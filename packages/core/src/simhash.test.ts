import { describe, expect, test } from "bun:test";

import { hammingDistance, simhash } from "./simhash.ts";

/**
 * An article-length body. SimHash distance tracks the share of shingles an
 * edit touches, so the same edit moves a short text much further than a long
 * one; the assertions below are calibrated on text of the length a real
 * article body has, and one test pins the length dependence itself.
 */
const ARTICLE =
  "The city council approved the new transit plan on Tuesday, allocating funds for two additional light rail lines that will connect the harbour district with the northern suburbs by 2030. The plan also restructures the existing bus network, and land acquisition begins next fiscal year with the aim of opening in 2030. At a press conference the mayor said the main goals were easing congestion and redeveloping the areas along the route, and indicated that half of the project cost would be covered by national subsidies. Opposition members questioned the projected ridership figures, arguing that the forecasts assumed population growth the city has not seen in a decade. The council will revisit the budget in the spring session once the environmental assessment is complete.";

const UNRELATED =
  "Researchers announced a breakthrough in battery chemistry, doubling the energy density of solid-state cells while halving the charge time in laboratory conditions. The team said the main obstacle to mass production is the stability of the electrolyte, which degrades after a few hundred cycles at room temperature. A carmaker taking part in the joint research has set a target of commercial use within five years, and several suppliers have begun pilot lines. Analysts cautioned that laboratory results rarely survive the move to production volumes intact, and that cost per kilowatt-hour remains well above current lithium-ion cells.";

const JA =
  "市議会は火曜日に新しい交通計画を承認し、港湾地区と北部郊外を結ぶ2本のライトレール路線に予算を割り当てた。計画には既存のバス網の再編も含まれ、2030年の開業を目指して来年度から用地取得が始まる。市長は記者会見で、渋滞の緩和と沿線の再開発が主な狙いだと述べ、事業費の半分は国の補助金で賄われる見通しを示した。";

const JA_UNRELATED =
  "研究チームは固体電池のエネルギー密度を2倍にし、充電時間を半分にする新しい電池化学を発表した。実験室条件では従来のリチウムイオン電池を大きく上回る性能を示しており、量産化に向けた課題は電解質の安定性だという。共同研究に参加する自動車メーカーは、5年以内の実用化を目標に掲げている。";

/** The clustering threshold, written as a literal so changing the default does not quietly move these tests with it. */
const THRESHOLD = 6;

const hash = (text: string) => simhash(text) as string;

describe("simhash", () => {
  test("is 64 bits of 0 and 1, and the same text always hashes the same", () => {
    const first = hash(ARTICLE);
    expect(first).toMatch(/^[01]{64}$/);
    expect(hash(ARTICLE)).toBe(first);
  });

  test("text shorter than one shingle has nothing to hash", () => {
    expect(simhash("")).toBeNull();
    expect(simhash("ab")).toBeNull();
    expect(simhash("abc")).toMatch(/^[01]{64}$/);
  });

  test("a character outside the BMP is one character, not two", () => {
    // Two emoji are two code points but four UTF-16 units. Counted as units,
    // this would be long enough to hash, and each shingle would hold half a
    // character.
    expect(simhash("🚀🚀")).toBeNull();
  });

  test("wire copy with a different byline and footer is the same story", () => {
    // The syndication case clustering exists for: the body is the outlet's
    // copy of the wire, and only the furniture around it differs.
    const syndicated = `WIRE — ${ARTICLE} Reporting by staff; editing by the desk.`;
    expect(hammingDistance(hash(ARTICLE), hash(syndicated))).toBeLessThanOrEqual(THRESHOLD);
  });

  test("a light rewording of an article body stays within the threshold", () => {
    const edited = ARTICLE.replace("that will connect", "connecting");
    expect(hammingDistance(hash(ARTICLE), hash(edited))).toBeLessThanOrEqual(THRESHOLD);
  });

  test("an unrelated article lands far outside the threshold", () => {
    expect(hammingDistance(hash(ARTICLE), hash(UNRELATED))).toBeGreaterThan(THRESHOLD * 2);
  });

  test("Japanese needs no tokeniser: an edit stays close and an unrelated article does not", () => {
    const edited = JA.replace("新しい交通計画", "新交通計画");
    expect(hammingDistance(hash(JA), hash(edited))).toBeLessThanOrEqual(THRESHOLD);
    expect(hammingDistance(hash(JA), hash(JA_UNRELATED))).toBeGreaterThan(THRESHOLD * 2);
  });

  test("the same edit moves a short text further than a long one", () => {
    // Why a feed that publishes only a title and a line of summary is left to
    // the embedding signal: on 200 characters this edit crosses the threshold,
    // on an article body it does not register. Measured: 12, 4 and 0 bits.
    const distanceAt = (length: number) => {
      const text = ARTICLE.slice(0, length);
      return hammingDistance(hash(text), hash(text.replace("that will connect", "connecting")));
    };
    expect(distanceAt(200)).toBeGreaterThan(THRESHOLD);
    expect(distanceAt(775)).toBeLessThanOrEqual(THRESHOLD);
  });
});

describe("hammingDistance", () => {
  test("counts exactly the positions that differ", () => {
    expect(hammingDistance("0000", "0000")).toBe(0);
    expect(hammingDistance("0101", "0011")).toBe(2);
    expect(hammingDistance("1111", "0000")).toBe(4);
  });

  test("refuses hashes of different lengths rather than comparing a prefix", () => {
    expect(() => hammingDistance("01", "011")).toThrow("lengths differ");
  });
});
