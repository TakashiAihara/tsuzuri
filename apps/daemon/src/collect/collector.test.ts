import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchResult, RawItem, Source, SourceContext } from "@tsuzuri/core";
import { fileStorage, readParquet, type Storage } from "@tsuzuri/store";
// A namespace import: a missing named export would fail every test in this file at load.
import * as collectorModule from "./collector.ts";
import {
  type CollectorState,
  type CollectorSubscription,
  createCollector,
  type FlushResult,
  parseState,
  type SubscriptionFetchState,
  type SubscriptionResult,
} from "./collector.ts";

const T0 = new Date("2026-11-08T12:34:56.000Z");
const STATE_KEY = "_state/collector.json";

// SHA-256 of the canonical URL, taken from normalizeItem's output.
const ID_A = "75aa39e4ad17f2ea3147a5168d35079e5050a1166e4e2a6aff67dcea1451f77d";
const ID_B = "c39a8839222451ee389ef70b6c84492299eaf198e5afd8816fa9e3de421f121e";
const ID_C = "4404d8fc43eda55c76c88199d06d26971450474878aeffcff8c3ed838f5e58e9";
const ID_D = "81edf9f88782bc8507b6ba862dcbe51835f0c87f66e9b1d7a5782ceb25be5126";

// recentIds keeps only the first 16 hex characters of an item id.
const P_A = "75aa39e4ad17f2ea";
const P_B = "c39a8839222451ee";
const P_C = "4404d8fc43eda55c";
const P_D = "81edf9f88782bc85";

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
    const saved = entry({ nextFetchAt: "2026-11-08T13:00:00.000Z", recentIds: [P_A] });
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
    expect(ctx?.signal.aborted).toBe(false);
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

  test("an unsupported subscription without an implementation stays skipped (behaviour I)", async () => {
    const saved = entry({ status: "unsupported", lastError: 'no implementation for kind "rule"' });
    await seed({ a: saved });
    const harness = fakeSources({});
    const collector = make(harness);
    expect((await collector.tick([sub("a", { kind: "rule" })])).subscriptions).toEqual([]);
    expect(harness.calls).toHaveLength(0);
    expect((await collector.state()).subscriptions.a).toEqual(saved);
  });

  test("a saved unsupported status is retried once an implementation exists and then counts as active (behaviour I)", async () => {
    await seed({
      a: entry({ status: "unsupported", lastError: 'no implementation for kind "feed"' }),
    });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        status: "active",
        contentHash: "h1",
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        lastSuccessAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T13:34:56.000Z",
      }),
    );
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
        recentIds: [P_A],
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
        recentIds: [P_A],
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
    expect(key).toMatch(/^items\/dt=2026-11-08\/20261108T123456Z-80000000\.parquet$/);
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

  test("an item whose 16-character prefix is in the previous recentIds is skipped (behaviours B, L)", async () => {
    await seed({ a: entry({ recentIds: [P_A] }) });
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), post("b")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    await collector.flush();
    const [key] = await storage.list("items/");
    expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([ID_B]);
    const [runKey] = await storage.list("_runs/");
    expect((await storedJson(runKey as string)).subscriptions).toEqual([
      { id: "a", status: "fetched", seen: 2, written: 1 },
    ]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([P_A, P_B]);
  });

  test("recentIds are 16-hex prefixes, deduplicated, in feed order (behaviour B)", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("c"), post("a"), post("c"), post("b")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    await collector.flush();
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([P_C, P_A, P_B]);
    const [key] = await storage.list("items/");
    expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([ID_C, ID_A, ID_B]);
    const [runKey] = await storage.list("_runs/");
    const run = await storedJson(runKey as string);
    expect((run.subscriptions as { written: number }[])[0]?.written).toBe(3);
  });

  test("recentIds hold only the latest fetched result, so an item that left the feed is written again (behaviour B)", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), post("b")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([P_A, P_B]);

    harness.results["https://a.example/feed.xml"] = fetched([post("c")]);
    advance(3600_000);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([P_C]);

    harness.results["https://a.example/feed.xml"] = fetched([post("a"), post("c"), post("d")]);
    advance(3600_000);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([P_A, P_C, P_D]);

    await collector.flush();
    // Ticks an hour apart each flush on their own (the interval is 5 minutes), so
    // the rows are spread over several files in write order.
    const rows: Record<string, unknown>[] = [];
    for (const key of await storage.list("items/")) rows.push(...(await rowsAt(key)));
    expect(rows.map((row) => row.id)).toEqual([ID_A, ID_B, ID_C, ID_A, ID_D]);
  });

  test("a collector that fetches on every tick still flushes once the interval has passed", async () => {
    const harness = fakeSources({});
    const collector = make(harness, { flushIntervalMs: 1000 });
    // Ticks at 0, 600, 1200 (flush), 1800, 2400 (flush), 3000 ms.
    for (let i = 0; i < 6; i++) {
      harness.results[`https://s${i}.example/feed.xml`] = fetched([post(`p${i}`)]);
      await collector.tick([sub(`s${i}`)]);
      advance(600);
    }
    expect(await storage.list("items/")).toHaveLength(2);
  });

  test("a failed or unchanged fetch keeps the previous recentIds (behaviour B)", async () => {
    await seed({ a: entry({ recentIds: [P_A, P_B] }), b: entry({ recentIds: [P_C] }) });
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "failed", error: "x", retryable: true },
      "https://b.example/feed.xml": { status: "unchanged", reason: "not-modified" },
    });
    const collector = make(harness);
    await collector.tick([sub("a"), sub("b")]);
    const state = await collector.state();
    expect(state.subscriptions.a?.recentIds).toEqual([P_A, P_B]);
    expect(state.subscriptions.b?.recentIds).toEqual([P_C]);
  });

  test("a 300-item feed that gains one item at the front writes exactly that one row (behaviours B, L)", async () => {
    const names = Array.from({ length: 300 }, (_, i) => `n${299 - i}`);
    const harness = fakeSources({ "https://a.example/feed.xml": fetched(names.map(post)) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    await collector.flush();
    const firstIds = await Promise.all(
      names.map((name) => idOf(`https://example.com/posts/${name}`)),
    );
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual(
      firstIds.map((id) => id.slice(0, 16)),
    );

    harness.results["https://a.example/feed.xml"] = fetched(["n300", ...names].map(post));
    advance(3600_000);
    await collector.tick([sub("a")]);
    await collector.flush();

    const keys = await storage.list("items/");
    expect(keys).toHaveLength(2);
    const second = await rowsAt(keys[1] ?? "");
    expect(second.map((row) => row.title)).toEqual(["n300"]);
    const runKeys = await storage.list("_runs/");
    expect((await storedJson(runKeys[1] as string)).subscriptions).toEqual([
      { id: "a", status: "fetched", seen: 301, written: 1 },
    ]);
    const newId = await idOf("https://example.com/posts/n300");
    const recent = (await collector.state()).subscriptions.a?.recentIds;
    expect(recent).toHaveLength(301);
    expect(recent?.[0]).toBe(newId.slice(0, 16));
    expect(recent?.[1]).toBe((firstIds[0] as string).slice(0, 16));
    expect(recent?.[300]).toBe((firstIds[299] as string).slice(0, 16));
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

  test("a flush with nothing to write still restarts the interval", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, { flushIntervalMs: 1000 });
    advance(5000);
    expect(await collector.flush()).toBeNull();
    advance(10);
    await collector.tick([sub("a")]);
    expect(await storage.list("items/")).toEqual([]);
    advance(1000);
    await collector.tick([]);
    expect(await storage.list("items/")).toHaveLength(1);
  });

  test("each flush writes only the rows buffered since the previous one", async () => {
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a")]),
      "https://b.example/feed.xml": fetched([post("b")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    await collector.flush();
    advance(1000);
    await collector.tick([sub("b")]);
    await collector.flush();

    const keys = await storage.list("items/");
    expect(keys).toHaveLength(2);
    const second = await rowsAt(keys[1] ?? "");
    expect(second.map((row) => row.title)).toEqual(["b"]);
  });

  test("a subscription whose source throws does not stop the others in the same tick", async () => {
    const harness = fakeSources({ "https://b.example/feed.xml": fetched([post("b")]) });
    const collector = make(harness);
    await collector.tick([sub("a"), sub("b")]);
    await collector.flush();

    expect(harness.calls.map((ctx) => ctx.url)).toEqual([
      "https://a.example/feed.xml",
      "https://b.example/feed.xml",
    ]);
    const keys = await storage.list("items/");
    expect((await rowsAt(keys[0] ?? "")).map((row) => row.title)).toEqual(["b"]);
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
      "items/dt=2026-11-09/20261109T000100Z-00000000.parquet",
    ]);
    expect(await storage.list("_runs/")).toEqual(["_runs/20261109T000100Z-00000000.json"]);
    const [row] = await rowsAt("items/dt=2026-11-09/20261109T000100Z-00000000.parquet");
    expect(row?.fetched_at).toEqual(new Date("2026-11-08T23:59:00.000Z"));
  });

  test("the eight hex digits are floor(random * 2^32) and run ids sort by write time", async () => {
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
    expect(keys[0]).toBe("_runs/20261108T123456Z-e6666666.json");
    expect(keys[1]).toBe("_runs/20261108T123457Z-00000000.json");
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
    expect(saved.subscriptions.a?.recentIds).toEqual([P_A]);
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
    expect((await storedState()).subscriptions.a?.recentIds).toEqual([P_A, P_B]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls for at most ~1s so a broken implementation fails instead of hanging.
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error("condition not reached");
}

// Each fetch blocks until the test opens its gate; a gate left closed rejects
// after 3s so nothing can hang forever.
function gatedSources() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let inFlight = 0;
  let maxInFlight = 0;
  const source: Source = {
    kind: "feed",
    id: "gated",
    fetchItems: async (ctx) => {
      started.push(ctx.url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("gate never opened")), 3000);
          gates.set(ctx.url, () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } finally {
        inFlight -= 1;
      }
      return fetched([post(new URL(ctx.url).hostname.split(".")[0] ?? "x")]);
    },
  };
  return {
    sources: new Map<string, Source>([["feed", source]]),
    calls: [] as SourceContext[],
    results: {} as Record<string, FetchResult>,
    started,
    maxInFlight: () => maxInFlight,
    open: (url: string) => {
      const gate = gates.get(url);
      if (!gate) throw new Error(`gate for ${url} not waiting`);
      gate();
    },
    openAll: () => {
      for (const gate of gates.values()) gate();
    },
  };
}

// The source returns only when its signal aborts, with a 1s bound of its own.
function abortWaitingSources() {
  const calls: SourceContext[] = [];
  const source: Source = {
    kind: "feed",
    id: "abort-waiting",
    fetchItems: (ctx) =>
      new Promise<FetchResult>((_resolve, reject) => {
        calls.push(ctx);
        const timer = setTimeout(() => reject(new Error("signal never aborted")), 1000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("aborted by signal"));
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      }),
  };
  return { sources: new Map<string, Source>([["feed", source]]), calls, results: {} };
}

// Advances the shared clock by 10s just before each fetch returns.
function clockAdvancingSources() {
  const source: Source = {
    kind: "feed",
    id: "advancing",
    fetchItems: async (ctx) => {
      advance(10_000);
      return fetched([post(new URL(ctx.url).hostname.split(".")[0] ?? "x")]);
    },
  };
  return {
    sources: new Map<string, Source>([["feed", source]]),
    calls: [] as SourceContext[],
    results: {} as Record<string, FetchResult>,
  };
}

describe("serialised tick and flush (behaviour A)", () => {
  test("a flush called while a tick is in flight waits for it and writes its row", async () => {
    const gated = gatedSources();
    const collector = make(gated);
    try {
      const tickPromise = collector.tick([sub("a")]);
      await until(() => gated.started.length === 1);
      const flushPromise = collector.flush();
      gated.open("https://a.example/feed.xml");
      const [tickResult, flushResult] = await Promise.all([tickPromise, flushPromise]);

      const expected: SubscriptionResult[] = [{ id: "a", status: "fetched", seen: 1, written: 1 }];
      expect(tickResult.subscriptions).toEqual(expected);
      expect(flushResult?.subscriptions).toEqual(expected);
      expect(flushResult?.items).toBe(1);

      const keys = await storage.list("items/");
      expect(keys).toHaveLength(1);
      expect((await rowsAt(keys[0] as string)).map((row) => row.id)).toEqual([ID_A]);
      expect(await storage.list("_runs/")).toHaveLength(1);
      const saved = (await storedState()).subscriptions.a;
      expect(saved?.nextFetchAt).toBe("2026-11-08T13:34:56.000Z");
      expect(saved?.recentIds).toEqual([P_A]);
    } finally {
      gated.openAll();
    }
  });

  test("two overlapping ticks fetch a subscription once and lose no result", async () => {
    const gated = gatedSources();
    const collector = make(gated);
    try {
      const first = collector.tick([sub("a")]);
      const second = collector.tick([sub("a")]);
      await until(() => gated.started.length === 1);
      await sleep(30);
      expect(gated.started).toHaveLength(1);
      gated.open("https://a.example/feed.xml");
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(gated.started).toHaveLength(1);
      expect(firstResult.subscriptions).toEqual([
        { id: "a", status: "fetched", seen: 1, written: 1 },
      ]);
      expect(secondResult.subscriptions).toEqual([]);
      await collector.flush();
      const [key] = await storage.list("items/");
      expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([ID_A]);
    } finally {
      gated.openAll();
    }
  });

  test("two overlapping flushes write once", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    const results = await Promise.all([collector.flush(), collector.flush()]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await storage.list("items/")).toHaveLength(1);
    expect(await storage.list("_runs/")).toHaveLength(1);
  });
});

describe("per-subscription times (behaviour C)", () => {
  test("each subscription's fetched_at, lastFetchedAt and nextFetchAt are read when its fetch completes", async () => {
    const harness = clockAdvancingSources();
    const collector = make(harness, { concurrency: 1 });
    await collector.tick([sub("a"), sub("b")]);
    await collector.flush();

    const state = await collector.state();
    expect(state.subscriptions.a).toMatchObject({
      lastFetchedAt: "2026-11-08T12:35:06.000Z",
      lastSuccessAt: "2026-11-08T12:35:06.000Z",
      nextFetchAt: "2026-11-08T13:35:06.000Z",
    });
    expect(state.subscriptions.b).toMatchObject({
      lastFetchedAt: "2026-11-08T12:35:16.000Z",
      lastSuccessAt: "2026-11-08T12:35:16.000Z",
      nextFetchAt: "2026-11-08T13:35:16.000Z",
    });
    const [key] = await storage.list("items/");
    const rows = await rowsAt(key as string);
    expect(rows.map((row) => [row.source_id, row.fetched_at])).toEqual([
      ["a", new Date("2026-11-08T12:35:06.000Z")],
      ["b", new Date("2026-11-08T12:35:16.000Z")],
    ]);
  });
});

describe("concurrency (behaviour D)", () => {
  test("at most `concurrency` fetches are in flight and results keep the input order", async () => {
    const gated = gatedSources();
    const collector = make(gated, { concurrency: 2 });
    try {
      const tickPromise = collector.tick([sub("a"), sub("b"), sub("c"), sub("d")]);
      await until(() => gated.started.length === 2);
      await sleep(30);
      expect(gated.started).toHaveLength(2);

      // Release the second one first, so completion order differs from input order.
      gated.open(gated.started[1] as string);
      await until(() => gated.started.length === 3);
      await sleep(30);
      expect(gated.started).toHaveLength(3);
      gated.open(gated.started[2] as string);
      await until(() => gated.started.length === 4);
      gated.openAll();
      const result = await tickPromise;

      expect(gated.maxInFlight()).toBe(2);
      expect(result.subscriptions.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
      const run = await collector.flush();
      expect(run?.subscriptions.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
      const [runKey] = await storage.list("_runs/");
      expect((await storedJson(runKey as string)).subscriptions as { id: string }[]).toHaveLength(
        4,
      );
    } finally {
      gated.openAll();
    }
  });

  test("the default concurrency is 4", async () => {
    const gated = gatedSources();
    const collector = make(gated);
    try {
      const subs = ["a", "b", "c", "d", "e", "f"].map((id) => sub(id));
      const tickPromise = collector.tick(subs);
      await until(() => gated.started.length === 4);
      await sleep(30);
      expect(gated.started).toHaveLength(4);
      gated.openAll();
      await until(() => gated.started.length === 6);
      gated.openAll();
      await tickPromise;
      expect(gated.maxInFlight()).toBe(4);
    } finally {
      gated.openAll();
    }
  });
});

describe("fetch timeout and signal (behaviour E)", () => {
  // The source's own rejection and the collector's deadline race, so only the
  // outcome is pinned here; behaviour P pins the message.
  const failedA = [{ id: "a", status: "failed", seen: 0, written: 0 }];

  test("fetchTimeoutMs aborts the source's signal even when deps.signal never aborts", async () => {
    const harness = abortWaitingSources();
    const collector = make(harness, {
      signal: new AbortController().signal,
      fetchTimeoutMs: 20,
    });
    const result = await collector.tick([sub("a")]);
    expect(result.subscriptions).toMatchObject(failedA);
    expect(harness.calls[0]?.signal.aborted).toBe(true);
  });

  test("fetchTimeoutMs applies without a deps.signal too", async () => {
    const harness = abortWaitingSources();
    const collector = make(harness, { fetchTimeoutMs: 20 });
    expect((await collector.tick([sub("a")])).subscriptions).toMatchObject(failedA);
  });

  test("aborting deps.signal aborts the signal the source sees", async () => {
    const harness = abortWaitingSources();
    const controller = new AbortController();
    const collector = make(harness, { signal: controller.signal });
    const tickPromise = collector.tick([sub("a")]);
    await until(() => harness.calls.length === 1);
    expect(harness.calls[0]?.signal.aborted).toBe(false);
    controller.abort();
    expect((await tickPromise).subscriptions).toEqual([]);
    expect(harness.calls[0]?.signal.aborted).toBe(true);
  });
});

describe("state file validation (behaviours F and G)", () => {
  const invalid: [string, unknown][] = [
    ["a wrong version", { version: 2, subscriptions: {} }],
    ["a missing version", { subscriptions: {} }],
    ["missing subscriptions", { version: 1 }],
    ["null subscriptions", { version: 1, subscriptions: null }],
    ["a string subscriptions", { version: 1, subscriptions: "x" }],
    ["an array of subscriptions", { version: 1, subscriptions: [] }],
  ];

  for (const [name, content] of invalid) {
    test(`${name} is rejected on read`, async () => {
      await storage.put(STATE_KEY, JSON.stringify(content));
      const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
      await expect(make(harness).state()).rejects.toThrow("invalid _state/collector.json");
      await expect(make(harness).tick([sub("a")])).rejects.toThrow("invalid _state/collector.json");
      expect(harness.calls).toHaveLength(0);
    });
  }

  test("an entry without recentIds is read as an empty list", async () => {
    const { recentIds: _recentIds, ...legacy } = entry();
    await storage.put(STATE_KEY, JSON.stringify({ version: 1, subscriptions: { a: legacy } }));
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([]);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a?.recentIds).toEqual([P_A]);
  });

  test("a state file rejected as invalid is read again by the next call", async () => {
    await storage.put(STATE_KEY, JSON.stringify({ version: 2, subscriptions: {} }));
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    await expect(collector.state()).rejects.toThrow("invalid _state/collector.json");
    await seed({ a: entry({ nextFetchAt: "2026-11-08T13:00:00.000Z" }) });
    expect((await collector.state()).subscriptions.a?.nextFetchAt).toBe("2026-11-08T13:00:00.000Z");
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(0);
  });

  test("a failed read is retried by the next tick, flush and state call", async () => {
    let failGet = true;
    const flakyGet: Storage = {
      ...storage,
      get: async (key) => {
        if (failGet && key === STATE_KEY) throw new Error("read failed");
        return storage.get(key);
      },
    };
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const build = () =>
      createCollector({
        storage: flakyGet,
        fetcher,
        sources: harness.sources,
        now: () => clock,
        random: () => 0.5,
        degradeAfterFailures: 3,
      });

    const ticking = build();
    await expect(ticking.tick([sub("a")])).rejects.toThrow("read failed");
    const flushing = build();
    await expect(flushing.flush()).rejects.toThrow("read failed");
    const reading = build();
    await expect(reading.state()).rejects.toThrow("read failed");
    expect(harness.calls).toHaveLength(0);

    failGet = false;
    expect((await ticking.tick([sub("a")])).subscriptions).toEqual([
      { id: "a", status: "fetched", seen: 1, written: 1 },
    ]);
    expect(await flushing.flush()).toBeNull();
    expect(await reading.state()).toEqual({ version: 1, subscriptions: {} });
  });
});

describe("a source that throws (behaviour H)", () => {
  const error = "no scripted result for https://a.example/feed.xml";

  test("counts as a retryable failure with the thrown message and is backed off", async () => {
    const harness = fakeSources({});
    const collector = make(harness);
    const result = await collector.tick([sub("a")]);
    expect(result.subscriptions).toEqual([
      { id: "a", status: "failed", seen: 0, written: 0, error },
    ]);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        consecutiveFailures: 1,
        lastError: error,
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T14:34:56.000Z",
      }),
    );

    // Not retried on the next tick.
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);

    await collector.flush();
    const [runKey] = await storage.list("_runs/");
    expect((await storedJson(runKey as string)).subscriptions).toEqual([
      { id: "a", status: "failed", seen: 0, written: 0, error },
    ]);
    expect((await storedState()).subscriptions.a?.consecutiveFailures).toBe(1);
  });

  test("degrades the subscription at the threshold", async () => {
    await seed({ a: entry({ consecutiveFailures: 2 }) });
    const collector = make(fakeSources({}));
    await collector.tick([sub("a")]);
    const saved = (await collector.state()).subscriptions.a;
    expect(saved?.status).toBe("degraded");
    expect(saved?.consecutiveFailures).toBe(3);
    expect(saved?.nextFetchAt).toBe("2026-11-08T20:34:56.000Z");
  });
});

