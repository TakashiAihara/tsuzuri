# P3: AI processing — interest scoring, enrichment, duplicate clustering, digest

Design for issues #4 (interest scoring), #5 (LLM enrichment), #6 (duplicate clustering) and #7 (digest and notifiers). One document because the four depend on each other: scoring consumes embeddings and interaction history, enrichment runs only on what scoring ranks highly, digest is built over clusters and summaries.

Terms follow `docs/glossary.md`. In particular: cluster (unqualified) is a set of items reporting the same story; interest cluster is a group of vectors from reading history; interest score is match against history, independent of any query.

## Scope

- Interest profile built from `item_state` history, as multiple interest clusters, rebuilt periodically (#4).
- Interest scoring of items: max similarity to any interest cluster × time decay, with an exploration slot and a reverse-chronological fallback until history suffices (#4).
- `ChatProvider` abstraction and an `enrichments` store for summaries, translations and tags, replayable after prompt changes (#5).
- Tagging as classification against `tag_vocabulary`, with candidate accumulation for human approval (#5).
- Duplicate clustering by embedding similarity plus SimHash, one representative per cluster in timeline and digest (#6).
- `tsuzuri digest --since` producing cluster-level summaries of top items, notifier and export-target interfaces (#7).

Out of scope, deliberately:

- Web UI surfaces for any of this (P4). The daemon API carries the data; the CLI and MCP are the P3 read paths.
- Multi-user separation of profiles and scores beyond keying by `user_id` (issue #30, P4).
- LLM extraction of article content (P6). Chat models here only summarise, translate, tag.

## Fixed constraints

These come from the architecture and from repo policy; the design below does not revisit them.

- All AI is opt-in. With no chat model configured, scoring and clustering still work (they need only embeddings); with no embedding model either, everything in P3 degrades to today's behaviour. Nothing in ingest may come to depend on enrich.
- One instance, one embedding model. Interest clusters live in the same vector space as `item_embeddings`, so `tsuzuri reindex --embedding-model` must also clear the interest profile.
- The daemon is the only writer. CLI and MCP trigger P3 operations through the daemon API, never by touching the database.
- Tagging never generates free text. The vocabulary is closed; unknown concepts become candidates, not tags.
- MCP list responses carry no article body text. Digest entries carry summaries, which are enrichments, not bodies; that stays within the rule.
- Nothing author-specific in core. Karakeep, Readwise, a personal Obsidian vault: adapters behind the export-target interface, not built-ins.

## Existing facts driving the design

### `item_state` is already the interaction log

The schema comment on `item_state` records the decision: a state row rather than an append-only event log, because interest scoring needs "when did this happen", and `read_at` / `starred_at` / `skipped_at` / `saved_at` timestamps answer that. So P3 adds no `interactions` table. The signal extraction reads `item_state` joined to `item_embeddings`. What is lost relative to an event log — repeated reads of the same item — was judged not worth storing, and this design keeps that judgement.

### The vector dimension exists only at runtime

`item_embeddings` is created at runtime because the dimension is fixed by the active embedding model (P2, D1). Interest cluster centroids have the same dimension, so the same applies: the centroid table is created at runtime next to `item_embeddings` and queried with raw SQL outside the Drizzle mirror.

### The embed worker is the pattern for new workers

`apps/daemon/src/enrich/embed-worker.ts` already shows the shape: an interval loop owned by the daemon, incremental, resumable, findable state in the database rather than in memory. The profile rebuild worker, the clustering pass and the enrichment worker follow it.

### Sub-second scoring is available in SQL

Scoring a candidate item is a max over 5–10 centroid distances. With `interest_clusters` holding at most a few dozen rows, `max(1 - (ie.embedding <=> ic.centroid))` over a cross join is cheap and needs no index. The expensive part, clustering history, happens in the rebuild worker, not per request.

## Part 1: interest profile and scoring (#4)

### Signals

One signal row per `(user, item)` with an embedding, derived from `item_state`:

- weight: starred 3.0, read 1.0, skipped −1.0. `saved_at` counts as starred-strength interest (3.0) — saving is a stronger act than reading.
- If several timestamps are set, the strongest wins; a star after a skip means interest.
- time decay: `exp(-ln(2) · age / half_life)` where age is `now() - <timestamp of the winning signal>` and half-life is `SCORING_HALF_LIFE_DAYS` (default 30).

### Clustering the history

- Algorithm: K-Means over the signal vectors, weights applied when averaging. Own implementation in `packages/core` (a K-Means over a few thousand vectors is ~40 lines); HDBSCAN would pull a dependency and its density parameters are harder to explain to a self-hoster than "k".
- k: `SCORING_CLUSTERS` (default 8, bounded 2–32). The issue says 5–10; a fixed default in that range with a config escape beats auto-selection (elbow/silhouette) that would make scoring behaviour vary run to run.
- Negative-weight signals (skips) do not form clusters; they subtract. Items whose nearest cluster is dominated by skip weight lower that cluster's own weight, so a persistently skipped topic fades rather than pinning a "disinterest" centroid that attracts nothing.
- Rebuild cadence: `SCORING_REBUILD_INTERVAL_MS` (default 6 h) in a worker following the embed-worker pattern. A rebuild is a full recompute; there is no incremental path to maintain or get wrong.
- Activation threshold: the profile is not built until `SCORING_MIN_INTERACTIONS` (default 30) signal rows with embeddings exist. Below it, ranking stays reverse-chronological and the API says so.

### Storage

Runtime-created, raw SQL, next to `item_embeddings`:

```sql
CREATE TABLE IF NOT EXISTS interest_clusters (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ordinal    int  NOT NULL,
  centroid   vector(<dimension>) NOT NULL,
  weight     real NOT NULL,           -- summed signal weight, for diagnostics and exploration ratio
  item_count int  NOT NULL,
  built_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id, ordinal)
);
```

A rebuild replaces the user's rows in one transaction. `tsuzuri reindex --embedding-model` truncates this table along with `item_embeddings`; the profile rebuilds itself once backfill has re-embedded enough history.

### Scoring and the timeline

- interest score = `max over clusters (1 - cosine distance)` × freshness decay, freshness using the same half-life family but its own knob `SCORING_FRESHNESS_HALF_LIFE_HOURS` (default 48): interests move in weeks, timelines in days.
- Where: the existing unread listing gains `order=interest` (default remains `order=published`). When the profile is inactive or the item set has no embeddings, `order=interest` answers with reverse-chronological plus `"scoring": "inactive"` and a reason, mirroring text-only mode in search (P2).
- Exploration slot: with `order=interest`, `SCORING_EXPLORATION_SHARE` (default 0.15) of each page is filled by recent items *not* chosen by score — sampled from below the cut, weighted toward subscriptions the user has never interacted with. Marked `"exploration": true` in the response so clients can render them distinctly.
- Estimated dates (`published_at_estimated`) already may not be treated as breaking news; the freshness term uses `published_at` as stored, and the existing rule suffices.

### Surfacing state

- `doctor` reports: profile active or not, signal count vs threshold, clusters and their sizes, last rebuild time.
- `tsuzuri read` (and the API) label the fallback: "scored" vs "chronological (n/30 interactions)".

## Part 2: chat provider and enrichment (#5)

### Provider interface

`ChatProvider` in `packages/core`, shaped like `EmbeddingProvider`:

```ts
export type ChatProvider = {
  readonly model: string;
  complete(req: { system: string; user: string; json?: boolean }): Promise<string>;
};
```

- Config: `CHAT_PROVIDER` (`none` | `openai-compatible`, default `none`), `CHAT_BASE_URL`, `CHAT_API_KEY`, `CHAT_MODEL`, `CHAT_REQUEST_TIMEOUT_MS` (default 120 000), `CHAT_CONCURRENCY` (default 1). Same superRefine pattern: setting `CHAT_PROVIDER` without base URL or model is a startup error, not silence.
- The issue lists Anthropic and Gemini as provider kinds. The interface admits them; this phase ships `openai-compatible` only, which both vendors expose natively. A dedicated `anthropic` / `gemini` kind is added the day someone needs a vendor feature the compatible endpoint lacks (recorded as D15).

### The `enrichments` table

A static migration — nothing here depends on the vector dimension:

```sql
CREATE TABLE enrichments (
  item_id        text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind           text NOT NULL,           -- 'summary' | 'translation' | 'tags'
  content        jsonb NOT NULL,
  chat_model     text NOT NULL,
  prompt_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind, prompt_version, chat_model)
);
```

- `content` shapes per kind: summary `{ text, language }`, translation `{ title, text, language }`, tags `{ tags: string[], candidates: string[] }`.
- The primary key makes replay additive: re-running after a prompt change writes new rows, old rows remain for comparison. Readers select the row with the highest `prompt_version` for the configured model, falling back to any model's latest (a model switch must not blank every summary).
- Prompt versions are constants in the code next to the prompts themselves (`summary.v1`, bumped by hand when the prompt text changes). Content-hashing prompts would version automatically but make two textually different but semantically equal prompts incomparable; a hand bump states intent.

### Selection: what gets enriched

Sending everything to a model is the failure mode the two-stage pipeline exists to avoid.

- The enrichment worker runs on an interval (`ENRICH_INTERVAL_MS`, default 15 min) and takes the top `ENRICH_TOP_N` (default 50) unenriched items of the last `ENRICH_WINDOW_HOURS` (default 48) by interest score — or by recency while scoring is inactive.
- Starring or saving an item enqueues it for enrichment regardless of score: an explicit act of interest outranks the ranking.
- Digest generation (part 4) enriches the items it needs on demand, so a digest never waits for the worker's schedule.
- Replay is explicit: `tsuzuri enrich --since <t> [--kind ...]` re-runs over history with the current prompts, answering the issue's "evaluate a prompt change against yesterday's articles without refetching".

### Tagging

- Classification against `tag_vocabulary`:

```sql
CREATE TABLE tag_vocabulary (
  tag        text PRIMARY KEY,
  status     text NOT NULL DEFAULT 'candidate',  -- 'candidate' | 'approved'
  hits       int  NOT NULL DEFAULT 1,            -- times the model proposed it
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE item_tags (
  item_id  text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag      text NOT NULL REFERENCES tag_vocabulary (tag) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag)
);
```

- The prompt presents the approved vocabulary and asks the model to choose from it, plus to name up to two concepts not covered. Chosen tags land in `item_tags` (approved tags only); named concepts upsert `tag_vocabulary` as candidates, incrementing `hits`.
- Approval is human: `tsuzuri tags` lists candidates by `hits`, `tsuzuri tags approve <tag>` / `reject <tag>`. Rejection deletes the row; the model re-proposing it recreates the candidate, and repeated rejection is visible in `hits` staying low. Initial vocabulary is empty, as the architecture prescribes.
- Search gains the `tags` filter that P2's D8 deferred: pushed into both arms like the existing filters.

## Part 3: duplicate clustering (#6)

### Two signals, both required

- SimHash: 64-bit over word shingles of `search_text`, stored as a `bigint` column added to `items` by migration, computed at ingest for every item (pure function in `packages/core`, no AI dependency). Hamming distance ≤ `CLUSTER_SIMHASH_MAX_DISTANCE` (default 6) marks near-identical wording — syndicated copy.
- Embedding cosine distance ≤ `CLUSTER_MAX_COSINE_DISTANCE` (default 0.25) marks same-story-different-words.
- An item joins a cluster if either signal matches the cluster's representative. SimHash alone still clusters the syndication case when no embedding model is configured; the embedding signal widens it to genuine near-duplicates. Requiring both would reduce the feature to exact-copy detection.

### Mechanics

```sql
CREATE TABLE clusters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_item text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE items ADD COLUMN cluster_id uuid REFERENCES clusters (id) ON DELETE SET NULL;
```

- A worker pass (piggybacking on the embed worker's cadence) takes items not yet assigned, compares against representatives of clusters whose representative published within `CLUSTER_WINDOW_HOURS` (default 72): the same story does not arrive a week apart, and the window keeps the comparison set tiny.
- No match → the item becomes its own cluster of one. Match → it joins; the representative stays the earliest-published member (first outlet to run the story), a deterministic choice that never needs re-election.
- Timeline and digest collapse to representatives, carrying `cluster_size` and, on demand, the member list. Search does not collapse: when you searched for it, showing every version is correct.
- Read state stays per item. Marking a representative read marks only it; the timeline treats a cluster as read when its representative is (cheap, predictable). Glossary examples ("a widely syndicated story occupies one row instead of eight") concern display, not state.

## Part 4: digest and notifiers (#7)

### Digest

- `GET /digest?since=<t>&limit=<n>` on the daemon; `tsuzuri digest --since 24h` renders it. Content: top clusters of the window by best member interest score (recency while scoring is inactive), each entry the representative's title, url, cluster size, tags and summary — enriched on demand if missing and a chat model is configured; without one, the entry carries the feed-provided summary or nothing.
- The digest is computed, not stored. Two invocations may differ as scores move; a digest worth archiving is one you exported.
- MCP gains the `digest` tool deferred by P2's D11, now that its grouping is honest: cluster-level, as the name promises.

### Notifiers

- Interface in `packages/core`: `notify(digest: Digest): Promise<void>`, chosen by `NOTIFIER` (`none` | `file` | `webhook` | `smtp` | `ntfy` | `slack` | `discord`, default `none`), each with its own `NOTIFIER_*` config keys validated by the same superRefine pattern.
- This phase implements `file` (markdown to a path) and `webhook` (JSON POST) fully — they cover testing and every self-hosted automation hub. `smtp`, `ntfy`, `slack`, `discord` are each ~30-line adapters over the same payload, added in the same PR if time allows, otherwise as follow-ups; the interface is the deliverable.
- Schedule: `NOTIFIER_INTERVAL` accepts `daily@07:00`-style times; the daemon sends the digest of the period since the last send. No cron dependency; the daemon already owns interval loops.

### Export targets

- `tsuzuri export <item-id> [--target <name>]` sends one article onward: `webhook` (JSON POST) and `markdown` (file per article) in this phase. Karakeep, Readwise and other services are adapters over the same interface, deliberately not in core (fixed constraint). The export payload includes the enrichment summary and tags when present.

## Cross-cutting

### Delivery order

Four stacked PRs, each leaving main working (repo rule):

1. #4 scoring — signals, K-Means, `interest_clusters`, `order=interest`, exploration slot, doctor.
2. #6 clustering — SimHash at ingest, `clusters`, collapse in timeline. Depends only on embeddings and can precede #5.
3. #5 enrichment — `ChatProvider`, `enrichments`, tagging, `tsuzuri enrich`, search `tags` filter.
4. #7 digest — `/digest`, CLI, MCP tool, notifier and export interfaces with `file` + `webhook`.

### Testing

- K-Means, SimHash, decay math, exploration sampling: pure functions in `packages/core`, unit-tested without a database, with negative controls (break the implementation, watch the pinned test fail, in every direction the test claims to guard).
- Scoring SQL, cluster assignment, enrichment replay: DB tests behind `TSUZURI_TEST_DATABASE_URL`, following the P2 suites.
- `ChatProvider`: contract-tested against a stub HTTP server, as the embedding provider is; prompts tested by asserting on the request payload, not by calling a live model.
- API contract: every new response shape lands in `packages/api` and `api.contract.test.ts` in the same PR (unknown-field detection is already in place).

### Documentation

- README: a P3 section per feature, each starting from "off by default" and showing the smallest enabling config.
- Glossary: already defines the P3 terms; additions if implementation coins anything new (it should not).

## Decisions

| # | Question | Decision |
|---|---|---|
| D13 | Where interaction history lives | In `item_state` as already designed; no `interactions` event table. The schema comment made this call in P1 and nothing in P3 needs event multiplicity |
| D14 | Clustering algorithm for the interest profile | K-Means, own implementation, `SCORING_CLUSTERS` default 8. HDBSCAN adds a dependency and parameters harder to explain than "k"; auto-selecting k would make ranking vary run to run |
| D15 | Chat provider kinds in v1 | Interface admits `anthropic` / `gemini`; only `openai-compatible` ships, both vendors expose it. A native kind is added when a vendor-only feature is actually needed |
| D16 | Enrichment storage on prompt change | Additive rows keyed by (item, kind, prompt_version, chat_model); replay never overwrites, comparison is a query |
| D17 | Cluster membership signals | Embedding cosine OR SimHash, not AND. AND reduces the feature to exact-copy detection; SimHash alone keeps clustering alive with no embedding model |
| D18 | Cluster representative | Earliest published member, never re-elected. Deterministic and stable under later arrivals |
| D19 | Digest persistence | Computed, not stored. Archiving is what export is for |
| D20 | Notifier scope in this phase | Interface plus `file` and `webhook` implementations; `smtp` / `ntfy` / `slack` / `discord` are same-payload adapters, follow-ups if the PR would otherwise grow |
| D21 | Where the `tags` search filter lands | In PR 3 with the vocabulary, completing P2's D8 deferral |
