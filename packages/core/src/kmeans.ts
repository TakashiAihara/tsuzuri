/**
 * Spherical k-means over embeddings, for building an interest profile.
 *
 * Spherical -- cosine distance, unit-length centroids -- because that is the
 * space the rest of the system already ranks in. Every vector here is
 * normalised on the way in, which turns cosine similarity into a dot product
 * and removes the only expensive part of the loop.
 *
 * It runs here rather than in SQL for a measured reason: a centroid is a
 * weighted mean, since a starred article counts three times a read one, and
 * pgvector has no scalar multiplication (`vector * 2` does not exist), so
 * `avg()` and `sum()` cannot express one. The input is bounded by how much
 * someone has reacted to rather than by how much they have stored, which is
 * what makes pulling it into memory reasonable.
 *
 * Determinism is a requirement, not a nicety. Without it the same history
 * produces a different timeline on every rebuild, nothing about the clustering
 * can be asserted in a test, and a ranking bug cannot be reproduced. So there
 * is no Math.random() anywhere below: the seed comes from the caller.
 */

/**
 * mulberry32.
 *
 * A seeded PRNG rather than Math.random(), so a rebuild over unchanged history
 * produces an unchanged profile. Small and well-distributed enough for
 * k-means++ sampling, which is all it is asked to do.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from arbitrary text, so a user id can seed a rebuild. */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Length of a vector. */
function norm(vector: readonly number[]): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}

/**
 * Scale to unit length, or null when there is nothing to scale.
 *
 * Null rather than a zero vector, because a zero vector is the one input that
 * makes every downstream distance NaN -- and NaN sorts above every real number
 * in PostgreSQL, so a single one would silently pin arbitrary articles to the
 * top of the timeline. Callers drop what this refuses.
 */
export function normalize(vector: readonly number[]): number[] | null {
  const length = norm(vector);
  if (!Number.isFinite(length) || length === 0) return null;
  return vector.map((value) => value / length);
}

/** Cosine similarity of two unit vectors, which is their dot product. */
export function dot(a: readonly number[], b: readonly number[]): number {
  const width = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < width; i += 1) total += (a[i] as number) * (b[i] as number);
  return total;
}

export type KMeansInput = {
  /** Unit-length vectors. Callers normalise and drop what cannot be normalised. */
  vectors: ReadonlyArray<readonly number[]>;
  /** Positive weight per vector, in the same order. */
  weights: readonly number[];
  k: number;
  seed: number;
  maxIterations?: number;
};

export type KMeansResult = {
  /** Centroid index per input vector, or -1 for a vector left unassigned. */
  assignments: number[];
  /** Unit-length centroids. Degenerate clusters are dropped, so this may be shorter than k. */
  centroids: number[][];
  iterations: number;
};

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * k-means++ seeding, weighted.
 *
 * Picking the first centre uniformly and each subsequent one in proportion to
 * its squared distance from the nearest chosen centre. Plain random seeding
 * regularly lands two centres inside one interest and leaves another with none,
 * and the loop cannot recover from that -- it converges to the bad split rather
 * than out of it.
 *
 * Weighted, because a starred article should be likelier to found a cluster
 * than something merely read.
 */
function seedCentroids(input: KMeansInput, random: () => number, k: number): number[][] {
  const { vectors, weights } = input;
  const chosen: number[][] = [];
  const chosenIndices: number[] = [];

  const pickWeighted = (scores: readonly number[]): number => {
    let total = 0;
    for (const score of scores) total += score;
    if (!(total > 0)) {
      // Every remaining candidate is identical to something already chosen.
      // Fall back to the first unused index rather than looping forever.
      return scores.findIndex((_, index) => !chosenIndices.includes(index));
    }
    let target = random() * total;
    for (let i = 0; i < scores.length; i += 1) {
      target -= scores[i] as number;
      if (target <= 0) return i;
    }
    return scores.length - 1;
  };

  const first = pickWeighted(weights);
  if (first < 0) return chosen;
  chosen.push([...(vectors[first] as readonly number[])]);
  chosenIndices.push(first);

  while (chosen.length < k) {
    const scores = vectors.map((vector, index) => {
      if (chosenIndices.includes(index)) return 0;
      let nearest = -1;
      for (const centroid of chosen) nearest = Math.max(nearest, dot(vector, centroid));
      // Cosine distance in [0, 2], squared, times the vector's weight.
      const distance = 1 - nearest;
      return distance * distance * (weights[index] as number);
    });
    const next = pickWeighted(scores);
    if (next < 0) break;
    chosen.push([...(vectors[next] as readonly number[])]);
    chosenIndices.push(next);
  }

  return chosen;
}

/**
 * Run the loop.
 *
 * Stops when no assignment changed or the iteration cap is reached. The cap
 * exists because convergence is not guaranteed to be quick and a rebuild that
 * runs for a minute is worse than one that stops slightly early: the result
 * feeds ranking, which is re-derived on the next rebuild anyway.
 *
 * Empty and zero-length clusters are dropped rather than re-seeded. A cluster
 * whose members cancelled each other out is not describing an interest, and
 * carrying it forward as a zero vector is exactly the NaN hazard this module
 * refuses to create.
 */
export function sphericalKMeans(input: KMeansInput): KMeansResult {
  const { vectors, weights } = input;
  if (vectors.length === 0) return { assignments: [], centroids: [], iterations: 0 };

  const k = Math.max(1, Math.min(input.k, vectors.length));
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const random = seededRandom(input.seed);

  let centroids = seedCentroids({ ...input, k }, random, k);
  let assignments = new Array<number>(vectors.length).fill(-1);
  let iterations = 0;

  for (; iterations < maxIterations; iterations += 1) {
    let changed = false;

    for (let i = 0; i < vectors.length; i += 1) {
      const vector = vectors[i] as readonly number[];
      let best = -1;
      let bestSimilarity = Number.NEGATIVE_INFINITY;
      for (let c = 0; c < centroids.length; c += 1) {
        const similarity = dot(vector, centroids[c] as number[]);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const width = (vectors[0] as readonly number[]).length;
    const sums = centroids.map(() => new Array<number>(width).fill(0));
    for (let i = 0; i < vectors.length; i += 1) {
      const cluster = assignments[i] as number;
      if (cluster < 0) continue;
      const sum = sums[cluster] as number[];
      const vector = vectors[i] as readonly number[];
      const weight = weights[i] as number;
      for (let d = 0; d < width; d += 1) {
        sum[d] = (sum[d] as number) + (vector[d] as number) * weight;
      }
    }

    // Rebuild the centroid list, dropping the ones that came out degenerate,
    // and remap assignments so indices stay meaningful.
    const kept: number[][] = [];
    const remap = new Map<number, number>();
    for (let c = 0; c < sums.length; c += 1) {
      const centroid = normalize(sums[c] as number[]);
      if (!centroid) continue;
      remap.set(c, kept.length);
      kept.push(centroid);
    }
    if (kept.length === 0)
      return { assignments: assignments.map(() => -1), centroids: [], iterations };

    assignments = assignments.map((cluster) => (cluster < 0 ? -1 : (remap.get(cluster) ?? -1)));
    if (kept.length !== centroids.length) changed = true;
    centroids = kept;

    if (!changed) break;
  }

  return { assignments, centroids, iterations };
}
