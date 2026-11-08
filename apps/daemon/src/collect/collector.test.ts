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
  const failedByAbort: SubscriptionResult[] = [
    { id: "a", status: "failed", seen: 0, written: 0, error: "aborted by signal" },
  ];

  test("fetchTimeoutMs aborts the source's signal even when deps.signal never aborts", async () => {
    const harness = abortWaitingSources();
    const collector = make(harness, {
      signal: new AbortController().signal,
      fetchTimeoutMs: 20,
    });
    const result = await collector.tick([sub("a")]);
    expect(result.subscriptions).toEqual(failedByAbort);
    expect(harness.calls[0]?.signal.aborted).toBe(true);
  });

  test("fetchTimeoutMs applies without a deps.signal too", async () => {
    const harness = abortWaitingSources();
    const collector = make(harness, { fetchTimeoutMs: 20 });
    expect((await collector.tick([sub("a")])).subscriptions).toEqual(failedByAbort);
  });

  test("aborting deps.signal aborts the signal the source sees", async () => {
    const harness = abortWaitingSources();
    const controller = new AbortController();
    const collector = make(harness, { signal: controller.signal });
    const tickPromise = collector.tick([sub("a")]);
    await until(() => harness.calls.length === 1);
    expect(harness.calls[0]?.signal.aborted).toBe(false);
    controller.abort();
    expect((await tickPromise).subscriptions).toEqual(failedByAbort);
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

async function idOf(url: string): Promise<string> {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
