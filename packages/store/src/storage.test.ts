import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileStorage, type S3Like, s3ClientOptions, s3Storage, storageFromEnv } from "./storage.ts";

const BAD_KEYS = [
  "",
  ".",
  "a/..",
  "../x",
  "/x",
  "a//b",
  "./a",
  "items/",
  "a b",
  "é/x",
  ".hidden/x",
];
const BAD_PREFIXES = [".", "../", "/x", "a//", "./", "a/../", "é/"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tsuzuri-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const S3_ENV = {
  AWS_ACCESS_KEY_ID: "test-key-id",
  AWS_SECRET_ACCESS_KEY: "test-secret",
  AWS_ENDPOINT_URL_S3: "https://example.invalid",
};

describe("fileStorage", () => {
  test("round-trips bytes and strings, creating parent directories", async () => {
    const storage = fileStorage(root);
    await storage.put("items/dt=2026-11-08/run1.parquet", new Uint8Array([1, 2, 3]));
    await storage.put("_state/collector.json", '{"a":1}');

    expect(await storage.get("items/dt=2026-11-08/run1.parquet")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      new TextDecoder().decode((await storage.get("_state/collector.json")) ?? undefined),
    ).toBe('{"a":1}');
  });

  test("overwrites an existing key", async () => {
    const storage = fileStorage(root);
    await storage.put("_state/collector.json", "old");
    await storage.put("_state/collector.json", "new");
    expect(
      new TextDecoder().decode((await storage.get("_state/collector.json")) ?? undefined),
    ).toBe("new");
  });

  test("returns null for a missing key", async () => {
    expect(await fileStorage(root).get("nope/missing.json")).toBeNull();
  });

  test("lists every key under a prefix, recursively and sorted, and nothing outside it", async () => {
    const storage = fileStorage(root);
    await storage.put("items/dt=2026-11-09/b.parquet", "x");
    await storage.put("items/dt=2026-11-08/a.parquet", "x");
    await storage.put("items/dt=2026-11-08/c.parquet", "x");
    await storage.put("inbox/p1/dt=2026-11-08/z.parquet", "x");
    await storage.put("itemsextra/should-not-match.parquet", "x");

    expect(await storage.list("items/")).toEqual([
      "items/dt=2026-11-08/a.parquet",
      "items/dt=2026-11-08/c.parquet",
      "items/dt=2026-11-09/b.parquet",
    ]);
  });

  test("treats a prefix as a string, not a directory, like S3 does", async () => {
    const storage = fileStorage(root);
    await storage.put("items/dt=2026-11-08/a1.parquet", "x");
    await storage.put("items/dt=2026-11-08/a2.parquet", "x");
    await storage.put("items/dt=2026-11-08/b1.parquet", "x");

    expect(await storage.list("items/dt=2026-11-08/a")).toEqual([
      "items/dt=2026-11-08/a1.parquet",
      "items/dt=2026-11-08/a2.parquet",
    ]);
  });

  test("lists an absent prefix as empty", async () => {
    expect(await fileStorage(root).list("events/")).toEqual([]);
  });

  test("locate gives the absolute path the key was written to", async () => {
    const storage = fileStorage(root);
    await storage.put("items/x.parquet", "hello");
    const path = storage.locate("items/x.parquet");
    expect(path).toBe(join(root, "items/x.parquet"));
    expect(await readFile(path, "utf8")).toBe("hello");
  });

  test("describe names the root as a file:// URL", () => {
    expect(fileStorage(root).describe()).toBe(`file://${root}`);
  });

  test("refuses keys that escape the root", async () => {
    const storage = fileStorage(join(root, "inner"));
    await expect(storage.put("../escape.json", "x")).rejects.toThrow("invalid storage key");
    await expect(storage.get("a/../../escape.json")).rejects.toThrow("invalid storage key");
    await expect(storage.put("/etc/absolute.json", "x")).rejects.toThrow("invalid storage key");
    await expect(storage.get("..")).rejects.toThrow("invalid storage key");
  });
});

describe("keys", () => {
  test("both backends refuse the same malformed keys with the same message", async () => {
    const file = fileStorage(root);
    const s3 = s3Storage("b", S3_ENV, fakeS3());
    for (const storage of [file, s3]) {
      for (const key of BAD_KEYS) {
        await expect(storage.put(key, "x"), key).rejects.toThrow("invalid storage key");
        await expect(storage.get(key), key).rejects.toThrow("invalid storage key");
        expect(() => storage.locate(key), key).toThrow("invalid storage key");
      }
      for (const prefix of BAD_PREFIXES) {
        await expect(storage.list(prefix), prefix).rejects.toThrow("invalid storage key");
      }
    }
  });

  test("an empty prefix lists everything", async () => {
    const storage = fileStorage(root);
    await storage.put("a/x.json", "1");
    await storage.put("b.json", "2");
    expect(await storage.list("")).toEqual(["a/x.json", "b.json"]);
  });
});

describe("fileStorage edge cases", () => {
  test("get of a key that is a directory on disk is null, like a missing S3 object", async () => {
    const storage = fileStorage(root);
    await storage.put("items/a.parquet", "x");
    expect(await storage.get("items")).toBeNull();
  });

  test("get under a key that is a file on disk is null", async () => {
    const storage = fileStorage(root);
    await storage.put("items/a.parquet", "x");
    expect(await storage.get("items/a.parquet/x")).toBeNull();
  });

  test("list under a key that is a file on disk is empty", async () => {
    const storage = fileStorage(root);
    await storage.put("items/a.parquet", "x");
    expect(await storage.list("items/a.parquet/")).toEqual([]);
  });

  test("get returns bytes that own their buffer", async () => {
    const storage = fileStorage(root);
    await storage.put("k.bin", new Uint8Array([9, 8, 7]));
    const bytes = await storage.get("k.bin");
    expect(bytes?.byteOffset).toBe(0);
    expect(bytes?.buffer.byteLength).toBe(3);
  });

  test("an overwrite replaces the file by rename and leaves no temporary file behind", async () => {
    const storage = fileStorage(root);
    await storage.put("_state/collector.json", "old");
    const before = (await stat(join(root, "_state/collector.json"))).ino;
    await storage.put("_state/collector.json", "new");
    const after = (await stat(join(root, "_state/collector.json"))).ino;

    expect(after).not.toBe(before);
    expect(await readdir(join(root, "_state"))).toEqual(["collector.json"]);
  });

  test("list skips files outside the key rule, such as an in-flight put's temporary file", async () => {
    const storage = fileStorage(root);
    await storage.put("_state/collector.json", "x");
    await Bun.write(join(root, "_state/.collector.json.0000.tmp"), "partial");
    expect(await storage.list("_state/")).toEqual(["_state/collector.json"]);
  });

  test("a relative root is resolved to an absolute path", () => {
    const storage = fileStorage("relative/store");
    expect(storage.locate("a.json")).toBe(join(process.cwd(), "relative/store/a.json"));
  });
});

/** An in-memory stand-in for Bun.S3Client, paging list results in pages of `pageSize`. */
function fakeS3(
  objects: Record<string, Uint8Array> = {},
  pageSize = 2,
): S3Like & { lists: number } {
  const fake = {
    lists: 0,
    write: async (key: string, data: Uint8Array | string) => {
      objects[key] = typeof data === "string" ? new TextEncoder().encode(data) : data;
      return 0;
    },
    file: (key: string) => ({
      exists: async () => key in objects,
      arrayBuffer: async () => {
        const bytes = objects[key];
        if (!bytes) throw new Error("NoSuchKey");
        return bytes.slice().buffer;
      },
    }),
    list: async (input: { prefix?: string; continuationToken?: string }) => {
      fake.lists += 1;
      const keys = Object.keys(objects)
        .filter((key) => key.startsWith(input.prefix ?? ""))
        .sort();
      const start = input.continuationToken ? Number(input.continuationToken) : 0;
      const page = keys.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        contents: page.map((key) => ({ key })),
        isTruncated: next < keys.length,
        ...(next < keys.length ? { nextContinuationToken: String(next) } : {}),
      };
    },
  };
  return fake;
}

