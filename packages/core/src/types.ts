import { z } from "zod";

/**
 * How a source produces items.
 *
 * The core pipeline never branches on this beyond picking an implementation:
 * everything downstream sees normalised items. Adding a kind must not require
 * changes outside the source layer.
 */
export const sourceKindSchema = z.enum([
  /** A real RSS / Atom / JSON Feed document. */
  "feed",
  /** An external feed-generation service (RSSHub, RSS-Bridge, …). */
  "external",
  /** A declarative YAML extraction rule. */
  "rule",
  /** A TypeScript plugin shipped in-repo or installed locally. */
  "plugin",
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/**
 * Whether a source is currently producing items.
 *
 * "degraded" means it is failing but we keep trying; "disabled" means we do not
 * poll it at all. A source whose only fetch mode is unavailable (for example a
 * headless rule with no browser worker running) lands in "unsupported" rather
 * than looking like a failure, because nothing is broken — a component is
 * simply not installed.
 */
export const sourceStatusSchema = z.enum(["active", "degraded", "unsupported", "disabled"]);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/** An item as produced by a source, before the pipeline assigns identity. */
export const rawItemSchema = z.object({
  url: z.string(),
  title: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  /** Publisher-supplied id. Recorded, but not used for deduplication. */
  guid: z.string().nullable().default(null),
  /** Unparsed timestamp exactly as the source gave it. */
  publishedAtRaw: z.string().nullable().default(null),
  /** Article body as HTML, if the source carries one. */
  contentHtml: z.string().nullable().default(null),
  /** Short teaser, if distinct from the body. */
  summary: z.string().nullable().default(null),
});
export type RawItem = z.infer<typeof rawItemSchema>;

/** An item after normalisation, ready to be stored. */
export type NormalizedItem = {
  /** SHA-256 of the canonical URL. */
  id: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  author: string | null;
  guid: string | null;
  publishedAt: Date;
  /** True when publishedAt came from fetch time because the source had no usable date. */
  publishedAtEstimated: boolean;
  contentHtml: string | null;
  summary: string | null;
};

/** Outcome of polling one source. */
export type FetchResult =
  | { status: "unchanged"; reason: "not-modified" | "same-content-hash" }
  | {
      status: "fetched";
      items: RawItem[];
      contentHash: string;
      etag?: string;
      lastModified?: string;
    }
  | { status: "failed"; error: string; retryable: boolean };

export const opmlOutlineSchema = z.object({
  title: z.string().nullable(),
  xmlUrl: z.string(),
  htmlUrl: z.string().nullable(),
});
export type OpmlOutline = z.infer<typeof opmlOutlineSchema>;
