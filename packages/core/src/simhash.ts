/**
 * 64-bit SimHash over character shingles of search_text, for near-duplicate
 * detection across sources (P3 clustering, design D17).
 *
 * Character trigrams rather than word shingles because half the corpus is
 * Japanese, where word boundaries do not exist in the text. Trigrams work for
 * both scripts without a tokeniser dependency.
 */

const SHINGLE_SIZE = 3;

/**
 * SimHash of a text: 64 bits where each bit is the majority vote of that bit
 * across the hashes of all shingles. Texts that share most of their shingles —
 * syndicated copy with a different byline — land within a few bits of each
 * other; unrelated texts land ~32 bits apart.
 *
 * Whitespace runs are collapsed and case is folded first, so markup-driven
 * reflow between outlets does not move the hash. Returns 0n for text shorter
 * than one shingle; callers treat 0n as "no hash" rather than comparing it.
 */
export function simhash64(text: string): bigint {
  const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
  if (normalized.length < SHINGLE_SIZE) return 0n;

  const counts = new Int32Array(64);
  for (let i = 0; i <= normalized.length - SHINGLE_SIZE; i++) {
    const hash = fnv1a64(normalized.slice(i, i + SHINGLE_SIZE));
    for (let bit = 0; bit < 64; bit++) {
      counts[bit] = (counts[bit] ?? 0) + ((hash >> BigInt(bit)) & 1n ? 1 : -1);
    }
  }

  let result = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if ((counts[bit] ?? 0) > 0) result |= 1n << BigInt(bit);
  }
  return result;
}

/**
 * Number of differing bits between two SimHashes.
 *
 * Masked to 64 bits first, so a hash that has been through a signed
 * round-trip (see toSigned64) compares identically to its unsigned form.
 */
export function hammingDistance64(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

const SIGN_BIT = 1n << 63n;

/**
 * Reinterpret an unsigned 64-bit hash as the signed value Postgres stores.
 *
 * `bigint` in Postgres is signed, and simhash64 sets the top bit about half
 * the time, so storing the raw value fails outright ("out of range") for half
 * the corpus. Reinterpreting rather than truncating keeps every bit, which is
 * what Hamming distance needs.
 */
export function toSigned64(hash: bigint): bigint {
  const masked = hash & MASK64;
  return masked & SIGN_BIT ? masked - (1n << 64n) : masked;
}

/** The inverse of toSigned64, for values read back out of the database. */
export function fromSigned64(stored: bigint): bigint {
  return stored < 0n ? stored + (1n << 64n) : stored;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}
