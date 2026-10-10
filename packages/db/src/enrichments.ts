import type postgres from "postgres";

import { retryBackoffSeconds } from "./embeddings.ts";

/**
 * Enrichment storage: what a chat model said about an item, and the vocabulary
 * it was allowed to say it with.
 *
 * Rows are keyed by item, kind, language, model and prompt version, so a
 * prompt change writes beside the previous answer rather than over it. That
 * key is what makes the prompt replayable over history, and it is why nothing
 * in this file overwrites an enrichment except a rerun of the same prompt on
 * the same article: the comparison is the reason the rows are kept.
 */

export type EnrichmentKind = "summary" | "translation" | "tags";
export type TagStatus = "approved" | "candidate" | "rejected";
export type TagSource = "model" | "manual";

export type EnrichmentRow = {
  itemId: string;
  kind: EnrichmentKind;
  lang: string;
  model: string;
  promptVersion: string;
  content: unknown;
  /** ISO 8601, formatted in SQL. See ISO_INSTANT. */
  createdAt: string;
};

export type TagRow = {
  id: string;
  slug: string;
  label: string;
  status: TagStatus;
  observations: number;
};

/**
 * Format a timestamp as ISO 8601 in SQL rather than relying on the driver.
 *
 * Once drizzle() wraps a postgres.js client it replaces the client's type
 * parsers, so raw queries on that client see PostgreSQL's own timestamp text
 * while every endpoint built with Drizzle sees ISO 8601. One field with two
 * shapes across two paths is a trap for anything consuming it. See the same
 * note on ISO_PUBLISHED_AT in search.ts.
 */
const ISO_INSTANT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function instant(at: Date): string {
  return at.toISOString();
}

/**
 * Store one enrichment.
 *
 * A second write on the same key replaces the content rather than failing:
 * re-running one prompt over one article is a replay, and replay is a supported
 * operation rather than a duplicate-key error.
 */
export async function writeEnrichment(
  sql: postgres.Sql,
  row: {
    itemId: string;
    kind: EnrichmentKind;
    /** The language a translation targets. Ignored for the other two kinds. */
    lang?: string;
    model: string;
    promptVersion: string;
    content: unknown;
  },
): Promise<void> {
  await sql`
    INSERT INTO enrichments (item_id, kind, lang, model, prompt_version, content)
    VALUES (
      ${row.itemId},
      ${row.kind},
      ${row.lang ?? ""},
      ${row.model},
      ${row.promptVersion},
      ${JSON.stringify(row.content)}::jsonb
    )
    ON CONFLICT (item_id, kind, lang, model, prompt_version) DO UPDATE
      SET content = EXCLUDED.content, created_at = now()
  `;
}

export type CurrentEnrichmentFilter = {
  kind?: EnrichmentKind;
  model: string;
  promptVersion: string;
  lang?: string;
};

/**
 * The enrichment these items currently have: the row for the configured model
 * and the prompt version this code is running.
 *
 * Scoped to that combination deliberately. Answering with the newest row
 * whoever wrote it would mean a chat model switch silently changed every
 * summary an install had, and the two are not comparable: one model's answer
 * says nothing about what another would have said.
 */
export async function currentEnrichments(
  sql: postgres.Sql,
  itemIds: readonly string[],
  filter: CurrentEnrichmentFilter,
): Promise<EnrichmentRow[]> {
  if (itemIds.length === 0) return [];

  const ids = [...itemIds];
  const kind = filter.kind ?? null;
  const lang = filter.lang ?? null;

  return sql<EnrichmentRow[]>`
    SELECT item_id AS "itemId",
           kind,
           lang,
           model,
           prompt_version AS "promptVersion",
           content,
           ${sql.unsafe(ISO_INSTANT)} AS "createdAt"
    FROM enrichments
    WHERE item_id = ANY(${ids}::text[])
      AND model = ${filter.model}
      AND prompt_version = ${filter.promptVersion}
      AND (${kind}::text IS NULL OR kind = ${kind}::text)
      AND (${lang}::text IS NULL OR lang = ${lang}::text)
    ORDER BY item_id, kind, lang
  `;
}

/**
 * The longest an item waits between enrichment attempts.
 *
 * Spelled out here rather than imported because the doubling has to be
 * computed inside the statement below, from the row's stored count, so that two
 * workers cannot both read "1" and both schedule the same retry. It is the
 * same day the embedding backoff stops at, and the arithmetic itself is
 * retryBackoffSeconds().
 */
const MAX_RETRY_BACKOFF_SECONDS = 24 * 60 * 60;

export async function recordEnrichmentFailure(
  sql: postgres.Sql,
  itemId: string,
  kind: EnrichmentKind,
  error: string,
  now = new Date(),
): Promise<void> {
  const first = new Date(now.getTime() + retryBackoffSeconds(1) * 1000);
  await sql`
    INSERT INTO enrichment_failures (item_id, kind, failures, last_error, next_attempt_at)
    VALUES (${itemId}, ${kind}, 1, ${error.slice(0, 1000)}, ${instant(first)}::timestamptz)
    ON CONFLICT (item_id, kind) DO UPDATE
      SET failures = enrichment_failures.failures + 1,
          last_error = EXCLUDED.last_error,
          next_attempt_at = ${instant(now)}::timestamptz + make_interval(
            secs => LEAST(
              60 * pow(2, enrichment_failures.failures),
              ${MAX_RETRY_BACKOFF_SECONDS}
            )::int
          )
  `;
}

