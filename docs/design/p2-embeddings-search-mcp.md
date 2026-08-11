# P2: embeddings, hybrid search, MCP server

Covers issues #1 (embedding provider abstraction), #2 (hybrid search), #3 (MCP server).

Status: approved 2026-08-10. Being implemented as three chained pull requests; see Delivery.

## Scope

- An `EmbeddingProvider` abstraction with one OpenAI-compatible implementation and a disabled default, one active model per instance, and a single command to switch models.
- `GET /search` fusing PGroonga and pgvector with Reciprocal Rank Fusion, degrading to text-only when embeddings are off, plus `tsuzuri search`.
- An MCP server exposing search, retrieval, digest, source listing and state updates, with list responses trimmed to fit an agent's context window.

Not in scope, deferred to the phase that owns them:

- Interest scoring, summarisation, translation, tagging, clustering (P3).
- The `digest` tool, which issue #3 lists. Moved to P3 with the clustering it is made of; see D11.
- Web UI (P4), source plugins (P5), headless rendering (P6).

Terms used here are defined in `docs/glossary.md`, which is the authority when a word in this document could mean two things.

## Fixed constraints

These are settled and not reopened here:

- AI is opt-in. The default embedding model is unset, and the reader works fully with no model configured.
- PGroonga is a hard dependency; managed PostgreSQL is unsupported.
- pgvector fixes the vector dimension in the column definition, so an instance has exactly one active embedding model, and changing it means re-embedding.
- MCP list responses never carry article body text. Summaries and match snippets are text too and are included; see D12 for the exact field set and why it is wider than the original shorthand.
- MIT licence, English documentation.

## Measured facts driving the design

Probed against the bundled image (PGroonga 4.0.8, pgvector 0.8.6, PostgreSQL 18). Each of these changed a decision, so they are recorded rather than assumed.

### PGroonga scoring is term frequency, not BM25

A row containing `Rust` four times scored 4; rows containing it once scored 1. There is no length normalisation and no inverse document frequency.

Consequence: a long article that mentions a term in passing outranks a short article about that term. See decision D5.

### `pgroonga_score` returns 0 unless the row came from the index

Forcing a sequential scan made every score 0 while the result set stayed correct. The failure is silent: ranking degrades to arbitrary order with no error.

Consequence: the query must be shaped so the planner cannot avoid the PGroonga index, and the test suite must assert that scores are non-zero rather than only asserting which rows come back. See D6.

### A space-separated query is an implicit AND

`search_text &@~ 'Rust 機械学習'` returned only the row containing both. `OR` is supported explicitly. A natural-language query passed straight through therefore returns nothing once it has more than a couple of terms — which is exactly how an agent will call `search_articles`. See D4.

### `pgroonga_query_escape` escapes operators as well as syntax

It turns `Next.js 16 (OR) -foo` into `Next.js 16 \(OR\) \-foo`, so escaping user input also disables any operator the user typed deliberately. Input is either literal or an expression language, not both. See D4.

### A pgvector column with no dimension cannot be indexed

`CREATE TABLE t (embedding vector)` succeeds, but `CREATE INDEX ... USING hnsw` on it fails with `column does not have dimensions`. Altering the dimension works on an empty table and fails on a populated one.

Consequence: `item_embeddings` cannot exist in a numbered migration, because the dimension is unknown until a model is configured. It is created at runtime, and a model switch is drop-rows, alter, refill. See D1 and D3.

### The fused query plan is sound

A prototype of the full RRF query used `Index Scan using ..._pgroonga` for the text arm and `Index Scan using ..._hnsw` for the vector arm over 5,003 rows, with joins and an unread filter applied after fusion. Scores survived. The prototype also exposed the problem in D7: with a query that few documents match textually, the vector arm's top-N fills the remaining slots with whatever is nearest, however far that is.

### MCP SDK

Published version is 1.30.0. It has `registerTool` / `registerResource` and accepts zod `^3.25 || ^4.0`, so the repo's zod 4.4.3 works unchanged. Note that DeepWiki describes an unreleased v2 with a different `inputSchema` convention; this design targets 1.30.0 as published.

## Part 1: embedding provider abstraction (#1)

### Provider interface

Lives in `packages/core/src/embedding.ts`, alongside the existing `Source` abstraction and for the same reason: the pipeline holds the interface, never a vendor.