describe("run id (behaviour J)", () => {
  async function runKeyFor(random: () => number): Promise<string> {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, { random });
    await collector.tick([sub("a")]);
    await collector.flush();
    const [key] = await storage.list("_runs/");
    await rm(join(dir, "_runs"), { recursive: true, force: true });
    await rm(join(dir, "items"), { recursive: true, force: true });
    await rm(join(dir, "_state"), { recursive: true, force: true });
    return key as string;
  }

  test("the suffix is floor(random * 2^32) as 8 zero-padded hex digits", async () => {
    expect(await runKeyFor(() => 0.5)).toBe("_runs/20261108T123456Z-80000000.json");
    expect(await runKeyFor(() => 0.9)).toBe("_runs/20261108T123456Z-e6666666.json");
    expect(await runKeyFor(() => 1 / 4294967296)).toBe("_runs/20261108T123456Z-00000001.json");
    expect(await runKeyFor(() => 0)).toBe("_runs/20261108T123456Z-00000000.json");
  });
});

describe("_runs startedAt (behaviour K)", () => {
  test("startedAt is the first fetch since the previous flush and finishedAt the flush time", async () => {
    const harness = clockAdvancingSources();
    const collector = make(harness, { concurrency: 1 });
    await collector.tick([sub("a"), sub("b")]);
    const first = await collector.flush();
    expect(first?.startedAt).toBe("2026-11-08T12:35:06.000Z");
    expect(first?.finishedAt).toBe("2026-11-08T12:35:16.000Z");

    advance(60_000);
    await collector.tick([sub("c")]);
    const second = await collector.flush();
    expect(second?.startedAt).toBe("2026-11-08T12:36:26.000Z");
    expect(second?.finishedAt).toBe("2026-11-08T12:36:26.000Z");
    const keys = await storage.list("_runs/");
    expect((await storedJson(keys[1] as string)).startedAt).toBe("2026-11-08T12:36:26.000Z");
  });

  test("a tick in which nothing is due does not start a run", async () => {
    const harness = fakeSources({ "https://b.example/feed.xml": fetched([post("b")]) });
    const collector = make(harness);
    await collector.tick([sub("a", { status: "disabled" })]);
    advance(1000);
    await collector.tick([sub("b")]);
    advance(1000);
    const run = await collector.flush();
    expect(run?.startedAt).toBe("2026-11-08T12:34:57.000Z");
    expect(run?.finishedAt).toBe("2026-11-08T12:34:58.000Z");
  });
});

