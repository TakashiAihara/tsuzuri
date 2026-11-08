# Parquet schema

The files tsuzuri keeps in its store of record, and the contract for other producers that write into it. The design behind them is `docs/design/parquet-store-migration.md`.

## Storage keys

Every key is `/`-separated segments. Each segment matches `^[A-Za-z0-9_=-][A-Za-z0-9._=-]*$` and is at most 200 characters: ASCII only, no empty segment, no leading dot. Keys outside this rule are refused when written and skipped when listed.

| Prefix | Content | Written by |
|---|---|---|
| `items/dt=YYYY-MM-DD/<runId>.parquet` | Items fetched by the collector, one file per flush | collector |
| `inbox/<producer>/dt=YYYY-MM-DD/<id>.parquet` | Items in the schema below from another producer | other producers |
| `_runs/<runId>.json` | One record per collector flush | collector |
| `_state/collector.json` | The collector's per-subscription fetch state | collector |

- `dt` is the UTC day the file was written, not the day of the items in it.
- `runId` is `YYYYMMDDTHHMMSSZ-<8 hex>` in UTC, so run ids sort by write time.
- Inbox producers name their files so that they sort by write time too.

## Items

`schema_version` 1. Readers match columns by name; the order below is the order tsuzuri writes.

| Column | Parquet type | Null | Meaning |
|---|---|---|---|
| `id` | BYTE_ARRAY (UTF8) | no | SHA-256 of the canonical URL, lowercase hex. Identity of the item |
| `url` | BYTE_ARRAY (UTF8) | no | The item's URL as published, resolved against the feed URL |
| `canonical_url` | BYTE_ARRAY (UTF8) | no | The URL after normalisation (the input to `id`) |
| `title` | BYTE_ARRAY (UTF8) | yes | |
| `author` | BYTE_ARRAY (UTF8) | yes | |
| `guid` | BYTE_ARRAY (UTF8) | yes | Publisher-supplied id. Recorded only; identity comes from the URL |
| `published_at` | INT64 (TIMESTAMP_MILLIS, UTC) | no | Publication time; fetch time when the source gave no usable date |
| `published_at_estimated` | BOOLEAN | no | True when `published_at` is the fetch time |
| `content_html` | BYTE_ARRAY (UTF8) | yes | Article body as HTML |
| `summary` | BYTE_ARRAY (UTF8) | yes | Teaser, when distinct from the body |
| `fetched_at` | INT64 (TIMESTAMP_MILLIS, UTC) | no | When the item was fetched |
| `source_id` | BYTE_ARRAY (UTF8) | no | The subscription that delivered it. Ignored for inbox files, whose subscription is the producer |
| `schema_version` | INT32 | no | `1` |
| `raw` | BYTE_ARRAY (UTF8) | yes | The item as the source produced it before normalisation, as JSON text (for a feed: `url`, `title`, `author`, `guid`, `publishedAtRaw`, `contentHtml`, `summary`) |

- tsuzuri writes SNAPPY-compressed files. It reads SNAPPY, ZSTD, GZIP, BROTLI and LZ4 files and uncompressed ones.
- The same `id` may appear in several files. When the copies differ, the one with the earliest `fetched_at` wins.
