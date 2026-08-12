export {
  type ParseFeedDateOptions,
  parseFeedDate,
  timeZoneOffsetMinutes,
  tryParseFeedDate,
} from "./date.ts";
export {
  createEmbeddingProvider,
  EmbeddingError,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
  embeddingInput,
  probeDimensions,
  toVectorLiteral,
} from "./embedding.ts";
export { contentHash, itemIdentity, sha256 } from "./hash.ts";
export {
  affinity,
  clusterCount,
  decayFactor,
  explorationSlots,
  interleaveExploration,
  type RecencyOptions,
  recencyFactor,
  type ScoringInactiveReason,
  type ScoringState,
  SIGNAL_WEIGHTS,
  type Signal,
  type SignalKind,
  signalStrength,
} from "./interest.ts";
export {
  dot,
  type KMeansInput,
  type KMeansResult,
  normalize,
  seededRandom,
  seedFrom,
  sphericalKMeans,
} from "./kmeans.ts";
export { type NormalizeOptions, normalizeItem } from "./normalize.ts";
export { RRF_K, reciprocalRankFusion, searchTerms } from "./search-query.ts";
export { snippetToText } from "./snippet.ts";
export {
  defineSource,
  type FetchState,
  type Source,
  type SourceContext,
} from "./source.ts";
export {
  type FetchResult,
  type NormalizedItem,
  type OpmlOutline,
  opmlOutlineSchema,
  type RawItem,
  rawItemSchema,
  type SourceKind,
  type SourceStatus,
  sourceKindSchema,
  sourceStatusSchema,
} from "./types.ts";
export { absolutizeHtml, canonicalUrl, resolveUrl } from "./url.ts";
