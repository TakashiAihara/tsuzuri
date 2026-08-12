# P3: interest scoring, clustering, LLM enrichment, digest

Covers issues #4 (interest scoring), #6 (duplicate clustering), #5 (LLM enrichment), #7 (digest and notifiers).

Status: open decisions settled 2026-08-12; awaiting approval to implement. Nothing here is implemented.

One document for four issues because they are not four features. Scoring decides which items are worth an LLM call, clustering decides that eight copies of one story are one call rather than eight, and the digest is a rendering of what the other three produced. Splitting them would mean writing the same interfaces three times and deciding the same questions differently each time.

The parts are presented in dependency order — scoring, clustering, enrichment, digest — which is also the delivery order, not issue-number order.

## Scope

- An interest profile built from reading history as several clusters rather than one centroid, and a per-item interest score derived from it, with a reserved share of the ranked list for items the score did not choose.
- Cross-source duplicate clustering by embedding distance and SimHash, with timeline, search and digest showing one representative per cluster.
- A `ChatProvider` abstraction with OpenAI-compatible, Anthropic and Gemini implementations and a disabled default; summaries, translations and fixed-vocabulary tags stored in `enrichments` with the model and prompt version that produced them.
- `tsuzuri digest --since`, a `Notifier` interface with several implementations, and an `Exporter` interface for sending one article onward. All disabled by default.
- The `digest` MCP tool deferred from P2 by D11, and the `tags` search parameter deferred from P2 by D8.

Not in scope, deferred to the phase that owns them:

- Web UI (P4), object storage (P4), source plugins (P5), headless rendering (P6).
- Multi-user accounts. Everything below is written per user because the schema already is, but there is still exactly one user.

Terms used here are defined in `docs/glossary.md`, which is the authority when a word in this document could mean two things. Terms this phase adds to it are listed under Glossary changes below.

## Fixed constraints

These are settled and not reopened here:

- AI is opt-in. There is no default chat model, exactly as there is no default embedding model, and the reader works fully with neither configured.
- PGroonga is a hard dependency; managed PostgreSQL is unsupported.
- One embedding model per instance. Everything in this phase that touches vectors inherits that, including the interest profile and the cluster join.
- MCP list responses never carry article body text. The `digest` tool arriving here is a list response and obeys it.
- MIT licence, English documentation.
- Nothing author-specific belongs in core. Issue #7 states this for notifiers; it is applied to export targets as well, which is why Karakeep and Readwise are not adapters in this repo. See D33.

## Measured facts driving the design

Probed against the bundled image (PGroonga 4.0.8, pgvector 0.8.6, PostgreSQL 18.4) on a synthetic corpus of 20,000 items at 384 dimensions. Each of these changed a decision, so they are recorded rather than assumed.

### Scoring the whole corpus against ten centroids costs about 45 ms

`EXPLAIN ANALYZE` over `items CROSS JOIN interest_clusters`, taking `max(1 - (embedding <=> centroid))` per item: 15.6 ms over a 7-day window of 4,687 items, 45.8 ms over all 20,000. The HNSW index is not used and should not be — every candidate is scored, not the nearest few.

Consequence: interest scores are computed per query and never stored. A stored score would have to be invalidated on every profile rebuild and is stale by construction anyway, because the score includes a time decay. See D16.

### A zero-length centroid produces `NaN`, and `NaN` sorts first

`'[0,0,0]'::vector <=> '[1,0,0]'::vector` returns `NaN`, and `max()` over a set containing `NaN` returns `NaN`. PostgreSQL orders `NaN` above every real number, so a single degenerate centroid would silently pin arbitrary items to the top of the ranked timeline with no error anywhere.

A centroid can reach zero legitimately: it is a weighted mean of member vectors, and members pointing in opposing directions cancel. `l2_normalize` does not help — it returns the zero vector unchanged rather than failing.

Consequence: the profile builder refuses to write a zero centroid, and the scoring query filters them out regardless. See D17.

### `l2_norm` cannot be called on a `vector` column

`l2_norm(centroid)` fails with `function l2_norm(vector) is not unique`, on a typed `vector(3)` column and with an explicit cast alike — pgvector 0.8.6 defines it for `vector`, `halfvec` and `sparsevec`, and the resolution is ambiguous. The usable form is the L2 distance to the origin, `centroid <-> '[0,…]'::vector(N)`, or plain inequality against the zero vector.

Consequence: the guard above is written as a comparison, not as a norm call. Worth recording because `l2_norm` is the obvious first attempt.

### `bit_count` over `bit(64)` discriminates cleanly at a threshold of 6

PostgreSQL 14+ provides `bit_count(bit)`, and `#` is XOR on bit strings, so Hamming distance is `bit_count(a # b)`. Against 20,001 rows of distinct 64-bit hashes: 2 rows within 6 bits (the row itself and a deliberately planted 3-bit neighbour), 10,962 within 32. Scanning a 72-hour window of 2,015 rows and filtering on the threshold ran in 0.57 ms on a plain `published_at` index.

Both controls matter. The negative control — unrelated hashes — removed 2,014 of 2,015 rows, so the filter has discriminating power at this threshold rather than matching everything. The positive control — a hash three bits away — was found.

Consequence: no specialised Hamming index is needed. The time window is what makes the scan cheap, and it is also the semantically right restriction: the same story arriving three weeks apart is not a duplicate. See D21.

