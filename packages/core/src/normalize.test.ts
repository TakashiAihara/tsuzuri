import { describe, expect, test } from "bun:test";

import { itemIdentity } from "./hash.ts";
import { normalizeItem } from "./normalize.ts";
import type { RawItem } from "./types.ts";

const FETCHED_AT = new Date("2026-08-09T12:00:00Z");
const OPTIONS = { baseUrl: "https://example.com/feed.xml", fetchedAt: FETCHED_AT };

function raw(overrides: Partial<RawItem> = {}): RawItem {
  return {
    url: "/posts/hello",
    title: "Hello",
    author: null,
    guid: null,
    publishedAtRaw: "2026-08-09T03:04:05Z",
    contentHtml: null,
    summary: null,
    ...overrides,
  };
}

describe("normalizeItem", () => {
  test("resolves the URL and derives identity from it", () => {
    const item = normalizeItem(raw(), OPTIONS);
    const expectedId = itemIdentity("https://example.com/posts/hello");
    expect(expectedId).not.toBeNull();
    expect(item?.url).toBe("https://example.com/posts/hello");
    expect(item?.id).toBe(expectedId ?? "");
  });

  test("gives one identity to items that differ only by tracking parameters", () => {
    const a = normalizeItem(raw({ url: "/posts/hello?utm_source=rss" }), OPTIONS);
    const b = normalizeItem(raw({ url: "/posts/hello/" }), OPTIONS);
    expect(a?.id).toBe(b?.id as string);
  });

  test("ignores a guid that changes between fetches", () => {
    // Feeds that append a counter or session id to <guid> would otherwise make
    // every poll look like a fresh batch of articles.
    const first = normalizeItem(raw({ guid: "https://example.com/posts/hello?count=1" }), OPTIONS);
    const second = normalizeItem(raw({ guid: "https://example.com/posts/hello?count=2" }), OPTIONS);
    expect(first?.id).toBe(second?.id as string);
    expect(first?.guid).toBe("https://example.com/posts/hello?count=1");
  });

  test("marks the date as estimated when the source had none", () => {
    const item = normalizeItem(raw({ publishedAtRaw: null }), OPTIONS);
    expect(item?.publishedAt).toEqual(FETCHED_AT);
    expect(item?.publishedAtEstimated).toBe(true);
  });

  test("marks the date as estimated when the source date was implausible", () => {
    const item = normalizeItem(raw({ publishedAtRaw: "1970-01-01T00:00:00Z" }), OPTIONS);
    expect(item?.publishedAt).toEqual(FETCHED_AT);
    expect(item?.publishedAtEstimated).toBe(true);
  });

  test("keeps a real publisher date and does not mark it estimated", () => {
    const item = normalizeItem(raw(), OPTIONS);
    expect(item?.publishedAt.toISOString()).toBe("2026-08-09T03:04:05.000Z");
    expect(item?.publishedAtEstimated).toBe(false);
  });

  test("absolutises links inside the article body against the item URL", () => {
    const item = normalizeItem(raw({ contentHtml: '<img src="a.png">' }), OPTIONS);
    expect(item?.contentHtml).toBe('<img src="https://example.com/posts/a.png">');
  });

  test("collapses whitespace in text fields", () => {
    const item = normalizeItem(raw({ title: "  Hello\n\n  world  " }), OPTIONS);
    expect(item?.title).toBe("Hello world");
  });

  test("returns null when the item has no usable URL", () => {
    expect(normalizeItem(raw({ url: "javascript:void(0)" }), OPTIONS)).toBeNull();
    expect(normalizeItem(raw({ url: "" }), OPTIONS)).toBeNull();
  });
});
