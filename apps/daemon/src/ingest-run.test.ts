import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorStorageSchema } from "@tsuzuri/api";
import { sha256 } from "@tsuzuri/core";
import { createDatabase, migrate } from "@tsuzuri/db";
import { fileStorage, type Storage } from "@tsuzuri/store";

import { createApi } from "./api.ts";

import { loadConfig } from "./config.ts";
import { createClusteringService } from "./enrich/clustering.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";
import { createEnrichmentService } from "./enrich/enrichment.ts";
import { createInterestService } from "./enrich/interest.ts";
import type { Fetcher } from "./ingest/fetcher.ts";
import { createIngestion } from "./ingestion.ts";

/**
 * The API fetching through the collector and filling PostgreSQL through the
 * loader. Real PostgreSQL, a real file store in a temp dir, and a fake fetcher
 * serving RSS. The collector and the load runner come from createIngestion,
 * the daemon's own wiring, so each flush is followed by a load as in
 * production.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const FEED = "http://127.0.0.1/feeds/animals.xml";
const BROKEN_FEED = "http://127.0.0.1/feeds/broken.xml";

type Entry = { slug: string; title: string; pubDate: string };

const ENTRIES: Entry[] = [
  { slug: "alpha", title: "Ferrets of the Andes", pubDate: "Sat, 07 Nov 2026 09:00:00 GMT" },
  { slug: "beta", title: "Numbat migration", pubDate: "Fri, 06 Nov 2026 09:00:00 GMT" },
  { slug: "gamma", title: "Okapi sighting", pubDate: "Thu, 05 Nov 2026 09:00:00 GMT" },
];

const postUrl = (slug: string) => `https://news.example/posts/${slug}`;

function rss(entries: Entry[]): string {
  const items = entries
    .map(
      (e) =>
        `<item><title>${e.title}</title><link>${postUrl(e.slug)}</link><pubDate>${e.pubDate}</pubDate></item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Animals</title>${items}</channel></rss>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A request that never answers fails the test in 2s instead of its 10s timeout.
function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    sleep(2000).then(() => {
      throw new Error("no answer within 2s");
    }),
  ]);
}

// Polls for at most ~2s so a broken implementation fails instead of hanging.
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error("condition not reached");
}

type ListedItem = { id: string; title: string | null; readAt: string | null };
type LoadResultBody = {
  objects: number;
  inserted: number;
  linked: number;
  rejected: number;
  stoppedAt: { key: string; error: string } | null;
};
type IngestBody = {
  polled: number;
  inserted: number;
  failed: number;
  outcomes: { id: string; status: string; seen: number; written: number; error?: string }[];
  stoppedAt: { key: string; error: string } | null;
};
type DoctorStorage = { at: string } & LoadResultBody;

describeIfDb("ingest through the collector and the loader", () => {
  let handle: ReturnType<typeof createDatabase>;
  let services: {
    embeddings: ReturnType<typeof createEmbeddingService>;
    interest: ReturnType<typeof createInterestService>;
    clustering: ReturnType<typeof createClusteringService>;
    enrichment: ReturnType<typeof createEnrichmentService>;
  };
  let config: ReturnType<typeof loadConfig>;
  let dir: string;
  let storage: Storage;
  let app: ReturnType<typeof createApi>;
  let collector: ReturnType<typeof createIngestion>["collector"];
  let loads: ReturnType<typeof createIngestion>["loads"];
  /** Every URL the fake fetcher was asked for, in order. */
  let fetched: string[];
  /** While set, every fetch waits for it before answering. */
  let hold: Promise<void> | null;

  const fetcher: Fetcher = async (url) => {
    fetched.push(String(url));
    if (hold) await hold;
    if (String(url) === BROKEN_FEED) return new Response("down", { status: 500 });
    return new Response(rss(ENTRIES), {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    });
  };

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    config = loadConfig({
      DATABASE_URL: DATABASE_URL as string,
      FETCH_ALLOW_PRIVATE_TARGETS: "true",
    });
    const embeddings = createEmbeddingService({ sql: handle.sql, config });
    await embeddings.start();
    const interest = createInterestService({ sql: handle.sql, config, embeddings });
    await interest.start();
    const clustering = createClusteringService({ sql: handle.sql, config, embeddings });
    const enrichment = createEnrichmentService({
      sql: handle.sql,
      config,
      interest,
      provider: null,
    });
    services = { embeddings, interest, clustering, enrichment };
  });

  beforeEach(async () => {
    await handle.sql`TRUNCATE items, sources, loaded_objects CASCADE`;
    dir = await mkdtemp(join(tmpdir(), "tsuzuri-ingest-run-"));
    storage = fileStorage(dir);
    fetched = [];
    hold = null;

    app = build();
  });

  // flushIntervalMs 0 makes every tick flush what an earlier tick left
  // pending, which is what the scheduler does every five minutes.
  function build(flushIntervalMs?: number) {
    const ingestion = createIngestion({
      sql: handle.sql,
      storage,
      fetcher,
      config: { ...config, DEGRADE_AFTER_FAILURES: 3 },
      log: () => {},
      flushIntervalMs,
    });
    collector = ingestion.collector;
    loads = ingestion.loads;
    return createApi({
      db: handle.db,
      sql: handle.sql,
      config,
      ...services,
      collector: ingestion.collector,
      loads: ingestion.loads,
    });
  }

  afterEach(async () => {
    hold = null;
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await handle?.close();
  });

  const get = async (path: string) => app.fetch(new Request(`http://test${path}`));
  const post = async (path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://test${path}`, {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );

  async function json<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  async function subscribe(url: string): Promise<string> {
    const response = await post("/sources", { url });
    expect(response.status).toBe(201);
    return (await json<{ source: { id: string } }>(response)).source.id;
  }

  async function ingest(query = "?all=true"): Promise<IngestBody> {
    const response = await post(`/ingest/run${query}`);
    expect(response.status).toBe(200);
    return json<IngestBody>(response);
  }

  async function listed(): Promise<ListedItem[]> {
    const body = await json<{ items: ListedItem[] }>(await get("/items?unread=false&limit=50"));
    return body.items.map(({ id, title, readAt }) => ({ id, title, readAt }));
  }

  async function count(table: "items" | "item_sources" | "loaded_objects"): Promise<number> {
    const [row] = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${handle.sql(table)}
    `;
    return (row as { n: number }).n;
  }

  describe("POST /ingest/run", () => {
    test("all=true fetches the feed, reports the loader's insert count, and the items are listed", async () => {
      const sourceId = await subscribe(FEED);

      const body = await ingest("?all=true");

      expect(body).toEqual({
        polled: 1,
        inserted: 3,
        failed: 0,
        outcomes: [{ id: sourceId, status: "fetched", seen: 3, written: 3 }],
        stoppedAt: null,
      });
      expect((await listed()).map((item) => item.title)).toEqual([
        "Ferrets of the Andes",
        "Numbat migration",
        "Okapi sighting",
      ]);
    });

    test("inserted includes the items a flush inside the tick loaded, not only the request's own flush", async () => {
      app = build(0);
      const sourceId = await subscribe(FEED);
      // A scheduler tick buffers the feed; nothing is written yet.
      await collector.tick([
        {
          id: sourceId,
          kind: "feed",
          url: FEED,
          config: {},
          fetchIntervalSeconds: 3600,
          status: "active",
        },
      ]);
      expect(await listed()).toEqual([]);

      const body = await ingest("?all=true");

      expect(body.inserted).toBe(3);
      expect((await listed()).length).toBe(3);
    });

    test("a scheduler tick and flush load into PostgreSQL without any API call", async () => {
      app = build();
      const sourceId = await subscribe(FEED);

      await collector.tick([
        {
          id: sourceId,
          kind: "feed",
          url: FEED,
          config: {},
          fetchIntervalSeconds: 3600,
          status: "active",
        },
      ]);
      await collector.flush();
      await loads.settled();

      expect((await listed()).length).toBe(3);
    });

    test("a load that is slow does not hold up the next flush or tick", async () => {
      const real = storage;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      storage = {
        ...real,
        list: async (prefix) => {
          if (prefix === "items/") await gate;
          return real.list(prefix);
        },
      };
      app = build();
      const sourceId = await subscribe(FEED);
      const sub = {
        id: sourceId,
        kind: "feed" as const,
        url: FEED,
        config: {},
        fetchIntervalSeconds: 3600,
        status: "active" as const,
      };

      await within(collector.tick([sub]));
      // The load this flush queues waits on the gate; the flush does not.
      await within(collector.flush());
      const second = await within(collector.tick([sub], { force: true }));

      expect(second.busy).toBe(false);
      expect(await listed()).toEqual([]);
      release();
      await loads.settled();
      expect((await listed()).length).toBe(3);
    });

    test("reports where the load stopped, and fetch keeps working", async () => {
      await subscribe(FEED);
      await storage.put("items/dt=2000-01-01/20000101T000000Z-00000000.parquet", "not parquet");

      const body = await ingest("?all=true");

      expect(body.stoppedAt?.key).toBe("items/dt=2000-01-01/20000101T000000Z-00000000.parquet");
      expect(body.stoppedAt?.error).toContain("cannot read object");
      expect(body.polled).toBe(1);
    });

    test("when the load a flush queued throws, the request loads again and reports the items", async () => {
      const real = storage;
      let failNextList = true;
      storage = {
        ...real,
        list: async (prefix) => {
          if (prefix === "items/" && failNextList) {
            failNextList = false;
            throw new Error("listing failed once");
          }
          return real.list(prefix);
        },
      };
      app = build();
      await subscribe(FEED);

      const body = await ingest("?all=true");

      expect(failNextList).toBe(false);
      expect(body.inserted).toBe(3);
      expect((await listed()).length).toBe(3);
    });

    test("a rebuild already running when the request starts is not counted as its inserts", async () => {
      await subscribe(FEED);
      await ingest("?all=true");
      await handle.sql`DELETE FROM items`;
      await handle.sql`TRUNCATE loaded_objects`;

      const rebuilding = post("/rebuild");
      const body = await ingest("");
      const rebuilt = await json<LoadResultBody>(await rebuilding);

      expect(rebuilt.inserted).toBe(3);
      expect(body.inserted).toBe(0);
    });

    test("with nothing due it still loads an object left pending in storage", async () => {
      await subscribe(FEED);
      await ingest("?all=true");
      // The object is in storage but PostgreSQL no longer has it applied.
      await handle.sql`DELETE FROM items`;
      await handle.sql`TRUNCATE loaded_objects`;

      const body = await ingest("");

      expect(body.polled).toBe(0);
      expect(body.inserted).toBe(3);
      expect((await listed()).length).toBe(3);
    });

    test("PostgreSQL gets its items from the Parquet object the loader applied, not from the fetch", async () => {
      await subscribe(FEED);
      await ingest("?all=true");

      expect(await storage.list("items/")).toHaveLength(1);
      expect(await storage.list("_runs/")).toHaveLength(1);
      expect(await storage.list("_state/")).toEqual(["_state/collector.json"]);
      expect(await count("loaded_objects")).toBe(1);
      expect(await count("items")).toBe(3);
      expect(await count("item_sources")).toBe(3);
    });

    test("inserted counts the items new to PostgreSQL, not the items the feed carried", async () => {
      await subscribe(FEED);
      // alpha is already stored under another title, as after the switch from
      // direct ingest to storage.
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${sha256(postUrl("alpha"))}, ${postUrl("alpha")}, ${postUrl("alpha")},
                'Stored before the switch', '2026-11-07T09:00:00Z', 'Stored before the switch')
      `;

      const body = await ingest("?all=true");

      expect(body.inserted).toBe(2);
      expect(body.outcomes[0]?.written).toBe(3);
      const titles = (await listed()).map((item) => item.title);
      expect(titles).toEqual(["Stored before the switch", "Numbat migration", "Okapi sighting"]);
    });

    test("without all=true a subscription with no saved state is fetched, and one fetched a moment ago is not", async () => {
      await subscribe(FEED);

      const first = await ingest("");
      expect(first.polled).toBe(1);
      expect(first.inserted).toBe(3);
      expect(first.outcomes[0]?.written).toBe(3);
      expect(fetched).toEqual([FEED]);

      const second = await ingest("");
      expect(second).toEqual({ polled: 0, inserted: 0, failed: 0, outcomes: [], stoppedAt: null });
      expect(fetched).toEqual([FEED]);
    });

    test("all=true fetches a subscription that is not due, and an unchanged feed inserts nothing", async () => {
      await subscribe(FEED);
      await ingest("");
      expect(fetched).toHaveLength(1);

      const forced = await ingest("?all=true");

      expect(fetched).toEqual([FEED, FEED]);
      expect(forced.polled).toBe(1);
      expect(forced.inserted).toBe(0);
      expect(forced.outcomes[0]?.written).toBe(0);
      expect(await count("items")).toBe(3);
    });

    test("a failing feed counts as failed and does not stop the one beside it", async () => {
      const okId = await subscribe(FEED);
      const brokenId = await subscribe(BROKEN_FEED);

      const body = await ingest("?all=true");

      expect(body.polled).toBe(2);
      expect(body.failed).toBe(1);
      expect(body.inserted).toBe(3);
      const byId = new Map(body.outcomes.map((outcome) => [outcome.id, outcome]));
      expect(byId.get(okId)?.status).toBe("fetched");
      expect(byId.get(brokenId)).toMatchObject({ status: "failed", error: "HTTP 500" });
    });

    test("the sources row takes the collector's fetch state through the loader", async () => {
      const sourceId = await subscribe(FEED);
      const before = Date.now();

      await ingest("?all=true");

      const [row] = await handle.sql<
        { last_success_at: Date | null; next_fetch_at: Date; consecutive_failures: number }[]
      >`SELECT last_success_at, next_fetch_at, consecutive_failures FROM sources WHERE id = ${sourceId}`;
      expect(row?.last_success_at).not.toBeNull();
      expect(new Date(String(row?.last_success_at)).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
      // The default interval is 3600 s with at most 10% jitter.
      const nextInMs = new Date(String(row?.next_fetch_at)).getTime() - before;
      expect(nextInMs).toBeGreaterThan(3_000_000);
      expect(nextInMs).toBeLessThan(4_000_000);
      expect(row?.consecutive_failures).toBe(0);
      // The row is derived: the collector's own copy is what the loader read.
      expect(await storage.get("_state/collector.json")).not.toBeNull();
    });

    test("a request made while a tick is in flight is refused with 409 and fetches nothing", async () => {
      await subscribe(FEED);
      let open: () => void = () => {};
      hold = new Promise<void>((resolve) => {
        open = resolve;
      });
      try {
        const running = post("/ingest/run?all=true");
        await until(() => fetched.length === 1);

        for (const query of ["?all=true", ""]) {
          const refused = await within(post(`/ingest/run${query}`));
          expect(refused.status).toBe(409);
          expect(await json<unknown>(refused)).toEqual({ error: "a fetch is already running" });
        }
        expect(fetched).toEqual([FEED]);

        open();
        const done = await running;
        expect(done.status).toBe(200);
        expect((await json<IngestBody>(done)).inserted).toBe(3);
      } finally {
        open();
      }

      const after = await post("/ingest/run?all=true");
      expect(after.status).toBe(200);
    });
  });

  describe("POST /rebuild", () => {
    test("with nothing in storage it applies nothing", async () => {
      const response = await post("/rebuild");
      expect(response.status).toBe(200);
      expect(await json<LoadResultBody>(response)).toEqual({
        objects: 0,
        inserted: 0,
        linked: 0,
        rejected: 0,
        stoppedAt: null,
      });
    });

    test("re-applying objects PostgreSQL already holds inserts and links nothing", async () => {
      await subscribe(FEED);
      await ingest("?all=true");

      const response = await post("/rebuild");

      expect(await json<LoadResultBody>(response)).toEqual({
        objects: 1,
        inserted: 0,
        linked: 0,
        rejected: 0,
        stoppedAt: null,
      });
      expect(await count("items")).toBe(3);
    });

    test("it does not delete an item that storage does not hold", async () => {
      await subscribe(FEED);
      await ingest("?all=true");
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${sha256(postUrl("orphan"))}, ${postUrl("orphan")}, ${postUrl("orphan")},
                'Only in PostgreSQL', now(), 'Only in PostgreSQL')
      `;

      const response = await post("/rebuild");

      expect(response.status).toBe(200);
      expect(await count("items")).toBe(4);
    });

    test("rebuilds items, links and read state: the items table can be dropped except what item_state holds", async () => {
      await subscribe(FEED);
      await ingest("?all=true");
      const before = await listed();
      expect(before).toHaveLength(3);

      const beta = before.find((item) => item.title === "Numbat migration");
      const marked = await post(`/items/${beta?.id}/state`, { read: true });
      expect(marked.status).toBe(200);
      const beforeRead = await listed();
      expect(beforeRead.filter((item) => item.readAt !== null).map((item) => item.title)).toEqual([
        "Numbat migration",
      ]);

      await handle.sql`
        DELETE FROM item_sources WHERE item_id NOT IN (SELECT item_id FROM item_state)
      `;
      await handle.sql`DELETE FROM items WHERE id NOT IN (SELECT item_id FROM item_state)`;
      await handle.sql`DELETE FROM loaded_objects`;
      expect(await count("items")).toBe(1);
      expect(await count("item_sources")).toBe(1);
      expect(await listed()).toHaveLength(1);

      const response = await post("/rebuild");

      expect(response.status).toBe(200);
      expect(await json<LoadResultBody>(response)).toEqual({
        objects: 1,
        inserted: 2,
        linked: 2,
        rejected: 0,
        stoppedAt: null,
      });
      expect(await listed()).toEqual(beforeRead);
    });

    test("it brings the sources fetch state back from _state/collector.json", async () => {
      const sourceId = await subscribe(FEED);
      await ingest("?all=true");
      await handle.sql`
        UPDATE sources SET last_success_at = NULL, consecutive_failures = 7 WHERE id = ${sourceId}
      `;

      await post("/rebuild");

      const [row] = await handle.sql<
        { last_success_at: Date | null; consecutive_failures: number }[]
      >`
        SELECT last_success_at, consecutive_failures FROM sources WHERE id = ${sourceId}
      `;
      expect(row?.last_success_at).not.toBeNull();
      expect(row?.consecutive_failures).toBe(0);
    });

    test("an object that cannot be read stops the run and is named in stoppedAt", async () => {
      const stuck = "items/dt=2000-01-01/20000101T000000Z-00000000.parquet";
      await storage.put(stuck, "this is not parquet");

      const response = await post("/rebuild");

      expect(response.status).toBe(200);
      const body = await json<LoadResultBody>(response);
      expect(body.objects).toBe(0);
      expect(body.stoppedAt?.key).toBe(stuck);
      expect(body.stoppedAt?.error).toMatch(/^cannot read object: /);
    });
  });

  describe("GET /doctor storage", () => {
    async function doctorStorage(): Promise<DoctorStorage> {
      const response = await get("/doctor");
      expect(response.status).toBe(200);
      return (await json<{ storage: DoctorStorage }>(response)).storage;
    }

    test("is null before any loader run has finished", async () => {
      const response = await get("/doctor");
      const body = await json<{ storage: unknown }>(response);
      expect(body.storage).toBeNull();
      expect(doctorStorageSchema.parse(body.storage)).toBeNull();
    });

    test("reports the last loader run: when, how many objects, how many items", async () => {
      await subscribe(FEED);
      const startedAt = Date.now();
      await ingest("?all=true");

      const report = await doctorStorage();

      expect(report.objects).toBe(1);
      expect(report.inserted).toBe(3);
      expect(report.stoppedAt).toBeNull();
      const at = Date.parse(report.at);
      expect(at).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test("shows the rebuild after an ingest, because it is the last run", async () => {
      await subscribe(FEED);
      await ingest("?all=true");
      expect((await doctorStorage()).inserted).toBe(3);

      await post("/rebuild");

      const report = await doctorStorage();
      expect(report.objects).toBe(1);
      expect(report.inserted).toBe(0);
    });

    test("shows the key a stuck run stopped at", async () => {
      const stuck = "items/dt=2000-01-01/20000101T000000Z-00000000.parquet";
      await storage.put(stuck, "this is not parquet");
      await subscribe(FEED);

      const body = await ingest("?all=true");
      // The stuck key sorts first, so the object this fetch wrote waits behind it.
      expect(body.polled).toBe(1);
      expect(body.inserted).toBe(0);

      const report = await doctorStorage();
      expect(report.objects).toBe(0);
      expect(report.stoppedAt?.key).toBe(stuck);
      expect(report.stoppedAt?.error).toMatch(/^cannot read object: /);
      expect(await count("items")).toBe(0);
    });
  });
});
