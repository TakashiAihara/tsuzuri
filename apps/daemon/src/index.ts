import { createDatabase, migrate } from "@tsuzuri/db";
import PQueue from "p-queue";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";
import { createInterestService } from "./enrich/interest.ts";
import { createFetcher } from "./ingest/fetcher.ts";
import { dueSources, ingestSource } from "./ingest/run.ts";

const config = loadConfig();
const { db, sql, close } = createDatabase({ url: config.DATABASE_URL });

const applied = await migrate(sql);
if (applied.applied.length > 0) {
  console.error(`migrations applied: ${applied.applied.join(", ")}`);
}

const fetcher = createFetcher({
  userAgent: config.USER_AGENT,
  timeoutMs: config.FETCH_TIMEOUT_MS,
  hostMinIntervalMs: config.HOST_MIN_INTERVAL_MS,
  allowPrivateTargets: config.FETCH_ALLOW_PRIVATE_TARGETS,
});

/**
 * Polling loop.
 *
 * Due times live in the database rather than in an in-memory cron, so a restart
 * does not reset every subscription's schedule and re-poll all of them at once.
 */
const SCHEDULER_TICK_MS = 30_000;
let stopping = false;

async function tick(): Promise<void> {
  const rows = await dueSources(db, config.FETCH_CONCURRENCY * 5);
  if (rows.length === 0) return;

  const queue = new PQueue({ concurrency: config.FETCH_CONCURRENCY });
  await Promise.all(
    rows.map((row) =>
      queue.add(async () => {
        try {
          await ingestSource(row, {
            db,
            fetcher,
            degradeAfterFailures: config.DEGRADE_AFTER_FAILURES,
          });
        } catch (error) {
          // One broken subscription must not stop the loop for the rest.
          console.error(`ingest failed for ${row.url}:`, error);
        }
      }),
    ),
  );
}

async function scheduler(): Promise<void> {
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error("scheduler tick failed:", error);
    }
    await Bun.sleep(SCHEDULER_TICK_MS);
  }
}

/**
 * Embeddings are resolved before serving, so that /doctor tells the truth from
 * the first request. A failure here is reported and then tolerated: the reader
 * works without embeddings, and refusing to start over an optional feature
 * would be a worse outcome than starting without it.
 */
const embeddings = createEmbeddingService({ sql, config });
try {
  await embeddings.start();
} catch (error) {
  console.error("embeddings could not be started:", error);
}

/**
 * The interest profile depends on embeddings being resolved, so it starts
 * after them. A failure here is tolerated for the same reason: ranking is an
 * enrichment, and refusing to serve the reader over one is a worse outcome.
 */
const interest = createInterestService({ sql, config, embeddings });
try {
  await interest.start();
} catch (error) {
  console.error("interest scoring could not be started:", error);
}

const app = createApi({ db, sql, fetcher, config, embeddings, interest });
const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });

console.error(`tsuzuri daemon listening on http://${config.HOST}:${config.PORT}`);
void scheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopping = true;
    await server.stop();
    await interest.stop();
    await embeddings.stop();
    await close();
    process.exit(0);
  });
}
