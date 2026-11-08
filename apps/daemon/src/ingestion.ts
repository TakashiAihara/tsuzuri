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
};

/**
 * The collector and the loader as the daemon runs them: every flush that wrote
 * a file is followed by a load, on the runner's one chain. The tests build the
 * same thing, so what they check is the daemon's wiring and not a copy of it.
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
    // A PostgreSQL error must not fail a flush whose files are already safe
    // in storage: the objects stay pending and the next load retries them.
    onFlush: async () => {
      try {
        await loads.load();
      } catch (error) {
        deps.log(`load failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  return { collector, loads };
}
