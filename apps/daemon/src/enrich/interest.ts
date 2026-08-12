import {
  clusterCount,
  dot,
  explorationSlots,
  interleaveExploration,
  normalize,
  type ScoringState,
  seedFrom,
  signalStrength,
  sphericalKMeans,
} from "@tsuzuri/core";
import {
  DEFAULT_USER_ID,
  explorationCandidates,
  type InterestCluster,
  readProfileSummary,
  type ScoredItem,
  scoreItems,
  signalCount,
  signalledItems,
  writeInterestProfile,
} from "@tsuzuri/db";
import type postgres from "postgres";

import type { Config } from "../config.ts";
import type { EmbeddingService } from "./embeddings.ts";

/**
 * Owns the interest profile: when it is rebuilt, whether scoring may run, and
 * what a ranked page looks like.
 *
 * Kept apart from ingest for the reason every enrichment is: nothing here can
 * prevent an article being stored, which is what makes the whole feature safe
 * to leave switched off. And it is switched off by default -- deriving a model
 * of what someone reads is the thing being opted into, whether or not the
 * arithmetic happens to be cheap.
 */

export type InterestStatus = ScoringState & {
  enabled: boolean;
  builtAt: string | null;
};

export type RankedPage = {
  items: Array<ScoredItem & { exploration: boolean }>;
  scoring: ScoringState;
};

export type InterestService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => Promise<InterestStatus>;
  /** Rebuild now. Throws when scoring is not in a state that can build one. */
  rebuild: () => Promise<{ clusters: number; signals: number }>;
  /** A ranked page, or null when scoring cannot run and the caller should fall back. */
  rank: (options: {
    limit: number;
    unreadOnly: boolean;
    sourceId: string | null;
  }) => Promise<RankedPage>;
};

/** Gap between rebuild checks, so a long interval does not delay shutdown. */
const TICK_MS = 60_000;

