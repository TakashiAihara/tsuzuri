import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EmbeddingProvider } from "@tsuzuri/core";
import { createDatabase, ensureItemEmbeddings, migrate, pendingEmbeddingItems } from "@tsuzuri/db";

import { runEmbedPass } from "./embed-worker.ts";

/**
 * The worker is tested against a real database and a fake provider.
 *
 * The provider is the part worth faking: what matters here is how the worker
 * reacts to a provider that fails, and provoking a real one into failing on
 * demand is harder and less precise than saying so.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("runEmbedPass", () => {
  let handle: ReturnType<typeof createDatabase>;

  /** A provider that answers with a fixed-width vector, and can be told to fail. */
  function fakeProvider(options: {
    width?: number;
    failFor?: (texts: string[]) => boolean;
  }): EmbeddingProvider & { calls: string[][] } {
    const width = options.width ?? 4;
    const calls: string[][] = [];
    return {
      id: "openai-compatible",
      model: "fake",
      calls,
      async embed(texts) {
        calls.push(texts);
        if (options.failFor?.(texts)) throw new Error("provider refused this batch");
        return texts.map((_, i) => Array.from({ length: width }, (_, j) => (i + j) / 10));
      },
    };
  }

  const options = (
    provider: EmbeddingProvider,
    overrides: Partial<{ batchSize: number; concurrency: number }> = {},
  ) => ({
    sql: handle.sql,
    provider,
    batchSize: overrides.batchSize ?? 2,
    concurrency: overrides.concurrency ?? 1,
    maxInputChars: 1000,
  });

  async function seed(count: number) {
    for (let i = 0; i < count; i += 1) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (
          ${`i${i}`},
          ${`https://example.com/${i}`},
          ${`https://example.com/${i}`},
          ${`title ${i}`},
          ${`2026-08-${String(i + 1).padStart(2, "0")}`},
          ${`body ${i}`}
        )
      `;
    }
  }

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.sql.unsafe("DROP TABLE IF EXISTS item_embeddings");
    await handle.sql`TRUNCATE embedding_failures`;
    await handle.sql`DELETE FROM items`;
    await ensureItemEmbeddings(handle.sql, 4);
  });

  test("reports idle when nothing is waiting", async () => {
    const provider = fakeProvider({});
    expect(await runEmbedPass(options(provider))).toEqual({ embedded: 0, failed: 0, idle: true });
    expect(provider.calls).toHaveLength(0);
  });

  test("one pass claims batchSize * concurrency items, not the whole backlog", async () => {
    // A pass is bounded so that a large corpus is worked through in steady
    // increments rather than claimed all at once.
    await seed(5);
    const provider = fakeProvider({});
    const result = await runEmbedPass(options(provider, { batchSize: 2, concurrency: 1 }));
    expect(result).toMatchObject({ embedded: 2, failed: 0, idle: false });
    expect(await pendingEmbeddingItems(handle.sql, 10)).toHaveLength(3);
  });

  test("repeated passes converge on an empty backlog", async () => {
    await seed(5);
    const provider = fakeProvider({});
    let passes = 0;
    for (;;) {
      const result = await runEmbedPass(options(provider, { batchSize: 2, concurrency: 1 }));
      passes += 1;
      if (result.idle) break;
      if (passes > 10) throw new Error("backfill did not converge");
    }
    expect(await pendingEmbeddingItems(handle.sql, 10)).toHaveLength(0);
  });

  test("splits a pass into batches of the configured size", async () => {
    await seed(5);
    const provider = fakeProvider({});
    await runEmbedPass(options(provider, { batchSize: 2, concurrency: 3 }));
    expect(provider.calls.map((batch) => batch.length).sort()).toEqual([1, 2, 2]);
  });

  test("sends title and body together as the embedded text", async () => {
    await seed(1);
    const provider = fakeProvider({});
    await runEmbedPass(options(provider));
    expect(provider.calls[0]?.[0]).toBe("title 0 body 0");
  });

  test("a failing batch is retried per item, so one bad article does not condemn the rest", async () => {
    await seed(4);
    // Refuse only the batch containing item 2, then refuse that item alone.
    const provider = fakeProvider({ failFor: (texts) => texts.some((t) => t.includes("title 2")) });

    const result = await runEmbedPass(options(provider, { batchSize: 4, concurrency: 1 }));

    expect(result.embedded).toBe(3);
    expect(result.failed).toBe(1);
    const remaining = await pendingEmbeddingItems(handle.sql, 10);
    expect(remaining).toHaveLength(0); // the failure is scheduled, not pending
  });

  test("records the failure so the item is held back rather than retried immediately", async () => {
    await seed(1);
    const provider = fakeProvider({ failFor: () => true });
    await runEmbedPass(options(provider));

    const rows = await handle.sql<{ failures: number; last_error: string }[]>`
      SELECT failures, last_error FROM embedding_failures
    `;
    expect(rows[0]).toMatchObject({ failures: 1 });
    expect(rows[0]?.last_error).toContain("provider refused");
    expect(await pendingEmbeddingItems(handle.sql, 10)).toHaveLength(0);
  });

  test("a later pass picks up items that arrived since", async () => {
    // Ingest does not notify anything; new articles are pending by virtue of
    // having no vector, which is what makes the queue-less design work.
    await seed(2);
    const provider = fakeProvider({});
    await runEmbedPass(options(provider));

    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
      VALUES ('late', 'https://example.com/late', 'https://example.com/late', 'late', now(), 'late body')
    `;
    expect(await runEmbedPass(options(provider))).toMatchObject({ embedded: 1, idle: false });
  });

  test("stores vectors at the provider's width", async () => {
    await seed(1);
    await runEmbedPass(options(fakeProvider({ width: 4 })));
    const rows = await handle.sql<{ dims: number }[]>`
      SELECT vector_dims(embedding) AS dims FROM item_embeddings
    `;
    expect(rows[0]?.dims).toBe(4);
  });

  test("a provider whose width disagrees with the column fails the item rather than the pass", async () => {
    await seed(1);
    const result = await runEmbedPass(options(fakeProvider({ width: 8 })));
    expect(result).toMatchObject({ embedded: 0, failed: 1 });
  });
});
