import { afterAll, describe, expect, test } from "bun:test";

import { BlockedTargetError, createFetcher } from "./fetcher.ts";

/**
 * The fetcher, against a real server.
 *
 * The target check is injected rather than real, because the stub necessarily
 * lives on loopback and the real check exists to refuse loopback. What is real
 * here is the redirect handling: that every hop is offered to the check, and
 * that a chain terminates.
 */

type Route = (request: Request) => Response | Promise<Response>;
const routes: Record<string, Route> = {};

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    const route = routes[pathname];
    return route ? route(request) : new Response("not found", { status: 404 });
  },
});

const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

routes["/feed"] = () => new Response("<rss/>", { headers: { "content-type": "application/xml" } });
routes["/once"] = () => Response.redirect(`${base}/feed`, 302);
routes["/private"] = () => Response.redirect("http://169.254.169.254/latest/meta-data/", 302);
routes["/loop"] = () => Response.redirect(`${base}/loop`, 302);
routes["/agent"] = (request) => new Response(request.headers.get("user-agent") ?? "");

/** Accepts everything, so loopback works; used where the check is not the subject. */
const allowAll = async () => ({ ok: true as const });

function fetcher(overrides: Partial<Parameters<typeof createFetcher>[0]> = {}) {
  return createFetcher({
    userAgent: "tsuzuri-test/0",
    timeoutMs: 5_000,
    hostMinIntervalMs: 0,
    checkTarget: allowAll,
    ...overrides,
  });
}

describe("createFetcher", () => {
  test("fetches a permitted URL", async () => {
    const response = await fetcher()(`${base}/feed`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<rss/>");
  });

  test("identifies itself", async () => {
    const response = await fetcher()(`${base}/agent`);
    expect(await response.text()).toBe("tsuzuri-test/0");
  });

  test("refuses a target the check rejects, before making the request", async () => {
    let requested = false;
    routes["/never"] = () => {
      requested = true;
      return new Response("should not happen");
    };
    const blocked = fetcher({
      checkTarget: async () => ({ ok: false, reason: "not a public address" }),
    });
    await expect(blocked(`${base}/never`)).rejects.toThrow(BlockedTargetError);
    expect(requested).toBe(false);
  });

  test("follows a redirect and returns the destination", async () => {
    const response = await fetcher()(`${base}/once`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<rss/>");
  });

  test("offers every hop to the check, not only the first", async () => {
    // The reason redirects are followed by hand. With redirect: "follow" the
    // destination was never examined, which made the subscribe-time check
    // decorative: a public URL could land anywhere.
    const seen: string[] = [];
    const recording = fetcher({
      checkTarget: async (url) => {
        seen.push(url);
        return { ok: true };
      },
    });
    await recording(`${base}/once`);
    expect(seen).toEqual([`${base}/once`, `${base}/feed`]);
  });

  test("refuses a redirect into a private address", async () => {
    // The attack the whole change exists for: a public feed URL that redirects
    // to cloud metadata.
    const guarded = fetcher({
      checkTarget: async (url) =>
        url.includes("169.254.169.254")
          ? { ok: false, reason: "not a public address" }
          : { ok: true },
    });
    await expect(guarded(`${base}/private`)).rejects.toThrow(/169\.254\.169\.254/);
  });

  test("gives up on a redirect loop rather than following it forever", async () => {
    await expect(fetcher({ maxRedirects: 3 })(`${base}/loop`)).rejects.toThrow(
      /too many redirects/,
    );
  });

  test("names the original URL and where it stopped", async () => {
    const failed = fetcher({ maxRedirects: 1 })(`${base}/loop`);
    await expect(failed).rejects.toThrow(new RegExp(`${server.port}/loop`));
  });

  test("a caller's abort signal still cancels", async () => {
    routes["/slow"] = async () => {
      await Bun.sleep(3000);
      return new Response("late");
    };
    const controller = new AbortController();
    const pending = fetcher()(`${base}/slow`, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