```ts
export type EmbeddingProvider = {
  /** Implementation id, recorded so a config change is detectable. */
  id: "openai-compatible";
  /** Model name as the endpoint knows it. */
  model: string;
  /** Embed a batch. Order of the result matches order of the input. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
};
```

Disabled is represented by the absence of a provider (`createEmbeddingProvider()` returns `null`), not by a null object that returns empty vectors. A null object would let callers write rows that look like embeddings and are not.

One implementation ships: `openai-compatible`, posting to `{baseUrl}/embeddings`. That covers Ollama, LM Studio, vLLM, OpenRouter and OpenAI itself. Adding Cohere or a native Gemini client later means a second file and no change anywhere else.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDING_PROVIDER` | `none` | `none` or `openai-compatible` |
| `EMBEDDING_BASE_URL` | — | Required when the provider is not `none`, e.g. `http://localhost:11434/v1` |
| `EMBEDDING_API_KEY` | — | Optional; local runtimes usually need none |
| `EMBEDDING_MODEL` | — | Required when the provider is not `none`. No default, deliberately |
| `EMBEDDING_DIMENSIONS` | — | Only for models that accept a `dimensions` request parameter. Asserted against the probe |
| `EMBEDDING_BATCH_SIZE` | `32` | Texts per request |
| `EMBEDDING_CONCURRENCY` | `2` | Concurrent requests. Low, because the common target is one local GPU |
| `EMBEDDING_MAX_INPUT_CHARS` | `8000` | Input truncation before embedding |

### Dimension discovery

The dimension is probed, not configured: embed one short string at first enablement and take the length of the result. A configured dimension that disagrees with the model is a mismatch nobody notices until search quality is quietly wrong, and the probe costs one request, once.

`EMBEDDING_DIMENSIONS` remains available because some models accept a `dimensions` request parameter and genuinely produce shorter vectors on request. When set, it is sent with the request and then asserted against what came back, since a server is free to ignore it and answer at its native width.

The probed width must be at most 2,000, which is pgvector's ceiling for an HNSW index over the `vector` type. Past that the table would be created and the index would not, leaving no recorded model and a state the next boot would try to reach again. Refusing at that point names the limit and points at `EMBEDDING_DIMENSIONS`.

### Schema

Two tables, created by migration `0004_embeddings.sql`, plus one created at runtime.

```sql
-- Single row. The active configuration for this instance.
CREATE TABLE embedding_model (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  provider    text NOT NULL,
  model       text NOT NULL,
  dimensions  integer NOT NULL CHECK (dimensions > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Items whose embedding call failed, so one poisonous item cannot block the
-- backfill queue forever. Cleared wholesale on a model switch.
CREATE TABLE embedding_failures (
  item_id         text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  failures        integer NOT NULL DEFAULT 1,
  last_error      text,
  next_attempt_at timestamptz NOT NULL
);
```

`item_embeddings` is created at runtime once the dimension is known:

```sql
CREATE TABLE item_embeddings (
  item_id    text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  embedding  vector(N) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_embeddings_hnsw
  ON item_embeddings USING hnsw (embedding vector_cosine_ops);
```

There is deliberately no `model` column on `item_embeddings`. The whole table belongs to one model by construction; a per-row model column would imply mixing is supported, and it is not — the column type forbids it.

This breaks the repo's existing invariant that `packages/db/src/schema.ts` mirrors every table, because a Drizzle definition cannot carry a dimension that is only known at runtime. The consequence is stated rather than worked around: `item_embeddings` is written and queried through raw SQL on the `postgres.js` client, which `createDatabase` already returns for exactly this kind of case. `schema.test.ts` gains a case that creates the table at a test dimension and asserts the runtime DDL matches what the queries expect.

### Model mismatch guard

On boot, compare the configured provider, model and dimension against the `embedding_model` row:

| State | Behaviour |
| --- | --- |
| No provider configured | No embed worker. Search runs text-only. Normal, not an error |
| Provider configured, no row | First enablement: probe, create the table, write the row, start the backfill |
| Configured matches the row | Start the embed worker |
| Configured differs from the row | Embed worker stays down, vector arm of search is disabled, `doctor` reports the mismatch and names `tsuzuri reindex` |

The mismatch case does not stop the daemon. Ingest keeps running and text search keeps working; the vectors on disk belong to the old model and a query embedded with the new one would be nonsense against them, so the vector arm alone is withdrawn.

### Backfill worker

No queue table. An item needs embedding exactly when it has no row in `item_embeddings`, which the ingest path produces for free:

