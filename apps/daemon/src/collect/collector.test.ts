import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchResult, RawItem, Source, SourceContext } from "@tsuzuri/core";
import { fileStorage, readParquet, type Storage } from "@tsuzuri/store";

import {
  type CollectorState,
  type CollectorSubscription,
  createCollector,
  type SubscriptionFetchState,
} from "./collector.ts";

const T0 = new Date("2026-11-08T12:34:56.000Z");
const STATE_KEY = "_state/collector.json";

// SHA-256 of the canonical URL, taken from normalizeItem's output.
const ID_A = "75aa39e4ad17f2ea3147a5168d35079e5050a1166e4e2a6aff67dcea1451f77d";
const ID_B = "c39a8839222451ee389ef70b6c84492299eaf198e5afd8816fa9e3de421f121e";
const ID_C = "4404d8fc43eda55c76c88199d06d26971450474878aeffcff8c3ed838f5e58e9";
const ID_D = "81edf9f88782bc8507b6ba862dcbe51835f0c87f66e9b1d7a5782ceb25be5126";

const COLUMNS = [
  "id",
  "url",
  "canonical_url",
  "title",
  "author",
  "guid",
  "published_at",
  "published_at_estimated",
  "content_html",
  "summary",
  "fetched_at",
  "source_id",
  "schema_version",
  "raw",
];

let dir: string;
let storage: Storage;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsuzuri-collector-"));
  storage = fileStorage(dir);
  clock = new Date(T0);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function raw(url: string, extra: Partial<RawItem> = {}): RawItem {
  return {
    url,
    title: null,
    author: null,
    guid: null,
    publishedAtRaw: null,
    contentHtml: null,
    summary: null,
    ...extra,
  };
}

function post(name: string): RawItem {
  return raw(`https://example.com/posts/${name}`, { title: name });
}

function fetched(items: RawItem[], extra: Partial<FetchResult> = {}): FetchResult {
  return { status: "fetched", items, contentHash: "h1", ...extra } as FetchResult;
}

function sub(id: string, extra: Partial<CollectorSubscription> = {}): CollectorSubscription {
  return {
    id,
    kind: "feed",
    url: `https://${id}.example/feed.xml`,
    config: {},
    fetchIntervalSeconds: 3600,
    status: "active",
    ...extra,
  };
}

function entry(extra: Partial<SubscriptionFetchState> = {}): SubscriptionFetchState {
  return {
    etag: null,
    lastModified: null,
    contentHash: null,
    nextFetchAt: "2026-11-08T12:00:00.000Z",
    lastFetchedAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lastError: null,
    status: "active",
    recentIds: [],
    ...extra,
  };
}

async function seed(subscriptions: Record<string, SubscriptionFetchState>): Promise<void> {
  const state: CollectorState = { version: 1, subscriptions };
  await storage.put(STATE_KEY, JSON.stringify(state));
}