export function createInterestService(deps: {
  sql: postgres.Sql;
  config: Config;
  embeddings: EmbeddingService;
}): InterestService {
  const { sql, config, embeddings } = deps;
  const userId = DEFAULT_USER_ID;

  let stopping = false;
  let wake: (() => void) | null = null;
  let loop: Promise<void> | null = null;
  let lastBuiltAt: Date | null = null;
  /** In-flight rebuild, so stop() waits for it rather than racing it. */
  let running: Promise<unknown> | null = null;

  /**
   * Why a ranked list cannot be produced right now, or null when it can.
   *
   * Every one of these looks the same from the resulting list, which is why the
   * caller reports it rather than silently returning dates.
   */
  async function inactiveReason(): Promise<ScoringState | null> {
    const signals = await signalCount(sql, userId);
    const required = config.INTEREST_MIN_SIGNALS;

    if (!config.INTEREST_SCORING_ENABLED) {
      return { active: false, reason: "interest scoring is not enabled", signals, required };
    }

    const active = embeddings.activeProvider();
    if (!active) {
      const status = await embeddings.status();
      return {
        active: false,
        reason:
          status.state === "mismatch"
            ? "the embedding model does not match the stored vectors"
            : "no embedding model is configured",
        signals,
        required,
      };
    }

    if (signals < required) {
      return { active: false, reason: "not enough reading history yet", signals, required };
    }

    const profile = await readProfileSummary(sql, userId);
    if (profile.clusters === 0) {
      return {
        active: false,
        reason: "the interest profile has not been built yet",
        signals,
        required,
      };
    }

    return null;
  }

  async function buildProfile(): Promise<{ clusters: number; signals: number }> {
    const now = new Date();
    const halfLife = config.INTEREST_SIGNAL_HALFLIFE_DAYS;
    const rows = await signalledItems(sql, {
      userId,
      limit: config.INTEREST_MAX_PROFILE_ITEMS,
    });

    // Positive and negative strength per item. Summed rather than taking the
    // strongest: an article you read and then starred told us two things, and
    // starring does not set read_at on its own, so the sum is not double
    // counting one action.
    const weighted = rows.map((row) => {
      let positive = 0;
      let skipped = 0;
      if (row.starredAt) {
        positive += signalStrength(
          { itemId: row.itemId, kind: "starred", at: row.starredAt },
          now,
          halfLife,
        );
      }
      if (row.readAt) {
        positive += signalStrength(
          { itemId: row.itemId, kind: "read", at: row.readAt },
          now,
          halfLife,
        );
      }
      if (row.skippedAt) {
        skipped += Math.abs(
          signalStrength({ itemId: row.itemId, kind: "skipped", at: row.skippedAt }, now, halfLife),
        );
      }
      return { ...row, positive, skipped, unit: normalize(row.embedding) };
    });

    // A vector that cannot be normalised has no position in the space. Dropping
    // it here is the first of the two guards against a NaN reaching ranking.
    const usable = weighted.filter((row) => row.unit !== null);
    const positives = usable.filter((row) => row.positive > 0);

    if (positives.length === 0) {
      await writeInterestProfile(sql, { userId, clusters: [], builtAt: now });
      lastBuiltAt = now;
      return { clusters: 0, signals: await signalCount(sql, userId) };
    }

    const k = clusterCount(positives.length, config.INTEREST_CLUSTERS_MAX);
    const result = sphericalKMeans({
      vectors: positives.map((row) => row.unit as number[]),
      weights: positives.map((row) => row.positive),
      k,
      // Seeded from the user rather than from the clock, so a rebuild over
      // unchanged history produces an unchanged profile.
      seed: seedFrom(userId),
    });

    const clusters: InterestCluster[] = result.centroids.map((centroid, ordinal) => ({
      ordinal,
      centroid,
      positiveWeight: 0,
      skippedWeight: 0,
      members: 0,
    }));

    for (const [index, row] of positives.entries()) {
      const assigned = result.assignments[index];
      if (assigned === undefined || assigned < 0) continue;
      const cluster = clusters[assigned];
      if (!cluster) continue;
      cluster.positiveWeight += row.positive;
      cluster.members += 1;
    }

    // Skips are never clustered -- a repulsive member has no meaning in cosine
    // k-means -- so each is charged to whichever interest it sits closest to.
    for (const row of usable) {
      if (row.skipped <= 0 || clusters.length === 0) continue;
      let best = -1;
      let bestSimilarity = Number.NEGATIVE_INFINITY;
      for (const [index, cluster] of clusters.entries()) {
        const similarity = dot(row.unit as number[], cluster.centroid);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          best = index;
        }
      }
      const cluster = clusters[best];
      if (cluster) cluster.skippedWeight += row.skipped;
    }

    const written = await writeInterestProfile(sql, {
      userId,
      clusters: clusters.filter((cluster) => cluster.positiveWeight > 0 && cluster.members > 0),
      builtAt: now,
    });
    lastBuiltAt = now;
    return { clusters: written, signals: await signalCount(sql, userId) };
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

  async function tick(): Promise<void> {
    if (!config.INTEREST_SCORING_ENABLED) return;
    if (!embeddings.activeProvider()) return;

    const signals = await signalCount(sql, userId);
    if (signals < config.INTEREST_MIN_SIGNALS) return;

    const due =
      lastBuiltAt === null ||
      Date.now() - lastBuiltAt.getTime() >= config.INTEREST_REBUILD_INTERVAL_MINUTES * 60_000;
    if (!due) return;

    running = buildProfile();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  return {
    async start() {
      if (!config.INTEREST_SCORING_ENABLED) return;
      const profile = await readProfileSummary(sql, userId);
      lastBuiltAt = profile.builtAt;

      loop = (async () => {
        while (!stopping) {
          try {
            await tick();
          } catch (error) {
            // A failed rebuild must not kill the loop. The previous profile
            // stays in place and ranking keeps working from it.
            console.error("interest profile rebuild failed:", error);
          }
          if (stopping) break;
          await sleep(TICK_MS);
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
      const state = await inactiveReason();
      const profile = await readProfileSummary(sql, userId);
      const signals = await signalCount(sql, userId);
      return {
        enabled: config.INTEREST_SCORING_ENABLED,
        builtAt: profile.builtAt?.toISOString() ?? null,
        ...(state ?? {
          active: true as const,
          signals,
          required: config.INTEREST_MIN_SIGNALS,
          clusters: profile.clusters,
        }),
      };
    },

    async rebuild() {
      if (!config.INTEREST_SCORING_ENABLED) {
        throw new Error("interest scoring is not enabled; set INTEREST_SCORING_ENABLED first");
      }
      if (!embeddings.activeProvider()) {
        throw new Error(
          "interest scoring needs an embedding model that matches the stored vectors",
        );
      }
      running = buildProfile();
      try {
        return (await running) as { clusters: number; signals: number };
      } finally {
        running = null;
      }
    },

    async rank(options) {
      const state = await inactiveReason();
      if (state) return { items: [], scoring: state };

      const { ranked, explore } = explorationSlots(
        options.limit,
        config.INTEREST_EXPLORATION_RATIO,
      );

      const scored = await scoreItems(sql, {
        userId,
        limit: ranked,
        unreadOnly: options.unreadOnly,
        sourceId: options.sourceId,
        recencyHalfLifeHours: config.INTEREST_RECENCY_HALFLIFE_HOURS,
        estimatedFactor: config.INTEREST_ESTIMATED_DATE_FACTOR,
        windowDays: config.INTEREST_WINDOW_DAYS,
      });

      const exploration = await explorationCandidates(sql, {
        userId,
        limit: explore,
        unreadOnly: options.unreadOnly,
        sourceId: options.sourceId,
        windowDays: config.INTEREST_WINDOW_DAYS,
        exclude: scored.map((item) => item.id),
      });

      const items = interleaveExploration(
        scored.map((item) => ({ ...item, exploration: false })),
        exploration.map((item) => ({ ...item, exploration: true })),
      );

      const profile = await readProfileSummary(sql, userId);
      const signals = await signalCount(sql, userId);
      return {
        items,
        scoring: {
          active: true,
          signals,
          required: config.INTEREST_MIN_SIGNALS,
          clusters: profile.clusters,
        },
      };
    },
  };
}