```sql
SELECT i.id, i.title, i.search_text
FROM items i
LEFT JOIN item_embeddings e ON e.item_id = i.id
LEFT JOIN embedding_failures f ON f.item_id = i.id
WHERE e.item_id IS NULL
  AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now())
ORDER BY i.published_at DESC
LIMIT $1;
```

Newest first, so a fresh install becomes useful for current articles immediately instead of after the whole archive.

Embedded text is `title` and `search_text` joined, truncated to `EMBEDDING_MAX_INPUT_CHARS`. Truncation is by characters, which only approximates the model's token limit; the default is set low enough that the approximation is safe for CJK, where characters-per-token is worst.

Failures record a row with exponential backoff. A batch rejected permanently by the provider is retried one item at a time, so one bad item does not condemn thirty-one good ones. A retryable outage is not split: it says nothing about the articles, and splitting would multiply requests against something already down. Neither is an abort or a database error, which describe the run rather than the corpus.

### Reindex

```text
tsuzuri reindex                              fill gaps only; never destroys vectors
tsuzuri reindex --embedding-model <name>     rebuild everything into <name>
```

`--embedding-model` must name the model that is currently configured in the environment. If it does not, the command fails and says so. The environment stays the single place a model is chosen; the flag is an acknowledgement of which rebuild you are asking for, in the same spirit as `--force-with-lease`. Without that assertion the flag would be a second, contradicting place to configure a model.

The rebuild: drop the HNSW index, truncate `item_embeddings` and `embedding_failures`, alter the column to the new dimension, rewrite the `embedding_model` row, backfill, then recreate the index. Index last because building HNSW over a full table is markedly faster than maintaining it across several thousand inserts.

It is resumable. An interrupted rebuild leaves an empty or partial table whose dimension already matches the record, so restarting continues the backfill rather than starting over.

`POST /embeddings/reindex` drives it; `GET /embeddings/status` reports `{ state, provider, model, dimensions, indexBuilt, reindexing, lastReindexError, counts: { total, embedded, pending, failed } }`, which the CLI polls to print progress and `doctor` embeds in its report. `lastReindexError` is there because a rebuild outlives the request that started it, so `reindexing: false` alone cannot distinguish finished from failed.

## Part 2: hybrid search (#2)

### Endpoint

```text
GET /search?q=&limit=&since=&sourceId=&unreadOnly=
```

- `q` required.
- `limit` 1..100, default 20.
- `since` an ISO instant or a duration like `7d`.
- `sourceId` a uuid.
- `unreadOnly` boolean, default false.

Response:

```json
{
  "mode": "hybrid",
  "results": [
    {
      "id": "…",
      "title": "…",
      "url": "…",
      "publishedAt": "…",
      "summary": "…",
      "snippet": "…",
      "score": { "rrf": 0.0323, "textRank": 3, "vectorRank": 1 }
    }
  ]
}
```

`mode` is `hybrid` or `text-only`; when it is `text-only` a `reason` field says which of the three causes applies (no provider configured, model mismatch, or the query itself could not be embedded). Issue #2 requires that the degraded case says so, and a caller cannot infer it from results alone.

Per-arm ranks are returned rather than hidden. Ranking is the part of this feature most likely to be wrong, and a fused score with no visible provenance is untunable.

### Query construction

Input is treated as literal text, never as PGroonga expression syntax. Terms are extracted, escaped with `pgroonga_query_escape`, and joined with `OR`.

`OR` rather than `AND` because of two measured facts together: an implicit `AND` returns nothing for a natural-language query, and the score is term frequency, so a document matching three of the query's terms generally outscores one matching a single term. Recall comes from the `OR`, and the precision that `AND` would have provided comes back through ranking instead of through exclusion.

### Query shape

```sql
WITH text_arm AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, published_at DESC) AS rank
  FROM (
    SELECT id, published_at, pgroonga_score(tableoid, ctid) AS s
    FROM items
    WHERE search_text &@~ $query
      AND (…inline filters…)
    ORDER BY pgroonga_score(tableoid, ctid) DESC
    LIMIT $candidates
  ) t
),
vector_arm AS (
  SELECT item_id AS id, row_number() OVER (ORDER BY distance) AS rank
  FROM (
    SELECT e.item_id, e.embedding <=> $queryVector AS distance
    FROM item_embeddings e
    WHERE (…inline filters…)
    ORDER BY e.embedding <=> $queryVector
    LIMIT $candidates
  ) v
  WHERE distance < $maxDistance
)
SELECT … FROM text_arm FULL OUTER JOIN vector_arm USING (id) …
ORDER BY rrf DESC LIMIT $limit;
```