describe("_runs written (behaviour L)", () => {
  test("written counts the new rows buffered for that subscription, not the rows seen", async () => {
    await seed({ a: entry({ recentIds: [P_A, P_B] }) });
    const harness = fakeSources({
      "https://a.example/feed.xml": fetched([post("a"), post("b"), post("c")]),
      "https://b.example/feed.xml": fetched([post("a"), post("b")]),
    });
    const collector = make(harness);
    await collector.tick([sub("a"), sub("b")]);
    const run = await collector.flush();
    expect(run?.subscriptions).toEqual([
      { id: "a", status: "fetched", seen: 3, written: 1 },
      { id: "b", status: "fetched", seen: 2, written: 2 },
    ]);
    expect(run?.items).toBe(3);
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

function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

describe("one item that cannot be turned into a row (behaviour M)", () => {
  const bigint = Object.assign(post("y"), { big: 10n }) as RawItem;
  const getter = raw("https://example.com/posts/g");
  Object.defineProperty(getter, "title", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });
  const cases: [string, FetchResult][] = [
    ["raw JSON that cannot be serialised", fetched([post("x"), bigint])],
    ["an item whose getter throws", fetched([post("x"), getter])],
  ];

  for (const [name, broken] of cases) {
    test(`${name} is skipped on its own; the rest of the fetch is written`, async () => {
      const harness = fakeSources({
        "https://a.example/feed.xml": broken,
        "https://b.example/feed.xml": fetched([post("b")]),
      });
      const collector = make(harness);
      const result = await within(collector.tick([sub("a"), sub("b")]));
      expect(result.subscriptions).toEqual([
        { id: "a", status: "fetched", seen: 1, written: 1 },
        { id: "b", status: "fetched", seen: 1, written: 1 },
      ]);
      const state = await collector.state();
      expect(state.subscriptions.a?.recentIds).toHaveLength(1);
      expect(state.subscriptions.a?.consecutiveFailures).toBe(0);

      await collector.flush();
      const keys = await storage.list("items/");
      expect((await rowsAt(keys[0] as string)).map((row) => row.title)).toEqual(["x", "b"]);
    });
  }

  test("a failure outside the items fails that subscription only, as a retryable failure", async () => {
    const poisoned = { status: "fetched", items: [post("x")] } as unknown as FetchResult;
    Object.defineProperty(poisoned, "contentHash", {
      enumerable: true,
      get() {
        throw new Error("contentHash boom");
      },
    });
    const harness = fakeSources({
      "https://a.example/feed.xml": poisoned,
      "https://b.example/feed.xml": fetched([post("b")]),
    });
    const collector = make(harness);
    const result = await within(collector.tick([sub("a"), sub("b")]));
    expect(result.subscriptions).toEqual([
      { id: "a", status: "failed", seen: 0, written: 0, error: "contentHash boom" },
      { id: "b", status: "fetched", seen: 1, written: 1 },
    ]);
    expect((await collector.state()).subscriptions.a).toMatchObject({
      consecutiveFailures: 1,
      nextFetchAt: "2026-11-08T14:34:56.000Z",
    });
    await collector.flush();
    const keys = await storage.list("items/");
    expect((await rowsAt(keys[0] as string)).map((row) => row.title)).toEqual(["b"]);
  });
});

describe("state entries are validated one by one (behaviour N)", () => {
  const future = "2026-11-08T13:00:00.000Z";
  const base = entry({ nextFetchAt: future, recentIds: [P_A], etag: "old" });
  const { nextFetchAt: _dropped, ...withoutNextFetchAt } = base;
  const malformed: [string, unknown][] = [
    ["a string", "oops"],
    ["null", null],
    ["a number", 7],
    ["an unparseable nextFetchAt", { ...base, nextFetchAt: "garbage" }],
    ["a missing nextFetchAt", withoutNextFetchAt],
    ["negative consecutiveFailures", { ...base, consecutiveFailures: -1 }],
    ["fractional consecutiveFailures", { ...base, consecutiveFailures: 1.5 }],
    ["string consecutiveFailures", { ...base, consecutiveFailures: "2" }],
    ["an unknown status", { ...base, status: "weird" }],
    ["a disabled status", { ...base, status: "disabled" }],
  ];

  for (const [name, value] of malformed) {
    test(`an entry that is ${name} is dropped and the subscription is fetched as new`, async () => {
      await storage.put(
        STATE_KEY,
        JSON.stringify({
          version: 1,
          subscriptions: { a: value, b: entry({ nextFetchAt: future }) },
        }),
      );
      const harness = fakeSources({
        "https://a.example/feed.xml": fetched([post("a")]),
        "https://b.example/feed.xml": fetched([post("b")]),
      });
      const collector = make(harness);
      const loaded = await collector.state();
      expect(loaded.subscriptions.a).toBeUndefined();
      expect(loaded.subscriptions.b).toEqual(entry({ nextFetchAt: future }));

      const result = await collector.tick([sub("a"), sub("b")]);
      expect(result.subscriptions).toEqual([{ id: "a", status: "fetched", seen: 1, written: 1 }]);
      expect(harness.calls.map((ctx) => ctx.url)).toEqual(["https://a.example/feed.xml"]);
      expect(harness.calls[0]?.state.etag).toBeNull();
    });
  }

  test("a recentIds that is not an array reads as an empty list", async () => {
    const odd = [
      ["a string", "abc"],
      ["an object", { "0": P_A }],
      ["a number", 3],
    ] as const;
    for (const [, recentIds] of odd) {
      await storage.put(
        STATE_KEY,
        JSON.stringify({ version: 1, subscriptions: { a: { ...entry(), recentIds } } }),
      );
      const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
      const collector = make(harness);
      expect((await collector.state()).subscriptions.a?.recentIds).toEqual([]);
      expect((await collector.tick([sub("a")])).subscriptions).toEqual([
        { id: "a", status: "fetched", seen: 1, written: 1 },
      ]);
    }
  });
});

describe("a shutdown abort is not a failure (behaviour O)", () => {
  const saved = entry({ etag: "old", recentIds: [P_B], consecutiveFailures: 1 });

  async function expectUntouched(
    collector: ReturnType<typeof make>,
    before: CollectorState,
    result: { subscriptions: SubscriptionResult[] },
  ): Promise<void> {
    expect(result.subscriptions).toEqual([]);
    expect(await collector.state()).toEqual(before);
    expect(await collector.flush()).toBeNull();
    expect(await storage.list("")).toEqual([STATE_KEY]);
  }

  test("a fetch that rejects after deps.signal aborted leaves state, results and rows alone", async () => {
    await seed({ a: saved });
    const harness = abortWaitingSources();
    const controller = new AbortController();
    const collector = make(harness, { signal: controller.signal });
    const before = structuredClone(await collector.state());
    const tickPromise = collector.tick([sub("a")]);
    await until(() => harness.calls.length === 1);
    controller.abort();
    await expectUntouched(collector, before, await within(tickPromise));
  });

  test("a fetch that resolves with items after deps.signal aborted is discarded", async () => {
    await seed({ a: saved });
    const controller = new AbortController();
    const source: Source = {
      kind: "feed",
      id: "abort-then-resolve",
      fetchItems: async () => {
        controller.abort();
        return fetched([post("a")]);
      },
    };
    const harness = { sources: new Map([["feed", source]]), calls: [], results: {} };
    const collector = make(harness, { signal: controller.signal });
    const before = structuredClone(await collector.state());
    await expectUntouched(collector, before, await within(collector.tick([sub("a")])));
  });

  test("a source error after deps.signal aborted is not recorded as a failure", async () => {
    await seed({ a: saved });
    const controller = new AbortController();
    const source: Source = {
      kind: "feed",
      id: "abort-then-throw",
      fetchItems: async () => {
        controller.abort();
        throw new Error("socket closed");
      },
    };
    const harness = { sources: new Map([["feed", source]]), calls: [], results: {} };
    const collector = make(harness, { signal: controller.signal });
    const before = structuredClone(await collector.state());
    await expectUntouched(collector, before, await within(collector.tick([sub("a")])));
  });
});

describe("a signal aborted before the fetch starts (behaviour O)", () => {
  test("ends the wait at once even when the source ignores its signal", async () => {
    const hang: Source = {
      kind: "feed",
      id: "hang",
      fetchItems: () => new Promise<FetchResult>(() => {}),
    };
    const harness = { sources: new Map([["feed", hang]]), calls: [], results: {} };
    const controller = new AbortController();
    controller.abort();
    const collector = make(harness, { signal: controller.signal, fetchTimeoutMs: 60_000 });
    const result = await within(collector.tick([sub("a")]));
    expect(result.subscriptions).toEqual([]);
    expect((await collector.state()).subscriptions.a).toBeUndefined();
  });
});

describe("the timeout bounds the fetch itself (behaviour P)", () => {
  test("a source that never settles and ignores its signal is a timed out failure and does not block a flush", async () => {
    const hang: Source = {
      kind: "feed",
      id: "hang",
      fetchItems: () => new Promise<FetchResult>(() => {}),
    };
    const harness = { sources: new Map([["feed", hang]]), calls: [], results: {} };
    const collector = make(harness, { fetchTimeoutMs: 20 });
    const result = await within(collector.tick([sub("a")]));
    expect(result.subscriptions).toEqual([
      {
        id: "a",
        status: "failed",
        seen: 0,
        written: 0,
        error: expect.stringContaining("timed out"),
      },
    ]);
    expect((await collector.state()).subscriptions.a).toMatchObject({
      consecutiveFailures: 1,
      nextFetchAt: "2026-11-08T14:34:56.000Z",
    });
    const run = await within(collector.flush());
    expect(run?.subscriptions).toHaveLength(1);
    expect(await storage.list("_runs/")).toHaveLength(1);
  });

  test("a source that settles after its timeout is ignored", async () => {
    let release: (result: FetchResult) => void = () => {};
    const late: Source = {
      kind: "feed",
      id: "late",
      fetchItems: () =>
        new Promise<FetchResult>((resolve) => {
          release = resolve;
        }),
    };
    const harness = { sources: new Map([["feed", late]]), calls: [], results: {} };
    const collector = make(harness, { fetchTimeoutMs: 20 });
    await within(collector.tick([sub("a")]));
    release(fetched([post("a")]));
    await sleep(30);
    await collector.flush();
    expect(await storage.list("items/")).toEqual([]);
    expect((await collector.state()).subscriptions.a?.consecutiveFailures).toBe(1);
  });
});

describe("overlapping ticks (behaviour Q)", () => {
  test("a tick called while another runs returns at once without fetching, and a flush still waits", async () => {
    const gated = gatedSources();
    const collector = make(gated);
    try {
      const first = collector.tick([sub("a")]);
      await until(() => gated.started.length === 1);
      const second = await within(collector.tick([sub("b")]));
      expect(second).toEqual({ subscriptions: [], busy: true });
      await sleep(30);
      expect(gated.started).toEqual(["https://a.example/feed.xml"]);

      const flushPromise = collector.flush();
      gated.open("https://a.example/feed.xml");
      await within(first);
      const run = await within(flushPromise);
      expect(run?.items).toBe(1);
      expect(gated.started).toEqual(["https://a.example/feed.xml"]);
      const [key] = await storage.list("items/");
      expect((await rowsAt(key as string)).map((row) => row.id)).toEqual([ID_A]);
    } finally {
      gated.openAll();
    }
  });

  test("a tick called while a flush is in flight queues behind it and runs", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    const flushing = collector.flush();
    const ticking = collector.tick([sub("a")]);
    await within(flushing);
    expect((await within(ticking)).subscriptions).toHaveLength(1);
  });

  test("a NaN concurrency still fetches", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, { concurrency: Number.NaN });
    expect((await within(collector.tick([sub("a")]))).subscriptions).toHaveLength(1);
  });

  test("three flushes in one second get three distinct run ids", async () => {
    const harness = fakeSources({});
    const collector = make(harness, { random: () => 0 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      harness.results[`https://s${i}.example/feed.xml`] = fetched([post(`p${i}`)]);
      await collector.tick([sub(`s${i}`)]);
      const run = await collector.flush();
      ids.push(run?.runId ?? "");
    }
    expect(new Set(ids).size).toBe(3);
    expect(await storage.list("items/")).toHaveLength(3);
  });

  test("after shutdown a remaining subscription's source is not called", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const controller = new AbortController();
    controller.abort();
    const collector = make(harness, { signal: controller.signal });
    await within(collector.tick([sub("a"), sub("b", { kind: "rule" })]));
    expect(harness.calls).toHaveLength(0);
    expect((await collector.state()).subscriptions).toEqual({});
  });
});

