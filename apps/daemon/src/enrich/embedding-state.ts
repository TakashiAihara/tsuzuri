import type { EmbeddingModelRow } from "@tsuzuri/db";

/**
 * What the daemon should do about embeddings on this boot.
 *
 * Split out as a pure function over two inputs so the decision can be tested
 * without a database or a provider. It is the part of the embedding feature
 * most likely to be got wrong, because three of its four states look like
 * "embeddings are off" from the outside and only one of them is a problem.
 */

export type ConfiguredModel = {
  provider: string;
  model: string;
};

export type EmbeddingState =
  /** No provider configured. The normal state, and not an error. */
  | { status: "disabled" }
  /** Configured, but nothing has been embedded here yet: probe and initialise. */
  | { status: "uninitialised"; configured: ConfiguredModel }
  /** Configured and matching what is stored. */
  | { status: "ready"; configured: ConfiguredModel; dimensions: number }
  /** Configured, but the stored vectors belong to a different model. */
  | { status: "mismatch"; configured: ConfiguredModel; stored: EmbeddingModelRow };

/**
 * Decide from the configured model and the recorded one.
 *
 * The mismatch case is the reason this exists. Vectors on disk belong to
 * whichever model produced them, and a query embedded by a different model
 * lands in an unrelated space, so the distances between them are not merely
 * less accurate -- they are meaningless. Comparing them would return confident
 * nonsense, which is worse than returning nothing.
 *
 * Note that a matching provider and model is enough; the stored dimension is
 * carried forward rather than checked against configuration. The dimension is
 * whatever the model actually produced when it was probed, and configuration
 * does not get a vote on that.
 */
export function decideEmbeddingState(
  configured: ConfiguredModel | null,
  stored: EmbeddingModelRow | null,
): EmbeddingState {
  if (!configured) return { status: "disabled" };
  if (!stored) return { status: "uninitialised", configured };

  if (stored.provider === configured.provider && stored.model === configured.model) {
    return { status: "ready", configured, dimensions: stored.dimensions };
  }

  return { status: "mismatch", configured, stored };
}

/** Human-readable explanation of a mismatch, for doctor and for the log. */
export function describeMismatch(state: Extract<EmbeddingState, { status: "mismatch" }>): string {
  return (
    `configured embedding model is ${state.configured.provider}/${state.configured.model}, ` +
    `but ${state.stored.dimensions}-dimensional vectors from ${state.stored.provider}/${state.stored.model} ` +
    "are stored. Vector search is disabled until the two agree. " +
    `Run: tsuzuri reindex --embedding-model ${state.configured.model}`
  );
}
