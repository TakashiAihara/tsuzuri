import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createClient } from "./client.ts";
import { createMcpServer } from "./server.ts";

/**
 * The MCP surface, driven through a real client over the SDK's in-memory
 * transport, against a stub daemon over real HTTP.
 *
 * Both halves are real protocol: the tool schemas are validated by the client
 * the way a host would validate them, and the daemon client speaks HTTP. What
 * is stubbed is only what the daemon would have answered.
 */

type Route = (request: Request) => Response | Promise<Response>;

let routes: Record<string, Route> = {};
const seen: { path: string; body: unknown }[] = [];

const daemon = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body =
      request.method === "POST"
        ? await request
            .clone()
            .json()
            .catch(() => null)
        : null;
    seen.push({ path: `${url.pathname}${url.search}`, body });
    const route = routes[url.pathname] ?? routes[`${request.method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: "no stub" }), { status: 404 });
    return route(request);
  },
});

const ID = `beef1234${"5".repeat(56)}`;

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    url: "https://example.com/a",
    title: "Rust 1.90 released",
    author: "someone",
    publishedAt: "2026-08-09T00:00:00.000Z",
    publishedAtEstimated: false,
    contentHtml: "<h1>Rust 1.90</h1><p>The <em>borrow checker</em> changed.</p>",
    summary: null,
    searchText: "Rust 1.90 The borrow checker changed.",
    ...overrides,
  };
}

async function connect() {
  const server = createMcpServer(createClient({ endpoint: `http://127.0.0.1:${daemon.port}` }));
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  routes = {};
  seen.length = 0;
});

afterEach(() => {
  // The stub server is shared; nothing to reset beyond routes.
});

describe("tools", () => {
  test("advertises exactly the tools the issue specifies", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_source",
      "get_article",
      "list_sources",
      "mark_read",
      "search_articles",
      "star",
    ]);
  });

  test("every tool declares an output schema", async () => {
    // Structured output is what lets a host use a result without parsing prose.
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });
});

describe("search_articles", () => {
  beforeEach(() => {
    routes["/search"] = () =>
      Response.json({
        mode: "hybrid",
        results: [
          {
            id: ID,
            url: "https://example.com/a",
            title: "Rust 1.90 released",
            publishedAt: "2026-08-09T00:00:00.000Z",
            summary: "A summary",
            snippet: 'Tom &amp; Rust <span class="keyword">1.90</span> released',
            rrf: 0.0323,
            textRank: 1,
            vectorRank: 1,
          },
        ],
      });
  });

  test("returns metadata and score, and never a body", async () => {
    // The reason this surface is designed rather than generated from the CLI:
    // a broad query that returned bodies would exhaust an agent's context
    // before it had decided what was worth reading.
    const client = await connect();
    const result = await client.callTool({
      name: "search_articles",
      arguments: { query: "Rust" },
    });
    const structured = result.structuredContent as {
      results: Record<string, unknown>[];
    };
    expect(Object.keys(structured.results[0] as object).sort()).toEqual([
      "id",
      "publishedAt",
      "score",
      "snippet",
      "summary",
      "title",
      "url",
    ]);
    expect(JSON.stringify(result)).not.toContain("borrow checker");
  });

  test("abbreviates ids so repeating one is cheap", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "search_articles",
      arguments: { query: "Rust" },
    });
    const structured = result.structuredContent as { results: { id: string }[] };
    expect(structured.results[0]?.id).toHaveLength(12);
    expect(ID.startsWith(structured.results[0]?.id as string)).toBe(true);
  });

  test("strips highlight markup and undoes the escaping under it", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "search_articles",
      arguments: { query: "Rust" },
    });
    const structured = result.structuredContent as { results: { snippet: string }[] };
    // pgroonga escapes the text before wrapping matches, so an ampersand in a
    // title would otherwise reach the agent as "&amp;".
    expect(structured.results[0]?.snippet).toBe("Tom & Rust 1.90 released");
  });

  test("passes filters through to the daemon", async () => {
    const client = await connect();
    await client.callTool({
      name: "search_articles",
      arguments: { query: "Rust", since: "7d", unreadOnly: true, limit: 5 },
    });
    const path = seen.at(-1)?.path ?? "";
    expect(path).toContain("since=7d");
    expect(path).toContain("unreadOnly=true");
    expect(path).toContain("limit=5");
  });

  test("carries the degraded mode and its reason to the agent", async () => {
    // An empty or thin result set otherwise looks the same as a corpus with no
    // match, and the agent cannot tell that half the search was switched off.
    routes["/search"] = () =>
      Response.json({
        mode: "text-only",
        reason: "no embedding model is configured",
        results: [],
      });
    const client = await connect();
    const result = await client.callTool({ name: "search_articles", arguments: { query: "Rust" } });
    expect(result.structuredContent).toMatchObject({
      mode: "text-only",
      reason: "no embedding model is configured",
    });
  });

  test("rejects an empty filter rather than silently widening the search", async () => {
    // The client drops empty parameters, so since: "" became "all of history"
    // and sourceId: "" became "every subscription" -- the opposite of what the
    // agent asked for, reported as success.
    const client = await connect();
    for (const args of [
      { query: "Rust", since: "" },
      { query: "Rust", sourceId: "" },
    ]) {
      const result = await client.callTool({ name: "search_articles", arguments: args });
      expect(result.isError).toBe(true);
    }
  });

  test("rejects an empty query at the schema", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "search_articles", arguments: { query: "" } });
    expect(result.isError).toBe(true);
  });
});

