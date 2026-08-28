import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "./client.ts";
import { createEmbeddingTable, insertEmbeddings, rebuildItemEmbeddings } from "./embeddings.ts";
import { migrate } from "./migrate.ts";
import { DEFAULT_USER_ID } from "./schema.ts";
import {
  dropInterestClusters,
  ensureInterestClusters,
  explorationItems,
  interactionCount,
  interactionRows,
  interestClustersExist,
  readInterestClusters,
  replaceInterestClusters,
  scoredItems,
} from "./scoring.ts";

/**
 * interest_clusters is runtime DDL like item_embeddings, so these tests are
 * the only check on its create, replace and the scoring SQL against real
 * pgvector operators. Skipped without TSUZURI_TEST_DATABASE_URL, like the
 * rest of the database suite.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const NOW = new Date("2026-08-28T12:00:00Z");
const DAY_MS = 24 * 3_600_000;

describeIfDb("scoring storage", () => {
  let handle: ReturnType<typeof createDatabase>;

  async function seedItem(id: string, publishedAt: Date) {
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
      VALUES (
        ${id},
        ${`https://example.com/${id}`},
        ${`https://example.com/${id}`},
        ${id},
        ${publishedAt.toISOString()},
        ${id}
      )
    `;
  }

  async function seedState(
    itemId: string,
    state: Partial<Record<"readAt" | "starredAt" | "skippedAt" | "savedAt", Date>>,
  ) {
    await handle.sql`
      INSERT INTO item_state (user_id, item_id, read_at, starred_at, skipped_at, saved_at)
      VALUES (
        ${DEFAULT_USER_ID}::uuid,
        ${itemId},
        ${state.readAt?.toISOString() ?? null},
        ${state.starredAt?.toISOString() ?? null},
        ${state.skippedAt?.toISOString() ?? null},
        ${state.savedAt?.toISOString() ?? null}
      )
    `;
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
    await handle.sql.unsafe("DROP TABLE IF EXISTS interest_clusters");
    await handle.sql`DELETE FROM item_state`;
    await handle.sql`DELETE FROM item_sources`;
    await handle.sql`DELETE FROM sources`;
    await handle.sql`DELETE FROM items`;
  });

  test("the cluster table does not exist until a profile is built", async () => {
    expect(await interestClustersExist(handle.sql)).toBe(false);
    expect(await readInterestClusters(handle.sql, DEFAULT_USER_ID)).toEqual([]);

    await ensureInterestClusters(handle.sql, 4);
    expect(await interestClustersExist(handle.sql)).toBe(true);
  });

  test("replace swaps the whole profile, not just the rows it overlaps", async () => {
    await ensureInterestClusters(handle.sql, 4);
    await replaceInterestClusters(
      handle.sql,
      DEFAULT_USER_ID,
      [
        { centroid: "[1,0,0,0]", weight: 5, itemCount: 3 },
        { centroid: "[0,1,0,0]", weight: 2, itemCount: 2 },
      ],
      NOW,
    );

    const first = await readInterestClusters(handle.sql, DEFAULT_USER_ID);
    expect(first).toHaveLength(2);
    expect(first[0]?.ordinal).toBe(0);
    expect(first[0]?.weight).toBeCloseTo(5, 5);
    expect(first[0]?.builtAt).toBe("2026-08-28T12:00:00.000Z");
    expect(JSON.parse(first[0]?.centroid ?? "[]")).toEqual([1, 0, 0, 0]);

    // A smaller rebuild must delete the surplus row, not leave a ghost
    // centroid attracting items for a cluster that no longer exists.
    await replaceInterestClusters(
      handle.sql,
      DEFAULT_USER_ID,
      [{ centroid: "[0,0,1,0]", weight: 1, itemCount: 1 }],
      NOW,
    );
    const second = await readInterestClusters(handle.sql, DEFAULT_USER_ID);
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0]?.centroid ?? "[]")).toEqual([0, 0, 1, 0]);
  });

  test("reindexing embeddings drops the profile with them", async () => {
    await ensureInterestClusters(handle.sql, 4);
    await replaceInterestClusters(
      handle.sql,
      DEFAULT_USER_ID,
      [{ centroid: "[1,0,0,0]", weight: 1, itemCount: 1 }],
      NOW,
    );

    // The new model's space is unrelated; centroids from the old one would be
    // meaningless there, and their column dimension is wrong anyway.
    await rebuildItemEmbeddings(handle.sql, 8);
    expect(await interestClustersExist(handle.sql)).toBe(false);
  });

  test("interaction rows carry the vector and every timestamp; rows without either are invisible", async () => {
    await createEmbeddingTable(handle.sql, 4);
    await seedItem("starred", NOW);
    await seedItem("merely-stored", NOW);
    await seedItem("no-vector", NOW);
    await insertEmbeddings(handle.sql, [
      { itemId: "starred", vector: "[1,0,0,0]" },
      { itemId: "merely-stored", vector: "[0,1,0,0]" },
    ]);
    await seedState("starred", { starredAt: NOW, readAt: new Date(NOW.getTime() - DAY_MS) });
    await seedState("no-vector", { readAt: NOW });

    const rows = await interactionRows(handle.sql, DEFAULT_USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.itemId).toBe("starred");
    expect(rows[0]?.starredAt).toBe("2026-08-28T12:00:00.000Z");
    expect(rows[0]?.readAt).toBe("2026-08-27T12:00:00.000Z");
    expect(rows[0]?.skippedAt).toBeNull();
    expect(JSON.parse(rows[0]?.vector ?? "[]")).toEqual([1, 0, 0, 0]);

    expect(await interactionCount(handle.sql, DEFAULT_USER_ID)).toBe(1);
  });
});

describeIfDb("scored timeline", () => {
  let handle: ReturnType<typeof createDatabase>;

  /** Every item needs a subscription: orphans are hidden, like the chronological listing. */
  const SHARED_SOURCE = "33333333-3333-4333-8333-333333333333";

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 2 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function seedSource(id: string) {
    await handle.sql`
      INSERT INTO sources (id, user_id, kind, url)
      VALUES (${id}::uuid, ${DEFAULT_USER_ID}::uuid, 'feed', ${`https://example.com/feed-${id}`})
    `;
  }

  async function seedItem(id: string, publishedAt: Date, sourceId = SHARED_SOURCE) {
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
      VALUES (
        ${id},
        ${`https://example.com/${id}`},
        ${`https://example.com/${id}`},
        ${id},
        ${publishedAt.toISOString()},
        ${id}
      )
    `;
    await handle.sql`
      INSERT INTO item_sources (item_id, source_id) VALUES (${id}, ${sourceId}::uuid)
    `;
  }

  beforeEach(async () => {
    await handle.sql.unsafe("DROP TABLE IF EXISTS item_embeddings");
    await handle.sql.unsafe("DROP TABLE IF EXISTS interest_clusters");
    await handle.sql`DELETE FROM item_state`;
    await handle.sql`DELETE FROM item_sources`;
    await handle.sql`DELETE FROM sources`;
    await handle.sql`DELETE FROM items`;

    await seedSource(SHARED_SOURCE);
    await createEmbeddingTable(handle.sql, 4);
    await ensureInterestClusters(handle.sql, 4);
    await replaceInterestClusters(
      handle.sql,
      DEFAULT_USER_ID,
      [{ centroid: "[1,0,0,0]", weight: 5, itemCount: 5 }],
      NOW,
    );
  });

  const options = {
    userId: DEFAULT_USER_ID,
    limit: 10,
    unreadOnly: false,
    sourceId: null,
    freshnessHalfLifeMs: 48 * 3_600_000,
    now: NOW,
  };

  test("orders by similarity, decays by age, and lists unembedded items last instead of hiding them", async () => {
    await seedItem("close-fresh", NOW);
    await seedItem("close-stale", new Date(NOW.getTime() - 10 * DAY_MS));
    await seedItem("far-fresh", NOW);
    await seedItem("unembedded-fresh", NOW);
    await insertEmbeddings(handle.sql, [
      { itemId: "close-fresh", vector: "[1,0,0,0]" },
      { itemId: "close-stale", vector: "[1,0,0,0]" },
      { itemId: "far-fresh", vector: "[0,1,0,0]" },
    ]);

    const rows = await scoredItems(handle.sql, options);
    expect(rows.map((row) => row.id)).toEqual([
      "close-fresh",
      "close-stale",
      "far-fresh",
      "unembedded-fresh",
    ]);

    const [closeFresh, closeStale, farFresh, unembedded] = rows;
    expect(closeFresh?.interestScore).toBeCloseTo(1, 3);
    // Ten days at a 48-hour half-life is five halvings.
    expect(closeStale?.interestScore).toBeCloseTo(2 ** -5, 3);
    // Orthogonal vector: similarity 0, so freshness has nothing to multiply.
    expect(farFresh?.interestScore).toBeCloseTo(0, 3);
    expect(unembedded?.interestScore).toBeNull();
    expect(closeFresh?.publishedAt).toBe("2026-08-28T12:00:00.000Z");
  });

  test("unreadOnly hides read items and keeps the rest", async () => {
    await seedItem("read", NOW);
    await seedItem("unread", NOW);
    await insertEmbeddings(handle.sql, [
      { itemId: "read", vector: "[1,0,0,0]" },
      { itemId: "unread", vector: "[1,0,0,0]" },
    ]);
    await handle.sql`
      INSERT INTO item_state (user_id, item_id, read_at)
      VALUES (${DEFAULT_USER_ID}::uuid, 'read', ${NOW.toISOString()})
    `;

    const rows = await scoredItems(handle.sql, { ...options, unreadOnly: true });
    expect(rows.map((row) => row.id)).toEqual(["unread"]);
  });

  test("exploration picks recent items outside the scored set, from untouched sources first", async () => {
    const touched = "11111111-1111-4111-8111-111111111111";
    const untouched = "22222222-2222-4222-8222-222222222222";
    await seedSource(touched);
    await seedSource(untouched);
    await seedItem("scored-pick", NOW, touched);
    await seedItem("from-touched", NOW, touched);
    await seedItem("from-untouched", NOW, untouched);
    await seedItem("too-old", new Date(NOW.getTime() - 30 * DAY_MS), untouched);
    // Reading an item from the touched source is what makes it touched.
    await handle.sql`
      INSERT INTO item_state (user_id, item_id, read_at)
      VALUES (${DEFAULT_USER_ID}::uuid, 'scored-pick', ${NOW.toISOString()})
    `;

    const picks = await explorationItems(handle.sql, {
      userId: DEFAULT_USER_ID,
      limit: 1,
      unreadOnly: false,
      sourceId: null,
      excludeIds: ["scored-pick"],
      now: NOW,
    });
    expect(picks.map((row) => row.id)).toEqual(["from-untouched"]);
    expect(picks[0]?.interestScore).toBeNull();

    // The window is a hard edge: a month-old item is not exploration.
    const wide = await explorationItems(handle.sql, {
      userId: DEFAULT_USER_ID,
      limit: 10,
      unreadOnly: false,
      sourceId: null,
      excludeIds: ["scored-pick"],
      now: NOW,
    });
    expect(wide.map((row) => row.id).sort()).toEqual(["from-touched", "from-untouched"]);
  });
});
