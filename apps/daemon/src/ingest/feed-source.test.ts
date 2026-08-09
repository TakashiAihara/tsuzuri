import { describe, expect, test } from "bun:test";
import { contentHash, type FetchState, type SourceContext } from "@tsuzuri/core";

import { feedSource } from "./feed-source.ts";

const EMPTY_STATE: FetchState = { etag: null, lastModified: null, contentHash: null };

function context(response: Response, state: Partial<FetchState> = {}): SourceContext {
  const requests: RequestInit[] = [];
  const ctx: SourceContext = {
    url: "https://example.com/feed.xml",
    config: {},
    state: { ...EMPTY_STATE, ...state },
    fetch: async (_url, init) => {
      requests.push(init ?? {});
      return response;
    },
    signal: AbortSignal.timeout(5000),
  };
  return Object.assign(ctx, { requests });
}

function xml(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/rss+xml", ...headers },
  });
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example</title>
    <item>
      <title>Hello</title>
      <link>https://example.com/posts/hello</link>
      <guid isPermaLink="false">tag:example.com,2026:hello</guid>
      <pubDate>Sat, 09 Aug 2026 03:04:05 GMT</pubDate>
      <dc:creator>Ada</dc:creator>
      <description>Short teaser</description>
      <content:encoded><![CDATA[<p>Full body with <a href="/next">a link</a>.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title>Hello</title>
    <link href="https://example.com/posts/hello"/>
    <id>urn:uuid:1</id>
    <updated>2026-08-09T03:04:05Z</updated>
    <author><name>Ada</name></author>
    <content type="html">&lt;p&gt;Full body&lt;/p&gt;</content>
  </entry>
</feed>`;

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "Example",
  items: [
    {
      id: "1",
      url: "https://example.com/posts/hello",
      title: "Hello",
      date_published: "2026-08-09T03:04:05Z",
      author: { name: "Ada" },
      content_html: "<p>Full body</p>",
    },
  ],
});

describe("feedSource: parsing", () => {
  test("reads an RSS item including author and full content", async () => {
    const result = await feedSource.fetchItems(context(xml(RSS)));
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") return;

    const [item] = result.items;
    expect(item?.url).toBe("https://example.com/posts/hello");
    expect(item?.title).toBe("Hello");
    expect(item?.author).toBe("Ada");
    // content:encoded, not the short <description>. The parser truncates
    // descriptions at 250 chars by default, which would cut bodies in half.
    expect(item?.contentHtml).toContain("Full body");
    expect(item?.summary).toBe("Short teaser");
  });

  test("keeps the publisher's raw date instead of a pre-converted one", async () => {
    // Our own parser has to see the original so its guards can reject
    // implausible values rather than trusting an ISO string.
    const result = await feedSource.fetchItems(context(xml(RSS)));
    if (result.status !== "fetched") throw new Error("expected fetched");
    expect(result.items[0]?.publishedAtRaw).toBe("Sat, 09 Aug 2026 03:04:05 GMT");
  });

  test("records a non-permalink guid without using it for identity", async () => {
    const result = await feedSource.fetchItems(context(xml(RSS)));
    if (result.status !== "fetched") throw new Error("expected fetched");
    expect(result.items[0]?.guid).toBe("tag:example.com,2026:hello");
  });

  test("reads Atom entries", async () => {
    const result = await feedSource.fetchItems(context(xml(ATOM)));
    if (result.status !== "fetched") throw new Error("expected fetched");
    const [item] = result.items;
    expect(item?.url).toBe("https://example.com/posts/hello");
    expect(item?.author).toBe("Ada");
    expect(item?.publishedAtRaw).toBe("2026-08-09T03:04:05Z");
  });

  test("reads JSON Feed", async () => {
    const response = new Response(JSON_FEED, {
      status: 200,
      headers: { "content-type": "application/feed+json" },
    });
    const result = await feedSource.fetchItems(context(response));
    if (result.status !== "fetched") throw new Error("expected fetched");
    expect(result.items[0]?.url).toBe("https://example.com/posts/hello");
  });

  test("skips entries with no link rather than failing the whole feed", async () => {
    const broken = RSS.replace("<link>https://example.com/posts/hello</link>", "");
    const result = await feedSource.fetchItems(context(xml(broken)));
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") return;
    expect(result.items).toHaveLength(0);
  });
});

describe("feedSource: change detection", () => {
  test("sends conditional headers when it has them", async () => {
    const ctx = context(xml(RSS), {
      etag: 'W/"abc"',
      lastModified: "Sat, 09 Aug 2026 00:00:00 GMT",
    });
    const captured: Record<string, string>[] = [];
    const spy: SourceContext = {
      ...ctx,
      fetch: async (_url, init) => {
        captured.push((init?.headers ?? {}) as Record<string, string>);
        return xml(RSS);
      },
    };
    await feedSource.fetchItems(spy);
    expect(captured[0]?.["If-None-Match"]).toBe('W/"abc"');
    expect(captured[0]?.["If-Modified-Since"]).toBe("Sat, 09 Aug 2026 00:00:00 GMT");
  });

  test("treats 304 as unchanged", async () => {
    const result = await feedSource.fetchItems(context(new Response(null, { status: 304 })));
    expect(result).toEqual({ status: "unchanged", reason: "not-modified" });
  });

  test("treats an identical body as unchanged even when the server returns 200", async () => {
    // This is the case conditional GET does not cover: servers that ignore
    // If-None-Match, and CDNs that rewrite ETags so it never matches.
    const previous = contentHash(new TextEncoder().encode(RSS));
    const result = await feedSource.fetchItems(context(xml(RSS), { contentHash: previous }));
    expect(result).toEqual({ status: "unchanged", reason: "same-content-hash" });
  });

  test("returns the new validators so the next poll can use them", async () => {
    const response = xml(RSS, { etag: '"v2"', "last-modified": "Sat, 09 Aug 2026 03:04:05 GMT" });
    const result = await feedSource.fetchItems(context(response));
    if (result.status !== "fetched") throw new Error("expected fetched");
    expect(result.etag).toBe('"v2"');
    expect(result.lastModified).toBe("Sat, 09 Aug 2026 03:04:05 GMT");
  });
});

describe("feedSource: failures", () => {
  test("marks 404 as not retryable", async () => {
    const result = await feedSource.fetchItems(context(new Response("", { status: 404 })));
    expect(result).toEqual({ status: "failed", error: "HTTP 404", retryable: false });
  });

  test("marks 503 and 429 as retryable", async () => {
    for (const status of [503, 429]) {
      const result = await feedSource.fetchItems(context(new Response("", { status })));
      expect(result).toMatchObject({ status: "failed", retryable: true });
    }
  });

  test("reports a network error instead of throwing", async () => {
    const ctx: SourceContext = {
      url: "https://example.com/feed.xml",
      config: {},
      state: EMPTY_STATE,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      signal: AbortSignal.timeout(5000),
    };
    const result = await feedSource.fetchItems(ctx);
    expect(result).toEqual({ status: "failed", error: "ECONNREFUSED", retryable: true });
  });

  test("reports unparseable markup as a failure", async () => {
    const result = await feedSource.fetchItems(context(xml("this is not a feed at all")));
    expect(result.status).toBe("failed");
  });
});
