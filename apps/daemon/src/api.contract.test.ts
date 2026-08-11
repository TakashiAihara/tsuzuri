import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  embeddingStatusSchema,
  errorResponseSchema,
  importOpmlResponseSchema,
  ingestRunResponseSchema,
  itemResponseSchema,
  itemStateResponseSchema,
  itemsResponseSchema,
  searchResponseSchema,
  sourcesResponseSchema,
} from "@tsuzuri/api";
import { createDatabase, DEFAULT_USER_ID, migrate } from "@tsuzuri/db";
import type { z } from "zod";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";

/**
 * The daemon's real responses, parsed through the shared contract.
 *
 * This is what stops @tsuzuri/api from becoming a third declaration that drifts
 * alongside the two it replaced. Shared types on their own would not: the CLI
 * and the MCP server would compile against them happily while a handler
 * returned something else. Here the handler runs, and its actual output has to
 * satisfy the schema clients were written against.
 *
 * Strict parsing throughout, so a field the daemon stopped sending fails as
 * loudly as one that changed type.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("api contract", () => {
  let handle: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof createApi>;

  const ITEM_ID = `c0ffee11${"2".repeat(56)}`;

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    await handle.sql`
      INSERT INTO sources (id, user_id, kind, url, title)
      VALUES ('11111111-1111-1111-1111-111111111111', ${DEFAULT_USER_ID}, 'feed',
              'https://a.example/feed', 'A')
    `;
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text, content_html)
      VALUES (${ITEM_ID}, 'https://e.com/a', 'https://e.com/a', 'Rust 1.90 released',
              now(), 'Rust 1.90 released. The borrow checker changed.', '<p>body</p>')
    `;
    await handle.sql`
      INSERT INTO item_sources (item_id, source_id)
      VALUES (${ITEM_ID}, '11111111-1111-1111-1111-111111111111')
    `;

    const config = loadConfig({ DATABASE_URL: DATABASE_URL as string });
    const embeddings = createEmbeddingService({ sql: handle.sql, config });
    await embeddings.start();
    app = createApi({ db: handle.db, sql: handle.sql, fetcher: fetch, config, embeddings });
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function parsed<T extends z.ZodTypeAny>(
    schema: T,
    path: string,
    init?: RequestInit,
  ): Promise<z.infer<T>> {
    const response = await app.fetch(new Request(`http://test${path}`, init));
    const body: unknown = await response.json();
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new Error(
        `${path} did not match its contract:\n${JSON.stringify(result.error.issues, null, 2)}\n` +
          `body was:\n${JSON.stringify(body, null, 2)}`,
      );
    }
    return result.data;
  }

  test("GET /sources", async () => {
    const body = await parsed(sourcesResponseSchema, "/sources");
    expect(body.sources).toHaveLength(1);
  });

  test("GET /items", async () => {
    const body = await parsed(itemsResponseSchema, "/items?unread=false");
    expect(body.items).toHaveLength(1);
  });

  test("GET /items/:id", async () => {
    const body = await parsed(itemResponseSchema, `/items/${ITEM_ID}`);
    expect(body.item.id).toBe(ITEM_ID);
  });

  test("POST /items/:id/state", async () => {
    const body = await parsed(itemStateResponseSchema, `/items/${ITEM_ID}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    expect(body.state.readAt).not.toBeNull();
  });

  test("GET /search", async () => {
    const body = await parsed(searchResponseSchema, "/search?q=Rust");
    expect(body.mode).toBe("text-only");
    expect(body.results[0]?.id).toBe(ITEM_ID);
  });

  test("GET /embeddings/status", async () => {
    const body = await parsed(embeddingStatusSchema, "/embeddings/status");
    expect(body.state).toBe("disabled");
  });

  test("POST /ingest/run", async () => {
    // Nothing is due, so this polls nothing and still has to answer in shape.
    await parsed(ingestRunResponseSchema, "/ingest/run", { method: "POST" });
  });

  test("POST /sources/import-opml", async () => {
    await parsed(importOpmlResponseSchema, "/sources/import-opml", {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: "<opml><body></body></opml>",
    });
  });

  describe("errors", () => {
    // Clients branch on these as much as on success bodies.
    const cases: { name: string; path: string; init?: RequestInit }[] = [
      { name: "unknown item", path: "/items/ffffffffffffffff" },
      { name: "ambiguous id", path: "/items/abc" },
      { name: "missing query", path: "/search" },
      { name: "unreadable since", path: "/search?q=x&since=whenever" },
      {
        name: "refused subscription",
        path: "/sources",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1/feed" }),
        },
      },
    ];

    for (const { name, path, init } of cases) {
      test(name, async () => {
        const response = await app.fetch(new Request(`http://test${path}`, init));
        expect(response.ok).toBe(false);
        expect(errorResponseSchema.safeParse(await response.json()).success).toBe(true);
      });
    }
  });
});