### pgvector has no scalar multiplication, so a weighted centroid is not expressible in SQL

`avg(vector)` and `l2_normalize` both exist in 0.8.6, and `avg` over an empty set returns `NULL` rather than a zero vector. But `'[1,2,3]'::vector * 2` fails with `operator does not exist: vector * integer`: pgvector defines element-wise `vector * vector` and no scalar form.

A centroid here is a *weighted* mean — a starred article counts three times a read one — and without scalar multiplication that cannot be written over `avg` or `sum`.

Consequence: the k-means loop runs in the daemon over vectors fetched for signalled items, not in SQL over the corpus. Its input is bounded by how much you have reacted to rather than by how much you have stored, and capped besides. It also makes the loop a pure function, which is the only reason its seeded determinism can be tested at all. See D15.

## Glossary changes

The repo rule is that new terms are agreed rather than invented during implementation. Most of what this phase needs was already fixed in `docs/glossary.md` during P2 — enrichment, interest profile, interest cluster, interest score, tag vocabulary, digest, exploration slot, chat model, chat provider, notifier — and is implemented as written there.

Six terms were added for this phase, agreed 2026-08-12 and already applied to `docs/glossary.md`: `signal`, `representative`, `collapse`, `SimHash`, `exporter` and `summary source`. The `provider` collision entry was extended to name `exporter` alongside the other interfaces that share the pattern.

`prompt version` is deliberately not among them. It already appears in the glossary's definition of enrichment — "It records the model and prompt version that produced it" — so it is existing vocabulary rather than a new term, and it needs no entry of its own to be used here.

## Part 1: interest scoring (#4)

### Signals

Weights come from the issue: starred 3.0, read 1.0, skipped -1.0. They are read from `item_state`, whose columns already carry a separate timestamp per kind. Migration `0002` records why the table is a state row rather than an event log — interest scoring needs when something happened, not how many times — so this phase adds no `interactions` table. See D13.

`item_state.saved_at` is not used. Nothing writes it: there is no save command in the CLI, the API, or the MCP surface. A weight for a signal that is always null would be untestable. It joins when something produces it.

Each signal decays exponentially from its own timestamp with a half-life of `INTEREST_SIGNAL_HALFLIFE_DAYS`, default 30. An article you starred last year should not still be defining what you are shown today.

### Building the profile

The profile is rebuilt on a timer, `INTEREST_REBUILD_INTERVAL_MINUTES`, default 60, and on demand through `POST /interest/rebuild`. It is spherical k-means — cosine distance, unit-length centroids — over the embeddings of positively-signalled items, weighted by decayed signal strength.

k is not fixed at one value. The issue asks for five to ten clusters; five clusters over the thirty signals that first activate scoring would be five clusters of six items, which describes noise rather than interests. k is `clamp(round(sqrt(signals / 2)), 2, INTEREST_CLUSTERS_MAX)` with `INTEREST_CLUSTERS_MAX` defaulting to 10, so it reaches the issue's range at a few hundred signals and stays below it before that. See D15.

Initialisation is k-means++ driven by a seeded PRNG, seeded from the user id and the rebuild timestamp. Determinism is not cosmetic here: without it the same history produces a different timeline on each rebuild, and no test of the clustering can assert anything.

Skipped items are not clustered. A negatively-weighted point in a k-means run moves a centroid to a position that represents nothing, and cosine k-means has no meaningful notion of a repulsive member. Instead each skipped item is assigned to its nearest centroid and its decayed weight accumulates against that cluster, which therefore carries two weights: `positive_weight` from stars and reads, and `skipped_weight` from skips.

The ratio between them is the cluster's affinity, `positive_weight / (positive_weight + skipped_weight)`, and it scales that cluster's contribution to a score. A cluster nobody has skipped has an affinity of exactly 1 and is untouched; one you skip as often as you read halves. No cluster is ever removed for being skipped — an interest you have cooled on fades continuously instead of vanishing the moment a running total crosses zero. See D14.

Note what affinity is not. It is not the cluster's size or weight used as a multiplier: ranking by raw weight would let a dominant interest swamp a smaller one the item actually matches better, which is the failure a multi-cluster profile exists to avoid. Affinity is bounded to (0, 1] and is exactly 1 until you have actually skipped something near that cluster.

The loop runs in the daemon, to a fixed iteration cap or until assignments stop changing, over embeddings fetched once for signalled items only — the profile is built from what you reacted to, never from the corpus. The fetch is capped at `INTEREST_MAX_PROFILE_ITEMS` (default 5,000) in decayed-weight order, which costs nothing real: a signal ranked below that cap has decayed to near zero by definition. Any centroid that comes out zero-length is dropped rather than written, per the measured `NaN` hazard above.

### Schema

```sql
-- One row per interest cluster. Rewritten wholesale on each rebuild.
CREATE TABLE interest_clusters (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  centroid        vector(N) NOT NULL,
  -- Decayed weight of the stars and reads that built this cluster.
  positive_weight double precision NOT NULL CHECK (positive_weight > 0),
  -- Decayed weight of the skips assigned to it. Scales the cluster's
  -- contribution to a score; it never removes the cluster.
  skipped_weight  double precision NOT NULL DEFAULT 0 CHECK (skipped_weight >= 0),
  members         integer NOT NULL CHECK (members > 0),
  built_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ordinal)
);
```

