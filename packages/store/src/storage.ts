import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The store of record: append-only objects addressed by "/"-separated keys.
 * `file://` and `s3://` implementations must behave identically, because the
 * collector, viewer and other producers share the same prefixes.
 */
export type Storage = {
  /** Short identifier for logs, e.g. "file:///data" or "s3://bucket". */
  describe(): string;
  put(key: string, data: Uint8Array | string): Promise<void>;
  /** Bytes at `key`, or null when absent. */
  get(key: string): Promise<Uint8Array | null>;
  /** Every key starting with `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  /** Where `key` lives, for humans and error messages. */
  locate(key: string): string;
};

type Env = Record<string, string | undefined>;

const OUTSIDE_ROOT = "outside the storage root";

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// fileStorage keeps one directory as the root; keys are relative paths inside it.
// The root is resolved once so locate() always reports an absolute path.
export function fileStorage(root: string): Storage {
  const rootDir = resolve(root);

  const resolveKey = (key: string): string => {
    const path = resolve(rootDir, key);
    const rel = relative(rootDir, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`key ${JSON.stringify(key)} is ${OUTSIDE_ROOT}`);
    }
    return path;
  };

  const walk = async (dir: string): Promise<string[]> => {
    const names: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        names.push(...(await walk(path)));
      } else if (entry.isFile()) {
        names.push(relative(rootDir, path).split(sep).join("/"));
      }
    }
    return names;
  };

  return {
    describe: () => `file://${rootDir}`,
    put: async (key, data) => {
      const path = resolveKey(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    get: async (key) => {
      try {
        const bytes = await readFile(resolveKey(key));
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (error) {
        if (isENOENT(error)) return null;
        throw error;
      }
    },
    list: async (prefix) => {
      resolveKey(prefix);
      // The scan starts at the prefix's directory part; the full prefix is
      // still applied as a literal string filter so "items/" cannot match
      // "itemsextra/..." while "items" can.
      const scanDir = resolveKey(prefix.slice(0, prefix.lastIndexOf("/") + 1));
      let names: string[];
      try {
        names = await walk(scanDir);
      } catch (error) {
        if (isENOENT(error)) return [];
        throw error;
      }
      return names.filter((name) => name.startsWith(prefix)).sort();
    },
    locate: (key) => resolveKey(key),
  };
}

// S3 keys have no filesystem semantics, so "." and ".." segments are resolved
// by hand; a key is refused only when that resolution would leave the bucket.
function assertS3Key(key: string): void {
  if (key.startsWith("/")) {
    throw new Error(`key ${JSON.stringify(key)} is ${OUTSIDE_ROOT}`);
  }
  let depth = 0;
  for (const segment of key.split("/")) {
    if (segment === "..") {
      if (depth === 0) {
        throw new Error(`key ${JSON.stringify(key)} is ${OUTSIDE_ROOT}`);
      }
      depth--;
    } else if (segment !== "" && segment !== ".") {
      depth++;
    }
  }
}

function normalizeS3Key(key: string): string {
  assertS3Key(key);
  const parts: string[] = [];
  for (const segment of key.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "" && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Any S3-compatible bucket (R2 included) through Bun's built-in client.
 * Credentials come from the standard AWS_* names in `env`, not process.env,
 * so tests and callers can pass an explicit environment.
 */
export function s3Storage(bucket: string, env: Env = process.env): Storage {
  const missing = (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    throw new Error(`s3://${bucket} needs ${missing.join(", ")}`);
  }

  const client = new Bun.S3Client({
    bucket,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
  });

  return {
    describe: () => `s3://${bucket}`,
    put: async (key, data) => {
      await client.write(normalizeS3Key(key), data);
    },
    get: async (key) => {
      const file = client.file(normalizeS3Key(key));
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },
    list: async (prefix) => {
      assertS3Key(prefix);
      const keys: string[] = [];
      let continuationToken: string | undefined;
      let startAfter: string | undefined;
      for (;;) {
        const page = await client.list({
          prefix,
          ...(continuationToken !== undefined ? { continuationToken } : {}),
          ...(startAfter !== undefined ? { startAfter } : {}),
        });
        for (const object of page.contents ?? []) keys.push(object.key);
        if (!page.isTruncated) break;
        if (page.nextContinuationToken) {
          continuationToken = page.nextContinuationToken;
          startAfter = undefined;
        } else {
          const last = page.contents?.at(-1)?.key;
          if (last === undefined) break;
          startAfter = last;
          continuationToken = undefined;
        }
      }
      return keys.sort();
    },
    locate: (key) => `s3://${bucket}/${normalizeS3Key(key)}`,
  };
}

/**
 * Pick the storage backend from TSUZURI_STORAGE: file://<dir> or s3://<bucket>.
 * The default file://./data keeps a first run working with no configuration;
 * requireExplicit exists for the standalone collector, where silently writing
 * to a local directory nobody reads would lose data.
 */
export function storageFromEnv(
  env: Env = process.env,
  {
    cwd = process.cwd(),
    requireExplicit = false,
  }: { cwd?: string; requireExplicit?: boolean } = {},
): Storage {
  const value = env.TSUZURI_STORAGE;
  if (!value) {
    if (requireExplicit) {
      throw new Error("TSUZURI_STORAGE is not set; it must be file://<dir> or s3://<bucket>");
    }
    return fileStorage(resolve(cwd, "data"));
  }
  if (value.startsWith("file://")) {
    const dir = value.slice("file://".length);
    return fileStorage(isAbsolute(dir) ? dir : resolve(cwd, dir));
  }
  if (value.startsWith("s3://")) {
    const name = value.slice("s3://".length);
    if (!name || name.includes("/")) {
      throw new Error(`TSUZURI_STORAGE ${JSON.stringify(value)} must be s3://<bucket>`);
    }
    return s3Storage(name, env);
  }
  throw new Error(
    `TSUZURI_STORAGE must be file://<dir> or s3://<bucket>, got ${JSON.stringify(value)}`,
  );
}
