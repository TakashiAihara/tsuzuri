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

describe("chat enrichment", () => {
  test("is off by default, with no model chosen for anyone", () => {
    const config = loadConfig(base);
    expect(config.CHAT_PROVIDER).toBe("none");
    expect(config.CHAT_MODEL).toBeUndefined();
    expect(config.ENRICH_TRANSLATE_TO).toBeUndefined();
  });

  test("a provider without a model is a startup error, not a disabled feature", () => {
    // Same rule and same reason as the embedding variables: the daemon keeps
    // serving when an optional feature will not start, so without this a typo
    // becomes an installation that silently never summarises anything.
    expect(() =>
      loadConfig({
        ...base,
        CHAT_PROVIDER: "openai-compatible",
        CHAT_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toThrow(/CHAT_MODEL/);
  });

  test("a provider without a base url is a startup error too", () => {
    expect(() =>
      loadConfig({ ...base, CHAT_PROVIDER: "anthropic", CHAT_MODEL: "claude-local" }),
    ).toThrow(/CHAT_BASE_URL/);
  });

  test("names every provider the design settled on", () => {
    for (const provider of ["openai-compatible", "anthropic", "gemini"] as const) {
      const config = loadConfig({
        ...base,
        CHAT_PROVIDER: provider,
        CHAT_BASE_URL: "http://localhost:1234",
        CHAT_MODEL: "local-model",
      });
      expect(config.CHAT_PROVIDER).toBe(provider);
    }
    expect(() => loadConfig({ ...base, CHAT_PROVIDER: "ollama" })).toThrow(/CHAT_PROVIDER/);
  });

  test("a fully configured provider loads", () => {
    const config = loadConfig({
      ...base,
      CHAT_PROVIDER: "openai-compatible",
      CHAT_BASE_URL: "http://localhost:11434/v1",
      CHAT_MODEL: "qwen3",
      CHAT_MAX_OUTPUT_TOKENS: "512",
    });
    expect(config.CHAT_MODEL).toBe("qwen3");
    expect(config.CHAT_MAX_OUTPUT_TOKENS).toBe(512);
  });

  test("what a pass does is decided separately from whether one exists", () => {
    // Defaults from the configuration table, spelled out here rather than read
    // from the implementation: a test that asserted config.ENRICH_TOP_N === 20
    // would pass with the default changed to anything.
    const config = loadConfig(base);
    expect(config.ENRICH_SUMMARY).toBe(true);
    expect(config.ENRICH_TAGS).toBe(true);
    expect(config.ENRICH_TOP_N).toBe(20);
    expect(config.ENRICH_WINDOW_HOURS).toBe(48);
    expect(config.ENRICH_MAX_ITEMS_PER_HOUR).toBe(60);
    expect(config.ENRICH_CONCURRENCY).toBe(2);
    expect(config.TAG_CANDIDATE_PROMOTION_THRESHOLD).toBe(5);
    expect(config.CHAT_MAX_OUTPUT_TOKENS).toBe(1024);
    expect(config.CHAT_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  test("summary and tagging can each be switched off", () => {
    const config = loadConfig({ ...base, ENRICH_SUMMARY: "false", ENRICH_TAGS: "false" });
    expect(config.ENRICH_SUMMARY).toBe(false);
    expect(config.ENRICH_TAGS).toBe(false);
  });
});
