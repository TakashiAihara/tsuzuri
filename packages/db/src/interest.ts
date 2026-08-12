import type postgres from "postgres";

/**
 * The interest_clusters table: runtime DDL, the profile, and the scoring query.
 *
 * Like item_embeddings, this table carries a dimension that is unknown until an
 * embedding model is configured, so it lives here in raw SQL rather than in the
 * Drizzle mirror. The two tables are created and destroyed together on purpose:
 * a profile built in one model's vector space is meaningless in another's, so
 * anything that discards vectors must discard the profile with them.
 */

type SqlLike = postgres.Sql | postgres.TransactionSql;

const TABLE = "interest_clusters";

/** Bind an instant as text; postgres.js cannot serialise a Date on its own. */
function instant(at: Date): string {
  return at.toISOString();
}

function assertDimension(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`refusing to build a vector column with dimension ${dimensions}`);
  }
  return dimensions;
}

/** Render a vector as the text form pgvector parses. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/** Parse the text form pgvector emits. */
export function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) return [];
  return inner.split(",").map(Number);
}

export async function createInterestClusters(sql: SqlLike, dimensions: number): Promise<void> {
  const n = assertDimension(dimensions);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      ordinal         integer NOT NULL,
      centroid        vector(${n}) NOT NULL,
      positive_weight double precision NOT NULL CHECK (positive_weight > 0),
      skipped_weight  double precision NOT NULL DEFAULT 0 CHECK (skipped_weight >= 0),
      members         integer NOT NULL CHECK (members > 0),
      built_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, ordinal)
    )
  `);
}

export async function interestClustersExists(sql: SqlLike): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${TABLE}) IS NOT NULL AS exists
  `;
  return rows[0]?.exists ?? false;
}

/**
 * Discard the profile and rebuild the table at a new dimension.
 *
 * Called from the same place that rebuilds item_embeddings. There is nothing to
 * preserve: every centroid is an average of vectors that are themselves being
 * discarded.
 */
export async function rebuildInterestClusters(sql: SqlLike, dimensions: number): Promise<void> {
  const n = assertDimension(dimensions);
  if (await interestClustersExists(sql)) {
    await sql.unsafe(`TRUNCATE ${TABLE}`);
    await sql.unsafe(`ALTER TABLE ${TABLE} ALTER COLUMN centroid TYPE vector(${n})`);
    return;
  }
  await createInterestClusters(sql, n);
}

/**
 * One signalled item, with its raw timestamps and its vector.
 *
 * Timestamps rather than pre-decayed weights: the decay arithmetic lives in
 * @tsuzuri/core so that the profile builder and its tests share one
 * implementation of it. Doing it here as well would be a second one, free to
 * drift from the first.
 */
export type SignalledItem = {
  itemId: string;
  starredAt: Date | null;
  readAt: Date | null;
  skippedAt: Date | null;
  embedding: number[];
};

/**
 * Items the user has reacted to, newest signal first, with their vectors.
 *
 * Bounded by `limit`, which is what keeps a large archive from being pulled
 * into memory: the profile is built from what someone reacted to, never from
 * the corpus. Recency order for the cap because a signal old enough to fall
 * outside it has decayed to near nothing anyway.
 *
 * Items with no vector are excluded rather than defaulted. There is no sensible
 * position in the space for an article that has not been embedded.
 */
export async function signalledItems(
  sql: postgres.Sql,
  options: { userId: string; limit: number },
): Promise<SignalledItem[]> {
  const rows = await sql<
    Array<{
      itemId: string;
      starredAt: string | null;
      readAt: string | null;
      skippedAt: string | null;
      embedding: string;
    }>
  >`
    SELECT s.item_id AS "itemId",
           s.starred_at AS "starredAt",
           s.read_at AS "readAt",
           s.skipped_at AS "skippedAt",
           e.embedding::text AS embedding
    FROM item_state s
    JOIN item_embeddings e ON e.item_id = s.item_id
    WHERE s.user_id = ${options.userId}
      AND (s.starred_at IS NOT NULL OR s.read_at IS NOT NULL OR s.skipped_at IS NOT NULL)
    ORDER BY GREATEST(
      COALESCE(s.starred_at, 'epoch'::timestamptz),
      COALESCE(s.read_at, 'epoch'::timestamptz),
      COALESCE(s.skipped_at, 'epoch'::timestamptz)
    ) DESC
    LIMIT ${options.limit}
  `;

  // The driver hands timestamptz back as text on this connection, because
  // drizzle() replaces postgres.js's type parsers for the whole pool.
  const at = (value: string | null): Date | null => (value === null ? null : new Date(value));

  return rows.map((row) => ({
    itemId: row.itemId,
    starredAt: at(row.starredAt),
    readAt: at(row.readAt),
    skippedAt: at(row.skippedAt),
    embedding: parseVectorLiteral(row.embedding),
  }));
}

export type InterestCluster = {
  ordinal: number;
  centroid: number[];
  positiveWeight: number;
  skippedWeight: number;
  members: number;
};