`centroid` carries the same runtime-determined dimension as `item_embeddings`, so this table has the same problem and takes the same answer: it is created at runtime beside `item_embeddings`, written and queried through raw SQL, and outside the Drizzle mirror. Concretely it is created by the same `ensureItemEmbeddings` path and dropped by the same `rebuildItemEmbeddings` path, because a profile built in one model's vector space is meaningless in another's. `tsuzuri reindex --embedding-model` therefore discards the profile along with the vectors, and the next rebuild recreates it.

There is no `interest_scores` table. See D16.

### Scoring

```sql
WITH matched AS (
  SELECT i.id,
         i.published_at,
         i.published_at_estimated,
         -- Affinity is inside max(), not applied to its result. See below.
         max((1 - (e.embedding <=> c.centroid))
             * (c.positive_weight / (c.positive_weight + c.skipped_weight)))
           AS affinity_similarity
  FROM items i
  JOIN item_embeddings e ON e.item_id = i.id
  CROSS JOIN interest_clusters c
  WHERE c.user_id = $userId
    AND c.centroid <> $zeroVector        -- see the NaN measurement above
    AND i.published_at > now() - $window
  GROUP BY i.id, i.published_at, i.published_at_estimated
)
SELECT id,
       affinity_similarity,
       affinity_similarity
         * pow(0.5, extract(epoch FROM now() - published_at)
                    / ($halflifeHours * 3600))
         * CASE WHEN published_at_estimated THEN $estimatedFactor ELSE 1 END
         AS interest
FROM matched
ORDER BY interest DESC
LIMIT $limit;
```

Points that are load-bearing rather than incidental:

- The affinity factor is inside `max()`, not applied to its result. Two clusters can sit near the same item with different affinities, and the one that should decide the score is the best *penalised* match, not the nearest match penalised afterwards. Applying it outside would let a cluster you mostly skip carry an item on raw proximity. This is pinned by a test that fails under the other placement.
- The recency half-life is `INTEREST_RECENCY_HALFLIFE_HOURS`, default 72. At that setting a week-old item scores 0.2 of its similarity, which is what the issue's "week-old items do not stay pinned" asks for.
- An estimated publication date is a guess, and the glossary already states that ranking must not treat a guess as breaking news. Because the guess is the fetch time, an estimated item always looks brand new. It is discounted by `INTEREST_ESTIMATED_DATE_FACTOR`, default 0.7, rather than backdated to an invented time. See D18.
- The candidate window is `INTEREST_WINDOW_DAYS`, default 30, and exists to bound the scan. The measurement above says 20,000 rows cost 46 ms unbounded, so the window is generosity rather than necessity at that size; it stops being generous at a million.
- The zero-centroid filter is present even though the builder refuses to write one. Two independent guards for a failure whose signature is silently wrong ranking, no error, and no way to notice.

### Activation and the exploration slot

Scoring is off unless `INTEREST_SCORING_ENABLED` is set, and it is unset by default. Once enabled it is still inactive until embeddings are ready, until `INTEREST_MIN_SIGNALS` decayed signals exist (default 30), and until a profile has been built.

Every one of those is a reason a list came back in date order, and a caller cannot tell them apart from the list. So the response carries `scoring: { active, reason, signals, required }` and `doctor` reports the same, in the shape `/search` established for its `mode` and `reason` in P2. Asking for `sort=score` while any of them is unmet is not an error: the request degrades to reverse-chronological and names which one, because an install with scoring switched off is a supported configuration rather than a broken one. The issue asks that it says when scoring becomes active; the same field also answers "why is this list not ranked" and "how much further do I have to go", which is the question someone actually has on day one.

A share of every ranked list, `INTEREST_EXPLORATION_RATIO` (default 0.2), is reserved for items scoring did not choose. They are taken from subscriptions with the fewest reads in the window, most recent first — "unexplored sources" in the issue's words — and are deterministic rather than random. A timeline that reshuffles on every refresh is unusable, and a randomised one cannot be tested. Each hit carries `exploration: true` so the CLI and the web UI can label it; an unlabelled item that ranking did not choose is indistinguishable from a ranking bug. See D19.

### Where the score is applied

`GET /items` gains `sort=recent|score` and returns the ranking metadata described above. `TIMELINE_DEFAULT_SORT` chooses the default and is `recent`. `tsuzuri read --by score` selects it at the command line.

Turning scoring on is therefore two steps: an embedding model, then `INTEREST_SCORING_ENABLED`. An earlier draft of this document made the second step implicit, on the grounds that building the profile costs no external call and no model — it is arithmetic over vectors already on disk, measured at 46 ms. That reasoning is about implementation cost, and the project's fixed constraint is not about cost: AI is opt-in and defaults to off. Deriving a model of what someone reads is the thing being opted into, whether or not it is cheap. The flag costs one line of configuration and one line in `doctor`. See D20.

## Part 2: duplicate clustering (#6)

### What a cluster is

A cluster is a set of items reporting the same story, per the glossary. Items are already global by canonical URL, so byte-identical syndication is handled; what is left is the same story rewritten by eight outlets.

