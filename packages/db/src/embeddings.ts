import type postgres from "postgres";

/**
 * The item_embeddings table: runtime DDL and the queries over it.
 *
 * This is the one table that cannot go through the Drizzle mirror in schema.ts,
 * because its column type carries a dimension that is unknown until a model is
 * configured. Rather than fake a mirror that would be wrong for every real
 * installation, the table is created and queried here in raw SQL on the
 * postgres.js client that createDatabase() already returns.
 *
 * Everything that interpolates the dimension into DDL routes through
 * assertDimension() first: it reaches `sql.unsafe` as text, so treating it as a
 * plain number is the difference between a schema and an injection point.
 */

/**
 * Either a pool handle or a transaction handle.
 *
 * The helpers below are called both directly and from inside
 * rebuildItemEmbeddings' transaction, and postgres.js gives those two different
 * types.
 */
type SqlLike = postgres.Sql | postgres.TransactionSql;

const TABLE = "item_embeddings";
const INDEX = "item_embeddings_hnsw";

export type EmbeddingModelRow = {
  provider: string;
  model: string;
  dimensions: number;
};

export type EmbeddingCounts = {
  /** Items in the corpus, i.e. the size of a full backfill. */
  total: number;
  embedded: number;
  /** Items with neither a vector nor an exhausted retry schedule. */
  pending: number;
  failed: number;
};

export type PendingItem = {
  id: string;
  title: string | null;
  searchText: string;
};

/**
 * Bind an instant as text with an explicit cast.
 *
 * A Date interpolated straight into a postgres.js template reaches the driver
 * with no inferred type and fails to serialise ("Received an instance of Date").
 * The ingest path sidesteps this by going through Drizzle's typed operators;
 * this file talks to the driver directly, so it does the conversion itself.
 */
function instant(at: Date): string {
  return at.toISOString();
}

function assertDimension(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 16_000) {
    throw new Error(`refusing to build a vector column with dimension ${dimensions}`);
  }
  return dimensions;
}

/** The active model, or null when embeddings have never been enabled here. */
export async function readEmbeddingModel(sql: postgres.Sql): Promise<EmbeddingModelRow | null> {
  const rows = await sql<EmbeddingModelRow[]>`
    SELECT provider, model, dimensions FROM embedding_model WHERE id
  `;
  return rows[0] ?? null;
}

/** Record the active model, replacing whatever was there. */
export async function writeEmbeddingModel(
  sql: postgres.Sql,
  row: EmbeddingModelRow,
): Promise<void> {
  await sql`
    INSERT INTO embedding_model (id, provider, model, dimensions)
    VALUES (true, ${row.provider}, ${row.model}, ${assertDimension(row.dimensions)})
    ON CONFLICT (id) DO UPDATE
      SET provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          created_at = now()
  `;
}

/**
 * Create the vector table at a given dimension, if it is not already there.
 *
 * The HNSW index is created with the table rather than after the first
 * backfill. Steady-state inserts maintain it incrementally, and the case where
 * building it in bulk is worth the extra code -- a full re-embed -- goes
 * through rebuildItemEmbeddings(), which drops it first for exactly that
 * reason.
 *
 * vector_cosine_ops because ranking is by cosine distance. Whether a provider
 * returns normalised vectors is not something this code can know, and cosine is
 * the operator that does not care.
 */
export async function createEmbeddingTable(sql: SqlLike, dimensions: number): Promise<void> {
  const n = assertDimension(dimensions);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      item_id    text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
      embedding  vector(${n}) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function ensureItemEmbeddings(sql: postgres.Sql, dimensions: number): Promise<void> {
  await createEmbeddingTable(sql, dimensions);
  await createEmbeddingIndex(sql);
}

/** Whether the vector table exists yet. */
export async function itemEmbeddingsExists(sql: SqlLike): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${TABLE}) IS NOT NULL AS exists
  `;
  return rows[0]?.exists ?? false;
}

/** The dimension the table is actually built at, or null when it does not exist. */
export async function itemEmbeddingsDimension(sql: SqlLike): Promise<number | null> {
  const rows = await sql<{ dimension: number | null }[]>`
    SELECT atttypmod AS dimension
    FROM pg_attribute
    WHERE attrelid = to_regclass(${TABLE}) AND attname = 'embedding' AND NOT attisdropped
  `;
  const dimension = rows[0]?.dimension ?? null;
  return dimension === null || dimension < 0 ? null : dimension;
}

/**
 * Discard every vector and rebuild the table at a new dimension.
 *
 * Destructive by definition: vectors produced by one model are meaningless
 * against a query embedded by another, so a model switch cannot preserve them.
 *
 * The index is dropped first and left off. Building HNSW over a populated table
 * is markedly cheaper than maintaining it across a backfill of every article
 * the reader has ever stored, so the caller creates it again once the backfill
 * finishes -- see ensureItemEmbeddings().
 *
 * All of it in one transaction. PostgreSQL is happy to roll DDL back, and the
 * intermediate states are ones nothing should ever observe: an index dropped
 * but the column not yet widened, or rows discarded while the recorded model
 * still claims the old dimension.
 *
 * Idempotent, so an interrupted rebuild is resumable: the table is already
 * empty and already at the target dimension, and running this again is a no-op
 * that leaves the backfill to continue.
 */
export async function rebuildItemEmbeddings(sql: postgres.Sql, dimensions: number): Promise<void> {
  const n = assertDimension(dimensions);

  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP INDEX IF EXISTS ${INDEX}`);

    if (await itemEmbeddingsExists(tx)) {
      // TRUNCATE before ALTER: altering the dimension of a populated column
      // fails ("expected N dimensions, not M"), and every row is being
      // discarded anyway.
      await tx.unsafe(`TRUNCATE ${TABLE}`);
      await tx.unsafe(`ALTER TABLE ${TABLE} ALTER COLUMN embedding TYPE vector(${n})`);
    } else {
      await createEmbeddingTable(tx, n);
    }

    // Past failures belong to the model being discarded. Carrying their retry
    // schedule forward would hold items back from a model that might embed
    // them without complaint.
    await tx`TRUNCATE embedding_failures`;
  });
}