/**
 * Replace the profile for a user.
 *
 * Wholesale, in a transaction: a partially replaced profile would rank against
 * a mixture of two runs, and there is no state in which that is the answer
 * anyone wants.
 *
 * A cluster with a zero-length centroid is refused rather than stored. Cosine
 * distance to a zero vector is NaN, PostgreSQL sorts NaN above every real
 * number, and the result would be arbitrary articles pinned to the top of the
 * timeline with no error anywhere. The caller drops these too; this is the
 * second of the two guards.
 */
export async function writeInterestProfile(
  sql: postgres.Sql,
  options: { userId: string; clusters: readonly InterestCluster[]; builtAt?: Date },
): Promise<number> {
  const builtAt = options.builtAt ?? new Date();
  const usable = options.clusters.filter(
    (cluster) =>
      cluster.positiveWeight > 0 &&
      cluster.members > 0 &&
      cluster.centroid.some((value) => value !== 0) &&
      cluster.centroid.every((value) => Number.isFinite(value)),
  );

  await sql.begin(async (tx) => {
    await tx`DELETE FROM interest_clusters WHERE user_id = ${options.userId}`;
    for (const [index, cluster] of usable.entries()) {
      await tx`
        INSERT INTO interest_clusters
          (user_id, ordinal, centroid, positive_weight, skipped_weight, members, built_at)
        VALUES (
          ${options.userId},
          ${index},
          -- ::text::vector, not ::vector: binding it as the extension type
          -- makes the parameter carry that type's OID, and the OID changes
          -- whenever the extension is dropped and recreated.
          ${toVectorLiteral(cluster.centroid)}::text::vector,
          ${cluster.positiveWeight},
          ${cluster.skippedWeight},
          ${cluster.members},
          ${instant(builtAt)}::timestamptz
        )
      `;
    }
  });

  return usable.length;
}

export type ProfileSummary = {
  clusters: number;
  builtAt: Date | null;
};

export async function readProfileSummary(
  sql: postgres.Sql,
  userId: string,
): Promise<ProfileSummary> {
  if (!(await interestClustersExists(sql))) return { clusters: 0, builtAt: null };
  const rows = await sql<Array<{ clusters: number; builtAt: string | null }>>`
    SELECT count(*)::int AS clusters, max(built_at) AS "builtAt"
    FROM interest_clusters WHERE user_id = ${userId}
  `;
  const row = rows[0];
  return {
    clusters: row?.clusters ?? 0,
    builtAt: row?.builtAt ? new Date(row.builtAt) : null,
  };
}

/**
 * How many signals exist, for deciding whether scoring may activate.
 *
 * Counts individual signals rather than rows: an article you read and then
 * starred is two, because it told us two things. Undecayed, because this
 * answers "is there enough history to cluster" and an old signal still counts
 * as history even once it barely counts as evidence.
 */
export async function signalCount(sql: postgres.Sql, userId: string): Promise<number> {
  const rows = await sql<Array<{ count: number }>>`
    SELECT (
      count(*) FILTER (WHERE starred_at IS NOT NULL)
      + count(*) FILTER (WHERE read_at IS NOT NULL)
      + count(*) FILTER (WHERE skipped_at IS NOT NULL)
    )::int AS count
    FROM item_state
    WHERE user_id = ${userId}
  `;
  return rows[0]?.count ?? 0;
}

export type ScoredItem = {
  id: string;
  url: string;
  title: string | null;
  author: string | null;
  publishedAt: string;
  publishedAtEstimated: boolean;
  summary: string | null;
  readAt: string | null;
  starredAt: string | null;
  interest: number;
  affinitySimilarity: number;
};

export type ScoreOptions = {
  userId: string;
  limit: number;
  unreadOnly: boolean;
  sourceId: string | null;
  /** Half-life applied to an item's age, in hours. */
  recencyHalfLifeHours: number;
  /** Multiplier for an item whose published_at is really the fetch time. */
  estimatedFactor: number;
  /** How far back to consider candidates, in days. */
  windowDays: number;
};

/**
 * Rank items by how well they match the interest profile.
 *
 * Two details are load-bearing and neither is obvious from reading the result:
 *
 * The affinity factor is inside max(), not applied to its result. Two clusters
 * can sit near the same item with different affinities, and the score should
 * come from the best penalised match rather than from the nearest match
 * penalised afterwards -- otherwise a cluster you almost always skip carries an
 * item on raw proximity alone.
 *
 * Centroids are filtered against the zero vector even though the writer refuses
 * to store one. The failure it guards is silent: NaN sorts first, so one
 * degenerate row would put arbitrary articles at the top with nothing logged.
 */
