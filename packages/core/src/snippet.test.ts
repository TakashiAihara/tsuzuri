import { describe, expect, test } from "bun:test";

import { snippetToText } from "./snippet.ts";

describe("snippetToText", () => {
  test("strips the highlight markup pgroonga adds", () => {
    expect(snippetToText('Rust <span class="keyword">1.90</span> released')).toBe(
      "Rust 1.90 released",
    );
  });

  test("decodes the escaping pgroonga applied first", () => {
    // Stripping tags alone left these on screen: a title with an ampersand
    // reached the terminal as "&amp;".
    expect(snippetToText("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(snippetToText("&lt;script&gt;")).toBe("<script>");
    expect(snippetToText("&quot;quoted&quot;")).toBe('"quoted"');
    expect(snippetToText("it&#39;s")).toBe("it's");
  });

  test("decodes numeric references, including non-ASCII", () => {
    expect(snippetToText("&#26085;&#26412;")).toBe("日本");
  });

  test("does not decode twice, so escaped text cannot become markup", () => {
    // Each of these is an article that literally contains the inner entity.
    // Decoding named and numeric forms in separate passes turns the second one
    // into "<", changing what the source said.
    expect(snippetToText("&amp;lt;")).toBe("&lt;");
    expect(snippetToText("&amp;#60;")).toBe("&#60;");
    expect(snippetToText("&amp;amp;")).toBe("&amp;");
  });

  test("leaves an unknown entity alone rather than mangling it", () => {
    expect(snippetToText("100 &euro;")).toBe("100 &euro;");
    expect(snippetToText("&#99999999;")).toBe("&#99999999;");
  });

  test("collapses whitespace and trims", () => {
    expect(snippetToText("  a\n\n  b  ")).toBe("a b");
  });

  test("survives an absent snippet, which vector-only hits have", () => {
    expect(snippetToText(null)).toBe("");
    expect(snippetToText(undefined)).toBe("");
    expect(snippetToText("")).toBe("");
  });

  test("keeps Japanese text intact", () => {
    expect(snippetToText('<span class="keyword">機械学習</span>の論文まとめ')).toBe(
      "機械学習の論文まとめ",
    );
  });
});
