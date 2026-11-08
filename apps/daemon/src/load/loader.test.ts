import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "@tsuzuri/db";
import { fileStorage, ITEM_SCHEMA, type Storage, writeParquet } from "@tsuzuri/store";

import { createLoader } from "./loader.ts";

/**
 * The loader against a real PostgreSQL and a real file store: what it applies,
 * in which order, what it refuses, and that running it again changes nothing.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_C = "c".repeat(64);
const KEY_1 = "items/dt=2026-11-08/20261108T000001Z-00000001.parquet";
const KEY_2 = "items/dt=2026-11-08/20261108T000002Z-00000002.parquet";
const KEY_3 = "items/dt=2026-11-09/20261109T000000Z-00000003.parquet";
const T1 = new Date("2026-11-08T01:00:00.000Z");
const T2 = new Date("2026-11-08T02:00:00.000Z");
const USER = "00000000-0000-0000-0000-000000000001";

describeIfDb("loader", () => {
  let handle: ReturnType<typeof createDatabase>;
  let dir: string;
  let storage: Storage;
  let logs: string[];
  let sourceId: string;

  const itemRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    url: `https://e.com/${id.slice(0, 4)}`,
    canonical_url: `https://e.com/${id.slice(0, 4)}`,
    title: "Title",
    published_at: new Date("2026-11-07T00:00:00.000Z"),
    published_at_estimated: false,
    fetched_at: T1,
    source_id: sourceId,
    schema_version: 1,
    ...overrides,
  });

  const put = (key: string, rows: Record<string, unknown>[]) =>
    storage.put(key, writeParquet(rows, ITEM_SCHEMA));

  const loader = (s: Storage = storage) =>
    createLoader({ sql: handle.sql, storage: s, log: (m) => logs.push(m) });

  const titles = async (): Promise<Record<string, string | null>> => {
    const rows = await handle.sql<{ id: string; title: string | null }[]>`
      SELECT id, title FROM items ORDER BY id
    `;
    return Object.fromEntries(rows.map((r) => [r.id, r.title]));
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
    dir = await mkdtemp(join(tmpdir(), "tsuzuri-loader-"));
    storage = fileStorage(dir);
    logs = [];
    await handle.sql`TRUNCATE items, sources, loaded_objects CASCADE`;
    const [source] = await handle.sql<{ id: string }[]>`
      INSERT INTO sources (user_id, kind, url) VALUES (${USER}, 'feed', 'https://e.com/feed.xml')
      RETURNING id
    `;
    sourceId = (source as { id: string }).id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await handle?.close();
  });

  describe("loadPending", () => {
    test("applies every object under items/ and reports the totals", async () => {
      await put(KEY_1, [itemRow(ID_A), itemRow(ID_B)]);
      await put(KEY_2, [itemRow(ID_C)]);

      const result = await loader().loadPending();

      expect(result).toEqual({ objects: 2, inserted: 3, linked: 3, rejected: 0 });
      expect(await count("items")).toBe(3);
      expect(await count("loaded_objects")).toBe(2);
    });

    test("with nothing in storage it does nothing", async () => {
      expect(await loader().loadPending()).toEqual({
        objects: 0,
        inserted: 0,
        linked: 0,
        rejected: 0,
      });
    });

    test("reads only items/, not inbox, runs or state", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await put("inbox/other/dt=2026-11-08/x.parquet", [itemRow(ID_B)]);
      await storage.put("_runs/20261108T000000Z-00000000.json", "{}");
      await storage.put("_state/collector.json", "{}");

      const result = await loader().loadPending();

      expect(result.objects).toBe(1);
      expect(Object.keys(await titles())).toEqual([ID_A]);
    });

    test("a second run applies nothing", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await loader().loadPending();

      const second = await loader().loadPending();

      expect(second).toEqual({ objects: 0, inserted: 0, linked: 0, rejected: 0 });
      expect(await count("items")).toBe(1);
    });

    test("an object that arrives later is the only one the next run applies", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await loader().loadPending();
      await put(KEY_2, [itemRow(ID_B)]);

      const second = await loader().loadPending();

      expect(second).toEqual({ objects: 1, inserted: 1, linked: 1, rejected: 0 });
    });

    test("skips an object the ledger already records", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await handle.sql`INSERT INTO loaded_objects (key, rows) VALUES (${KEY_1}, 1)`;

      const result = await loader().loadPending();

      expect(result.objects).toBe(0);
      expect(await count("items")).toBe(0);
    });

    test("applies objects in key order, so the earlier write wins across objects", async () => {
      // Written in the opposite order of their keys.
      await put(KEY_2, [itemRow(ID_A, { title: "later", fetched_at: T2 })]);
      await put(KEY_1, [itemRow(ID_A, { title: "earlier", fetched_at: T1 })]);

      await loader().loadPending();

      expect(await titles()).toEqual({ [ID_A]: "earlier" });
    });

    test("within an object the earliest fetched_at wins, ties by row position", async () => {
      await put(KEY_1, [
        itemRow(ID_A, { title: "late", fetched_at: T2 }),
        itemRow(ID_A, { title: "early", fetched_at: T1 }),
        itemRow(ID_A, { title: "early-but-after", fetched_at: T1 }),
      ]);

      const result = await loader().loadPending();

      expect(result.inserted).toBe(1);
      expect(await titles()).toEqual({ [ID_A]: "early" });
      const [stored] = await handle.sql`SELECT fetched_at FROM items`;
      expect(stored?.fetched_at.toISOString()).toBe("2026-11-08T01:00:00.000Z");
    });

    test("when fetched_at ties, the first row of the object stays", async () => {
      await put(KEY_1, [
        itemRow(ID_A, { title: "first", fetched_at: T1 }),
        itemRow(ID_A, { title: "second", fetched_at: T1 }),
      ]);

      await loader().loadPending();

      expect(await titles()).toEqual({ [ID_A]: "first" });
    });

    test("derives search_text from title and stripped html", async () => {
      await put(KEY_1, [
        itemRow(ID_A, {
          title: "Hello",
          content_html: "<p>World &amp; <b>x</b></p><script>bad()</script>",
        }),
      ]);

      await loader().loadPending();

      const [stored] = await handle.sql`SELECT search_text FROM items`;
      expect(stored?.search_text).toBe("Hello World x");
    });

    test("falls back to the summary when there is no html", async () => {
      await put(KEY_1, [itemRow(ID_A, { title: "T", summary: "Short text" })]);

      await loader().loadPending();

      const [stored] = await handle.sql`SELECT search_text FROM items`;
      expect(stored?.search_text).toBe("T Short text");
    });

    test("an item of an unknown source is stored without a link", async () => {
      await put(KEY_1, [
        itemRow(ID_A),
        itemRow(ID_B, { source_id: "00000000-0000-0000-0000-00000000dead" }),
      ]);

      const result = await loader().loadPending();

      expect(result).toEqual({ objects: 1, inserted: 2, linked: 1, rejected: 0 });
      const links = await handle.sql<{ item_id: string }[]>`SELECT item_id FROM item_sources`;
      expect(links.map((l) => l.item_id)).toEqual([ID_A]);
    });

    test("the link's first_seen_at is the row's fetched_at", async () => {
      await put(KEY_1, [itemRow(ID_A, { fetched_at: T2 })]);

      await loader().loadPending();

      const [link] = await handle.sql`SELECT first_seen_at FROM item_sources`;
      expect(link?.first_seen_at.toISOString()).toBe("2026-11-08T02:00:00.000Z");
    });
  });

  describe("validation", () => {
    const invalid: [string, Record<string, unknown>][] = [
      ["schema_version other than 1", { schema_version: 2 }],
      ["a null schema_version", { schema_version: null }],
      ["a null url", { url: null }],
      ["a null canonical_url", { canonical_url: null }],
      ["a null published_at", { published_at: null }],
      ["a null published_at_estimated", { published_at_estimated: null }],
      ["a null fetched_at", { fetched_at: null }],
      ["a null source_id", { source_id: null }],
      ["a null id", { id: null }],
      ["an id of the wrong length", { id: "d".repeat(63) }],
      ["an uppercase id", { id: "D".repeat(64) }],
      ["an id that is not hex", { id: "g".repeat(64) }],
    ];

    for (const [name, overrides] of invalid) {
      test(`refuses a row with ${name} and still applies its valid neighbours`, async () => {
        await put(KEY_1, [itemRow(ID_A), itemRow(ID_B, overrides), itemRow(ID_C)]);

        const result = await loader().loadPending();

        expect(result).toEqual({ objects: 1, inserted: 2, linked: 2, rejected: 1 });
        expect(Object.keys(await titles())).toEqual([ID_A, ID_C]);
        const [ledger] = await handle.sql`SELECT rows, rejected FROM loaded_objects`;
        expect(ledger).toMatchObject({ rows: 2, rejected: 1 });
      });
    }

    test("reports each refused row with the object key and its position", async () => {
      await put(KEY_1, [
        itemRow(ID_A),
        itemRow(ID_B, { schema_version: 2 }),
        itemRow(ID_C, { url: null }),
      ]);

      await loader().loadPending();

      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain(KEY_1);
      expect(logs[0]).toMatch(/\b1\b/);
      expect(logs[1]).toContain(KEY_1);
      expect(logs[1]).toMatch(/\b2\b/);
    });

    test("an object whose rows are all refused is still recorded as loaded", async () => {
      await put(KEY_1, [itemRow(ID_A, { schema_version: 2 })]);

      const first = await loader().loadPending();
      const second = await loader().loadPending();

      expect(first).toEqual({ objects: 1, inserted: 0, linked: 0, rejected: 1 });
      expect(second.objects).toBe(0);
    });

    test("an optional column left null is accepted", async () => {
      await put(KEY_1, [itemRow(ID_A, { title: null })]);

      const result = await loader().loadPending();

      expect(result.rejected).toBe(0);
      expect(await titles()).toEqual({ [ID_A]: null });
    });
  });

  describe("objects that cannot be applied", () => {
    test("an unreadable object is reported, left unmarked and retried next time", async () => {
      await storage.put(KEY_1, "this is not parquet");
      await put(KEY_2, [itemRow(ID_A)]);

      const first = await loader().loadPending();

      expect(first).toEqual({ objects: 1, inserted: 1, linked: 1, rejected: 0 });
      expect(logs.some((m) => m.includes(KEY_1))).toBe(true);
      const loaded = await handle.sql<{ key: string }[]>`SELECT key FROM loaded_objects`;
      expect(loaded.map((r) => r.key)).toEqual([KEY_2]);

      await put(KEY_1, [itemRow(ID_B)]);
      const second = await loader().loadPending();

      expect(second).toEqual({ objects: 1, inserted: 1, linked: 1, rejected: 0 });
      expect(Object.keys(await titles())).toEqual([ID_A, ID_B]);
    });

    test("an object that disappears between list and get is not marked loaded", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await put(KEY_2, [itemRow(ID_B)]);
      const vanishing: Storage = {
        ...storage,
        get: async (key) => (key === KEY_1 ? null : storage.get(key)),
      };

      const result = await loader(vanishing).loadPending();

      expect(result.objects).toBe(1);
      expect(logs.some((m) => m.includes(KEY_1))).toBe(true);
      const loaded = await handle.sql<{ key: string }[]>`SELECT key FROM loaded_objects`;
      expect(loaded.map((r) => r.key)).toEqual([KEY_2]);
    });

    test("a row the database refuses commits nothing of its object and leaves it unmarked", async () => {
      await put(KEY_1, [itemRow(ID_A), itemRow(ID_B, { title: "bad\u0000title" })]);
      await put(KEY_2, [itemRow(ID_C)]);

      const first = await loader().loadPending();

      expect(first).toEqual({ objects: 1, inserted: 1, linked: 1, rejected: 0 });
      expect(Object.keys(await titles())).toEqual([ID_C]);
      expect(logs.some((m) => m.includes(KEY_1))).toBe(true);
      const loaded = await handle.sql<{ key: string }[]>`SELECT key FROM loaded_objects`;
      expect(loaded.map((r) => r.key)).toEqual([KEY_2]);

      const second = await loader().loadPending();

      expect(second.objects).toBe(0);
      expect(logs.filter((m) => m.includes(KEY_1)).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("reload", () => {
    test("applies everything again without duplicating rows or touching item_state", async () => {
      await put(KEY_1, [itemRow(ID_A), itemRow(ID_B)]);
      await put(KEY_3, [itemRow(ID_C)]);
      await loader().loadPending();
      await handle.sql`
        INSERT INTO item_state (user_id, item_id, read_at, starred_at)
        VALUES (${USER}, ${ID_A}, '2026-11-08T03:00:00Z', '2026-11-08T04:00:00Z')
      `;

      const result = await loader().reload();

      expect(result).toEqual({ objects: 2, inserted: 0, linked: 0, rejected: 0 });
      expect(await count("items")).toBe(3);
      expect(await count("item_sources")).toBe(3);
      expect(await count("loaded_objects")).toBe(2);
      const [state] = await handle.sql`SELECT read_at, starred_at FROM item_state`;
      expect(state?.read_at.toISOString()).toBe("2026-11-08T03:00:00.000Z");
      expect(state?.starred_at.toISOString()).toBe("2026-11-08T04:00:00.000Z");
    });

    test("restores a link that was lost", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await loader().loadPending();
      await handle.sql`DELETE FROM item_sources`;

      const result = await loader().reload();

      expect(result).toEqual({ objects: 1, inserted: 0, linked: 1, rejected: 0 });
    });

    test("does not delete items whose objects are gone from storage", async () => {
      await put(KEY_1, [itemRow(ID_A)]);
      await loader().loadPending();
      await rm(join(dir, KEY_1));

      const result = await loader().reload();

      expect(result.objects).toBe(0);
      expect(await count("items")).toBe(1);
      expect(await count("loaded_objects")).toBe(0);
    });
  });

  describe("syncSourceState", () => {
    const entry = (overrides: Record<string, unknown> = {}) => ({
      etag: '"abc"',
      lastModified: null,
      contentHash: "hash-1",
      nextFetchAt: "2026-11-09T00:00:00.000Z",
      lastFetchedAt: "2026-11-08T12:00:00.000Z",
      lastSuccessAt: "2026-11-08T12:00:00.000Z",
      consecutiveFailures: 2,
      lastError: "boom",
      status: "degraded",
      recentIds: ["75aa39e4ad17f2ea"],
      ...overrides,
    });

    const putState = (subscriptions: Record<string, unknown>) =>
      storage.put("_state/collector.json", JSON.stringify({ version: 1, subscriptions }));

    test("returns 0 when the collector has not written any state", async () => {
      expect(await loader().syncSourceState()).toBe(0);
    });

    test("copies the collector's state onto the sources", async () => {
      await putState({ [sourceId]: entry() });

      const updated = await loader().syncSourceState();

      expect(updated).toBe(1);
      const [source] = await handle.sql`SELECT * FROM sources WHERE id = ${sourceId}`;
      expect(source?.etag).toBe('"abc"');
      expect(source?.content_hash).toBe("hash-1");
      expect(source?.consecutive_failures).toBe(2);
      expect(source?.last_error).toBe("boom");
      expect(source?.status).toBe("degraded");
      expect(source?.next_fetch_at.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    });

    test("keeps a disabled source disabled and ignores unknown ids", async () => {
      await handle.sql`UPDATE sources SET status = 'disabled' WHERE id = ${sourceId}`;
      await putState({
        [sourceId]: entry({ status: "active" }),
        "00000000-0000-0000-0000-00000000beef": entry(),
      });

      const updated = await loader().syncSourceState();

      expect(updated).toBe(1);
      const [source] = await handle.sql`SELECT status, etag FROM sources`;
      expect(source).toMatchObject({ status: "disabled", etag: '"abc"' });
    });

    test("drops a malformed entry the way the collector does", async () => {
      await putState({ [sourceId]: entry({ consecutiveFailures: -1, etag: '"never"' }) });

      const updated = await loader().syncSourceState();

      expect(updated).toBe(0);
      const [source] = await handle.sql`SELECT etag FROM sources`;
      expect(source?.etag).toBeNull();
    });

    test("refuses a state file that is not the collector's format", async () => {
      await storage.put("_state/collector.json", JSON.stringify({ version: 2, subscriptions: {} }));

      await expect(loader().syncSourceState()).rejects.toThrow("collector.json");
    });
  });
});
