/**
 * Turning what someone typed into something PGroonga will answer.
 *
 * Two measured facts about PGroonga shape everything here:
 *
 *   A space-separated query is an implicit AND. `Rust 機械学習` matches only
 *   documents containing both, so a natural-language question -- which is
 *   exactly how an agent phrases a search -- returns nothing once it has more
 *   than a couple of words.
 *
 *   The relevance score is term frequency. Not BM25: no length normalisation
 *   and no inverse document frequency, just how many times the term occurs.
 *
 * Taken together they decide the strategy. Terms are joined with OR so recall
 * survives, and the precision that AND would have given comes back through
 * ranking instead: a document matching three of the query's terms accumulates
 * more term frequency than one matching a single term, so it sorts higher
 * without anything being excluded.
 */

/**
 * Cap on terms taken from one query.
 *
 * A pasted paragraph would otherwise become a hundred-clause OR that matches
 * most of the corpus, which is slow and useless in the same breath.
 */
const MAX_TERMS = 32;

/**
 * Split a query into the terms that will be OR'd together.
 *
 * Splitting on whitespace only. CJK gets no special treatment on purpose:
 * `機械学習の論文` stays one term, and PGroonga segments it internally into a
 * phrase match, which is the behaviour a Japanese substring query wants. Trying
 * to segment it here would mean shipping a tokeniser to second-guess the one in
 * the database.
 *
 * The result is raw user text. It must be escaped before it reaches a query,
 * which happens in SQL via pgroonga_query_escape() -- the escaping rules belong
 * to PGroonga's version, not to a copy of them maintained here.
 */
export function searchTerms(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_TERMS);
}

/**
 * Reciprocal Rank Fusion constant.
 *
 * 60 is the value from the original paper and the de facto default. It sets how
 * quickly a result's contribution decays with rank: large enough that the
 * difference between rank 1 and rank 2 does not dominate, small enough that
 * rank 200 contributes almost nothing.
 */
export const RRF_K = 60;

/**
 * Fuse two ranked lists.
 *
 * Exported and pure so the arithmetic can be tested without a database, even
 * though the query does this in SQL. The two must agree, and a test that pins
 * the intended behaviour is worth more than a comment claiming it.
 *
 * By rank rather than by score, which is the whole point of RRF here:
 * PGroonga's term counts and pgvector's cosine distances are not on comparable
 * scales, and no amount of normalisation would make them so.
 */
export function reciprocalRankFusion(
  ranks: ReadonlyArray<number | null>,
  k: number = RRF_K,
): number {
  return ranks.reduce<number>((total, rank) => total + (rank === null ? 0 : 1 / (k + rank)), 0);
}