/** Build the HNSW index if the rebuild left it off. */
export async function createEmbeddingIndex(sql: SqlLike): Promise<void> {
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} USING hnsw (embedding vector_cosine_ops)
  `);
}

export async function embeddingIndexExists(sql: SqlLike): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${INDEX}) IS NOT NULL AS exists
  `;
  return rows[0]?.exists ?? false;
}

/**
 * Items still waiting for a vector.
 *
 * There is no queue table: an item needs embedding exactly when it has no row
 * in item_embeddings, which means ingest enqueues new articles for free and a
 * rebuild re-enqueues everything by truncating. A queue would be a second
 * source of truth about the same fact, and the two would drift.
 *
 * Newest first, so a fresh install becomes useful for current articles
 * immediately instead of after the whole archive has been processed.
 */
export async function pendingEmbeddingItems(
  sql: postgres.Sql,
  limit: number,
  now = new Date(),
): Promise<PendingItem[]> {
  return sql<PendingItem[]>`
    SELECT i.id, i.title, i.search_text AS "searchText"
    FROM items i
    LEFT JOIN item_embeddings e ON e.item_id = i.id
    LEFT JOIN embedding_failures f ON f.item_id = i.id
    WHERE e.item_id IS NULL
      AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= ${instant(now)}::timestamptz)
    ORDER BY i.published_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Store a batch of vectors.
 *
 * One statement via UNNEST rather than a row per round trip. The vectors travel
 * as text and are cast, which is how pgvector takes a parameter.
 */
export async function insertEmbeddings(
  sql: postgres.Sql,
  rows: ReadonlyArray<{ itemId: string; vector: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.itemId);
  const vectors = rows.map((row) => row.vector);
  await sql`
    INSERT INTO item_embeddings (item_id, embedding)
    SELECT id, vec::vector FROM UNNEST(${ids}::text[], ${vectors}::text[]) AS t(id, vec)
    ON CONFLICT (item_id) DO UPDATE
      SET embedding = EXCLUDED.embedding, created_at = now()
  `;
  await sql`DELETE FROM embedding_failures WHERE item_id = ANY(${ids}::text[])`;
}

/**
 * Longest gap between retries of a failing item.
 *
 * A day, so that an item failing because the provider was misconfigured is
 * picked up again on its own once that is fixed, without anybody remembering
 * to ask for it.
 */
const MAX_RETRY_BACKOFF_SECONDS = 24 * 60 * 60;

/** Seconds to wait before retrying an item that has failed this many times. */
export function retryBackoffSeconds(failures: number): number {
  return Math.min(60 * 2 ** Math.max(0, failures - 1), MAX_RETRY_BACKOFF_SECONDS);
}

export async function recordEmbeddingFailure(
  sql: postgres.Sql,
  itemId: string,
  error: string,
  now = new Date(),
): Promise<void> {
  const first = new Date(now.getTime() + retryBackoffSeconds(1) * 1000);
  await sql`
    INSERT INTO embedding_failures (item_id, failures, last_error, next_attempt_at)
    VALUES (${itemId}, 1, ${error.slice(0, 1000)}, ${instant(first)}::timestamptz)
    ON CONFLICT (item_id) DO UPDATE
      SET failures = embedding_failures.failures + 1,
          last_error = EXCLUDED.last_error,
          -- Doubling is computed in SQL from the row's current count, so
          -- concurrent workers cannot both read "1" and both schedule 120s.
          next_attempt_at = ${instant(now)}::timestamptz + make_interval(
            secs => LEAST(
              60 * pow(2, embedding_failures.failures),
              ${MAX_RETRY_BACKOFF_SECONDS}
            )::int
          )
  `;
}

export async function embeddingCounts(
  sql: postgres.Sql,
  now = new Date(),
): Promise<EmbeddingCounts> {
  // Before the first model is configured the vector table does not exist, and
  // every item is pending by definition. Branching in TypeScript rather than
  // splicing conditional fragments into one query: the splice was unreadable
  // and the two cases are genuinely different queries.
  if (!(await itemEmbeddingsExists(sql))) {
    const rows = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM items`;
    const total = rows[0]?.total ?? 0;
    return { total, embedded: 0, pending: total, failed: 0 };
  }

  const rows = await sql<{ total: number; embedded: number; pending: number; failed: number }[]>`
    SELECT
      (SELECT count(*)::int FROM items) AS total,
      (SELECT count(*)::int FROM item_embeddings) AS embedded,
      (SELECT count(*)::int FROM embedding_failures) AS failed,
      (
        SELECT count(*)::int
        FROM items i
        LEFT JOIN item_embeddings e ON e.item_id = i.id
        LEFT JOIN embedding_failures f ON f.item_id = i.id
        WHERE e.item_id IS NULL
          AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= ${instant(now)}::timestamptz)
      ) AS pending
  `;
  return rows[0] ?? { total: 0, embedded: 0, pending: 0, failed: 0 };
}
