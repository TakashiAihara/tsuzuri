import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileStorage, s3Storage, storageFromEnv } from "./storage.ts";

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
    await expect(storage.put("../escape.json", "x")).rejects.toThrow("outside the storage root");
    await expect(storage.get("a/../../escape.json")).rejects.toThrow("outside the storage root");
    await expect(storage.put("/etc/absolute.json", "x")).rejects.toThrow(
      "outside the storage root",
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
    await expect(storage.put("../x.json", "x")).rejects.toThrow("outside the storage root");
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