Points that are load-bearing rather than incidental:

- The inner subquery aliases the score as `s` and the outer window orders by `s`. Recomputing `pgroonga_score` outside the index scan is how the zero-score failure gets reintroduced.
- Filters are pushed into both arms as inline predicates and `EXISTS` subqueries, not applied after fusion. Post-filtering a fixed candidate list silently loses recall exactly when the filter is selective, which is when the user cares. The implementation verifies with `EXPLAIN` that both index scans survive each filter combination.
- `$candidates` is `max(limit * 10, 200)`.
- RRF is `sum(1 / (k + rank))` with `k = 60`.

### Two corrections applied to the raw signals

Both were prompted by measurements above, and both change what comes back, so each is pinned by a test that fails under the opposite choice.

The text arm divides the term-frequency score by `sqrt(length(search_text))`. PGroonga's score is a raw occurrence count with no length normalisation, so without this a long article that mentions a term once outranks a short article about that term — which is precisely the exact-product-name case in the issue's acceptance criterion.

The vector arm drops candidates beyond a maximum cosine distance, `EMBEDDING_MAX_DISTANCE`, default 0.6. The arm otherwise always returns its top N however far away they are, so a query few documents match textually fills its lower half with unrelated articles. The default is tuned against a real corpus during implementation and is configurable.

### Degradation

With no usable vector arm, the same query runs with the vector CTE omitted, `mode` is `text-only`, and results carry `vectorRank: null`. The RRF arithmetic is unchanged: a single arm reduces to ordering by text rank.

### CLI

```text
tsuzuri search <query> [--limit n] [--since 7d] [--source <id>] [--unread] [--json]
```

Human output is one line per hit with the age, title and snippet. `--json` emits the endpoint's response verbatim, including scores.

## Part 3: MCP server (#3)

### Shape

A new workspace app, `apps/mcp`, on `@modelcontextprotocol/sdk` 1.30.0 over stdio. It is an HTTP client of the daemon exactly as the CLI is, holding no database connection. The daemon stays the only writer, which is what stops the MCP surface and the CLI surface drifting apart.

Stdio only for now. The SDK's streamable HTTP transport is a later addition and brings an authentication question the daemon does not answer yet.

### Tools

| Tool | Input | Output |
| --- | --- | --- |
| `search_articles` | `query`, `since`, `sourceId`, `unreadOnly`, `limit` | abbreviated id, title, url, publishedAt, summary, snippet, score |
| `get_article` | `id` (abbreviated or full), `format`: `markdown` \| `text` \| `summary` | One article including body |
| `list_sources` | — | id, title, url, status, failure count |
| `mark_read` | `ids[]`, `read` | Per-id result |
| `star` | `ids[]`, `starred` | Per-id result |
| `add_source` | `url`, `title?` | The created subscription |

No list tool returns article body text. Full text costs a deliberate `get_article` call. This is the point of the MCP surface being designed rather than generated from the CLI: a broad query that returned bodies would spend the agent's context before it had decided what was worth reading.

`search_articles` returns id, title, summary, score, url, published time and a match snippet. The last three are beyond the original shorthand of "id, title, summary and score" and are there deliberately — see D12.

Tools declare `outputSchema` and return `structuredContent` alongside a text rendering, which the SDK requires once an output schema is present.

`digest` is not among them. It is a summary of a period built over clusters, and both the clustering and the summarising are P3, so a P2 version could only group by source and repeat whatever summary the feed happened to supply. That is `search_articles` with a date filter wearing a different name. Shipping it would publish an agent-facing tool that does not do what it is called, and later change what it groups by — the exact drift `docs/glossary.md` exists to prevent. It moves to P3 with the parts it is made of.

Issue #3's completion criterion, an agent answering "what happened with X last week" in one call, is met by `search_articles` with `since`, and does not depend on `digest`.

### Resource

`tsuzuri://unread/recent` exposes the most recent unread items in the same trimmed shape, so a host can put them in context without a tool call.

### Working with no AI configured

Search, retrieval, listing, state updates and `add_source` all work with no provider configured. Search is text-only, summaries are whatever the feed supplied. The natural arrangement is that the host agent does the summarising, which is a strength of shipping an MCP surface rather than a gap.

## Cross-cutting

