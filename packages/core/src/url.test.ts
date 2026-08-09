import { describe, expect, test } from "bun:test";

import { absolutizeHtml, canonicalUrl, resolveUrl } from "./url.ts";

describe("resolveUrl", () => {
  test("resolves a relative href against its base", () => {
    expect(resolveUrl("/posts/hello", "https://example.com/feed.xml")).toBe(
      "https://example.com/posts/hello",
    );
  });

  test("keeps http as http so we do not break http-only sites", () => {
    expect(resolveUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  test("drops tracking parameters but keeps meaningful ones", () => {
    expect(resolveUrl("https://example.com/a?id=7&utm_source=rss&fbclid=xyz")).toBe(
      "https://example.com/a?id=7",
    );
  });

  test("rejects non-http schemes rather than throwing", () => {
    expect(resolveUrl("javascript:void(0)")).toBeNull();
    expect(resolveUrl("mailto:someone@example.com")).toBeNull();
  });

  test("rejects empty and malformed input", () => {
    expect(resolveUrl("")).toBeNull();
    expect(resolveUrl("   ")).toBeNull();
    expect(resolveUrl("not a url")).toBeNull();
  });
});

describe("canonicalUrl", () => {
  test("collapses http and https copies of one article", () => {
    expect(canonicalUrl("http://example.com/a")).toBe(canonicalUrl("https://example.com/a"));
  });

  test("ignores host case, default port, fragment and trailing slash", () => {
    const variants = [
      "https://Example.COM/posts/hello/",
      "https://example.com:443/posts/hello",
      "https://example.com/posts/hello#section-2",
    ];
    for (const variant of variants) {
      expect(canonicalUrl(variant)).toBe("https://example.com/posts/hello");
    }
  });

  test("ignores query parameter order", () => {
    expect(canonicalUrl("https://example.com/a?b=2&a=1")).toBe(
      canonicalUrl("https://example.com/a?a=1&b=2"),
    );
  });

  test("keeps the site root's slash", () => {
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com/");
  });

  test("does not merge www with a different subdomain", () => {
    expect(canonicalUrl("https://www.example.com/a")).not.toBe(
      canonicalUrl("https://news.example.com/a"),
    );
  });

  test("strips Blogger's ?m=1 mobile variant only on blogspot hosts", () => {
    expect(canonicalUrl("https://foo.blogspot.com/2026/08/post.html?m=1")).toBe(
      "https://foo.blogspot.com/2026/08/post.html",
    );
    // "m" is an ordinary parameter name anywhere else and must survive.
    expect(canonicalUrl("https://example.com/search?m=1")).toBe("https://example.com/search?m=1");
  });
});

describe("absolutizeHtml", () => {
  test("rewrites relative img and link targets", () => {
    const html = '<p><a href="/next">next</a><img src="images/a.png"></p>';
    expect(absolutizeHtml(html, "https://example.com/posts/hello")).toBe(
      '<p><a href="https://example.com/next">next</a>' +
        '<img src="https://example.com/posts/images/a.png"></p>',
    );
  });

  test("leaves absolute URLs, anchors and data URIs untouched", () => {
    const html =
      '<a href="https://other.example/x">x</a><a href="#top">top</a><img src="data:image/gif;base64,AA">';
    expect(absolutizeHtml(html, "https://example.com/a")).toBe(html);
  });

  test("resolves protocol-relative URLs against the base scheme", () => {
    expect(absolutizeHtml('<img src="//cdn.example.com/a.jpg">', "https://example.com/a")).toBe(
      '<img src="https://cdn.example.com/a.jpg">',
    );
  });
});
