import { describe, expect, test } from "bun:test";

import {
  affinity,
  clusterCount,
  decayFactor,
  explorationSlots,
  interleaveExploration,
  recencyFactor,
  SIGNAL_WEIGHTS,
  signalStrength,
} from "./interest.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("decayFactor", () => {
  test("is 1 at zero age and 0.5 at one half-life", () => {
    expect(decayFactor(0, DAY)).toBe(1);
    expect(decayFactor(DAY, DAY)).toBeCloseTo(0.5, 12);
    expect(decayFactor(2 * DAY, DAY)).toBeCloseTo(0.25, 12);
  });

  test("clamps a negative age rather than amplifying it", () => {
    // A publisher's clock running fast must not be able to manufacture a
    // relevance score above the maximum.
    expect(decayFactor(-DAY, DAY)).toBe(1);
  });

  test("refuses a non-positive half-life", () => {
    expect(() => decayFactor(DAY, 0)).toThrow("half-life must be positive");
  });
});

describe("signalStrength", () => {
  const now = new Date("2026-08-12T00:00:00Z");

  test("keeps the sign of the signal's weight", () => {
    const at = now;
    expect(signalStrength({ itemId: "a", kind: "starred", at }, now, 30)).toBeCloseTo(3, 12);
    expect(signalStrength({ itemId: "a", kind: "read", at }, now, 30)).toBeCloseTo(1, 12);
    expect(signalStrength({ itemId: "a", kind: "skipped", at }, now, 30)).toBeCloseTo(-1, 12);
  });

  test("a star older than the half-life is worth less than a fresh read", () => {
    // The point of decaying signals: what you starred last year should not
    // still outweigh what you read this morning.
    const old = new Date(now.getTime() - 90 * DAY);
    const star = signalStrength({ itemId: "a", kind: "starred", at: old }, now, 30);
    const read = signalStrength({ itemId: "b", kind: "read", at: now }, now, 30);
    expect(star).toBeLessThan(read);
  });

  test("matches the weights the issue specifies", () => {
    expect(SIGNAL_WEIGHTS).toEqual({ starred: 3, read: 1, skipped: -1 });
  });
});

describe("clusterCount", () => {
  test("stays below the issue's five-to-ten range on thin history", () => {
    // Thirty signals is where scoring activates. Five clusters of six items
    // would be describing noise.
    expect(clusterCount(30, 10)).toBeLessThan(5);
  });

  test("reaches the range once there is real history", () => {
    expect(clusterCount(200, 10)).toBeGreaterThanOrEqual(5);
    expect(clusterCount(200, 10)).toBeLessThanOrEqual(10);
  });

  test("never returns one, which is the design the issue rejects", () => {
    expect(clusterCount(0, 10)).toBe(2);
    expect(clusterCount(1, 10)).toBe(2);
  });

  test("respects the configured maximum", () => {
    expect(clusterCount(100_000, 10)).toBe(10);
    expect(clusterCount(100_000, 6)).toBe(6);
  });
});

describe("affinity", () => {
  test("is exactly 1 for a cluster nothing has been skipped near", () => {
    // The property that makes this safe to apply unconditionally: a user who
    // has never skipped anything sees no effect from it at all.
    expect(affinity(12.5, 0)).toBe(1);
  });

  test("halves when skips match positives", () => {
    expect(affinity(4, 4)).toBeCloseTo(0.5, 12);
  });

  test("approaches zero without reaching it, so a cluster fades rather than vanishing", () => {
    const heavy = affinity(1, 999);
    expect(heavy).toBeGreaterThan(0);
    expect(heavy).toBeLessThan(0.01);
  });

  test("refuses a cluster with no positive weight", () => {
    expect(() => affinity(0, 1)).toThrow();
  });
});

describe("recencyFactor", () => {
  const now = new Date("2026-08-12T00:00:00Z");
  const options = { halfLifeHours: 72, estimatedFactor: 0.7 };

  test("a week-old item keeps about a fifth of its similarity", () => {
    // Issue #4: "week-old items do not stay pinned".
    const published = new Date(now.getTime() - 7 * DAY);
    expect(recencyFactor(published, false, now, options)).toBeCloseTo(0.198, 3);
  });

  test("discounts an item whose date was guessed", () => {
    const published = now;
    const real = recencyFactor(published, false, now, options);
    const guessed = recencyFactor(published, true, now, options);
    expect(guessed).toBeCloseTo(real * 0.7, 12);
    // Pins the direction. Not discounting would put every dateless item at the
    // top of the timeline, since its guessed date is always "now".
    expect(guessed).toBeLessThan(real);
  });
});

describe("explorationSlots", () => {
  test("reserves the configured share", () => {
    expect(explorationSlots(20, 0.2)).toEqual({ ranked: 16, explore: 4 });
    expect(explorationSlots(50, 0.2)).toEqual({ ranked: 40, explore: 10 });
  });

  test("never gives up the whole page", () => {
    // A list with no scored items is not a ranked list.
    expect(explorationSlots(3, 1)).toEqual({ ranked: 1, explore: 2 });
    expect(explorationSlots(1, 0.5)).toEqual({ ranked: 1, explore: 0 });
  });

  test("reserves nothing when the ratio is off", () => {
    expect(explorationSlots(20, 0)).toEqual({ ranked: 20, explore: 0 });
  });
});

describe("interleaveExploration", () => {
  test("spreads exploration through the page instead of appending it", () => {
    // Appended items land below where reading stops, so the slot would exist
    // without doing anything. This test fails under the append implementation.
    const ranked = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];
    const explore = ["e1", "e2"];
    const merged = interleaveExploration(ranked, explore);

    expect(merged).toHaveLength(10);
    expect(merged.filter((id) => id.startsWith("e"))).toEqual(["e1", "e2"]);
    expect(merged.indexOf("e1")).toBeLessThan(merged.length - 2);
  });

  test("is deterministic", () => {
    // A timeline that reshuffles on every refresh cannot be navigated.
    const ranked = ["r1", "r2", "r3", "r4"];
    const explore = ["e1"];
    expect(interleaveExploration(ranked, explore)).toEqual(interleaveExploration(ranked, explore));
  });

  test("keeps the ranked order among the ranked items", () => {
    const ranked = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const merged = interleaveExploration(ranked, ["e1", "e2"]);
    expect(merged.filter((id) => id.startsWith("r"))).toEqual(ranked);
  });

  test("handles an empty side", () => {
    expect(interleaveExploration(["r1"], [])).toEqual(["r1"]);
    expect(interleaveExploration([], ["e1"])).toEqual(["e1"]);
  });
});