### `doctor`

`features.embeddings` stops being a P2 placeholder and reports `{ enabled, provider, model, dimensions, embedded, pending, failed, mismatch }`. `features.search` reports the mode the next query would use and why.

### Testing

The suite stood at 74 passing when this document was written, skipping database tests when `TSUZURI_TEST_DATABASE_URL` is unset. That split is preserved; the count is not kept current here.

- Pure unit: RRF fusion, term extraction and escaping, duration parsing for `since`, the mismatch guard as a decision function, backoff arithmetic.
- Provider: the OpenAI-compatible client against a stub HTTP server started in-process. Covers batch ordering, the `dimensions` parameter, a dimension that disagrees with the probe, HTTP errors, and a malformed response. No network.
- Database: runtime creation of `item_embeddings` at a test dimension; a rebuild at a different dimension; backfill selection including the failure backoff; and the ranking cases from the issue's acceptance criterion, seeded with a Japanese corpus and an exact-product-name corpus.
- Ranking regression: assert PGroonga scores are non-zero for every filter combination the endpoint supports. This is the test that catches the silent seq-scan failure, and it is the reason the probe work above was done before writing this.
- MCP: drive the server through the SDK's in-memory transport against a stubbed daemon, asserting that list tools omit body text.

Per the repo rule that an implementation change which breaks no test means the tests were insufficient: the ranking changes in D5 and D7 each get a test that fails under the other choice, so the decision is pinned by the suite rather than by this document.

### Delivery

Three draft PRs, chained, each leaving `main` in a working state:

1. `feat/p2-embedding-provider` — issue #1.
2. `feat/p2-hybrid-search` — issue #2, based on 1.
3. `feat/p2-mcp-server` — issue #3, based on 2.

Search is written to work without embeddings, so PR 2 is independently useful even if PR 1 is never enabled by a given install.

Commits and PR bodies carry `sid: 3YC4SS`.

### Documentation

README gains a configuration section for the embedding variables, a statement that switching models re-embeds, an MCP client configuration snippet, and the search command. English, consistent with the existing docs.

## Decisions

Settled 2026-08-10.

| # | Decision | Resolution |
| --- | --- | --- |
| D1 | Where `item_embeddings` is created | At runtime rather than in a migration, and queried by raw SQL outside the Drizzle mirror. The dimension cannot exist in a static migration |
| D2 | Names for the two new tables | `embedding_model` and `embedding_failures` |
| D3 | What `--embedding-model` does | Asserts the configured model rather than setting it. A flag that also configured would contradict the environment |
| D4 | How query input is interpreted | Literal text, terms escaped and joined with `OR`. PGroonga expression syntax is not exposed |
| D5 | PGroonga's score has no length normalisation | Divide by `sqrt(length(search_text))` |
| D6 | Where filters are applied | Pushed into both arms and verified by `EXPLAIN`, not applied after fusion, which would lose recall exactly where it matters most |
| D7 | The vector arm has no relevance floor | Add a maximum cosine distance, configurable, default 0.6, tuned during implementation against a real corpus |
| D8 | Issue #2 lists a `tags` parameter, but tags do not exist until P3 | Omit it now rather than accept a parameter that silently does nothing. It arrives in P3 with the tag vocabulary |
| D9 | `get_article` needs HTML-to-markdown for `format: markdown` | Add `turndown`. Markdown is what agents consume best |
| D10 | `tsuzuri read` prints an 8-character id prefix that `tsuzuri show` rejects, so the two do not compose | Accept a unique prefix. Carried as a separate commit, since it is a P1 bug rather than P2 scope |
| D11 | Issue #3 lists a `digest` tool, but clustering and summarisation are both P3 | Move it to P3. A P2 version would group by source and change its grouping later, publishing an agent-facing contract that does not match its name. Recorded as a comment on issue #3 |
| D12 | The stated contract for list responses was "id, title, summary and score", and `search_articles` also returns url, published time and a snippet | Keep the wider set. The constraint is that list responses carry no article *body* text, and the enumeration was shorthand for that. Dropping the published time would break this phase's own acceptance criterion — an agent cannot answer "what happened last week" without dates — and dropping the url removes the only way to reach an article without a second call; the snippet is bounded at roughly 160 characters. Ids in every MCP response are abbreviated to twelve characters and accepted anywhere a full id is, because the daemon resolves unique prefixes (D10), so an agent never handles a 64-character id. Confirmed with the author 2026-08-11 |
