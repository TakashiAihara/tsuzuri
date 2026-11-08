import type { SourceRow } from "@tsuzuri/db";

import type { CollectorSubscription, SubscriptionFetchState } from "./collector.ts";

export function toSubscription(row: SourceRow): CollectorSubscription {
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    config: row.config,
    fetchIntervalSeconds: row.fetchIntervalSeconds,
    status: row.status,
  };
}

/**
 * The fetch state a sources row already holds, for seeding a collector that
 * has none yet. A disabled row is left out: its status is the user's choice
 * and not a saved collector status, and the collector skips it either way.
 */
export function toSeedEntries(
  rows: SourceRow[],
): Record<string, Omit<SubscriptionFetchState, "recentIds">> {
  const entries: Record<string, Omit<SubscriptionFetchState, "recentIds">> = {};
  for (const row of rows) {
    if (row.status === "disabled") continue;
    entries[row.id] = {
      etag: row.etag,
      lastModified: row.lastModified,
      contentHash: row.contentHash,
      nextFetchAt: row.nextFetchAt.toISOString(),
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.lastError,
      status: row.status,
    };
  }
  return entries;
}
