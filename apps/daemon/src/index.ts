import { createChatProvider } from "@tsuzuri/core";
import { createDatabase, migrate, sources } from "@tsuzuri/db";
import { storageFromEnv } from "@tsuzuri/store";

import { createApi } from "./api.ts";
import { seedState } from "./collect/collector.ts";
import { toSeedEntries, toSubscription } from "./collect/subscriptions.ts";
import { loadConfig } from "./config.ts";
import { createClusteringService } from "./enrich/clustering.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";
import { createEnrichmentService } from "./enrich/enrichment.ts";
import { createInterestService } from "./enrich/interest.ts";
import { createFetcher } from "./ingest/fetcher.ts";
import { createIngestion } from "./ingestion.ts";

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

const storage = storageFromEnv();
console.error(`storage: ${process.env.TSUZURI_STORAGE ?? "file://./data"} (cwd ${process.cwd()})`);
// Aborted on shutdown, so in-flight fetches end at once; an aborted fetch
// leaves its subscription's state untouched and it is fetched next start.
const shutdown = new AbortController();
const { collector, loads } = createIngestion({
  sql,
  storage,
  fetcher,
  config,
  log: (message) => console.error(message),
  signal: shutdown.signal,
});

async function loadAndLog(): Promise<void> {
  try {
    await loads.load();
  } catch (error) {
    console.error("load failed:", error);
  }
}

// Switching from direct ingest: without this every feed is refetched with no
// validators.
try {
  const seeded = await seedState(storage, toSeedEntries(await db.select().from(sources)));
  if (seeded) console.error("seeded _state/collector.json from the sources table");
} catch (error) {
  console.error("collector state could not be seeded:", error);
}

/**
 * Polling loop.
 *
 * Which subscriptions are due is the collector's call, from its own state in
 * storage, so a restart does not reset every schedule and re-poll all of them
 * at once. The loop waits for each tick before sleeping, so ticks never overlap.
 */
const SCHEDULER_TICK_MS = 30_000;
let stopping = false;
let inFlight: Promise<void> = Promise.resolve();

async function tick(): Promise<void> {
  try {
    const rows = await db.select().from(sources);
    await collector.tick(rows.map(toSubscription));
  } catch (error) {
    console.error("scheduler tick failed:", error);
  }
}

async function scheduler(): Promise<void> {
  while (!stopping) {
    inFlight = tick();
    await inFlight;
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

/**
 * Clustering consults embeddings when they are ready and works without them,
 * so it starts after them and tolerates failing the same way.
 */
const clustering = createClusteringService({ sql, config, embeddings });
try {
  await clustering.start();
} catch (error) {
  console.error("clustering could not be started:", error);
}

/**
 * The chat model, resolved once.
 *
 * A half-configured provider is a startup error rather than silence, and the
 * configuration schema has already refused a missing base URL or model and a
 * base URL that is not a URL, so what remains here is a model this daemon can
 * name. The point of building it here is that /doctor can report the model it
 * will use from the first request.
 */
const chat = createChatProvider({
  provider: config.CHAT_PROVIDER,
  baseUrl: config.CHAT_BASE_URL,
  apiKey: config.CHAT_API_KEY,
  model: config.CHAT_MODEL,
  requestTimeoutMs: config.CHAT_REQUEST_TIMEOUT_MS,
});

/**
 * Enrichment starts last: it spends on the ranking the other two produce, so
 * running it before them would mean paying for articles nothing had ordered.
 */
const enrichment = createEnrichmentService({ sql, config, interest, provider: chat });
try {
  await enrichment.start();
} catch (error) {
  console.error("enrichment could not be started:", error);
}

const app = createApi({
  db,
  sql,
  config,
  embeddings,
  interest,
  clustering,
  enrichment,
  collector,
  loads,
});
const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });

console.error(`tsuzuri daemon listening on http://${config.HOST}:${config.PORT}`);
// Objects written before a restart are caught up after the server is up, so
// /health answers during a long backlog; the runner orders it before any
// load a flush queues.
void loadAndLog();
void scheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // A second signal means the operator will not wait for the graceful path.
    if (stopping) process.exit(1);
    stopping = true;
    let code = 0;
    try {
      // No new /ingest/run or /rebuild while the last flush and load run.
      // stop() waits for requests in progress, so abort first: an
      // /ingest/run waiting on a slow fetch then ends with it instead of
      // holding stop().
      const stopped = server.stop();
      shutdown.abort();
      await stopped;
      await inFlight;
      // A storage failure here loses only what this flush held, and the
      // fetch state was not advanced for it, so the next start fetches it
      // again. A flush that wrote has already queued its load.
      let flushed = null;
      try {
        flushed = await collector.flush();
      } catch (error) {
        console.error("final flush failed:", error);
      }
      if (flushed === null) await loadAndLog();
      await loads.settled();
      await enrichment.stop();
      await interest.stop();
      await clustering.stop();
      await embeddings.stop();
      await close();
    } catch (error) {
      console.error("shutdown failed:", error);
      code = 1;
    } finally {
      process.exit(code);
    }
  });
}
