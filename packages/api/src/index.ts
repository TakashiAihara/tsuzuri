import { z } from "zod";

/**
 * The daemon's JSON API, as a contract both sides can see.
 *
 * The CLI and the MCP server are HTTP clients with no dependency on the daemon
 * package, which is worth keeping — they should not be able to reach past the
 * API. What that cost, until this package existed, was that each of them
 * declared its own copy of every response shape, and nothing failed to compile
 * when the daemon changed one. The copies had already drifted: the CLI typed
 * `state` as a bare string where the daemon has a union.
 *
 * Shared types alone would not fix that. They would be a third declaration,
 * free to drift from the handlers in the same way. What makes this hold is
 * api.contract.test.ts, which drives the real daemon and parses its real
 * responses through these schemas — so a handler that stops matching fails a
 * test rather than a client at runtime.
 *
 * Schemas rather than types because the checking has to happen at runtime to be
 * worth anything; the types are inferred from them.
 *
 * Closed shapes use strictObject, not object. Zod's object() strips unknown
 * keys and succeeds, so the contract test would catch a field that disappeared
 * and miss one that appeared -- including a handler that started returning an
 * article's body in a listing, which is the one thing the MCP surface promises
 * not to do. Genuinely open values (a source's config, an error payload, ingest
 * outcomes) stay permissive on purpose.
 */

export const sourceStatusSchema = z.enum(["active", "degraded", "unsupported", "disabled"]);

/** One subscription, as the API renders it. */
export const sourceSchema = z.strictObject({
  id: z.string(),
  userId: z.string(),
  kind: z.enum(["feed", "external", "rule", "plugin"]),
  url: z.string(),
  title: z.string().nullable(),
  siteUrl: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  status: sourceStatusSchema,
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  contentHash: z.string().nullable(),
  fetchIntervalSeconds: z.number(),
  nextFetchAt: z.string(),
  lastFetchedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

/** An item in a listing: no body, because listings are read in bulk. */
export const itemSummarySchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.string(),
  publishedAtEstimated: z.boolean(),
  summary: z.string().nullable(),
  readAt: z.string().nullable(),
  starredAt: z.string().nullable(),
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

/** One article in full. */
export const itemSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  guid: z.string().nullable(),
  publishedAt: z.string(),
  publishedAtEstimated: z.boolean(),
  contentHtml: z.string().nullable(),
  summary: z.string().nullable(),
  searchText: z.string(),
  rawHtmlKey: z.string().nullable(),
  fetchedAt: z.string(),
  createdAt: z.string(),
});
export type Item = z.infer<typeof itemSchema>;

