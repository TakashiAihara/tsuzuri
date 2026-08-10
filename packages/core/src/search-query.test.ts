import { describe, expect, test } from "bun:test";

import { RRF_K, reciprocalRankFusion, searchTerms } from "./search-query.ts";

describe("searchTerms", () => {
  test("splits on whitespace", () => {
    expect(searchTerms("Rust release notes")).toEqual(["Rust", "release", "notes"]);
  });

  test("collapses runs of whitespace and trims", () => {
    expect(searchTerms("  Rust \n\t release  ")).toEqual(["Rust", "release"]);
  });

  test("keeps an unspaced Japanese phrase as one term", () => {
    // PGroonga segments this internally into a phrase match, which is what a
    // Japanese substring query wants. Splitting it here would mean shipping a
    // tokeniser to second-guess the database.
    expect(searchTerms("機械学習の論文")).toEqual(["機械学習の論文"]);
  });

  test("mixes scripts without special-casing either", () => {
    expect(searchTerms("Rust 機械学習")).toEqual(["Rust", "機械学習"]);
  });

  test("an empty query yields no terms", () => {
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
  });

  test("caps a pasted paragraph", () => {
    // Otherwise this becomes a hundred-clause OR matching most of the corpus:
    // slow and useless at the same time.
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(searchTerms(long)).toHaveLength(32);
  });

  test("passes operator-looking text through untouched, for SQL to escape", () => {
    expect(searchTerms("(OR) -Rust")).toEqual(["(OR)", "-Rust"]);
  });
});

describe("reciprocalRankFusion", () => {
  test("sums the reciprocal of each rank", () => {
    expect(reciprocalRankFusion([1, 1])).toBeCloseTo(2 / (RRF_K + 1));
  });

  test("a missing rank contributes nothing", () => {
    expect(reciprocalRankFusion([1, null])).toBeCloseTo(1 / (RRF_K + 1));
    expect(reciprocalRankFusion([null, null])).toBe(0);
  });

  test("appearing in both arms beats appearing first in one", () => {
    // The point of fusing: agreement between two independent retrievers is
    // worth more than a single retriever's confidence.
    expect(reciprocalRankFusion([2, 2])).toBeGreaterThan(reciprocalRankFusion([1, null]));
  });

  test("a better rank scores higher", () => {
    expect(reciprocalRankFusion([1, null])).toBeGreaterThan(reciprocalRankFusion([2, null]));
  });

  test("the constant flattens the gap between the top ranks", () => {
    // k = 60 exists so rank 1 does not dominate rank 2 outright.
    const gap = reciprocalRankFusion([1, null]) - reciprocalRankFusion([2, null]);
    expect(gap).toBeLessThan(reciprocalRankFusion([1, null]) / 10);
  });
});
