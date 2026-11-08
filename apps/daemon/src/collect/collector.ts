import { normalizeItem, type Source, type SourceKind, type SourceStatus } from "@tsuzuri/core";
import {
  ITEM_SCHEMA,
  ITEM_SCHEMA_VERSION,
  type ItemRow,
  type Storage,
  writeParquet,
} from "@tsuzuri/store";

import type { Fetcher } from "../ingest/fetcher.ts";
import { registry } from "../ingest/registry.ts";

/** A subscription as the caller passes it in: the daemon's sources row, flattened. */
export type CollectorSubscription = {
  id: string;
  kind: SourceKind;
  url: string;
  config: Record<string, unknown>;
  fetchIntervalSeconds: number;
  status: SourceStatus;
};

/** Per-subscription fetch bookkeeping, persisted as _state/collector.json. */
export type SubscriptionFetchState = {
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  nextFetchAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  status: SourceStatus;
  recentIds: string[];
};

export type CollectorState = {
  version: 1;
  subscriptions: Record<string, SubscriptionFetchState>;
};

/** What one subscription's fetch produced, as recorded in a _runs file. */
export type SubscriptionResult = {
  id: string;
  status: "fetched" | "unchanged" | "failed";
  seen: number;
  written: number;
  error?: string;
};

export type TickResult = {
  subscriptions: SubscriptionResult[];
};

/** The _runs/<runId>.json record of one flush. */
export type FlushResult = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  subscriptions: SubscriptionResult[];
  items: number;
};

export type CollectorDeps = {
  storage: Storage;
  fetcher: Fetcher;
  sources?: Map<string, Source>;
  now?: () => Date;
  random?: () => number;
  degradeAfterFailures: number;
  flushIntervalMs?: number;
  recentIdsPerSource?: number;
  signal?: AbortSignal;
};

/** Longest backoff after repeated failures, so a dead feed is still retried daily. */
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;

/**
 * Spread of jitter added to every nextFetchAt.
 *
 * Without it, every subscription added in one OPML import polls in the same
 * second forever, which is both a thundering herd against us and a burst
 * against whichever host owns a chunk of the list.
 */
const JITTER_RATIO = 0.1;

const DEFAULT_FLUSH_INTERVAL_MS = 300_000;
const DEFAULT_RECENT_IDS_PER_SOURCE = 200;
const STATE_KEY = "_state/collector.json";
const FETCH_TIMEOUT_MS = 60_000;

function backoffSeconds(intervalSeconds: number, consecutiveFailures: number): number {
  const grown = intervalSeconds * 2 ** Math.min(consecutiveFailures, 10);
  return Math.min(grown, MAX_BACKOFF_SECONDS);
}

function nextFetchAt(now: Date, intervalSeconds: number, random: () => number): Date {
  const jitter = intervalSeconds * JITTER_RATIO * (random() * 2 - 1);
  return new Date(now.getTime() + (intervalSeconds + jitter) * 1000);
}

// The timestamp keeps run ids sorting by write time; the hex only has to keep
// two flushes inside the same second apart.
function newRunId(at: Date, random: () => number): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = Math.min(0xffff, Math.floor(random() * 0x10000))
    .toString(16)
    .padStart(4, "0");
  return `${stamp}-${suffix}`;
}

/**
 * The collector: polls due subscriptions and appends their items as Parquet.
 *
 * It never touches PostgreSQL — the subscription list arrives as tick()
 * arguments and its own fetch state lives in _state/collector.json. State is
 * read once and then kept in memory; each flush persists it after the Parquet
 * file, so a crash refetches items rather than skipping them past an advanced
 * ETag, the same failure the ingest transaction exists to prevent.
 */
