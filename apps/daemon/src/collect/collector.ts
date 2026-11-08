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
  /** True when the call returned at once because another tick was running or queued. */
  busy: boolean;
};

export type TickOptions = {
  /** Ignore nextFetchAt and any backoff. A disabled subscription is still skipped. */
  force?: boolean;
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
  /**
   * Called, and awaited by flush, after every flush that wrote its _runs
   * record and _state, with or without an items file: a flush of failures
   * alone still changes the fetch state the loader copies to sources.
   */
  onFlush?: (result: FlushResult) => void | Promise<void>;
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
// 16 hex characters keep _state small. A collision would skip a new item —
// it would be lost, not rewritten — but the chance is negligible per
// subscription.
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
// have to keep two flushes inside the same second apart. `nonce` bumps the
// suffix when random() already produced a taken id.
function newRunId(at: Date, random: () => number, nonce = 0): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = (Math.floor(random() * 0x1_0000_0000) + nonce) % 0x1_0000_0000;
  return `${stamp}-${suffix.toString(16).padStart(8, "0")}`;
}

function invalidState(): Error {
  return new Error(`invalid ${STATE_KEY}: expected {"version":1,"subscriptions":{...}}`);
}

const SAVED_STATUSES: ReadonlySet<string> = new Set(["active", "degraded", "unsupported"]);

// Entries are checked one by one: a malformed one is dropped and its
// subscription is then treated as new.
function parseEntry(value: unknown): SubscriptionFetchState | null {
  if (typeof value !== "object" || value === null) return null;
  const saved = value as Record<string, unknown>;
  const { nextFetchAt, consecutiveFailures, status, recentIds } = saved;
  if (typeof nextFetchAt !== "string" || Number.isNaN(Date.parse(nextFetchAt))) {
    return null;
  }
  if (
    typeof consecutiveFailures !== "number" ||
    !Number.isInteger(consecutiveFailures) ||
    consecutiveFailures < 0
  ) {
    return null;
  }
  if (typeof status !== "string" || !SAVED_STATUSES.has(status)) return null;
  return {
    ...(saved as SubscriptionFetchState),
    recentIds: Array.isArray(recentIds) ? recentIds : [],
  };
}

/**
 * Writes _state/collector.json from per-subscription fetch state, only when it
 * is absent. Returns whether it wrote. recentIds starts empty, so each feed's
 * first fetch writes the items it already has once more.
 */
export async function seedState(
  storage: Storage,
  entries: Record<string, Omit<SubscriptionFetchState, "recentIds">>,
): Promise<boolean> {
  // With nothing to seed, the first flush writes the state anyway.
  if (Object.keys(entries).length === 0) return false;
  if ((await storage.get(STATE_KEY)) !== null) return false;
  const subscriptions: Record<string, SubscriptionFetchState> = {};
  for (const [id, entry] of Object.entries(entries)) {
    subscriptions[id] = { ...entry, recentIds: [] };
  }
  const state: CollectorState = { version: 1, subscriptions };
  await storage.put(STATE_KEY, JSON.stringify(state));
  return true;
}

