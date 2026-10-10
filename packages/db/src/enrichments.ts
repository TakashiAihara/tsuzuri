import type postgres from "postgres";

import { instant, MAX_RETRY_BACKOFF_SECONDS, retryBackoffSeconds } from "./embeddings.ts";
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

/** One combination an enrichment or a failure belongs to. */
export type EnrichmentTarget = {
  kind: EnrichmentKind;
  /** Target language for a translation; empty for the other two kinds. */
  lang?: string | undefined;
  model: string;
  promptVersion: string;
};

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
 * Record one attempt that failed, and when it was made.
 *
 * last_attempt_at is stamped rather than read off next_attempt_at because the
 * backoff is computed from now and always lands in the future, so it says when
 * to try again and nothing about when the call was spent. The hourly spend
 * bound needs the second of those.
 */
export async function recordEnrichmentFailure(
  sql: postgres.Sql,
  itemId: string,
  target: EnrichmentTarget,
  error: string,
  now = new Date(),
): Promise<void> {
  const first = new Date(now.getTime() + retryBackoffSeconds(1) * 1000);
  await sql`
    INSERT INTO enrichment_failures (item_id, kind, lang, model, prompt_version,
                                     failures, last_error, last_attempt_at, next_attempt_at)
    VALUES (
      ${itemId}, ${target.kind}, ${target.lang ?? ""}, ${target.model}, ${target.promptVersion},
      1, ${error.slice(0, 1000)}, ${instant(now)}::timestamptz, ${instant(first)}::timestamptz
    )
    ON CONFLICT (item_id, kind, lang, model, prompt_version) DO UPDATE
      SET failures = enrichment_failures.failures + 1,
          last_error = EXCLUDED.last_error,
          last_attempt_at = ${instant(now)}::timestamptz,
          next_attempt_at = ${instant(now)}::timestamptz + make_interval(
            secs => LEAST(
              60 * pow(2, enrichment_failures.failures),
              ${MAX_RETRY_BACKOFF_SECONDS}
            )::int
          )
  `;
}

/**
 * Whether this item is waiting out a backoff for this combination.
 *
 * Asked of the store rather than assumed from the selection, because selection
 * only promises the item lacks a wanted combination: an item chosen for
 * tagging may still be inside a summary backoff, and running the summary anyway
 * spends a call the backoff was holding.
 */
