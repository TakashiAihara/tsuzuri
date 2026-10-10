import type postgres from "postgres";

/**
 * Duplicate clustering: which story each item reports.
 *
 * item_simhash is bit(64) and has no Drizzle mirror, so this module is raw SQL
 * throughout, like the embedding store. clusters and item_clusters are
 * mirrored so the timeline query can join them; see schema.ts.
 */

type SqlLike = postgres.Sql | postgres.TransactionSql;

export type PendingClusterItem = {
  id: string;
  searchText: string;
  hasSimhash: boolean;
};

/**
 * Items no cluster has claimed yet, oldest first.
 *
 * Oldest first so the item that founds a cluster is, more often than not, the
 * one that ends up representing it, and the representative changes less as
 * later reports join.
 *
 * With the embedding signal in use, an item is not clustered until the
 * backfill has given it a vector (or has given up on it). Clustering it before
 * that would decide its membership with one signal missing, and a decision is
 * never revisited -- so a story told in different words would be split
 * permanently by nothing more than the order two workers happened to run in.
 */
export async function pendingClusterItems(
  sql: SqlLike,
  options: { limit: number; requireEmbedding: boolean },
): Promise<PendingClusterItem[]> {
  const embedded = options.requireEmbedding
    ? sql`AND (
        EXISTS (SELECT 1 FROM item_embeddings e WHERE e.item_id = i.id)
        OR EXISTS (SELECT 1 FROM embedding_failures f WHERE f.item_id = i.id)
      )`
    : sql``;

  return sql<PendingClusterItem[]>`
    SELECT i.id,
           i.search_text AS "searchText",
           EXISTS (SELECT 1 FROM item_simhash s WHERE s.item_id = i.id) AS "hasSimhash"
    FROM items i
    WHERE NOT EXISTS (SELECT 1 FROM item_clusters ic WHERE ic.item_id = i.id)
      ${embedded}
    ORDER BY i.published_at, i.id
    LIMIT ${options.limit}
  `;
}

/** `bits` is the 64-character 0/1 string from @tsuzuri/core's simhash. */
export async function writeSimhash(sql: SqlLike, itemId: string, bits: string): Promise<void> {
  if (!/^[01]{64}$/.test(bits)) throw new Error(`not a 64-bit hash: ${bits.length} characters`);
  await sql`
    INSERT INTO item_simhash (item_id, simhash)
    VALUES (${itemId}, ${bits}::bit(64))
    ON CONFLICT (item_id) DO UPDATE SET simhash = excluded.simhash, hashed_at = now()
  `;
}

export type ClusterMatch = {
  clusterId: string;
  /** Null when the embedding signal is not in use, or either side has no vector. */
  distance: number | null;
  /** Null when either side has no SimHash. */
  bits: number | null;
};

export type MatchOptions = {
  itemId: string;
  windowHours: number;
  maxDistance: number;
  maxBits: number;
  /**
   * Whether to consult item_embeddings at all. False with no embedding model
   * configured, where the table may not exist and SimHash decides alone.
   */
  useEmbedding: boolean;
};

/**
 * The clustered item this one is most like, within the window, by either
 * signal (D21), from a subscription this item did not arrive through.
 *
 * Either signal alone is enough. The best match is the one meeting more of the
 * two thresholds, then the nearer by embedding, then by SimHash -- a fixed
 * order, so the same corpus always produces the same clusters.
 */
export async function bestClusterMatch(
  sql: SqlLike,
  options: MatchOptions,
): Promise<ClusterMatch | null> {
  const distance = options.useEmbedding
    ? sql`(ce.embedding <=> me_e.embedding)::float8`
    : sql`NULL::float8`;
  const embeddingJoins = options.useEmbedding
    ? sql`LEFT JOIN item_embeddings me_e ON me_e.item_id = me.id
          LEFT JOIN item_embeddings ce ON ce.item_id = ci.id`
    : sql``;

  const [row] = await sql<ClusterMatch[]>`
    SELECT "clusterId", distance, bits
    FROM (
      SELECT ic.cluster_id AS "clusterId",
             ci.id AS candidate,
             ${distance} AS distance,
             bit_count(cs.simhash # ms.simhash)::int AS bits
      FROM items me
      JOIN items ci
        ON ci.published_at BETWEEN me.published_at - make_interval(hours => ${options.windowHours}::int)
                               AND me.published_at + make_interval(hours => ${options.windowHours}::int)
      JOIN item_clusters ic ON ic.item_id = ci.id
      LEFT JOIN item_simhash ms ON ms.item_id = me.id
      LEFT JOIN item_simhash cs ON cs.item_id = ci.id
      ${embeddingJoins}
      WHERE me.id = ${options.itemId}
        AND ci.id <> me.id
        -- Two items that share a subscription are never one story told twice.
        -- A feed does not report the same news twice; what looks alike inside
        -- one feed is a series or a follow-up. Measured on a real corpus: the
        -- three same-feed pairs that matched were parts 1-3 of one series, at
        -- cosine distances 0.122-0.132, between the true cross-outlet matches
        -- at 0.119-0.149 -- so no distance threshold separates them, and this
        -- does, exactly.
        AND NOT EXISTS (
          SELECT 1
          FROM item_sources mine
          JOIN item_sources theirs ON theirs.source_id = mine.source_id
          WHERE mine.item_id = me.id AND theirs.item_id = ci.id
        )
    ) candidates
    -- A NaN distance (a zero-length vector) compares false here, so it can
    -- never match: PostgreSQL orders NaN above every number.
    WHERE distance < ${options.maxDistance}::float8
       OR bits <= ${options.maxBits}::int
    ORDER BY COALESCE((distance < ${options.maxDistance}::float8)::int, 0)
           + COALESCE((bits <= ${options.maxBits}::int)::int, 0) DESC,
             distance ASC NULLS LAST,
             bits ASC NULLS LAST,
             candidate
    LIMIT 1
  `;
  return row ?? null;
}

