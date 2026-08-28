import { fromSigned64, hammingDistance64, simhash64, toSigned64 } from "@tsuzuri/core";
import {
  assignToCluster,
  candidateClusters,
  createClusterFor,
  itemsMissingSimhash,
  nearestClusterByEmbedding,
  setSimhash,
  unclusteredItems,
} from "@tsuzuri/db";
import type postgres from "postgres";

import type { Config } from "../config.ts";

/**
 * Duplicate clustering: assign every item to a story.
 *
 * An enrichment like the embedding backfill -- allowed to fall behind, safe to
 * run again -- but with no external dependency at all when SimHash is doing
 * the work, so it runs on installs with no AI configured.
 */

export type ClusterPassResult = {
  hashed: number;
  assigned: number;
  clustersCreated: number;
  idle: boolean;
};

export type ClusterWorkerOptions = {
  sql: postgres.Sql;
  config: Config;
  now?: () => Date;
};

/** Items handled per pass. Small: each one scans the candidates in its window. */
const PASS_SIZE = 200;
/** Items hashed per pass while backfilling the column. */
const HASH_PASS_SIZE = 500;

/**
 * Hash whatever is unhashed.
 *
 * Ingest hashes as it writes, so this only ever catches up articles that
 * predate the column. It is kept in the loop rather than run once at boot
 * because a restart in the middle of a backfill would otherwise leave items
 * permanently unhashed.
 */
async function hashPass(sql: postgres.Sql): Promise<number> {
  const rows = await itemsMissingSimhash(sql, HASH_PASS_SIZE);
  if (rows.length === 0) return 0;

  const hashed = rows
    .map((row) => ({ itemId: row.id, hash: simhash64(row.searchText) }))
    // 0n is the "too short to hash" sentinel; writing it would claim a hash
    // that means nothing and make every such item look identical to the others.
    .filter((row) => row.hash !== 0n)
    // Postgres bigint is signed; see toSigned64.
    .map((row) => ({ itemId: row.itemId, simhash: toSigned64(row.hash) }));

  await setSimhash(sql, hashed);
  return hashed.length;
}

export async function runClusterPass(options: ClusterWorkerOptions): Promise<ClusterPassResult> {
  const { sql, config } = options;
  const hashed = await hashPass(sql);

  const pending = await unclusteredItems(sql, PASS_SIZE);
  if (pending.length === 0) return { hashed, assigned: 0, clustersCreated: 0, idle: hashed === 0 };

  let assigned = 0;
  let clustersCreated = 0;

  for (const item of pending) {
    const candidates = await candidateClusters(sql, item.publishedAt, config.CLUSTER_WINDOW_HOURS);

    let match: string | null = null;

    // SimHash first: it is a comparison in memory over a handful of rows,
    // where the embedding signal is a query. Same-answer either way, so the
    // cheap one goes first.
    if (item.simhash !== null) {
      const mine = fromSigned64(BigInt(item.simhash));
      for (const candidate of candidates) {
        if (candidate.simhash === null) continue;
        if (
          hammingDistance64(mine, fromSigned64(BigInt(candidate.simhash))) <=
          config.CLUSTER_SIMHASH_MAX_DISTANCE
        ) {
          match = candidate.clusterId;
          break;
        }
      }
    }

    if (match === null && candidates.length > 0) {
      const nearest = await nearestClusterByEmbedding(
        sql,
        item.id,
        candidates.map((candidate) => candidate.clusterId),
        config.CLUSTER_MAX_COSINE_DISTANCE,
      );
      match = nearest?.clusterId ?? null;
    }

    if (match !== null) {
      await assignToCluster(sql, item.id, match);
    } else {
      // Nobody else reported this story yet. A cluster of one is not a special
      // case: it is what every story is until the second outlet publishes.
      await createClusterFor(sql, item.id);
      clustersCreated += 1;
    }
    assigned += 1;
  }

  return { hashed, assigned, clustersCreated, idle: false };
}

const IDLE_INTERVAL_MS = 60_000;
const BUSY_INTERVAL_MS = 250;

export type ClusterWorker = {
  stop: () => void;
  done: Promise<void>;
};

/**
 * Run clustering continuously.
 *
 * Polls "items with no cluster" for the same reason the embedding backfill
 * polls: the pending set is already a database query, and a queue fed by
 * ingest would be a second answer to it that could drift.
 */
export function startClusterWorker(options: ClusterWorkerOptions): ClusterWorker {
  let stopping = false;
  let wake: (() => void) | null = null;

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
        const result = await runClusterPass(options);
        idle = result.idle;
      } catch (error) {
        console.error("clustering pass failed:", error);
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
