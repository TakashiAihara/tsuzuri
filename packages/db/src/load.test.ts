import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "./client.ts";
import {
  applyItemObject,
  forgetLoadedObjects,
  type LoadRow,
  loadedKeys,
  syncSourceFetchState,
} from "./load.ts";
import { migrate } from "./migrate.ts";

/**
 * The SQL half of the loader against a real PostgreSQL: one transaction per
 * storage object, and the loaded_objects ledger that makes loading repeatable.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const KEY = "items/dt=2026-11-08/20261108T000000Z-00000001.parquet";
const KEY_2 = "items/dt=2026-11-08/20261108T000001Z-00000002.parquet";
const FETCHED = new Date("2026-11-08T01:02:03.000Z");

describeIfDb("loader SQL", () => {
  let handle: ReturnType<typeof createDatabase>;

  const row = (id: string, overrides: Partial<LoadRow> = {}): LoadRow => ({
    id,
    url: `https://e.com/${id.slice(0, 4)}`,
    canonicalUrl: `https://e.com/${id.slice(0, 4)}`,
    title: "Title",
    author: null,
    guid: null,
    publishedAt: new Date("2026-11-07T00:00:00.000Z"),
    publishedAtEstimated: false,
    contentHtml: null,
    summary: null,
    searchText: "Title",
    fetchedAt: FETCHED,
    sourceId: "00000000-0000-0000-0000-00000000dead",
    ...overrides,
  });

  const seedSource = async (url: string, status = "active"): Promise<string> => {
    const [source] = await handle.sql<{ id: string }[]>`
      INSERT INTO sources (user_id, kind, url, status)
      VALUES ('00000000-0000-0000-0000-000000000001', 'feed', ${url}, ${status})
      RETURNING id
    `;
    return (source as { id: string }).id;
  };

  const count = async (table: "items" | "item_sources" | "loaded_objects"): Promise<number> => {
    const [result] = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${handle.sql(table)}
    `;
    return (result as { n: number }).n;
  };

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  beforeEach(async () => {
    await handle.sql`TRUNCATE items, sources, loaded_objects CASCADE`;
  });

  afterAll(async () => {
    await handle?.close();
  });

  test("loadedKeys is empty before anything is applied and lists applied keys after", async () => {
    expect([...(await loadedKeys(handle.sql))]).toEqual([]);

    await applyItemObject(handle.sql, KEY, [row(ID_A)]);

    expect([...(await loadedKeys(handle.sql))]).toEqual([KEY]);
  });

  test("applyItemObject stores the row's columns and records the object", async () => {
    const sourceId = await seedSource("https://e.com/feed.xml");

    const result = await applyItemObject(
      handle.sql,
      KEY,
      [
        row(ID_A, {
          title: "Hello",
          author: "Ann",
          guid: "g-1",
          contentHtml: "<p>body</p>",
          summary: "short",
          searchText: "Hello body",
          publishedAtEstimated: true,
          sourceId,
        }),
        row(ID_B, { sourceId }),
      ],
      3,
    );

    expect(result).toEqual({ inserted: 2, linked: 2 });

    const [stored] = await handle.sql`SELECT * FROM items WHERE id = ${ID_A}`;
    expect(stored?.title).toBe("Hello");
    expect(stored?.author).toBe("Ann");
    expect(stored?.guid).toBe("g-1");
    expect(stored?.content_html).toBe("<p>body</p>");
    expect(stored?.summary).toBe("short");
    expect(stored?.search_text).toBe("Hello body");
    expect(stored?.published_at_estimated).toBe(true);
    expect(stored?.published_at.toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(stored?.fetched_at.toISOString()).toBe("2026-11-08T01:02:03.000Z");

    const [ledger] = await handle.sql`SELECT key, rows, rejected FROM loaded_objects`;
    expect(ledger).toMatchObject({ key: KEY, rows: 2, rejected: 3 });
  });

  test("rejected defaults to 0 in the ledger", async () => {
    await applyItemObject(handle.sql, KEY, [row(ID_A)]);

    const [ledger] = await handle.sql`SELECT rows, rejected FROM loaded_objects`;
    expect(ledger).toMatchObject({ rows: 1, rejected: 0 });
  });

  test("an item that already exists is left as it is and not counted", async () => {
    await applyItemObject(handle.sql, KEY, [row(ID_A, { title: "First" })]);

    const result = await applyItemObject(handle.sql, KEY_2, [
      row(ID_A, { title: "Second" }),
      row(ID_B),
    ]);

    expect(result).toEqual({ inserted: 1, linked: 0 });
    const [stored] = await handle.sql`SELECT title FROM items WHERE id = ${ID_A}`;
    expect(stored?.title).toBe("First");
  });

  test("links only to sources that exist, with first_seen_at taken from fetched_at", async () => {
    const sourceId = await seedSource("https://e.com/feed.xml");

    const result = await applyItemObject(handle.sql, KEY, [
      row(ID_A, { sourceId, fetchedAt: new Date("2026-11-08T05:00:00.000Z") }),
      row(ID_B),
    ]);

    expect(result).toEqual({ inserted: 2, linked: 1 });
    const links = await handle.sql`SELECT item_id, source_id, first_seen_at FROM item_sources`;
    expect(links).toHaveLength(1);
    expect(links[0]?.item_id).toBe(ID_A);
    expect(links[0]?.source_id).toBe(sourceId);
    expect(links[0]?.first_seen_at.toISOString()).toBe("2026-11-08T05:00:00.000Z");
  });

  test("a link that already exists is not duplicated or counted again", async () => {
    const sourceId = await seedSource("https://e.com/feed.xml");
    await applyItemObject(handle.sql, KEY, [
      row(ID_A, { sourceId, fetchedAt: new Date("2026-11-08T05:00:00.000Z") }),
    ]);

    const result = await applyItemObject(handle.sql, KEY_2, [
      row(ID_A, { sourceId, fetchedAt: new Date("2026-11-08T09:00:00.000Z") }),
    ]);

    expect(result).toEqual({ inserted: 0, linked: 0 });
    const links = await handle.sql`SELECT first_seen_at FROM item_sources`;
    expect(links).toHaveLength(1);
    expect(links[0]?.first_seen_at.toISOString()).toBe("2026-11-08T05:00:00.000Z");
  });

  test("a row that fails the insert commits nothing of the object", async () => {
    const sourceId = await seedSource("https://e.com/feed.xml");

    // PostgreSQL refuses NUL in text, which no earlier validation would catch.
    await expect(
      applyItemObject(handle.sql, KEY, [
        row(ID_A, { sourceId }),
        row(ID_B, { sourceId, title: "bad\u0000title" }),
      ]),
    ).rejects.toThrow();

    expect(await count("items")).toBe(0);
    expect(await count("item_sources")).toBe(0);
    expect(await count("loaded_objects")).toBe(0);
    expect([...(await loadedKeys(handle.sql))]).toEqual([]);
  });

  test("applying a key that is already recorded fails and leaves its new rows out", async () => {
    await applyItemObject(handle.sql, KEY, [row(ID_A)]);

    await expect(applyItemObject(handle.sql, KEY, [row(ID_B)])).rejects.toThrow();

    const ids = await handle.sql<{ id: string }[]>`SELECT id FROM items`;
    expect(ids.map((r) => r.id)).toEqual([ID_A]);
  });

  test("an empty object is still recorded", async () => {
    const result = await applyItemObject(handle.sql, KEY, []);

    expect(result).toEqual({ inserted: 0, linked: 0 });
    const [ledger] = await handle.sql`SELECT rows FROM loaded_objects WHERE key = ${KEY}`;
    expect(ledger?.rows).toBe(0);
  });

  test("forgetLoadedObjects empties the ledger and keeps the items", async () => {
    await applyItemObject(handle.sql, KEY, [row(ID_A)]);
    await applyItemObject(handle.sql, KEY_2, [row(ID_B)]);

    await forgetLoadedObjects(handle.sql);

    expect(await count("loaded_objects")).toBe(0);
    expect(await count("items")).toBe(2);
  });

  test("the ledger enforces non-negative counts", async () => {
    await expect(
      handle.sql`INSERT INTO loaded_objects (key, rows) VALUES ('k1', -1)`,
    ).rejects.toThrow();
    await expect(
      handle.sql`INSERT INTO loaded_objects (key, rows, rejected) VALUES ('k2', 0, -1)`,
    ).rejects.toThrow();
  });

  describe("syncSourceFetchState", () => {
    const state = {
      etag: '"abc"',
      lastModified: "Sun, 08 Nov 2026 00:00:00 GMT",
      contentHash: "hash-1",
      nextFetchAt: "2026-11-09T00:00:00.000Z",
      lastFetchedAt: "2026-11-08T12:00:00.000Z",
      lastSuccessAt: "2026-11-08T11:00:00.000Z",
      consecutiveFailures: 3,
      lastError: "timeout",
      status: "degraded" as const,
    };

    test("copies the fetch state onto an existing source", async () => {
      const sourceId = await seedSource("https://e.com/feed.xml");

      const updated = await syncSourceFetchState(handle.sql, { [sourceId]: state });

      expect(updated).toBe(1);
      const [source] = await handle.sql`SELECT * FROM sources WHERE id = ${sourceId}`;
      expect(source?.etag).toBe('"abc"');
      expect(source?.last_modified).toBe("Sun, 08 Nov 2026 00:00:00 GMT");
      expect(source?.content_hash).toBe("hash-1");
      expect(source?.next_fetch_at.toISOString()).toBe("2026-11-09T00:00:00.000Z");
      expect(source?.last_fetched_at.toISOString()).toBe("2026-11-08T12:00:00.000Z");
      expect(source?.last_success_at.toISOString()).toBe("2026-11-08T11:00:00.000Z");
      expect(source?.consecutive_failures).toBe(3);
      expect(source?.last_error).toBe("timeout");
      expect(source?.status).toBe("degraded");
    });

    test("writes nulls through", async () => {
      const sourceId = await seedSource("https://e.com/feed.xml");
      await syncSourceFetchState(handle.sql, { [sourceId]: state });

      await syncSourceFetchState(handle.sql, {
        [sourceId]: {
          ...state,
          etag: null,
          lastModified: null,
          contentHash: null,
          lastFetchedAt: null,
          lastSuccessAt: null,
          lastError: null,
          consecutiveFailures: 0,
          status: "active",
        },
      });

      const [source] = await handle.sql`SELECT * FROM sources WHERE id = ${sourceId}`;
      expect(source?.etag).toBeNull();
      expect(source?.last_fetched_at).toBeNull();
      expect(source?.last_error).toBeNull();
      expect(source?.consecutive_failures).toBe(0);
      expect(source?.status).toBe("active");
    });

    test("a disabled source keeps disabled but takes the other fields", async () => {
      const sourceId = await seedSource("https://e.com/off.xml", "disabled");

      const updated = await syncSourceFetchState(handle.sql, { [sourceId]: state });

      expect(updated).toBe(1);
      const [source] = await handle.sql`SELECT status, etag, consecutive_failures FROM sources`;
      expect(source).toMatchObject({ status: "disabled", etag: '"abc"', consecutive_failures: 3 });
    });

    test("ids that are not sources are ignored and not counted", async () => {
      const sourceId = await seedSource("https://e.com/feed.xml");

      const updated = await syncSourceFetchState(handle.sql, {
        "00000000-0000-0000-0000-00000000beef": state,
        [sourceId]: state,
      });

      expect(updated).toBe(1);
      expect(await syncSourceFetchState(handle.sql, {})).toBe(0);
    });

    test("an id that is not a uuid does not fail the batch", async () => {
      const sourceId = await seedSource("https://e.com/feed.xml");

      const updated = await syncSourceFetchState(handle.sql, {
        "not-a-uuid": state,
        [sourceId]: state,
      });

      expect(updated).toBe(1);
    });
  });
});