describe("an empty fetch keeps recentIds (behaviour R)", () => {
  test("zero items keep the previous recentIds and the next fetch of the same items writes nothing", async () => {
    await seed({ a: entry({ recentIds: [P_A, P_B], contentHash: "h0" }) });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([]) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    expect((await collector.state()).subscriptions.a).toEqual(
      entry({
        recentIds: [P_A, P_B],
        contentHash: "h1",
        lastFetchedAt: "2026-11-08T12:34:56.000Z",
        lastSuccessAt: "2026-11-08T12:34:56.000Z",
        nextFetchAt: "2026-11-08T13:34:56.000Z",
      }),
    );

    harness.results["https://a.example/feed.xml"] = fetched([post("a"), post("b")]);
    advance(3600_000);
    const result = await collector.tick([sub("a")]);
    expect(result.subscriptions).toEqual([{ id: "a", status: "fetched", seen: 2, written: 0 }]);
    const run = await collector.flush();
    expect(run?.items).toBe(0);
    expect(await storage.list("items/")).toEqual([]);
  });
});

describe("the same id twice in one tick (behaviour S)", () => {
  test("is fetched once, from the first occurrence", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    const result = await collector.tick([
      sub("a"),
      sub("a", { url: "https://dup.example/feed.xml" }),
    ]);
    expect(result.subscriptions).toEqual([{ id: "a", status: "fetched", seen: 1, written: 1 }]);
    expect(harness.calls.map((ctx) => ctx.url)).toEqual(["https://a.example/feed.xml"]);
    await collector.flush();
    const keys = await storage.list("items/");
    expect(keys).toHaveLength(1);
    expect((await rowsAt(keys[0] as string)).map((row) => row.id)).toEqual([ID_A]);
    const run = (await storedJson((await storage.list("_runs/"))[0] as string)).subscriptions;
    expect(run).toHaveLength(1);
  });
});

