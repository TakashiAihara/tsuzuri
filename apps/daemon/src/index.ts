import { createDatabase, migrate } from "@tsuzuri/db";
import PQueue from "p-queue";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
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

const app = createApi({ db, fetcher, config });
const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });

console.error(`tsuzuri daemon listening on http://${config.HOST}:${config.PORT}`);
void scheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopping = true;
    await server.stop();
    await close();
    process.exit(0);
  });
}
