# Glossary

The vocabulary this project is written in. It exists because several of these words are ordinary English that could reasonably mean two things here, and a term that drifts takes the implementation with it.

Rules for this file:

- One meaning per term. Where a word already carries two, the collision is written down and one of the two meanings gets a qualifier it must always be used with.
- Every term names where it lives — a table, a type, an endpoint — so a definition can be checked rather than believed.
- Terms for phases that are not built yet are defined here anyway. The point is to fix them before they are implemented, not after.

## Terms that collide

These are the ones to be careful with. Each pair is two genuinely different things that a single English word would cover.

### cluster

- cluster, unqualified, means a set of items reporting the same story. One event arriving through ten subscriptions is one cluster. It is what `digest` groups by. Table `clusters`, phase P3.
- interest cluster means a group of vectors derived from your own reading history, representing one of your interests. There are five to ten of them per user, and a new item's interest score is its similarity to the nearest one. It contains no items and is never shown to you. Phase P3.
- Never write "cluster" when the interest kind is meant. Always "interest cluster".

### model

- embedding model turns text into a vector. Together with any requested output width (`EMBEDDING_DIMENSIONS`), its identity fixes the vector dimension, so both are recorded in `embedding_model` and changing either means re-embedding everything.
- chat model produces text: summaries, translations, tags. It can be changed freely, because nothing on disk is shaped by it. Phase P3.
- "model" alone is ambiguous and should not appear in code or docs. Configuration says so too: `EMBEDDING_MODEL`, and later `CHAT_MODEL`.

### score

- search score is the RRF value a `/search` result carries. It orders one result set and means nothing across queries.
- text score is PGroonga's per-row relevance, normalised by document length. It exists only as an input to the text arm's rank.
- vector distance is cosine distance from pgvector. Lower is closer, which is the opposite direction from every other number here.
- interest score is how much a given item matches your reading history, independent of any query. Phase P3.
- Anywhere all four could be meant, use the qualified name.

### provider

- A provider is an external dependency behind an interface, chosen by configuration, defaulting to off or to something that works anywhere.
- embedding provider, chat provider, storage provider and notifier are separate interfaces that share the pattern. They are never referred to collectively as "the provider".

### source

- Source, capitalised, is the TypeScript interface that turns a subscription into items. Feeds, YAML rules and plugins are implementations of it. Defined in `packages/core/src/source.ts`.
- subscription is one row in the `sources` table: a URL you subscribed to, with its schedule and health.
- The table is called `sources` for historical reasons and stays that way. In prose and in user-facing output, a row is a subscription, and "source" on its own refers to the interface.

## Ingest

- ingest is fetching and storing. It is responsible only for not losing articles, and it runs whether or not any AI is configured.
- enrich is everything derived from an article after it is stored: embeddings, summaries, tags, scores. It is asynchronous, re-runnable over history, and entirely optional. The separation is why an LLM outage cannot cost you articles.
- item is one article. Items are global rather than per-subscription, because the same article genuinely arrives through several subscriptions and read state has to be per article. Table `items`.
- item identity is the SHA-256 of the canonical URL, and it is the item's primary key. Deliberately not the feed's `<guid>`, because feeds that mutate their own guid on every fetch would otherwise look like a flood of new articles.
- canonical URL is the identity form of a URL: scheme forced to https, host lowercased, tracking parameters removed, parameters sorted, trailing slash and fragment dropped. Used only for deduplication.
- resolved URL is the form actually fetched and linked. It keeps its original scheme, because http-only sites exist and "upgrading" them breaks the fetch. Never use one where the other is meant.
- content hash is the SHA-256 of a fetched response body, and it is the real change-detection gate. Conditional GET is sent as well, but many servers ignore it and CDNs rewrite ETags.
- search text is the plain text derived from an article's title and body, and the only column PGroonga indexes. Column `items.search_text`.
- estimated date marks an item whose `published_at` is the fetch time because the source gave no usable date. Ranking must not treat a guess as breaking news. Column `items.published_at_estimated`.
- source kind is which implementation handles a subscription: `feed`, `external`, `rule` or `plugin`. Adding one must not require changes outside the source layer.
- source status is whether a subscription is producing items: `active`, `degraded`, `unsupported`, `disabled`. `unsupported` specifically means nothing is broken and a component the subscription needs is not installed, which is why it is not a failure.

