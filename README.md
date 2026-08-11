# tsuzuri

A self-hosted feed reader built for a CLI and for AI agents, with first-class support for sites that do not publish a feed at all.

> Status: early. Phase 1 (ingest + CLI) works end to end. Search, MCP, AI processing, the web UI and the plugin layer are not built yet — see [Roadmap](#roadmap).

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
| P2 | Embeddings, hybrid search (pgvector + PGroonga), MCP server | next |
| P3 | Interest scoring, summarisation, translation, tagging, clustering, digests | |
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

`docs/glossary.md` fixes the vocabulary this project is written in. Its first section is the useful one: the words that could reasonably mean two things here — cluster, model, score, provider, source — and which meaning gets the qualifier. Worth reading before naming anything.

## License

MIT