describe("s3Storage with a fake client", () => {
  test("put, get and a missing key", async () => {
    const storage = s3Storage("b", S3_ENV, fakeS3());
    await storage.put("_state/collector.json", "s");
    expect(
      new TextDecoder().decode((await storage.get("_state/collector.json")) ?? undefined),
    ).toBe("s");
    expect(await storage.get("_state/missing.json")).toBeNull();
  });

  test("list follows continuation tokens through every page", async () => {
    const fake = fakeS3();
    const storage = s3Storage("b", S3_ENV, fake);
    for (const name of ["e", "a", "d", "b", "c"]) await storage.put(`items/${name}.parquet`, "x");
    await storage.put("other/z.parquet", "x");

    expect(await storage.list("items/")).toEqual([
      "items/a.parquet",
      "items/b.parquet",
      "items/c.parquet",
      "items/d.parquet",
      "items/e.parquet",
    ]);
    expect(fake.lists).toBe(3);
  });

  test("list stops with an error when the server repeats a continuation token", async () => {
    const stuck: S3Like = {
      ...fakeS3(),
      list: async () => ({
        contents: [{ key: "items/a" }],
        isTruncated: true,
        nextContinuationToken: "same",
      }),
    };
    await expect(s3Storage("b", S3_ENV, stuck).list("items/")).rejects.toThrow(
      "continuation token",
    );
  });
});