export function createCollector(deps: CollectorDeps) {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const recentIdsPerSource = deps.recentIdsPerSource ?? DEFAULT_RECENT_IDS_PER_SOURCE;
  const sources: ReadonlyMap<string, Source> = deps.sources ?? registry;
  const startedAt = now().getTime();

  let statePromise: Promise<CollectorState> | null = null;
  const loadState = (): Promise<CollectorState> => {
    statePromise ??= deps.storage
      .get(STATE_KEY)
      .then((bytes): CollectorState => {
        if (bytes === null) return { version: 1, subscriptions: {} };
        return JSON.parse(new TextDecoder().decode(bytes)) as CollectorState;
      })
      .catch((error: unknown) => {
        // A failed read must not poison every later call.
        statePromise = null;
        throw error;
      });
    return statePromise;
  };

  let pending: SubscriptionResult[] = [];
  let buffer: ItemRow[] = [];
  let pendingStartedAt: Date | null = null;
  let lastFlushAt = startedAt;

  const fetchSubscription = async (
    sub: CollectorSubscription,
    state: CollectorState,
    tickNow: Date,
  ): Promise<SubscriptionResult | null> => {
    const saved = state.subscriptions[sub.id];
    const effective = saved?.status ?? sub.status;

    // `disabled` is the user's choice and lives on the subscription; the
    // collector never writes it. Every other status is its own, from state.
    if (sub.status === "disabled") return null;
    if (effective !== "active" && effective !== "degraded") return null;
    if (saved && new Date(saved.nextFetchAt).getTime() > tickNow.getTime()) return null;

    const prev: SubscriptionFetchState = saved ?? {
      etag: null,
      lastModified: null,
      contentHash: null,
      nextFetchAt: tickNow.toISOString(),
      lastFetchedAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      status: effective,
      recentIds: [],
    };

    const implementation = sources.get(sub.kind);
    if (!implementation) {
      const lastError = `no implementation for kind "${sub.kind}"`;
      state.subscriptions[sub.id] = {
        ...prev,
        status: "unsupported",
        lastError,
        lastFetchedAt: tickNow.toISOString(),
        nextFetchAt: nextFetchAt(tickNow, sub.fetchIntervalSeconds, random).toISOString(),
      };
      return { id: sub.id, status: "failed", seen: 0, written: 0, error: lastError };
    }

    const result = await implementation.fetchItems({
      url: sub.url,
      config: sub.config,
      state: { etag: prev.etag, lastModified: prev.lastModified, contentHash: prev.contentHash },
      fetch: deps.fetcher,
      signal: deps.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (result.status === "failed") {
      const failures = prev.consecutiveFailures + 1;
      const interval = result.retryable
        ? backoffSeconds(sub.fetchIntervalSeconds, failures)
        : backoffSeconds(sub.fetchIntervalSeconds, failures + 2);
      state.subscriptions[sub.id] = {
        ...prev,
        consecutiveFailures: failures,
        lastError: result.error,
        lastFetchedAt: tickNow.toISOString(),
        status: failures >= deps.degradeAfterFailures ? "degraded" : prev.status,
        nextFetchAt: nextFetchAt(tickNow, interval, random).toISOString(),
      };
      return { id: sub.id, status: "failed", seen: 0, written: 0, error: result.error };
    }

    if (result.status === "unchanged") {
      state.subscriptions[sub.id] = {
        ...prev,
        consecutiveFailures: 0,
        lastError: null,
        lastFetchedAt: tickNow.toISOString(),
        lastSuccessAt: tickNow.toISOString(),
        status: prev.status === "degraded" ? "active" : prev.status,
        nextFetchAt: nextFetchAt(tickNow, sub.fetchIntervalSeconds, random).toISOString(),
      };
      return { id: sub.id, status: "unchanged", seen: 0, written: 0 };
    }

    const normalized = result.items.flatMap((rawItem) => {
      const item = normalizeItem(rawItem, { baseUrl: sub.url, fetchedAt: tickNow });
      return item === null ? [] : [{ raw: rawItem, item }];
    });

    const recentIds = [...prev.recentIds];
    let written = 0;
    for (const { raw: rawItem, item } of normalized) {
      if (recentIds.includes(item.id)) continue;
      recentIds.push(item.id);
      buffer.push({
        id: item.id,
        url: item.url,
        canonical_url: item.canonicalUrl,
        title: item.title,
        author: item.author,
        guid: item.guid,
        published_at: item.publishedAt,
        published_at_estimated: item.publishedAtEstimated,
        content_html: item.contentHtml,
        summary: item.summary,
        fetched_at: tickNow,
        source_id: sub.id,
        schema_version: ITEM_SCHEMA_VERSION,
        raw: JSON.stringify(rawItem),
      });
      written += 1;
    }

    state.subscriptions[sub.id] = {
      ...prev,
      etag: result.etag ?? null,
      lastModified: result.lastModified ?? null,
      contentHash: result.contentHash,
      consecutiveFailures: 0,
      lastError: null,
      lastFetchedAt: tickNow.toISOString(),
      lastSuccessAt: tickNow.toISOString(),
      status: prev.status === "degraded" ? "active" : prev.status,
      nextFetchAt: nextFetchAt(tickNow, sub.fetchIntervalSeconds, random).toISOString(),
      recentIds: recentIds.slice(Math.max(0, recentIds.length - recentIdsPerSource)),
    };
    return { id: sub.id, status: "fetched", seen: normalized.length, written };
  };

  const tick = async (subscriptions: CollectorSubscription[]): Promise<TickResult> => {
    const state = await loadState();
    const tickNow = now();
    const results: SubscriptionResult[] = [];

    for (const sub of subscriptions) {
      let result: SubscriptionResult | null;
      try {
        result = await fetchSubscription(sub, state, tickNow);
      } catch (error) {
        // Same isolation the scheduler gives ingestSource: one broken
        // subscription must not stop the rest. Its state is untouched, so it
        // stays due and is retried on the next tick.
        console.error(`collect failed for ${sub.url}:`, error);
        continue;
      }
      if (result === null) continue;
      pendingStartedAt ??= tickNow;
      pending.push(result);
      results.push(result);
    }

    if (tickNow.getTime() - lastFlushAt >= flushIntervalMs) {
      await flush();
    }
    return { subscriptions: results };
  };

  const flush = async (): Promise<FlushResult | null> => {
    const state = await loadState();
    const flushTime = now();

    if (pending.length === 0) {
      lastFlushAt = flushTime.getTime();
      return null;
    }

    const runId = newRunId(flushTime, random);
    const run: FlushResult = {
      runId,
      startedAt: (pendingStartedAt ?? flushTime).toISOString(),
      finishedAt: flushTime.toISOString(),
      subscriptions: pending,
      items: buffer.length,
    };

    if (buffer.length > 0) {
      const day = flushTime.toISOString().slice(0, 10);
      await deps.storage.put(`items/dt=${day}/${runId}.parquet`, writeParquet(buffer, ITEM_SCHEMA));
    }
    await deps.storage.put(`_runs/${runId}.json`, JSON.stringify(run));
    // _state goes last: it is what advances nextFetchAt past these items, so
    // writing it first would skip them for good after a crash.
    await deps.storage.put(STATE_KEY, JSON.stringify(state));

    pending = [];
    buffer = [];
    pendingStartedAt = null;
    lastFlushAt = flushTime.getTime();
    return run;
  };

  return { tick, flush, state: loadState };
}
