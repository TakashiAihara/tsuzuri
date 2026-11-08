import type { SourceStatus } from "@tsuzuri/core";
import type postgres from "postgres";

/**
 * The loader's SQL half: the loaded_objects ledger and the per-object apply.
 *
 * Raw SQL on the postgres.js client, like embeddings.ts and clustering.ts;
 * loaded_objects is mirrored in schema.ts so schema.test.ts keeps the two
 * honest. Everything that writes runs inside one transaction per storage
 * object — the item rows, their item_sources links and the ledger mark commit
 * or roll back together, so a crash can never record an object whose rows
 * were never stored. Applying is idempotent per row rather than per object:
 * a rebuild re-applies every object and ON CONFLICT DO NOTHING makes the
 * second pass a no-op for items and links alike.
 */

/**
 * One validated row of an items/*.parquet object, in the shape `items` takes.
 * searchText is already derived by the caller; raw stays in storage and is
 * not a column here.
 */
export type LoadRow = {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  author: string | null;
  guid: string | null;
  publishedAt: Date;
  publishedAtEstimated: boolean;
  contentHtml: string | null;
  summary: string | null;
  searchText: string;
  fetchedAt: Date;
  sourceId: string;
};

/**
 * One _state/collector.json subscription entry, minus recentIds — the fetch
 * bookkeeping the collector owns and the sources table mirrors. Dates are
 * ISO strings, as the collector writes them.
 */
export type SourceFetchStateRow = {
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  nextFetchAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  status: SourceStatus;
};

/** Every storage key the loader has already applied. */
export async function loadedKeys(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<{ key: string }[]>`SELECT key FROM loaded_objects`;
  return new Set(rows.map((row) => row.key));
}

/**
 * Apply one storage object: its items, the item_sources links that have a
 * source to point at, and the loaded_objects mark — one transaction, so a
 * failure anywhere leaves the object unmarked and fully unapplied.
 *
 * `rows` are applied in the order given and the first row for an id wins (the
 * caller orders them). `rejected` is the count of rows the caller's
 * validation refused, kept on the ledger for diagnosis; a reload recomputes
 * it. Returns how many items and links were actually new.
 */
