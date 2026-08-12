import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDatabase, DEFAULT_USER_ID, migrate } from "@tsuzuri/db";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";
import { createInterestService } from "./enrich/interest.ts";

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

    // Every stored item arrives through a subscription, and the listing joins
    // on that, so a fixture without one lists nothing.
    const [source] = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES (${DEFAULT_USER_ID}, 'feed', 'https://fixture.example/feed')
      RETURNING id
    `;
    for (const id of [idA, idB, idC]) {
      await handle.sql`
        INSERT INTO item_sources (item_id, source_id) VALUES (${id}, ${source?.id as string})
      `;
    }

    const config = loadConfig({ DATABASE_URL: DATABASE_URL as string });
    const embeddings = createEmbeddingService({ sql: handle.sql, config });
    await embeddings.start();
    const interest = createInterestService({ sql: handle.sql, config, embeddings });
    await interest.start();
    app = createApi({
      db: handle.db,
      sql: handle.sql,
      fetcher: fetch,
      config,
      embeddings,
      interest,
    });
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

    test("a full-length id that does not exist is 404, not a foreign key violation", async () => {
      // The state route inserts against this id, so trusting the length would
      // turn a missing article into a 500.
      const missing = `dead${"9".repeat(60)}`;
      expect((await get(`/items/${missing}`)).status).toBe(404);

      const response = await app.fetch(
        new Request(`http://test/items/${missing}/state`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ read: true }),
        }),
      );
      expect(response.status).toBe(404);
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

    test("rejects a query that is only whitespace", async () => {
      // It would otherwise reach searchTerms, produce no terms, and come back
      // as an empty result set indistinguishable from a real miss.
      expect((await get("/search?q=%20%20")).status).toBe(400);
    });

    test("caps the limit", async () => {
      expect((await get("/search?q=Rust&limit=5000")).status).toBe(400);
    });
  });

  describe("ranked listing", () => {
    type RankedBody = {
      items: Array<{ id: string; interest: number; exploration: boolean }>;
      scoring: { active: boolean; reason?: string; signals: number; required: number };
    };

    test("degrades to date order and says why, with scoring switched off", async () => {
      // Not an error: an install with scoring off is a supported configuration.
      // But the list cannot distinguish "off" from "no history yet" from "the
      // model does not match", so the response has to name which.
      const body = await json<RankedBody>(await get("/items?sort=score&unread=false"));
      expect(body.scoring.active).toBe(false);
      expect(body.scoring.reason).toBe("interest scoring is not enabled");
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((item) => item.interest === 0)).toBe(true);
      expect(body.items.every((item) => item.exploration === false)).toBe(true);
    });

    test("reports how far off activation is", async () => {
      const body = await json<RankedBody>(await get("/items?sort=score"));
      // "How much further do I have to go" is the question someone actually
      // has on day one, and it is answerable from these two numbers.
      expect(body.scoring.required).toBeGreaterThan(0);
      expect(body.scoring.signals).toBeGreaterThanOrEqual(0);
    });

    test("carries no scoring block when date order was asked for", async () => {
      const body = await json<{ items: unknown[]; scoring?: unknown }>(
        await get("/items?sort=recent"),
      );
      expect(body.scoring).toBeUndefined();
      expect(Array.isArray(body.items)).toBe(true);
    });

    test("rejects an ordering it does not have", async () => {
      expect((await get("/items?sort=whatever")).status).toBe(400);
    });
  });

  describe("interest profile", () => {
    test("refuses a rebuild while scoring is switched off, and says so", async () => {
      const response = await app.fetch(
        new Request("http://test/interest/rebuild", { method: "POST" }),
      );
      expect(response.status).toBe(400);
      expect((await json<{ error: string }>(response)).error).toMatch(/INTEREST_SCORING_ENABLED/);
    });

    test("reports its state rather than 404ing when it is off", async () => {
      const body = await json<{ enabled: boolean; active: boolean; builtAt: string | null }>(
        await get("/interest/status"),
      );
      expect(body.enabled).toBe(false);
      expect(body.active).toBe(false);
      expect(body.builtAt).toBeNull();
    });
  });
});
