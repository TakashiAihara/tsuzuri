import {
  type FetchResult,
  normalizeItem,
  type Source,
  type SourceKind,
  type SourceStatus,
} from "@tsuzuri/core";
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
  /** New rows this fetch buffered for the run that the next flush writes. */
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
  /** At most this many fetches are in flight within one tick. */
  concurrency?: number;
  /** Per-fetch abort deadline, always combined with deps.signal. */
  fetchTimeoutMs?: number;
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
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const STATE_KEY = "_state/collector.json";
// 16 hex characters keep _state small while collisions stay rare enough that
// a rewritten row is harmless (loader inserts are idempotent per row).
const RECENT_ID_PREFIX_LENGTH = 16;

function backoffSeconds(intervalSeconds: number, consecutiveFailures: number): number {
  const grown = intervalSeconds * 2 ** Math.min(consecutiveFailures, 10);
  return Math.min(grown, MAX_BACKOFF_SECONDS);
}

function nextFetchAt(now: Date, intervalSeconds: number, random: () => number): Date {
  const jitter = intervalSeconds * JITTER_RATIO * (random() * 2 - 1);
  return new Date(now.getTime() + (intervalSeconds + jitter) * 1000);
}

// The timestamp keeps run ids sorting by write time; the 32 bits of hex only
// have to keep two flushes inside the same second apart.
function newRunId(at: Date, random: () => number): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = Math.floor(random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
  return `${stamp}-${suffix}`;
}

function invalidState(): Error {
  return new Error(`invalid ${STATE_KEY}: expected {"version":1,"subscriptions":{...}}`);
}

function parseState(bytes: Uint8Array): CollectorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidState();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalidState();
  const { version, subscriptions } = parsed as {
    version?: unknown;
    subscriptions?: unknown;
  };
  if (
    version !== 1 ||
    typeof subscriptions !== "object" ||
    subscriptions === null ||
    Array.isArray(subscriptions)
  ) {
    throw invalidState();
  }
  const entries: Record<string, SubscriptionFetchState> = {};
  for (const [id, value] of Object.entries(subscriptions)) {
    const saved = (
      typeof value === "object" && value !== null ? value : {}
    ) as Partial<SubscriptionFetchState>;
    entries[id] = {
      ...(saved as SubscriptionFetchState),
      recentIds: Array.isArray(saved.recentIds) ? saved.recentIds : [],
    };
  }
  return { version: 1, subscriptions: entries };
}

/** What one subscription's fetch attempt produced, before results are ordered. */
type FetchOutcome =
  | { kind: "skip" }
  | { kind: "unsupported"; at: Date; prev: SubscriptionFetchState }
  | { kind: "done"; at: Date; prev: SubscriptionFetchState; result: FetchResult }
  | { kind: "threw"; at: Date; prev: SubscriptionFetchState; error: unknown };