export async function scoreItems(
  sql: postgres.Sql,
  options: ScoreOptions,
  now = new Date(),
): Promise<ScoredItem[]> {
  const halfLifeSeconds = options.recencyHalfLifeHours * 3600;
  const windowDays = options.windowDays;

  return sql<ScoredItem[]>`
    WITH matched AS (
      SELECT i.id,
             max(
               (1 - (e.embedding <=> c.centroid))
               * (c.positive_weight / (c.positive_weight + c.skipped_weight))
             ) AS affinity_similarity
      FROM items i
      JOIN item_embeddings e ON e.item_id = i.id
      CROSS JOIN interest_clusters c
      WHERE c.user_id = ${options.userId}
        -- A usable centroid is at zero distance from itself; a zero-length one
        -- is at NaN from itself, and NaN = 0 is false. Tests the property that
        -- actually matters rather than a proxy for it, and needs no literal of
        -- the right dimension to compare against.
        AND (c.centroid <=> c.centroid) = 0
        AND i.published_at > ${instant(now)}::timestamptz
                             - make_interval(days => ${windowDays}::int)
      GROUP BY i.id
    )
    SELECT i.id,
           i.url,
           i.title,
           i.author,
           i.published_at AS "publishedAt",
           i.published_at_estimated AS "publishedAtEstimated",
           i.summary,
           st.read_at AS "readAt",
           st.starred_at AS "starredAt",
           m.affinity_similarity AS "affinitySimilarity",
           m.affinity_similarity
             * pow(0.5, extract(epoch FROM ${instant(now)}::timestamptz - i.published_at)
                        / ${halfLifeSeconds}::double precision)
             -- Cast both branches: postgres.js infers a parameter's type from
             -- its context, and an integer literal in the other branch makes
             -- that context integer, which rejects 0.7 outright.
             * CASE WHEN i.published_at_estimated
                    THEN ${options.estimatedFactor}::double precision
                    ELSE 1::double precision END
             AS interest
    FROM matched m
    JOIN items i ON i.id = m.id
    LEFT JOIN item_state st ON st.item_id = i.id AND st.user_id = ${options.userId}
    WHERE (${!options.unreadOnly} OR st.read_at IS NULL)
      AND (
        ${options.sourceId}::uuid IS NULL
        OR EXISTS (
          SELECT 1 FROM item_sources s
          WHERE s.item_id = i.id AND s.source_id = ${options.sourceId}::uuid
        )
      )
    ORDER BY interest DESC, i.published_at DESC, i.id
    LIMIT ${options.limit}
  `;
}

export type ExplorationOptions = {
  userId: string;
  limit: number;
  unreadOnly: boolean;
  sourceId: string | null;
  windowDays: number;
  /** Ids already chosen by scoring, which must not be offered again. */
  exclude: readonly string[];
};

/**
 * Items from the subscriptions the user reads least.
 *
 * The exploration slot exists so that ranking on your own history does not
 * close the loop on itself, so its candidates are chosen by what you have *not*
 * been reading rather than by score. Deterministic -- least-read subscription
 * first, then most recent -- because a randomised timeline reshuffles on every
 * refresh and cannot be tested.
 */
export async function explorationCandidates(
  sql: postgres.Sql,
  options: ExplorationOptions,
  now = new Date(),
): Promise<ScoredItem[]> {
  if (options.limit <= 0) return [];

  // Two stages, because DISTINCT ON forces its own key to sort first and that
  // is not the order the result wants. The inner query picks, for each item,
  // the least-read subscription that carried it; the outer one orders by that.
  return sql<ScoredItem[]>`
    WITH source_reads AS (
      SELECT s.source_id, count(st.item_id)::int AS reads
      FROM item_sources s
      LEFT JOIN item_state st
        ON st.item_id = s.item_id
       AND st.user_id = ${options.userId}
       AND st.read_at IS NOT NULL
      GROUP BY s.source_id
    ),
    candidates AS (
      SELECT DISTINCT ON (i.id)
             i.id,
             i.url,
             i.title,
             i.author,
             i.published_at AS "publishedAt",
             i.published_at_estimated AS "publishedAtEstimated",
             i.summary,
             st.read_at AS "readAt",
             st.starred_at AS "starredAt",
             sr.reads
      FROM items i
      JOIN item_sources src ON src.item_id = i.id
      JOIN source_reads sr ON sr.source_id = src.source_id
      LEFT JOIN item_state st ON st.item_id = i.id AND st.user_id = ${options.userId}
      WHERE i.published_at > ${instant(now)}::timestamptz
                             - make_interval(days => ${options.windowDays}::int)
        AND NOT (i.id = ANY(${[...options.exclude]}::text[]))
        AND (${!options.unreadOnly} OR st.read_at IS NULL)
        AND (
          ${options.sourceId}::uuid IS NULL
          OR src.source_id = ${options.sourceId}::uuid
        )
      ORDER BY i.id, sr.reads ASC
    )
    SELECT id,
           url,
           title,
           author,
           "publishedAt",
           "publishedAtEstimated",
           summary,
           "readAt",
           "starredAt",
           0::double precision AS "affinitySimilarity",
           0::double precision AS interest
    FROM candidates
    ORDER BY reads ASC, "publishedAt" DESC, id
    LIMIT ${options.limit}
  `;
}
