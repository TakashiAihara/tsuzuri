import type postgres from "postgres";

import { itemEmbeddingsExists } from "./embeddings.ts";

/**
 * Interest profile storage and the scored timeline query.
 *
 * Like item_embeddings, the interest_clusters table exists only at runtime:
 * a centroid's dimension is the active embedding model's dimension, which no
 * static migration can know. Everything here is raw SQL outside the Drizzle
 * mirror for the same reason.
 */

const TABLE = "interest_clusters";

/** Guard for values interpolated into DDL, mirroring embeddings.ts. */
function assertDimension(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_000) {
    throw new Error(`invalid embedding dimension: ${dimensions}`);
  }
  return dimensions;
}

/** Bind an instant as text with an explicit cast; postgres.js binds Dates unreliably across parsers. */
function instant(at: Date): string {
  return at.toISOString();
}

export async function ensureInterestClusters(sql: postgres.Sql, dimensions: number): Promise<void> {
  const n = assertDimension(dimensions);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      ordinal    int  NOT NULL,
      centroid   vector(${n}) NOT NULL,
      weight     real NOT NULL,
      item_count int  NOT NULL,
      built_at   timestamptz NOT NULL,
      PRIMARY KEY (user_id, ordinal)
    )
  `);
}

export async function interestClustersExist(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${TABLE}) IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
}

export type InterestClusterRow = {
  ordinal: number;
  /** pgvector text form, `[0.1,0.2,...]`; JSON.parse gives the numbers back. */
  centroid: string;
  weight: number;
  itemCount: number;
  /** ISO 8601. Raw queries receive timestamptz as text on this driver. */
  builtAt: string;
};

export async function readInterestClusters(
  sql: postgres.Sql,
  userId: string,
): Promise<InterestClusterRow[]> {
  if (!(await interestClustersExist(sql))) return [];
  return sql<InterestClusterRow[]>`
    SELECT
      ordinal,
      centroid::text AS centroid,
      weight::float8 AS weight,
      item_count AS "itemCount",
      to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "builtAt"
    FROM interest_clusters
    WHERE user_id = ${userId}::uuid
    ORDER BY ordinal
  `;
}

export type NewInterestCluster = {
  /** pgvector literal, from toVectorLiteral(). */
  centroid: string;
  weight: number;
  itemCount: number;
};

/** One transaction: a reader never sees half a profile. */
export async function replaceInterestClusters(
  sql: postgres.Sql,
  userId: string,
  clusters: readonly NewInterestCluster[],
  builtAt: Date,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM interest_clusters WHERE user_id = ${userId}::uuid`;
    for (const [ordinal, cluster] of clusters.entries()) {
      await tx`
        INSERT INTO interest_clusters (user_id, ordinal, centroid, weight, item_count, built_at)
        VALUES (
          ${userId}::uuid,
          ${ordinal},
          ${cluster.centroid}::vector,
          ${cluster.weight},
          ${cluster.itemCount},
          ${instant(builtAt)}::timestamptz
        )
      `;
    }
  });
}

export type InteractionRow = {
  itemId: string;
  /** pgvector text form of the item's embedding. */
  vector: string;
  readAt: string | null;
  starredAt: string | null;
  skippedAt: string | null;
  savedAt: string | null;
};

/**
 * Every interaction that can become a signal: an item_state row with at least
 * one interaction timestamp and an embedding to point at. Rows without a
 * vector are invisible to the profile by construction, which is also why the
 * activation threshold counts these rows and not item_state itself.
 */
export async function interactionRows(
  sql: postgres.Sql,
  userId: string,
): Promise<InteractionRow[]> {
  // No vector table yet -- embeddings never configured -- means no signals,
  // not an error: this is every fresh install until AI is turned on.
  if (!(await itemEmbeddingsExists(sql))) return [];
  return sql<InteractionRow[]>`
    SELECT
      st.item_id AS "itemId",
      e.embedding::text AS vector,
      to_char(st.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "readAt",
      to_char(st.starred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "starredAt",
      to_char(st.skipped_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "skippedAt",
      to_char(st.saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "savedAt"
    FROM item_state st
    JOIN item_embeddings e ON e.item_id = st.item_id
    WHERE st.user_id = ${userId}::uuid
      AND (st.read_at IS NOT NULL OR st.starred_at IS NOT NULL
        OR st.skipped_at IS NOT NULL OR st.saved_at IS NOT NULL)
  `;
}

