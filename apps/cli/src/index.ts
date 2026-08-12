#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import type {
  EmbeddingStatus,
  Item,
  ItemSummary,
  RankedItem,
  ScoringState,
  SearchResponse,
  Source,
} from "@tsuzuri/api";
import { snippetToText } from "@tsuzuri/core";
import { Command } from "commander";

/**
 * The CLI is a thin client of the daemon's HTTP API.
 *
 * It deliberately holds no database connection: the daemon is the only writer,
 * and keeping the CLI over HTTP means it works the same whether the daemon runs
 * on this machine or elsewhere.
 *
 * Convention throughout: data goes to stdout (machine readable with --json),
 * everything else goes to stderr, so output can be piped without filtering.
 */

type RankedItemsResponse = { items: RankedItem[]; scoring: ScoringState };

const DEFAULT_ENDPOINT = process.env.TSUZURI_ENDPOINT ?? "http://127.0.0.1:8787";

type GlobalOptions = { endpoint: string; json?: boolean };

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function out(value: string): void {
  process.stdout.write(`${value}\n`);
}

async function call<T>(
  options: GlobalOptions,
  path: string,
  init?: RequestInit & { raw?: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${options.endpoint}${path}`, {
      ...init,
      headers: {
        ...(init?.body || init?.raw ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      body: init?.raw ?? init?.body,
    });
  } catch (error) {
    log(`cannot reach the daemon at ${options.endpoint}`);
    log(`  ${error instanceof Error ? error.message : String(error)}`);
    log("  start it with: bun run apps/daemon/src/index.ts");
    process.exit(2);
  }

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    log(`request failed (${response.status}): ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  return parsed as T;
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function formatAge(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

const program = new Command();
program
  .name("tsuzuri")
  .description("AI-first feed reader: CLI client for the tsuzuri daemon")
  .option("--endpoint <url>", "daemon base URL", DEFAULT_ENDPOINT)
  .option("--json", "emit raw JSON on stdout");

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

const feed = program.command("feed").description("manage subscriptions");

feed
  .command("add <url>")
  .description("subscribe to a feed")
  .option("--title <title>", "override the title")
  .action(async (url: string, opts: { title?: string }) => {
    const body = JSON.stringify({ url, ...(opts.title ? { title: opts.title } : {}) });
    const result = await call<{ source: Source }>(globals(), "/sources", {
      method: "POST",
      raw: body,
    });
    if (globals().json) return printJson(result);
    log(`subscribed: ${result.source.url}`);
    out(result.source.id);
  });

feed
  .command("list")
  .description("list subscriptions")
  .action(async () => {
    const { sources } = await call<{ sources: Source[] }>(globals(), "/sources");
    if (globals().json) return printJson(sources);
    if (sources.length === 0) return log("no subscriptions yet");
    for (const source of sources) {
      const health =
        source.status === "active" && source.consecutiveFailures === 0
          ? "ok"
          : `${source.status}(${source.consecutiveFailures})`;
      const last = source.lastSuccessAt ? formatAge(source.lastSuccessAt) : "never";
      out(`${source.id}  ${health.padEnd(12)} ${last.padEnd(6)} ${source.title ?? source.url}`);
    }
  });

feed
  .command("rm <id>")
  .description("unsubscribe")
  .action(async (id: string) => {
    await call(globals(), `/sources/${id}`, { method: "DELETE" });
    log(`removed ${id}`);
  });

feed
  .command("import <file>")
  .description("import subscriptions from an OPML export")
  .action(async (file: string) => {
    const xml = await readFile(file, "utf8");
    const result = await call<{ imported: number; skipped: number }>(
      globals(),
      "/sources/import-opml",
      { method: "POST", raw: xml, headers: { "content-type": "text/xml" } },
    );
    if (globals().json) return printJson(result);
    log(`imported ${result.imported}, skipped ${result.skipped} already subscribed`);
  });

program
  .command("fetch")
  .description("poll subscriptions now")
  .option("--all", "ignore schedules and poll everything")
  .action(async (opts: { all?: boolean }) => {
    const result = await call<{ polled: number; inserted: number; failed: number }>(
      globals(),
      `/ingest/run${opts.all ? "?all=true" : ""}`,
      { method: "POST" },
    );
    if (globals().json) return printJson(result);
    log(`polled ${result.polled}, new items ${result.inserted}, failed ${result.failed}`);
  });

program
  .command("read")
  .description("list unread items, newest first")
  .option("--limit <n>", "how many", "20")
  .option("--source <id>", "restrict to one subscription")
  .option("--all", "include items already read")
  // No default: an omitted --by sends no `sort`, which leaves the choice to the
  // daemon's TIMELINE_DEFAULT_SORT. Defaulting to "recent" here would send it
  // explicitly and make that setting unreachable from the CLI.
  .option("--by <order>", "recent or score (default: the daemon's setting)")
  .action(async (opts: { limit: string; source?: string; all?: boolean; by?: string }) => {
    const params = new URLSearchParams({ limit: opts.limit, unread: String(!opts.all) });
    if (opts.source) params.set("sourceId", opts.source);
    if (opts.by) params.set("sort", opts.by);

    // Which shape came back is a property of the response, not of the flag,
    // precisely because the daemon may have chosen the ordering.
    const body = await call<{ items: ItemSummary[] } | RankedItemsResponse>(
      globals(),
      `/items?${params}`,
    );
    if (!("scoring" in body)) {
      if (globals().json) return printJson(body.items);
      if (body.items.length === 0) return log("nothing unread");
      for (const item of body.items) {
        out(
          `${item.id.slice(0, 8)}  ${formatAge(item.publishedAt).padEnd(5)} ${item.title ?? item.url}`,
        );
      }
      return;
    }

    const response = body;
    if (globals().json) return printJson(response);

    // Say when the list is not actually ranked. Dates and scores produce the
    // same-looking list, so silence here reads as "ranking thinks this is the
    // order", which is the one thing it does not mean.
    if (!response.scoring.active) {
      log(`not ranked: ${response.scoring.reason}`);
      if (response.scoring.signals < response.scoring.required) {
        log(`${response.scoring.signals} of ${response.scoring.required} signals so far`);
      }
    }
    if (response.items.length === 0) return log("nothing unread");

    for (const item of response.items) {
      // A leading dot marks a row the score did not choose. Without it, an
      // exploration slot is indistinguishable from a ranking bug.
      const mark = item.exploration ? "·" : " ";
      out(
        `${mark}${item.id.slice(0, 8)}  ${formatAge(item.publishedAt).padEnd(5)} ${item.title ?? item.url}`,
      );
    }
  });

program
  .command("search <query...>")
  .description("hybrid search over everything stored")
  .option("--limit <n>", "how many", "20")
  .option("--since <when>", "only items newer than this, e.g. 7d or an ISO date")
  .option("--source <id>", "restrict to one subscription")
  .option("--unread", "exclude items already read")
  .action(
    async (
      query: string[],
      opts: { limit: string; since?: string; source?: string; unread?: boolean },
    ) => {
      const params = new URLSearchParams({ q: query.join(" "), limit: opts.limit });
      if (opts.since) params.set("since", opts.since);
      if (opts.source) params.set("sourceId", opts.source);
      if (opts.unread) params.set("unreadOnly", "true");

      const response = await call<SearchResponse>(globals(), `/search?${params}`);
      if (globals().json) return printJson(response);

      // Say when half the search was switched off. An empty list otherwise
      // looks the same as a corpus that genuinely had no match.
      if (response.mode === "text-only" && response.reason) {
        log(`full-text only: ${response.reason}`);
      }
      if (response.results.length === 0) return log("no matches");

      for (const hit of response.results) {
        out(
          `${hit.id.slice(0, 8)}  ${formatAge(hit.publishedAt).padEnd(5)} ${hit.title ?? hit.url}`,
        );
        // pgroonga_snippet_html escapes the text and then wraps matches in a
        // span, so tags and entities both have to go. Shared with the MCP
        // server, which renders the same snippets.
        const snippet = snippetToText(hit.snippet);
        if (snippet) out(`          ${snippet.slice(0, 160)}`);
      }
    },
  );

program
  .command("show <id>")
  .description("print one item")
  .action(async (id: string) => {
    const { item } = await call<{ item: Item }>(globals(), `/items/${id}`);
    if (globals().json) return printJson(item);
    out(item.title ?? "(untitled)");
    out(item.url);
    if (item.author) out(`by ${item.author}`);
    out("");
    out(item.searchText || item.summary || "(no body)");
  });

program
  .command("mark <ids...>")
  .description("mark items read")
  .option("--unread", "mark unread instead")
  .action(async (ids: string[], opts: { unread?: boolean }) => {
    for (const id of ids) {
      await call(globals(), `/items/${id}/state`, {
        method: "POST",
        raw: JSON.stringify({ read: !opts.unread }),
      });
    }
    log(`${opts.unread ? "unmarked" : "marked"} ${ids.length}`);
  });

program
  .command("star <ids...>")
  .description("star items (a positive signal for future scoring)")
  .action(async (ids: string[]) => {
    for (const id of ids) {
      await call(globals(), `/items/${id}/state`, {
        method: "POST",
        raw: JSON.stringify({ starred: true }),
      });
    }
    log(`starred ${ids.length}`);
  });

program
  .command("reindex")
  .description("embed items that have no vector yet")
  .option(
    "--embedding-model <name>",
    "rebuild every vector into this model; must match the configured EMBEDDING_MODEL. Destroys all existing vectors",
  )
  .action(async (opts: { embeddingModel?: string }) => {
    // Without the flag this is a plain backfill, which the daemon is doing
    // anyway; the command exists so that "fill the gaps" and "throw everything
    // away and start again" are visibly different requests.
    if (!opts.embeddingModel) {
      const status = await call<EmbeddingStatus>(globals(), "/embeddings/status");
      if (globals().json) return printJson(status);
      if (status.state !== "ready") {
        log(`embeddings are ${status.state}${status.message ? `: ${status.message}` : ""}`);
        return;
      }
      log(
        `backfill runs continuously: ${status.counts.embedded}/${status.counts.total} embedded, ` +
          `${status.counts.pending} pending, ${status.counts.failed} failed`,
      );
      log("to rebuild every vector into a different model, pass --embedding-model <name>");
      return;
    }

    log(`rebuilding every vector into ${opts.embeddingModel}. Existing vectors are discarded.`);
    await call<EmbeddingStatus>(globals(), "/embeddings/reindex", {
      method: "POST",
      raw: JSON.stringify({ model: opts.embeddingModel }),
    });

    // Poll rather than hold a request open for the length of a full re-embed.
    for (;;) {
      const status = await call<EmbeddingStatus>(globals(), "/embeddings/status");
      if (!status.reindexing) {
        // The rebuild runs detached from the request that started it, so
        // "no longer running" is not the same as "finished". Decided before
        // the output format is chosen, or --json would report the failure in
        // its body and still exit 0, and a script would see success.
        if (status.lastReindexError) {
          if (globals().json) printJson(status);
          else log(`reindex failed: ${status.lastReindexError}`);
          process.exit(1);
        }
        if (globals().json) return printJson(status);
        log(
          `done: ${status.counts.embedded}/${status.counts.total} embedded, ` +
            `${status.counts.failed} failed, index ${status.indexBuilt ? "built" : "not built"}`,
        );
        return;
      }
      log(`  ${status.counts.embedded}/${status.counts.total} embedded…`);
      await Bun.sleep(2000);
    }
  });

program
  .command("doctor")
  .description("report what is configured and what is not")
  .action(async () => {
    const report = await call<Record<string, unknown>>(globals(), "/doctor");
    printJson(report);
  });

await program.parseAsync(process.argv);