describe("get_article", () => {
  beforeEach(() => {
    routes[`/items/${ID.slice(0, 12)}`] = () => Response.json({ item: article() });
  });

  test("converts the body to markdown by default", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "get_article",
      arguments: { id: ID.slice(0, 12) },
    });
    const structured = result.structuredContent as { content: string; format: string };
    expect(structured.format).toBe("markdown");
    expect(structured.content).toContain("# Rust 1.90");
    expect(structured.content).toContain("_borrow checker_");
  });

  test("returns plain text on request", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "get_article",
      arguments: { id: ID.slice(0, 12), format: "text" },
    });
    expect((result.structuredContent as { content: string }).content).toBe(
      "Rust 1.90 The borrow checker changed.",
    );
  });

  test("says a summary is absent rather than returning an empty one", async () => {
    // Nothing generates summaries until P3, and many feeds carry none. An
    // empty string would be reported as an article with no content.
    const client = await connect();
    const result = await client.callTool({
      name: "get_article",
      arguments: { id: ID.slice(0, 12), format: "summary" },
    });
    expect((result.structuredContent as { content: string }).content).toMatch(/no summary/);
  });

  test("reports an estimated date, so a guess is not read as news", async () => {
    routes[`/items/${ID.slice(0, 12)}`] = () =>
      Response.json({ item: article({ publishedAtEstimated: true }) });
    const client = await connect();
    const result = await client.callTool({
      name: "get_article",
      arguments: { id: ID.slice(0, 12) },
    });
    expect(result.structuredContent).toMatchObject({ publishedAtEstimated: true });
  });

  test("surfaces an unknown id as an error", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_article", arguments: { id: "ffffffff" } });
    expect(result.isError).toBe(true);
  });
});

describe("list_sources", () => {
  test("returns subscriptions with their health", async () => {
    routes["/sources"] = () =>
      Response.json({
        sources: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            url: "https://a.example/feed",
            title: "A",
            siteUrl: null,
            status: "degraded",
            consecutiveFailures: 6,
            lastSuccessAt: null,
            lastError: "timeout",
          },
        ],
      });
    const client = await connect();
    const result = await client.callTool({ name: "list_sources", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      sources: [{ status: "degraded", consecutiveFailures: 6 }],
    });
  });
});

