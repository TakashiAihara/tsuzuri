import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDatabase, DEFAULT_USER_ID, migrate } from "@tsuzuri/db";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";

/**
 * The HTTP surface, driven through Hono's fetch rather than a live socket.
 *
 * Focused on the two things the endpoint layer decides for itself: which item
 * an abbreviated id refers to, and what a search says about its own
 * degradation. The ranking itself is tested in packages/db/src/search.test.ts.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("api", () => {
  let handle: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof createApi>;

  // Ids are 64 hex characters in production; these share a long prefix so the
  // ambiguity path is reachable.
  const idA = `abcdef01${"0".repeat(56)}`;
  const idB = `abcdef01${"1".repeat(56)}`;
  const idC = `beef1234${"2".repeat(56)}`;

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    for (const [id, title] of [
      [idA, "first"],
      [idB, "second"],
      [idC, "Rust 1.90 released"],
    ] as const) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${id}, ${`https://e.com/${id}`}, ${`https://e.com/${id}`}, ${title}, now(), ${title})
      `;
    }

    const config = loadConfig({ DATABASE_URL: DATABASE_URL as string });
    const embeddings = createEmbeddingService({ sql: handle.sql, config });
    await embeddings.start();
    app = createApi({ db: handle.db, sql: handle.sql, fetcher: fetch, config, embeddings });
  });

  afterAll(async () => {
    await handle?.close();
  });

  const get = (path: string) => app.fetch(new Request(`http://test${path}`));

  /** Response.json() is typed unknown, so tests say what they expect back. */
  async function json<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  describe("item id resolution", () => {
    test("accepts a full id", async () => {
      const response = await get(`/items/${idC}`);
      expect(response.status).toBe(200);
      expect((await json<{ item: { id: string } }>(response)).item.id).toBe(idC);
    });

    test("accepts the abbreviation the CLI prints", async () => {
      // `tsuzuri read` shows eight characters; before this, feeding one back to
      // `tsuzuri show` returned 404, so the two commands did not compose.
      const response = await get(`/items/${idC.slice(0, 8)}`);
      expect(response.status).toBe(200);
      expect((await json<{ item: { id: string } }>(response)).item.id).toBe(idC);
    });

    test("refuses an ambiguous prefix instead of guessing", async () => {
      // Picking whichever sorted first would show the wrong article, and
      // marking it read would hide the wrong one.
      const response = await get(`/items/${idA.slice(0, 8)}`);
      expect(response.status).toBe(400);
      expect((await json<{ error: string }>(response)).error).toMatch(/more than one/);
    });

    test("refuses an abbreviation shorter than the one displayed", async () => {
      const response = await get("/items/abc");
      expect(response.status).toBe(400);
    });

    test("a prefix matching nothing is not found", async () => {
      expect((await get("/items/ffffffff")).status).toBe(404);
    });

    test("non-hexadecimal input is not found rather than a query", async () => {
      expect((await get("/items/'; DROP TABLE items; --")).status).toBe(404);
    });

    test("state updates resolve the same way", async () => {
      const response = await app.fetch(
        new Request(`http://test/items/${idC.slice(0, 8)}/state`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ read: true }),
        }),
      );
      expect(response.status).toBe(200);
      expect((await json<{ state: { itemId: string } }>(response)).state.itemId).toBe(idC);
    });
  });

  describe("search", () => {
    test("reports text-only mode and why, with no model configured", async () => {
      // An empty list cannot distinguish "nothing matched" from "half the
      // search was switched off", so the response has to say.
      const body = await json<{ mode: string; reason: string; results: { id: string }[] }>(
        await get("/search?q=Rust"),
      );
      expect(body.mode).toBe("text-only");
      expect(body.reason).toMatch(/no embedding model is configured/);
      expect(body.results.map((r) => r.id)).toContain(idC);
    });

    test("rejects a since it cannot read rather than ignoring it", async () => {
      const response = await get("/search?q=Rust&since=last%20tuesday");
      expect(response.status).toBe(400);
    });

    test("accepts a duration", async () => {
      expect((await get("/search?q=Rust&since=7d")).status).toBe(200);
    });

    test("requires a query", async () => {
      expect((await get("/search")).status).toBe(400);
    });

    test("caps the limit", async () => {
      expect((await get("/search?q=Rust&limit=5000")).status).toBe(400);
    });
  });
});
