import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

const base = { DATABASE_URL: "postgres://localhost/tsuzuri" };

describe("loadConfig", () => {
  test("embeddings are off by default, with no model chosen for anyone", () => {
    const config = loadConfig(base);
    expect(config.EMBEDDING_PROVIDER).toBe("none");
    expect(config.EMBEDDING_MODEL).toBeUndefined();
  });

  test("a provider without a model is a startup error, not a disabled feature", () => {
    // The daemon tolerates embeddings failing to start so a broken optional
    // feature cannot stop the reader. Without this rule that tolerance turns a
    // typo into silence: embeddings never run and nothing says why.
    expect(() =>
      loadConfig({
        ...base,
        EMBEDDING_PROVIDER: "openai-compatible",
        EMBEDDING_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toThrow(/EMBEDDING_MODEL/);
  });

  test("a provider without a base url is a startup error too", () => {
    expect(() =>
      loadConfig({ ...base, EMBEDDING_PROVIDER: "openai-compatible", EMBEDDING_MODEL: "bge-m3" }),
    ).toThrow(/EMBEDDING_BASE_URL/);
  });

  test("a fully configured provider loads", () => {
    const config = loadConfig({
      ...base,
      EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_BASE_URL: "http://localhost:11434/v1",
      EMBEDDING_MODEL: "bge-m3",
    });
    expect(config.EMBEDDING_MODEL).toBe("bge-m3");
    expect(config.EMBEDDING_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("still refuses a configuration with no database", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
