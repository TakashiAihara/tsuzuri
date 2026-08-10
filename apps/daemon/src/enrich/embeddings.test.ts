import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, migrate } from "@tsuzuri/db";

import { loadConfig } from "../config.ts";
import { createEmbeddingService } from "./embeddings.ts";

/**
 * The service that decides whether embeddings run at all, and the one operation
 * that destroys vectors.
 *
 * Driven against a real database and a stub provider over real HTTP, because
 * the interesting behaviour is in the interaction between a long-running
 * rebuild and shutdown.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("createEmbeddingService", () => {
  /** Milliseconds each embedding request takes, so a rebuild is observably in flight. */
  let latencyMs = 0;

  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: string[] };
      if (latencyMs > 0) await Bun.sleep(latencyMs);
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
      });
    },
  });

  const handle = createDatabase({ url: DATABASE_URL as string, max: 4 });

  const config = () =>
    loadConfig({
      DATABASE_URL: DATABASE_URL as string,
      EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      EMBEDDING_MODEL: "stub",
      EMBEDDING_BATCH_SIZE: "1",
      EMBEDDING_CONCURRENCY: "1",
    });

  afterAll(async () => {
    provider.stop(true);
    await handle.close();
  });

  beforeEach(async () => {
    latencyMs = 0;
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
    for (let i = 0; i < 12; i += 1) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${`i${i}`}, ${`https://e.com/${i}`}, ${`https://e.com/${i}`}, ${`t${i}`}, now(), ${`b${i}`})
      `;
    }
  });

  test("first enablement probes the width and records the model", async () => {
    const service = createEmbeddingService({ sql: handle.sql, config: config() });
    await service.start();
    try {
      const status = await service.status();
      expect(status.state).toBe("ready");
      expect(status.dimensions).toBe(4);
      expect(status.lastReindexError).toBeNull();
    } finally {
      await service.stop();
    }
  });

  test("stop() interrupts a running rebuild instead of waiting it out", async () => {
    // The backfill loop used to ignore shutdown entirely: it kept calling the
    // provider and writing, and the process closed the connection pool
    // underneath it. Twelve items at 150ms each is well over the time stop()
    // is allowed to take.
    const service = createEmbeddingService({ sql: handle.sql, config: config() });
    await service.start();
    latencyMs = 150;

    const rebuild = service.reindex({ model: "stub" }).catch(() => {});
    await Bun.sleep(200);

    const started = Date.now();
    await service.stop();
    const elapsed = Date.now() - started;
    await rebuild;

    // Bounded by one pass, not by the whole corpus.
    expect(elapsed).toBeLessThan(1500);
    expect((await service.status()).reindexing).toBe(false);
  });

  test("a rebuild stopped part-way says so rather than reporting success", async () => {
    const service = createEmbeddingService({ sql: handle.sql, config: config() });
    await service.start();
    latencyMs = 150;

    const rebuild = service.reindex({ model: "stub" }).catch(() => {});
    await Bun.sleep(200);
    await service.stop();
    await rebuild;

    const status = await service.status();
    expect(status.lastReindexError).toMatch(/stopped/);
  });

  test("refuses a rebuild into a model that is not the configured one", async () => {
    const service = createEmbeddingService({ sql: handle.sql, config: config() });
    await service.start();
    try {
      await expect(service.reindex({ model: "something-else" })).rejects.toThrow(
        /does not match the configured/,
      );
    } finally {
      await service.stop();
    }
  });
});
