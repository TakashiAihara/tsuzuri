import type postgres from "postgres";

import { itemEmbeddingsExists } from "./embeddings.ts";

/**
 * Hybrid search: PGroonga and pgvector, fused with Reciprocal Rank Fusion.
 *
 * Neither half is a fallback for the other. Vector similarity buries exact
 * proper nouns -- a query for `Rust` lands among its conceptual neighbours --
 * while term matching misses paraphrase entirely. Fusing ranks rather than
 * scores is what lets two incomparable numbers decide one ordering.
 *
 * Three things in the SQL below are load-bearing, and each of them was learned
 * by measuring rather than by reading:
 *
 *   pgroonga_score() returns 0 for any row the planner did not fetch through
 *   the PGroonga index. The results stay correct and only the ranking collapses,
 *   with no error anywhere -- so the text arm is shaped to keep the index scan
 *   unavoidable, and search.test.ts asserts scores are non-zero for every
 *   filter combination the endpoint supports.
 *
 *   That score is raw term frequency, with no length normalisation. Left alone,
 *   a long article mentioning a term in passing outranks a short article about
 *   it, which is precisely the exact-product-name case this feature exists to
 *   get right. Dividing by sqrt(length) is the correction.
 *
 *   The vector arm returns its nearest N however far away they are. For a query
 *   few documents match textually, that fills the tail of every result set with
 *   unrelated articles, so candidates past a maximum distance are dropped.
 */

export type SearchFilters = {
  /** Only items published at or after this instant. */
  since?: Date | null;
  /** Only items delivered by this subscription. */
  sourceId?: string | null;
  /** Exclude items already read by the user. */
  unreadOnly?: boolean;
  userId: string;
};

export type SearchOptions = SearchFilters & {
  /** Raw terms from the query, escaped in SQL before use. */
  terms: string[];
  /**
   * The query embedded by the active model, as a pgvector literal. Null
   * whenever the vector arm cannot run, which the caller decides: no model
   * configured, a model mismatch, or the provider failing on this query.
   */
  queryVector?: string | null;
  limit: number;
  /** Candidates each arm contributes before fusion. */
  candidateDepth?: number;
  /** Cosine distance beyond which a vector candidate is not a result. */
  maxDistance?: number;
};

export type SearchHit = {
  id: string;
  url: string;
  title: string | null;
  /** ISO 8601, formatted in SQL. See ISO_PUBLISHED_AT. */
  publishedAt: string;
  summary: string | null;
  /** Highlighted excerpt, absent for items only the vector arm found. */
  snippet: string | null;
  rrf: number;
  textRank: number | null;
  vectorRank: number | null;
};

export type SearchResult = {
  mode: "hybrid" | "text-only";
  hits: SearchHit[];
};

/** Reciprocal Rank Fusion constant. Mirrors RRF_K in @tsuzuri/core. */
const RRF_K = 60;

/**
 * Format a timestamp as ISO 8601 in SQL rather than relying on the driver.
 *
 * Once drizzle() wraps a postgres.js client it replaces the client's type
 * parsers, because it maps values itself. Raw queries on that same client then
 * receive timestamps as PostgreSQL's own text format -- `2026-08-08
 * 11:23:34.994689+00` -- while every endpoint built with Drizzle returns
 * `2026-08-08T11:23:34.994Z`. Two shapes for one field across two endpoints is
 * a trap for anything consuming the API, and an agent gets it wrong quietly.
 *
 * Formatting here makes the output the same whatever the driver is doing.
 */
