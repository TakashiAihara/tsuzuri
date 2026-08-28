import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDatabase,
  createEmbeddingTable,
  DEFAULT_USER_ID,
  insertEmbeddings,
  interestClustersExist,
  migrate,
  readInterestClusters,
} from "@tsuzuri/db";

import { loadConfig } from "../config.ts";
import { profileStatus, rebuildInterestProfile } from "./profile.ts";

/**
 * The rebuild against a real database: real vectors in, real centroids out.
 * The math itself is pinned in @tsuzuri/core; what this covers is the seam --
 * signals read from item_state, thresholds, skips, and what lands in
 * interest_clusters.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const NOW = new Date("2026-08-28T12:00:00Z");
const DAY_MS = 24 * 3_600_000;

describeIfDb("rebuildInterestProfile", () => {
  let handle: ReturnType<typeof createDatabase>;

  // k = 2 rather than the default: with history this small, a larger k would
  // give every point its own cluster and there would be no grouping to test.
  const config = loadConfig({
    DATABASE_URL: "postgres://unused",
    SCORING_MIN_INTERACTIONS: "3",
    SCORING_CLUSTERS: "2",
  });

  async function seedInteraction(
    id: string,
    vector: string,
    state: Partial<Record<"readAt" | "starredAt" | "skippedAt", Date>>,
  ) {
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
      VALUES (${id}, ${`https://example.com/${id}`}, ${`https://example.com/${id}`}, ${id},
              ${NOW.toISOString()}, ${id})
    `;
    await insertEmbeddings(handle.sql, [{ itemId: id, vector }]);
    await handle.sql`
      INSERT INTO item_state (user_id, item_id, read_at, starred_at, skipped_at)
      VALUES (
        ${DEFAULT_USER_ID}::uuid,
        ${id},
        ${state.readAt?.toISOString() ?? null},
        ${state.starredAt?.toISOString() ?? null},
        ${state.skippedAt?.toISOString() ?? null}
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
    await handle.sql`DELETE FROM items`;
    await createEmbeddingTable(handle.sql, 4);
  });

  test("below the threshold nothing is built, and the status says how far along history is", async () => {
    await seedInteraction("only", "[1,0,0,0]", { readAt: NOW });

    const outcome = await rebuildInterestProfile(handle.sql, config, NOW);
    expect(outcome.built).toBe(false);
    expect(outcome.reason).toBe("1/3 interactions");
    expect(await interestClustersExist(handle.sql)).toBe(false);

    const status = await profileStatus(handle.sql, config);
    expect(status.active).toBe(false);
    expect(status.signals).toBe(1);
    expect(status.threshold).toBe(3);
  });

  test("two topics in history become two centroids, and a rebuild is reproducible", async () => {
    await seedInteraction("rust-1", "[1,0,0,0]", { readAt: NOW });
    await seedInteraction("rust-2", "[0.9,0.1,0,0]", { starredAt: NOW });
    await seedInteraction("cooking-1", "[0,0,1,0]", { readAt: NOW });
    await seedInteraction("cooking-2", "[0,0,0.9,0.1]", { readAt: NOW });

    const outcome = await rebuildInterestProfile(handle.sql, config, NOW);
    expect(outcome.built).toBe(true);
    expect(outcome.signals).toBe(4);
    expect(outcome.clusters).toBe(2);

    const first = await readInterestClusters(handle.sql, DEFAULT_USER_ID);
    expect(first).toHaveLength(2);
    // The starred item carries triple weight, so its cluster says so.
    const weights = first.map((row) => row.weight).sort((a, b) => a - b);
    expect(weights[0]).toBeCloseTo(2, 3);
    expect(weights[1]).toBeCloseTo(4, 3);

    await rebuildInterestProfile(handle.sql, config, NOW);
    const second = await readInterestClusters(handle.sql, DEFAULT_USER_ID);
    expect(second).toEqual(first);

    expect((await profileStatus(handle.sql, config)).active).toBe(true);
  });

  test("skips exhaust the cluster they are nearest to, and only that one", async () => {
    // A topic read long ago, faded to 0.25 per read...
    const sixtyDaysAgo = new Date(NOW.getTime() - 60 * DAY_MS);
    await seedInteraction("faded-1", "[1,0,0,0]", { readAt: sixtyDaysAgo });
    await seedInteraction("faded-2", "[1,0,0,0]", { readAt: sixtyDaysAgo });
    // ...now being skipped fresh, which outweighs it...
    await seedInteraction("skipped-1", "[0.99,0.01,0,0]", { skippedAt: NOW });
    // ...while another topic stays alive.
    await seedInteraction("alive", "[0,1,0,0]", { readAt: NOW });

    const outcome = await rebuildInterestProfile(handle.sql, config, NOW);
    expect(outcome.built).toBe(true);
    expect(outcome.clusters).toBe(1);

    const clusters = await readInterestClusters(handle.sql, DEFAULT_USER_ID);
    const centroid = JSON.parse(clusters[0]?.centroid ?? "[]") as number[];
    // The survivor is the living topic, not the skipped one.
    expect(centroid[1]).toBeGreaterThan(0.9);
  });
});
