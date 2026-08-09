import { parseFeedDate } from "./date.ts";
import { itemIdentity } from "./hash.ts";
import type { NormalizedItem, RawItem } from "./types.ts";
import { absolutizeHtml, canonicalUrl, resolveUrl } from "./url.ts";

export type NormalizeOptions = {
  /** Base URL for resolving relative links, usually the feed or page URL. */
  baseUrl: string;
  /** When this fetch happened. Used as the date fallback. */
  fetchedAt: Date;
  /** Offset applied to timestamps with no zone. See parseFeedDate. */
  assumeOffsetMinutes?: number;
};

/**
 * Turn a source's raw item into the shape the rest of the system stores.
 *
 * Returns null when the item has no usable URL. That is the one field we cannot
 * work around: without it there is no identity, no link to open, and no base
 * for the item's own relative links.
 */
export function normalizeItem(raw: RawItem, options: NormalizeOptions): NormalizedItem | null {
  const url = resolveUrl(raw.url, options.baseUrl);
  if (!url) return null;

  const canonical = canonicalUrl(url);
  const id = itemIdentity(url);
  if (!canonical || !id) return null;

  const parsedDate = raw.publishedAtRaw
    ? parseFeedDate(raw.publishedAtRaw, {
        now: options.fetchedAt,
        fallback: options.fetchedAt,
        assumeOffsetMinutes: options.assumeOffsetMinutes,
      })
    : options.fetchedAt;

  // Distinguish "the publisher told us when this was posted" from "we guessed".
  // Scoring and digests care about the difference: an estimated date should not
  // let a stale item masquerade as breaking news.
  const publishedAtEstimated =
    !raw.publishedAtRaw || parsedDate.getTime() === options.fetchedAt.getTime();

  return {
    id,
    url,
    canonicalUrl: canonical,
    title: cleanText(raw.title),
    author: cleanText(raw.author),
    guid: raw.guid?.trim() || null,
    publishedAt: parsedDate,
    publishedAtEstimated,
    contentHtml: raw.contentHtml ? absolutizeHtml(raw.contentHtml, url) : null,
    summary: cleanText(raw.summary),
  };
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed || null;
}
