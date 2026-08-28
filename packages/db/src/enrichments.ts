import type postgres from "postgres";

/**
 * Enrichment storage: what a chat model said about an article, and when.
 *
 * Rows are additive per (item, kind, prompt version, model). Readers take the
 * newest row for a kind; nothing is ever overwritten, so a prompt change can
 * be evaluated against yesterday's articles rather than replacing what the
 * previous prompt said.
 */

export type EnrichmentKind = "summary" | "translation" | "tags";

export type EnrichmentRow = {
  itemId: string;
  kind: EnrichmentKind;
  content: unknown;
  chatModel: string;
  promptVersion: string;
  createdAt: string;
};

function instant(at: Date): string {
  return at.toISOString();
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export async function writeEnrichment(
  sql: postgres.Sql,
  row: {
    itemId: string;
    kind: EnrichmentKind;
    content: unknown;
    chatModel: string;
    promptVersion: string;
    createdAt?: Date;
  },
): Promise<void> {
  const createdAt = row.createdAt ?? new Date();
  await sql`
    INSERT INTO enrichments (item_id, kind, content, chat_model, prompt_version, created_at)
    VALUES (
      ${row.itemId},
      ${row.kind},
      ${JSON.stringify(row.content)}::jsonb,
      ${row.chatModel},
      ${row.promptVersion},
      ${instant(createdAt)}::timestamptz
    )
    -- Re-running the same prompt on the same article with the same model is
    -- idempotent rather than an error: replay is a supported operation.
    ON CONFLICT (item_id, kind, prompt_version, chat_model) DO UPDATE
      SET content = excluded.content, created_at = excluded.created_at
  `;
}

/**
 * The newest enrichment of each kind for these items.
 *
 * Not filtered by the configured model: a model switch must not blank every
 * summary an install already has. What the reader gets is the most recent
 * answer, whoever produced it, and the row says which model that was.
 */
export async function latestEnrichments(
  sql: postgres.Sql,
  itemIds: readonly string[],
  kinds: readonly EnrichmentKind[],
): Promise<EnrichmentRow[]> {
  if (itemIds.length === 0 || kinds.length === 0) return [];
  const ids = [...itemIds];
  const kindList = [...kinds];
  return sql<EnrichmentRow[]>`
    SELECT DISTINCT ON (item_id, kind)
      item_id AS "itemId",
      kind,
      content,
      chat_model AS "chatModel",
      prompt_version AS "promptVersion",
      to_char(created_at AT TIME ZONE 'UTC', ${sql.unsafe(ISO)}) AS "createdAt"
    FROM enrichments
    WHERE item_id = ANY(${ids}::text[]) AND kind = ANY(${kindList}::text[])
    ORDER BY item_id, kind, created_at DESC
  `;
}

export type EnrichmentCandidate = {
  id: string;
  title: string | null;
  searchText: string;
};

/**
 * Items worth spending a model call on: recent, not yet enriched at this
 * prompt version with this model, not in backoff, ordered by whatever the
 * caller ranks by.
 *
 * `orderByInterest` uses the interest profile when one exists. Without it the
 * ordering falls back to recency, which is the same degradation the timeline
 * makes and for the same reason: an install with no history is not broken.
 */
export async function enrichmentCandidates(
  sql: postgres.Sql,
  options: {
    kind: EnrichmentKind;
    promptVersion: string;
    chatModel: string;
    limit: number;
    windowHours: number;
    userId: string;
    orderByInterest: boolean;
    now?: Date;
  },
): Promise<EnrichmentCandidate[]> {
  const now = options.now ?? new Date();

  // The interest term is a correlated subquery either way; when there is no
  // profile it evaluates to NULL for every row and the ordering falls through
  // to recency. Written as one query rather than two branches so the user id
  // stays a bound parameter -- interpolating it into a fragment would put a
  // caller-supplied value into SQL text.
  const orderByInterest = options.orderByInterest;

  return sql<EnrichmentCandidate[]>`
    SELECT i.id, i.title, i.search_text AS "searchText"
    FROM items i
    WHERE i.search_text <> ''
      AND i.published_at >= ${instant(now)}::timestamptz
        - make_interval(hours => ${options.windowHours})
      AND NOT EXISTS (
        SELECT 1 FROM enrichments en
        WHERE en.item_id = i.id
          AND en.kind = ${options.kind}
          AND en.prompt_version = ${options.promptVersion}
          AND en.chat_model = ${options.chatModel}
      )
      AND NOT EXISTS (
        SELECT 1 FROM enrichment_failures f
        WHERE f.item_id = i.id AND f.kind = ${options.kind}
          AND f.next_attempt_at > ${instant(now)}::timestamptz
      )
    ORDER BY
      CASE WHEN ${orderByInterest}::boolean THEN (
        SELECT max(1 - (e.embedding <=> c.centroid))
        FROM item_embeddings e, interest_clusters c
        WHERE e.item_id = i.id AND c.user_id = ${options.userId}::uuid
      ) END DESC NULLS LAST,
      i.published_at DESC
    LIMIT ${options.limit}
  `;
}

/** Backoff mirrors the embedding side: doubling, capped, so a bad article never blocks the queue. */
const MAX_RETRY_BACKOFF_SECONDS = 86_400;

export function enrichmentBackoffSeconds(failures: number): number {
  return Math.min(60 * 2 ** (failures - 1), MAX_RETRY_BACKOFF_SECONDS);
}

export async function recordEnrichmentFailure(
  sql: postgres.Sql,
  itemId: string,
  kind: EnrichmentKind,
  error: string,
  now = new Date(),
): Promise<void> {
  await sql`
    INSERT INTO enrichment_failures (item_id, kind, failures, last_error, next_attempt_at)
    VALUES (${itemId}, ${kind}, 1, ${error.slice(0, 1000)},
            ${instant(now)}::timestamptz + make_interval(secs => ${enrichmentBackoffSeconds(1)}))
    ON CONFLICT (item_id, kind) DO UPDATE
      SET failures = enrichment_failures.failures + 1,
          last_error = excluded.last_error,
          next_attempt_at = ${instant(now)}::timestamptz + make_interval(
            secs => LEAST(60 * 2 ^ enrichment_failures.failures, ${MAX_RETRY_BACKOFF_SECONDS})
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

export type VocabularyRow = {
  tag: string;
  status: "candidate" | "approved";
  hits: number;
};

export async function approvedTags(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ tag: string }[]>`
    SELECT tag FROM tag_vocabulary WHERE status = 'approved' ORDER BY tag
  `;
  return rows.map((row) => row.tag);
}

export async function listVocabulary(
  sql: postgres.Sql,
  status?: "candidate" | "approved",
): Promise<VocabularyRow[]> {
  return sql<VocabularyRow[]>`
    SELECT tag, status, hits
    FROM tag_vocabulary
    WHERE (${status ?? null}::text IS NULL OR status = ${status ?? null}::text)
    ORDER BY status, hits DESC, tag
  `;
}

/**
 * Record proposed candidates, incrementing the count for ones already seen.
 *
 * An approved tag proposed as a candidate is left alone: it is already in the
 * vocabulary, and bumping its count would mix "how often was this proposed
 * before approval" with usage.
 */
export async function recordCandidates(
  sql: postgres.Sql,
  candidates: readonly string[],
): Promise<void> {
  for (const tag of candidates) {
    await sql`
      INSERT INTO tag_vocabulary (tag, status, hits) VALUES (${tag}, 'candidate', 1)
      ON CONFLICT (tag) DO UPDATE
        SET hits = CASE
          WHEN tag_vocabulary.status = 'candidate' THEN tag_vocabulary.hits + 1
          ELSE tag_vocabulary.hits
        END
    `;
  }
}

export async function approveTag(sql: postgres.Sql, tag: string): Promise<boolean> {
  const rows = await sql<{ tag: string }[]>`
    UPDATE tag_vocabulary SET status = 'approved' WHERE tag = ${tag} RETURNING tag
  `;
  return rows.length > 0;
}

/**
 * Rejection deletes the row rather than marking it rejected.
 *
 * A rejected-and-re-proposed tag comes back as a fresh candidate with a count
 * of one, which is the honest signal: the model keeps thinking it applies, and
 * persistent re-proposal is itself an argument worth seeing again. A tombstone
 * would suppress that argument permanently on the strength of one decision.
 */
export async function rejectTag(sql: postgres.Sql, tag: string): Promise<boolean> {
  const rows = await sql<{ tag: string }[]>`
    DELETE FROM tag_vocabulary WHERE tag = ${tag} RETURNING tag
  `;
  return rows.length > 0;
}

/** Only approved tags are attached; the caller has already filtered against the vocabulary. */
export async function setItemTags(
  sql: postgres.Sql,
  itemId: string,
  tags: readonly string[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM item_tags WHERE item_id = ${itemId}`;
    for (const tag of tags) {
      await tx`
        INSERT INTO item_tags (item_id, tag)
        SELECT ${itemId}, ${tag}
        WHERE EXISTS (
          SELECT 1 FROM tag_vocabulary WHERE tag = ${tag} AND status = 'approved'
        )
      `;
    }
  });
}

