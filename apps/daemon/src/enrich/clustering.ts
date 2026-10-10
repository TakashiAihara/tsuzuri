import { simhash } from "@tsuzuri/core";
import {
  bestClusterMatch,
  type ClusteringCounts,
  clusteringCounts,
  foundCluster,
  joinCluster,
  matchedBy,
  pendingClusterItems,
  writeSimhash,
} from "@tsuzuri/db";
import type postgres from "postgres";

import type { Config } from "../config.ts";
import type { EmbeddingService } from "./embeddings.ts";

/**
 * Assigns every item to the story it reports.
 *
 * An enrichment like the others: it never writes to items, so nothing here
 * can stop an article being stored, and it is off by default. Unlike scoring
 * it needs no model -- SimHash clusters near-verbatim copies alone -- so an
 * install with no AI configured still gets the syndication half of it.
 */

export type ClusteringStatus = ClusteringCounts & { enabled: boolean };

export type PassResult = {
  joined: number;
  founded: number;
  /** True when nothing was waiting, i.e. clustering has caught up. */
  idle: boolean;
};

export type ClusteringService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => Promise<ClusteringStatus>;
  /** One pass over what is pending. Exported for tests and for an on-demand run. */
  runPass: () => Promise<PassResult>;
};

/** Items claimed per pass. Each is a few small queries, so this bounds a pass to well under a second. */
const PASS_SIZE = 200;
/** Gap between passes once clustering has caught up. */
const IDLE_INTERVAL_MS = 30_000;
/** Gap between passes while there is still work, purely to yield. */
const BUSY_INTERVAL_MS = 250;

export function createClusteringService(deps: {
  sql: postgres.Sql;
  config: Config;
  embeddings: EmbeddingService;
}): ClusteringService {
  const { sql, config, embeddings } = deps;

  let stopping = false;
  let wake: (() => void) | null = null;
  let loop: Promise<void> | null = null;
  /** Single-flight, for the same reason as the interest rebuild: two passes would assign the same items twice. */
  let running: Promise<PassResult> | null = null;

  const thresholds = {
    maxDistance: config.CLUSTER_MAX_DISTANCE,
    maxBits: config.CLUSTER_SIMHASH_MAX_BITS,
  };

  async function pass(): Promise<PassResult> {
    // Decided per pass, not at start: the embedding model can become ready, or
    // stop matching the stored vectors, while the daemon runs.
    const useEmbedding = embeddings.activeProvider() !== null;
    const pending = await pendingClusterItems(sql, {
      limit: PASS_SIZE,
      requireEmbedding: useEmbedding,
    });
    if (pending.length === 0) return { joined: 0, founded: 0, idle: true };

    let joined = 0;
    let founded = 0;

    for (const item of pending) {
      if (stopping) break;

      if (!item.hasSimhash) {
        const bits = simhash(item.searchText);
        // No hash for text shorter than a shingle: SimHash simply does not
        // vote for this item, and the embedding signal still can.
        if (bits !== null) await writeSimhash(sql, item.id, bits);
      }

      const match = await bestClusterMatch(sql, {
        itemId: item.id,
        windowHours: config.CLUSTER_WINDOW_HOURS,
        ...thresholds,
        useEmbedding,
      });

      if (match) {
        await joinCluster(sql, {
          itemId: item.id,
          clusterId: match.clusterId,
          matchedBy: matchedBy(match, thresholds),
        });
        joined += 1;
      } else {
        await foundCluster(sql, item.id);
        founded += 1;
      }
    }

    return { joined, founded, idle: false };
  }

  function runOnce(): Promise<PassResult> {
    if (running) return running;
    const started = pass().finally(() => {
      if (running === started) running = null;
    });
    running = started;
    return started;
  }

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

  return {
    async start() {
      if (!config.CLUSTERING_ENABLED) return;
      loop = (async () => {
        while (!stopping) {
          let idle = true;
          try {
            idle = (await runOnce()).idle;
          } catch (error) {
            // A failed pass must not kill the loop. Whatever it did not reach
            // is still pending and the next pass picks it up.
            console.error("clustering pass failed:", error);
          }
          if (stopping) break;
          await sleep(idle ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS);
        }
      })();
    },

    async stop() {
      stopping = true;
      wake?.();
      await running?.catch(() => {});
      await loop;
    },

    async status() {
      return { enabled: config.CLUSTERING_ENABLED, ...(await clusteringCounts(sql)) };
    },

    runPass: runOnce,
  };
}
