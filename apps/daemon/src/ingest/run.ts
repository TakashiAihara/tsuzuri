import { normalizeItem, type Source } from "@tsuzuri/core";
import { type Database, itemSources, items, type SourceRow, sources } from "@tsuzuri/db";
import { and, eq, inArray, lte } from "drizzle-orm";

import type { Fetcher } from "./fetcher.ts";
import { registry } from "./registry.ts";

export type IngestOutcome = {
  sourceId: string;
  status: "fetched" | "unchanged" | "failed";
  /** Items the source produced, after normalisation. */
  seen: number;
  /** Items that were not already stored. */
  inserted: number;
  error?: string;
};

export type IngestDeps = {
  db: Database;
  fetcher: Fetcher;
  now?: () => Date;
  degradeAfterFailures: number;
  signal?: AbortSignal;
};

/** Longest backoff after repeated failures, so a dead feed is still retried daily. */
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;

/**
 * Spread of jitter added to every next_fetch_at.
 *
 * Without it, every subscription added in one OPML import polls in the same
 * second forever, which is both a thundering herd against us and a burst
 * against whichever host owns a chunk of the list.
 */
const JITTER_RATIO = 0.1;

function nextFetchAt(now: Date, intervalSeconds: number): Date {
  const jitter = intervalSeconds * JITTER_RATIO * (Math.random() * 2 - 1);
  return new Date(now.getTime() + (intervalSeconds + jitter) * 1000);
}

function backoffSeconds(intervalSeconds: number, consecutiveFailures: number): number {
  const grown = intervalSeconds * 2 ** Math.min(consecutiveFailures, 10);
  return Math.min(grown, MAX_BACKOFF_SECONDS);
}

/** Strip markup down to the text pgroonga will index. */
function toSearchText(title: string | null, html: string | null, summary: string | null): string {
  const body = html ?? summary ?? "";
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/g, " ");
  return [title ?? "", stripped].join(" ").replace(/\s+/g, " ").trim();
}

function resolveSource(row: SourceRow): Source | null {
  return registry.get(row.kind) ?? null;
}

/**
 * Poll one subscription and persist whatever it produced.
 *
 * Writing items and updating the subscription's own bookkeeping happen in one
 * transaction, so a crash cannot advance the ETag past items that were never
 * stored — which would silently skip them forever.
 */
export async function ingestSource(row: SourceRow, deps: IngestDeps): Promise<IngestOutcome> {
  const now = deps.now?.() ?? new Date();
  const db = deps.db;

  const implementation = resolveSource(row);
  if (!implementation) {
    await db
      .update(sources)
      .set({
        status: "unsupported",
        lastError: `no implementation for kind "${row.kind}"`,
        lastFetchedAt: now,
        nextFetchAt: nextFetchAt(now, row.fetchIntervalSeconds),
        updatedAt: now,
      })
      .where(eq(sources.id, row.id));
    return { sourceId: row.id, status: "failed", seen: 0, inserted: 0, error: "unsupported kind" };
  }

  const result = await implementation.fetchItems({
    url: row.url,
    config: row.config,
    state: { etag: row.etag, lastModified: row.lastModified, contentHash: row.contentHash },
    fetch: deps.fetcher,
    signal: deps.signal ?? AbortSignal.timeout(60_000),
  });

  if (result.status === "failed") {
    const failures = row.consecutiveFailures + 1;
    const interval = result.retryable
      ? backoffSeconds(row.fetchIntervalSeconds, failures)
      : backoffSeconds(row.fetchIntervalSeconds, failures + 2);

    await db
      .update(sources)
      .set({
        consecutiveFailures: failures,
        lastError: result.error,
        lastFetchedAt: now,
        status: failures >= deps.degradeAfterFailures ? "degraded" : row.status,
        nextFetchAt: nextFetchAt(now, interval),
        updatedAt: now,
      })
      .where(eq(sources.id, row.id));

    return { sourceId: row.id, status: "failed", seen: 0, inserted: 0, error: result.error };
  }

  if (result.status === "unchanged") {
    await db
      .update(sources)
      .set({
        consecutiveFailures: 0,
        lastError: null,
        lastFetchedAt: now,
        lastSuccessAt: now,
        status: row.status === "degraded" ? "active" : row.status,
        nextFetchAt: nextFetchAt(now, row.fetchIntervalSeconds),
        updatedAt: now,
      })
      .where(eq(sources.id, row.id));

    return { sourceId: row.id, status: "unchanged", seen: 0, inserted: 0 };
  }

  const normalized = result.items
    .map((raw) => normalizeItem(raw, { baseUrl: row.url, fetchedAt: now }))
    .filter((item) => item !== null);

  let inserted = 0;

  await db.transaction(async (tx) => {
    for (const item of normalized) {
      const rows = await tx
        .insert(items)
        .values({
          id: item.id,
          url: item.url,
          canonicalUrl: item.canonicalUrl,
          title: item.title,
          author: item.author,
          guid: item.guid,
          publishedAt: item.publishedAt,
          publishedAtEstimated: item.publishedAtEstimated,
          contentHtml: item.contentHtml,
          summary: item.summary,
          searchText: toSearchText(item.title, item.contentHtml, item.summary),
          fetchedAt: now,
        })
        // An article already stored is left alone. Publishers do fix typos, but
        // overwriting here would also wipe enrichments derived from the old
        // text; re-extraction belongs in an explicit refresh, not in polling.
        .onConflictDoNothing()
        .returning({ id: items.id });

      if (rows.length > 0) inserted += 1;

      await tx
        .insert(itemSources)
        .values({ itemId: item.id, sourceId: row.id, firstSeenAt: now })
        .onConflictDoNothing();
    }

    await tx
      .update(sources)
      .set({
        etag: result.etag ?? null,
        lastModified: result.lastModified ?? null,
        contentHash: result.contentHash,
        consecutiveFailures: 0,
        lastError: null,
        lastFetchedAt: now,
        lastSuccessAt: now,
        status: row.status === "degraded" ? "active" : row.status,
        nextFetchAt: nextFetchAt(now, row.fetchIntervalSeconds),
        updatedAt: now,
      })
      .where(eq(sources.id, row.id));
  });

  return { sourceId: row.id, status: "fetched", seen: normalized.length, inserted };
}

/**
 * Subscriptions whose next_fetch_at has passed.
 *
 * Built from Drizzle's typed operators rather than a raw sql template: a Date
 * interpolated into a template reaches the driver untyped, and postgres.js
 * cannot serialise it.
 */
export async function dueSources(db: Database, limit: number, now = new Date()) {
  return db
    .select()
    .from(sources)
    .where(and(inArray(sources.status, ["active", "degraded"]), lte(sources.nextFetchAt, now)))
    .orderBy(sources.nextFetchAt)
    .limit(limit);
}
