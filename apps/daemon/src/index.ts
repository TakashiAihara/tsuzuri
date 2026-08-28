import { createChatProvider } from "@tsuzuri/core";
import { createDatabase, migrate } from "@tsuzuri/db";
import PQueue from "p-queue";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { startClusterWorker } from "./enrich/cluster-worker.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";
import { startEnrichWorker } from "./enrich/enrich-worker.ts";
import { profileStatus, startProfileWorker } from "./enrich/profile.ts";
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

const profileWorker = startProfileWorker({ sql, config, embeddings });
// Runs unconditionally: SimHash needs no model, so clustering works on an
// install with no AI configured at all.
const clusterWorker = startClusterWorker({ sql, config });

/**
 * Enrichment only starts when a chat model is configured. Unlike the other
 * workers there is no useful degraded mode: without a provider there is
 * nothing to call, and a loop that wakes every fifteen minutes to discover
 * that again is just noise in the log.
 */
const chatProvider = createChatProvider({
  provider: config.CHAT_PROVIDER,
  baseUrl: config.CHAT_BASE_URL,
  apiKey: config.CHAT_API_KEY,
  model: config.CHAT_MODEL,
  requestTimeoutMs: config.CHAT_REQUEST_TIMEOUT_MS,
});
const enrichWorker = chatProvider
  ? startEnrichWorker({
      sql,
      config,
      provider: chatProvider,
      scoringActive: async () => (await profileStatus(sql, config)).active,
    })
  : null;
if (chatProvider) {
  console.error(`enrichment enabled: ${chatProvider.id}/${chatProvider.model}`);
}

const app = createApi({ db, sql, fetcher, config, embeddings, chatProvider });
const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });

console.error(`tsuzuri daemon listening on http://${config.HOST}:${config.PORT}`);
void scheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopping = true;
    await server.stop();
    profileWorker.stop();
    clusterWorker.stop();
    enrichWorker?.stop();
    await Promise.all([profileWorker.done, clusterWorker.done, enrichWorker?.done]);
    await embeddings.stop();
    await close();
    process.exit(0);
  });
}
