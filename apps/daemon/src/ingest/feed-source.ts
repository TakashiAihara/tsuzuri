import { extractFromJson, extractFromXml } from "@extractus/feed-extractor";
import { contentHash, defineSource, type FetchResult, type RawItem } from "@tsuzuri/core";

import { decodeBody } from "./decode.ts";

/**
 * Builtin source for RSS, Atom and JSON Feed.
 *
 * The high-level `extract(url)` helper in feed-extractor is deliberately not
 * used. It owns the HTTP call, and this pipeline needs to own it instead: for
 * conditional GET, for the content hash that catches servers which ignore
 * conditional GET, for per-host rate limiting, and for encoding detection that
 * prefers the document's own declaration over the Content-Type header.
 */

const PARSER_OPTIONS = {
  normalization: true,
  // Keep the publisher's original date string. Our own parser applies the
  // sanity guards (no far-future dates, nothing before 2000) that a plain ISO
  // conversion would silently pass through.
  useISODateFormat: false,
  // Defaults to 250 characters, which truncates article bodies mid-sentence.
  descriptionMaxLen: 0,
} as const;

/** Pull a string out of the several shapes feed parsers produce for one field. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // fast-xml-parser puts element text under "#text" when the element also
    // carries attributes, which is the common case for <guid isPermaLink>.
    if ("#text" in record) return text(record["#text"]);
    if ("name" in record) return text(record.name);
    if ("@_href" in record) return text(record["@_href"]);
  }
  return null;
}

function firstText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Capture fields the normalised shape drops.
 *
 * Author, full content and the raw date all live under format-specific keys
 * (dc:creator vs author, content:encoded vs content, pubDate vs updated), and
 * losing them means every item shows up as an untitled excerpt with no byline.
 */
function getExtraEntryFields(entry: Record<string, unknown>) {
  return {
    _author: firstText(entry, ["dc:creator", "author", "creator"]),
    _content: firstText(entry, ["content:encoded", "content", "description", "summary"]),
    _guid: firstText(entry, ["guid", "id"]),
    _rawDate: firstText(entry, ["pubDate", "published", "updated", "dc:date", "date"]),
  };
}

function toRawItems(entries: unknown[]): RawItem[] {
  const items: RawItem[] = [];

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;

    const url = text(entry.link) ?? text(entry.url);
    // No URL means no identity and nothing to open. Skipping one entry beats
    // failing the whole feed.
    if (!url) continue;

    items.push({
      url,
      title: text(entry.title),
      author: (entry._author as string | null) ?? null,
      guid: (entry._guid as string | null) ?? text(entry.id),
      publishedAtRaw: (entry._rawDate as string | null) ?? text(entry.published),
      contentHtml: (entry._content as string | null) ?? null,
      summary: text(entry.description),
    });
  }

  return items;
}

function looksLikeJson(body: string, contentType: string | null): boolean {
  if (contentType?.includes("json")) return true;
  return body.trimStart().startsWith("{");
}

export const feedSource = defineSource({
  kind: "feed",
  id: "builtin:feed",

  async fetchItems(ctx): Promise<FetchResult> {
    const headers: Record<string, string> = {};
    if (ctx.state.etag) headers["If-None-Match"] = ctx.state.etag;
    if (ctx.state.lastModified) headers["If-Modified-Since"] = ctx.state.lastModified;

    let response: Response;
    try {
      response = await ctx.fetch(ctx.url, { headers, signal: ctx.signal });
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }

    if (response.status === 304) {
      return { status: "unchanged", reason: "not-modified" };
    }

    if (!response.ok) {
      return {
        status: "failed",
        error: `HTTP ${response.status}`,
        // 4xx other than rate limiting means the subscription itself is wrong;
        // retrying on a schedule will not fix a 404.
        retryable: response.status >= 500 || response.status === 429,
      };
    }

    const body = new Uint8Array(await response.arrayBuffer());
    const hash = contentHash(body);

    // The real change gate. A large share of servers ignore If-None-Match and
    // return 200 with a byte-identical body forever; CDNs rewrite ETags so the
    // conditional request stops matching at all.
    if (ctx.state.contentHash && ctx.state.contentHash === hash) {
      return { status: "unchanged", reason: "same-content-hash" };
    }

    const contentType = response.headers.get("content-type");
    const { text: decoded } = decodeBody(body, contentType);

    let entries: unknown[];
    try {
      const feed = looksLikeJson(decoded, contentType)
        ? extractFromJson(decoded, { ...PARSER_OPTIONS, getExtraEntryFields })
        : extractFromXml(decoded, { ...PARSER_OPTIONS, getExtraEntryFields });
      entries = feed?.entries ?? [];
    } catch (error) {
      return {
        status: "failed",
        error: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
        // A malformed document will stay malformed until the publisher fixes
        // it, but publishers do fix it, so keep polling on the normal schedule.
        retryable: true,
      };
    }

    const result: FetchResult = {
      status: "fetched",
      items: toRawItems(entries),
      contentHash: hash,
    };
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) result.etag = etag;
    if (lastModified) result.lastModified = lastModified;
    return result;
  },
});