Two signals, because they fail differently. Embedding distance catches a rewrite that shares no phrasing. SimHash catches near-verbatim wire copy that embedding distance can miss when both texts are long and the model's vector is dominated by topic rather than wording — and, more usefully, it works with no embedding model configured at all. Clustering is therefore partly available on an install with no AI, which is the same reason ingest and enrich are separate.

### Schema

```sql
CREATE TABLE clusters (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_item_id text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  size                   integer NOT NULL DEFAULT 1 CHECK (size > 0),
  first_published_at     timestamptz NOT NULL,
  last_published_at      timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- An item belongs to at most one cluster, hence item_id as the key.
CREATE TABLE item_clusters (
  item_id    text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  -- How it matched, for debugging a cluster that looks wrong.
  matched_by text NOT NULL CHECK (matched_by IN ('embedding', 'simhash', 'both')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_clusters_by_cluster ON item_clusters (cluster_id);

CREATE TABLE item_simhash (
  item_id  text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  simhash  bit(64) NOT NULL,
  hashed_at timestamptz NOT NULL DEFAULT now()
);
```

Membership is a separate table rather than a column on `items` because ingest owns `items` and enrichment must not write there. That separation is what makes the whole of this phase optional, and it is worth one join to keep.

`clusters` and `item_clusters` carry no dimension, so unlike the interest profile they are ordinary numbered-migration tables in the Drizzle mirror.

### SimHash

Computed in `packages/core/src/simhash.ts` over `search_text`: character 3-gram shingles, each hashed with the existing `sha256` helper and truncated to 64 bits, summed per bit position with the shingle's occurrence count as its weight, then taken as the sign of each position.

Character n-grams rather than word tokens, uniformly across scripts. Whitespace tokenisation does not segment Japanese, which is the same reason PGroonga is a hard dependency; running a word tokeniser for English and a different path for CJK would be two behaviours to tune where one works. See D22.

### The join

For each item with no cluster, look at items published within `CLUSTER_WINDOW_HOURS` (default 72) and take the best match by either signal:

- cosine distance below `CLUSTER_MAX_DISTANCE`, default 0.15 — much tighter than search's 0.6, because search wants related and this wants same;
- or Hamming distance at most `CLUSTER_SIMHASH_MAX_BITS`, default 6 of 64.

Either signal alone is enough; `matched_by` records which fired. An item joins the cluster of its best match, or opens a new cluster of one. This is single-link agglomeration over a window, which can chain — A near B, B near C, A not near C — and at these thresholds a chain means the pair really is one story told twice. Tightening further would split real duplicates apart, which is the failure the issue is about.

The worker runs on the same shape as the embedding backfill: poll for items with no `item_clusters` row, no queue table, resumable, and safe to run repeatedly. `CLUSTERING_ENABLED` defaults to false.

### Collapsing

Collapsing is a query-time decision, expressed as `DISTINCT ON (COALESCE(cluster_id::text, item_id))` over the ranked or ordered list — an unclustered item is its own group, so one query serves both cases. Verified against the planner.

The representative is the cluster member with the earliest non-estimated `published_at`, ties broken by longest `search_text`: the outlet that published first, and among simultaneous ones the version with the most content. Deterministic, and computable without reference to anything user-specific. An attractive alternative — the version from the subscription you read most — is recorded and not taken. See D23.

When a listing is collapsed, marking the visible row read marks every member of its cluster read. Anything else resurfaces the same story under the next representative, which is exactly what the issue asks to stop. `POST /items/:id/state` gains `scope: item|cluster`, defaulting to `item`; the CLI and MCP pass `cluster` when they collapsed. Note that a propagated read is not noise for interest scoring: a cluster is one story by construction, so "you read this story" is true of every member. See D24.

`--no-collapse` and `collapse=false` expand.

## Part 3: LLM enrichment (#5)

### Provider interface

Lives in `packages/core/src/chat.ts`, beside `EmbeddingProvider` and for the same reason.

```ts
export type ChatProvider = {
  /** Implementation id, recorded so a configuration change is detectable. */
  id: "openai-compatible" | "anthropic" | "gemini";
  /** Model name as the endpoint knows it. */
  model: string;
  /** One completion. No streaming: nothing here renders as it arrives. */
  complete: (request: ChatRequest, signal?: AbortSignal) => Promise<string>;
};

export type ChatRequest = {
  system: string;
  user: string;
  maxOutputTokens: number;
};
```

Disabled is the absence of a provider, `createChatProvider()` returning `null`, for the reason `createEmbeddingProvider` gives: a null object would let callers write rows that look like enrichments and are not.

Three implementations, because the three wire formats genuinely differ and none of the other two is reachable through the OpenAI-compatible one. `openai-compatible` posts to `{baseUrl}/chat/completions` with the system prompt as a message; Anthropic posts to `{baseUrl}/v1/messages` with `system` as a top-level field, an `x-api-key` header and an `anthropic-version` header; Gemini posts to `{baseUrl}/v1beta/models/{model}:generateContent` with `systemInstruction` and `contents`. Each is one file and a `fetch`, matching the existing embedding client — no vendor SDK is added. A vendor SDK would pull a dependency per provider to save nothing: the request bodies are three objects and the responses are three shapes, and the abstraction exists precisely so that the rest of the pipeline never sees them. See D25.

### Structured output