async function storedState(): Promise<CollectorState> {
  const bytes = await storage.get(STATE_KEY);
  if (bytes === null) throw new Error("no _state/collector.json");
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function storedJson(key: string): Promise<Record<string, unknown>> {
  const bytes = await storage.get(key);
  if (bytes === null) throw new Error(`no ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function rowsAt(key: string): Promise<Record<string, unknown>[]> {
  const bytes = await storage.get(key);
  if (bytes === null) throw new Error(`no ${key}`);
  return readParquet(bytes);
}

// Results are looked up by subscription URL at fetch time, so a test can
// change what a feed returns between ticks.
function fakeSources(results: Record<string, FetchResult>) {
  const calls: SourceContext[] = [];
  const source: Source = {
    kind: "feed",
    id: "fake",
    fetchItems: async (ctx) => {
      calls.push(ctx);
      const result = results[ctx.url];
      if (!result) throw new Error(`no scripted result for ${ctx.url}`);
      return result;
    },
  };
  return { sources: new Map<string, Source>([["feed", source]]), calls, results };
}

const fetcher = async () => new Response("");

type Harness = ReturnType<typeof fakeSources>;

function make(harness: Harness, extra: Partial<Parameters<typeof createCollector>[0]> = {}) {
  return createCollector({
    storage,
    fetcher,
    sources: harness.sources,
    now: () => clock,
    random: () => 0.5,
    degradeAfterFailures: 3,
    ...extra,
  });
}

describe("state loading (behaviour 1)", () => {
  test("a missing _state file is an empty state and its subscriptions are due", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    expect(await collector.state()).toEqual({ version: 1, subscriptions: {} });
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);
  });

  test("a saved nextFetchAt in the future keeps its subscription from being fetched", async () => {
    const saved = entry({ nextFetchAt: "2026-11-08T13:00:00.000Z", recentIds: [ID_A] });
    await seed({ a: saved, b: entry() });
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([]),
      "https://b.example/feed.xml": fetched([]),
    });
    const collector = make(harness);
    await collector.tick([sub("a"), sub("b")]);
    expect(harness.calls.map((ctx) => ctx.url)).toEqual(["https://b.example/feed.xml"]);
    expect((await collector.state()).subscriptions.a).toEqual(saved);
  });

  test("the saved fetch state is what the source sees", async () => {
    await seed({
      a: entry({ etag: "e1", lastModified: "Sat, 01 Aug 2026 00:00:00 GMT", contentHash: "h0" }),
    });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const signal = new AbortController().signal;
    await make(harness, { signal }).tick([sub("a", { config: { depth: 2 } })]);
    const ctx = harness.calls[0];
    expect(ctx?.url).toBe("https://a.example/feed.xml");
    expect(ctx?.config).toEqual({ depth: 2 });
    expect(ctx?.state).toEqual({
      etag: "e1",
      lastModified: "Sat, 01 Aug 2026 00:00:00 GMT",
      contentHash: "h0",
    });
    expect(ctx?.fetch).toBe(fetcher);
    expect(ctx?.signal).toBe(signal);
  });

  test("storage is read once, not on every tick", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    await collector.state();
    await seed({ a: entry({ nextFetchAt: "2026-11-08T13:00:00.000Z" }) });
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);
  });
});

describe("which subscriptions are fetched (behaviour 2)", () => {
  test("a subscription is due exactly when nextFetchAt is not after now", async () => {
    await seed({
      at: entry({ nextFetchAt: "2026-11-08T12:34:56.000Z" }),
      later: entry({ nextFetchAt: "2026-11-08T12:34:56.001Z" }),
    });
    const harness = fakeSources({
      "https://at.example/feed.xml": fetched([]),
      "https://later.example/feed.xml": fetched([]),
    });
    await make(harness).tick([sub("at"), sub("later")]);
    expect(harness.calls.map((ctx) => ctx.url)).toEqual(["https://at.example/feed.xml"]);
  });

  test("a subscription without state uses its own status", async () => {
    const harness = fakeSources({
      "https://off.example/feed.xml": fetched([]),
      "https://slow.example/feed.xml": fetched([]),
    });
    await make(harness).tick([
      sub("off", { status: "disabled" }),
      sub("slow", { status: "degraded" }),
    ]);
    expect(harness.calls.map((ctx) => ctx.url)).toEqual(["https://slow.example/feed.xml"]);
  });

  // `disabled` is the user's choice and arrives on the subscription; the
  // collector never writes it. Every other status is the collector's own.
  test("a subscription the user disabled is skipped even when its saved state is active", async () => {
    await seed({ off: entry({ status: "active" }) });
    const harness = fakeSources({ "https://off.example/feed.xml": fetched([]) });
    await make(harness).tick([sub("off", { status: "disabled" })]);
    expect(harness.calls).toHaveLength(0);
  });

  test("the collector's saved degraded status applies to an active subscription", async () => {
    await seed({ d: entry({ status: "degraded", consecutiveFailures: 3 }) });
    const harness = fakeSources({ "https://d.example/feed.xml": fetched([]) });
    const collector = make(harness);
    await collector.tick([sub("d")]);
    expect(harness.calls).toHaveLength(1);
    expect((await collector.state()).subscriptions.d?.status).toBe("active");
  });

  test("an unsupported subscription is not retried", async () => {
    await seed({ a: entry({ status: "unsupported" }) });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    await make(harness).tick([sub("a")]);
    expect(harness.calls).toHaveLength(0);
  });
});

describe("state transitions (behaviour 3)", () => {
  test("a kind with no implementation becomes unsupported", async () => {
    const harness = fakeSources({});
    const collector = make(harness);
    await collector.tick([sub("a", { kind: "rule" })]);
    expect(harness.calls).toHaveLength(0);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        status: "unsupported",
        lastError: 'no implementation for kind "rule"',
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T13:34:56.000Z",
      }),
    );
  });

  test("a retryable failure doubles the interval and keeps the status below the threshold", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "HTTP 503", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        consecutiveFailures: 1,
        lastError: "HTTP 503",
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T14:34:56.000Z",
      }),
    );
  });

  test("a non-retryable failure counts two extra failures for the backoff only", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "HTTP 404", retryable: false },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    const state = (await collector.state()).subscriptions.a;
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.nextFetchAt).toBe("2026-11-08T20:34:56.000Z");
  });

  test("the backoff is capped at 24 hours", async () => {
    await seed({ a: entry({ consecutiveFailures: 9 }) });
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.nextFetchAt).toBe("2026-11-09T12:34:56.000Z");
  });

  test("the backoff exponent stops growing at 10 failures", async () => {
    await seed({ a: entry({ consecutiveFailures: 19 }) });
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a", { fetchIntervalSeconds: 60 })]);
    expect((await collector.state()).subscriptions.a?.nextFetchAt).toBe("2026-11-09T05:38:56.000Z");
  });

  test("the failure that reaches degradeAfterFailures degrades the subscription", async () => {
    await seed({ at_threshold: entry({ consecutiveFailures: 2 }), below: entry() });
    const failing: FetchResult = { status: "failed", error: "x", retryable: true };
    const harness = fakeSources({
      "https://at_threshold.example/feed.xml": failing,
      "https://below.example/feed.xml": failing,
    });
    const collector = make(harness);
    await collector.tick([sub("at_threshold"), sub("below")]);
    const state = await collector.state();
    expect(state.subscriptions.at_threshold?.status).toBe("degraded");
    expect(state.subscriptions.below?.status).toBe("active");
  });

  test("degradeAfterFailures comes from the options", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
    });
    const collector = make(harness, { degradeAfterFailures: 1 });
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.status).toBe("degraded");
  });

  test("a degraded subscription stays degraded while it keeps failing", async () => {
    await seed({ a: entry({ status: "degraded", consecutiveFailures: 5 }) });
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.status).toBe("degraded");
  });

  test("unchanged resets failures, recovers a degraded subscription and keeps validators", async () => {
    await seed({
      a: entry({
        status: "degraded",
        consecutiveFailures: 5,
        lastError: "boom",
        etag: "old",
        lastModified: "old-lm",
        contentHash: "old-hash",
        recentIds: [ID_A],
      }),
    });
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "unchanged", reason: "not-modified" },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        status: "active",
        consecutiveFailures: 0,
        lastError: null,
        etag: "old",
        lastModified: "old-lm",
        contentHash: "old-hash",
        recentIds: [ID_A],
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        lastSuccessAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T13:34:56.000Z",
      }),
    );
  });

  test("fetched stores the validators, recovers a degraded subscription and schedules the next fetch", async () => {
    await seed({
      a: entry({ status: "degraded", consecutiveFailures: 4, lastError: "boom", etag: "old" }),
    });
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([], {
        etag: "e2",
        lastModified: "Sun, 02 Aug 2026 00:00:00 GMT",
        contentHash: "h2",
      }),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        status: "active",
        etag: "e2",
        lastModified: "Sun, 02 Aug 2026 00:00:00 GMT",
        contentHash: "h2",
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        lastSuccessAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T13:34:56.000Z",
      }),
    );
  });

  test("fetched without validators clears the stored ones", async () => {
    await seed({ a: entry({ etag: "old", lastModified: "old-lm" }) });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    const state = (await collector.state()).subscriptions.a;
    expect(state?.etag).toBeNull();
    expect(state?.lastModified).toBeNull();
    expect(state?.contentHash).toBe("h1");
  });

  test("a failure leaves the last success and the validators alone", async () => {
    await seed({
      a: entry({ etag: "old", lastSuccessAt: "2026-11-07T00:00:00.000Z", contentHash: "h0" }),
    });
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    const state = (await collector.state()).subscriptions.a;
    expect(state?.lastSuccessAt).toBe("2026-11-07T00:00:00.000Z");
    expect(state?.etag).toBe("old");
    expect(state?.contentHash).toBe("h0");
  });

  test("the next fetch time is jittered by up to 10% using the injected random", async () => {
    const results = { "https://a.example/feed.xml": fetched([]) };
    const low = make(fakeSources(results), { random: () => 0 });
    await low.tick([sub("a")]);
    expect((await low.state()).subscriptions.a?.nextFetchAt).toBe("2026-11-08T13:28:56.000Z");

    const high = make(fakeSources(results), { random: () => 0.75 });
    await high.tick([sub("a")]);
    expect((await high.state()).subscriptions.a?.nextFetchAt).toBe("2026-11-08T13:37:56.000Z");
  });

  test("jitter applies to backoff and to unsupported kinds too", async () => {
    const failing = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
    });
    const collector = make(failing, { random: () => 0 });
    await collector.tick([sub("a"), sub("b", { kind: "rule" })]);
    const state = await collector.state();
    expect(state.subscriptions.a?.nextFetchAt).toBe("2026-11-08T14:22:56.000Z");
    expect(state.subscriptions.b?.nextFetchAt).toBe("2026-11-08T13:28:56.000Z");
  });
});

describe("items (behaviours 4 and 5)", () => {
  test("the Parquet file holds the normalised rows with every column and the raw JSON", async () => {
    const full = raw("https://example.com/posts/a", {
      title: "  Hello   World ",
      author: "Ada",
      guid: "g-1",
      publishedAtRaw: "Sat, 09 Aug 2026 03:04:05 GMT",
      contentHtml: '<p>Hi <a href="/next">n</a></p>',
      summary: "Teaser",
    });
    const minimal = raw("/posts/b");
    const harness = fakeSources({
      "https://example.com/feed.xml": fetched([full, minimal]),
    });
    const collector = make(harness);
    await collector.tick([sub("feed-a", { url: "https://example.com/feed.xml" })]);
    await collector.flush();

    const [key] = await storage.list("items/");
    expect(key).toMatch(/^items\/dt=2026-11-08\/20261108T123456Z-[0-9a-f]{4}\.parquet$/);
    const rows = await rowsAt(key as string);
    expect(rows.map((row) => Object.keys(row))).toEqual([COLUMNS, COLUMNS]);
    expect(rows.map(({ raw: _raw, ...rest }) => rest)).toEqual([
      {
        id: ID_A,
        url: "https://example.com/posts/a",
        canonical_url: "https://example.com/posts/a",
        title: "Hello World",
        author: "Ada",
        guid: "g-1",
        published_at: new Date("2026-08-09T03:04:05.000Z"),
        published_at_estimated: false,
        content_html: '<p>Hi <a href="https://example.com/next">n</a></p>',
        summary: "Teaser",
        fetched_at: new Date("2026-11-08T12:34:56.000Z"),
        source_id: "feed-a",
        schema_version: 1,
      },
      {
        id: ID_B,
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
      },
    ]);
    expect(rows.map((row) => JSON.parse(row.raw as string))).toEqual([full, minimal]);
  });

  test("an item without a usable URL is dropped and not counted as seen", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), raw("http://")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    await collector.flush();
    const [key] = await storage.list("items/");
    expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([ID_A]);
    const [runKey] = await storage.list("_runs/");
    const run = await storedJson(runKey as string);
    expect(run.subscriptions).toEqual([{ id: "a", status: "fetched", seen: 1, written: 1 }]);
  });

  test("ids kept in recentIds are skipped, and only the last recentIdsPerSource are kept", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), post("b"), post("c")]),
    });
    const collector = make(harness, { recentIdsPerSource: 2 });
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([ID_B, ID_C]);

    // A has fallen out of the window, so it is written again; B and C are not.
    harness.results["https://a.example/feed.xml"] = fetched([
      post("a"),
      post("b"),
      post("c"),
      post("d"),
    ]);
    advance(3600_000);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([ID_A, ID_D]);

    await collector.flush();
    const [key] = await storage.list("items/");
    expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([
      ID_A,
      ID_B,
      ID_C,
      ID_A,
      ID_D,
    ]);
    const [runKey] = await storage.list("_runs/");
    expect((await storedJson(runKey as string)).subscriptions).toEqual([
      { id: "a", status: "fetched", seen: 3, written: 3 },
      { id: "a", status: "fetched", seen: 4, written: 2 },
    ]);
  });

  test("recentIdsPerSource defaults to 200", async () => {
    const items = Array.from({ length: 201 }, (_, i) => post(`n${i}`));
    const harness = fakeSources({ "https://a.example/feed.xml": fetched(items) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    const recent = (await collector.state()).subscriptions.a?.recentIds;
    expect(recent).toHaveLength(200);
    expect(recent).not.toContain(await idOf("https://example.com/posts/n0"));
  });

  test("two subscriptions each write an item they both carry", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a")]),
      "https://b.example/feed.xml": fetched([post("a")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a"), sub("b")]);
    await collector.flush();
    const [key] = await storage.list("items/");
    expect((await rowsAt(key as string)).map((row) => [row.id, row.source_id])).toEqual([
      [ID_A, "a"],
      [ID_A, "b"],
    ]);
  });

  test("recentIds survive a restart through _state", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const first = make(harness);
    await first.tick([sub("a")]);
    await first.flush();

    advance(3600_000);
    const second = make(harness);
    await second.tick([sub("a")]);
    await second.flush();
    expect(await storage.list("items/")).toHaveLength(1);
    expect(harness.calls).toHaveLength(2);
  });
});

describe("when a flush happens (behaviours 6 and 9)", () => {
  test("a tick flushes only once flushIntervalMs (default 300000) has passed", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a")]),
      "https://b.example/feed.xml": fetched([post("b")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect(await storage.list("")).toEqual([]);

    advance(299_999);
    await collector.tick([sub("a")]);
    expect(await storage.list("")).toEqual([]);

    advance(2);
    await collector.tick([sub("a")]);
    expect(await storage.list("items/")).toHaveLength(1);
    expect(await storage.list("_state/")).toEqual([STATE_KEY]);

    // The interval restarts at the flush.
    advance(1);
    await collector.tick([sub("a"), sub("b")]);
    expect(await storage.list("items/")).toHaveLength(1);
    advance(300_001);
    await collector.tick([sub("a"), sub("b")]);
    expect(await storage.list("items/")).toHaveLength(2);
  });

  test("flushIntervalMs comes from the options", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, { flushIntervalMs: 1000 });
    await collector.tick([sub("a")]);
    advance(1001);
    await collector.tick([sub("a")]);
    expect(await storage.list("items/")).toHaveLength(1);
  });

  test("a subscription fetched in one tick is not fetched again before its nextFetchAt", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    await collector.tick([sub("a")]);
    advance(1800_000);
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);
    advance(1800_000);
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(2);
  });
});

describe("flush output (behaviour 7)", () => {
  test("one flush writes one Parquet file for several ticks and subscriptions, plus _runs and _state", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), post("b")]),
      "https://b.example/feed.xml": { status: "unchanged", reason: "same-content-hash" },
      "https://c.example/feed.xml": { status: "failed", error: "boom", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a"), sub("b")]);
    advance(1000);
    await collector.tick([sub("c")]);
    advance(1000);
    const result = await collector.flush();
    expect(result).not.toBeNull();

    const [itemsKey] = await storage.list("items/");
    const [runKey] = await storage.list("_runs/");
    expect(await storage.list("items/")).toHaveLength(1);
    expect(await storage.list("_runs/")).toHaveLength(1);
    expect((await rowsAt(itemsKey as string)).map((row) => row.id)).toEqual([ID_A, ID_B]);

    const runId = (runKey as string).slice("_runs/".length, -".json".length);
    expect(itemsKey).toBe(`items/dt=2026-11-08/${runId}.parquet`);
    const run = await storedJson(runKey as string);
    expect(run.runId).toBe(runId);
    expect(run.finishedAt).toBe("2026-11-08T12:34:58.000Z");
    expect(typeof run.startedAt).toBe("string");
    expect(run.items).toBe(2);
    expect(run.subscriptions).toEqual([
      { id: "a", status: "fetched", seen: 2, written: 2 },
      { id: "b", status: "unchanged", seen: 0, written: 0 },
      { id: "c", status: "failed", seen: 0, written: 0, error: "boom" },
    ]);
  });

  test("the run id and partition come from the flush time in UTC, fetched_at from the tick", async () => {
    clock = new Date("2026-11-08T23:59:00.000Z");
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, { random: () => 0 });
    await collector.tick([sub("a")]);
    clock = new Date("2026-11-09T00:01:00.000Z");
    await collector.flush();

    expect(await storage.list("items/")).toEqual([
      "items/dt=2026-11-09/20261109T000100Z-0000.parquet",
    ]);
    expect(await storage.list("_runs/")).toEqual(["_runs/20261109T000100Z-0000.json"]);
    const [row] = await rowsAt("items/dt=2026-11-09/20261109T000100Z-0000.parquet");
    expect(row?.fetched_at).toEqual(new Date("2026-11-08T23:59:00.000Z"));
  });

  test("the four hex digits come from random and run ids sort by write time", async () => {
    let value = 0.9;
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a")]),
      "https://b.example/feed.xml": fetched([post("b")]),
    });
    const collector = make(harness, { random: () => value });
    await collector.tick([sub("a")]);
    await collector.flush();
    value = 0;
    advance(1000);
    await collector.tick([sub("b")]);
    await collector.flush();

    const keys = await storage.list("_runs/");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^_runs\/20261108T123456Z-[0-9a-f]{4}\.json$/);
    expect(keys[0]).not.toBe("_runs/20261108T123456Z-0000.json");
    expect(keys[1]).toBe("_runs/20261108T123457Z-0000.json");
  });

  test("_state is written last and holds the advanced state", async () => {
    const puts: string[] = [];
    const recording: Storage = {
      ...storage,
      put: async (key, data) => {
        await storage.put(key, data);
        puts.push(key);
      },
    };
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = createCollector({
      storage: recording,
      fetcher,
      sources: harness.sources,
      now: () => clock,
      random: () => 0.5,
      degradeAfterFailures: 3,
    });
    await collector.tick([sub("a")]);
    await collector.flush();

    expect(puts).toHaveLength(3);
    expect(puts[0]).toStartWith("items/dt=2026-11-08/");
    expect(puts[2]).toBe(STATE_KEY);
    expect(puts.slice(0, 2).some((key) => key.startsWith("_runs/"))).toBe(true);
    const saved = await storedState();
    expect(saved).toEqual(await collector.state());
    expect(saved.subscriptions.a?.recentIds).toEqual([ID_A]);
  });

  test("a flush with only failures and unchanged results writes _runs and _state but no Parquet file", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "boom", retryable: true },
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect(await collector.flush()).not.toBeNull();
    expect(await storage.list("items/")).toEqual([]);
    expect(await storage.list("_runs/")).toHaveLength(1);
    expect((await storedState()).subscriptions.a?.consecutiveFailures).toBe(1);
  });

  test("a flush with nothing fetched since the last one writes nothing and returns null", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    expect(await collector.flush()).toBeNull();
    expect(await storage.list("")).toEqual([]);

    await collector.tick([sub("a")]);
    expect(await collector.flush()).not.toBeNull();
    const written = await storage.list("");
    expect(written).toHaveLength(3);

    advance(400_000);
    await collector.tick([sub("a")]);
    expect(await collector.flush()).toBeNull();
    expect(await storage.list("")).toEqual(written);
  });

  test("ticks with nothing due write nothing even after the flush interval", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    advance(301_000);
    await collector.tick([sub("a", { status: "disabled" })]);
    expect(await storage.list("")).toEqual([]);
  });
});

describe("a failing Parquet write (behaviour 8)", () => {
  test("the error propagates, _state stays unwritten and the next flush retries the same rows", async () => {
    let failing = true;
    const flaky: Storage = {
      ...storage,
      put: async (key, data) => {
        if (failing && key.startsWith("items/")) throw new Error("disk full");
        await storage.put(key, data);
      },
    };
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), post("b")]),
    });
    const collector = createCollector({
      storage: flaky,
      fetcher,
      sources: harness.sources,
      now: () => clock,
      random: () => 0.5,
      degradeAfterFailures: 3,
    });
    await collector.tick([sub("a")]);
    await expect(collector.flush()).rejects.toThrow("disk full");
    expect(await storage.get(STATE_KEY)).toBeNull();
    expect(await storage.list("items/")).toEqual([]);

    // The subscription is still not due, so its rows exist only in the buffer.
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);

    failing = false;
    expect(await collector.flush()).not.toBeNull();
    const [key] = await storage.list("items/");
    expect(await storage.list("items/")).toHaveLength(1);
    expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([ID_A, ID_B]);
    expect((await storedState()).subscriptions.a?.recentIds).toEqual([ID_A, ID_B]);
  });
});

describe("default sources", () => {
  test("without a sources map the feed registry reads real feeds through the fetcher", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>Hello</title><link>https://example.com/posts/hello</link></item></channel></rss>`;
    const collector = createCollector({
      storage,
      fetcher: async () =>
        new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } }),
      now: () => clock,
      random: () => 0.5,
      degradeAfterFailures: 3,
    });
    await collector.tick([sub("a", { url: "https://example.com/feed.xml" })]);
    await collector.flush();
    const [key] = await storage.list("items/");
    const rows = await rowsAt(key as string);
    expect(rows.map((row) => [row.title, row.url, row.source_id])).toEqual([
      ["Hello", "https://example.com/posts/hello", "a"],
    ]);
  });
});

async function idOf(url: string): Promise<string> {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