describe("_runs startedAt is the earliest result (behaviour T)", () => {
  test("with concurrency 2 and the first subscription finishing last, startedAt is the second's time", async () => {
    const gated = gatedSources();
    const collector = make(gated, { concurrency: 2 });
    try {
      const tickPromise = collector.tick([sub("a"), sub("b")]);
      await until(() => gated.started.length === 2);
      advance(1000);
      gated.open("https://b.example/feed.xml");
      await sleep(30);
      advance(1000);
      gated.open("https://a.example/feed.xml");
      const result = await within(tickPromise);
      expect(result.subscriptions.map((entry) => entry.id)).toEqual(["a", "b"]);

      const run = await collector.flush();
      expect(run?.startedAt).toBe("2026-11-08T12:34:57.000Z");
      expect(run?.finishedAt).toBe("2026-11-08T12:34:58.000Z");
      const state = await collector.state();
      expect(state.subscriptions.b?.lastFetchedAt).toBe("2026-11-08T12:34:57.000Z");
      expect(state.subscriptions.a?.lastFetchedAt).toBe("2026-11-08T12:34:58.000Z");
    } finally {
      gated.openAll();
    }
  });
});

describe("concurrency below 1 (behaviour U)", () => {
  for (const concurrency of [0, -3]) {
    test(`concurrency ${concurrency} still fetches, one at a time`, async () => {
      const gated = gatedSources();
      const collector = make(gated, { concurrency });
      try {
        const tickPromise = collector.tick([sub("a"), sub("b")]);
        await until(() => gated.started.length === 1);
        await sleep(30);
        expect(gated.started).toHaveLength(1);
        gated.open("https://a.example/feed.xml");
        await until(() => gated.started.length === 2);
        gated.open("https://b.example/feed.xml");
        const result = await within(tickPromise);
        expect(result.subscriptions.map((entry) => entry.status)).toEqual(["fetched", "fetched"]);
        expect(gated.maxInFlight()).toBe(1);
      } finally {
        gated.openAll();
      }
    });
  }
});