export type MatchedBy = "embedding" | "simhash" | "both";

/** Which thresholds a match met. Exported so the classification is tested on its own. */
export function matchedBy(
  match: ClusterMatch,
  thresholds: { maxDistance: number; maxBits: number },
): MatchedBy {
  const byEmbedding = match.distance !== null && match.distance < thresholds.maxDistance;
  const bySimhash = match.bits !== null && match.bits <= thresholds.maxBits;
  if (byEmbedding && bySimhash) return "both";
  if (byEmbedding) return "embedding";
  return "simhash";
}

/**
 * Bring a cluster's summary columns back in line with its members.
 *
 * The representative is the earliest non-estimated published_at, ties broken
 * by the longest search_text (D23): the outlet that published first, and among
 * simultaneous ones the version with the most content. An estimated date is
 * the fetch time standing in for one nobody supplied, so it must not win
 * "first" against a real date. Recomputed from the members every time rather
 * than updated incrementally, because a member can arrive with an earlier date
 * than everything already in the cluster.
 */
async function refreshCluster(sql: SqlLike, clusterId: string): Promise<void> {
  await sql`
    UPDATE clusters c
    SET size = agg.size,
        first_published_at = agg.first,
        last_published_at = agg.last,
        representative_item_id = agg.representative,
        updated_at = now()
    FROM (
      SELECT count(*)::int AS size,
             min(i.published_at) AS first,
             max(i.published_at) AS last,
             (
               SELECT r.id
               FROM item_clusters rc
               JOIN items r ON r.id = rc.item_id
               WHERE rc.cluster_id = ${clusterId}::uuid
               ORDER BY r.published_at_estimated, r.published_at, length(r.search_text) DESC, r.id
               LIMIT 1
             ) AS representative
      FROM item_clusters ic
      JOIN items i ON i.id = ic.item_id
      WHERE ic.cluster_id = ${clusterId}::uuid
    ) agg
    WHERE c.id = ${clusterId}::uuid
  `;
}

export async function joinCluster(
  sql: postgres.Sql,
  options: { itemId: string; clusterId: string; matchedBy: MatchedBy },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO item_clusters (item_id, cluster_id, matched_by)
      VALUES (${options.itemId}, ${options.clusterId}::uuid, ${options.matchedBy})
    `;
    await refreshCluster(tx, options.clusterId);
  });
}

/** A story nobody else has reported yet: a cluster of one. */
export async function foundCluster(sql: postgres.Sql, itemId: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [cluster] = await tx<{ id: string }[]>`
      INSERT INTO clusters (representative_item_id, first_published_at, last_published_at)
      SELECT id, published_at, published_at FROM items WHERE id = ${itemId}
      RETURNING id
    `;
    if (!cluster) throw new Error(`cannot found a cluster for missing item ${itemId}`);
    await tx`
      INSERT INTO item_clusters (item_id, cluster_id, matched_by)
      VALUES (${itemId}, ${cluster.id}::uuid, NULL)
    `;
    return cluster.id;
  });
}

/**
 * Every item reporting the same story as this one, including itself.
 *
 * An unclustered item is its own story, so the answer is never empty for an
 * item that exists. Used to carry a read across a collapsed row (D24).
 */
export async function clusterMemberIds(sql: SqlLike, itemId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT ic2.item_id AS id
    FROM item_clusters ic
    JOIN item_clusters ic2 ON ic2.cluster_id = ic.cluster_id
    WHERE ic.item_id = ${itemId}
    ORDER BY ic2.item_id
  `;
  return rows.length > 0 ? rows.map((row) => row.id) : [itemId];
}

export type ClusteringCounts = {
  clusters: number;
  clusteredItems: number;
  pending: number;
};

export async function clusteringCounts(sql: SqlLike): Promise<ClusteringCounts> {
  const [row] = await sql<ClusteringCounts[]>`
    SELECT (SELECT count(*)::int FROM clusters) AS clusters,
           (SELECT count(*)::int FROM item_clusters) AS "clusteredItems",
           (SELECT count(*)::int FROM items i
            WHERE NOT EXISTS (SELECT 1 FROM item_clusters ic WHERE ic.item_id = i.id)) AS pending
  `;
  return row ?? { clusters: 0, clusteredItems: 0, pending: 0 };
}