## Embeddings

- embedding is a fixed-length vector representing an article's meaning. Two articles about the same thing have vectors close together, which is what makes paraphrase searchable. Table `item_embeddings`.
- dimension is the length of that vector: the model's native width, or the narrower width it was asked for. pgvector fixes it in the column definition, which is the root of every constraint below, and indexes at most 2,000 of them.
- active model is the one embedding model an instance is using. There is exactly one, recorded in `embedding_model`. Vectors from two models must never share a column, even when their dimensions happen to match, because the spaces are unrelated and distances between them are meaningless.
- backfill is embedding items that have no vector yet. It is incremental, resumable, and destroys nothing. An item needs backfilling exactly when it has no row in `item_embeddings`, so newly ingested items are picked up without any queue.
- reindex is switching the active model: drop the index, clear the vectors, change the dimension, backfill, rebuild. It destroys every existing vector by definition. `tsuzuri reindex --embedding-model <name>`.
- The distinction matters at the command line. The daemon backfills on its own, continuously, so `tsuzuri reindex` with no flag only reports how far along it is; `tsuzuri reindex --embedding-model` rebuilds. One is safe to run at any time and the other destroys every vector.

## Search

- hybrid search is one query answered by two independent retrievers whose results are fused. Neither is a fallback for the other.
- text arm is the PGroonga side. It finds exact strings, which is what proper nouns and product names need.
- vector arm is the pgvector side. It finds things that mean the same, which is what paraphrase needs.
- RRF, Reciprocal Rank Fusion, combines the two arms by rank rather than by score, as `sum(1 / (k + rank))` with `k = 60`. Rank rather than score because PGroonga's numbers and pgvector's distances are not on comparable scales and never will be.
- rank is an arm's ordinal position, one-based. score is that arm's raw number. RRF consumes ranks; scores only produce them.
- candidate depth is how many rows each arm contributes to fusion before the final limit is applied. Larger than the requested limit, because an item ranked poorly by one arm and well by the other must still be reachable.
- text-only mode is a search running with the vector arm withdrawn, because no model is configured, the configured model does not match the stored one, or the query could not be embedded. Responses say which.

## Enrichment

Phase P3. Defined here so the terms are fixed before anything implements them.

- enrichment is one derived artefact attached to an item: a summary, a translation, a tag set, a score. It records the model and prompt version that produced it, so a prompt change can be replayed over history. Table `enrichments`.
- interest profile is the set of interest clusters for a user, rebuilt periodically from interaction history with time decay. Multiple clusters rather than one centroid, because a single average of several unrelated interests lands on a point that is none of them.
- tag vocabulary is the closed set of tags an LLM may choose from, split into approved and candidate. Tagging is a classification task against this set, never free generation, because free tags diverge until they are useless for filtering. Table `tag_vocabulary`.
- digest is a summary of a period built over clusters: the stories that happened, one entry each, rather than the articles that arrived. It requires both clustering and summarisation, which is why it does not exist before P3.
- exploration slot is a fraction of a ranked list reserved for items that scoring did not choose, so that ranking on your own history does not close the loop on itself.

## Interfaces

- daemon is the only writer. Every interface is a client of its JSON API, which is what stops one of them growing behaviour the others lack.
- CLI, web UI and MCP server are those clients. The web UI is P4.
- MCP server is the agent-facing interface. It is designed rather than transliterated from the CLI, because an agent's useful granularity is not a human's.
- list response is any MCP result carrying more than one article. Ids in them are abbreviated to twelve characters, which every tool accepts in place of a full id because the daemon resolves unique prefixes. The rule is that none of them carry article body text: full text costs a deliberate `get_article` call, so a broad query cannot exhaust an agent's context before it has chosen what to read. What they do carry is whatever the agent needs to choose — for `search_articles`, id, title, summary, score, url, published time and a bounded match snippet; `list_sources` carries subscription fields instead.
- doctor reports what is enabled and what is not. On a self-hosted product, not knowing which half of the system you turned on is the largest source of friction, so it is a first-class command rather than a diagnostic afterthought.