describe("a flush that fails after the Parquet write (behaviour V)", () => {
  function failingOnce(prefix: string) {
    const puts: string[] = [];
    let failed = false;
    const wrapped: Storage = {
      ...storage,
      put: async (key, data) => {
        puts.push(key);
        if (!failed && key.startsWith(prefix)) {
          failed = true;
          throw new Error("put failed");
        }
        await storage.put(key, data);
      },
    };
    return { wrapped, puts };
  }

  function collectorOn(wrapped: Storage, harness: Harness) {
    return createCollector({
      storage: wrapped,
      fetcher,
      sources: harness.sources,
      now: () => clock,
      random: () => 0.5,
      degradeAfterFailures: 3,
    });
  }

  test("a failing _runs write keeps the rows and the retry writes a second file, then _runs and _state", async () => {
    const { wrapped, puts } = failingOnce("_runs/");
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a"), post("b")]) });
    const collector = collectorOn(wrapped, harness);
    await collector.tick([sub("a")]);
    await expect(collector.flush()).rejects.toThrow("put failed");
    expect(await storage.get(STATE_KEY)).toBeNull();
    expect(await storage.list("_runs/")).toEqual([]);
    expect(await storage.list("items/")).toHaveLength(1);

    advance(1000);
    const run = await collector.flush();
    expect(run?.items).toBe(2);
    expect(run?.subscriptions).toEqual([{ id: "a", status: "fetched", seen: 2, written: 2 }]);
    expect(puts.map((key) => key.split("/")[0])).toEqual([
      "items",
      "_runs",
      "items",
      "_runs",
      "_state",
    ]);

    const keys = await storage.list("items/");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(`items/dt=2026-11-08/${run?.runId}.parquet`);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) {
      expect((await rowsAt(key)).map((row) => row.id)).toEqual([ID_A, ID_B]);
    }
    expect(await storage.list("_runs/")).toEqual([`_runs/${run?.runId}.json`]);
    expect((await storedState()).subscriptions.a?.recentIds).toEqual([P_A, P_B]);
  });

  test("a failing _state write keeps the rows and the retry writes them again under a new run id", async () => {
    const { wrapped, puts } = failingOnce("_state/");
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a"), post("b")]) });
    const collector = collectorOn(wrapped, harness);
    await collector.tick([sub("a")]);
    await expect(collector.flush()).rejects.toThrow("put failed");
    expect(await storage.get(STATE_KEY)).toBeNull();

    advance(1000);
    const run = await collector.flush();
    expect(run?.items).toBe(2);
    expect(puts.map((key) => key.split("/")[0])).toEqual([
      "items",
      "_runs",
      "_state",
      "items",
      "_runs",
      "_state",
    ]);
    const keys = await storage.list("items/");
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect((await rowsAt(key)).map((row) => row.id)).toEqual([ID_A, ID_B]);
    }
    expect(await storage.list("_runs/")).toHaveLength(2);
    expect((await storedState()).subscriptions.a?.recentIds).toEqual([P_A, P_B]);
  });
});