export async function inBackoff(
  sql: postgres.Sql,
  itemId: string,
  target: EnrichmentTarget,
  now = new Date(),
): Promise<boolean> {
  const rows = await sql<{ waiting: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM enrichment_failures
      WHERE item_id = ${itemId} AND kind = ${target.kind} AND lang = ${target.lang ?? ""}
        AND model = ${target.model} AND prompt_version = ${target.promptVersion}
        AND next_attempt_at > ${instant(now)}::timestamptz
    ) AS waiting
  `;
  return rows[0]?.waiting ?? false;
}

export async function clearEnrichmentFailure(
  sql: postgres.Sql,
  itemId: string,
  target: EnrichmentTarget,
): Promise<void> {
  await sql`
    DELETE FROM enrichment_failures
    WHERE item_id = ${itemId} AND kind = ${target.kind} AND lang = ${target.lang ?? ""}
      AND model = ${target.model} AND prompt_version = ${target.promptVersion}
  `;
}

/**
 * How many distinct articles of this build have proposed this tag.
 *
 * Counted from the stored `tags` enrichments rather than incremented per
 * proposal, because the question the number answers is "how many articles is
 * this about". A counter incremented on each suggestion answers a different
 * one -- "how many times did a model say it" -- and re-running one article five
 * times is enough to reach a promotion threshold on its own.
 *
 * The suggestions are already written down: every `tags` enrichment row holds
 * what the model named for that article, so counting distinct items that named
 * this slug reads the store rather than keeping a second tally beside it.
 * Scoped to one model and one prompt version because a row written by another
 * model, or by yesterday's prompt, is an answer about a question this build is
 * not asking -- counting it would make a model switch look like evidence.
 *
 * An approved or rejected row is left exactly as it is, observations included:
 * its status is a decision somebody made, and a later suggestion is not an
 * argument that overturns it.
 *
 * NOTE ponytail: this still scans every current `tags` row once per suggested
 * slug to find the one being counted. That is the ceiling until the proposals
 * are a table of their own rather than a JSON field read back out; the index
 * below only narrows which rows are scanned, not how often.
 */
export async function suggestTag(
  sql: postgres.Sql,
  slug: string,
  label: string,
  model: string,
  promptVersion: string,
): Promise<void> {
  const seen = sql`
    SELECT count(DISTINCT e.item_id)::int
    FROM enrichments e
    WHERE e.kind = 'tags'
      AND e.model = ${model}
      AND e.prompt_version = ${promptVersion}
      AND (
        (e.content->'tags') ?| ${[slug]}::text[]
        OR (e.content->'candidates') ?| ${[slug]}::text[]
      )`;

  await sql`
    INSERT INTO tag_vocabulary (slug, label, status, observations)
    VALUES (${slug}, ${label}, 'candidate', (${seen}))
    ON CONFLICT (slug) DO UPDATE
      SET observations = (${seen})
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
 *
 * Rejecting also detaches the tag from every article carrying it. Leaving it
 * attached would mean `tsuzuri tags reject` answers a question about future
 * prompts while the filter people use today still has the tag on it -- the
 * article stays tagged by something nobody chose to call that any more.
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
  if (rows.length === 0 || status !== "rejected") return rows.length > 0;

  await sql`
    DELETE FROM item_tags
    WHERE tag_id = (SELECT id FROM tag_vocabulary WHERE slug = ${slug})
  `;
  return true;
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
 * The tags attached to these items, by slug.
 *
 * Read by slug rather than by id because that is what a caller shows, and a
 * filter built from these values is what `search_articles --tags` will be
 * given. Only approved tags can be attached, so nothing here needs to say so.
 */
export async function tagsOfItems(
  sql: postgres.Sql,
  itemIds: readonly string[],
): Promise<Map<string, string[]>> {
  const attached = new Map<string, string[]>();
  if (itemIds.length === 0) return attached;

  const rows = await sql<{ itemId: string; slug: string }[]>`
    SELECT it.item_id AS "itemId", t.slug
    FROM item_tags it
    JOIN tag_vocabulary t ON t.id = it.tag_id
    WHERE it.item_id = ANY(${[...itemIds]}::text[])
    ORDER BY it.item_id, t.slug
  `;
  for (const row of rows) {
    const slugs = attached.get(row.itemId);
    if (slugs) slugs.push(row.slug);
    else attached.set(row.itemId, [row.slug]);
  }
  return attached;
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

export type CandidateSelection = {
  /**
   * Items worth a call, in the order the query chose them.
   *
   * Ids rather than rows: the star is a filter in the query, not something the
   * caller acts on, and a field nobody reads is a field that drifts from what
   * the query actually does.
   */
  candidates: string[];
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
   * Re-run items the store already holds something for, and ignore any retry
   * backoff.
   *
   * An explicit rerun asked for by a person is treated as the decision the
   * backoff was waiting for; a scheduled pass never sets this.
   *
   * A row written at or after `forceBefore` is the answer the caller already
   * has; one written before it is not, and the item is a candidate again. The
   * cutoff defaults to the instant the request began, so a rerun reaches every
   * item rather than none of them, and the response returns the cutoff it used
   * so that a second call continues past what the first wrote instead of
   * re-picking the same items.
   */
  force?: boolean | undefined;
  /** The instant a forced rerun measures against; defaults to the request time. */
  forceBefore?: Date | null | undefined;
  /** One row per story, as in scoreItems. */
  collapse: boolean;
  /** Every starred item rather than the newest ones, regardless of rank. */
  starredOnly?: boolean | undefined;
  /**
   * How many to return. Omitted means every candidate there is.
   *
   * The default arm of a pass ranks its whole window and then takes the top N,
   * so a limit here would decide the order by publication date for everything
   * past it.
   */
  limit?: number | undefined;
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
 *     for tagging. `force` keeps the same test and moves its cutoff: the item
 *     qualifies whenever it lacked a combination as of `forceBefore`, which is
 *     what leaves a later call the articles the earlier ones did not write.
 *   - Retry backoff. A kind is skipped while its failure row says to wait, and
 *     only that kind: one kind failing must not park the others behind it.
 *   - The representative. With clustering on, a story is one call through one
 *     item, so members are not candidates (D29). The starred arm is exempt: a
 *     star names one article, and an article nobody chose because another
 *     outlet published it first is still the one being asked for.
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

  // Under `force`, "already answered" means as of the cutoff the caller named:
  // a row written from it on is an answer somebody has, and a row written
  // before it is not, so the item is asked about again.
  const answered = options.force
    ? sql`
        SELECT 1 FROM enrichments e
        WHERE e.item_id = i.id
          AND e.model = ${options.model}
          AND e.kind = want.kind
          AND e.prompt_version = want.prompt_version
          AND e.lang = want.lang
          AND e.created_at >= ${instant(options.forceBefore ?? now)}::timestamptz`
    : sql`
        SELECT 1 FROM enrichments e
        WHERE e.item_id = i.id
          AND e.model = ${options.model}
          AND e.kind = want.kind
          AND e.prompt_version = want.prompt_version
          AND e.lang = want.lang`;

  // An explicit rerun is the decision a backoff was waiting for, so it asks
  // past one; a scheduled pass does not.
  const notWaitingOut = options.force
    ? sql`TRUE`
    : sql`NOT EXISTS (
          SELECT 1 FROM enrichment_failures f
          WHERE f.item_id = i.id
            AND f.kind = want.kind
            AND f.lang = want.lang
            AND f.model = ${options.model}
            AND f.prompt_version = want.prompt_version
            AND f.next_attempt_at > ${instant(now)}::timestamptz
        )`;

  const missing = sql`EXISTS (
          SELECT 1
          FROM unnest(${kinds}::text[], ${promptVersions}::text[], ${langs}::text[])
               AS want(kind, prompt_version, lang)
          WHERE NOT EXISTS (${answered})
            AND ${notWaitingOut}
        )`;

  const rows = await sql<Array<{ id: string; matched: number }>>`
    SELECT i.id,
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
      AND (
        NOT ${options.collapse}::boolean
        OR ${options.starredOnly ?? false}::boolean
        OR ${sql.unsafe(STORY_ROW)}
      )
      AND EXISTS (SELECT 1 FROM item_sources s WHERE s.item_id = i.id)
    ORDER BY ${
      options.starredOnly
        ? sql`st.starred_at DESC NULLS LAST, i.published_at DESC, i.id`
        : sql`i.published_at DESC, i.id`
    }
    ${options.limit === undefined ? sql`` : sql`LIMIT ${options.limit}`}
  `;

  return { candidates: rows.map((row) => row.id), matched: rows[0]?.matched ?? 0 };
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
 * Failures are keyed by model and prompt version too, so they are scoped the
 * same way.
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
           (SELECT count(*)::int FROM enrichment_failures
            WHERE model = ${filter.model} AND prompt_version = ANY(${versions}::text[])) AS failed
    FROM enrichments
    WHERE model = ${filter.model} AND prompt_version = ANY(${versions}::text[])
  `;
  return rows[0] ?? { summarised: 0, tagged: 0, translated: 0, failed: 0 };
}

/**
 * How many calls this store already spent since an instant.
 *
 * The seed for the hourly spend bound rather than the bound itself: the service
 * counts the calls it makes itself, and asks this once at startup so that a
 * restart does not hand it a fresh allowance. A counter that starts empty on
 * every restart lets a daemon restarted inside the hour spend
 * ENRICH_MAX_ITEMS_PER_HOUR again on each restart.
 *
 * Rows and attempts rather than items, because the bound is about calls: one
 * item can be two calls when the first answer does not parse, and an item
 * counted once no matter how many times it failed is not a bound at all. What
 * this cannot see is the calls a failure row has absorbed -- one row records
 * every attempt at one item and kind -- so a restart after repeated refusals
 * starts the hour slightly optimistic. That is the safe direction to be wrong
 * in: the alternative is an hour that never refills.
 *
 * next_attempt_at is what the backoff reads and is always in the future for a
 * fresh failure, so the attempt itself is stamped on its own column.
 */
export async function enrichmentCallsSince(sql: postgres.Sql, since: Date): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT (
      (SELECT count(*)::int FROM enrichments
       WHERE created_at >= ${instant(since)}::timestamptz)
      +
      (SELECT count(*)::int FROM enrichment_failures
       WHERE last_attempt_at >= ${instant(since)}::timestamptz)
    )::int AS count
  `;
  return rows[0]?.count ?? 0;
}
