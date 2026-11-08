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
import { toSearchText } from "./search-text.ts";

/**
 * The loader: derives PostgreSQL's items, item_sources and sources fetch
 * state from what the collector wrote to storage. The daemon runs it through
 * createLoadRunner, which keeps runs from overlapping.
 *
 * loaded_objects is the ledger that makes loadPending cheap to repeat: a key
 * it records is skipped, and forgetLoadedObjects (reload) makes every object
 * pending again. Objects apply in the order the storage keys sort, and
 * within an object by fetched_at. When the same item id shows up twice with
 * different content, the first applied copy is the one items keeps (ON
 * CONFLICT DO NOTHING), matching docs/parquet-schema.md. To keep that order,
 * an object that cannot be read or applied stops the run there, and the
 * result names it: applying the later keys first would let a later copy win.
 */

export type LoadResult = {
  /** Storage objects applied this run. */
  objects: number;
  inserted: number;
  linked: number;
  /** Rows refused by validation, across all applied objects. */
  rejected: number;
  /**
   * The object the run stopped at, because it could not be read or applied.
   * It and every later key stay pending for the next run.
   */
  stoppedAt: { key: string; error: string } | null;
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

  const readObject = async (key: string): Promise<Record<string, unknown>[]> => {
    const bytes = await deps.storage.get(key);
    if (bytes === null) throw new Error("object is gone");
    return readParquet(bytes);
  };

  const loadPending = async (): Promise<LoadResult> => {
    const result: LoadResult = { objects: 0, inserted: 0, linked: 0, rejected: 0, stoppedAt: null };
    const done = await loadedKeys(deps.sql);
    const keys = (await deps.storage.list(ITEMS_PREFIX)).filter(
      (key) => key.endsWith(".parquet") && !done.has(key),
    );

    for (const key of keys) {
      let raw: Record<string, unknown>[];
      try {
        raw = await readObject(key);
      } catch (error) {
        result.stoppedAt = { key, error: `cannot read object: ${describe(error)}` };
        break;
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
        result.stoppedAt = { key, error: `apply failed: ${describe(error)}` };
        break;
      }
    }

    if (result.stoppedAt) {
      log(`${result.stoppedAt.key}: ${result.stoppedAt.error}; stopped, later keys wait`);
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
        // One value PostgreSQL refuses would fail the whole UPDATE, so a bad
        // entry is skipped alone. Not guarded: lone surrogates in text, which
        // only a hand-edited state file could hold.
        const times = {
          nextFetchAt: toTimestamp(entry.nextFetchAt),
          lastFetchedAt: toTimestamp(entry.lastFetchedAt),
          lastSuccessAt: toTimestamp(entry.lastSuccessAt),
        };
        const badTime = Object.entries(times).find(([, value]) => value === undefined);
        const badText = (["etag", "lastModified", "contentHash", "lastError"] as const).find(
          (field) => !isStorableText(entry[field]),
        );
        const badOther = !isStorableText(id)
          ? "id"
          : entry.consecutiveFailures > INT4_MAX
            ? "consecutiveFailures"
            : undefined;
        const bad = badTime?.[0] ?? badText ?? badOther;
        if (bad) {
          log(`${STATE_KEY}: ${id}: ${bad} cannot be stored, skipped`);
          continue;
        }
        entries[id] = {
          ...entry,
          // parseState guarantees nextFetchAt is a string, so it is not null here.
          nextFetchAt: times.nextFetchAt as string,
          lastFetchedAt: times.lastFetchedAt ?? null,
          lastSuccessAt: times.lastSuccessAt ?? null,
        };
      }
      return syncSourceFetchState(deps.sql, entries);
    },
  };
}

type CheckedRow = { row: LoadRow } | { reason: string };

function isText(value: unknown): value is string {
  return typeof value === "string";
}

// Years 1..9999: a later year serialises as "+010000-…", which PostgreSQL
// reads as a zone offset, and year 0 or earlier fails too. One such row
// would fail the object's transaction on every run.
function isDate(value: unknown): value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return false;
  const year = value.getUTCFullYear();
  return year >= 1 && year <= 9999;
}

const INT4_MAX = 2_147_483_647;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Only the UTC ISO form the collector writes: Date accepts looser forms and
// silently moves them ("2026-02-30" to March, "1" to 2001, no zone to local
// time). null and missing stay null; undefined means "cannot be stored".
function toTimestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
  const date = new Date(value);
  if (!isDate(date) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return value;
}

function isStorableText(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.includes(String.fromCharCode(0)))
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OPTIONAL_TEXT = ["title", "author", "guid", "content_html", "summary"] as const;
const STORED_TEXT: ReadonlySet<string> = new Set([
  "id",
  "url",
  "canonical_url",
  "source_id",
  ...OPTIONAL_TEXT,
]);

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
  if (!isText(raw.canonical_url) || raw.canonical_url === "") {
    return refuse("canonical_url", "non-empty text");
  }
  if (sha256(raw.canonical_url) !== raw.id) return refuse("id", "sha256 of canonical_url");
  if (!isDate(raw.published_at)) return refuse("published_at", "a timestamp");
  if (typeof raw.published_at_estimated !== "boolean") {
    return refuse("published_at_estimated", "a boolean");
  }
  if (!isDate(raw.fetched_at)) return refuse("fetched_at", "a timestamp");
  if (!isText(raw.source_id)) return refuse("source_id", "text");

  // PostgreSQL text cannot hold U+0000; one such row would fail the object's
  // transaction on every run.
  // Only the columns that reach the database count; `raw` and unknown
  // columns are not loaded.
  for (const [field, value] of Object.entries(raw)) {
    if (STORED_TEXT.has(field) && typeof value === "string" && value.includes("\u0000")) {
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
