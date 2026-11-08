import { sha256 } from "@tsuzuri/core";
import {
  applyItemObject,
  forgetLoadedObjects,
  type LoadRow,
  loadedKeys,
  type SourceFetchStateRow,
  syncSourceFetchState,
} from "@tsuzuri/db";
import { ITEM_SCHEMA_VERSION, readParquet, type Storage } from "@tsuzuri/store";
import type postgres from "postgres";

import { parseState } from "../collect/collector.ts";
import { toSearchText } from "../ingest/run.ts";

/**
 * The loader: derives PostgreSQL's items, item_sources and sources fetch
 * state from what the collector wrote to storage. Nothing calls it yet —
 * wiring into the daemon and `tsuzuri rebuild` is a later step.
 *
 * loaded_objects is the ledger that makes loadPending cheap to repeat: a key
 * it records is skipped, and forgetLoadedObjects (reload) makes every object
 * pending again. Objects apply in the order the storage keys sort, which is
 * write order, and within an object by fetched_at. When the same item id
 * shows up twice with different content, the first applied copy is the one
 * items keeps (ON CONFLICT DO NOTHING), matching docs/parquet-schema.md. To
 * keep that order, an object whose apply fails stops the run: applying the
 * later keys first would let a later copy win.
 */

export type LoadResult = {
  /** Storage objects applied this run. */
  objects: number;
  inserted: number;
  linked: number;
  /** Rows refused by validation, across all applied objects. */
  rejected: number;
  /** Objects that could not be read; they stay pending for the next run. */
  failed: number;
};

export type LoaderDeps = {
  sql: postgres.Sql;
  storage: Storage;
  log: (message: string) => void;
};

const ITEMS_PREFIX = "items/";
const STATE_KEY = "_state/collector.json";
const ITEM_ID = /^[0-9a-f]{64}$/;

export function createLoader(deps: LoaderDeps) {
  const { log } = deps;

  // A key that cannot be read — gone between list and get, or not parquet at
  // all — is reported and left out of loaded_objects, so the next
  // loadPending tries it again. Its rows count nowhere.
  const readObject = async (key: string): Promise<Record<string, unknown>[] | null> => {
    try {
      const bytes = await deps.storage.get(key);
      if (bytes === null) throw new Error("object is gone");
      return await readParquet(bytes);
    } catch (error) {
      log(`${key}: cannot read object: ${describe(error)}`);
      return null;
    }
  };

  const loadPending = async (): Promise<LoadResult> => {
    const result: LoadResult = { objects: 0, inserted: 0, linked: 0, rejected: 0, failed: 0 };
    const done = await loadedKeys(deps.sql);
    const keys = (await deps.storage.list(ITEMS_PREFIX)).filter(
      (key) => key.endsWith(".parquet") && !done.has(key),
    );

    for (const key of keys) {
      const raw = await readObject(key);
      if (raw === null) {
        result.failed += 1;
        continue;
      }

      let rejected = 0;
      const valid: LoadRow[] = [];
      raw.forEach((record, index) => {
        const checked = checkRow(record);
        if ("reason" in checked) {
          rejected += 1;
          log(`${key}: rejected row ${index}: ${checked.reason}`);
        } else {
          valid.push(checked.row);
        }
      });
      // Earliest fetched_at wins a duplicate id. Array.prototype.sort is
      // stable, so a tie keeps the order the producer wrote the rows in.
      valid.sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());

      try {
        const applied = await applyItemObject(deps.sql, key, valid, rejected);
        result.objects += 1;
        result.inserted += applied.inserted;
        result.linked += applied.linked;
        result.rejected += rejected;
      } catch (error) {
        // applyItemObject is one transaction, so a failure here committed
        // nothing and the key stays out of loaded_objects for the next run.
        log(`${key}: apply failed, stopping this run: ${describe(error)}`);
        throw error;
      }
    }

    return result;
  };

  return {
    loadPending,

    async reload(): Promise<LoadResult> {
      // Items and item_state stay: item_state is not in storage yet, so a
      // reload that deleted items would cascade it away. Re-applying is
      // idempotent per row, and item_sources rows that went missing get
      // re-linked because links are attempted for every row, not just new
      // items.
      await forgetLoadedObjects(deps.sql);
      return loadPending();
    },

    async syncSourceState(): Promise<number> {
      const bytes = await deps.storage.get(STATE_KEY);
      if (bytes === null) return 0;
      const entries: Record<string, SourceFetchStateRow> = {};
      for (const [id, entry] of Object.entries(parseState(bytes).subscriptions)) {
        const bad = (["lastFetchedAt", "lastSuccessAt"] as const).find((field) => {
          const value: unknown = entry[field];
          return (
            value !== null &&
            value !== undefined &&
            (typeof value !== "string" || Number.isNaN(Date.parse(value)))
          );
        });
        if (bad) {
          // parseState checks nextFetchAt only, and one bad timestamp would
          // fail the whole UPDATE; skip that source.
          log(`${STATE_KEY}: ${id}: ${bad} is not a timestamp, skipped`);
          continue;
        }
        entries[id] = entry;
      }
      return syncSourceFetchState(deps.sql, entries);
    },
  };
}

