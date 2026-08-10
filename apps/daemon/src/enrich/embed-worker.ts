import { type EmbeddingProvider, embeddingInput, toVectorLiteral } from "@tsuzuri/core";
import {
  insertEmbeddings,
  type PendingItem,
  pendingEmbeddingItems,
  recordEmbeddingFailure,
} from "@tsuzuri/db";
import PQueue from "p-queue";
import type postgres from "postgres";

/**
 * The backfill worker: give every stored item a vector.
 *
 * Runs only when a model is configured and matches what is stored. It is an
 * enrichment, which is to say it is allowed to fail, fall behind, and be run
 * again over the same articles without consequence -- ingest has already done
 * the part that cannot be repeated.
 */

export type EmbedWorkerOptions = {
  sql: postgres.Sql;
  provider: EmbeddingProvider;
  batchSize: number;
  concurrency: number;
  maxInputChars: number;
  now?: () => Date;
  signal?: AbortSignal;
};

export type EmbedPassResult = {
  embedded: number;
  failed: number;
  /** True when nothing was waiting, i.e. the backfill has caught up. */
  idle: boolean;
};

/** Items claimed per pass. Enough to keep every worker slot busy. */
function passSize(options: EmbedWorkerOptions): number {
  return options.batchSize * options.concurrency;
}

/**
 * Embed one batch, attributing failure to the right items.
 *
 * A failed batch is retried one item at a time. Providers reject a whole batch
 * for the sake of a single input often enough -- one article over the token
 * limit, one tripping a content filter -- that failing all thirty-two would
 * park good articles behind a bad one for a day.
 */
async function embedBatch(
  batch: PendingItem[],
  options: EmbedWorkerOptions,
): Promise<{ embedded: number; failed: number }> {
  const { sql, provider, maxInputChars } = options;
  const now = options.now?.() ?? new Date();
  const texts = batch.map((item) => embeddingInput(item.title, item.searchText, maxInputChars));

  try {
    const vectors = await provider.embed(texts, options.signal);
    await insertEmbeddings(
      sql,
      batch.map((item, i) => ({
        itemId: item.id,
        // embed() guarantees one vector per input, in order.
        vector: toVectorLiteral(vectors[i] as number[]),
      })),
    );
    return { embedded: batch.length, failed: 0 };
  } catch (error) {
    if (batch.length === 1) {
      const item = batch[0] as PendingItem;
      await recordEmbeddingFailure(
        sql,
        item.id,
        error instanceof Error ? error.message : String(error),
        now,
      );
      return { embedded: 0, failed: 1 };
    }

    let embedded = 0;
    let failed = 0;
    for (const item of batch) {
      const result = await embedBatch([item], options);
      embedded += result.embedded;
      failed += result.failed;
    }
    return { embedded, failed };
  }
}

/** One pass over whatever is currently pending. Exported for tests and for reindex. */
export async function runEmbedPass(options: EmbedWorkerOptions): Promise<EmbedPassResult> {
  const now = options.now?.() ?? new Date();
  const pending = await pendingEmbeddingItems(options.sql, passSize(options), now);
  if (pending.length === 0) return { embedded: 0, failed: 0, idle: true };

  const batches: PendingItem[][] = [];
  for (let i = 0; i < pending.length; i += options.batchSize) {
    batches.push(pending.slice(i, i + options.batchSize));
  }

  const queue = new PQueue({ concurrency: options.concurrency });
  const results = await Promise.all(
    batches.map((batch) => queue.add(() => embedBatch(batch, options))),
  );

  return results.reduce<EmbedPassResult>(
    (total, result) => ({
      embedded: total.embedded + (result?.embedded ?? 0),
      failed: total.failed + (result?.failed ?? 0),
      idle: false,
    }),
    { embedded: 0, failed: 0, idle: false },
  );
}

/** Gap between passes once the backfill has caught up. */
const IDLE_INTERVAL_MS = 30_000;
/** Gap between passes while there is still work, purely to yield. */
const BUSY_INTERVAL_MS = 250;

export type EmbedWorker = {
  stop: () => void;
  /** Resolves once the loop has actually exited. */
  done: Promise<void>;
};

/**
 * Run the backfill continuously.
 *
 * Polling rather than an in-process queue fed by ingest, because the pending
 * set is already a database query and a queue would be a second, divergent
 * answer to the same question. It also means a reindex needs no notification:
 * truncating the table makes everything pending again.
 */
export function startEmbedWorker(options: EmbedWorkerOptions): EmbedWorker {
  let stopping = false;

  const done = (async () => {
    while (!stopping) {
      let idle = true;
      try {
        const result = await runEmbedPass(options);
        idle = result.idle;
      } catch (error) {
        // The provider being unreachable must not kill the loop; the reader
        // keeps working and embeddings catch up when it comes back.
        console.error("embedding pass failed:", error);
      }
      await Bun.sleep(idle ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS);
    }
  })();

  return {
    stop: () => {
      stopping = true;
    },
    done,
  };
}