export async function itemTags(
  sql: postgres.Sql,
  itemIds: readonly string[],
): Promise<{ itemId: string; tag: string }[]> {
  if (itemIds.length === 0) return [];
  const ids = [...itemIds];
  return sql<{ itemId: string; tag: string }[]>`
    SELECT item_id AS "itemId", tag FROM item_tags
    WHERE item_id = ANY(${ids}::text[])
    ORDER BY item_id, tag
  `;
}

export type EnrichmentStatus = {
  summaries: number;
  translations: number;
  tagged: number;
  approvedTags: number;
  candidateTags: number;
  failures: number;
};

export async function enrichmentStatus(sql: postgres.Sql): Promise<EnrichmentStatus> {
  const [row] = await sql<EnrichmentStatus[]>`
    SELECT
      (SELECT count(DISTINCT item_id)::int FROM enrichments WHERE kind = 'summary') AS summaries,
      (SELECT count(DISTINCT item_id)::int FROM enrichments WHERE kind = 'translation') AS translations,
      (SELECT count(DISTINCT item_id)::int FROM item_tags) AS tagged,
      (SELECT count(*)::int FROM tag_vocabulary WHERE status = 'approved') AS "approvedTags",
      (SELECT count(*)::int FROM tag_vocabulary WHERE status = 'candidate') AS "candidateTags",
      (SELECT count(*)::int FROM enrichment_failures) AS failures
  `;
  return (
    row ?? {
      summaries: 0,
      translations: 0,
      tagged: 0,
      approvedTags: 0,
      candidateTags: 0,
      failures: 0,
    }
  );
}
