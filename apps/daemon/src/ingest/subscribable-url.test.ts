import { describe, expect, test } from "bun:test";

import { checkSubscribableUrl } from "./subscribable-url.ts";

/**
 * Subscribing is an instruction to fetch, and the MCP server puts that
 * instruction within reach of an agent whose inputs include untrusted article
 * text. These cases are the shapes an injected `add_source` would take.
 */

const resolvesTo =
  (address: string, family = 4) =>
  async () => [{ address, family }];

describe("checkSubscribableUrl", () => {
  test("accepts an ordinary feed URL", async () => {
    const result = await checkSubscribableUrl("https://example.com/feed.xml", {
      resolve: resolvesTo("93.184.216.34"),
    });
    expect(result.ok).toBe(true);
  });

  test("rejects anything that is not http or https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/f", "gopher://example.com"]) {
      const result = await checkSubscribableUrl(url);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects a literal loopback or private address", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "0.0.0.0"]) {
      const result = await checkSubscribableUrl(`http://${host}/feed`);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects the cloud metadata address", async () => {
    // The reason this check exists at all.
    const result = await checkSubscribableUrl("http://169.254.169.254/latest/meta-data/");
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects IPv6 loopback, link-local and unique-local", async () => {
    for (const host of ["[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:127.0.0.1]"]) {
      const result = await checkSubscribableUrl(`http://${host}/feed`);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects a public name that resolves somewhere private", async () => {
    // localtest.me is a real public name pointing at 127.0.0.1, which is why
    // the literal host cannot be trusted on its own.
    const result = await checkSubscribableUrl("http://localtest.me/feed", {
      resolve: resolvesTo("127.0.0.1"),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("127.0.0.1");
  });

  test("rejects when any answer is private, not only the first", async () => {
    // A public answer next to a private one is the shape of a deliberate
    // bypass, not a coincidence.
    const result = await checkSubscribableUrl("http://mixed.example/feed", {
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects a name that does not resolve", async () => {
    const result = await checkSubscribableUrl("https://nonexistent.invalid/feed", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects a name that resolves to nothing", async () => {
    const result = await checkSubscribableUrl("https://empty.example/feed", {
      resolve: async () => [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects input that is not a URL at all", async () => {
    expect(await checkSubscribableUrl("not a url")).toMatchObject({ ok: false });
  });

  test("accepts a public IPv6 address", async () => {
    const result = await checkSubscribableUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/feed");
    expect(result.ok).toBe(true);
  });
});
