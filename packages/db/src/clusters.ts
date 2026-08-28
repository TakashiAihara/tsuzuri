import type postgres from "postgres";

import { itemEmbeddingsExists } from "./embeddings.ts";

/**
 * Duplicate clustering: one story, one row in a timeline.
 *
 * Two signals decide membership, and either alone is enough (design D17).
 * SimHash catches syndicated copy and keeps working with no embedding model
 * configured; the embedding distance catches the same story told in different
 * words. Requiring both would reduce this to exact-copy detection.
 */

export type UnclusteredItem = {
  id: string;
  publishedAt: string;
  /** Postgres bigint arrives as a string on this driver; parse before comparing. */
  simhash: string | null;
};

/**
 * Items with no cluster yet, oldest first.
 *
 * Oldest first so that the earliest-published member of a story is the one
 * that creates the cluster and becomes its representative, without any
 * re-election later.
 */
export async function unclusteredItems(
  sql: postgres.Sql,
  limit: number,
): Promise<UnclusteredItem[]> {
  return sql<UnclusteredItem[]>`
    SELECT
      id,
      to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",
      simhash::text AS simhash
    FROM items
    WHERE cluster_id IS NULL
    ORDER BY published_at ASC, id
    LIMIT ${limit}
  `;
}

export async function setSimhash(
  sql: postgres.Sql,
  rows: readonly { itemId: string; simhash: bigint }[],
): Promise<void> {
  for (const row of rows) {
    await sql`
      UPDATE items SET simhash = ${row.simhash.toString()}::bigint WHERE id = ${row.itemId}
    `;
  }
}

/** Items whose SimHash has never been computed. Backfill for anything predating the column. */
export async function itemsMissingSimhash(
  sql: postgres.Sql,
  limit: number,
): Promise<{ id: string; searchText: string }[]> {
  return sql<{ id: string; searchText: string }[]>`
    SELECT id, search_text AS "searchText"
    FROM items
    WHERE simhash IS NULL AND search_text <> ''
    ORDER BY published_at DESC
    LIMIT ${limit}
  `;
}

export type ClusterCandidate = {
  clusterId: string;
  representativeItem: string;
  simhash: string | null;
};

/**
 * Clusters whose representative was published near enough to be the same
 * story. The same event does not arrive a week apart, and the window is what
 * keeps the comparison set small enough to scan without an index on either
 * signal.
 */
export async function candidateClusters(
  sql: postgres.Sql,
  publishedAt: string,
  windowHours: number,
): Promise<ClusterCandidate[]> {
  return sql<ClusterCandidate[]>`
    SELECT
      c.id AS "clusterId",
      c.representative_item AS "representativeItem",
      rep.simhash::text AS simhash
    FROM clusters c
    JOIN items rep ON rep.id = c.representative_item
    WHERE rep.published_at BETWEEN
        ${publishedAt}::timestamptz - make_interval(hours => ${windowHours})
      AND ${publishedAt}::timestamptz + make_interval(hours => ${windowHours})
  `;
}

/**
 * The nearest cluster by embedding distance, within a ceiling.
 *
 * Answers null when either side has no vector, which is the normal state on an
 * install with no embedding model: SimHash then decides membership alone.
 */
export async function nearestClusterByEmbedding(
  sql: postgres.Sql,
  itemId: string,
  candidateClusterIds: readonly string[],
  maxDistance: number,
): Promise<{ clusterId: string; distance: number } | null> {
  if (candidateClusterIds.length === 0) return null;
  if (!(await itemEmbeddingsExists(sql))) return null;

  const ids = [...candidateClusterIds];
  const [row] = await sql<{ clusterId: string; distance: number }[]>`
    SELECT
      c.id AS "clusterId",
      (rep.embedding <=> mine.embedding)::float8 AS distance
    FROM clusters c
    JOIN item_embeddings rep ON rep.item_id = c.representative_item
    CROSS JOIN item_embeddings mine
    WHERE mine.item_id = ${itemId}
      AND c.id = ANY(${ids}::uuid[])
      AND (rep.embedding <=> mine.embedding) <= ${maxDistance}
    ORDER BY distance
    LIMIT 1
  `;
  return row ?? null;
}

export async function assignToCluster(
  sql: postgres.Sql,
  itemId: string,
  clusterId: string,
): Promise<void> {
  await sql`UPDATE items SET cluster_id = ${clusterId}::uuid WHERE id = ${itemId}`;
}

/** A story nobody else reported yet: a cluster of one, ready to be joined. */
export async function createClusterFor(sql: postgres.Sql, itemId: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [cluster] = await tx<{ id: string }[]>`
      INSERT INTO clusters (representative_item) VALUES (${itemId}) RETURNING id
    `;
    const id = cluster?.id;
    if (!id) throw new Error(`failed to create a cluster for ${itemId}`);
    await tx`UPDATE items SET cluster_id = ${id}::uuid WHERE id = ${itemId}`;
    return id;
  });
}

export type ClusterSize = { clusterId: string; size: number };

/** Member counts, for the `cluster_size` a collapsed listing carries. */
export async function clusterSizes(
  sql: postgres.Sql,
  clusterIds: readonly string[],
): Promise<ClusterSize[]> {
  if (clusterIds.length === 0) return [];
  const ids = [...clusterIds];
  return sql<ClusterSize[]>`
    SELECT cluster_id AS "clusterId", count(*)::int AS size
    FROM items
    WHERE cluster_id = ANY(${ids}::uuid[])
    GROUP BY cluster_id
  `;
}

export type ClusteringStatus = {
  clusters: number;
  clustered: number;
  unclustered: number;
  /** Clusters with more than one member: the duplicates actually being collapsed. */
  duplicates: number;
};

/** What /doctor reports: whether clustering has caught up, and whether it is finding anything. */
export async function clusteringStatus(sql: postgres.Sql): Promise<ClusteringStatus> {
  const [row] = await sql<ClusteringStatus[]>`
    SELECT
      (SELECT count(*)::int FROM clusters) AS clusters,
      (SELECT count(*)::int FROM items WHERE cluster_id IS NOT NULL) AS clustered,
      (SELECT count(*)::int FROM items WHERE cluster_id IS NULL) AS unclustered,
      (SELECT count(*)::int FROM (
        SELECT cluster_id FROM items
        WHERE cluster_id IS NOT NULL
        GROUP BY cluster_id HAVING count(*) > 1
      ) d) AS duplicates
  `;
  return row ?? { clusters: 0, clustered: 0, unclustered: 0, duplicates: 0 };
}

/** Every member of a cluster except the representative, for expanding a collapsed row. */
export async function clusterMembers(
  sql: postgres.Sql,
  clusterId: string,
): Promise<{ id: string; url: string; title: string | null; publishedAt: string }[]> {
  return sql<{ id: string; url: string; title: string | null; publishedAt: string }[]>`
    SELECT
      i.id,
      i.url,
      i.title,
      to_char(i.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt"
    FROM items i
    JOIN clusters c ON c.id = i.cluster_id
    WHERE i.cluster_id = ${clusterId}::uuid
      AND i.id <> c.representative_item
    ORDER BY i.published_at
  `;
}