Tagging and summarisation ask for JSON and validate the reply with a zod schema; a reply that does not parse is retried once with the parse error appended, and a second failure is recorded as an enrichment failure against the item.

Not the providers' structured-output modes. Those are three different mechanisms — `output_config.format`, `response_format`, `responseSchema` — and the OpenAI-compatible implementation is the one that covers Ollama, LM Studio, vLLM and OpenRouter, most of which implement none of them or implement them partially. A capability that works on one of three providers is a capability the pipeline cannot rely on, and the fallback path would have to exist anyway. See D26.

### Schema

```sql
CREATE TABLE enrichments (
  item_id        text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('summary', 'translation', 'tags')),
  -- Target language for a translation; empty string otherwise, because a
  -- nullable column cannot carry a primary key.
  lang           text NOT NULL DEFAULT '',
  model          text NOT NULL,
  prompt_version text NOT NULL,
  content        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind, lang, model, prompt_version)
);
CREATE INDEX enrichments_by_item ON enrichments (item_id, kind);

CREATE TABLE enrichment_failures (
  item_id         text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  failures        integer NOT NULL DEFAULT 1 CHECK (failures > 0),
  last_error      text,
  next_attempt_at timestamptz NOT NULL,
  PRIMARY KEY (item_id, kind)
);

CREATE TABLE tag_vocabulary (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  label        text NOT NULL,
  status       text NOT NULL DEFAULT 'candidate'
               CHECK (status IN ('approved', 'candidate', 'rejected')),
  -- How many times a candidate has been suggested. The promotion threshold.
  observations integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz
);

CREATE TABLE item_tags (
  item_id    text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tag_vocabulary (id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('model', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX item_tags_by_tag ON item_tags (tag_id);
```

The primary key of `enrichments` includes `model` and `prompt_version`, so a prompt change writes a new row beside the old one instead of overwriting it. That is the whole of the issue's completion criterion — a prompt change evaluated against yesterday's articles without refetching — and it is a property of the key, not of a feature built on top. The current enrichment for an item is the row matching the configured model and the code's current prompt version. See D27.

Unbounded growth is real and bounded by hand: `tsuzuri enrich prune --keep-current` deletes rows for combinations that are neither current nor named. Automatic pruning would delete the comparison the table exists to make.

### Tagging

Tagging is classification against `tag_vocabulary`, never generation. The prompt carries the approved slugs and asks for a subset, plus optional free-text suggestions for concepts the list does not cover. Only approved tags are attached to items. Suggestions become or increment `candidate` rows, and a candidate reaching `TAG_CANDIDATE_PROMOTION_THRESHOLD` observations (default 5) is surfaced by `tsuzuri tags review`; `tsuzuri tags approve <slug>` and `tsuzuri tags reject <slug>` resolve them.

There is no seed vocabulary. Shipping one would put one person's interests in every installation, which is the same rule that keeps personal destinations out of the notifier layer. An empty vocabulary means tagging runs in suggest-only mode: nothing is tagged, candidates accumulate, and the first `tsuzuri tags review` a few days in has real material in it. This is documented so it does not read as a bug. See D28.

### Selection

Enrichment runs on the top of the ranked list, which is the point of doing scoring first. Per pass it takes the top `ENRICH_TOP_N` (default 20) unenriched items within `ENRICH_WINDOW_HOURS` (default 48), plus every starred item regardless of rank — you asked for those explicitly.

When clustering is on, only the cluster representative is enriched. A widely syndicated story is one summary, not eight, and this is where the two features pay for each other. See D29.

`ENRICH_MAX_ITEMS_PER_HOUR` (default 60) bounds spend, and `ENRICH_CONCURRENCY` (default 2) bounds pressure on a local runtime, matching `EMBEDDING_CONCURRENCY` and for the same reason.

Re-running over history is `tsuzuri enrich --since 7d [--kind summary] [--force]`, and `--force` is what re-runs items that already have a row for the current model and prompt version.

### Translation

Off unless `ENRICH_TRANSLATE_TO` names a language. It translates the title and the summary, not the body. A body translation is a large call on text you may not read, and the point of a translated summary is deciding whether to read the body at all. `tsuzuri translate <id>` translates one body on request, which is the deliberate act the cost deserves. See D30.

### The summary a response carries

Listings currently return `items.summary`, which is whatever the feed supplied. They now return the current enrichment summary when one exists and fall back to the feed's, with a `summarySource` field of `feed` or `model` beside it.

Without that field the two are indistinguishable, and "is enrichment doing anything" becomes unanswerable from a response — the same failure `mode` and `reason` were added to `/search` to prevent in P2. `itemSummarySchema` and `searchHitSchema` gain the field, and `api.contract.test.ts` covers it. See D35.

## Part 4: digest, notifiers, exporters (#7)

### Digest

```text
GET /digest?since=&limit=&unreadOnly=
tsuzuri digest [--since 7d] [--limit 20] [--format text|markdown|json] [--notify <name>]
```

A digest is a list of clusters, ranked by the highest interest score among their members, each carrying the representative, the member count, the distinct subscriptions that carried it, and the representative's summary. With scoring inactive it ranks by recency and says so, using the same `scoring` block as the timeline. With clustering off, every item is its own cluster of one and the digest is still a digest — a worse one, and not a broken one.

