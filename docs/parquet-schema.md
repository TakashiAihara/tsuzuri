# Parquet schema

The files tsuzuri keeps in its store of record, and the contract for other producers that write into it. The design behind them is `docs/design/parquet-store-migration.md`.

## Storage keys

Every key is `/`-separated segments. Each segment matches `^[A-Za-z0-9_=-][A-Za-z0-9._=-]*$` and is at most 200 characters: ASCII only, no empty segment, no leading dot. Keys outside this rule are refused when written and skipped when listed.

| Prefix | Content | Written by |
|---|---|---|
| `items/dt=YYYY-MM-DD/<runId>.parquet` | Items fetched by the collector, one file per flush | collector |
| `inbox/<producer>/dt=YYYY-MM-DD/<id>.parquet` | Items in the schema below from another producer (not read yet: step 6 of the design) | other producers |
| `_runs/<runId>.json` | One JSON record per collector flush: `runId`, `startedAt`, `finishedAt`, `items` (rows written) and per subscription `id`, `status` (`fetched` / `unchanged` / `failed`), `seen`, `written`, `error`. For diagnosis; nothing reads it back | collector |
| `_state/collector.json` | The collector's per-subscription fetch state. Internal to the collector, not a contract | collector |

- `dt` is the UTC day the file was written, not the day of the items in it.
- `runId` is `YYYYMMDDTHHMMSSZ-<8 hex>` in UTC, so run ids sort by write time.
- Inbox producers name their files so that they sort by write time too.

## Items

`schema_version` 1. Readers match columns by name; the order below is the order tsuzuri writes. Every column is written as OPTIONAL; "Required" means a producer must not leave it null. The loader refuses such a row on its own and applies the rest of the file. It also refuses a row whose `id` is not the SHA-256 of its `canonical_url`, whose `url` or `canonical_url` is empty, whose timestamps fall outside the years 1 to 9999, or whose loaded text columns (every text column above except `raw`) contain U+0000 or, for the optional ones, a value of another type. `raw` is not loaded and is not checked.

| Column | Parquet type | Required | Meaning |
|---|---|---|---|
| `id` | BYTE_ARRAY (UTF8) | yes | SHA-256 of the canonical URL, lowercase hex. Identity of the item |
| `url` | BYTE_ARRAY (UTF8) | yes | The item's URL as published, resolved against the feed URL |
| `canonical_url` | BYTE_ARRAY (UTF8) | yes | The URL after normalisation (the input to `id`) |
| `title` | BYTE_ARRAY (UTF8) | no | |
| `author` | BYTE_ARRAY (UTF8) | no | |
| `guid` | BYTE_ARRAY (UTF8) | no | Publisher-supplied id. Recorded only; identity comes from the URL |
| `published_at` | INT64 (TIMESTAMP_MILLIS, UTC) | yes | Publication time; fetch time when the source gave no usable date |
| `published_at_estimated` | BOOLEAN | yes | True when `published_at` is the fetch time |
| `content_html` | BYTE_ARRAY (UTF8) | no | Article body as HTML |
| `summary` | BYTE_ARRAY (UTF8) | no | The source's short description with whitespace collapsed (as are `title` and `author`). May repeat the body |
| `fetched_at` | INT64 (TIMESTAMP_MILLIS, UTC) | yes | When the item was fetched |
| `source_id` | BYTE_ARRAY (UTF8) | yes, in `items/` | The subscription that delivered it. Inbox producers cannot know it and may leave it null; for inbox files the subscription comes from the producer path (step 6) |
| `schema_version` | INT32 | yes | `1` |
| `raw` | BYTE_ARRAY (UTF8) | no | The item as the source produced it before normalisation, as JSON text (for a feed: `url`, `title`, `author`, `guid`, `publishedAtRaw`, `contentHtml`, `summary`) |

- tsuzuri writes SNAPPY-compressed files. It reads SNAPPY, ZSTD, GZIP, BROTLI and LZ4 files and uncompressed ones.
- The same `id` may appear in several files. When the copies differ, the first one the loader applies wins: files apply in key order, and within a file the row with the earliest `fetched_at` comes first, ties keeping the row position. A file that cannot be read or applied stops the loader there, so a later key never applies before an earlier one in the same run.
- Key order follows write order only to the second: two flushes within the same second sort by their random suffix, not by time. It also breaks when a clock steps back or a second producer writes into `items/`: a key that sorts before files already applied is applied after them and loses.
