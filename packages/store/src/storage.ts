import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The store of record: objects addressed by "/"-separated keys. The collector,
 * viewer and other producers share the same prefixes, so both backends apply
 * one key rule — but they are not identical: file:// cannot hold both "p" and
 * "p/q" where S3 can, and file:// follows symlinks on get/put while its list
 * does not report them. The store is not append-only: `put` overwrites, and
 * `_state` documents rely on that.
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

// One key rule for both backends, applied with no normalisation: a key is
// "/"-separated segments matching SEGMENT — ASCII only, no empty segment, no
// leading dot so "." and ".." cannot appear, and at most 200 characters so the
// file backend's temporary name stays under the 255-byte file-name limit —
// and an object key does not end in "/". A list prefix follows the same rule
// but may be empty and may end in "/", its last segment being only a partial
// match.
const SEGMENT = /^[A-Za-z0-9_=-][A-Za-z0-9._=-]{0,199}$/;

function invalidKey(key: string): Error {
  return new Error(`invalid storage key ${JSON.stringify(key)}`);
}

function isObjectKey(key: string): boolean {
  // A trailing "/" leaves an empty last segment, which SEGMENT refuses.
  return key.split("/").every((segment) => SEGMENT.test(segment));
}

function assertKey(key: string): void {
  if (!isObjectKey(key)) throw invalidKey(key);
}

function assertPrefix(prefix: string): void {
  if (prefix === "") return;
  const body = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  for (const segment of body.split("/")) {
    if (!SEGMENT.test(segment)) throw invalidKey(prefix);
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// fileStorage keeps one directory as the root; keys are paths inside it. The
// shared key rule refuses traversal and absolute keys, which is what keeps
// them inside the root; it does not defend against symlinks — get/put follow
// them, while list does not report them. The root is resolved once so
// locate() always reports an absolute path. put writes a temporary file and
// renames it over the target, so a reader sees the old or the new object,
// never a partial one.
export function fileStorage(root: string): Storage {
  const rootDir = resolve(root);

  const pathFor = (key: string): string => join(rootDir, key);

  const walk = async (dir: string): Promise<string[]> => {
    const names: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // Names outside the key rule (the dot-prefixed temporary files of an
      // in-flight put, editor droppings) are not objects.
      if (!SEGMENT.test(entry.name)) continue;
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
      assertKey(key);
      const path = pathFor(key);
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      // The temporary file sits in the same directory so the rename stays on
      // one filesystem and replaces the target atomically. Its leading dot
      // breaks the key rule, so a concurrent list never returns it.
      const tmp = join(dir, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
      try {
        await writeFile(tmp, data);
        // fsync the file before the rename and the directory after it:
        // without both, a power loss can lose the data or the rename itself.
        // Directories that mkdir just created are not synced into their own
        // parents, so the first put into a new dt= partition is not durable
        // until something else syncs it.
        const file = await open(tmp, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, path);
        const parent = await open(dir, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    },
    get: async (key) => {
      assertKey(key);
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    list: async (prefix) => {
      assertPrefix(prefix);
      // Only the prefix's directory part is walked, which already keeps
      // "items/" out of "itemsextra/". The string filter is what applies a
      // partial last segment, as in "items/dt=2026-11-08/a".
      const scanDir = join(rootDir, prefix.slice(0, prefix.lastIndexOf("/") + 1));
      let names: string[];
      try {
        names = await walk(scanDir);
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw error;
      }
      return names.filter((name) => name.startsWith(prefix)).sort();
    },
    locate: (key) => {
      assertKey(key);
      return pathFor(key);
    },
  };
}

/**
 * The slice of Bun.S3Client the backend uses, so tests can inject a fake.
 */
export type S3Like = {
  write(key: string, data: Uint8Array | string): Promise<unknown>;
  file(key: string): {
    exists(): Promise<boolean>;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  list(input: { prefix?: string; continuationToken?: string }): Promise<{
    contents?: { key: string }[];
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
};

/**
 * The Bun.S3Client options for `bucket`: the standard AWS_* names are read
 * from `env`, and any option left undefined falls back to Bun's own reading
 * of the S3_ and AWS_ variables in process.env.
 */
export function s3ClientOptions(bucket: string, env: Env = process.env): Bun.S3Options {
  return {
    bucket,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
  };
}

/**
 * Any S3-compatible bucket (R2 included) through Bun's built-in client, or an
 * injected S3Like. Client options come from the standard AWS_* names in `env`;
 * any left undefined fall back to Bun's own reading of the S3_ and AWS_
 * variables in process.env, so tests and callers can pass an explicit
 * environment.
 */
export function s3Storage(bucket: string, env: Env = process.env, client?: S3Like): Storage {
  const missing = (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    throw new Error(`s3://${bucket} needs ${missing.join(", ")}`);
  }

  const s3: S3Like = client ?? new Bun.S3Client(s3ClientOptions(bucket, env));

  return {
    describe: () => `s3://${bucket}`,
    put: async (key, data) => {
      assertKey(key);
      await s3.write(key, data);
    },
    get: async (key) => {
      assertKey(key);
      const file = s3.file(key);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },
    list: async (prefix) => {
      assertPrefix(prefix);
      const keys: string[] = [];
      const seenTokens = new Set<string>();
      let continuationToken: string | undefined;
      for (;;) {
        const page = await s3.list({
          prefix,
          ...(continuationToken !== undefined ? { continuationToken } : {}),
        });
        for (const object of page.contents ?? []) {
          // S3 holds keys the shared rule refuses (folder markers, spaces,
          // non-ASCII); like fileStorage's walk, list reports only real keys.
          if (isObjectKey(object.key)) keys.push(object.key);
        }
        if (!page.isTruncated) break;
        const next = page.nextContinuationToken;
        if (next === undefined) {
          throw new Error(`s3://${bucket} list was truncated but returned no continuation token`);
        }
        if (seenTokens.has(next)) {
          throw new Error(
            `s3://${bucket} list repeated continuation token ${JSON.stringify(next)}`,
          );
        }
        seenTokens.add(next);
        continuationToken = next;
      }
      return keys.sort();
    },
    locate: (key) => {
      assertKey(key);
      return `s3://${bucket}/${key}`;
    },
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
    if (dir === "") {
      throw new Error(`TSUZURI_STORAGE ${JSON.stringify(value)} must be file://<dir>`);
    }
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