The cluster's summary is the representative's summary. Synthesising across eight versions of one story is an extra call per cluster to produce approximately the text the representative's summary already contains, and until there is evidence otherwise the extra call is not earned. Recorded rather than left implicit, because "cluster-level summaries" in the issue can be read either way. See D31.

`DIGEST_AT` (empty by default) makes it scheduled: a local wall-clock time at which the existing scheduler loop builds a digest and hands it to `DIGEST_NOTIFIERS`.

### Notifiers

```ts
export type Notifier = {
  id: string;
  send: (message: Notification, signal?: AbortSignal) => Promise<void>;
};

export type Notification = {
  title: string;
  /** Plain text rendering. Every implementation can send this. */
  text: string;
  /** Markdown rendering, for implementations that render it. */
  markdown: string;
  /** The structured digest, for the webhook and file implementations. */
  payload: unknown;
};
```

Implementations: `webhook` (POST JSON), `smtp`, `ntfy`, `slack`, `discord`, `file`. Slack and Discord are incoming-webhook POSTs with different body shapes, so they are thin wrappers over the webhook transport rather than three independent clients. `smtp` is the one that adds a dependency (`nodemailer`); it is listed in the issue and there is no SMTP client in the runtime.

`NOTIFIERS` is a comma-separated list, empty by default, and each implementation reads its own variables. Nothing is enabled by omission. See D32.

### Exporters

```ts
export type Exporter = {
  id: string;
  export: (item: ExportedArticle, signal?: AbortSignal) => Promise<void>;
};
```

`tsuzuri export <id> --to <name>`, and an `export_article` MCP tool.

Two implementations ship: `webhook`, which POSTs a fixed JSON document (id, url, title, summary, tags, published time) to a configured URL with configured headers, and `markdown-file`, which writes a file into a configured directory.

Karakeep and Readwise are not integrated, and integrating with them is not planned. Issue #7 names them to illustrate what an adapter over this interface would be, which is consistent with the sentence immediately after them: personal destinations are adapters over these interfaces, not code inside core. What this phase owes is the interface plus two implementations general enough to be worth having — a webhook for anything that accepts JSON, a file for everything else. Someone who wants a particular service writes an adapter, and core never learns the service exists.

This is also why no request-templating syntax appears anywhere in this document. Templating would only be needed to reach specific named services from inside core, and core is not reaching them. See D33.

### MCP

`digest` arrives here, closing D11: input `since`, `limit`, `unreadOnly`; output one row per cluster with abbreviated id, title, url, published time, summary, member count, and the subscriptions that carried it. No body text, per the standing rule.

`search_articles` gains `tags`, closing D8: filtering by approved tag slugs, pushed into both search arms as an `EXISTS` predicate exactly as the other filters are, and verified with `EXPLAIN` that both index scans survive. A new `list_tags` tool returns the approved vocabulary, because an agent cannot filter by a vocabulary it cannot see.

`get_article` with `format: summary` returns the enrichment summary when there is one. `export_article` is the one new write tool and carries the destructive annotation the others do.

