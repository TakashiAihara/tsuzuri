import { describe, expect, test } from "bun:test";

import {
  halfLifeDecay,
  interactionSignal,
  kmeans,
  maxCosineSimilarity,
  type WeightedVector,
} from "./scoring.ts";

const HOUR = 3_600_000;

describe("halfLifeDecay", () => {
  test("is 1 at age zero", () => {
    expect(halfLifeDecay(0, 24 * HOUR)).toBe(1);
  });

  test("halves at each half-life", () => {
    expect(halfLifeDecay(24 * HOUR, 24 * HOUR)).toBeCloseTo(0.5, 10);
    expect(halfLifeDecay(48 * HOUR, 24 * HOUR)).toBeCloseTo(0.25, 10);
  });

  test("clamps negative ages to 1 instead of rewarding the future", () => {
    expect(halfLifeDecay(-5 * HOUR, 24 * HOUR)).toBe(1);
  });

  test("rejects a non-positive half-life", () => {
    expect(() => halfLifeDecay(HOUR, 0)).toThrow("positive");
    expect(() => halfLifeDecay(HOUR, -1)).toThrow("positive");
  });
});

describe("interactionSignal", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const halfLife = 30 * 24 * HOUR;
  const empty = { readAt: null, starredAt: null, skippedAt: null, savedAt: null };

  test("returns null when nothing happened", () => {
    expect(interactionSignal(empty, now, halfLife)).toBeNull();
  });

  test("a fresh read weighs 1, a fresh star weighs 3, a fresh skip weighs -1", () => {
    expect(interactionSignal({ ...empty, readAt: now }, now, halfLife)?.weight).toBeCloseTo(1, 10);
    expect(interactionSignal({ ...empty, starredAt: now }, now, halfLife)?.weight).toBeCloseTo(
      3,
      10,
    );
    expect(interactionSignal({ ...empty, skippedAt: now }, now, halfLife)?.weight).toBeCloseTo(
      -1,
      10,
    );
    expect(interactionSignal({ ...empty, savedAt: now }, now, halfLife)?.weight).toBeCloseTo(3, 10);
  });

  test("a star after a skip means interest: the strongest interaction wins", () => {
    const signal = interactionSignal(
      { ...empty, skippedAt: new Date("2026-08-01T00:00:00Z"), starredAt: now },
      now,
      halfLife,
    );
    expect(signal?.weight).toBeCloseTo(3, 10);
    expect(signal?.at).toEqual(now);
  });

  test("decay runs from the winning interaction's own timestamp", () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * HOUR);
    const signal = interactionSignal({ ...empty, readAt: thirtyDaysAgo }, now, halfLife);
    expect(signal?.weight).toBeCloseTo(0.5, 10);
  });

  test("an old skip stays negative after decay, just weaker", () => {
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * HOUR);
    const signal = interactionSignal({ ...empty, skippedAt: sixtyDaysAgo }, now, halfLife);
    expect(signal?.weight).toBeCloseTo(-0.25, 10);
  });
});

/** Points scattered tightly around a direction, so cluster recovery is testable. */
function around(direction: number[], count: number, jitter: number, weight = 1): WeightedVector[] {
  return Array.from({ length: count }, (_, i) => ({
    vector: direction.map((x, d) => x + jitter * Math.sin(i * 7 + d * 13)),
    weight,
  }));
}

describe("kmeans", () => {
  const eastward = [1, 0, 0, 0];
  const northward = [0, 1, 0, 0];

  test("recovers two well-separated groups", () => {
    const points = [...around(eastward, 20, 0.05), ...around(northward, 20, 0.05)];
    const clusters = kmeans(points, 2, { seed: 42 });

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.itemCount).sort()).toEqual([20, 20]);
    const similarity = (a: readonly number[], b: readonly number[]) =>
      maxCosineSimilarity(a, [b as number[]]);
    const nearEast = clusters.find((c) => similarity(c.centroid, eastward) > 0.99);
    const nearNorth = clusters.find((c) => similarity(c.centroid, northward) > 0.99);
    expect(nearEast).toBeDefined();
    expect(nearNorth).toBeDefined();
  });

  test("is deterministic for the same seed", () => {
    const points = [...around(eastward, 15, 0.1), ...around(northward, 15, 0.1)];
    const a = kmeans(points, 3, { seed: 7 });
    const b = kmeans(points, 3, { seed: 7 });
    expect(a).toEqual(b);
  });

  test("heavier points pull the centroid", () => {
    const light: WeightedVector = { vector: [1, 0], weight: 1 };
    const heavy: WeightedVector = { vector: [0, 1], weight: 100 };
    const [cluster] = kmeans([light, heavy], 1, { seed: 1 });
    const [x = 0, y = 0] = cluster?.centroid ?? [];
    expect(y).toBeGreaterThan(x);
    expect(cluster?.weight).toBe(101);
  });

  test("caps k at the number of points", () => {
    const points = around(eastward, 3, 0.2);
    const clusters = kmeans(points, 10, { seed: 1 });
    expect(clusters.length).toBeLessThanOrEqual(3);
    expect(clusters.reduce((sum, c) => sum + c.itemCount, 0)).toBe(3);
  });

  test("collapses identical points into one cluster instead of duplicating centres", () => {
    const points: WeightedVector[] = Array.from({ length: 4 }, () => ({
      vector: [1, 0],
      weight: 1,
    }));
    const clusters = kmeans(points, 3, { seed: 1 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.itemCount).toBe(4);
  });

  test("rejects non-positive weights: skips are the caller's job, not a cluster member", () => {
    expect(() => kmeans([{ vector: [1, 0], weight: 0 }], 1)).toThrow("positive");
    expect(() => kmeans([{ vector: [1, 0], weight: -1 }], 1)).toThrow("positive");
  });

  test("rejects mixed dimensions", () => {
    const points: WeightedVector[] = [
      { vector: [1, 0], weight: 1 },
      { vector: [1, 0, 0], weight: 1 },
    ];
    expect(() => kmeans(points, 1)).toThrow("dimension");
  });

  test("returns empty for no points", () => {
    expect(kmeans([], 5)).toEqual([]);
  });
});

describe("maxCosineSimilarity", () => {
  test("takes the nearest centroid, not an average of them", () => {
    const centroids = [
      [1, 0],
      [0, 1],
    ];
    expect(maxCosineSimilarity([1, 0.01], centroids)).toBeGreaterThan(0.99);
  });

  test("is 0 with no centroids", () => {
    expect(maxCosineSimilarity([1, 0], [])).toBe(0);
  });

  test("normalises its input, so magnitude does not change the score", () => {
    const centroids = [[1, 0]];
    expect(maxCosineSimilarity([5, 0], centroids)).toBeCloseTo(
      maxCosineSimilarity([0.2, 0], centroids),
      10,
    );
  });
});
