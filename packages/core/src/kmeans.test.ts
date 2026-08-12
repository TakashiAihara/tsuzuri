import { describe, expect, test } from "bun:test";

import { dot, normalize, seededRandom, seedFrom, sphericalKMeans } from "./kmeans.ts";

/** Three tight groups on the unit circle, embedded in 3 dimensions. */
function threeGroups(): { vectors: number[][]; weights: number[] } {
  const seeds: Array<[number, number, number]> = [
    [1, 0, 0],
    [0.98, 0.02, 0],
    [0.97, 0, 0.03],
    [0, 1, 0],
    [0.02, 0.98, 0],
    [0, 0.99, 0.02],
    [0, 0, 1],
    [0, 0.03, 0.97],
    [0.02, 0, 0.98],
  ];
  const vectors = seeds.map((seed) => normalize(seed) as number[]);
  return { vectors, weights: seeds.map(() => 1) };
}

describe("seededRandom", () => {
  test("is reproducible for a seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("differs between seeds", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  test("stays inside [0, 1)", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 500; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("seedFrom", () => {
  test("is stable for the same text", () => {
    expect(seedFrom("00000000-0000-0000-0000-000000000001")).toBe(
      seedFrom("00000000-0000-0000-0000-000000000001"),
    );
  });

  test("differs for different text", () => {
    expect(seedFrom("a")).not.toBe(seedFrom("b"));
  });
});

describe("normalize", () => {
  test("scales to unit length", () => {
    const unit = normalize([3, 4, 0]) as number[];
    expect(unit).toEqual([0.6, 0.8, 0]);
  });

  test("refuses a zero vector", () => {
    // The one input that would make every downstream cosine distance NaN --
    // and NaN sorts above every real number in PostgreSQL, so a single one
    // would silently pin arbitrary articles to the top of the timeline.
    expect(normalize([0, 0, 0])).toBeNull();
  });

  test("refuses a vector containing infinities", () => {
    expect(normalize([Number.POSITIVE_INFINITY, 0])).toBeNull();
  });
});

describe("sphericalKMeans", () => {
  test("recovers separated groups", () => {
    const { vectors, weights } = threeGroups();
    const result = sphericalKMeans({ vectors, weights, k: 3, seed: 1 });

    expect(result.centroids).toHaveLength(3);
    // Members of a group must land together, whatever the cluster is numbered.
    const [a, b, c] = [result.assignments[0], result.assignments[1], result.assignments[2]];
    expect(a).toBe(b as number);
    expect(a).toBe(c as number);
    expect(result.assignments[3]).toBe(result.assignments[4] as number);
    expect(result.assignments[6]).toBe(result.assignments[8] as number);
    expect(new Set(result.assignments).size).toBe(3);
  });

  test("produces identical centroids for the same seed", () => {
    // Determinism is a requirement: without it the same history produces a
    // different timeline on every rebuild and nothing here can be asserted.
    const { vectors, weights } = threeGroups();
    const first = sphericalKMeans({ vectors, weights, k: 3, seed: 99 });
    const second = sphericalKMeans({ vectors, weights, k: 3, seed: 99 });
    expect(second.centroids).toEqual(first.centroids);
    expect(second.assignments).toEqual(first.assignments);
  });

  test("returns unit-length centroids", () => {
    const { vectors, weights } = threeGroups();
    const result = sphericalKMeans({ vectors, weights, k: 3, seed: 5 });
    for (const centroid of result.centroids) {
      expect(dot(centroid, centroid)).toBeCloseTo(1, 10);
    }
  });

  test("weights pull a centroid toward the heavier member", () => {
    // A starred article counts three times a read one, and this is the only
    // place that fact reaches the geometry.
    const vectors = [normalize([1, 0]) as number[], normalize([0, 1]) as number[]];
    const even = sphericalKMeans({ vectors, weights: [1, 1], k: 1, seed: 3 });
    const skewed = sphericalKMeans({ vectors, weights: [3, 1], k: 1, seed: 3 });
    const first = even.centroids[0] as number[];
    const second = skewed.centroids[0] as number[];
    expect(second[0] as number).toBeGreaterThan(first[0] as number);
  });

  test("drops a cluster whose members cancel out rather than writing a zero centroid", () => {
    // Opposing members sum to zero. Writing that would be the NaN hazard.
    const vectors = [normalize([1, 0]) as number[], normalize([-1, 0]) as number[]];
    const result = sphericalKMeans({ vectors, weights: [1, 1], k: 1, seed: 11 });
    expect(result.centroids).toHaveLength(0);
    expect(result.assignments).toEqual([-1, -1]);
    for (const centroid of result.centroids) {
      expect(normalize(centroid)).not.toBeNull();
    }
  });

  test("never emits a centroid that would produce NaN", () => {
    const { vectors, weights } = threeGroups();
    const result = sphericalKMeans({ vectors, weights, k: 5, seed: 2 });
    for (const centroid of result.centroids) {
      for (const value of centroid) expect(Number.isFinite(value)).toBe(true);
      expect(dot(centroid, centroid)).toBeGreaterThan(0);
    }
  });

  test("caps k at the number of vectors", () => {
    const vectors = [normalize([1, 0]) as number[], normalize([0, 1]) as number[]];
    const result = sphericalKMeans({ vectors, weights: [1, 1], k: 10, seed: 4 });
    expect(result.centroids.length).toBeLessThanOrEqual(2);
  });

  test("handles an empty input", () => {
    expect(sphericalKMeans({ vectors: [], weights: [], k: 3, seed: 1 })).toEqual({
      assignments: [],
      centroids: [],
      iterations: 0,
    });
  });

  test("stops rather than running forever on identical vectors", () => {
    const vectors = Array.from({ length: 8 }, () => normalize([1, 1, 1]) as number[]);
    const result = sphericalKMeans({
      vectors,
      weights: vectors.map(() => 1),
      k: 3,
      seed: 6,
      maxIterations: 20,
    });
    expect(result.iterations).toBeLessThanOrEqual(20);
    expect(result.centroids.length).toBeGreaterThan(0);
  });
});
