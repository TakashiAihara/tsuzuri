import { describe, expect, test } from "bun:test";

import { ITEM_SCHEMA, ITEM_SCHEMA_VERSION, type ItemRow } from "./items.ts";
import { readParquet, writeParquet } from "./parquet.ts";

describe("ITEM_SCHEMA", () => {
  test("declares the public columns in order with their types", () => {
    expect(Object.entries(ITEM_SCHEMA)).toEqual([
      ["id", "STRING"],
      ["url", "STRING"],
      ["canonical_url", "STRING"],
      ["title", "STRING"],
      ["author", "STRING"],
      ["guid", "STRING"],
      ["published_at", "TIMESTAMP"],
      ["published_at_estimated", "BOOLEAN"],
      ["content_html", "STRING"],
      ["summary", "STRING"],
      ["fetched_at", "TIMESTAMP"],
      ["source_id", "STRING"],
      ["schema_version", "INT32"],
      ["raw", "STRING"],
    ]);
  });

  test("schema version is 1", () => {
    expect(ITEM_SCHEMA_VERSION).toBe(1);
  });
});

describe("ItemRow", () => {
  test("a full row round-trips through Parquet unchanged", async () => {
    const row: ItemRow = {
      id: "75aa39e4",
      url: "https://example.com/posts/a",
      canonical_url: "https://example.com/posts/a",
      title: "日本語のタイトル",
      author: "Ada",
      guid: "g-1",
      published_at: new Date("2026-08-09T03:04:05.000Z"),
      published_at_estimated: false,
      content_html: "<p>body</p>",
      summary: "Teaser",
      fetched_at: new Date("2026-11-08T12:34:56.000Z"),
      source_id: "feed-a",
      schema_version: 1,
      raw: '{"url":"https://example.com/posts/a"}',
    };
    expect(await readParquet(writeParquet([row], ITEM_SCHEMA))).toEqual([row]);
  });

  test("the nullable columns round-trip as null", async () => {
    const row: ItemRow = {
      id: "c39a8839",
      url: "https://example.com/posts/b",
      canonical_url: "https://example.com/posts/b",
      title: null,
      author: null,
      guid: null,
      published_at: new Date("2026-11-08T12:34:56.000Z"),
      published_at_estimated: true,
      content_html: null,
      summary: null,
      fetched_at: new Date("2026-11-08T12:34:56.000Z"),
      source_id: "feed-a",
      schema_version: 1,
      raw: null,
    };
    expect(await readParquet(writeParquet([row], ITEM_SCHEMA))).toEqual([row]);
  });
});
