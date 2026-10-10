import { sha256 } from "./hash.ts";

/**
 * SimHash over character 3-grams, for spotting near-verbatim copies of a story.
 *
 * Character n-grams rather than words, uniformly across scripts: whitespace
 * does not segment Japanese, which is the reason PGroonga is a hard
 * dependency, and running a word tokeniser for one script and something else
 * for another would be two behaviours to tune where one works (D22).
 *
 * Returned as a 64-character string of 0 and 1 so it can be written straight
 * into a `bit(64)` column, where Hamming distance is `bit_count(a # b)`.
 */

const SHINGLE = 3;
const BITS = 64;

/** Null when the text is shorter than one shingle and there is nothing to hash. */
export function simhash(text: string): string | null {
  // Code points rather than UTF-16 units, so a character outside the BMP is
  // one character and never split across two shingles.
  const chars = Array.from(text);
  if (chars.length < SHINGLE) return null;

  const counts = new Map<string, number>();
  for (let i = 0; i + SHINGLE <= chars.length; i++) {
    const shingle = chars.slice(i, i + SHINGLE).join("");
    counts.set(shingle, (counts.get(shingle) ?? 0) + 1);
  }

  const sums = new Array<number>(BITS).fill(0);
  for (const [shingle, count] of counts) {
    // The first 16 hex digits of sha256 are 64 bits, taken most significant
    // bit first so position i of the result is bit i of this prefix.
    const hex = sha256(shingle).slice(0, BITS / 4);
    for (let nibble = 0; nibble < hex.length; nibble++) {
      const value = Number.parseInt(hex[nibble] as string, 16);
      for (let bit = 0; bit < 4; bit++) {
        const position = nibble * 4 + bit;
        const set = (value >> (3 - bit)) & 1;
        sums[position] = (sums[position] ?? 0) + (set ? count : -count);
      }
    }
  }

  return sums.map((sum) => (sum > 0 ? "1" : "0")).join("");
}

/** Number of positions at which two SimHashes differ. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`hash lengths differ: ${a.length} vs ${b.length}`);
  let distance = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
  return distance;
}
