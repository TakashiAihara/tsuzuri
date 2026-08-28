/**
 * Pure math for interest scoring: exponential time decay and weighted K-Means
 * over embedding vectors. No I/O here; the daemon feeds it signal vectors read
 * from item_state × item_embeddings and stores the resulting centroids.
 */

/**
 * Exponential decay by half-life: 1.0 at age 0, 0.5 at one half-life, 0.25 at
 * two. Negative ages (clock skew, estimated dates slightly in the future) clamp
 * to 1.0 rather than rewarding the future.
 */
export function halfLifeDecay(ageMs: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) throw new Error(`halfLifeMs must be positive, got ${halfLifeMs}`);
  if (ageMs <= 0) return 1;
  return 2 ** (-ageMs / halfLifeMs);
}

export type WeightedVector = {
  vector: readonly number[];
  /** Signal strength × time decay. Must be positive: negative signals (skips) do not cluster, they are applied by the caller against cluster weights. */
  weight: number;
};

export type InterestCentroid = {
  /** Unit-length centroid in the embedding space. */
  centroid: number[];
  /** Summed signal weight of the members, for diagnostics and exploration ratios. */
  weight: number;
  itemCount: number;
};

export type KMeansOptions = {
  maxIterations?: number;
  /** Seed for the deterministic PRNG used by k-means++ initialisation. The same inputs and seed always produce the same clusters, so a rebuild is reproducible. */
  seed?: number;
};

/**
 * Weighted K-Means with k-means++ initialisation over unit-normalised vectors.
 *
 * Vectors are normalised to unit length so squared Euclidean distance orders
 * pairs the same way cosine distance does; centroids are re-normalised after
 * every update to stay in that geometry.
 *
 * Empty clusters are dropped rather than re-seeded, so fewer than k centroids
 * can come back. With k >= points, every point is its own cluster.
 */
export function kmeans(
  points: readonly WeightedVector[],
  k: number,
  options: KMeansOptions = {},
): InterestCentroid[] {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`);
  const first = points[0];
  if (!first) return [];

  const dimension = first.vector.length;
  for (const p of points) {
    if (!(p.weight > 0)) throw new Error(`weights must be positive, got ${p.weight}`);
    if (p.vector.length !== dimension)
      throw new Error(`vector dimensions differ: ${p.vector.length} vs ${dimension}`);
  }

  const unit = points.map((p) => ({ vector: normalize(p.vector), weight: p.weight }));
  const effectiveK = Math.min(k, unit.length);
  const rng = mulberry32(options.seed ?? 1);
  let centroids = plusPlusInit(unit, effectiveK, rng);

  const maxIterations = options.maxIterations ?? 50;
  const assignment = new Array<number>(unit.length).fill(0);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;
    for (let i = 0; i < unit.length; i++) {
      const point = unit[i];
      if (!point) continue;
      const nearest = nearestCentroid(point.vector, centroids);
      if (nearest !== assignment[i]) {
        assignment[i] = nearest;
        changed = true;
      }
    }
    if (!changed && iteration > 0) break;

    const sums = centroids.map(() => new Array<number>(dimension).fill(0));
    const weights = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < unit.length; i++) {
      const point = unit[i];
      const c = assignment[i] ?? 0;
      const sum = sums[c];
      if (!point || !sum) continue;
      weights[c] = (weights[c] ?? 0) + point.weight;
      for (let d = 0; d < dimension; d++)
        sum[d] = (sum[d] ?? 0) + (point.vector[d] ?? 0) * point.weight;
    }
    centroids = centroids.map((old, c) => {
      const sum = sums[c];
      return sum && (weights[c] ?? 0) > 0 ? normalize(sum) : old;
    });
  }

  const clusters: InterestCentroid[] = centroids.map((centroid) => ({
    centroid,
    weight: 0,
    itemCount: 0,
  }));
  for (let i = 0; i < points.length; i++) {
    const cluster = clusters[assignment[i] ?? 0];
    const point = points[i];
    if (!cluster || !point) continue;
    cluster.weight += point.weight;
    cluster.itemCount += 1;
  }
  return clusters.filter((c) => c.itemCount > 0);
}

/** Cosine similarity of a vector against its nearest centroid: the similarity half of the interest score. */
export function maxCosineSimilarity(
  vector: readonly number[],
  centroids: readonly (readonly number[])[],
): number {
  if (centroids.length === 0) return 0;
  const v = normalize(vector);
  let best = -1;
  for (const c of centroids) {
    let dot = 0;
    for (let d = 0; d < v.length; d++) dot += (v[d] ?? 0) * (c[d] ?? 0);
    if (dot > best) best = dot;
  }
  return best;
}

function normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const norm = Math.sqrt(sum);
  // The zero vector has no direction; leave it at the origin, where it is
  // equally far from everything instead of NaN-far.
  if (norm === 0) return [...vector];
  return vector.map((x) => x / norm);
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  let distance = 0;
  for (let d = 0; d < a.length; d++) {
    const diff = (a[d] ?? 0) - (b[d] ?? 0);
    distance += diff * diff;
  }
  return distance;
}

function nearestCentroid(vector: readonly number[], centroids: readonly number[][]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let c = 0; c < centroids.length; c++) {
    const centroid = centroids[c];
    if (!centroid) continue;
    const distance = squaredDistance(vector, centroid);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best;
}

/**
 * k-means++ seeding: the first centre is weight-sampled, each further centre is
 * sampled proportionally to weight × squared distance from the nearest chosen
 * centre. Spreads the seeds without the pathological starts uniform sampling
 * produces on clustered data.
 */
function plusPlusInit(
  points: readonly { vector: number[]; weight: number }[],
  k: number,
  rng: () => number,
): number[][] {
  const centroids: number[][] = [];
  const firstPick =
    points[
      sampleIndex(
        points.map((p) => p.weight),
        rng,
      )
    ];
  if (!firstPick) return centroids;
  centroids.push(firstPick.vector);

  while (centroids.length < k) {
    const scores = points.map((p) => {
      let nearest = Number.POSITIVE_INFINITY;
      for (const c of centroids) {
        const distance = squaredDistance(p.vector, c);
        if (distance < nearest) nearest = distance;
      }
      return p.weight * nearest;
    });
    // All remaining points coincide with a chosen centre; more centres would be duplicates.
    if (scores.every((s) => s === 0)) break;
    const pick = points[sampleIndex(scores, rng)];
    if (!pick) break;
    centroids.push(pick.vector);
  }
  return centroids;
}

function sampleIndex(weights: readonly number[], rng: () => number): number {
  let total = 0;
  for (const w of weights) total += w;
  let target = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i] ?? 0;
    if (target <= 0) return i;
  }
  return weights.length - 1;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
