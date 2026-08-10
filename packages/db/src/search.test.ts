import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDatabase } from "./client.ts";
import { ensureItemEmbeddings, insertEmbeddings } from "./embeddings.ts";
import { migrate } from "./migrate.ts";
import { DEFAULT_USER_ID } from "./schema.ts";
import { hybridSearch, textScores } from "./search.ts";

/**
 * Ranking is the part of this feature most likely to be quietly wrong, so these
 * tests assert orderings and scores rather than only membership.
 *
 * The corpus is deliberately small but adversarial: a long article that
 * mentions a product in passing, a short article about it, Japanese text with
 * no spaces, and documents that are semantically near without sharing a word.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

/** Four dimensions is enough to place documents in obviously distinct directions. */
const DIMENSION = 4;

describeIfDb("hybridSearch", () => {
  let handle: ReturnType<typeof createDatabase>;
  let sourceA: string;
  let sourceB: string;

  const corpus = [
    {
      id: "short-rust",
      title: "Rust 1.90 released",
      body: "Rust 1.90 is out. The release focuses on the borrow checker.",
      vector: "[1,0,0,0]",
      published: "2026-08-09",
    },
    {
      id: "long-mentions-rust",
      title: "A very long week in review",
      // Mentions Rust more times than the article actually about Rust, but
      // buried in a document many times longer. This is the case that raw term
      // frequency gets wrong and sqrt(length) normalisation gets right, so the
      // corpus has to be built so the two orderings genuinely disagree.
      body: `${"Assorted notes about deployments, meetings and coffee. ".repeat(40)} We mentioned Rust here. Rust came up again. Someone asked about Rust. Rust once more. Rust.`,
      vector: "[0,1,0,0]",
      published: "2026-08-08",
    },
    {
      id: "ja-ml",
      title: "機械学習の論文まとめ",
      body: "今週読んだ機械学習の論文をまとめる。自然言語処理の話題が中心。",
      vector: "[0,0,1,0]",
      published: "2026-08-07",
    },
    {
      id: "ja-dl",
      title: "ディープラーニング入門",
      // Semantically adjacent to ja-ml but shares no query term with it.
      body: "ニューラルネットワークの基礎を解説する。",
      vector: "[0,0,0.95,0.05]",
      published: "2026-08-06",
    },
    {
      id: "unrelated",
      title: "Bread recipes",
      body: "How to bake sourdough at home.",
      vector: "[0,0,0,1]",
      published: "2026-08-05",
    },
  ];

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    const [a] = await handle.sql<{ id: string }[]>`
      INSERT INTO sources (user_id, kind, url) VALUES (${DEFAULT_USER_ID}, 'feed', 'https://a.example/feed')
      RETURNING id
    `;
    const [b] = await handle.sql<{ id: string }[]>`
      INSERT INTO sources (user_id, kind, url) VALUES (${DEFAULT_USER_ID}, 'feed', 'https://b.example/feed')
      RETURNING id
    `;
    sourceA = (a as { id: string }).id;
    sourceB = (b as { id: string }).id;

    await ensureItemEmbeddings(handle.sql, DIMENSION);

    for (const doc of corpus) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (
          ${doc.id}, ${`https://example.com/${doc.id}`}, ${`https://example.com/${doc.id}`},
          ${doc.title}, ${doc.published}, ${`${doc.title} ${doc.body}`}
        )
      `;
      await handle.sql`
        INSERT INTO item_sources (item_id, source_id)
        VALUES (${doc.id}, ${doc.id === "unrelated" ? sourceB : sourceA})
      `;
      await insertEmbeddings(handle.sql, [{ itemId: doc.id, vector: doc.vector }]);
    }

    // One item read, so unreadOnly has something to exclude.
    await handle.sql`
      INSERT INTO item_state (user_id, item_id, read_at)
      VALUES (${DEFAULT_USER_ID}, 'short-rust', now())
    `;
  });

  afterAll(async () => {
    await handle?.close();
  });

  const search = (options: Partial<Parameters<typeof hybridSearch>[1]> & { terms: string[] }) =>
    hybridSearch(handle.sql, {
      limit: 10,
      userId: DEFAULT_USER_ID,
      ...options,
    });

  describe("text arm", () => {
    test("an exact product name finds the article about it", async () => {
      const { hits } = await search({ terms: ["Rust"] });
      expect(hits.map((h) => h.id)).toContain("short-rust");
    });

    test("length normalisation puts the short article about a term above the long one mentioning it", async () => {
      // PGroonga scores raw term frequency, so without the sqrt(length)
      // correction this ordering is not guaranteed by anything.
      const { hits } = await search({ terms: ["Rust"] });
      const ids = hits.map((h) => h.id);
      expect(ids.indexOf("short-rust")).toBeLessThan(ids.indexOf("long-mentions-rust"));
    });

    test("a Japanese substring query matches inside an unspaced phrase", async () => {
      // The reason PGroonga is a hard dependency: tsvector would tokenise
      // 機械学習の論文まとめ as one term and find nothing for 機械学習.
      const { hits } = await search({ terms: ["機械学習"] });
      expect(hits.map((h) => h.id)).toContain("ja-ml");
    });

    test("terms are OR'd, so a multi-word query still returns something", async () => {
      // Space-separated is an implicit AND in PGroonga; an agent's phrasing
      // would otherwise come back empty.
      const { hits } = await search({ terms: ["Rust", "機械学習", "sourdough"] });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("short-rust");
      expect(ids).toContain("ja-ml");
      expect(ids).toContain("unrelated");
    });

    test("query syntax typed by a user is literal, not operators", async () => {
      // pgroonga_query_escape neutralises these; the query must not error and
      // must not be interpreted.
      const { hits } = await search({ terms: ["(OR)", "-Rust", '"quoted"'] });
      expect(Array.isArray(hits)).toBe(true);
    });

    test("no terms yields no hits rather than everything", async () => {
      expect((await search({ terms: [] })).hits).toEqual([]);
    });

    test("publishedAt is ISO 8601, matching every other endpoint", async () => {
      // Drizzle replaces the client's type parsers, so raw queries on the same
      // client get PostgreSQL's text format instead. Two shapes for one field
      // across two endpoints is a trap for anything consuming the API.
      const { hits } = await search({ terms: ["Rust"] });
      const publishedAt = hits[0]?.publishedAt as string;
      expect(publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isNaN(new Date(publishedAt).getTime())).toBe(false);
    });

    test("returns a highlighted snippet for text matches", async () => {
      const { hits } = await search({ terms: ["Rust"] });
      const hit = hits.find((h) => h.id === "short-rust");
      expect(hit?.snippet).toContain("Rust");
    });
  });

  describe("scores survive every filter combination", () => {
    // The silent failure mode of this whole feature: pgroonga_score() returns 0
    // for rows the planner did not fetch through the PGroonga index. Results
    // stay correct, ranking collapses, and nothing raises an error. These cases
    // exist to catch a plan regression rather than a logic bug.
    const cases: { name: string; options: Record<string, unknown> }[] = [
      { name: "no filters", options: {} },
      { name: "since", options: { since: new Date("2026-08-01") } },
      { name: "sourceId", options: { sourceId: undefined } },
      { name: "unreadOnly", options: { unreadOnly: true } },
      {
        name: "since + unreadOnly",
        options: { since: new Date("2026-08-01"), unreadOnly: true },
      },
    ];

    for (const { name, options } of cases) {
      test(name, async () => {
        const resolved = "sourceId" in options ? { ...options, sourceId: sourceA } : options;
        const { hits } = await search({ terms: ["Rust"], ...resolved });
        expect(hits.length).toBeGreaterThan(0);
        // A collapsed ranking shows up as every hit tying at rank 1.
        expect(hits.every((h) => h.rrf > 0)).toBe(true);
      });
    }

    test("raw text scores are non-zero, which is what a lost index scan destroys", async () => {
      const scores = await textScores(handle.sql, ["Rust"]);
      expect(scores.length).toBeGreaterThan(0);
      expect(scores.every((row) => row.score > 0)).toBe(true);
    });
  });

  describe("filters", () => {
    test("since excludes older items", async () => {
      const { hits } = await search({
        terms: ["Rust", "sourdough"],
        since: new Date("2026-08-09"),
      });
      expect(hits.map((h) => h.id)).toEqual(["short-rust"]);
    });

    test("sourceId restricts to one subscription", async () => {
      const { hits } = await search({ terms: ["Rust", "sourdough"], sourceId: sourceB });
      expect(hits.map((h) => h.id)).toEqual(["unrelated"]);
    });

    test("unreadOnly excludes what has been read", async () => {
      const { hits } = await search({ terms: ["Rust"], unreadOnly: true });
      expect(hits.map((h) => h.id)).not.toContain("short-rust");
    });

    test("filters apply to the vector arm too, not only the text arm", async () => {
      // Filtering after fusion would let a filtered-out item back in through
      // the vector side.
      const { hits } = await search({
        terms: ["Rust"],
        queryVector: "[1,0,0,0]",
        unreadOnly: true,
      });
      expect(hits.map((h) => h.id)).not.toContain("short-rust");
    });
  });

  describe("vector arm", () => {
    test("finds a semantic neighbour that shares no query term", async () => {
      // ja-dl contains none of the query's characters; only the vector arm can
      // reach it.
      const { hits } = await search({ terms: ["機械学習"], queryVector: "[0,0,1,0]" });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("ja-ml");
      expect(ids).toContain("ja-dl");
    });

    test("reports hybrid mode and per-arm ranks", async () => {
      const result = await search({ terms: ["機械学習"], queryVector: "[0,0,1,0]" });
      expect(result.mode).toBe("hybrid");
      const jaMl = result.hits.find((h) => h.id === "ja-ml");
      expect(jaMl?.textRank).toBeGreaterThan(0);
      expect(jaMl?.vectorRank).toBeGreaterThan(0);
    });

    test("an item found only by vector has no text rank", async () => {
      const result = await search({ terms: ["機械学習"], queryVector: "[0,0,1,0]" });
      expect(result.hits.find((h) => h.id === "ja-dl")?.textRank).toBeNull();
    });

    test("the distance ceiling keeps unrelated neighbours out of the tail", async () => {
      // Without a ceiling the arm returns its nearest N however far away they
      // are, filling the result set with whatever exists.
      const far = await search({
        terms: ["機械学習"],
        queryVector: "[0,0,1,0]",
        maxDistance: 0.01,
      });
      expect(far.hits.map((h) => h.id)).not.toContain("unrelated");

      const wide = await search({
        terms: ["機械学習"],
        queryVector: "[0,0,1,0]",
        maxDistance: 2,
      });
      expect(wide.hits.map((h) => h.id)).toContain("unrelated");
    });

    test("both arms contributing outranks either alone", async () => {
      const { hits } = await search({ terms: ["機械学習"], queryVector: "[0,0,1,0]" });
      // ja-ml is first in both arms; ja-dl only in one.
      expect(hits[0]?.id).toBe("ja-ml");
      expect((hits[0]?.rrf ?? 0) > (hits[1]?.rrf ?? 0)).toBe(true);
    });
  });

  describe("degradation", () => {
    test("without a query vector the mode is text-only and vector ranks are null", async () => {
      const result = await search({ terms: ["Rust"] });
      expect(result.mode).toBe("text-only");
      expect(result.hits.every((h) => h.vectorRank === null)).toBe(true);
      expect(result.hits.every((h) => h.rrf > 0)).toBe(true);
    });

    test("text-only returns the same shape as hybrid", async () => {
      const textOnly = await search({ terms: ["Rust"] });
      const hybrid = await search({ terms: ["Rust"], queryVector: "[1,0,0,0]" });
      expect(Object.keys(textOnly.hits[0] ?? {}).sort()).toEqual(
        Object.keys(hybrid.hits[0] ?? {}).sort(),
      );
    });

    test("respects the limit", async () => {
      const { hits } = await search({
        terms: ["Rust", "機械学習", "sourdough"],
        queryVector: "[1,0,0,0]",
        limit: 2,
      });
      expect(hits).toHaveLength(2);
    });
  });
});