type CheckedRow = { row: LoadRow } | { reason: string };

function isText(value: unknown): value is string {
  return typeof value === "string";
}

// Years 1..9999: PostgreSQL's timestamptz refuses dates far outside that, and
// one such row would fail the object's transaction on every run.
function isDate(value: unknown): value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return false;
  const year = value.getUTCFullYear();
  return year >= 1 && year <= 9999;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OPTIONAL_TEXT = ["title", "author", "guid", "content_html", "summary"] as const;

// The contract's required columns must be present and well-typed; an invalid
// row is refused alone so its valid neighbours in the same object still
// apply. Optional columns may be null, and a wrong type there refuses the
// row too — a producer that cannot write a string did not follow the schema.
function checkRow(raw: Record<string, unknown>): CheckedRow {
  const refuse = (field: string, expected: string): CheckedRow => ({
    reason: `${field} must be ${expected}`,
  });

  if (raw.schema_version !== ITEM_SCHEMA_VERSION) {
    return refuse("schema_version", `${ITEM_SCHEMA_VERSION}`);
  }
  if (!isText(raw.id) || !ITEM_ID.test(raw.id)) {
    return refuse("id", "64 lowercase hex characters");
  }
  if (!isText(raw.url) || raw.url === "") return refuse("url", "non-empty text");
  if (!isText(raw.canonical_url)) return refuse("canonical_url", "text");
  // Also refuses an empty canonical_url, whose hash no valid id can match.
  if (sha256(raw.canonical_url) !== raw.id) return refuse("id", "sha256 of canonical_url");
  if (!isDate(raw.published_at)) return refuse("published_at", "a timestamp");
  if (typeof raw.published_at_estimated !== "boolean") {
    return refuse("published_at_estimated", "a boolean");
  }
  if (!isDate(raw.fetched_at)) return refuse("fetched_at", "a timestamp");
  if (!isText(raw.source_id)) return refuse("source_id", "text");

  // PostgreSQL text cannot hold U+0000; one such row would fail the object's
  // transaction on every run.
  // `raw` is not loaded, so only the columns that reach the database count.
  for (const [field, value] of Object.entries(raw)) {
    if (field !== "raw" && typeof value === "string" && value.includes("\u0000")) {
      return refuse(field, "text without U+0000");
    }
  }

  const optional: Partial<Record<(typeof OPTIONAL_TEXT)[number], string | null>> = {};
  for (const field of OPTIONAL_TEXT) {
    const value = raw[field];
    if (value === null || value === undefined) {
      optional[field] = null;
    } else if (typeof value === "string") {
      optional[field] = value;
    } else {
      return refuse(field, "text or null");
    }
  }

  const title = optional.title ?? null;
  const contentHtml = optional.content_html ?? null;
  const summary = optional.summary ?? null;

  return {
    row: {
      id: raw.id,
      url: raw.url,
      canonicalUrl: raw.canonical_url,
      title,
      author: optional.author ?? null,
      guid: optional.guid ?? null,
      publishedAt: raw.published_at,
      publishedAtEstimated: raw.published_at_estimated,
      contentHtml,
      summary,
      searchText: toSearchText(title, contentHtml, summary),
      fetchedAt: raw.fetched_at,
      sourceId: raw.source_id,
    },
  };
}
