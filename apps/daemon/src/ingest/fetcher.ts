/**
 * The HTTP client every source is given.
 *
 * Sources never call global fetch directly, so that identification, timeouts
 * and per-host politeness cannot be forgotten in one implementation and
 * present in another. This matters more for a tool other people run than for a
 * personal script: a misbehaving reader looks like an attack to the site owner.
 */

export type FetcherOptions = {
  userAgent: string;
  timeoutMs: number;
  /** Minimum gap between two requests to the same host. */
  hostMinIntervalMs: number;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function createFetcher(options: FetcherOptions): Fetcher {
  /** Per-host promise chain, each link delayed to keep requests spaced out. */
  const hostQueues = new Map<string, Promise<void>>();

  async function waitForTurn(host: string): Promise<void> {
    if (options.hostMinIntervalMs <= 0) return;

    const previous = hostQueues.get(host) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    hostQueues.set(
      host,
      previous.then(() => current),
    );

    await previous;
    setTimeout(release, options.hostMinIntervalMs);
  }

  return async function fetcher(url, init) {
    const host = new URL(url).host;
    await waitForTurn(host);

    const headers = new Headers(init?.headers);
    headers.set("user-agent", options.userAgent);
    // Feeds are usually gzip-friendly XML and often large.
    if (!headers.has("accept")) {
      headers.set(
        "accept",
        "application/atom+xml, application/rss+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
      );
    }

    // Combine our timeout with any caller signal so a shutdown still aborts.
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    return fetch(url, { ...init, headers, signal, redirect: "follow" });
  };
}
