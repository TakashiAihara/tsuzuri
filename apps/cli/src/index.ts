#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
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
    const result = await call<{ source: { id: string; url: string } }>(globals(), "/sources", {
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
    type Row = {
      id: string;
      url: string;
      title: string | null;
      status: string;
      lastSuccessAt: string | null;
      consecutiveFailures: number;
    };
    const { sources } = await call<{ sources: Row[] }>(globals(), "/sources");
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
  .action(async (opts: { limit: string; source?: string; all?: boolean }) => {
    type Row = { id: string; title: string | null; url: string; publishedAt: string };
    const params = new URLSearchParams({ limit: opts.limit, unread: String(!opts.all) });
    if (opts.source) params.set("sourceId", opts.source);
    const { items } = await call<{ items: Row[] }>(globals(), `/items?${params}`);
    if (globals().json) return printJson(items);
    if (items.length === 0) return log("nothing unread");
    for (const item of items) {
      out(
        `${item.id.slice(0, 8)}  ${formatAge(item.publishedAt).padEnd(5)} ${item.title ?? item.url}`,
      );
    }
  });

program
  .command("show <id>")
  .description("print one item")
  .action(async (id: string) => {
    type Item = {
      id: string;
      title: string | null;
      url: string;
      author: string | null;
      publishedAt: string;
      contentHtml: string | null;
      summary: string | null;
      searchText: string;
    };
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

type EmbeddingStatus = {
  state: string;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  message?: string;
  indexBuilt: boolean;
  reindexing: boolean;
  lastReindexError: string | null;
  counts: { total: number; embedded: number; pending: number; failed: number };
};

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