## Cross-cutting

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTEREST_SCORING_ENABLED` | `false` | Build the interest profile and compute scores at all |
| `INTEREST_SIGNAL_HALFLIFE_DAYS` | `30` | Half-life of a signal when building the profile |
| `INTEREST_RECENCY_HALFLIFE_HOURS` | `72` | Half-life applied to an item's age when scoring |
| `INTEREST_ESTIMATED_DATE_FACTOR` | `0.7` | Discount for an item whose date was guessed |
| `INTEREST_MIN_SIGNALS` | `30` | Signals required before scoring activates |
| `INTEREST_CLUSTERS_MAX` | `10` | Upper bound on k |
| `INTEREST_MAX_PROFILE_ITEMS` | `5000` | Signalled items fetched to build the profile, in decayed-weight order |
| `INTEREST_EXPLORATION_RATIO` | `0.2` | Share of a ranked list reserved for unexplored sources |
| `INTEREST_WINDOW_DAYS` | `30` | Candidate window for scoring |
| `INTEREST_REBUILD_INTERVAL_MINUTES` | `60` | Profile rebuild interval |
| `TIMELINE_DEFAULT_SORT` | `recent` | `recent` or `score` |
| `CLUSTERING_ENABLED` | `false` | Run the clustering worker |
| `CLUSTER_WINDOW_HOURS` | `72` | How far back a candidate duplicate may be |
| `CLUSTER_MAX_DISTANCE` | `0.15` | Cosine distance below which two items are one story |
| `CLUSTER_SIMHASH_MAX_BITS` | `6` | Hamming distance below which two items are one story |
| `CHAT_PROVIDER` | `none` | `none`, `openai-compatible`, `anthropic`, `gemini` |
| `CHAT_BASE_URL` | — | Required once a provider is set |
| `CHAT_API_KEY` | — | Optional; local runtimes usually need none |
| `CHAT_MODEL` | — | Required once a provider is set. No default, deliberately |
| `CHAT_MAX_OUTPUT_TOKENS` | `1024` | Per-request output bound |
| `CHAT_REQUEST_TIMEOUT_MS` | `120000` | Per-request deadline |
| `ENRICH_SUMMARY` | `true` | Summarise, once a provider is set |
| `ENRICH_TAGS` | `true` | Tag, once a provider is set |
| `ENRICH_TRANSLATE_TO` | — | Target language; unset means no translation |
| `ENRICH_TOP_N` | `20` | Ranked items enriched per pass |
| `ENRICH_WINDOW_HOURS` | `48` | How far back enrichment looks |
| `ENRICH_MAX_ITEMS_PER_HOUR` | `60` | Spend bound |
| `ENRICH_CONCURRENCY` | `2` | Concurrent chat requests |
| `TAG_CANDIDATE_PROMOTION_THRESHOLD` | `5` | Observations before a candidate is surfaced for review |
| `NOTIFIERS` | — | Comma-separated notifier names; empty means none |
| `DIGEST_AT` | — | Local time for a scheduled digest; empty means none |
| `DIGEST_NOTIFIERS` | — | Which notifiers a scheduled digest uses |
| `EXPORTERS` | — | Comma-separated exporter names; empty means none |

`CHAT_PROVIDER` set without `CHAT_BASE_URL` or `CHAT_MODEL` is a startup error, the same rule and for the same reason as the embedding variables: the daemon tolerates an optional feature failing to start, and that tolerance would otherwise turn a typo into silence.

### `doctor`

`features.llm` stops being `not implemented until P3` and reports `{ enabled, provider, model, promptVersions, counts: { summarised, tagged, translated, failed } }`. Two more appear: `features.scoring` with `{ active, reason, signals, required, clusters, builtAt }`, and `features.clustering` with `{ enabled, clusters, clusteredItems, pending }`.

### Testing

- Pure unit: signal decay and recency decay arithmetic; k selection; seeded k-means++ and one full k-means run over fixed input, asserting the same centroids twice; the zero-centroid guard as a decision function; SimHash over known inputs, its stability under small edits, and Hamming distance; exploration-slot allocation; the chat response parser including the retry path; prompt-version selection; candidate promotion arithmetic.
- Provider: all three chat implementations against in-process stub servers, covering each wire format, HTTP errors, malformed JSON, and the deadline. No network.
- Database: profile build over a seeded corpus; the scoring query including the estimated-date discount and the zero-centroid filter; cluster assignment by each signal separately and by both; collapse ordering; the `enrichments` key admitting two prompt versions for one item; the digest query with clustering and scoring each on and off.
- Contract: `api.contract.test.ts` extended to the new endpoints and the changed listing shape.
- MCP: `digest`, `list_tags` and the `tags` filter driven through the in-memory transport against a stubbed daemon, asserting no body text.

Per the repo rule that an implementation change breaking no test means the tests were insufficient, each ranking choice is pinned by a test that fails under the opposite choice: the exploration ratio, the estimated-date discount, cluster-scoped read propagation, and representative selection. The zero-centroid case gets a test that fails without the guard — a seeded profile containing a cancelling cluster, asserting that no `NaN` reaches the ordering — because the failure is silent and a test is the only thing that would ever notice it.

The suite stood at 305 passing when this document was written, skipping database tests when `TSUZURI_TEST_DATABASE_URL` is unset. That split is preserved; the count is not kept current here.

### Delivery

Four draft PRs, chained, each leaving `main` in a working state:

1. `feat/p3-interest-scoring` — issue #4.
2. `feat/p3-clustering` — issue #6, based on 1.
3. `feat/p3-llm-enrichment` — issue #5, based on 2.
4. `feat/p3-digest-notifiers` — issue #7, based on 3.

Clustering does not depend on scoring in code; the chain is linear because both touch the listing query, and resolving that once in sequence beats resolving it twice in a merge.

Commits and PR bodies carry `sid: MH56CM`.

### Documentation

README gains a configuration section for the chat, scoring, clustering, digest and notifier variables; a statement that ranked ordering is opt-in and why; a note that a chat model can be changed freely where an embedding model cannot; the digest and tag commands; and the new MCP tools. `docs/glossary.md` gains the terms listed above. English, consistent with the existing docs.

## Decisions

Proposed. Nothing here is settled until this document is approved.

| # | Decision | Resolution |
| --- | --- | --- |
| D13 | Where interest signals come from | `item_state` timestamps. No `interactions` table — migration `0002` already settled that the state row is deliberate, and scoring needs when rather than how many. `saved_at` is unused because nothing writes it |
| D14 | How skipped items participate in clustering | Not clustered. Each is assigned to its nearest centroid and accumulates into that cluster's `skipped_weight`; the cluster's affinity, `positive / (positive + skipped)`, scales its contribution to a score, and no cluster is ever removed for being skipped. Rejected: weighted k-means with negative weights, which moves a centroid to a position representing nothing; a separate set of aversion centroids, which adds a concept the glossary does not have for one of three signals; and dropping a cluster once its net weight crosses zero, which makes an interest vanish at a threshold instead of fading. Settled 2026-08-12 |
| D15 | K-Means or HDBSCAN, and how many clusters | Spherical k-means with seeded k-means++, k = `clamp(round(sqrt(signals / 2)), 2, 10)`. No maintained TypeScript HDBSCAN exists, and its variable cluster count plus noise label would still have to be mapped onto the issue's five-to-ten contract. Determinism is required or the timeline reshuffles on every rebuild and nothing about it is testable |
| D16 | Whether interest scores are stored | Computed per query. Measured at 46 ms for 20,000 items against ten centroids. A stored score would need invalidating on every rebuild and is stale by construction anyway, because the score contains a time decay |
| D17 | A centroid can be zero-length | Refuse to write one, and filter in the query as well. Measured: cosine distance to a zero vector is `NaN`, `max()` propagates it, PostgreSQL sorts `NaN` first, and `l2_normalize` returns the zero vector unchanged. The failure is silently wrong ranking with no error |
| D18 | Estimated publication dates always look like breaking news | Multiply the decay by `INTEREST_ESTIMATED_DATE_FACTOR`, default 0.7. Rejected: backdating to an invented time, which replaces a known guess with an unknown one |
| D19 | How exploration slots are filled | Deterministically, from subscriptions with the fewest reads in the window, most recent first, and labelled `exploration: true` in the response. Rejected: random selection, which reshuffles the timeline on every refresh and cannot be tested |
| D20 | Whether scoring itself is opt-in, or only ordering by it | Both. `INTEREST_SCORING_ENABLED` defaults to false and gates the profile build and the scoring query; ordering by the result is separately opt-in per call or by `TIMELINE_DEFAULT_SORT`. Rejected: computing automatically once embeddings are on, on the grounds that it costs no external call — that argues from implementation cost, and the constraint is not about cost. Deriving a model of what someone reads is the thing being opted into whether or not it is cheap. Settled 2026-08-12 |
| D21 | How the two clustering signals combine | Either alone is sufficient, within a 72-hour window: cosine distance below 0.15, or Hamming distance at most 6 of 64. `matched_by` records which. Requiring both would miss the wire copy the embedding arm scores as merely related, and the SimHash arm is what makes clustering partly work with no model configured |
| D22 | SimHash tokenisation | Character 3-grams uniformly. Word tokenisation does not segment Japanese, which is why PGroonga is a dependency; two tokenisers would be two behaviours to tune where one works |
| D23 | Which member represents a cluster | Earliest non-estimated `published_at`, ties broken by longest `search_text`. Rejected for now: the member from the subscription you read most, which is the version you would rather read but couples clustering to reading history and makes the representative user-specific |
| D24 | Read state across a cluster | Marking a collapsed row read marks every member. Anything else resurfaces the story under the next representative. The propagated read is not noise for scoring, because a cluster is one story by construction |
| D25 | Chat provider implementations | Three thin `fetch` clients, one per wire format, no vendor SDKs. The three request shapes differ genuinely — top-level `system` and an `anthropic-version` header, a system message, `systemInstruction` and `contents` — and a dependency per provider would buy nothing the abstraction does not already give |
| D26 | How structured output is obtained | JSON asked for in the prompt, validated with zod, one retry with the parse error, then a recorded failure. Rejected: the providers' structured-output modes, which are three different mechanisms and are unimplemented or partial across most of what `openai-compatible` targets, so the fallback would exist anyway |
| D27 | What makes a prompt change replayable | `model` and `prompt_version` in the primary key of `enrichments`, so a change writes beside rather than over. The issue's completion criterion is a property of the key. Growth is bounded by an explicit `enrich prune`, never automatically |
| D28 | Whether a starting tag vocabulary ships | No. It would put one person's interests in every installation. An empty vocabulary runs tagging in suggest-only mode, and that is documented so it does not read as a bug |
| D29 | Which items are enriched | Top `ENRICH_TOP_N` of the ranked list within the window, plus every starred item, and only the representative of a cluster. The last is where clustering pays for enrichment: one syndicated story is one call rather than eight |
| D30 | What translation covers | Title and summary. A body translation is a large call on text you may not read; `tsuzuri translate <id>` does one body on request |
| D31 | What a cluster-level summary is | The representative's summary. Synthesising across members is an extra call per cluster for approximately the same text; recorded because the issue's wording admits both readings |
| D32 | The notifier set | `webhook`, `smtp`, `ntfy`, `slack`, `discord`, `file`. Slack and Discord are webhook body shapes rather than separate clients. `smtp` adds `nodemailer`, the one dependency in this phase, because the runtime has no SMTP client |
| D33 | Karakeep and Readwise adapters | Neither is integrated and neither is planned. Issue #7 names them to illustrate what an adapter over the interface is, not as deliverables; its own next sentence says personal destinations are adapters rather than core code. Core ships the `Exporter` interface plus `webhook` and `markdown-file`. No request-templating syntax is introduced, because templating would exist only to reach named services from inside core. Confirmed with the author 2026-08-12 |
| D34 | The P2 deferrals | `digest` arrives as an MCP tool, closing D11 now that clustering and summarisation exist. `tags` arrives on `search_articles`, closing D8, with `list_tags` so the vocabulary is discoverable |
| D35 | Feed summary and model summary are indistinguishable in a response | Add `summarySource: feed \| model`. Without it, "is enrichment doing anything" cannot be answered from a response — the failure `/search`'s `mode` and `reason` exist to prevent |

## Review

Settled with the author on 2026-08-12, and folded into the text above:

- The six glossary additions, applied to `docs/glossary.md`.
- D14. A skipped cluster fades by affinity rather than being dropped at a threshold.
- D20. `INTEREST_SCORING_ENABLED`, default false. Scoring is opt-in, not only the ordering.
- D33. Karakeep and Readwise are illustrations in the issue, not integrations. No templating.

Nothing is open. This document is ready for a decision on whether to implement it.