export function parseState(bytes: Uint8Array): CollectorState {
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
    const entry = parseEntry(value);
    if (entry !== null) entries[id] = entry;
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

/** A source's fetch promise settled one way or the other. */
type FetchSettled = { kind: "done"; result: FetchResult } | { kind: "threw"; error: unknown };

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
  const requested = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
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
  // Run ids already used within the current second; reset when the second changes.
  let runIdSecond = "";
  const runIdsThisSecond = new Set<string>();

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
    force: boolean,
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
    if (!force && saved && new Date(saved.nextFetchAt).getTime() > tickStart.getTime()) {
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

    // After shutdown nothing new is started.
    if (deps.signal?.aborted) return { kind: "skip" };

    if (!implementation) {
      return { kind: "unsupported", at: now(), prev: base };
    }

    // The timeout always applies; deps.signal can only abort earlier.
    const timeout = AbortSignal.timeout(fetchTimeoutMs);
    const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
    const fetchPromise = (async (): Promise<FetchSettled> => {
      try {
        const result = await implementation.fetchItems({
          url: sub.url,
          config: sub.config,
          state: {
            etag: prev.etag,
            lastModified: prev.lastModified,
            contentHash: prev.contentHash,
          },
          fetch: deps.fetcher,
          signal,
        });
        return { kind: "done", result };
      } catch (error) {
        return { kind: "threw", error };
      }
    })();

    // The timeout bounds the wait itself, even when the source ignores its
    // signal; a source that settles later is ignored. deps.signal aborting is
    // shutdown, not a failure, so it ends the wait and drops the outcome.
    const settled = await new Promise<FetchSettled | "timeout" | "shutdown">((resolve) => {
      const finish = (value: FetchSettled | "timeout" | "shutdown") => {
        timeout.removeEventListener("abort", onTimeout);
        deps.signal?.removeEventListener("abort", onShutdown);
        resolve(value);
      };
      const onTimeout = () => finish("timeout");
      const onShutdown = () => finish("shutdown");
      timeout.addEventListener("abort", onTimeout);
      if (deps.signal) {
        if (deps.signal.aborted) onShutdown();
        else deps.signal.addEventListener("abort", onShutdown);
      }
      fetchPromise.then(finish);
    });

    if (settled === "shutdown") return { kind: "skip" };
    const at = now();
    if (settled === "timeout") {
      return {
        kind: "threw",
        at,
        prev: base,
        error: new Error(`fetch timed out after ${fetchTimeoutMs} ms`),
      };
    }
    return { ...settled, at, prev: base };
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

    // One item that cannot be normalised or serialised is skipped on its own;
    // it stays out of recentIds, so the next fetch tries it again.
    const normalized = result.items.flatMap((rawItem) => {
      try {
        const item = normalizeItem(rawItem, { baseUrl: sub.url, fetchedAt: at });
        return item === null ? [] : [{ raw: JSON.stringify(rawItem), item }];
      } catch (error) {
        console.error(`collect skipped an item from ${sub.url}:`, error);
        return [];
      }
    });

    // recentIds is rebuilt from the latest fetch alone, so an item still in
    // the feed stays skipped and an item that left it is written again if it
    // returns. A prefix found in the previous fetch skips the row but still
    // lands in the new list.
    const previous = new Set(prev.recentIds);
    const emitted = new Set<string>();
    const recentIds: string[] = [];
    const rows: ItemRow[] = [];
    let written = 0;
    for (const { raw: rawItem, item } of normalized) {
      const prefix = item.id.slice(0, RECENT_ID_PREFIX_LENGTH);
      const skip = previous.has(prefix) || emitted.has(prefix);
      if (!emitted.has(prefix)) {
        emitted.add(prefix);
        recentIds.push(prefix);
      }
      if (skip) continue;
      rows.push({
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
        raw: rawItem,
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
      // An empty page must not make the next good fetch rewrite the feed.
      recentIds: normalized.length === 0 ? prev.recentIds : recentIds,
    };
    for (const row of rows) buffer.push(row);
    return { id: sub.id, status: "fetched", seen: normalized.length, written };
  };

  const tickInner = async (
    subscriptions: CollectorSubscription[],
    force: boolean,
  ): Promise<TickResult> => {
    const state = await loadState();
    const tickStart = now();

    // Once the interval has passed, the flush writes what earlier ticks left
    // pending; this tick's own results wait for the next flush or flush().
    if (now().getTime() - lastFlushAt >= flushIntervalMs) {
      await flushInner();
    }

    // The same id twice in one tick is fetched once, from its first entry.
    const seenIds = new Set<string>();
    const unique = subscriptions.filter((sub) => {
      if (seenIds.has(sub.id)) return false;
      seenIds.add(sub.id);
      return true;
    });

    const outcomes: FetchOutcome[] = new Array(unique.length);

    // Fetches run through a worker pool so at most `concurrency` are in flight;
    // outcomes are applied afterwards in subscription order, which keeps tick
    // results, _runs entries and buffered rows deterministic.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        const index = cursor;
        cursor += 1;
        const sub = unique[index];
        if (sub === undefined) continue;
        outcomes[index] = await runSubscription(sub, state, tickStart, force);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));

    const results: SubscriptionResult[] = [];
    for (let index = 0; index < unique.length; index += 1) {
      const sub = unique[index];
      const outcome = outcomes[index];
      if (sub === undefined || outcome === undefined || outcome.kind === "skip") continue;
      let result: SubscriptionResult;
      try {
        result = applyOutcome(sub, outcome, state);
      } catch (error) {
        // Turning an outcome into state and rows is part of the
        // subscription's work: a failure there is that subscription's
        // retryable failure, and its rows from this fetch stay unbuffered.
        result = applyOutcome(
          sub,
          { kind: "threw", at: outcome.at, prev: outcome.prev, error },
          state,
        );
      }
      if (pendingStartedAt === null || outcome.at.getTime() < pendingStartedAt.getTime()) {
        pendingStartedAt = outcome.at;
      }
      pending.push(result);
      results.push(result);
    }

    return { subscriptions: results, busy: false };
  };

  const flushInner = async (): Promise<FlushResult | null> => {
    const state = await loadState();
    const flushTime = now();

    if (pending.length === 0) {
      lastFlushAt = flushTime.getTime();
      return null;
    }

    // The items file and the _runs record are both named after the run id, so
    // two flushes inside the same second must not share one.
    let nonce = 0;
    let runId = newRunId(flushTime, random, nonce);
    const second = runId.slice(0, runId.indexOf("-"));
    if (second !== runIdSecond) {
      runIdSecond = second;
      runIdsThisSecond.clear();
    }
    while (runIdsThisSecond.has(runId)) {
      nonce += 1;
      runId = newRunId(flushTime, random, nonce);
    }
    runIdsThisSecond.add(runId);
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
    await deps.onFlush?.(run);
    return run;
  };

  // A tick called while another is running or queued does not pile up: it
  // returns empty at once. flush() still queues behind the chain.
  let tickActive = false;
  return {
    tick: (subscriptions: CollectorSubscription[], options?: TickOptions) => {
      if (tickActive) return Promise.resolve<TickResult>({ subscriptions: [], busy: true });
      tickActive = true;
      return enqueue(async () => {
        try {
          return await tickInner(subscriptions, options?.force ?? false);
        } finally {
          tickActive = false;
        }
      });
    },
    flush: () => enqueue(flushInner),
    state: loadState,
  };
}
