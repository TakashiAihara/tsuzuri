import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import TurndownService from "turndown";
import { z } from "zod";

import type { DaemonClient, Item } from "./client.ts";

/**
 * The agent-facing surface.
 *
 * Deliberately not a transliteration of the CLI. An agent's useful granularity
 * is not a human's, and the difference that matters most is what a list
 * response costs: every tool here that can return more than one article returns
 * id, title, summary and score, never body text. Full text is a separate,
 * deliberate call, so a broad query cannot spend the context window before the
 * agent has decided what is worth reading.
 *
 * Everything works with no AI configured. Search degrades to full text and says
 * so, and summaries are whatever the feed supplied. The natural arrangement
 * then is that the host agent does the summarising, which is a strength of
 * exposing MCP rather than a gap in it.
 */

/** Long enough to be unambiguous, short enough that repeating it is cheap. */
const ID_PREFIX_LENGTH = 12;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function shortId(id: string): string {
  return id.slice(0, ID_PREFIX_LENGTH);
}

/**
 * Render an article in the requested form.
 *
 * `summary` can legitimately be absent: nothing has generated one until P3, and
 * plenty of feeds carry none. Saying so beats returning an empty string, which
 * an agent would report as an article with no content.
 */
function renderItem(item: Item, format: "markdown" | "text" | "summary"): string {
  if (format === "summary") {
    return item.summary ?? "(no summary available; no summarisation model is configured)";
  }
  if (format === "text") return item.searchText || item.summary || "(no body)";
  if (!item.contentHtml) return item.searchText || item.summary || "(no body)";
  return turndown.turndown(item.contentHtml);
}

const searchOutput = {
  mode: z.enum(["hybrid", "text-only"]),
  reason: z.string().optional(),
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      url: z.string(),
      publishedAt: z.string(),
      summary: z.string().nullable(),
      snippet: z.string().nullable(),
      score: z.number(),
    }),
  ),
};

function textContent(value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
}

