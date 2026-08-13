import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDatabase } from "./client.ts";
import { ensureItemEmbeddings, insertEmbeddings } from "./embeddings.ts";
import {
  explorationCandidates,
  interestClustersExists,
  readProfileSummary,
  scoreItems,
  signalCount,
  signalledItems,
  writeInterestProfile,
} from "./interest.ts";
import { migrate } from "./migrate.ts";
import { DEFAULT_USER_ID } from "./schema.ts";

/**
 * Ranking is the part of this feature most likely to be quietly wrong, so these
 * tests assert orderings and numbers rather than only membership.
 *
 * Three dimensions, with each interest pointing along an axis, so "near" and
 * "far" are obvious by inspection and a wrong ordering is unambiguous.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const DIMENSION = 3;
const NOW = new Date("2026-08-12T00:00:00Z");

describeIfDb("interest profile and scoring", () => {
  let handle: ReturnType<typeof createDatabase>;
  let sourceRead: string;
  let sourceUnread: string;

  /** Items on the x axis are "the interest"; y is unrelated; z is skipped territory. */
  const corpus = [
    { id: "x-fresh", vector: "[1,0,0]", published: "2026-08-11T00:00:00Z", estimated: false },
    { id: "x-week-old", vector: "[1,0,0]", published: "2026-08-05T00:00:00Z", estimated: false },
    { id: "x-estimated", vector: "[1,0,0]", published: "2026-08-11T00:00:00Z", estimated: true },
    { id: "y-unrelated", vector: "[0,1,0]", published: "2026-08-11T00:00:00Z", estimated: false },
    { id: "z-skipped", vector: "[0,0,1]", published: "2026-08-11T00:00:00Z", estimated: false },
  ] as const;

  const scoreDefaults = {
    userId: DEFAULT_USER_ID,
    limit: 20,
    unreadOnly: false,
    sourceId: null,
    recencyHalfLifeHours: 72,
    estimatedFactor: 0.7,
    windowDays: 30,
  };

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
    await ensureItemEmbeddings(handle.sql, DIMENSION);

    const sources = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES (${DEFAULT_USER_ID}, 'feed', 'https://read.example/feed'),
             (${DEFAULT_USER_ID}, 'feed', 'https://unread.example/feed')
      RETURNING id
    `;
    sourceRead = sources[0]?.id as string;
    sourceUnread = sources[1]?.id as string;

    for (const item of corpus) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at,
                           published_at_estimated, search_text)
        VALUES (${item.id}, ${`https://e.com/${item.id}`}, ${`https://e.com/${item.id}`},
                ${item.id}, ${item.published}::timestamptz, ${item.estimated}, ${item.id})
      `;
      await handle.sql`
        INSERT INTO item_sources (item_id, source_id)
        VALUES (${item.id}, ${item.id.startsWith("y") ? sourceUnread : sourceRead})
      `;
    }
    await insertEmbeddings(
      handle.sql,
      corpus.map((item) => ({ itemId: item.id, vector: item.vector })),
    );
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function resetState(): Promise<void> {
    await handle.sql`DELETE FROM item_state`;
    await handle.sql`DELETE FROM interest_clusters`;
  }

  /** A profile with one interest on the x axis, optionally penalised by skips. */
  async function seedProfile(skippedWeight = 0): Promise<void> {
    await writeInterestProfile(handle.sql, {
      userId: DEFAULT_USER_ID,
      builtAt: NOW,
      clusters: [
        {
          ordinal: 0,
          centroid: [1, 0, 0],
          positiveWeight: 4,
          skippedWeight,
          members: 4,
        },
      ],
    });
  }

  test("the profile table is created alongside the vector table", async () => {
    // The two share a dimension and a vector space, so one existing without the
    // other is a state ranking cannot recover from.
    expect(await interestClustersExists(handle.sql)).toBe(true);
  });

  describe("signals", () => {
    test("counts each timestamp, not each row", async () => {
      await resetState();
      await handle.sql`
        INSERT INTO item_state (user_id, item_id, read_at, starred_at)
        VALUES (${DEFAULT_USER_ID}, 'x-fresh', now(), now())
      `;
      // Read and then starred is two signals: it told us two things.
      expect(await signalCount(handle.sql, DEFAULT_USER_ID)).toBe(2);
    });

    test("returns timestamps and vectors for signalled items only", async () => {
      await resetState();
      await handle.sql`
        INSERT INTO item_state (user_id, item_id, starred_at)
        VALUES (${DEFAULT_USER_ID}, 'x-fresh', ${NOW.toISOString()}::timestamptz)
      `;
      const rows = await signalledItems(handle.sql, { userId: DEFAULT_USER_ID, limit: 50 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.itemId).toBe("x-fresh");
      expect(rows[0]?.starredAt?.toISOString()).toBe(NOW.toISOString());
      expect(rows[0]?.readAt).toBeNull();
      expect(rows[0]?.embedding).toEqual([1, 0, 0]);
    });

    test("respects the cap that bounds what is pulled into memory", async () => {
      await resetState();
      for (const item of corpus) {
        await handle.sql`
          INSERT INTO item_state (user_id, item_id, read_at)
          VALUES (${DEFAULT_USER_ID}, ${item.id}, now())
        `;
      }
      const rows = await signalledItems(handle.sql, { userId: DEFAULT_USER_ID, limit: 2 });
      expect(rows).toHaveLength(2);
    });
  });

  describe("writeInterestProfile", () => {
    test("stores and reads back a profile", async () => {
      await resetState();
      const written = await seedProfile().then(() =>
        readProfileSummary(handle.sql, DEFAULT_USER_ID),
      );
      expect(written.clusters).toBe(1);
      expect(written.builtAt?.toISOString()).toBe(NOW.toISOString());
    });

    test("refuses a zero-length centroid rather than storing it", async () => {
      // Storing one would make every distance against it NaN, and NaN sorts
      // above every real number, so arbitrary articles would be pinned to the
      // top of the timeline with nothing logged anywhere.
      await resetState();
      const written = await writeInterestProfile(handle.sql, {
        userId: DEFAULT_USER_ID,
        clusters: [
          { ordinal: 0, centroid: [0, 0, 0], positiveWeight: 1, skippedWeight: 0, members: 1 },
          { ordinal: 1, centroid: [1, 0, 0], positiveWeight: 1, skippedWeight: 0, members: 1 },
        ],
      });
      expect(written).toBe(1);
      expect((await readProfileSummary(handle.sql, DEFAULT_USER_ID)).clusters).toBe(1);
    });

    test("replaces the previous profile wholesale", async () => {
      await resetState();
      await seedProfile();
      await seedProfile();
      expect((await readProfileSummary(handle.sql, DEFAULT_USER_ID)).clusters).toBe(1);
    });
  });

  describe("scoreItems", () => {
    test("ranks items near the interest above unrelated ones", async () => {
      await resetState();
      await seedProfile();
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const first = rows[0];
      expect(first?.id).toBe("x-fresh");
      const unrelated = rows.find((row) => row.id === "y-unrelated");
      expect(unrelated?.interest).toBeLessThan(first?.interest as number);
    });

    test("decays a week-old item to about a fifth of its similarity", async () => {
      await resetState();
      await seedProfile();
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const fresh = rows.find((row) => row.id === "x-fresh");
      const old = rows.find((row) => row.id === "x-week-old");
      // Both sit on the same axis, so the only difference is age. Similarity
      // and affinity are both 1 here, which makes the score the decay itself.
      expect(old?.affinitySimilarity).toBeCloseTo(fresh?.affinitySimilarity as number, 6);
      expect(old?.interest).toBeCloseTo(0.198, 3);
      expect(old?.interest).toBeLessThan((fresh?.interest as number) * 0.3);
    });

    test("discounts an item whose date was guessed", async () => {
      // Without this, every dateless article outranks everything, because its
      // guessed publication time is always "now".
      await resetState();
      await seedProfile();
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const real = rows.find((row) => row.id === "x-fresh");
      const guessed = rows.find((row) => row.id === "x-estimated");
      expect(guessed?.interest).toBeCloseTo((real?.interest as number) * 0.7, 6);
      expect(guessed?.interest).toBeLessThan(real?.interest as number);
    });

    test("matches the arithmetic the pure module computes", async () => {
      // The SQL and @tsuzuri/core implement the same formula twice. This is
      // what says they agree.
      await resetState();
      await seedProfile(4);
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const fresh = rows.find((row) => row.id === "x-fresh");
      // affinity(4, 4) = 0.5, similarity 1, age 24h at a 72h half-life.
      const expected = 1 * 0.5 * 0.5 ** (24 / 72);
      expect(fresh?.interest).toBeCloseTo(expected, 6);
      expect(fresh?.affinitySimilarity).toBeCloseTo(0.5, 6);
    });

    test("takes the best penalised match, not the nearest match penalised after", async () => {
      // Two clusters: one exactly on the item and almost entirely skipped, one
      // slightly off it and untouched. Applying affinity outside max() would
      // let the skipped cluster win on raw proximity; inside, the clean one
      // does. This test fails under the other placement.
      await resetState();
      await writeInterestProfile(handle.sql, {
        userId: DEFAULT_USER_ID,
        builtAt: NOW,
        clusters: [
          {
            ordinal: 0,
            centroid: [1, 0, 0],
            positiveWeight: 1,
            skippedWeight: 99,
            members: 1,
          },
          {
            ordinal: 1,
            centroid: [0.8, 0.6, 0],
            positiveWeight: 5,
            skippedWeight: 0,
            members: 5,
          },
        ],
      });
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const fresh = rows.find((row) => row.id === "x-fresh");
      // Skipped cluster: 1 * 0.01 = 0.01. Clean cluster: 0.8 * 1 = 0.8.
      expect(fresh?.affinitySimilarity).toBeCloseTo(0.8, 3);
    });

    test("ignores a zero-length centroid that reached the table anyway", async () => {
      // The writer refuses these, so this inserts one directly. The guard in
      // the query is the second of two, and it is the one that matters: a NaN
      // here sorts above every real score.
      await resetState();
      await seedProfile();
      await handle.sql`
        INSERT INTO interest_clusters
          (user_id, ordinal, centroid, positive_weight, skipped_weight, members)
        VALUES (${DEFAULT_USER_ID}, 99, '[0,0,0]'::vector, 1, 0, 1)
      `;
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Number.isNaN(row.interest)).toBe(false);
        expect(Number.isNaN(row.affinitySimilarity)).toBe(false);
      }
      expect(rows[0]?.id).toBe("x-fresh");
    });

    test("filters to unread and to one subscription", async () => {
      await resetState();
      await seedProfile();
      await handle.sql`
        INSERT INTO item_state (user_id, item_id, read_at)
        VALUES (${DEFAULT_USER_ID}, 'x-fresh', now())
      `;
      const unread = await scoreItems(handle.sql, { ...scoreDefaults, unreadOnly: true }, NOW);
      expect(unread.map((row) => row.id)).not.toContain("x-fresh");

      const scoped = await scoreItems(
        handle.sql,
        { ...scoreDefaults, sourceId: sourceUnread },
        NOW,
      );
      expect(scoped.map((row) => row.id)).toEqual(["y-unrelated"]);
    });

    test("does not let a future-dated item outrank everything", async () => {
      // Ingest accepts a publication date up to a day ahead, so this is
      // reachable from a real feed with a fast clock. An unclamped age makes
      // the exponent negative, the decay greater than 1, and the item's score
      // exceed its own similarity. core's decayFactor clamps the same input.
      await resetState();
      await seedProfile();
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES ('x-future', 'https://e.com/f', 'https://e.com/f', 'future',
                ${NOW.toISOString()}::timestamptz + interval '12 hours', 'future')
        ON CONFLICT (id) DO UPDATE SET published_at = EXCLUDED.published_at
      `;
      await handle.sql`
        INSERT INTO item_embeddings (item_id, embedding)
        SELECT id, vec::vector FROM UNNEST(ARRAY['x-future'], ARRAY['[1,0,0]']) AS t(id, vec)
        ON CONFLICT (item_id) DO UPDATE SET embedding = EXCLUDED.embedding
      `;

      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const future = rows.find((row) => row.id === "x-future");
      expect(future?.interest).toBeLessThanOrEqual(future?.affinitySimilarity as number);
      expect(future?.interest).toBeCloseTo(1, 6);

      await handle.sql`DELETE FROM items WHERE id = 'x-future'`;
    });

    test("floors a similarity that points away from every interest", async () => {
      // Cosine distance runs to 2, so this term goes negative for an opposed
      // vector. Multiplying a negative by a decay makes older items score
      // higher among them, which is backwards.
      await resetState();
      await writeInterestProfile(handle.sql, {
        userId: DEFAULT_USER_ID,
        builtAt: NOW,
        clusters: [
          { ordinal: 0, centroid: [-1, 0, 0], positiveWeight: 1, skippedWeight: 0, members: 1 },
        ],
      });
      const rows = await scoreItems(handle.sql, scoreDefaults, NOW);
      const fresh = rows.find((row) => row.id === "x-fresh");
      const old = rows.find((row) => row.id === "x-week-old");
      expect(fresh?.affinitySimilarity).toBe(0);
      expect(fresh?.interest).toBe(0);
      // Tied at zero, so the older one must not sort above the newer one.
      expect(rows.indexOf(fresh as (typeof rows)[number])).toBeLessThan(
        rows.indexOf(old as (typeof rows)[number]),
      );
    });

    test("returns nothing when there is no profile", async () => {
      await resetState();
      expect(await scoreItems(handle.sql, scoreDefaults, NOW)).toHaveLength(0);
    });
  });

  describe("explorationCandidates", () => {
    test("prefers the subscription with the fewest reads", async () => {
      await resetState();
      // Four reads on sourceRead, none on sourceUnread.
      for (const id of ["x-fresh", "x-week-old", "x-estimated", "z-skipped"]) {
        await handle.sql`
          INSERT INTO item_state (user_id, item_id, read_at)
          VALUES (${DEFAULT_USER_ID}, ${id}, now())
        `;
      }
      const rows = await explorationCandidates(
        handle.sql,
        {
          userId: DEFAULT_USER_ID,
          limit: 1,
          unreadOnly: false,
          sourceId: null,
          windowDays: 30,
          exclude: [],
        },
        NOW,
      );
      expect(rows.map((row) => row.id)).toEqual(["y-unrelated"]);
    });

    test("never offers something scoring already chose", async () => {
      await resetState();
      const rows = await explorationCandidates(
        handle.sql,
        {
          userId: DEFAULT_USER_ID,
          limit: 10,
          unreadOnly: false,
          sourceId: null,
          windowDays: 30,
          exclude: ["y-unrelated", "x-fresh"],
        },
        NOW,
      );
      expect(rows.map((row) => row.id)).not.toContain("y-unrelated");
      expect(rows.map((row) => row.id)).not.toContain("x-fresh");
    });

    test("is deterministic", async () => {
      await resetState();
      const options = {
        userId: DEFAULT_USER_ID,
        limit: 3,
        unreadOnly: false,
        sourceId: null,
        windowDays: 30,
        exclude: [] as string[],
      };
      const first = await explorationCandidates(handle.sql, options, NOW);
      const second = await explorationCandidates(handle.sql, options, NOW);
      expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    });

    test("returns nothing when no slots are reserved", async () => {
      await resetState();
      const rows = await explorationCandidates(
        handle.sql,
        {
          userId: DEFAULT_USER_ID,
          limit: 0,
          unreadOnly: false,
          sourceId: null,
          windowDays: 30,
          exclude: [],
        },
        NOW,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