type CompletedFetch = Exclude<FetchOutcome, { kind: "skip" }>;

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
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const sources: ReadonlyMap<string, Source> = deps.sources ?? registry;
  const startedAt = now().getTime();

  let statePromise: Promise<CollectorState> | null = null;
  const loadState = (): Promise<CollectorState> => {
    statePromise ??= deps.storage
      .get(STATE_KEY)
      .then((bytes): CollectorState => {
        if (bytes === null) return { version: 1, subscriptions: {} };
        return parseState(bytes);
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

  // One chain serialises every tick and flush: a flush called while a tick's
  // fetches are in flight waits for them, so no row or result is lost or
  // written twice. The flush a tick triggers runs inside the tick's own slot.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const runSubscription = async (
    sub: CollectorSubscription,
    state: CollectorState,
    tickStart: Date,
  ): Promise<FetchOutcome> => {
    const saved = state.subscriptions[sub.id];
    const effective = saved?.status ?? sub.status;

    // `disabled` is the user's choice and lives on the subscription; the
    // collector never writes it. Every other status is its own, from state.
    if (sub.status === "disabled") return { kind: "skip" };

    const implementation = sources.get(sub.kind);
    // A saved "unsupported" is retried once an implementation exists; without
    // one it stays skipped and its saved state is left untouched.
    const eligible =
      effective === "active" ||
      effective === "degraded" ||
      (effective === "unsupported" && implementation !== undefined);
    if (!eligible) return { kind: "skip" };
    if (saved && new Date(saved.nextFetchAt).getTime() > tickStart.getTime()) {
      return { kind: "skip" };
    }

    const prev: SubscriptionFetchState = saved ?? {
      etag: null,
      lastModified: null,
      contentHash: null,
      nextFetchAt: tickStart.toISOString(),
      lastFetchedAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      status: effective,
      recentIds: [],
    };
    // A revived "unsupported" is processed exactly like an active one.
    const base: SubscriptionFetchState =
      effective === "unsupported" ? { ...prev, status: "active" } : prev;

    if (!implementation) {
      return { kind: "unsupported", at: now(), prev: base };
    }

    // The timeout always applies; deps.signal can only abort earlier.
    const timeout = AbortSignal.timeout(fetchTimeoutMs);
    const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
    let result: FetchResult;
    try {
      result = await implementation.fetchItems({
        url: sub.url,
        config: sub.config,
        state: { etag: prev.etag, lastModified: prev.lastModified, contentHash: prev.contentHash },
        fetch: deps.fetcher,
        signal,
      });
    } catch (error) {
      return { kind: "threw", at: now(), prev: base, error };
    }
    return { kind: "done", at: now(), prev: base, result };
  };

  const applyOutcome = (
    sub: CollectorSubscription,
    outcome: CompletedFetch,
    state: CollectorState,
  ): SubscriptionResult => {
    const at = outcome.at;
    const prev = outcome.prev;

    if (outcome.kind === "unsupported") {
      const lastError = `no implementation for kind "${sub.kind}"`;
      state.subscriptions[sub.id] = {
        ...prev,
        status: "unsupported",
        lastError,
        lastFetchedAt: at.toISOString(),
        nextFetchAt: nextFetchAt(at, sub.fetchIntervalSeconds, random).toISOString(),
      };
      return { id: sub.id, status: "failed", seen: 0, written: 0, error: lastError };
    }

    // A source that throws is a retryable failure with the thrown message.
    const result: FetchResult =
      outcome.kind === "threw"
        ? {
            status: "failed",
            error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            retryable: true,
          }
        : outcome.result;

    if (result.status === "failed") {
      const failures = prev.consecutiveFailures + 1;
      const interval = result.retryable
        ? backoffSeconds(sub.fetchIntervalSeconds, failures)
        : backoffSeconds(sub.fetchIntervalSeconds, failures + 2);
      state.subscriptions[sub.id] = {
        ...prev,
        consecutiveFailures: failures,
        lastError: result.error,
        lastFetchedAt: at.toISOString(),
        status: failures >= deps.degradeAfterFailures ? "degraded" : prev.status,
        nextFetchAt: nextFetchAt(at, interval, random).toISOString(),
      };
      return { id: sub.id, status: "failed", seen: 0, written: 0, error: result.error };
    }

    if (result.status === "unchanged") {
      state.subscriptions[sub.id] = {
        ...prev,
        consecutiveFailures: 0,
        lastError: null,
        lastFetchedAt: at.toISOString(),
        lastSuccessAt: at.toISOString(),
        status: prev.status === "degraded" ? "active" : prev.status,
        nextFetchAt: nextFetchAt(at, sub.fetchIntervalSeconds, random).toISOString(),
      };
      return { id: sub.id, status: "unchanged", seen: 0, written: 0 };
    }

    const normalized = result.items.flatMap((rawItem) => {
      const item = normalizeItem(rawItem, { baseUrl: sub.url, fetchedAt: at });
      return item === null ? [] : [{ raw: rawItem, item }];
    });

    // recentIds is the prefix set of this fetch alone: feeds list newest first,
    // so a rolling window would drop the newest ids first. A prefix from the
    // previous fetch skips the row but still lands in the new list, which is
    // what lets an item that left the feed be written again.
    const previous = new Set(prev.recentIds);
    const emitted = new Set<string>();
    const recentIds: string[] = [];
    let written = 0;
    for (const { raw: rawItem, item } of normalized) {
      const prefix = item.id.slice(0, RECENT_ID_PREFIX_LENGTH);
      const skip = previous.has(prefix) || emitted.has(prefix);
      if (!emitted.has(prefix)) {
        emitted.add(prefix);
        recentIds.push(prefix);
      }
      if (skip) continue;
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
        fetched_at: at,
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
      lastFetchedAt: at.toISOString(),
      lastSuccessAt: at.toISOString(),
      status: prev.status === "degraded" ? "active" : prev.status,
      nextFetchAt: nextFetchAt(at, sub.fetchIntervalSeconds, random).toISOString(),
      recentIds,
    };
    return { id: sub.id, status: "fetched", seen: normalized.length, written };
  };

  const tickInner = async (subscriptions: CollectorSubscription[]): Promise<TickResult> => {
    const state = await loadState();
    const tickStart = now();
    const outcomes: FetchOutcome[] = new Array(subscriptions.length);

    // Fetches run through a worker pool so at most `concurrency` are in flight;
    // outcomes are applied afterwards in subscription order, which keeps tick
    // results, _runs entries and buffered rows deterministic.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < subscriptions.length) {
        const index = cursor;
        cursor += 1;
        const sub = subscriptions[index];
        if (sub === undefined) continue;
        outcomes[index] = await runSubscription(sub, state, tickStart);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, subscriptions.length) }, () => worker()),
    );

    const results: SubscriptionResult[] = [];
    for (let index = 0; index < subscriptions.length; index += 1) {
      const sub = subscriptions[index];
      const outcome = outcomes[index];
      if (sub === undefined || outcome === undefined || outcome.kind === "skip") continue;
      const result = applyOutcome(sub, outcome, state);
      pendingStartedAt ??= outcome.at;
      pending.push(result);
      results.push(result);
    }

    if (now().getTime() - lastFlushAt >= flushIntervalMs) {
      await flushInner();
    }
    return { subscriptions: results };
  };

  const flushInner = async (): Promise<FlushResult | null> => {
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

  return {
    tick: (subscriptions: CollectorSubscription[]) => enqueue(() => tickInner(subscriptions)),
    flush: () => enqueue(flushInner),
    state: loadState,
  };
}
