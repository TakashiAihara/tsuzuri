import { describe, expect, test } from "bun:test";

import { hammingDistance64, simhash64 } from "./simhash.ts";

const ARTICLE =
  "The city council approved the new transit plan on Tuesday, allocating funds for two additional light rail lines that will connect the harbour district with the northern suburbs by 2030.";

const ARTICLE_SYNDICATED =
  "The city council approved the new transit plan on Tuesday, allocating funds for two additional light rail lines connecting the harbour district with the northern suburbs by 2030.";

const UNRELATED =
  "Researchers announced a breakthrough in battery chemistry, doubling the energy density of solid-state cells while halving the charge time in laboratory conditions.";

describe("simhash64", () => {
  test("identical text hashes identically", () => {
    expect(simhash64(ARTICLE)).toBe(simhash64(ARTICLE));
  });

  test("syndicated copy with light edits lands within a few bits", () => {
    const distance = hammingDistance64(simhash64(ARTICLE), simhash64(ARTICLE_SYNDICATED));
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(6);
  });

  test("unrelated text lands well above the clustering threshold", () => {
    // Same-language prose shares trigram distribution ("the ", "ing "), so
    // unrelated English pairs measure ~15 bits apart, not ~32. The property
    // that matters is a clear gap above the default threshold of 6.
    const distance = hammingDistance64(simhash64(ARTICLE), simhash64(UNRELATED));
    expect(distance).toBeGreaterThan(10);
  });

  test("whitespace reflow and case do not move the hash", () => {
    const reflowed = ARTICLE.toUpperCase().replace(/ /gu, "\n\t ");
    expect(simhash64(reflowed)).toBe(simhash64(ARTICLE));
  });

  test("works on Japanese text without a tokeniser", () => {
    // Article-length text, not a single sentence: on short CJK text each edit
    // touches a larger share of the shingles, and a one-word edit measured
    // 8 bits on a 55-character sentence. Real bodies are paragraph-scale.
    const ja =
      "市議会は火曜日に新しい交通計画を承認し、港湾地区と北部郊外を結ぶ2本のライトレール路線に予算を割り当てた。計画には既存のバス網の再編も含まれ、2030年の開業を目指して来年度から用地取得が始まる。市長は記者会見で、渋滞の緩和と沿線の再開発が主な狙いだと述べ、事業費の半分は国の補助金で賄われる見通しを示した。";
    const jaEdited =
      "市議会は火曜日に新交通計画を承認し、港湾地区と北部郊外を結ぶ2本のライトレール路線に予算を割り当てた。計画には既存のバス網の再編も含まれ、2030年の開業を目指して来年度から用地取得が始まる。市長は記者会見で、渋滞の緩和と沿線の再開発が主な狙いだと述べ、事業費の半分は国の補助金で賄われる見通しを示した。";
    const jaUnrelated =
      "研究チームは固体電池のエネルギー密度を2倍にし、充電時間を半分にする新しい電池化学を発表した。実験室条件では従来のリチウムイオン電池を大きく上回る性能を示しており、量産化に向けた課題は電解質の安定性だという。共同研究に参加する自動車メーカーは、5年以内の実用化を目標に掲げている。";

    expect(hammingDistance64(simhash64(ja), simhash64(jaEdited))).toBeLessThanOrEqual(6);
    expect(hammingDistance64(simhash64(ja), simhash64(jaUnrelated))).toBeGreaterThan(10);
  });

  test("text shorter than one shingle returns the no-hash sentinel", () => {
    expect(simhash64("ab")).toBe(0n);
    expect(simhash64("  a  ")).toBe(0n);
    expect(simhash64("")).toBe(0n);
  });
});

describe("hammingDistance64", () => {
  test("is 0 for equal values and 64 for complements", () => {
    const hash = simhash64(ARTICLE);
    expect(hammingDistance64(hash, hash)).toBe(0);
    expect(hammingDistance64(0n, 0xffffffffffffffffn)).toBe(64);
  });

  test("counts exactly the flipped bits", () => {
    expect(hammingDistance64(0b1011n, 0b0001n)).toBe(2);
  });
});