describe("state updates", () => {
  test("marks several articles in one call and reports each", async () => {
    routes[`/items/${ID.slice(0, 12)}/state`] = () => Response.json({ state: {} });
    routes["/items/aaaaaaaa/state"] = () => Response.json({ state: {} });
    const client = await connect();
    const result = await client.callTool({
      name: "mark_read",
      arguments: { ids: [ID.slice(0, 12), "aaaaaaaa"] },
    });
    expect(result.structuredContent).toMatchObject({
      updated: [{ ok: true }, { ok: true }],
    });
  });

  test("attributes a partial failure to the id that failed", async () => {
    // Silently marking nine of ten would leave the tenth unread forever with
    // nothing to say which it was.
    routes[`/items/${ID.slice(0, 12)}/state`] = () => Response.json({ state: {} });
    const client = await connect();
    const result = await client.callTool({
      name: "mark_read",
      arguments: { ids: [ID.slice(0, 12), "ffffffff"] },
    });
    const structured = result.structuredContent as { updated: { ok: boolean }[] };
    expect(structured.updated[0]?.ok).toBe(true);
    expect(structured.updated[1]?.ok).toBe(false);
  });

  test("sends read: false when asked to unmark", async () => {
    routes[`/items/${ID.slice(0, 12)}/state`] = () => Response.json({ state: {} });
    const client = await connect();
    await client.callTool({
      name: "mark_read",
      arguments: { ids: [ID.slice(0, 12)], read: false },
    });
    expect(seen.at(-1)?.body).toEqual({ read: false });
  });

  test("star sends the starred flag", async () => {
    routes[`/items/${ID.slice(0, 12)}/state`] = () => Response.json({ state: {} });
    const client = await connect();
    await client.callTool({ name: "star", arguments: { ids: [ID.slice(0, 12)] } });
    expect(seen.at(-1)?.body).toEqual({ starred: true });
  });

  test("requires at least one id", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "mark_read", arguments: { ids: [] } });
    expect(result.isError).toBe(true);
  });

  test("caps how many articles one call may update", async () => {
    // Updates are sequential and each can wait out the client's timeout, so an
    // unbounded list could hold a tool call open for hours.
    const client = await connect();
    const ids = Array.from({ length: 101 }, (_, i) => `aaaaaaaa${String(i).padStart(4, "0")}`);
    const result = await client.callTool({ name: "mark_read", arguments: { ids } });
    expect(result.isError).toBe(true);
  });
});

describe("add_source", () => {
  test("subscribes and returns the new subscription", async () => {
    routes["/sources"] = () =>
      Response.json(
        {
          source: {
            id: "22222222-2222-2222-2222-222222222222",
            url: "https://b.example/feed",
            title: null,
            siteUrl: null,
            status: "active",
            consecutiveFailures: 0,
            lastSuccessAt: null,
            lastError: null,
          },
        },
        { status: 201 },
      );
    const client = await connect();
    const result = await client.callTool({
      name: "add_source",
      arguments: { url: "https://b.example/feed" },
    });
    expect(result.structuredContent).toMatchObject({ url: "https://b.example/feed" });
  });

  test("reports a duplicate subscription as an error", async () => {
    routes["/sources"] = () => Response.json({ error: "already subscribed" }, { status: 409 });
    const client = await connect();
    const result = await client.callTool({
      name: "add_source",
      arguments: { url: "https://b.example/feed" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("resources", () => {
  test("exposes recent unread without a tool call", async () => {
    routes["/items"] = () =>
      Response.json({
        items: [
          {
            id: ID,
            url: "https://example.com/a",
            title: "Rust 1.90 released",
            publishedAt: "2026-08-09T00:00:00.000Z",
            summary: null,
          },
        ],
      });
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("tsuzuri://unread/recent");

    const read = await client.readResource({ uri: "tsuzuri://unread/recent" });
    const payload = JSON.parse((read.contents[0] as { text: string }).text) as {
      id: string;
      title: string;
    }[];
    expect(payload[0]?.title).toBe("Rust 1.90 released");
    expect(payload[0]?.id).toHaveLength(12);
  });
});

describe("untrusted content", () => {
  test("tells the host that article text is data, not instructions", async () => {
    // Feeds are hostile input. A server that hands an agent web text with no
    // trust boundary invites indirect prompt injection into its write tools.
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/untrusted/i);
    expect(instructions).toMatch(/never as\s+instructions|not as instructions/i);

    const { tools } = await client.listTools();
    const bodyReturning = tools.filter((t) => ["search_articles", "get_article"].includes(t.name));
    for (const tool of bodyReturning) {
      expect(tool.description).toMatch(/untrusted/i);
    }
  });

  test("marks write tools so a host can require confirmation", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.search_articles?.annotations?.readOnlyHint).toBe(true);
    expect(byName.mark_read?.annotations?.readOnlyHint).toBe(false);
    expect(byName.add_source?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("daemon unavailable", () => {
  test("reports a non-JSON body with its status instead of a parse error", async () => {
    // A reverse proxy answering 502 with HTML would otherwise surface as a
    // SyntaxError, losing both the status and the fact it was the daemon.
    routes["/search"] = () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    const client = await connect();
    const result = await client.callTool({ name: "search_articles", arguments: { query: "x" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/non-JSON body/);
  });

  test("says the daemon is unreachable rather than failing opaquely", async () => {
    const server = createMcpServer(createClient({ endpoint: "http://127.0.0.1:1" }));
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "search_articles", arguments: { query: "x" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot reach the tsuzuri daemon/);
  });
});