export const itemStateSchema = z.strictObject({
  userId: z.string(),
  itemId: z.string(),
  readAt: z.string().nullable(),
  starredAt: z.string().nullable(),
  skippedAt: z.string().nullable(),
  savedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type ItemState = z.infer<typeof itemStateSchema>;

/**
 * One search hit.
 *
 * Carries both arms' ranks rather than only the fused score: ranking is the
 * part of search most likely to be wrong, and a number with no provenance
 * cannot be tuned. `vectorRank` is null when the vector arm did not run or did
 * not reach this item.
 */
export const searchHitSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  publishedAt: z.string(),
  summary: z.string().nullable(),
  snippet: z.string().nullable(),
  rrf: z.number(),
  textRank: z.number().nullable(),
  vectorRank: z.number().nullable(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * `mode` says whether the vector arm ran, and `reason` says why not.
 *
 * An empty result set cannot distinguish "nothing matched" from "half the
 * search was switched off", so the response says which.
 */
export const searchResponseSchema = z.strictObject({
  mode: z.enum(["hybrid", "text-only"]),
  reason: z.string().optional(),
  results: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const embeddingCountsSchema = z.strictObject({
  total: z.number(),
  embedded: z.number(),
  pending: z.number(),
  failed: z.number(),
});

export const embeddingStatusSchema = z.strictObject({
  state: z.enum(["disabled", "uninitialised", "ready", "mismatch"]),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  dimensions: z.number().nullable(),
  message: z.string().optional(),
  indexBuilt: z.boolean(),
  reindexing: z.boolean(),
  lastReindexError: z.string().nullable(),
  counts: embeddingCountsSchema,
});
export type EmbeddingStatus = z.infer<typeof embeddingStatusSchema>;

/**
 * Why a listing came back in date order rather than ranked.
 *
 * Scoring switched off, no embedding model, a model mismatch, too little
 * history and a profile that has not been built yet all produce the same list,
 * so the list cannot say which happened. Same argument as `mode` and `reason`
 * on a search response, and the same shape.
 */
export const scoringStateSchema = z.union([
  z.strictObject({
    active: z.literal(true),
    signals: z.number(),
    required: z.number(),
    clusters: z.number(),
  }),
  z.strictObject({
    active: z.literal(false),
    reason: z.string(),
    signals: z.number(),
    required: z.number(),
  }),
]);
export type ScoringState = z.infer<typeof scoringStateSchema>;

/**
 * An item in a ranked listing.
 *
 * `interest` is the fused score and `exploration` marks a row the score did not
 * choose. The flag is not decoration: without it, an item that ranking did not
 * pick is indistinguishable from a ranking bug.
 */
export const rankedItemSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.string(),
  publishedAtEstimated: z.boolean(),
  summary: z.string().nullable(),
  readAt: z.string().nullable(),
  starredAt: z.string().nullable(),
  interest: z.number(),
  affinitySimilarity: z.number(),
  exploration: z.boolean(),
});
export type RankedItem = z.infer<typeof rankedItemSchema>;

/**
 * Written out as two closed shapes rather than an intersection with
 * `scoringStateSchema`. Intersecting a strictObject with anything rejects every
 * key the other side adds, so the strictness that catches a field appearing --
 * the reason these schemas are closed at all -- would have had to be given up.
 */
export const interestStatusSchema = z.union([
  z.strictObject({
    enabled: z.boolean(),
    builtAt: z.string().nullable(),
    active: z.literal(true),
    signals: z.number(),
    required: z.number(),
    clusters: z.number(),
  }),
  z.strictObject({
    enabled: z.boolean(),
    builtAt: z.string().nullable(),
    active: z.literal(false),
    reason: z.string(),
    signals: z.number(),
    required: z.number(),
  }),
]);
export type InterestStatus = z.infer<typeof interestStatusSchema>;

export const rebuildInterestResponseSchema = z.strictObject({
  clusters: z.number(),
  signals: z.number(),
});

export const sourcesResponseSchema = z.strictObject({ sources: z.array(sourceSchema) });
export const sourceResponseSchema = z.strictObject({ source: sourceSchema });
export const itemsResponseSchema = z.strictObject({ items: z.array(itemSummarySchema) });
/**
 * A ranked listing.
 *
 * A separate shape from `itemsResponseSchema` rather than optional fields on
 * it. A caller asking for date order gets no score, and a score that is
 * sometimes absent would have to be defended at every use.
 */
export const rankedItemsResponseSchema = z.strictObject({
  items: z.array(rankedItemSchema),
  scoring: scoringStateSchema,
});
export const itemResponseSchema = z.strictObject({ item: itemSchema });
export const itemStateResponseSchema = z.strictObject({ state: itemStateSchema });

export const importOpmlResponseSchema = z.strictObject({
  imported: z.number(),
  skipped: z.number(),
  sources: z.array(z.strictObject({ id: z.string(), url: z.string() })),
});

export const ingestRunResponseSchema = z.strictObject({
  polled: z.number(),
  inserted: z.number(),
  failed: z.number(),
  outcomes: z.array(z.unknown()),
});

/** Every error the API returns has this shape, whatever the status. */
export const errorResponseSchema = z.strictObject({ error: z.unknown() });

export type ItemStatePatch = {
  read?: boolean;
  starred?: boolean;
  skipped?: boolean;
};
