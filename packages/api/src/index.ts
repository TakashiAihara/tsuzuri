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
 */

export const sourceStatusSchema = z.enum(["active", "degraded", "unsupported", "disabled"]);

/** One subscription, as the API renders it. */
export const sourceSchema = z.object({
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
export const itemSummarySchema = z.object({
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
export const itemSchema = z.object({
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

export const itemStateSchema = z.object({
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
export const searchHitSchema = z.object({
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
export const searchResponseSchema = z.object({
  mode: z.enum(["hybrid", "text-only"]),
  reason: z.string().optional(),
  results: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const embeddingCountsSchema = z.object({
  total: z.number(),
  embedded: z.number(),
  pending: z.number(),
  failed: z.number(),
});

export const embeddingStatusSchema = z.object({
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

export const sourcesResponseSchema = z.object({ sources: z.array(sourceSchema) });
export const sourceResponseSchema = z.object({ source: sourceSchema });
export const itemsResponseSchema = z.object({ items: z.array(itemSummarySchema) });
export const itemResponseSchema = z.object({ item: itemSchema });
export const itemStateResponseSchema = z.object({ state: itemStateSchema });

export const importOpmlResponseSchema = z.object({
  imported: z.number(),
  skipped: z.number(),
  sources: z.array(z.object({ id: z.string(), url: z.string() })),
});

export const ingestRunResponseSchema = z.object({
  polled: z.number(),
  inserted: z.number(),
  failed: z.number(),
  outcomes: z.array(z.unknown()),
});

/** Every error the API returns has this shape, whatever the status. */
export const errorResponseSchema = z.object({ error: z.unknown() });

export type ItemStatePatch = {
  read?: boolean;
  starred?: boolean;
  skipped?: boolean;
};