async function idOf(url: string): Promise<string> {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("parseState (exported for the loader)", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  test("returns the valid entries and drops a malformed one", () => {
    const parsed = parseState(
      bytes({ version: 1, subscriptions: { a: entry(), b: { nextFetchAt: "garbage" } } }),
    );
    expect(Object.keys(parsed.subscriptions)).toEqual(["a"]);
    expect(parsed.subscriptions.a).toEqual(entry());
  });

  test("refuses a file that is not version 1 or not JSON", () => {
    expect(() => parseState(bytes({ version: 2, subscriptions: {} }))).toThrow(
      "invalid _state/collector.json",
    );
    expect(() => parseState(new TextEncoder().encode("{not json"))).toThrow(
      "invalid _state/collector.json",
    );
  });
});

describe("force (step 2c)", () => {
  test("force fetches a subscription that is not due yet, and a plain tick does not", async () => {
    await seed({ a: entry({ nextFetchAt: "2026-11-08T13:00:00.000Z", etag: "e-saved" }) });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);

    await collector.tick([sub("a")]);
    await collector.tick([sub("a")], { force: false });
    expect(harness.calls).toHaveLength(0);

    const forced = await collector.tick([sub("a")], { force: true });
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.state.etag).toBe("e-saved");
    expect(forced.subscriptions).toEqual([{ id: "a", status: "fetched", seen: 1, written: 1 }]);
    // The forced fetch reschedules from now, not from the old nextFetchAt.
    expect((await collector.state()).subscriptions.a?.nextFetchAt).toBe("2026-11-08T13:34:56.000Z");
  });

  test("force fetches a subscription whose saved backoff has not elapsed, and success clears it", async () => {
    await seed({
      a: entry({
        nextFetchAt: "2026-11-09T12:34:56.000Z",
        consecutiveFailures: 2,
        lastError: "HTTP 503",
      }),
    });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    await collector.tick([sub("a")], { force: true });
    expect(harness.calls).toHaveLength(1);
    const saved = (await collector.state()).subscriptions.a;
    expect(saved?.consecutiveFailures).toBe(0);
    expect(saved?.lastError).toBeNull();
  });

  test("a disabled subscription is skipped even under force, and its saved state is left alone", async () => {
    const savedOff = entry({ nextFetchAt: "2026-11-08T13:00:00.000Z", etag: "off-etag" });
    // b is not due either, so only force can make the collector fetch it.
    await seed({ off: savedOff, b: entry({ nextFetchAt: "2026-11-08T15:00:00.000Z" }) });
    const harness = fakeSources({
      "https://off.example/feed.xml": fetched([post("off")]),
      "https://b.example/feed.xml": fetched([post("b")]),
    });
    const collector = make(harness);
    const result = await collector.tick([sub("off", { status: "disabled" }), sub("b")], {
      force: true,
    });
    expect(harness.calls.map((ctx) => ctx.url)).toEqual(["https://b.example/feed.xml"]);
    expect(result.subscriptions.map((r) => r.id)).toEqual(["b"]);
    expect((await collector.state()).subscriptions.off).toEqual(savedOff);
  });
});

describe("busy (step 2c)", () => {
  test("a tick that ran reports busy false, with or without results", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    expect((await collector.tick([sub("a")])).busy).toBe(false);
    expect(await collector.tick([])).toEqual({ subscriptions: [], busy: false });
  });

  test("a tick called while another is in flight reports busy true, and the running one reports false", async () => {
    const gated = gatedSources();
    const collector = make(gated);
    try {
      const first = collector.tick([sub("a")]);
      await until(() => gated.started.length === 1);
      const second = await within(collector.tick([sub("b")]));
      expect(second.busy).toBe(true);
      expect(second.subscriptions).toEqual([]);

      gated.open("https://a.example/feed.xml");
      const finished = await within(first);
      expect(finished.busy).toBe(false);
      expect(finished.subscriptions).toHaveLength(1);

      // Once the first is done the collector is free again.
      expect((await within(collector.tick([]))).busy).toBe(false);
    } finally {
      gated.openAll();
    }
  });

  test("a tick queued behind a flush is not busy", async () => {
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);
    const flushing = collector.flush();
    const ticking = collector.tick([sub("a")]);
    await within(flushing);
    expect((await within(ticking)).busy).toBe(false);
  });
});

