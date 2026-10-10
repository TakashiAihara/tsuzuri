import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "./client.ts";
import {
  bestClusterMatch,
  clusteringCounts,
  clusterMemberIds,
  foundCluster,
  joinCluster,
  matchedBy,
  pendingClusterItems,
  writeSimhash,
} from "./clustering.ts";
import { ensureItemEmbeddings, insertEmbeddings } from "./embeddings.ts";
import { migrate } from "./migrate.ts";

/**
 * Cluster assignment against a real PostgreSQL, so bit_count, the bit(64)
 * cast and pgvector's <=> are the real operators rather than stand-ins.
 *
 * SimHashes are planted rather than computed, the way the design document
 * measured the threshold: a base pattern, a neighbour three bits away, and a
 * pattern half the bits away. That keeps these tests about the matching, not
 * about how text hashes -- which @tsuzuri/core's own tests cover.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const BASE = "0".repeat(64);
const NEAR = `111${"0".repeat(61)}`;
const FAR = `${"1".repeat(32)}${"0".repeat(32)}`;

const thresholds = { maxDistance: 0.15, maxBits: 6 };
const match = (itemId: string, useEmbedding: boolean) =>
  ({ itemId, windowHours: 72, ...thresholds, useEmbedding }) as const;

describeIfDb("duplicate clustering", () => {
  let handle: ReturnType<typeof createDatabase>;

  async function seed(
    id: string,
    published: string,
    options: { estimated?: boolean; text?: string } = {},
  ) {
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, published_at_estimated, search_text)
      VALUES (${id}, ${`https://e.com/${id}`}, ${`https://e.com/${id}`}, ${id},
              ${published}, ${options.estimated ?? false}, ${options.text ?? id})
    `;
  }

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
    await ensureItemEmbeddings(handle.sql, 3);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.sql`TRUNCATE items, clusters, item_clusters, item_simhash, embedding_failures CASCADE`;
  });

  test("a story nobody else reported founds a cluster of one, with no matched_by", async () => {
    await seed("alone", "2026-10-01T00:00:00Z");
    const clusterId = await foundCluster(handle.sql, "alone");

    const [row] = await handle.sql`
      SELECT c.size, c.representative_item_id AS rep, ic.matched_by
      FROM clusters c JOIN item_clusters ic ON ic.cluster_id = c.id
      WHERE c.id = ${clusterId}::uuid
    `;
    expect(row).toEqual({ size: 1, rep: "alone", matched_by: null });
  });

  test("SimHash alone joins a near copy, with no embedding model configured", async () => {
    await seed("first", "2026-10-01T00:00:00Z");
    await seed("copy", "2026-10-01T02:00:00Z");
    await seed("other", "2026-10-01T02:00:00Z");
    await writeSimhash(handle.sql, "first", BASE);
    await writeSimhash(handle.sql, "copy", NEAR);
    await writeSimhash(handle.sql, "other", FAR);
    const clusterId = await foundCluster(handle.sql, "first");

    // useEmbedding false: item_embeddings is never touched, as on an install
    // with no model, where that table need not exist.
    const near = await bestClusterMatch(handle.sql, match("copy", false));
    expect(near).toEqual({ clusterId, distance: null, bits: 3 });
    expect(matchedBy(near as NonNullable<typeof near>, thresholds)).toBe("simhash");

    expect(await bestClusterMatch(handle.sql, match("other", false))).toBeNull();
  });

  test("the embedding signal alone joins a story told in different words", async () => {
    await seed("first", "2026-10-01T00:00:00Z");
    await seed("rewrite", "2026-10-01T02:00:00Z");
    // Far apart by SimHash, so only the embedding can be what matched.
    await writeSimhash(handle.sql, "first", BASE);
    await writeSimhash(handle.sql, "rewrite", FAR);
    await insertEmbeddings(handle.sql, [
      { itemId: "first", vector: "[1,0,0]" },
      { itemId: "rewrite", vector: "[0.99,0.1,0]" },
    ]);
    const clusterId = await foundCluster(handle.sql, "first");

    const found = await bestClusterMatch(handle.sql, match("rewrite", true));
    expect(found?.clusterId).toBe(clusterId);
    expect(found?.bits).toBe(32);
    expect(matchedBy(found as NonNullable<typeof found>, thresholds)).toBe("embedding");
  });

  test("a match on both signals is recorded as both", async () => {
    await seed("first", "2026-10-01T00:00:00Z");
    await seed("copy", "2026-10-01T02:00:00Z");
    await writeSimhash(handle.sql, "first", BASE);
    await writeSimhash(handle.sql, "copy", NEAR);
    await insertEmbeddings(handle.sql, [
      { itemId: "first", vector: "[1,0,0]" },
      { itemId: "copy", vector: "[1,0,0]" },
    ]);
    const clusterId = await foundCluster(handle.sql, "first");

    const found = await bestClusterMatch(handle.sql, match("copy", true));
    expect(found?.clusterId).toBe(clusterId);
    expect(matchedBy(found as NonNullable<typeof found>, thresholds)).toBe("both");
  });

  test("the best match is the one meeting both thresholds, not merely the nearer embedding", async () => {
    // a: nearer by embedding but far by SimHash. b: a little further by
    // embedding, close by SimHash. b meets two thresholds, a only one.
    await seed("a", "2026-10-01T00:00:00Z");
    await seed("b", "2026-10-01T00:00:00Z");
    await seed("new", "2026-10-01T01:00:00Z");
    await writeSimhash(handle.sql, "a", FAR);
    await writeSimhash(handle.sql, "b", NEAR);
    await writeSimhash(handle.sql, "new", BASE);
    await insertEmbeddings(handle.sql, [
      { itemId: "a", vector: "[1,0,0]" },
      { itemId: "b", vector: "[0.99,0.1,0]" },
      { itemId: "new", vector: "[1,0,0]" },
    ]);
    await foundCluster(handle.sql, "a");
    const clusterB = await foundCluster(handle.sql, "b");

    expect((await bestClusterMatch(handle.sql, match("new", true)))?.clusterId).toBe(clusterB);
  });

  test("two items from the same subscription never cluster, however alike", async () => {
    // A feed does not report one story twice: parts of a series look alike
    // and are different articles. Identical vectors, so only the feed rule
    // can be what keeps them apart.
    const sources = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES ('00000000-0000-0000-0000-000000000001', 'feed', 'https://a.example/feed'),
             ('00000000-0000-0000-0000-000000000001', 'feed', 'https://b.example/feed')
      RETURNING id
    `;
    const [feedA, feedB] = sources.map((row) => row.id);
    await seed("part-1", "2026-10-01T00:00:00Z");
    await seed("part-2", "2026-10-01T01:00:00Z");
    await seed("elsewhere", "2026-10-01T01:00:00Z");
    for (const [itemId, sourceId] of [
      ["part-1", feedA],
      ["part-2", feedA],
      ["elsewhere", feedB],
    ] as const) {
      await handle.sql`INSERT INTO item_sources (item_id, source_id) VALUES (${itemId}, ${sourceId as string})`;
    }
    await insertEmbeddings(handle.sql, [
      { itemId: "part-1", vector: "[1,0,0]" },
      { itemId: "part-2", vector: "[1,0,0]" },
      { itemId: "elsewhere", vector: "[1,0,0]" },
    ]);
    const clusterId = await foundCluster(handle.sql, "part-1");

    expect(await bestClusterMatch(handle.sql, match("part-2", true))).toBeNull();
    expect((await bestClusterMatch(handle.sql, match("elsewhere", true)))?.clusterId).toBe(
      clusterId,
    );

    await handle.sql`DELETE FROM sources`;
  });

  test("a series cannot join through another outlet's copy of one of its parts", async () => {
    // part-1 (feed A) and a cross-post of it (feed B) are one story. part-2
    // (feed A) matches the cross-post, a different feed -- but the story
    // already holds part-1 from feed A, so it must not join.
    const sources = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES ('00000000-0000-0000-0000-000000000001', 'feed', 'https://a.example/feed'),
             ('00000000-0000-0000-0000-000000000001', 'feed', 'https://b.example/feed')
      RETURNING id
    `;
    const [feedA, feedB] = sources.map((row) => row.id as string);
    await seed("part-1", "2026-10-01T00:00:00Z");
    await seed("cross-post", "2026-10-01T01:00:00Z");
    await seed("part-2", "2026-10-01T02:00:00Z");
    for (const [itemId, sourceId] of [
      ["part-1", feedA],
      ["cross-post", feedB],
      ["part-2", feedA],
    ] as const) {
      await handle.sql`INSERT INTO item_sources (item_id, source_id) VALUES (${itemId}, ${sourceId as string})`;
    }
    await insertEmbeddings(handle.sql, [
      { itemId: "part-1", vector: "[1,0,0]" },
      { itemId: "cross-post", vector: "[1,0,0]" },
      { itemId: "part-2", vector: "[1,0,0]" },
    ]);
    const clusterId = await foundCluster(handle.sql, "part-1");
    await joinCluster(handle.sql, { itemId: "cross-post", clusterId, matchedBy: "embedding" });

    expect(await bestClusterMatch(handle.sql, match("part-2", true))).toBeNull();

    await handle.sql`DELETE FROM sources`;
  });

  test("an item no subscription carries any more does not represent the story", async () => {
    // "unfollowed" is earliest, so it would win on date; with its feed gone
    // it cannot be listed, and the story must be shown through "followed".
    const [source] = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES ('00000000-0000-0000-0000-000000000001', 'feed', 'https://still.example/feed')
      RETURNING id
    `;
    await seed("unfollowed", "2026-10-01T00:00:00Z");
    await seed("followed", "2026-10-01T05:00:00Z");
    await handle.sql`INSERT INTO item_sources (item_id, source_id) VALUES ('followed', ${source?.id as string})`;
    // "unfollowed" founds the cluster, so the assertion only holds if the join
    // recomputes the representative.
    const clusterId = await foundCluster(handle.sql, "unfollowed");
    await joinCluster(handle.sql, { itemId: "followed", clusterId, matchedBy: "embedding" });

    const [row] =
      await handle.sql`SELECT representative_item_id AS rep FROM clusters WHERE id = ${clusterId}::uuid`;
    expect(row?.rep).toBe("followed");

    await handle.sql`DELETE FROM sources`;
  });

  test("matchedBy refuses a match that meets neither threshold", () => {
    expect(() => matchedBy({ clusterId: "c", distance: 0.5, bits: 40 }, thresholds)).toThrow(
      "neither threshold",
    );
  });

  test("a report outside the window is a different story", async () => {
    await seed("old", "2026-10-01T00:00:00Z");
    await seed("later", "2026-10-05T00:00:00Z");
    await writeSimhash(handle.sql, "old", BASE);
    await writeSimhash(handle.sql, "later", BASE);
    await foundCluster(handle.sql, "old");

    // Identical hash, four days apart: the window is what says no.
    expect(await bestClusterMatch(handle.sql, match("later", false))).toBeNull();
  });

  test("a zero-length vector never matches", async () => {
    await seed("first", "2026-10-01T00:00:00Z");
    await seed("zero", "2026-10-01T01:00:00Z");
    await insertEmbeddings(handle.sql, [
      { itemId: "first", vector: "[1,0,0]" },
      { itemId: "zero", vector: "[0,0,0]" },
    ]);
    await foundCluster(handle.sql, "first");

    // Cosine distance to a zero vector is NaN. If NaN ever compared as small,
    // every degenerate vector would join whatever cluster it met first.
    expect(await bestClusterMatch(handle.sql, match("zero", true))).toBeNull();
  });

  test("the representative is the earliest real date, not an earlier guessed one", async () => {
    // "guessed" is the fetch time standing in for a missing date, and sorts
    // first by timestamp; a real date must still win (D23). "guessed" founds
    // the cluster, so the assertion only holds if the join recomputes the
    // representative -- a founder that never gave way would pass otherwise.
    await seed("real", "2026-10-01T05:00:00Z");
    await seed("guessed", "2026-10-01T01:00:00Z", { estimated: true });
    const clusterId = await foundCluster(handle.sql, "guessed");
    await joinCluster(handle.sql, { itemId: "real", clusterId, matchedBy: "simhash" });

    const [row] = await handle.sql`
      SELECT representative_item_id AS rep, size, first_published_at AS first
      FROM clusters WHERE id = ${clusterId}::uuid
    `;
    expect(row?.rep).toBe("real");
    expect(row?.size).toBe(2);
    // first_published_at still reports the earliest date of any member.
    expect(new Date(row?.first as string).toISOString()).toBe("2026-10-01T01:00:00.000Z");
  });

  test("an earlier report that joins later takes over as representative", async () => {
    // "z-early" has the shorter text and the later id, so the date is the only
    // term that can make it the representative.
    await seed("a-late", "2026-10-01T05:00:00Z", { text: "the full article, considerably longer" });
    await seed("z-early", "2026-10-01T01:00:00Z", { text: "brief" });
    const clusterId = await foundCluster(handle.sql, "a-late");
    await joinCluster(handle.sql, { itemId: "z-early", clusterId, matchedBy: "simhash" });

    const [row] =
      await handle.sql`SELECT representative_item_id AS rep FROM clusters WHERE id = ${clusterId}::uuid`;
    expect(row?.rep).toBe("z-early");
  });

  test("simultaneous reports are represented by the one with the most content", async () => {
    // "z-long" sorts after "a-short", so the id tie-break would pick the wrong
    // one: only the length term can choose it.
    await seed("a-short", "2026-10-01T01:00:00Z", { text: "brief" });
    await seed("z-long", "2026-10-01T01:00:00Z", { text: "the full article, considerably longer" });
    const clusterId = await foundCluster(handle.sql, "a-short");
    await joinCluster(handle.sql, { itemId: "z-long", clusterId, matchedBy: "simhash" });

    const [row] =
      await handle.sql`SELECT representative_item_id AS rep FROM clusters WHERE id = ${clusterId}::uuid`;
    expect(row?.rep).toBe("z-long");
  });

  test("pending waits for the embedding backfill when the embedding signal is in use", async () => {
    await seed("embedded", "2026-10-01T00:00:00Z");
    await seed("failed", "2026-10-01T01:00:00Z");
    await seed("waiting", "2026-10-01T02:00:00Z");
    await seed("clustered", "2026-10-01T03:00:00Z");
    await insertEmbeddings(handle.sql, [{ itemId: "embedded", vector: "[1,0,0]" }]);
    await handle.sql`
      INSERT INTO embedding_failures (item_id, failures, next_attempt_at)
      VALUES ('failed', 3, now() + interval '1 day')
    `;
    await foundCluster(handle.sql, "clustered");

    const withEmbedding = await pendingClusterItems(handle.sql, {
      limit: 10,
      requireEmbedding: true,
    });
    // "failed" is let through: waiting for a vector the backfill has given up
    // on would hold it out of clustering for good.
    expect(withEmbedding.map((row) => row.id)).toEqual(["embedded", "failed"]);

    const withoutEmbedding = await pendingClusterItems(handle.sql, {
      limit: 10,
      requireEmbedding: false,
    });
    expect(withoutEmbedding.map((row) => row.id)).toEqual(["embedded", "failed", "waiting"]);
  });

  test("members of a story are found from any one of them, and an unclustered item is its own story", async () => {
    await seed("a", "2026-10-01T00:00:00Z");
    await seed("b", "2026-10-01T01:00:00Z");
    await seed("solo", "2026-10-01T02:00:00Z");
    const clusterId = await foundCluster(handle.sql, "a");
    await joinCluster(handle.sql, { itemId: "b", clusterId, matchedBy: "embedding" });

    expect(await clusterMemberIds(handle.sql, "b")).toEqual(["a", "b"]);
    expect(await clusterMemberIds(handle.sql, "solo")).toEqual(["solo"]);
  });

  test("counts report clusters, clustered items and the backlog", async () => {
    await seed("a", "2026-10-01T00:00:00Z");
    await seed("b", "2026-10-01T01:00:00Z");
    await seed("c", "2026-10-01T02:00:00Z");
    const clusterId = await foundCluster(handle.sql, "a");
    await joinCluster(handle.sql, { itemId: "b", clusterId, matchedBy: "simhash" });

    expect(await clusteringCounts(handle.sql)).toEqual({
      clusters: 1,
      clusteredItems: 2,
      pending: 1,
    });
  });

  test("writeSimhash refuses anything that is not 64 bits", async () => {
    await seed("a", "2026-10-01T00:00:00Z");
    await expect(writeSimhash(handle.sql, "a", "0101")).rejects.toThrow("not a 64-bit hash");
  });
});