export async function interactionCount(sql: postgres.Sql, userId: string): Promise<number> {
  if (!(await itemEmbeddingsExists(sql))) return 0;
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM item_state st
    JOIN item_embeddings e ON e.item_id = st.item_id
    WHERE st.user_id = ${userId}::uuid
      AND (st.read_at IS NOT NULL OR st.starred_at IS NOT NULL
        OR st.skipped_at IS NOT NULL OR st.saved_at IS NOT NULL)
  `;
  return row?.count ?? 0;
}

export type ScoredItemRow = {
  id: string;
  url: string;
  title: string | null;
  author: string | null;
  publishedAt: string;
  publishedAtEstimated: boolean;
  summary: string | null;
  readAt: string | null;
  starredAt: string | null;
  /** Null when the item has no embedding yet; it is still listed, last. */
  interestScore: number | null;
  /** How many items report this story. 1 when unclustered or alone. */
  clusterSize: number | null;
};

/**
 * Only cluster representatives, when a listing is collapsing duplicates.
 *
 * Written as a condition rather than a join so an item the clustering pass has
 * not reached yet still appears: an unassigned item is not a duplicate, it is
 * an item nobody has looked at.
 */
const REPRESENTATIVES_ONLY = `(
  i.cluster_id IS NULL
  OR EXISTS (
    SELECT 1 FROM clusters c
    WHERE c.id = i.cluster_id AND c.representative_item = i.id
  )
)`;

export type ScoredItemsOptions = {
  userId: string;
  limit: number;
  unreadOnly: boolean;
  sourceId: string | null;
  /** Freshness decay half-life. Interests move in weeks; timelines move in days. */
  freshnessHalfLifeMs: number;
  /** Show one row per story rather than one per copy of it. */
  collapseDuplicates?: boolean;
  now?: Date;
};

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The timeline in interest order.
 *
 * interest score = max cosine similarity to any centroid × freshness decay.
 * Items the backfill has not embedded yet score null and sort last rather than
 * vanishing: a listing that silently dropped the newest articles would be
 * indistinguishable from a broken ingest.
 */
export async function scoredItems(
  sql: postgres.Sql,
  options: ScoredItemsOptions,
): Promise<ScoredItemRow[]> {
  const now = options.now ?? new Date();
  const sourceId = options.sourceId;
  const halfLifeSeconds = options.freshnessHalfLifeMs / 1000;

  return sql<ScoredItemRow[]>`
    SELECT
      i.id,
      i.url,
      i.title,
      i.author,
      to_char(i.published_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "publishedAt",
      i.published_at_estimated AS "publishedAtEstimated",
      i.summary,
      to_char(st.read_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "readAt",
      to_char(st.starred_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "starredAt",
      (
        SELECT count(*)::int FROM items sib WHERE sib.cluster_id = i.cluster_id
      ) AS "clusterSize",
      (
        SELECT
          max(1 - (e.embedding <=> c.centroid))
          * exp(
              -ln(2)
              * GREATEST(EXTRACT(EPOCH FROM (${instant(now)}::timestamptz - i.published_at)), 0)
              / ${halfLifeSeconds}
            )
        FROM item_embeddings e, interest_clusters c
        WHERE e.item_id = i.id AND c.user_id = ${options.userId}::uuid
      )::float8 AS "interestScore"
    FROM items i
    LEFT JOIN item_state st
      ON st.item_id = i.id AND st.user_id = ${options.userId}::uuid
    WHERE (NOT ${options.unreadOnly}::boolean OR st.read_at IS NULL)
      -- Items whose every subscription is gone stay hidden, matching the
      -- chronological listing's inner join on item_sources.
      AND EXISTS (SELECT 1 FROM item_sources sub WHERE sub.item_id = i.id)
      AND (NOT ${options.collapseDuplicates ?? false}::boolean OR ${sql.unsafe(REPRESENTATIVES_ONLY)})
      AND (${sourceId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM item_sources s
        WHERE s.item_id = i.id AND s.source_id = ${sourceId}::uuid
      ))
    ORDER BY "interestScore" DESC NULLS LAST, i.published_at DESC, i.id
    LIMIT ${options.limit}
  `;
}

/** How far back the exploration slot looks. Not configuration: it bounds a sample, not a behaviour anyone tunes. */
const EXPLORATION_WINDOW_DAYS = 7;

/**
 * The exploration slot: recent items the score did not choose, preferring
 * subscriptions the user has never interacted with, random within that.
 * Ranking on your own history otherwise closes the loop on itself.
 */
export async function explorationItems(
  sql: postgres.Sql,
  options: {
    userId: string;
    limit: number;
    unreadOnly: boolean;
    sourceId: string | null;
    excludeIds: readonly string[];
    collapseDuplicates?: boolean;
    now?: Date;
  },
): Promise<ScoredItemRow[]> {
  if (options.limit <= 0) return [];
  const now = options.now ?? new Date();
  const sourceId = options.sourceId;
  const exclude = [...options.excludeIds];

  return sql<ScoredItemRow[]>`
    SELECT
      i.id,
      i.url,
      i.title,
      i.author,
      to_char(i.published_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "publishedAt",
      i.published_at_estimated AS "publishedAtEstimated",
      i.summary,
      to_char(st.read_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "readAt",
      to_char(st.starred_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "starredAt",
      NULL::float8 AS "interestScore",
      (
        SELECT count(*)::int FROM items sib WHERE sib.cluster_id = i.cluster_id
      ) AS "clusterSize"
    FROM items i
    LEFT JOIN item_state st
      ON st.item_id = i.id AND st.user_id = ${options.userId}::uuid
    WHERE i.id != ALL(${exclude}::text[])
      AND i.published_at >= ${instant(now)}::timestamptz - make_interval(days => ${EXPLORATION_WINDOW_DAYS})
      AND EXISTS (SELECT 1 FROM item_sources sub WHERE sub.item_id = i.id)
      AND (NOT ${options.collapseDuplicates ?? false}::boolean OR ${sql.unsafe(REPRESENTATIVES_ONLY)})
      AND (NOT ${options.unreadOnly}::boolean OR st.read_at IS NULL)
      AND (${sourceId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM item_sources s
        WHERE s.item_id = i.id AND s.source_id = ${sourceId}::uuid
      ))
    ORDER BY
      -- Sources the user has never touched first; the point of the slot.
      EXISTS (
        SELECT 1
        FROM item_sources isrc
        JOIN item_state hist ON hist.item_id = isrc.item_id
        WHERE isrc.source_id IN (
          SELECT source_id FROM item_sources WHERE item_id = i.id
        )
          AND hist.user_id = ${options.userId}::uuid
          AND (hist.read_at IS NOT NULL OR hist.starred_at IS NOT NULL
            OR hist.skipped_at IS NOT NULL OR hist.saved_at IS NOT NULL)
      ) ASC,
      random()
    LIMIT ${options.limit}
  `;
}
