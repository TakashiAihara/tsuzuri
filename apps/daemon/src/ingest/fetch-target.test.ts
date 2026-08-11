import { describe, expect, test } from "bun:test";

import { checkFetchTarget } from "./fetch-target.ts";

/**
 * Subscribing is an instruction to fetch, and the MCP server puts that
 * instruction within reach of an agent whose inputs include untrusted article
 * text. These cases are the shapes an injected `add_source` would take.
 */

const resolvesTo =
  (address: string, family = 4) =>
  async () => [{ address, family }];

describe("checkFetchTarget", () => {
  test("accepts an ordinary feed URL", async () => {
    const result = await checkFetchTarget("https://example.com/feed.xml", {
      resolve: resolvesTo("93.184.216.34"),
    });
    expect(result.ok).toBe(true);
  });

  test("rejects anything that is not http or https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/f", "gopher://example.com"]) {
      const result = await checkFetchTarget(url);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects a literal loopback or private address", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "0.0.0.0"]) {
      const result = await checkFetchTarget(`http://${host}/feed`);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects the cloud metadata address", async () => {
    // The reason this check exists at all.
    const result = await checkFetchTarget("http://169.254.169.254/latest/meta-data/");
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects IPv6 loopback, link-local, unique-local and multicast", async () => {
    for (const host of ["[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:127.0.0.1]", "[ff02::1]"]) {
      const result = await checkFetchTarget(`http://${host}/feed`);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects the whole link-local range, not just addresses starting fe80", async () => {
    // fe80::/10 runs to febf. Matching the literal string "fe80" let the rest
    // of the range through.
    for (const host of ["[fe90::1]", "[fea0::1]", "[febf::1]"]) {
      const result = await checkFetchTarget(`http://${host}/feed`);
      expect(result).toMatchObject({ ok: false });
    }
  });

  test("rejects a public name that resolves somewhere private", async () => {
    // localtest.me is a real public name pointing at 127.0.0.1, which is why
    // the literal host cannot be trusted on its own.
    const result = await checkFetchTarget("http://localtest.me/feed", {
      resolve: resolvesTo("127.0.0.1"),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("127.0.0.1");
  });

  test("rejects when any answer is private, not only the first", async () => {
    // A public answer next to a private one is the shape of a deliberate
    // bypass, not a coincidence.
    const result = await checkFetchTarget("http://mixed.example/feed", {
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects a name that does not resolve", async () => {
    const result = await checkFetchTarget("https://nonexistent.invalid/feed", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects a name that resolves to nothing", async () => {
    const result = await checkFetchTarget("https://empty.example/feed", {
      resolve: async () => [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects input that is not a URL at all", async () => {
    expect(await checkFetchTarget("not a url")).toMatchObject({ ok: false });
  });

  describe("with private targets allowed", () => {
    const allowPrivate = { allowPrivate: true };

    test("permits loopback and RFC1918, which is the point of the opt-in", async () => {
      for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "[::1]"]) {
        const result = await checkFetchTarget(`http://${host}/feed`, allowPrivate);
        expect(result.ok).toBe(true);
      }
    });

    test("still refuses carrier-grade NAT, which is the ISP's network not yours", async () => {
      const result = await checkFetchTarget("http://100.64.0.1/feed", allowPrivate);
      expect(result).toMatchObject({ ok: false });
    });

    test("still refuses link-local, where cloud metadata lives", async () => {
      // "Let me read my router's feed" must not quietly also mean "let an
      // article talk you into reading the instance credentials endpoint".
      const result = await checkFetchTarget(
        "http://169.254.169.254/latest/meta-data/",
        allowPrivate,
      );
      expect(result).toMatchObject({ ok: false });
    });

    test("still refuses a name that resolves to link-local", async () => {
      const result = await checkFetchTarget("http://metadata.example/x", {
        ...allowPrivate,
        resolve: resolvesTo("169.254.169.254"),
      });
      expect(result).toMatchObject({ ok: false });
    });

    test("still refuses a non-http scheme", async () => {
      expect(await checkFetchTarget("file:///etc/passwd", allowPrivate)).toMatchObject({
        ok: false,
      });
    });
  });

  test("accepts a public IPv6 address", async () => {
    const result = await checkFetchTarget("http://[2606:2800:220:1:248:1893:25c8:1946]/feed");
    expect(result.ok).toBe(true);
  });
});