const ISO_PUBLISHED_AT = `to_char(i.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Default cosine distance ceiling for the vector arm. */
export const DEFAULT_MAX_DISTANCE = 0.6;

function candidateDepthFor(options: SearchOptions): number {
  // Wider than the requested limit: an item ranked poorly by one arm and well
  // by the other has to be reachable for fusion to have anything to do.
  return options.candidateDepth ?? Math.max(options.limit * 10, 200);
}

/**
 * Escape the terms and join them into a PGroonga query.
 *
 * Escaping happens in the database rather than in TypeScript because the rules
 * belong to the installed PGroonga, and a copy maintained here would be a
 * second opinion that silently goes stale. Note that pgroonga_query_escape
 * escapes operators too, which is the intent: input is literal text, and the
 * only operator in the final query is the OR this function puts there.
 */
async function buildQuery(sql: postgres.Sql, terms: string[]): Promise<string | null> {
  if (terms.length === 0) return null;
  const rows = await sql<{ query: string | null }[]>`
    SELECT array_to_string(
      ARRAY(SELECT pgroonga_query_escape(t) FROM unnest(${terms}::text[]) AS t WHERE t <> ''),
      ' OR '
    ) AS query
  `;
  const query = rows[0]?.query;
  return query && query.length > 0 ? query : null;
}

export async function hybridSearch(
  sql: postgres.Sql,
  options: SearchOptions,
): Promise<SearchResult> {
  const queryVector = options.queryVector ?? null;
  // Resolved before the empty-query shortcut, so an empty query reports the
  // same mode a real one would. Deciding it from queryVector alone made the
  // answer depend on the input: with no vector table, an empty query claimed
  // "hybrid" and a non-empty one admitted "text-only" on the same install.
  const useVector = queryVector !== null && (await itemEmbeddingsExists(sql));

  const query = await buildQuery(sql, options.terms);
  if (!query) return { mode: useVector ? "hybrid" : "text-only", hits: [] };

  const depth = candidateDepthFor(options);
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const since = options.since ? options.since.toISOString() : null;
  const sourceId = options.sourceId ?? null;
  const unreadOnly = options.unreadOnly ?? false;

  // Narrowed here rather than relying on useVector, so the vector literal is
  // known to be present where the query interpolates it.
  if (useVector && queryVector !== null) {
    const hits = await sql<SearchHit[]>`
        WITH text_arm AS (
          SELECT id, row_number() OVER (ORDER BY score DESC, published_at DESC) AS rank
          FROM (
            SELECT
              i.id,
              i.published_at,
              -- Length-normalised term frequency; see the note at the top.
              pgroonga_score(i.tableoid, i.ctid) / sqrt(GREATEST(length(i.search_text), 1)) AS score
            FROM items i
            WHERE i.search_text &@~ ${query}
              AND (${since}::timestamptz IS NULL OR i.published_at >= ${since}::timestamptz)
              AND (${sourceId}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM item_sources s
                WHERE s.item_id = i.id AND s.source_id = ${sourceId}::uuid
              ))
              AND (NOT ${unreadOnly}::boolean OR NOT EXISTS (
                SELECT 1 FROM item_state st
                WHERE st.item_id = i.id AND st.user_id = ${options.userId}::uuid
                  AND st.read_at IS NOT NULL
              ))
            ORDER BY score DESC
            LIMIT ${depth}
          ) t
        ),
        vector_arm AS (
          SELECT id, row_number() OVER (ORDER BY distance) AS rank
          FROM (
            SELECT e.item_id AS id, e.embedding <=> ${queryVector}::vector AS distance
            FROM item_embeddings e
            WHERE EXISTS (
                SELECT 1 FROM items i
                WHERE i.id = e.item_id
                  AND (${since}::timestamptz IS NULL OR i.published_at >= ${since}::timestamptz)
              )
              AND (${sourceId}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM item_sources s
                WHERE s.item_id = e.item_id AND s.source_id = ${sourceId}::uuid
              ))
              AND (NOT ${unreadOnly}::boolean OR NOT EXISTS (
                SELECT 1 FROM item_state st
                WHERE st.item_id = e.item_id AND st.user_id = ${options.userId}::uuid
                  AND st.read_at IS NOT NULL
              ))
            ORDER BY e.embedding <=> ${queryVector}::vector
            LIMIT ${depth}
          ) v
          WHERE distance < ${maxDistance}
        ),
        fused AS (
          SELECT
            COALESCE(t.id, v.id) AS id,
            COALESCE(1.0 / (${RRF_K} + t.rank), 0) + COALESCE(1.0 / (${RRF_K} + v.rank), 0) AS rrf,
            t.rank AS text_rank,
            v.rank AS vector_rank
          FROM text_arm t
          FULL OUTER JOIN vector_arm v ON v.id = t.id
        )
        SELECT
          i.id,
          i.url,
          i.title,
          ${sql.unsafe(ISO_PUBLISHED_AT)} AS "publishedAt",
          i.summary,
          (pgroonga_snippet_html(
            i.search_text, pgroonga_query_extract_keywords(${query})
          ))[1] AS snippet,
          f.rrf::float8 AS rrf,
          f.text_rank::int AS "textRank",
          f.vector_rank::int AS "vectorRank"
        FROM fused f
        JOIN items i ON i.id = f.id
        ORDER BY f.rrf DESC, i.published_at DESC
        LIMIT ${options.limit}
    `;
    return { mode: "hybrid", hits: [...hits] };
  }

  const hits = await sql<SearchHit[]>`
        WITH text_arm AS (
          SELECT id, row_number() OVER (ORDER BY score DESC, published_at DESC) AS rank
          FROM (
            SELECT
              i.id,
              i.published_at,
              pgroonga_score(i.tableoid, i.ctid) / sqrt(GREATEST(length(i.search_text), 1)) AS score
            FROM items i
            WHERE i.search_text &@~ ${query}
              AND (${since}::timestamptz IS NULL OR i.published_at >= ${since}::timestamptz)
              AND (${sourceId}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM item_sources s
                WHERE s.item_id = i.id AND s.source_id = ${sourceId}::uuid
              ))
              AND (NOT ${unreadOnly}::boolean OR NOT EXISTS (
                SELECT 1 FROM item_state st
                WHERE st.item_id = i.id AND st.user_id = ${options.userId}::uuid
                  AND st.read_at IS NOT NULL
              ))
            ORDER BY score DESC
            LIMIT ${depth}
          ) t
        )
        SELECT
          i.id,
          i.url,
          i.title,
          ${sql.unsafe(ISO_PUBLISHED_AT)} AS "publishedAt",
          i.summary,
          (pgroonga_snippet_html(
            i.search_text, pgroonga_query_extract_keywords(${query})
          ))[1] AS snippet,
          -- One arm reduces RRF to ordering by that arm's rank, so the shape of
          -- the response does not change when embeddings are off.
          (1.0 / (${RRF_K} + t.rank))::float8 AS rrf,
          t.rank::int AS "textRank",
          NULL::int AS "vectorRank"
        FROM text_arm t
        JOIN items i ON i.id = t.id
        ORDER BY t.rank
        LIMIT ${options.limit}
  `;

  return { mode: "text-only", hits: [...hits] };
}

/**
 * The raw text score for a query, for tests and for diagnosis.
 *
 * Exists because a zero score is the silent failure mode of this whole feature:
 * it means the planner stopped using the PGroonga index, and nothing else in
 * the system would notice.
 */
export async function textScores(
  sql: postgres.Sql,
  terms: string[],
  limit = 20,
): Promise<{ id: string; score: number }[]> {
  const query = await buildQuery(sql, terms);
  if (!query) return [];
  return sql<{ id: string; score: number }[]>`
    SELECT i.id, pgroonga_score(i.tableoid, i.ctid)::float8 AS score
    FROM items i
    WHERE i.search_text &@~ ${query}
    ORDER BY score DESC
    LIMIT ${limit}
  `;
}
