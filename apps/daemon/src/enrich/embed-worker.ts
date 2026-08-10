import {
  EmbeddingError,
  type EmbeddingProvider,
  embeddingInput,
  toVectorLiteral,
} from "@tsuzuri/core";
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
    // Only a permanent, provider-side rejection is evidence about the articles.
    // Everything else describes the run: a retryable outage, a shutdown arriving
    // as an AbortError, a database error from insertEmbeddings. Blaming the
    // articles for those writes a failure row and a backoff against each one, so
    // a restart would park recent articles for a minute apiece, and a database
    // hiccup would look like a corpus full of unembeddable text.
    //
    // Letting those propagate leaves the items pending, which is what they are.
    if (!(error instanceof EmbeddingError) || error.retryable) throw error;

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
  let firstError: unknown;

  // Promise.all would return at the first rejection while the other batches
  // carried on in the background. The caller treats a thrown pass as finished
  // and starts another, so the same items would be embedded twice and the
  // requests doubled against whatever had just failed. Wait for every batch to
  // settle instead.
  //
  // Batches that have not started when a failure lands return immediately
  // rather than being removed with queue.clear(): clear() discards pending
  // tasks without settling the promises add() handed out, which would leave
  // allSettled waiting forever.
  //
  // That is currently unreachable -- a pass claims batchSize * concurrency
  // items, so there are never more batches than slots and nothing ever waits
  // in the queue -- but the trap is one line away from being real if that
  // sizing changes, and the flag costs nothing.
  const results = await Promise.allSettled(
    batches.map((batch) =>
      Promise.resolve(
        queue.add(async () => {
          if (firstError !== undefined) return { embedded: 0, failed: 0 };
          return embedBatch(batch, options);
        }),
      ).catch((error: unknown) => {
        firstError ??= error;
        throw error;
      }),
    ),
  );

  if (firstError !== undefined) throw firstError;

  return results.reduce<EmbedPassResult>(
    (total, result) => ({
      embedded:
        total.embedded + (result.status === "fulfilled" ? (result.value?.embedded ?? 0) : 0),
      failed: total.failed + (result.status === "fulfilled" ? (result.value?.failed ?? 0) : 0),
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
  let wake: (() => void) | null = null;

  /**
   * Sleep that stop() can cut short.
   *
   * A plain Bun.sleep would make shutdown wait out the idle interval, because
   * stop() only sets a flag and the loop is not looking at it. Everything that
   * awaits the worker -- the daemon's signal handler, the start of a reindex --
   * would block for up to that long with nothing happening.
   */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish;
    });

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
      if (stopping) break;
      await sleep(idle ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS);
    }
  })();

  return {
    stop: () => {
      stopping = true;
      wake?.();
    },
    done,
  };
}
