import { describe, expect, test } from "bun:test";

import { toSearchText } from "./run.ts";

describe("toSearchText", () => {
  test("joins the title and the body with markup, scripts and styles stripped", () => {
    expect(
      toSearchText(
        "Title",
        "<p>Hello <b>World</b></p><script>alert(1)</script><style>p{}</style>&amp; more",
        "ignored summary",
      ),
    ).toBe("Title Hello World more");
  });

  test("falls back to the summary when there is no body, and copes with no title", () => {
    expect(toSearchText(null, null, "  Short\n text ")).toBe("Short text");
  });

  test("is empty when the item has no text at all", () => {
    expect(toSearchText(null, null, null)).toBe("");
  });
});