export async function clearEnrichmentFailure(
  sql: postgres.Sql,
  itemId: string,
  kind: EnrichmentKind,
): Promise<void> {
  await sql`DELETE FROM enrichment_failures WHERE item_id = ${itemId} AND kind = ${kind}`;
}

/**
 * Record a tag the model proposed, or count one more proposal of it.
 *
 * An approved or rejected row is left exactly as it is, observations included:
 * its status is a decision somebody made, and a later suggestion is not an
 * argument that overturns it. Counting proposals against a row that is no
 * longer a candidate for anything would put a number there meaning nothing.
 */
export async function suggestTag(sql: postgres.Sql, slug: string, label: string): Promise<void> {
  await sql`
    INSERT INTO tag_vocabulary (slug, label, status, observations)
    VALUES (${slug}, ${label}, 'candidate', 1)
    ON CONFLICT (slug) DO UPDATE
      SET observations = tag_vocabulary.observations + 1
      WHERE tag_vocabulary.status = 'candidate'
  `;
}

/** The slugs the tagging prompt may choose from, which is only the approved ones. */
export async function approvedTags(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM tag_vocabulary WHERE status = 'approved' ORDER BY slug
  `;
  return rows.map((row) => row.slug);
}

/**
 * Move a tag between candidate, approved and rejected, and report whether
 * there was one to move.
 *
 * approved_at is stamped on approval and cleared on anything else, so the
 * column cannot go on claiming a tag is approved after it stops being one.
 */
export async function setTagStatus(
  sql: postgres.Sql,
  slug: string,
  status: TagStatus,
): Promise<boolean> {
  const rows = await sql<{ slug: string }[]>`
    UPDATE tag_vocabulary
    SET status = ${status},
        approved_at = CASE WHEN ${status} = 'approved' THEN now() ELSE NULL END
    WHERE slug = ${slug}
    RETURNING slug
  `;
  return rows.length > 0;
}

/**
 * Candidates the model has proposed often enough to be worth a decision.
 *
 * Candidates only: an approved tag is not waiting for anybody, and a rejected
 * one has been answered already. Ordered by how often it was proposed, which
 * is the only evidence there is about whether it deserves approving.
 */
export async function tagsForReview(sql: postgres.Sql, threshold: number): Promise<TagRow[]> {
  return sql<TagRow[]>`
    SELECT id, slug, label, status, observations
    FROM tag_vocabulary
    WHERE status = 'candidate' AND observations >= ${threshold}
    ORDER BY observations DESC, slug
  `;
}

/**
 * Attach tags to an item, and return how many were attached.
 *
 * The approved test is in the statement rather than left to the caller, because
 * the model chooses from a vocabulary it was shown and that vocabulary can
 * change between the prompt and the write. A tag that is not approved is not a
 * tag, and letting one through would let the model widen its own vocabulary by
 * asking twice.
 */
export async function attachTags(
  sql: postgres.Sql,
  itemId: string,
  tagIds: readonly string[],
  source: TagSource,
): Promise<number> {
  if (tagIds.length === 0) return 0;

  const ids = [...tagIds];
  await sql`
    INSERT INTO item_tags (item_id, tag_id, source)
    SELECT ${itemId}, t.id, ${source}
    FROM tag_vocabulary t
    WHERE t.id = ANY(${ids}::uuid[]) AND t.status = 'approved'
    ON CONFLICT DO NOTHING
  `;

  const rows = await sql<{ attached: number }[]>`
    SELECT count(*)::int AS attached
    FROM item_tags
    WHERE item_id = ${itemId} AND tag_id = ANY(${ids}::uuid[])
  `;
  return rows[0]?.attached ?? 0;
}

/**
 * Delete every enrichment that is not one of the named combinations, and
 * report how many rows went.
 *
 * Which combinations survive is the caller's to name, never a rule computed
 * here: automatic pruning would delete the comparison the key exists to make
 * possible (D27). Naming nothing therefore keeps nothing.
 */
export async function pruneEnrichments(
  sql: postgres.Sql,
  keep: ReadonlyArray<{ model: string; promptVersion: string }>,
): Promise<number> {
  const models = keep.map((entry) => entry.model);
  const promptVersions = keep.map((entry) => entry.promptVersion);

  const rows = await sql<{ pruned: number }[]>`
    WITH pruned AS (
      DELETE FROM enrichments e
      WHERE NOT EXISTS (
        SELECT 1
        FROM unnest(${models}::text[], ${promptVersions}::text[]) AS keep (model, prompt_version)
        WHERE keep.model = e.model AND keep.prompt_version = e.prompt_version
      )
      RETURNING 1
    )
    SELECT count(*)::int AS pruned FROM pruned
  `;
  return rows[0]?.pruned ?? 0;
}
