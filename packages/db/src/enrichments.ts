import type postgres from "postgres";

import { retryBackoffSeconds } from "./embeddings.ts";
import { STORY_ROW } from "./interest.ts";

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
 * The ids of the approved tags among these slugs.
 *
 * Ids rather than slugs because attaching goes through item_tags, and the
 * prompt answers in slugs. Unknown and unapproved slugs are simply absent
 * from the result rather than an error: the model picks from a vocabulary it
 * was shown and may still answer with something else, which is a tag that does
 * not exist rather than a failure of the request.
 */
export async function approvedTagIds(
  sql: postgres.Sql,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM tag_vocabulary
    WHERE status = 'approved' AND slug = ANY(${[...slugs]}::text[])
  `;
  return rows.map((row) => row.id);
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

/**
 * One enrichment a pass wants an item to have.
 *
 * The whole combination, not just the kind: an item that has a translation of
 * yesterday's prompt is still waiting for the one this build asks for.
 */
export type WantedEnrichment = {
  kind: EnrichmentKind;
  /** Target language for a translation; ignored for the other two kinds. */
  lang?: string | undefined;
  promptVersion: string;
};

/** An item worth spending a model call on, and whether it was starred. */
export type EnrichmentCandidate = {
  id: string;
  starred: boolean;
};

export type CandidateSelection = {
  candidates: EnrichmentCandidate[];
  /**
   * How many items matched before `limit` cut the list short.
   *
   * Counted with a window function rather than by running the query twice, so
   * a pass that stops at the hourly bound can say what it left waiting instead
   * of reporting a truncated list as the whole backlog.
   */
  matched: number;
};

export type CandidateOptions = {
  userId: string;
  /** The model whose rows count as current. Anything else is somebody else's. */
  model: string;
  wanted: readonly WantedEnrichment[];
  /** How far back a pass looks. Ignored when `since` is given. */
  windowHours?: number | undefined;
  /** A rerun over history: everything published at or after this instant. */
  since?: Date | null | undefined;
  /**
   * Re-run items that already have a row, and ignore any retry backoff.
   *
   * An explicit rerun asked for by a person is treated as the decision the
   * backoff was waiting for; a scheduled pass never sets this.
   */
  force?: boolean | undefined;
  /** One row per story, as in scoreItems. */
  collapse: boolean;
  /** Every starred item rather than the newest ones, regardless of rank. */
  starredOnly?: boolean | undefined;
  limit: number;
  now?: Date | undefined;
};

/**
 * Items a pass could spend a call on, in the order it would choose them.
 *
 * Four filters, each answering one thing the design settled:
 *
 *   - The horizon. `windowHours` for a pass, `since` for a rerun over history,
 *     and neither for the starred arm: a star is an explicit request, and the
 *     spend bound that keeps it affordable is the hourly one.
 *   - What is missing. An item qualifies when it lacks at least one wanted
 *     combination, so an article with a summary and no tags is still selected
 *     for tagging. `force` removes this filter, which is what re-running an
 *     item means.
 *   - Retry backoff. A kind is skipped while its failure row says to wait, and
 *     only that kind: one kind failing must not park the others behind it.
 *   - The representative. With clustering on, a story is one call through one
 *     item, so members are not candidates (D29).
 *
 * The text is deliberately not selected. Ranking a pool of candidates pulls in
 * every item a window holds, and article bodies are large; the caller asks for
 * the bodies of the items it chose with enrichmentInputs.
 */
export async function enrichmentCandidates(
  sql: postgres.Sql,
  options: CandidateOptions,
): Promise<CandidateSelection> {
  if (options.wanted.length === 0) return { candidates: [], matched: 0 };

  const now = options.now ?? new Date();
  const kinds = options.wanted.map((want) => want.kind);
  const promptVersions = options.wanted.map((want) => want.promptVersion);
  const langs = options.wanted.map((want) => want.lang ?? "");

  // The window bounds the ranked arm, which spends on whatever is newest. A
  // star is somebody naming this article for themselves, so the starred arm is
  // not held to it; the hourly spend bound still applies to both.
  const horizon = options.starredOnly
    ? sql`TRUE`
    : options.since
      ? sql`i.published_at >= ${instant(options.since)}::timestamptz`
      : sql`i.published_at > ${instant(now)}::timestamptz
                - make_interval(hours => ${options.windowHours ?? 0}::int)`;

  const missing = options.force
    ? sql`TRUE`
    : sql`EXISTS (
          SELECT 1
          FROM unnest(${kinds}::text[], ${promptVersions}::text[], ${langs}::text[])
               AS want(kind, prompt_version, lang)
          WHERE NOT EXISTS (
            SELECT 1 FROM enrichments e
            WHERE e.item_id = i.id
              AND e.model = ${options.model}
              AND e.kind = want.kind
              AND e.prompt_version = want.prompt_version
              AND e.lang = want.lang
          )
            AND NOT EXISTS (
              SELECT 1 FROM enrichment_failures f
              WHERE f.item_id = i.id
                AND f.kind = want.kind
                AND f.next_attempt_at > ${instant(now)}::timestamptz
            )
        )`;

  const rows = await sql<Array<{ id: string; starred: boolean; matched: number }>>`
    SELECT i.id,
           (st.starred_at IS NOT NULL) AS starred,
           count(*) OVER ()::int AS matched
    FROM items i
    -- Left, not inner: most items have never been acted on and must still be
    -- candidates. The star is read here rather than in a second query so the
    -- starred arm and the ranked arm cannot disagree about who is starred.
    LEFT JOIN item_state st ON st.item_id = i.id AND st.user_id = ${options.userId}::uuid
    LEFT JOIN item_clusters ic ON ic.item_id = i.id
    LEFT JOIN clusters cl ON cl.id = ic.cluster_id
    WHERE ${horizon}
      AND ${missing}
      AND (NOT ${options.starredOnly ?? false}::boolean OR st.starred_at IS NOT NULL)
      AND (NOT ${options.collapse}::boolean OR ${sql.unsafe(STORY_ROW)})
      AND EXISTS (SELECT 1 FROM item_sources s WHERE s.item_id = i.id)
    ORDER BY ${
      options.starredOnly
        ? sql`st.starred_at DESC NULLS LAST, i.published_at DESC, i.id`
        : sql`i.published_at DESC, i.id`
    }
    LIMIT ${options.limit}
  `;

  return {
    candidates: rows.map((row) => ({ id: row.id, starred: row.starred })),
    matched: rows[0]?.matched ?? 0,
  };
}

/** What a model is asked about: the title and the body, as stored. */
export type EnrichmentInput = {
  id: string;
  title: string | null;
  summary: string | null;
  searchText: string;
};

/**
 * The bodies of the items a pass chose.
 *
 * Separate from the selection because the selection ranks a pool far larger
 * than the number of calls made: fetching article text for every candidate to
 * throw most of it away would cost more than the calls it saves.
 */
export async function enrichmentInputs(
  sql: postgres.Sql,
  itemIds: readonly string[],
): Promise<EnrichmentInput[]> {
  if (itemIds.length === 0) return [];

  const ids = [...itemIds];
  return sql<EnrichmentInput[]>`
    SELECT id, title, summary, search_text AS "searchText"
    FROM items
    WHERE id = ANY(${ids}::text[])
    ORDER BY id
  `;
}

export type EnrichmentCounts = {
  summarised: number;
  tagged: number;
  translated: number;
  failed: number;
};

/**
 * What this model has produced, and how many items are waiting on a retry.
 *
 * Scoped to the configured model and the prompt versions this build runs, for
 * the same reason currentEnrichments is: an answer from another model says
 * nothing about what this one would have said, and counting it would make a
 * model switch look like work this installation had already done.
 *
 * Failures carry no model, so they are counted whole and labelled as the
 * backlog rather than as this model's output.
 */
export async function enrichmentCounts(
  sql: postgres.Sql,
  filter: { model: string; promptVersions: readonly string[] },
): Promise<EnrichmentCounts> {
  const versions = [...filter.promptVersions];
  const rows = await sql<EnrichmentCounts[]>`
    SELECT count(DISTINCT item_id) FILTER (WHERE kind = 'summary')::int AS summarised,
           count(DISTINCT item_id) FILTER (WHERE kind = 'tags')::int AS tagged,
           count(DISTINCT item_id) FILTER (WHERE kind = 'translation')::int AS translated,
           (SELECT count(*)::int FROM enrichment_failures) AS failed
    FROM enrichments
    WHERE model = ${filter.model} AND prompt_version = ANY(${versions}::text[])
  `;
  return rows[0] ?? { summarised: 0, tagged: 0, translated: 0, failed: 0 };
}

/**
 * How many distinct items this store has answered for since an instant.
 *
 * The hourly spend bound is counted from the rows rather than from memory: a
 * counter that starts empty on every restart would let a daemon that is
 * restarted hourly spend ENRICH_MAX_ITEMS_PER_HOUR on each restart.
 */
export async function enrichedItemsSince(sql: postgres.Sql, since: Date): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(DISTINCT item_id)::int AS count
    FROM enrichments
    WHERE created_at >= ${instant(since)}::timestamptz
  `;
  return rows[0]?.count ?? 0;
}