describe("onFlush (step 2c)", () => {
  test("a flush that wrote an items file calls onFlush once with the FlushResult it returns", async () => {
    const seen: FlushResult[] = [];
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a"), post("b")]) });
    const collector = make(harness, { onFlush: (result) => void seen.push(result) });
    await collector.tick([sub("a")]);
    expect(seen).toEqual([]);

    const run = await collector.flush();
    expect(run?.items).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(run as FlushResult);
  });

  test("onFlush runs after the items file, the _runs record and _state are all written", async () => {
    const observed: { items: string[]; runs: string[]; state: boolean }[] = [];
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, {
      onFlush: async () => {
        observed.push({
          items: await storage.list("items/"),
          runs: await storage.list("_runs/"),
          state: (await storage.get(STATE_KEY)) !== null,
        });
      },
    });
    await collector.tick([sub("a")]);
    const run = await collector.flush();
    expect(observed).toEqual([
      {
        items: [`items/dt=2026-11-08/${run?.runId}.parquet`],
        runs: [`_runs/${run?.runId}.json`],
        state: true,
      },
    ]);
  });

  test("an empty flush does not call onFlush", async () => {
    let calls = 0;
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, {
      onFlush: () => {
        calls += 1;
      },
    });
    expect(await collector.flush()).toBeNull();
    expect(calls).toBe(0);
    await collector.tick([sub("a")]);
    await collector.flush();
    expect(calls).toBe(1);
    expect(await collector.flush()).toBeNull();
    expect(calls).toBe(1);
  });

  test("a flush with no new items, only an unchanged fetch, still calls onFlush", async () => {
    const seen: FlushResult[] = [];
    const harness = fakeSources({
      "https://a.example/feed.xml": { status: "unchanged", reason: "not-modified" },
    });
    const collector = make(harness, { onFlush: (result) => void seen.push(result) });

    await collector.tick([sub("a")]);
    await collector.flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.items).toBe(0);
    expect(seen[0]?.subscriptions.map((s) => s.status)).toEqual(["unchanged"]);
  });

  test("a flush the interval triggers inside a tick calls onFlush as well", async () => {
    const seen: FlushResult[] = [];
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, {
      flushIntervalMs: 1000,
      onFlush: (result) => void seen.push(result),
    });
    await collector.tick([sub("a")]);
    expect(seen).toEqual([]);
    advance(2000);
    await collector.tick([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.items).toBe(1);
    expect(seen[0]?.subscriptions.map((r) => r.id)).toEqual(["a"]);
  });

  test("flush resolves only after an asynchronous onFlush has finished", async () => {
    let finished = false;
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness, {
      onFlush: async () => {
        await sleep(50);
        finished = true;
      },
    });
    await collector.tick([sub("a")]);
    await collector.flush();
    expect(finished).toBe(true);
  });

  test("a flush whose items write fails does not call onFlush", async () => {
    let calls = 0;
    const flaky: Storage = {
      ...storage,
      put: async (key, data) => {
        if (key.startsWith("items/")) throw new Error("disk full");
        await storage.put(key, data);
      },
    };
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = createCollector({
      storage: flaky,
      fetcher,
      sources: harness.sources,
      now: () => clock,
      random: () => 0.5,
      degradeAfterFailures: 3,
      onFlush: () => {
        calls += 1;
      },
    });
    await collector.tick([sub("a")]);
    await expect(collector.flush()).rejects.toThrow("disk full");
    expect(calls).toBe(0);
  });
});

describe("seedState (step 2c)", () => {
  // The fetch-state columns of a sources row, as the daemon passes them.
  const seedEntry = (extra: Partial<Omit<SubscriptionFetchState, "recentIds">> = {}) => ({
    etag: "seed-etag",
    lastModified: "Mon, 02 Nov 2026 00:00:00 GMT",
    contentHash: "seed-hash",
    nextFetchAt: "2026-11-08T14:00:00.000Z",
    lastFetchedAt: "2026-11-08T13:00:00.000Z",
    lastSuccessAt: "2026-11-08T13:00:00.000Z",
    consecutiveFailures: 0,
    lastError: null,
    status: "active" as const,
    ...extra,
  });

  test("writes _state/collector.json when it is absent, with empty recentIds, and returns true", async () => {
    const degraded = seedEntry({
      consecutiveFailures: 4,
      lastError: "HTTP 503",
      status: "degraded",
    });
    const wrote = await collectorModule.seedState(storage, { a: seedEntry(), b: degraded });
    expect(wrote).toBe(true);
    expect(await storedState()).toEqual({
      version: 1,
      subscriptions: {
        a: { ...seedEntry(), recentIds: [] },
        b: { ...degraded, recentIds: [] },
      },
    });
  });

  test("leaves an existing _state/collector.json untouched and returns false", async () => {
    await seed({ kept: entry({ recentIds: [P_A], etag: "kept-etag" }) });
    const before = await storage.get(STATE_KEY);
    const wrote = await collectorModule.seedState(storage, { a: seedEntry() });
    expect(wrote).toBe(false);
    expect(await storage.get(STATE_KEY)).toEqual(before);
    expect((await storedState()).subscriptions.a).toBeUndefined();
  });

  test("a second seed does not overwrite the first", async () => {
    expect(await collectorModule.seedState(storage, { a: seedEntry({ etag: "first" }) })).toBe(
      true,
    );
    expect(await collectorModule.seedState(storage, { a: seedEntry({ etag: "second" }) })).toBe(
      false,
    );
    expect((await storedState()).subscriptions.a?.etag).toBe("first");
  });

  test("a collector treats a seeded subscription as not due until its nextFetchAt, then sends its validators", async () => {
    await collectorModule.seedState(storage, { a: seedEntry() });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a")]) });
    const collector = make(harness);

    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(0);

    // 12:34:56 + 24 min 4 s = 12:59:00, still before 14:00.
    advance(24 * 60_000 + 4_000);
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(0);

    // 14:00:00 exactly.
    advance(61 * 60_000);
    await collector.tick([sub("a")]);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.state).toEqual({
      etag: "seed-etag",
      lastModified: "Mon, 02 Nov 2026 00:00:00 GMT",
      contentHash: "seed-hash",
    });
  });

  test("the first fetch after seeding writes the feed's items again, since recentIds starts empty", async () => {
    await collectorModule.seedState(storage, {
      a: seedEntry({ nextFetchAt: "2026-11-08T12:00:00.000Z" }),
    });
    const harness = fakeSources({ "https://a.example/feed.xml": fetched([post("a"), post("b")]) });
    const collector = make(harness);
    await collector.tick([sub("a")]);
    const run = await collector.flush();
    expect(run?.items).toBe(2);
    expect((await storedState()).subscriptions.a?.recentIds).toEqual([P_A, P_B]);
  });
});
