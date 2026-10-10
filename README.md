# tsuzuri

A self-hosted feed reader built for a CLI and for AI agents, with first-class support for sites that do not publish a feed at all.

> Status: early. Ingest, the CLI, hybrid search, the MCP server, interest scoring, article duplicate clustering and LLM enrichment work end to end. Digests, the web UI and the plugin layer are not built yet — see [Roadmap](#roadmap).

## Why another reader

Most readers treat AI as an add-on and the browser as the only way in. tsuzuri inverts both:

- The CLI and an MCP server are the primary interfaces. The web UI comes second, and there is no mobile app.
- Summarisation, relevance scoring, tagging and deduplication are meant to be the normal way you read, not a plugin.
- Sites without RSS are a first-class subscription type, extended by declarative rules you can write and share.
- Japanese and other non-English content is expected to work properly, not to fall out of an English-first design.

**AI is entirely optional.** With no model configured, tsuzuri is a plain, fast feed reader. Everything AI-related is off until you turn it on, and you can turn on just the parts you want.

## Requirements

- [Bun](https://bun.sh) 1.2+
- Docker (for PostgreSQL)

PostgreSQL needs two extensions, so the bundled image is not interchangeable with a stock one:

- **PGroonga** — full-text search that segments Japanese and other CJK text. PostgreSQL's built-in `tsvector` tokenizer splits on whitespace, so searching for `機械学習` inside `機械学習の論文` finds nothing.
- **pgvector** — embedding storage for relevance scoring.

Managed PostgreSQL (RDS, Neon, Supabase) is **not supported**, because PGroonga cannot be installed there.

## Quick start

```bash
git clone https://github.com/TakashiAihara/tsuzuri
cd tsuzuri
bun install

# PostgreSQL with PGroonga + pgvector
docker compose up -d postgres

# The daemon migrates on boot and starts polling
DATABASE_URL=postgres://tsuzuri:tsuzuri@localhost:5432/tsuzuri \
  bun run apps/daemon/src/index.ts
```

In another shell:

```bash
alias tsuzuri="bun run apps/cli/src/index.ts"

tsuzuri feed add https://news.ycombinator.com/rss
tsuzuri feed import subscriptions.opml   # from Inoreader, Feedly, …
tsuzuri fetch --all
tsuzuri read
tsuzuri search "機械学習"                   # works without any AI configured
tsuzuri read --by score                   # ranked by what you actually read (opt-in)
tsuzuri show <id>
tsuzuri mark <id>
tsuzuri doctor                            # what is enabled, what is not
```

Every command takes `--json` for scripting. Data goes to stdout, logs to stderr.

## Configuration

All settings are environment variables. Only `DATABASE_URL` is required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `HOST` | `127.0.0.1` | Daemon bind address |
| `PORT` | `8787` | Daemon port |
| `USER_AGENT` | `tsuzuri/0.1 (+…)` | Sent on every request so site owners can identify the crawler |
| `FETCH_TIMEOUT_MS` | `20000` | Per-request timeout |
| `HOST_MIN_INTERVAL_MS` | `1000` | Minimum gap between requests to the same host |
| `FETCH_CONCURRENCY` | `20` | Feeds fetched at once |
| `DEFAULT_FETCH_INTERVAL_SECONDS` | `3600` | Polling interval for new subscriptions |
| `DEGRADE_AFTER_FAILURES` | `5` | Consecutive failures before a source is marked degraded |
| `FETCH_ALLOW_PRIVATE_TARGETS` | `false` | Allow subscriptions on your own network (loopback and private ranges). Link-local stays blocked |
| `SEARCH_MAX_DISTANCE` | `0.6` | Cosine distance beyond which a vector match is not a result |

The CLI reads `TSUZURI_ENDPOINT` (default `http://127.0.0.1:8787`), so it works against a daemon on another machine.

### Search

`tsuzuri search <query>` runs one query through two retrievers and fuses the results.

- PGroonga finds the exact string, which is what proper nouns and product names need, and what makes `機械学習` match inside `機械学習の論文まとめ`.
- pgvector finds articles that mean the same thing without sharing a word.

Neither is a fallback for the other: vector similarity buries exact names among their conceptual neighbours, and term matching misses paraphrase entirely. The two are combined by Reciprocal Rank Fusion, which ranks by agreement between them rather than by scores that are not comparable.

With no embedding model configured, search runs on PGroonga alone and says so — the response carries a `mode` of `text-only` and the reason, so an empty result is never mistaken for a disabled half.

```bash
tsuzuri search "Next.js 16" --since 7d --unread
tsuzuri search 機械学習 --json          # includes per-arm ranks and the fused score
```

Two adjustments exist because of how the underlying tools behave, and both are visible in `--json` output:

- PGroonga scores raw term frequency, with no length normalisation, so a long article mentioning a term once would otherwise outrank a short article about it. Scores are divided by the square root of the document length.
- The vector side returns its nearest matches however far away they are, so a query that few documents match textually would fill its results with whatever exists. `SEARCH_MAX_DISTANCE` bounds it.

### Embeddings

Off by default, and there is no default model: choosing one commits the database to a vector width, so it is not a choice to make on someone's behalf. With none configured, everything else works and `doctor` says embeddings are disabled.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDING_PROVIDER` | `none` | `none`, or `openai-compatible` |
| `EMBEDDING_BASE_URL` | — | Required once a provider is set. e.g. `http://localhost:11434/v1` for Ollama |
| `EMBEDDING_API_KEY` | — | Optional; local runtimes usually need none |
| `EMBEDDING_MODEL` | — | Required once a provider is set |
| `EMBEDDING_DIMENSIONS` | — | Only for models that accept a `dimensions` parameter. Checked against what the model returns |
| `EMBEDDING_BATCH_SIZE` | `32` | Texts per request |
| `EMBEDDING_CONCURRENCY` | `2` | Concurrent requests |
| `EMBEDDING_MAX_INPUT_CHARS` | `8000` | Article text sent per embedding |

`openai-compatible` covers Ollama, LM Studio, vLLM, OpenRouter and OpenAI itself. Pick a multilingual model if you read anything other than English.

The model must produce at most 2,000 dimensions, which is pgvector's ceiling for an HNSW index. Wider models are refused at startup with that explanation rather than failing later at index creation — OpenAI's `text-embedding-3-large` is 3,072 natively, and needs `EMBEDDING_DIMENSIONS` set to something within the limit.

```bash
EMBEDDING_PROVIDER=openai-compatible \
EMBEDDING_BASE_URL=http://localhost:11434/v1 \
EMBEDDING_MODEL=bge-m3 \
  bun run apps/daemon/src/index.ts
```

On first start the daemon asks the model how wide its vectors are, builds the vector column to fit, and backfills in the background, newest articles first. Progress shows up in `tsuzuri doctor`.

**One model per installation.** pgvector fixes the vector width in the column definition, so vectors from two models cannot share it — and even at equal widths their spaces are unrelated, which would make the distances between them meaningless rather than merely inaccurate. Point the configuration at a different model and the daemon keeps serving, but leaves vector search switched off and tells you why, rather than comparing vectors that are not comparable.

Switching means re-embedding everything:

```bash
# Change EMBEDDING_MODEL in the environment first, restart, then:
tsuzuri reindex --embedding-model <the-new-model>
```

That discards every existing vector, which is why it takes the model name: the flag confirms what is being rebuilt, it does not select it. `tsuzuri reindex` with no flag just reports backfill progress, since the daemon fills gaps on its own.

### Ranked reading

With a couple of hundred subscriptions, a thousand articles arrive in a day and the useful ten are somewhere in the middle. `tsuzuri read --by score` orders them by how well they match what you actually read.

```bash
INTEREST_SCORING_ENABLED=true bun run apps/daemon/src/index.ts

tsuzuri read --by score
tsuzuri read --by score --limit 10 --json   # includes the score and why it ranked
```

Off by default, and it needs an embedding model, so turning it on is two steps. The model is not implied by the embeddings: building a picture of what you read is its own thing to agree to, and the fact that it costs no API call does not make that decision for you.

Your history becomes **several interests, not one average.** A single centroid over everything you read lands at a point that represents none of your interests — the midpoint of Rust, cooking and local news is not a topic. So the profile is several clusters, and an article scores against whichever one it is nearest. How many grows with your history, from two up to `INTEREST_CLUSTERS_MAX`: splitting thirty articles ten ways would be describing noise.

Stars count three times a read, and everything decays: something you starred last year no longer decides what you are shown today. Skipping is the counterweight — a skipped article is charged to the interest it sits closest to, and that interest's scores fall in proportion. It fades rather than disappearing, and an interest you have never skipped near is unaffected. Skipping something that matches none of your interests costs nothing, rather than being blamed on whichever one happened to be least far away.

Recency multiplies the result, so a week-old article keeps about a fifth of its score and yesterday's does not stay pinned all week. An article whose date had to be guessed — many feeds publish none — is discounted rather than treated as breaking news.

**A fifth of every page is reserved for subscriptions you read least,** marked with a `·`, so ranking on your own history does not quietly narrow it to the things you already agree with.

Ranking is never silent about itself. Until it is switched on, has a model, has enough history and has built a profile, `tsuzuri read --by score` returns the same list as always and says which of those is missing:

```text
not ranked: not enough reading history yet
12 of 30 signals so far
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTEREST_SCORING_ENABLED` | `false` | Build the profile and score at all |
| `INTEREST_MIN_SIGNALS` | `30` | Stars, reads and skips needed before ranking starts |
| `INTEREST_SIGNAL_HALFLIFE_DAYS` | `30` | How fast your past reading stops counting |
| `INTEREST_RECENCY_HALFLIFE_HOURS` | `72` | How fast an article's age discounts its score |
| `INTEREST_ESTIMATED_DATE_FACTOR` | `0.7` | Discount for an article whose date was guessed |
| `INTEREST_CLUSTERS_MAX` | `10` | Most interests to split your history into |
| `INTEREST_SKIP_MAX_DISTANCE` | `0.6` | How near a skip must be to an interest to count against it |
| `INTEREST_EXPLORATION_RATIO` | `0.2` | Share of a page reserved for subscriptions you read least |
| `INTEREST_WINDOW_DAYS` | `30` | How far back a ranked page looks |
| `INTEREST_MAX_PROFILE_ITEMS` | `5000` | Cap on the history read to build the profile |
| `INTEREST_REBUILD_INTERVAL_MINUTES` | `60` | How often the profile is rebuilt |
| `TIMELINE_DEFAULT_SORT` | `recent` | `recent` or `score`, when `--by` is not given |

The profile rebuilds on its own; `tsuzuri doctor` shows whether ranking is active and how many interests it found. Switching embedding models discards it along with the vectors, since a profile only means something in the space it was built in.

### Collapsing duplicates

The same story reaches you through several subscriptions. Items are already one per canonical URL, so the identical article arriving twice is one item; what is left is the same news rewritten by eight outlets. `tsuzuri read` shows it as one row:

```text
b8f2a1c3  2h    Council approves transit plan  +7
```

`+7` is how many other reports the row stands for. `tsuzuri read --no-collapse` shows all of them.

```bash
CLUSTERING_ENABLED=true bun run apps/daemon/src/index.ts
```

Off by default, but it needs no model. Two signals decide whether two articles are one story, and either is enough:

- **SimHash** over the article text catches wire copy republished near-verbatim, and works with no embedding model configured at all.
- **Embedding distance** catches the same story told in different words, once an embedding model is configured.

They fail in different places. SimHash measures how much of the text changed, so it is reliable on an article body and not on a title with a line of summary: a two-word edit moves a 200-character text past the threshold and leaves a full article untouched. A feed that publishes only titles is left to the embedding signal.

The row is the outlet that published first. A guessed date never wins that, and between reports published at the same moment the one with the most text does. Marking it read reads every report of the story, so the duplicates do not come back under `--no-collapse` or count as unread; `tsuzuri mark --no-collapse` reads only the one you named. The MCP server's `mark_read` carries the read the same way, since an id found through search is still one report of the story. The interest profile counts a story once however many of its reports are read. A star stays on the article you starred, since starring eight copies of one story would count one opinion eight times.

A report joins a story only if it was published within `CLUSTER_WINDOW_HOURS` of a report already in it, which is also what keeps the comparison cheap; a story that keeps drawing follow-ups can therefore span longer than the window. Two reports from the same subscription never join one story, since a feed does not report the same news twice and what looks alike inside one feed is a series. `--source` never collapses, for the same reason. Search never collapses either: when you searched for something, every version of it is a result.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLUSTERING_ENABLED` | `false` | Run the clustering worker |
| `CLUSTER_WINDOW_HOURS` | `72` | How far apart two reports of one story may be published |
| `CLUSTER_MAX_DISTANCE` | `0.15` | Cosine distance below which two articles are one story |
| `CLUSTER_SIMHASH_MAX_BITS` | `6` | Bits out of 64 within which two articles are one story |

`tsuzuri doctor` shows how many clusters exist and how many articles are still waiting. With an embedding model configured, an article waits for its vector before it is clustered, so the backlog drains behind the embedding backfill.

### Enrichment

A chat model summarises what you read, translates it, and suggests tags for it. Off by default, and with no default model for the same reason embeddings have none: a model cannot be chosen on your behalf.

```bash
CHAT_PROVIDER=openai-compatible \
CHAT_BASE_URL=http://localhost:11434/v1 \
CHAT_MODEL=qwen3 \
  bun run apps/daemon/src/index.ts
```

Three providers ship, one per wire format, and nothing else is added to reach them:

| Provider | Use it for |
| --- | --- |
| `openai-compatible` | Anything speaking the OpenAI chat format: Ollama, LM Studio, vLLM, OpenRouter, OpenAI itself |
| `anthropic` | The Anthropic Messages API |
| `gemini` | The Google Generative Language API |

`CHAT_API_KEY` is optional — local runtimes usually need none. `CHAT_PROVIDER` set without `CHAT_BASE_URL` or `CHAT_MODEL` is a startup error naming the variable, exactly as for embeddings: a typo in a feature that is quietly off is the failure mode that costs the most time.

A pass runs over the top of the ranked list — a widely syndicated story is summarised once, through its representative, rather than eight times — plus every starred article whatever its rank. Every answer records the model and the prompt version that wrote it, so **changing the chat model costs nothing but the calls**, unlike an embedding model:

```bash
# Change CHAT_MODEL in the environment first, restart, then replay the period
# you want the new model to answer for. Both answers survive, side by side.
tsuzuri enrich --since 7d --kind summary --force
```

`tsuzuri enrich` is bounded by `ENRICH_MAX_ITEMS_PER_HOUR`, and says so when the bound is what stopped it — a run that quietly did half of what you asked looks exactly like a run with nothing to do.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAT_PROVIDER` | `none` | `none`, `openai-compatible`, `anthropic` or `gemini` |
| `CHAT_BASE_URL` | — | Required once a provider is set |
| `CHAT_API_KEY` | — | Optional; local runtimes usually need none |
| `CHAT_MODEL` | — | Required once a provider is set |
| `CHAT_MAX_OUTPUT_TOKENS` | `1024` | Bound on one answer. A long body needs more |
| `CHAT_REQUEST_TIMEOUT_MS` | `120000` | Per-request deadline |
| `ENRICH_SUMMARY` | `true` | Summarise |
| `ENRICH_TAGS` | `true` | Suggest tags |
| `ENRICH_TRANSLATE_TO` | — | Target language. Unset means no translation |
| `ENRICH_TOP_N` | `20` | Ranked articles considered per pass |
| `ENRICH_WINDOW_HOURS` | `48` | How far back a pass looks |
| `ENRICH_MAX_ITEMS_PER_HOUR` | `60` | Spend bound |
| `ENRICH_CONCURRENCY` | `2` | Concurrent requests |
| `TAG_CANDIDATE_PROMOTION_THRESHOLD` | `5` | Times a tag must be suggested before `tsuzuri tags review` lists it |

Listings and search return the model's summary where one exists and the feed's where it does not, and carry `summarySource` beside it — `model` or `feed`. Without that field there is no way to tell from a response whether enrichment is doing anything, which is the same problem `mode` and `reason` solve on a search.

**Tags are suggestions until you approve them.** No vocabulary ships with tsuzuri: seeding one would put somebody's interests into every installation. So tagging starts in suggest-only mode — candidates accumulate, and nothing is attached to anything until you decide:

```bash
tsuzuri tags review           # candidates the model has proposed often enough to matter
tsuzuri tags approve rust     # now a real tag, and offered to the model from now on
tsuzuri tags reject crypto-cats
```

An empty list in the first days is the documented behaviour, not a broken feature.

Translation covers the title and the summary, not the body: a body is a large call on text you may never open, and the point of a translated summary is deciding whether to read the body at all. When you have decided, ask for it — one article, once, and stored so a second ask is free:

```bash
tsuzuri translate 4f2a91c7
```

Enrichments accumulate, because the comparison between two prompt versions is the reason the rows are kept. Deleting them is a deliberate act, never a timer:

```bash
tsuzuri enrich prune --keep-current   # drops every other model and prompt version
```

`tsuzuri doctor` reports whether a model is configured, which one, the prompt versions this build would write under, and how much has been summarised, tagged, translated or failed.

## MCP server

Agents are a first-class way in, not a wrapper over the CLI. Their useful granularity is not a human's, so the tools are designed rather than transliterated.

```bash
bun run apps/mcp/src/index.ts       # speaks MCP over stdio, talks to the daemon over HTTP
```

Point a host at it. For Claude Code:

```json
{
  "mcpServers": {
    "tsuzuri": {
      "command": "bun",
      "args": ["run", "/path/to/tsuzuri/apps/mcp/src/index.ts"],
      "env": { "TSUZURI_ENDPOINT": "http://127.0.0.1:8787" }
    }
  }
}
```

| Tool | Purpose |
| --- | --- |
| `search_articles` | Hybrid search, filtered by period, subscription or unread |
| `get_article` | One article's body, as markdown, plain text or summary |
| `list_sources` | Subscriptions and their health |
| `mark_read` / `star` | State updates, several ids at a time |
| `add_source` | Subscribe to a feed |

Recent unread is also exposed as the resource `tsuzuri://unread/recent`, so a host can put current articles in context without spending a tool call.

**List responses never carry article text.** Search results carry id, title, summary, score, URL, publication time and a short match snippet; the `tsuzuri://unread/recent` resource carries id, title, URL, publication time and summary. Neither carries a body — that costs a deliberate `get_article`. A broad query would otherwise spend the context window before the agent had decided what was worth reading. Everything in a list response is there because an agent needs it to choose what to read next.

**Article text is untrusted.** Titles, summaries, snippets and bodies come from the open web, and this project treats feeds as hostile input everywhere else too. The server says so in its instructions and in the description of every tool that returns article text, so a host's model is told to report what an article says rather than act on it. That is a declared trust boundary, not a guarantee: an agent with write tools is exposed to indirect prompt injection through any content it reads, so require confirmation for `mark_read`, `star` and `add_source` if your host supports it. The tools carry the MCP annotations (`readOnlyHint`, `destructiveHint`) that let a host make that distinction.

It works with no AI configured. Search degrades to full text and says so in its `mode`, and summaries are whatever the feed supplied. The natural arrangement then is that the host agent does the summarising, which is a reason to expose MCP rather than a gap in it.

## How it is put together

```text
CLI ─┐
Web ─┼─ HTTP/JSON ─→ daemon ─┬─ ingest  ─→ source layer (feed / rule / plugin / external)
MCP ─┘                       └─ enrich  ─→ LLM + embedding providers (optional)
                                   │
                             PostgreSQL + pgvector + PGroonga
```

Two decisions shape everything else:

**The daemon is the only writer.** Every interface talks to the same JSON API, so no one of them can grow behaviour the others lack.

**Ingest and enrichment are separate.** Fetching is responsible only for storing articles reliably. Summaries and scores are recomputed asynchronously, which is why an LLM outage cannot cost you articles, why prompt changes can be replayed over history, and why the reader works with no AI configured at all.

Some details that exist because feeds are a hostile input:

- Item identity is the SHA-256 of a canonicalised URL, not the feed's `<guid>`. Plenty of feeds mutate their own guid on every fetch, which would make every poll look like a batch of new articles.
- Conditional GET is backed by a body hash, because many servers ignore `If-None-Match` and CDNs rewrite ETags.
- Encoding is taken from the document's own declaration before the `Content-Type` header, because servers routinely send `text/xml` with no charset while the document declares Shift_JIS.
- Dates parse from RFC 822, RFC 3339, Japanese notation and relative phrases, then reject anything more than 24 hours in the future or before 2000 — publisher clock drift otherwise pins an item to the top of the timeline forever.

## Crawling policy

tsuzuri fetches on behalf of one person, but it is software other people run, so the defaults are conservative:

- A descriptive `User-Agent` with a link back to the project.
- Per-host rate limiting on by default.
- No bot-detection evasion: no TLS fingerprint spoofing, no stealth plugins, no CAPTCHA solving. If a site does not want to be read this way, that is an answer.
- No republishing. tsuzuri is a personal reader and will not gain a feature that serves fetched full text to the public.
- By default, requests go to public addresses only. A subscription URL tells the daemon where to send a request, and the MCP server puts that within reach of an agent reading untrusted articles — an article should not be able to talk one into fetching `http://169.254.169.254/`. Loopback, private, link-local and metadata addresses are all refused by default, and every redirect hop is checked, not just the URL you typed. Set `FETCH_ALLOW_PRIVATE_TARGETS=true` if you subscribe to something on your own network — that permits loopback and private ranges, and still refuses link-local, so `169.254.169.254` stays out of reach either way.

This narrows the exposure rather than eliminating it. The address is checked by resolving the host, but the request itself resolves again independently, so a name that answers differently between the two can still be reached. Closing that needs the connection pinned to the address that was checked, which the runtime's `fetch` does not offer.

`robots.txt` handling arrives with the scraping layer in P5, where it becomes relevant.

## Roadmap

| Phase | Scope | State |
| --- | --- | --- |
| P1 | Ingest (RSS/Atom/JSON Feed), storage, CLI, OPML import | done |
| P2 | Embeddings, hybrid search (pgvector + PGroonga), MCP server | done |
| P3 | Interest scoring, summarisation, translation, tagging, article duplicate clustering, digests | in progress |
| P4 | Web UI (React + TanStack + shadcn/ui), packaging | |
| P5 | Source plugins: declarative YAML rules (CSS/XPath), TypeScript plugins, external generators | |
| P6 | Headless rendering, LLM-based extraction and rule repair | |

Not planned: a mobile app (the web UI can become a PWA), multi-user accounts, hosting for other people, bot-detection evasion.

## Development

```bash
bun test                    # unit tests; database tests skip without a DB
bun run typecheck
bun run lint

# with the database tests
docker compose up -d postgres
TSUZURI_TEST_DATABASE_URL=postgres://tsuzuri:tsuzuri@localhost:5432/tsuzuri bun test
```

Migrations are hand-written SQL in `packages/db/migrations`, and `packages/db/src/schema.ts` is a Drizzle mirror of them. `schema.test.ts` runs the SQL and then queries every table through the mirror, so the two cannot drift apart silently.

`packages/api` holds the daemon's JSON API as Zod schemas. The CLI and the MCP server take their response types from there rather than declaring their own, and `apps/daemon/src/api.contract.test.ts` parses the daemon's real responses through the same schemas — so a handler that stops matching fails a test instead of a client at runtime. Shared types without that test would just be a third declaration free to drift.

`docs/glossary.md` fixes the vocabulary this project is written in. Its first section is the useful one: the words that could reasonably mean two things here — cluster, model, score, provider, source — and which meaning gets the qualifier. Worth reading before naming anything.

## License

MIT
