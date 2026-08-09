import { createHash } from "node:crypto";

import { canonicalUrl } from "./url.ts";

/** Hex SHA-256 of a string or byte buffer. */
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Fingerprint of a fetched response body.
 *
 * Conditional GET is the documented way to skip unchanged feeds, but a large
 * share of servers ignore If-None-Match / If-Modified-Since and return 200 with
 * the full body every time. CDNs make it worse by rewriting ETags. Hashing the
 * body is the only reliable "nothing changed here" signal, so it is the real
 * gate in front of parsing and writing.
 */
export function contentHash(body: string | Uint8Array): string {
  return sha256(body);
}

/**
 * Stable identity for a feed item.
 *
 * Derived from the canonicalised URL rather than the feed's own <guid>.
 * A surprising number of feeds emit a guid that changes on every fetch — view
 * counters, session ids, cache-busting suffixes — which makes every poll look
 * like a batch of brand new articles. The URL is the thing that actually
 * identifies the article.
 *
 * The guid is still worth storing alongside for debugging and for the rare feed
 * that reuses URLs, but it does not decide identity.
 *
 * Returns null when the URL cannot be canonicalised; the caller must then skip
 * the item rather than invent an id for it.
 */
export function itemIdentity(url: string): string | null {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;
  return sha256(canonical);
}
