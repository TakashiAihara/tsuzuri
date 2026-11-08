import type { Storage } from "@tsuzuri/store";
import type postgres from "postgres";

import { createCollector } from "./collect/collector.ts";
import type { Config } from "./config.ts";
import type { Fetcher } from "./ingest/fetcher.ts";
import { createLoader } from "./load/loader.ts";
import { createLoadRunner } from "./load/runner.ts";

export type IngestionDeps = {
  sql: postgres.Sql;
  storage: Storage;
  fetcher: Fetcher;
  config: Pick<Config, "DEGRADE_AFTER_FAILURES" | "FETCH_CONCURRENCY" | "FETCH_TIMEOUT_MS">;
  log: (message: string) => void;
  /** The collector's own default (five minutes) when left out. */
  flushIntervalMs?: number;
  signal?: AbortSignal;
};

/**
 * The collector and the loader as the daemon runs them: every flush is
 * followed by a load, on the runner's one chain. The tests build the same
 * thing, so what they check is the daemon's wiring and not a copy of it.
 */
export function createIngestion(deps: IngestionDeps) {
  const loader = createLoader({
    sql: deps.sql,
    storage: deps.storage,
    log: (message) => deps.log(`load: ${message}`),
  });
  const loads = createLoadRunner(loader);

  const collector = createCollector({
    storage: deps.storage,
    fetcher: deps.fetcher,
    degradeAfterFailures: deps.config.DEGRADE_AFTER_FAILURES,
    concurrency: deps.config.FETCH_CONCURRENCY,
    fetchTimeoutMs: deps.config.FETCH_TIMEOUT_MS,
    flushIntervalMs: deps.flushIntervalMs,
    signal: deps.signal,
    // Queued, not awaited: the flush runs inside the collector's chain, and a
    // long load (or a rebuild ahead of it) must not hold up fetching. A
    // PostgreSQL error does not fail the flush either; its files are already
    // safe in storage and the next load retries them. Callers that need the
    // load done wait on loads.settled().
    onFlush: () => {
      loads.load().catch((error: unknown) => {
        deps.log(`load failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  return { collector, loads };
}
