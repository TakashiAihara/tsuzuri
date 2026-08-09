import { describe, expect, test } from "bun:test";

import { parseOpml } from "./opml.ts";

describe("parseOpml", () => {
  test("reads a flat export", () => {
    const xml = `<?xml version="1.0"?>
      <opml version="1.0"><body>
        <outline text="Example" type="rss" xmlUrl="https://example.com/feed.xml"
                 htmlUrl="https://example.com/"/>
      </body></opml>`;
    expect(parseOpml(xml)).toEqual([
      {
        title: "Example",
        xmlUrl: "https://example.com/feed.xml",
        htmlUrl: "https://example.com/",
      },
    ]);
  });

  test("descends into folders", () => {
    const xml = `<?xml version="1.0"?>
      <opml><body>
        <outline text="Tech">
          <outline text="A" xmlUrl="https://a.example/feed"/>
          <outline text="Nested">
            <outline text="B" xmlUrl="https://b.example/feed"/>
          </outline>
        </outline>
      </body></opml>`;
    expect(parseOpml(xml).map((o) => o.xmlUrl)).toEqual([
      "https://a.example/feed",
      "https://b.example/feed",
    ]);
  });

  test("handles a single outline as well as many", () => {
    // fast-xml-parser collapses a one-element list to an object unless told
    // otherwise, which used to make single-feed exports parse to nothing.
    const one = `<opml><body><outline xmlUrl="https://a.example/feed"/></body></opml>`;
    expect(parseOpml(one)).toHaveLength(1);
  });

  test("ignores folder outlines that carry no feed URL", () => {
    const xml = `<opml><body><outline text="Empty folder"/></body></opml>`;
    expect(parseOpml(xml)).toEqual([]);
  });

  test("drops duplicate feed URLs", () => {
    const xml = `<opml><body>
        <outline text="A" xmlUrl="https://a.example/feed"/>
        <outline text="A again" xmlUrl="https://a.example/feed"/>
      </body></opml>`;
    expect(parseOpml(xml)).toHaveLength(1);
  });

  test("prefers title over text but falls back", () => {
    const xml = `<opml><body>
        <outline text="text value" title="title value" xmlUrl="https://a.example/feed"/>
        <outline text="text only" xmlUrl="https://b.example/feed"/>
      </body></opml>`;
    expect(parseOpml(xml).map((o) => o.title)).toEqual(["title value", "text only"]);
  });

  test("returns empty for input that is not OPML", () => {
    expect(parseOpml("<html><body>nope</body></html>")).toEqual([]);
    expect(parseOpml("")).toEqual([]);
  });
});
