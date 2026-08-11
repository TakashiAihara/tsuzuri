import type { Item, ItemStatePatch, ItemSummary, SearchResponse, Source } from "@tsuzuri/api";

/**
 * HTTP client for the daemon.
 *
 * The MCP server holds no database connection, exactly as the CLI does not.
 * The daemon stays the only writer, which is what keeps the agent-facing
 * surface and the human-facing one from drifting into different products.
 */

export type ClientOptions = {
  endpoint: string;
  /** Applied to every request. Agents retry; a hung tool call helps nobody. */
  timeoutMs?: number;
};

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

// Re-exported so the server imports its shapes from one place; the definitions
// live in @tsuzuri/api, which the daemon is tested against.
export type { Item, SearchResponse as SearchResult, Source } from "@tsuzuri/api";

const DEFAULT_TIMEOUT_MS = 30_000;

export function createClient(options: ClientOptions) {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${endpoint}${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
        // The caller's deadline, when it has one, on top of the per-request
        // timeout -- a batch of updates has a budget of its own.
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DaemonError(
        `cannot reach the tsuzuri daemon at ${endpoint}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const text = await response.text();

    // A reverse proxy in front of the daemon answers 502 with HTML, and a bare
    // JSON.parse would throw a SyntaxError that loses both the status code and
    // the fact that this was the daemon at all.
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new DaemonError(
          `the tsuzuri daemon at ${endpoint} answered with a non-JSON body: ` +
            `${text.slice(0, 200)}`,
          response.status,
        );
      }
    }

    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : response.statusText;
      throw new DaemonError(message, response.status);
    }
    return body as T;
  }

  return {
    search(params: {
      query: string;
      limit?: number;
      since?: string;
      sourceId?: string;
      unreadOnly?: boolean;
    }): Promise<SearchResponse> {
      const search = new URLSearchParams({ q: params.query });
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      if (params.since) search.set("since", params.since);
      if (params.sourceId) search.set("sourceId", params.sourceId);
      if (params.unreadOnly) search.set("unreadOnly", "true");
      return call<SearchResponse>(`/search?${search}`);
    },

    getItem(id: string): Promise<{ item: Item }> {
      return call<{ item: Item }>(`/items/${encodeURIComponent(id)}`);
    },

    listItems(params: { limit?: number; unread?: boolean; sourceId?: string }) {
      const search = new URLSearchParams({
        unread: String(params.unread ?? true),
        limit: String(params.limit ?? 20),
      });
      if (params.sourceId) search.set("sourceId", params.sourceId);
      return call<{ items: ItemSummary[] }>(`/items?${search}`);
    },

    listSources(): Promise<{ sources: Source[] }> {
      return call<{ sources: Source[] }>("/sources");
    },

    addSource(body: { url: string; title?: string }) {
      return call<{ source: Source }>("/sources", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    setItemState(id: string, patch: { read?: boolean; starred?: boolean }, signal?: AbortSignal) {
      return call<{ state: unknown }>(`/items/${encodeURIComponent(id)}/state`, {
        method: "POST",
        body: JSON.stringify(patch),
        ...(signal ? { signal } : {}),
      });
    },
  };
}

export type DaemonClient = ReturnType<typeof createClient>;