describe("s3ClientOptions", () => {
  test("passes endpoint, region and session token from the given env", () => {
    const options = s3ClientOptions("b", {
      ...S3_ENV,
      AWS_REGION: "auto",
      AWS_SESSION_TOKEN: "fake-session",
    });
    expect(options).toMatchObject({
      bucket: "b",
      accessKeyId: "test-key-id",
      endpoint: "https://example.invalid",
      region: "auto",
      sessionToken: "fake-session",
    });
  });

  test("falls back to AWS_DEFAULT_REGION", () => {
    expect(s3ClientOptions("b", { ...S3_ENV, AWS_DEFAULT_REGION: "eu-west-1" }).region).toBe(
      "eu-west-1",
    );
  });
});

describe("s3Storage", () => {
  test("describe and locate use s3:// URLs without contacting the endpoint", () => {
    const storage = s3Storage("my-bucket", S3_ENV);
    expect(storage.describe()).toBe("s3://my-bucket");
    expect(storage.locate("items/dt=2026-11-08/run1.parquet")).toBe(
      "s3://my-bucket/items/dt=2026-11-08/run1.parquet",
    );
  });

  test("names every missing credential before any request", () => {
    expect(() => s3Storage("b", {})).toThrow("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY");
    expect(() => s3Storage("b", { AWS_ACCESS_KEY_ID: "k" })).toThrow("needs AWS_SECRET_ACCESS_KEY");
  });

  test("refuses keys that escape the bucket prefix", async () => {
    const storage = s3Storage("b", S3_ENV);
    await expect(storage.put("../x.json", "x")).rejects.toThrow("invalid storage key");
    await expect(storage.put("/x.json", "x")).rejects.toThrow("invalid storage key");
  });
});

describe("storageFromEnv", () => {
  test("defaults to ./data under the working directory when TSUZURI_STORAGE is unset", () => {
    const storage = storageFromEnv({}, { cwd: root });
    expect(storage.describe()).toBe(`file://${join(root, "data")}`);
  });

  test("accepts an absolute file:// URL", () => {
    const storage = storageFromEnv(
      { TSUZURI_STORAGE: `file://${root}/store` },
      { cwd: "/somewhere/else" },
    );
    expect(storage.describe()).toBe(`file://${root}/store`);
  });

  test("resolves a relative file:// URL against the working directory", () => {
    const storage = storageFromEnv({ TSUZURI_STORAGE: "file://rel/dir" }, { cwd: root });
    expect(storage.describe()).toBe(`file://${join(root, "rel/dir")}`);
  });

  test("selects S3 for s3://<bucket>", () => {
    const storage = storageFromEnv({ TSUZURI_STORAGE: "s3://news", ...S3_ENV }, { cwd: root });
    expect(storage.describe()).toBe("s3://news");
  });

  test("refuses an s3:// URL without a bucket", () => {
    expect(() => storageFromEnv({ TSUZURI_STORAGE: "s3://", ...S3_ENV }, { cwd: root })).toThrow(
      "bucket",
    );
  });

  test("refuses an s3:// URL with a path after the bucket", () => {
    expect(() =>
      storageFromEnv({ TSUZURI_STORAGE: "s3://news/prefix", ...S3_ENV }, { cwd: root }),
    ).toThrow("s3://<bucket>");
  });

  test("refuses file:// with an empty path instead of using the working directory", () => {
    expect(() => storageFromEnv({ TSUZURI_STORAGE: "file://" }, { cwd: root })).toThrow(
      "file://<dir>",
    );
  });

  test("refuses any other scheme and quotes the value", () => {
    expect(() => storageFromEnv({ TSUZURI_STORAGE: "r2://news" }, { cwd: root })).toThrow(
      '"r2://news"',
    );
  });

  test("with requireExplicit, refuses to fall back to the default", () => {
    expect(() => storageFromEnv({}, { cwd: root, requireExplicit: true })).toThrow(
      "TSUZURI_STORAGE is not set",
    );
    expect(
      storageFromEnv({ TSUZURI_STORAGE: `file://${root}` }, { requireExplicit: true }).describe(),
    ).toBe(`file://${root}`);
  });
});

// Runs only against a real bucket: TSUZURI_TEST_S3=s3://<bucket> plus the AWS_* variables.
const live = process.env.TSUZURI_TEST_S3;
describe.skipIf(!live)("s3Storage against a real bucket", () => {
  test("put, get, list and a missing key", async () => {
    const storage = storageFromEnv({ ...process.env, TSUZURI_STORAGE: live });
    const prefix = `_test/${crypto.randomUUID()}/`;
    await storage.put(`${prefix}b.json`, "b");
    await storage.put(`${prefix}a/x.json`, new Uint8Array([7]));

    expect(await storage.list(prefix)).toEqual([`${prefix}a/x.json`, `${prefix}b.json`]);
    expect(await storage.get(`${prefix}a/x.json`)).toEqual(new Uint8Array([7]));
    expect(await storage.get(`${prefix}missing`)).toBeNull();
  });
});
