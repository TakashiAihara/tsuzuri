import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "./client.ts";
import {
  createEmbeddingIndex,
  embeddingCounts,
  embeddingIndexExists,
  ensureItemEmbeddings,
  HNSW_MAX_DIMENSIONS,
  insertEmbeddings,
  itemEmbeddingsDimension,
  itemEmbeddingsExists,
  pendingEmbeddingItems,
  readEmbeddingModel,
  rebuildItemEmbeddings,
  recordEmbeddingFailure,
  retryBackoffSeconds,
  writeEmbeddingModel,
} from "./embeddings.ts";
import { migrate } from "./migrate.ts";

/**
 * item_embeddings is the one table with no Drizzle mirror, because its column
 * carries a dimension nothing static can state. That makes these tests the only
 * thing standing between the runtime DDL and the queries written against it, so
 * they exercise the real create, the real rebuild at a different dimension, and
 * the real pgvector operators.
 *
 * Skipped when TSUZURI_TEST_DATABASE_URL is unset, like the rest of the
 * database suite.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("embeddings", () => {
  let handle: ReturnType<typeof createDatabase>;

  const item = (id: string, publishedAt: string, title: string) => ({
    id,
    publishedAt,
    title,
  });

  async function seedItems(rows: ReturnType<typeof item>[]) {
    for (const row of rows) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (
          ${row.id},
          ${`https://example.com/${row.id}`},
          ${`https://example.com/${row.id}`},
          ${row.title},
          ${row.publishedAt},
          ${row.title}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 2 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.sql.unsafe("DROP TABLE IF EXISTS item_embeddings");
    await handle.sql`TRUNCATE embedding_failures, embedding_model`;
    await handle.sql`DELETE FROM items`;
  });

  test("the vector table does not exist until a model is configured", async () => {
    // The default install has no model, so there is nothing to create it from.
    expect(await itemEmbeddingsExists(handle.sql)).toBe(false);
    expect(await itemEmbeddingsDimension(handle.sql)).toBeNull();
  });

  test("counts report everything pending before the table exists", async () => {
    await seedItems([item("a", "2026-08-01", "one"), item("b", "2026-08-02", "two")]);
    expect(await embeddingCounts(handle.sql)).toEqual({
      total: 2,
      embedded: 0,
      pending: 2,
      failed: 0,
    });
  });

  test("creates the table at the probed dimension, with an HNSW index", async () => {
    await ensureItemEmbeddings(handle.sql, 4);
    expect(await itemEmbeddingsExists(handle.sql)).toBe(true);
    expect(await itemEmbeddingsDimension(handle.sql)).toBe(4);
    expect(await embeddingIndexExists(handle.sql)).toBe(true);
  });

  test("creating twice is a no-op, so a restart is safe", async () => {
    await ensureItemEmbeddings(handle.sql, 4);
    await ensureItemEmbeddings(handle.sql, 4);
    expect(await itemEmbeddingsDimension(handle.sql)).toBe(4);
  });

  test("refuses an implausible dimension rather than building a column from it", async () => {
    // The dimension reaches DDL as text, so it is the one value that must not
    // be trusted from a caller.
    await expect(ensureItemEmbeddings(handle.sql, 0)).rejects.toThrow(/refusing/);
    await expect(ensureItemEmbeddings(handle.sql, 1.5)).rejects.toThrow(/refusing/);
    await expect(ensureItemEmbeddings(handle.sql, -1)).rejects.toThrow(/refusing/);
  });

  test("refuses a model too wide for pgvector to index, before creating anything", async () => {
    // text-embedding-3-large is 3072 dimensions natively. The table would be
    // created and CREATE INDEX would then fail with "column cannot have more
    // than 2000 dimensions for hnsw index", leaving an unindexed table and no
    // recorded model -- a state the next boot would try to reach again.
    await expect(ensureItemEmbeddings(handle.sql, 3072)).rejects.toThrow(/at most 2000/);
    await expect(ensureItemEmbeddings(handle.sql, 3072)).rejects.toThrow(/EMBEDDING_DIMENSIONS/);
    expect(await itemEmbeddingsExists(handle.sql)).toBe(false);
  });

  test("accepts the widest dimension pgvector will index", async () => {
    await ensureItemEmbeddings(handle.sql, HNSW_MAX_DIMENSIONS);
    expect(await embeddingIndexExists(handle.sql)).toBe(true);
  });

  test("stores vectors and finds the nearest by cosine distance", async () => {
    await seedItems([
      item("a", "2026-08-01", "one"),
      item("b", "2026-08-02", "two"),
      item("c", "2026-08-03", "three"),
    ]);
    await ensureItemEmbeddings(handle.sql, 4);
    await insertEmbeddings(handle.sql, [
      { itemId: "a", vector: "[1,0,0,0]" },
      { itemId: "b", vector: "[0.9,0.1,0,0]" },
      { itemId: "c", vector: "[0,0,1,0]" },
    ]);

    const rows = await handle.sql<{ item_id: string }[]>`
      SELECT item_id FROM item_embeddings ORDER BY embedding <=> '[1,0,0,0]'::vector LIMIT 2
    `;
    expect(rows.map((r) => r.item_id)).toEqual(["a", "b"]);
  });

  test("re-inserting an item replaces its vector rather than failing", async () => {
    await seedItems([item("a", "2026-08-01", "one")]);
    await ensureItemEmbeddings(handle.sql, 4);
    await insertEmbeddings(handle.sql, [{ itemId: "a", vector: "[1,0,0,0]" }]);
    await insertEmbeddings(handle.sql, [{ itemId: "a", vector: "[0,1,0,0]" }]);

    const rows = await handle.sql<{ embedding: string }[]>`
      SELECT embedding::text FROM item_embeddings WHERE item_id = 'a'
    `;
    expect(rows[0]?.embedding).toBe("[0,1,0,0]");
  });

  test("an empty insert makes no statement", async () => {
    await ensureItemEmbeddings(handle.sql, 4);
    await insertEmbeddings(handle.sql, []);
    expect(await embeddingCounts(handle.sql)).toMatchObject({ embedded: 0 });
  });

  describe("pending selection", () => {
    beforeEach(async () => {
      await seedItems([
        item("old", "2026-08-01", "oldest"),
        item("mid", "2026-08-02", "middle"),
        item("new", "2026-08-03", "newest"),
      ]);
      await ensureItemEmbeddings(handle.sql, 4);
    });

    test("returns items with no vector, newest first", async () => {
      // Newest first so a fresh install is useful for current articles before
      // the whole archive has been processed.
      const pending = await pendingEmbeddingItems(handle.sql, 10);
      expect(pending.map((row) => row.id)).toEqual(["new", "mid", "old"]);
    });

    test("carries the text the item will be embedded from", async () => {
      const pending = await pendingEmbeddingItems(handle.sql, 1);
      expect(pending[0]).toMatchObject({ id: "new", title: "newest", searchText: "newest" });
    });

    test("skips items that already have a vector", async () => {
      await insertEmbeddings(handle.sql, [{ itemId: "new", vector: "[1,0,0,0]" }]);
      const pending = await pendingEmbeddingItems(handle.sql, 10);
      expect(pending.map((row) => row.id)).toEqual(["mid", "old"]);
    });

    test("holds back a failed item until its retry is due", async () => {
      const now = new Date("2026-08-10T00:00:00Z");
      await recordEmbeddingFailure(handle.sql, "new", "provider said no", now);

      const soon = await pendingEmbeddingItems(handle.sql, 10, now);
      expect(soon.map((row) => row.id)).toEqual(["mid", "old"]);

      // One poisonous item must not park the queue, but it must come back.
      const later = new Date(now.getTime() + 10 * 60 * 1000);
      expect((await pendingEmbeddingItems(handle.sql, 10, later)).map((r) => r.id)).toContain(
        "new",
      );
    });

    test("backs off further on each successive failure", async () => {
      const now = new Date("2026-08-10T00:00:00Z");
      await recordEmbeddingFailure(handle.sql, "new", "first", now);
      await recordEmbeddingFailure(handle.sql, "new", "second", now);

      const rows = await handle.sql<{ failures: number; next_attempt_at: string }[]>`
        SELECT failures, next_attempt_at FROM embedding_failures WHERE item_id = 'new'
      `;
      expect(rows[0]?.failures).toBe(2);
      // First failure waits 60s; the second must wait longer than that.
      const scheduled = new Date(rows[0]?.next_attempt_at as string).getTime();
      expect(scheduled - now.getTime()).toBeGreaterThan(60_000);
    });

    test("a successful embedding clears an earlier failure", async () => {
      await recordEmbeddingFailure(handle.sql, "new", "transient", new Date());
      await insertEmbeddings(handle.sql, [{ itemId: "new", vector: "[1,0,0,0]" }]);
      expect(await embeddingCounts(handle.sql)).toMatchObject({ embedded: 1, failed: 0 });
    });

    test("respects the limit", async () => {
      expect(await pendingEmbeddingItems(handle.sql, 2)).toHaveLength(2);
    });
  });

  describe("rebuild", () => {
    test("discards vectors and moves the column to the new dimension", async () => {
      await seedItems([item("a", "2026-08-01", "one")]);
      await ensureItemEmbeddings(handle.sql, 4);
      await insertEmbeddings(handle.sql, [{ itemId: "a", vector: "[1,0,0,0]" }]);

      await rebuildItemEmbeddings(handle.sql, 8);

      expect(await itemEmbeddingsDimension(handle.sql)).toBe(8);
      expect(await embeddingCounts(handle.sql)).toMatchObject({ embedded: 0, pending: 1 });
      // The index is left off so the backfill can build it once at the end.
      expect(await embeddingIndexExists(handle.sql)).toBe(false);
    });

    test("accepts vectors at the new width afterwards", async () => {
      await seedItems([item("a", "2026-08-01", "one")]);
      await ensureItemEmbeddings(handle.sql, 4);
      await rebuildItemEmbeddings(handle.sql, 8);
      await insertEmbeddings(handle.sql, [{ itemId: "a", vector: "[1,2,3,4,5,6,7,8]" }]);
      expect(await embeddingCounts(handle.sql)).toMatchObject({ embedded: 1 });
    });

    test("rejects vectors at the old width, which is the guarantee the column exists for", async () => {
      await seedItems([item("a", "2026-08-01", "one")]);
      await ensureItemEmbeddings(handle.sql, 4);
      await rebuildItemEmbeddings(handle.sql, 8);
      await expect(
        insertEmbeddings(handle.sql, [{ itemId: "a", vector: "[1,0,0,0]" }]),
      ).rejects.toThrow();
    });

    test("works when the table does not exist yet", async () => {
      await rebuildItemEmbeddings(handle.sql, 6);
      expect(await itemEmbeddingsDimension(handle.sql)).toBe(6);
    });

    test("is idempotent, so an interrupted rebuild resumes", async () => {
      await rebuildItemEmbeddings(handle.sql, 6);
      await rebuildItemEmbeddings(handle.sql, 6);
      expect(await itemEmbeddingsDimension(handle.sql)).toBe(6);
    });

    test("leaves nothing half-done when the rebuild fails partway", async () => {
      // DROP INDEX, TRUNCATE and ALTER used to run as separate statements, so a
      // failure between them left the table indexless, empty, and still at the
      // old dimension while embedding_model claimed otherwise.
      await seedItems([item("a", "2026-08-01", "one")]);
      await ensureItemEmbeddings(handle.sql, 4);
      await insertEmbeddings(handle.sql, [{ itemId: "a", vector: "[1,0,0,0]" }]);

      // The failure has to land *inside* the transaction, after DROP INDEX and
      // during TRUNCATE, or this tests nothing: a rejected dimension fails in
      // assertDimension before the transaction opens. A foreign key pointing at
      // the table makes TRUNCATE fail, which is exactly the shape of an
      // interruption partway through.
      await handle.sql.unsafe(
        "CREATE TABLE fk_probe (item_id text REFERENCES item_embeddings (item_id))",
      );
      await expect(rebuildItemEmbeddings(handle.sql, 8)).rejects.toThrow();
      await handle.sql.unsafe("DROP TABLE fk_probe");

      expect(await itemEmbeddingsDimension(handle.sql)).toBe(4);
      expect(await embeddingCounts(handle.sql)).toMatchObject({ embedded: 1 });
      expect(await embeddingIndexExists(handle.sql)).toBe(true);
    });

    test("clears failures belonging to the discarded model", async () => {
      await seedItems([item("a", "2026-08-01", "one")]);
      await ensureItemEmbeddings(handle.sql, 4);
      await recordEmbeddingFailure(handle.sql, "a", "too long for the old model", new Date());

      await rebuildItemEmbeddings(handle.sql, 8);

      // The new model might embed it happily; holding it back for a day on the
      // strength of the old model's opinion would be wrong.
      expect(await embeddingCounts(handle.sql)).toMatchObject({ failed: 0, pending: 1 });
    });

    test("the index can be rebuilt once the backfill is done", async () => {
      await rebuildItemEmbeddings(handle.sql, 4);
      expect(await embeddingIndexExists(handle.sql)).toBe(false);
      await createEmbeddingIndex(handle.sql);
      expect(await embeddingIndexExists(handle.sql)).toBe(true);
    });
  });

  describe("embedding_model", () => {
    test("is empty until embeddings are enabled", async () => {
      expect(await readEmbeddingModel(handle.sql)).toBeNull();
    });

    test("round-trips the active model", async () => {
      await writeEmbeddingModel(handle.sql, {
        provider: "openai-compatible",
        model: "bge-m3",
        dimensions: 1024,
      });
      expect(await readEmbeddingModel(handle.sql)).toEqual({
        provider: "openai-compatible",
        model: "bge-m3",
        dimensions: 1024,
      });
    });

    test("a second write replaces the first, because there is only ever one model", async () => {
      await writeEmbeddingModel(handle.sql, { provider: "p", model: "a", dimensions: 4 });
      await writeEmbeddingModel(handle.sql, { provider: "p", model: "b", dimensions: 8 });

      const rows = await handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM embedding_model
      `;
      expect(rows[0]?.count).toBe(1);
      expect(await readEmbeddingModel(handle.sql)).toMatchObject({ model: "b", dimensions: 8 });
    });

    test("the schema itself forbids a second row", async () => {
      await handle.sql`
        INSERT INTO embedding_model (id, provider, model, dimensions)
        VALUES (true, 'p', 'a', 4)
      `;

      // Wrapped in a real promise rather than handed to expect().rejects
      // directly: a postgres.js query is a lazy thenable, and the matcher does
      // not drive it to completion.
      const second = async () =>
        handle.sql`
          INSERT INTO embedding_model (id, provider, model, dimensions)
          VALUES (false, 'p', 'b', 8)
        `;

      // One model per instance is a schema guarantee, not a convention that
      // callers are trusted to observe.
      await expect(second()).rejects.toThrow(/check constraint/);
    });
  });
});

describe("retryBackoffSeconds", () => {
  test("starts at a minute and doubles", () => {
    expect(retryBackoffSeconds(1)).toBe(60);
    expect(retryBackoffSeconds(2)).toBe(120);
    expect(retryBackoffSeconds(3)).toBe(240);
  });

  test("caps at a day, so a fixed provider recovers without being asked", () => {
    expect(retryBackoffSeconds(100)).toBe(24 * 60 * 60);
  });
});
