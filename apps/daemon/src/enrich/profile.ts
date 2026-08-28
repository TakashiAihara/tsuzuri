import {
  type InterestCentroid,
  interactionSignal,
  kmeans,
  maxCosineSimilarity,
  toVectorLiteral,
  type WeightedVector,
} from "@tsuzuri/core";
import {
  DEFAULT_USER_ID,
  ensureInterestClusters,
  interactionCount,
  interactionRows,
  readInterestClusters,
  replaceInterestClusters,
} from "@tsuzuri/db";
import type postgres from "postgres";

import type { Config } from "../config.ts";
import type { EmbeddingService } from "./embeddings.ts";

/**
 * The interest profile: interaction history clustered into centroids.
 *
 * Rebuilt from scratch on a timer. A full recompute over a few thousand
 * vectors is cheap, and an incremental path would be a second answer to the
 * same question that could drift from this one.
 */

export type RebuildOutcome = {
  built: boolean;
  /** Interaction rows with embeddings, the same number the threshold counts. */
  signals: number;
  clusters: number;
  reason?: string;
};

export type ProfileStatus = {
  active: boolean;
  signals: number;
  threshold: number;
  clusters: { ordinal: number; weight: number; itemCount: number }[];
  lastBuiltAt: string | null;
};

export async function rebuildInterestProfile(
  sql: postgres.Sql,
  config: Config,
  now = new Date(),
): Promise<RebuildOutcome> {
  const rows = await interactionRows(sql, DEFAULT_USER_ID);
  if (rows.length < config.SCORING_MIN_INTERACTIONS) {
    return {
      built: false,
      signals: rows.length,
      clusters: 0,
      reason: `${rows.length}/${config.SCORING_MIN_INTERACTIONS} interactions`,
    };
  }

  const halfLifeMs = config.SCORING_HALF_LIFE_DAYS * 24 * 3_600_000;
  const positives: WeightedVector[] = [];
  const negatives: { vector: number[]; weight: number }[] = [];

  for (const row of rows) {
    const signal = interactionSignal(
      {
        readAt: row.readAt ? new Date(row.readAt) : null,
        starredAt: row.starredAt ? new Date(row.starredAt) : null,
        skippedAt: row.skippedAt ? new Date(row.skippedAt) : null,
        savedAt: row.savedAt ? new Date(row.savedAt) : null,
      },
      now,
      halfLifeMs,
    );
    if (!signal) continue;
    const vector = JSON.parse(row.vector) as number[];
    if (signal.weight > 0) positives.push({ vector, weight: signal.weight });
    else negatives.push({ vector, weight: signal.weight });
  }

  if (positives.length === 0) {
    return { built: false, signals: rows.length, clusters: 0, reason: "no positive signals" };
  }

  // Seed fixed: two rebuilds over the same history must produce the same
  // profile, or ranking would shuffle with nothing having happened.
  const clusters = kmeans(positives, config.SCORING_CLUSTERS, { seed: 1 });
  const surviving = applySkips(clusters, negatives);

  const dimension = positives[0]?.vector.length ?? 0;
  await ensureInterestClusters(sql, dimension);
  await replaceInterestClusters(
    sql,
    DEFAULT_USER_ID,
    surviving.map((cluster) => ({
      centroid: toVectorLiteral(cluster.centroid),
      weight: cluster.weight,
      itemCount: cluster.itemCount,
    })),
    now,
  );

  return { built: true, signals: rows.length, clusters: surviving.length };
}

/**
 * Skips subtract from the cluster they are nearest to, and a cluster whose
 * weight they exhaust is dropped. This is how a topic you now consistently
 * skip fades: its centroid stops existing, rather than a "disinterest" vector
 * hanging around attracting nothing (design D22).
 */
function applySkips(
  clusters: InterestCentroid[],
  negatives: readonly { vector: number[]; weight: number }[],
): InterestCentroid[] {
  if (clusters.length === 0) return [];
  const adjusted = clusters.map((cluster) => ({ ...cluster }));

  for (const negative of negatives) {
    let nearest = 0;
    let best = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < adjusted.length; c++) {
      const centroid = adjusted[c];
      if (!centroid) continue;
      const similarity = maxCosineSimilarity(negative.vector, [centroid.centroid]);
      if (similarity > best) {
        best = similarity;
        nearest = c;
      }
    }
    const target = adjusted[nearest];
    if (target) target.weight -= Math.abs(negative.weight);
  }

  return adjusted.filter((cluster) => cluster.weight > 0);
}

/** What /doctor and the timeline need to know, read fresh from the database. */
export async function profileStatus(sql: postgres.Sql, config: Config): Promise<ProfileStatus> {
  const [clusters, signals] = await Promise.all([
    readInterestClusters(sql, DEFAULT_USER_ID),
    interactionCount(sql, DEFAULT_USER_ID),
  ]);

  return {
    active: clusters.length > 0,
    signals,
    threshold: config.SCORING_MIN_INTERACTIONS,
    clusters: clusters.map(({ ordinal, weight, itemCount }) => ({ ordinal, weight, itemCount })),
    lastBuiltAt: clusters[0]?.builtAt ?? null,
  };
}

export type ProfileWorker = {
  stop: () => void;
  done: Promise<void>;
};

/**
 * Rebuild the profile on an interval, but only while embeddings are ready:
 * the profile is derived data over vectors, so without a model there is
 * nothing to derive. Polls anyway, because embeddings can become ready after
 * a reindex without anyone restarting this loop.
 */
export function startProfileWorker(options: {
  sql: postgres.Sql;
  config: Config;
  embeddings: EmbeddingService;
}): ProfileWorker {
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
      try {
        if (options.embeddings.activeProvider() !== null) {
          const outcome = await rebuildInterestProfile(options.sql, options.config);
          if (outcome.built) {
            console.error(
              `interest profile rebuilt: ${outcome.clusters} clusters from ${outcome.signals} interactions`,
            );
          }
        }
      } catch (error) {
        // A failed rebuild leaves the previous profile in place, which is the
        // right fallback; the reader must not notice.
        console.error("interest profile rebuild failed:", error);
      }
      if (stopping) break;
      await sleep(options.config.SCORING_REBUILD_INTERVAL_MS);
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