export function createMcpServer(client: DaemonClient): McpServer {
  const server = new McpServer(
    { name: "tsuzuri", version: "0.1.0" },
    {
      instructions:
        "Search and read a personal feed reader. List results carry only id, title, " +
        "summary and score; call get_article for an article's text. Ids may be " +
        "abbreviated. If search reports mode 'text-only', semantic matching is off " +
        "and the reason says why.",
    },
  );

  server.registerTool(
    "search_articles",
    {
      title: "Search articles",
      description:
        "Hybrid full-text and semantic search over every stored article. Returns id, " +
        "title, summary and score only. Use `since` for questions about a period, e.g. " +
        "'7d'. Returns mode 'text-only' with a reason when semantic search is unavailable.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for. Plain words, not a query language."),
        since: z
          .string()
          .optional()
          .describe("Only articles newer than this: a duration like '7d' or an ISO date."),
        sourceId: z.string().optional().describe("Restrict to one subscription."),
        unreadOnly: z.boolean().optional().describe("Exclude articles already read."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
      outputSchema: searchOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await client.search({
        query: args.query,
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.sourceId !== undefined ? { sourceId: args.sourceId } : {}),
        ...(args.unreadOnly !== undefined ? { unreadOnly: args.unreadOnly } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });

      const structuredContent = {
        mode: result.mode,
        ...(result.reason ? { reason: result.reason } : {}),
        results: result.results.map((hit) => ({
          id: shortId(hit.id),
          title: hit.title,
          url: hit.url,
          publishedAt: hit.publishedAt,
          summary: hit.summary,
          // The highlight markup is for a browser; an agent wants the words.
          snippet: hit.snippet?.replace(/<[^>]+>/g, "") ?? null,
          score: hit.rrf,
        })),
      };
      return { structuredContent, content: textContent(structuredContent) };
    },
  );

  server.registerTool(
    "get_article",
    {
      title: "Get one article",
      description:
        "Fetch a single article's text. This is the only tool that returns a body, so " +
        "call it for articles you have already chosen from a search or listing.",
      inputSchema: {
        id: z.string().min(1).describe("Article id. An abbreviated id from a list is fine."),
        format: z
          .enum(["markdown", "text", "summary"])
          .optional()
          .describe("Default markdown. 'summary' may be unavailable."),
      },
      outputSchema: {
        id: z.string(),
        title: z.string().nullable(),
        url: z.string(),
        author: z.string().nullable(),
        publishedAt: z.string(),
        publishedAtEstimated: z
          .boolean()
          .describe("True when the date is the fetch time because the feed gave none."),
        format: z.string(),
        content: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const { item } = await client.getItem(args.id);
      const format = args.format ?? "markdown";
      const structuredContent = {
        id: shortId(item.id),
        title: item.title,
        url: item.url,
        author: item.author,
        publishedAt: item.publishedAt,
        publishedAtEstimated: item.publishedAtEstimated,
        format,
        content: renderItem(item, format),
      };
      return { structuredContent, content: textContent(structuredContent) };
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List subscriptions",
      description: "Every subscription with its health, so a gap in coverage is explainable.",
      outputSchema: {
        sources: z.array(
          z.object({
            id: z.string(),
            title: z.string().nullable(),
            url: z.string(),
            status: z.string(),
            consecutiveFailures: z.number(),
            lastSuccessAt: z.string().nullable(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { sources } = await client.listSources();
      const structuredContent = {
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          url: source.url,
          status: source.status,
          consecutiveFailures: source.consecutiveFailures,
          lastSuccessAt: source.lastSuccessAt,
        })),
      };
      return { structuredContent, content: textContent(structuredContent) };
    },
  );

  /**
   * State updates take a list.
   *
   * An agent that has just read ten articles should say so once. Per-id results
   * rather than a count, because a partial failure has to be attributable --
   * silently marking nine of ten would leave the tenth unread forever with
   * nothing to indicate it.
   */
  const stateResult = {
    updated: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })),
  };

  async function applyState(
    ids: string[],
    patch: { read?: boolean; starred?: boolean },
  ): Promise<{ updated: { id: string; ok: boolean; error?: string }[] }> {
    const updated = [];
    for (const id of ids) {
      try {
        await client.setItemState(id, patch);
        updated.push({ id: shortId(id), ok: true });
      } catch (error) {
        updated.push({
          id: shortId(id),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { updated };
  }

  server.registerTool(
    "mark_read",
    {
      title: "Mark articles read",
      description: "Mark articles as read, or unread with read: false.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).describe("Article ids, possibly abbreviated."),
        read: z.boolean().optional().describe("Default true."),
      },
      outputSchema: stateResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const structuredContent = await applyState(args.ids, { read: args.read ?? true });
      return { structuredContent, content: textContent(structuredContent) };
    },
  );

  server.registerTool(
    "star",
    {
      title: "Star articles",
      description:
        "Star articles. Starring is the strongest positive signal for future relevance " +
        "scoring, so use it for articles that were genuinely worth reading.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1),
        starred: z.boolean().optional().describe("Default true."),
      },
      outputSchema: stateResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const structuredContent = await applyState(args.ids, { starred: args.starred ?? true });
      return { structuredContent, content: textContent(structuredContent) };
    },
  );

  server.registerTool(
    "add_source",
    {
      title: "Subscribe to a feed",
      description: "Add a subscription by feed URL.",
      inputSchema: {
        url: z.string().min(1).describe("The feed's URL."),
        title: z.string().optional(),
      },
      outputSchema: {
        id: z.string(),
        url: z.string(),
        title: z.string().nullable(),
        status: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { source } = await client.addSource({
        url: args.url,
        ...(args.title !== undefined ? { title: args.title } : {}),
      });
      const structuredContent = {
        id: source.id,
        url: source.url,
        title: source.title,
        status: source.status,
      };
      return { structuredContent, content: textContent(structuredContent) };
    },
  );

  /**
   * Recent unread, as a resource.
   *
   * A resource rather than another tool so a host can put current articles in
   * context without spending a tool call on it, which is the case where an
   * agent has not been asked anything specific yet.
   */
  server.registerResource(
    "recent-unread",
    "tsuzuri://unread/recent",
    {
      title: "Recent unread articles",
      description: "The most recent unread articles: id, title and summary only.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { items } = await client.listItems({ unread: true, limit: 20 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              items.map((item) => ({
                id: shortId(item.id),
                title: item.title,
                url: item.url,
                publishedAt: item.publishedAt,
                summary: item.summary,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
