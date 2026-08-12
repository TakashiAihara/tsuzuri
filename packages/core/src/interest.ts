/**
 * The arithmetic behind interest scoring.
 *
 * Everything here is pure and free of the database, because ranking is the part
 * of this feature most likely to be quietly wrong. A score that is merely a
 * little off looks exactly like a score that is right, so each choice below is
 * pinned by a test that fails under the opposite choice rather than by a
 * comment claiming it works.
 *
 * The scoring query in packages/db computes the same shapes in SQL. The two
 * must agree; the tests here are what says what they must agree on.
 */

/**
 * What a signal is worth before decay.
 *
 * From issue #4. Signed, and the sign is load-bearing rather than decorative:
 * positive signals decide where an interest cluster sits, and negative ones
 * never do -- a repulsive member has no meaning in cosine k-means, and a
 * negatively weighted point would drag a centroid to a position representing
 * nothing. Skips are accumulated separately and spend themselves on affinity.
 */
export const SIGNAL_WEIGHTS = {
  starred: 3,
  read: 1,
  skipped: -1,
} as const;

export type SignalKind = keyof typeof SIGNAL_WEIGHTS;

/** One recorded interaction, as the profile builder consumes it. */
export type Signal = {
  itemId: string;
  kind: SignalKind;
  at: Date;
};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Exponential decay by half-life.
 *
 * Half-life rather than a linear window because the question "how much does a
 * month-old star still count" has a smooth answer and a cliff does not. An age
 * before the reference point is clamped to 1 rather than amplified: clock skew
 * on a publisher's feed should not be able to manufacture relevance.
 */
export function decayFactor(ageMs: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) throw new Error("half-life must be positive");
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / halfLifeMs);
}

/**
 * A signal's strength now: its weight, decayed from when it happened.
 *
 * Keeps the sign of SIGNAL_WEIGHTS, so callers split on it rather than
 * remembering which kinds are negative.
 */
export function signalStrength(signal: Signal, now: Date, halfLifeDays: number): number {
  const age = now.getTime() - signal.at.getTime();
  return SIGNAL_WEIGHTS[signal.kind] * decayFactor(age, halfLifeDays * MS_PER_DAY);
}

/**
 * How many interest clusters to build for a given amount of history.
 *
 * Issue #4 asks for five to ten. Taken literally at the point scoring first
 * activates -- thirty signals -- that would be five clusters of six items,
 * which describes noise rather than interests. Growing k with the square root
 * of the history reaches the issue's range at a few hundred signals and stays
 * honestly below it before that.
 *
 * Two is the floor: one cluster is the single-centroid design the issue exists
 * to reject.
 */
export function clusterCount(signals: number, max: number): number {
  const wanted = Math.round(Math.sqrt(signals / 2));
  return Math.max(2, Math.min(max, wanted));
}

/**
 * How much a cluster's similarity counts, given what has been skipped near it.
 *
 * Exactly 1 when nothing has been skipped, so a cluster you have never skipped
 * is untouched by this. Falls to 0.5 when skips match positives, and approaches
 * zero as skips dominate -- an interest you have cooled on fades continuously
 * instead of vanishing the moment a running total crosses zero.
 *
 * Deliberately not the cluster's weight or size. Scaling by those would let a
 * large interest swamp a smaller one that an item actually matches better,
 * which is the failure a multi-cluster profile exists to prevent.
 */
export function affinity(positiveWeight: number, skippedWeight: number): number {
  if (!(positiveWeight > 0)) throw new Error("a cluster with no positive weight should not exist");
  const skipped = Math.max(0, skippedWeight);
  return positiveWeight / (positiveWeight + skipped);
}

export type RecencyOptions = {
  halfLifeHours: number;
  /**
   * Multiplier for an item whose published_at is really the fetch time.
   *
   * Such an item always looks brand new, because the guess is "now". Discounted
   * rather than backdated: there is no better timestamp available, so the honest
   * move is to trust it less, not to invent a different one.
   */
  estimatedFactor: number;
};

/** The time component of an interest score. */
export function recencyFactor(
  publishedAt: Date,
  estimated: boolean,
  now: Date,
  options: RecencyOptions,
): number {
  const age = now.getTime() - publishedAt.getTime();
  const decay = decayFactor(age, options.halfLifeHours * MS_PER_HOUR);
  return estimated ? decay * options.estimatedFactor : decay;
}

/**
 * How a ranked page is split between scoring's choices and exploration.
 *
 * Rounding down, and never taking the whole page: a list with no scored items
 * is not a ranked list. A page of one is all ranked, which is the only sensible
 * reading of "reserve twenty percent of one row".
 */
export function explorationSlots(
  limit: number,
  ratio: number,
): { ranked: number; explore: number } {
  if (limit <= 1 || ratio <= 0) return { ranked: limit, explore: 0 };
  const explore = Math.min(limit - 1, Math.floor(limit * Math.min(1, ratio)));
  return { ranked: limit - explore, explore };
}

/**
 * Place exploration items among the ranked ones.
 *
 * Spread through the list rather than appended, because everything appended
 * lands below where reading stops and the slot may as well not exist. Spread
 * deterministically rather than randomly: a timeline that reshuffles on every
 * refresh cannot be navigated, and a random one cannot be tested.
 *
 * Positions are computed from the totals alone, so the same inputs always
 * produce the same page.
 */
export function interleaveExploration<T>(ranked: readonly T[], explore: readonly T[]): T[] {
  if (explore.length === 0) return [...ranked];
  if (ranked.length === 0) return [...explore];

  const total = ranked.length + explore.length;
  const positions = new Set<number>();
  for (let i = 1; i <= explore.length; i += 1) {
    positions.add(Math.min(total - 1, Math.ceil((i * total) / explore.length) - 1));
  }

  const out: T[] = [];
  let nextRanked = 0;
  let nextExplore = 0;
  for (let slot = 0; slot < total; slot += 1) {
    const takeExplore = positions.has(slot) && nextExplore < explore.length;
    if (takeExplore || nextRanked >= ranked.length) {
      const item = explore[nextExplore];
      if (item !== undefined) {
        out.push(item);
        nextExplore += 1;
        continue;
      }
    }
    const item = ranked[nextRanked];
    if (item !== undefined) {
      out.push(item);
      nextRanked += 1;
    }
  }
  return out;
}

/**
 * Why a list came back in date order rather than ranked.
 *
 * Every one of these looks identical from the list itself, which is why the
 * response carries the reason. It is the same argument that put `mode` and
 * `reason` on /search: an empty or unranked answer cannot distinguish "off"
 * from "not ready" from "broken", and guessing wrong sends someone debugging a
 * component they never enabled.
 */
export type ScoringState =
  | { active: true; signals: number; required: number; clusters: number }
  | { active: false; reason: ScoringInactiveReason; signals: number; required: number };

export type ScoringInactiveReason =
  | "interest scoring is not enabled"
  | "no embedding model is configured"
  | "the embedding model does not match the stored vectors"
  | "not enough reading history yet"
  | "the interest profile has not been built yet";