export async function applyItemObject(
  sql: postgres.Sql,
  key: string,
  rows: LoadRow[],
  rejected = 0,
): Promise<{ inserted: number; linked: number }> {
  // Duplicates are dropped here rather than left to ON CONFLICT inside one
  // statement: jsonb_to_recordset and a join promise no row order, so which
  // copy reached the table first would be up to the planner.
  const seenItems = new Set<string>();
  const itemRows = rows.filter((row) => !seenItems.has(row.id) && seenItems.add(row.id));
  const seenLinks = new Set<string>();
  const linkRows = rows.filter((row) => {
    const pair = `${row.id} ${row.sourceId}`;
    return !seenLinks.has(pair) && seenLinks.add(pair);
  });

  return sql.begin(async (tx) => {
    let inserted = 0;
    let linked = 0;

    if (rows.length > 0) {
      const insertedItems = await tx<{ id: string }[]>`
        INSERT INTO items (
          id, url, canonical_url, title, author, guid,
          published_at, published_at_estimated, content_html, summary,
          search_text, fetched_at
        )
        SELECT id, url, canonical_url, title, author, guid,
               published_at, published_at_estimated, content_html, summary,
               search_text, fetched_at
        FROM jsonb_to_recordset(${jsonb(tx, itemRows.map(itemRecord))}::jsonb)
          AS t(
            id text, url text, canonical_url text, title text, author text,
            guid text, published_at timestamptz, published_at_estimated boolean,
            content_html text, summary text, search_text text, fetched_at timestamptz
          )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      inserted = insertedItems.length;

      // Links go in for every row whose source_id is a live subscription,
      // whether or not its item was new: an item that already existed still
      // gains the link it never got. source_id compares as text because the
      // column may hold an id that is not a uuid at all, which a ::uuid cast
      // would reject for the whole batch.
      const insertedLinks = await tx<{ item_id: string }[]>`
        INSERT INTO item_sources (item_id, source_id, first_seen_at)
        SELECT t.item_id, s.id, t.first_seen_at
        FROM jsonb_to_recordset(${jsonb(tx, linkRows.map(linkRecord))}::jsonb)
          AS t(item_id text, source_id text, first_seen_at timestamptz)
        JOIN sources s ON s.id::text = t.source_id
        ON CONFLICT DO NOTHING
        RETURNING item_id
      `;
      linked = insertedLinks.length;
    }

    await tx`
      INSERT INTO loaded_objects (key, rows, rejected)
      VALUES (${key}, ${rows.length}, ${rejected})
    `;

    return { inserted, linked };
  });
}

/** Drop the ledger so the next loadPending applies every object again. */
export async function forgetLoadedObjects(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM loaded_objects`;
}

/**
 * Copy the collector's per-subscription fetch state onto sources.
 *
 * Entries whose id is not a source — including ids that are not uuids at
 * all — are ignored rather than failing the batch. A source the user
 * disabled keeps its status: `disabled` is the user's choice, not fetch
 * bookkeeping, so the collector's view of it must not overwrite that.
 * Returns the number of sources updated.
 */
export async function syncSourceFetchState(
  sql: postgres.Sql,
  entries: Record<string, SourceFetchStateRow>,
): Promise<number> {
  const records = Object.entries(entries).map(([id, entry]) => ({
    id,
    etag: entry.etag,
    last_modified: entry.lastModified,
    content_hash: entry.contentHash,
    next_fetch_at: entry.nextFetchAt,
    last_fetched_at: entry.lastFetchedAt,
    last_success_at: entry.lastSuccessAt,
    consecutive_failures: entry.consecutiveFailures,
    last_error: entry.lastError,
    status: entry.status,
  }));
  if (records.length === 0) return 0;

  const updated = await sql<{ id: string }[]>`
    UPDATE sources s
    SET etag = v.etag,
        last_modified = v.last_modified,
        content_hash = v.content_hash,
        next_fetch_at = v.next_fetch_at,
        last_fetched_at = v.last_fetched_at,
        last_success_at = v.last_success_at,
        consecutive_failures = v.consecutive_failures,
        last_error = v.last_error,
        status = CASE WHEN s.status = 'disabled' THEN s.status ELSE v.status END,
        updated_at = now()
    FROM jsonb_to_recordset(${jsonb(sql, records)}::jsonb)
      AS v(
        id text, etag text, last_modified text, content_hash text,
        next_fetch_at timestamptz, last_fetched_at timestamptz,
        last_success_at timestamptz, consecutive_failures integer,
        last_error text, status text
      )
    WHERE s.id::text = v.id
    RETURNING s.id
  `;
  return updated.length;
}

// sql.json() is not safe on a drizzle()-wrapped client: drizzle replaces the
// jsonb serializer with an identity passthrough, so a Parameter typed jsonb
// would put a raw array on the wire and the driver would crash writing it.
// Sending the JSON text as a text parameter (oid 25) and letting ::jsonb
// parse it server-side works on patched and unpatched clients alike.
function jsonb(sql: postgres.Sql | postgres.TransactionSql, value: unknown) {
  return sql.typed(JSON.stringify(value), 25);
}

// jsonb_to_recordset takes the columns by name, so the record keys are the
// snake_case column names; dates travel as ISO strings and land on
// timestamptz columns through the recordset's own cast.
function itemRecord(row: LoadRow) {
  return {
    id: row.id,
    url: row.url,
    canonical_url: row.canonicalUrl,
    title: row.title,
    author: row.author,
    guid: row.guid,
    published_at: row.publishedAt.toISOString(),
    published_at_estimated: row.publishedAtEstimated,
    content_html: row.contentHtml,
    summary: row.summary,
    search_text: row.searchText,
    fetched_at: row.fetchedAt.toISOString(),
  };
}

function linkRecord(row: LoadRow) {
  return {
    item_id: row.id,
    source_id: row.sourceId,
    first_seen_at: row.fetchedAt.toISOString(),
  };
}
