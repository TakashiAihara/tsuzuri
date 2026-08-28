import { describe, expect, test } from "bun:test";

import {
  articleInput,
  MAX_ARTICLE_CHARS,
  normalizeTag,
  parseSummary,
  parseTags,
  parseTranslation,
  tagsPrompt,
} from "./prompts.ts";

describe("articleInput", () => {
  test("truncates the body at MAX_ARTICLE_CHARS", () => {
    const text = "x".repeat(MAX_ARTICLE_CHARS + 500);
    expect(articleInput(null, text)).toHaveLength(MAX_ARTICLE_CHARS);
  });

  test("prefixes the title only when there is one", () => {
    expect(articleInput("Title", "body")).toBe("Title\n\nbody");
    expect(articleInput(null, "body")).toBe("body");
  });
});

describe("parseSummary", () => {
  test("returns null for empty, whitespace-only, and the exact sentinel NONE", () => {
    expect(parseSummary("")).toBeNull();
    expect(parseSummary("   \n  ")).toBeNull();
    expect(parseSummary("NONE")).toBeNull();
    expect(parseSummary("  NONE  ")).toBeNull();
  });

  test("returns trimmed prose otherwise", () => {
    expect(parseSummary("  Something happened and it matters.  ")).toBe(
      "Something happened and it matters.",
    );
  });

  test("treats only the exact sentinel as absence, not a similar answer", () => {
    // A lowercase or punctuated near-miss is a real (if odd) summary, not the
    // model declining to summarise; conflating the two would drop content.
    expect(parseSummary("none")).toBe("none");
    expect(parseSummary("NONE.")).toBe("NONE.");
  });
});

describe("parseTranslation", () => {
  test("parses a well-formed object", () => {
    expect(parseTranslation('{"title":"T","text":"B"}')).toEqual({ title: "T", text: "B" });
  });

  test("tolerates a fenced answer", () => {
    expect(parseTranslation('```json\n{"title":"T","text":"B"}\n```')).toEqual({
      title: "T",
      text: "B",
    });
  });

  test("returns null for malformed JSON", () => {
    expect(parseTranslation("not json")).toBeNull();
  });

  test("returns null for a JSON object missing a field", () => {
    expect(parseTranslation('{"title":"T"}')).toBeNull();
  });
});

describe("parseTags", () => {
  test("drops tags outside the vocabulary rather than promoting them to candidates", () => {
    // The model was told to put unlisted topics in candidates; treating a
    // vocabulary miss as intent would let any hallucinated string in through
    // the tags door instead.
    const result = parseTags(JSON.stringify({ tags: ["ai", "made-up-topic"], candidates: [] }), [
      "ai",
      "politics",
    ]);
    expect(result?.tags).toEqual(["ai"]);
  });

  test("caps tags at four and candidates at two", () => {
    const vocabulary = ["a", "b", "c", "d", "e"];
    const result = parseTags(
      JSON.stringify({ tags: vocabulary, candidates: ["x", "y", "z"] }),
      vocabulary,
    );
    expect(result?.tags).toHaveLength(4);
    expect(result?.candidates).toHaveLength(2);
  });

  test("deduplicates repeated tags and candidates", () => {
    const result = parseTags(
      JSON.stringify({ tags: ["ai", "ai", "ai"], candidates: ["new-topic", "new-topic"] }),
      ["ai"],
    );
    expect(result?.tags).toEqual(["ai"]);
    expect(result?.candidates).toEqual(["new-topic"]);
  });

  test("lowercases and collapses whitespace before matching the vocabulary", () => {
    const result = parseTags(JSON.stringify({ tags: ["  AI   Topic  "], candidates: [] }), [
      "ai topic",
    ]);
    expect(result?.tags).toEqual(["ai topic"]);
  });

  test("drops candidates that duplicate an existing vocabulary entry", () => {
    // A candidate equal to something already in the vocabulary is not a new
    // topic; letting it through would offer the same entry twice for approval.
    const result = parseTags(JSON.stringify({ tags: [], candidates: ["ai", "new-topic"] }), ["ai"]);
    expect(result?.candidates).toEqual(["new-topic"]);
  });

  test("drops over-long candidates", () => {
    const tooLong = "x".repeat(41);
    const atLimit = "y".repeat(40);
    const result = parseTags(JSON.stringify({ tags: [], candidates: [tooLong, atLimit] }), []);
    expect(result?.candidates).toEqual([atLimit]);
  });

  test("returns null for unparseable input", () => {
    expect(parseTags("not json", ["ai"])).toBeNull();
    expect(parseTags(JSON.stringify({ tags: "not-an-array", candidates: [] }), ["ai"])).toBeNull();
  });

  test("handles an empty vocabulary: everything proposed as a tag is dropped, candidates still work", () => {
    const result = parseTags(
      JSON.stringify({ tags: ["something"], candidates: ["new-topic"] }),
      [],
    );
    expect(result?.tags).toEqual([]);
    expect(result?.candidates).toEqual(["new-topic"]);
  });
});

describe("normalizeTag", () => {
  test("trims, lowercases, and collapses internal whitespace runs to a single space", () => {
    expect(normalizeTag("  Machine   Learning \n")).toBe("machine learning");
  });
});

describe("tagsPrompt", () => {
  test("names every vocabulary entry in the system text", () => {
    const prompt = tagsPrompt(["ai", "politics", "sports"]);
    expect(prompt.system).toContain("ai, politics, sports");
  });

  test("says something sensible when the vocabulary is empty", () => {
    const prompt = tagsPrompt([]);
    expect(prompt.system).toContain("the vocabulary is currently empty");
  });
});
