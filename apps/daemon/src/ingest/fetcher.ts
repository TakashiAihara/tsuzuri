import { checkFetchTarget } from "./fetch-target.ts";

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
  /** Permit loopback and private targets. See checkFetchTarget. */
  allowPrivateTargets?: boolean;
  /** Injected by tests, which have to fetch loopback to test anything. */
  checkTarget?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Hops followed before giving up. */
  maxRedirects?: number;
};

/** Enough for the usual http-to-https and www hops, short of a loop. */
const DEFAULT_MAX_REDIRECTS = 5;

export class BlockedTargetError extends Error {
  constructor(url: string, reason: string) {
    super(`refusing to fetch ${url}: ${reason}`);
    this.name = "BlockedTargetError";
  }
}

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

  const checkTarget =
    options.checkTarget ??
    ((target: string) =>
      checkFetchTarget(target, { allowPrivate: options.allowPrivateTargets ?? false }));

  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return async function fetcher(url, init) {
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
    // One budget for the whole redirect chain, not per hop.
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    /**
     * Redirects are followed here rather than by fetch, because every hop is a
     * new decision about where this daemon will send a request. `redirect:
     * "follow"` would let a public URL land on a private one with nothing
     * looking at the destination, which makes the subscribe-time check
     * decorative.
     */
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const allowed = await checkTarget(target);
      if (!allowed.ok) throw new BlockedTargetError(target, allowed.reason ?? "not permitted");

      await waitForTurn(new URL(target).host);
      const response = await fetch(target, { ...init, headers, signal, redirect: "manual" });

      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return response;

      // Whatever happens next, this response's body is not going to be read.
      // Releasing it only on the happy path leaks a stream on every redirect
      // that is refused or over the limit.
      try {
        if (hop >= maxRedirects) {
          throw new Error(`too many redirects fetching ${url} (stopped at ${target})`);
        }
        target = new URL(location, target).toString();
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    }
  };
}
