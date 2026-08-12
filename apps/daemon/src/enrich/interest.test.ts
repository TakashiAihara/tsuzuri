import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, DEFAULT_USER_ID, insertEmbeddings, migrate } from "@tsuzuri/db";

import { loadConfig } from "../config.ts";
import { createEmbeddingService } from "./embeddings.ts";
import { createInterestService } from "./interest.ts";

/**
 * The service that turns reading history into a profile, end to end against a
 * real database.
 *
 * The pure arithmetic is covered in @tsuzuri/core and the SQL in @tsuzuri/db.
 * What is only testable here is the part in between: which items become
 * signals, how their weights reach the geometry, and where a skip lands.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

/** Three axes, so an interest and its opposite are obvious by inspection. */
const VECTORS: Record<string, [number, number, number]> = {
  "rust-a": [1, 0, 0],
  "rust-b": [0.98, 0.19, 0],
  "rust-c": [0.97, 0, 0.24],
  "cooking-a": [0, 1, 0],
  "cooking-b": [0, 0.98, 0.19],
  "sport-a": [0, 0, 1],
  "sport-b": [0.1, 0, 0.99],
};

describeIfDb("createInterestService", () => {
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: string[] };
      // The stub is only used for the probe and for query embedding; item
      // vectors are inserted directly so the geometry is controlled.
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      });
    },
  });

  const handle = createDatabase({ url: DATABASE_URL as string, max: 4 });

  const config = (overrides: Record<string, string> = {}) =>
    loadConfig({
      DATABASE_URL: DATABASE_URL as string,
      EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      EMBEDDING_MODEL: "stub",
      INTEREST_SCORING_ENABLED: "true",
      INTEREST_MIN_SIGNALS: "3",
      INTEREST_CLUSTERS_MAX: "3",
      INTEREST_EXPLORATION_RATIO: "0",
      ...overrides,
    });

  afterAll(async () => {
    provider.stop(true);
    await handle.close();
  });

  beforeEach(async () => {
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    const [source] = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES (${DEFAULT_USER_ID}, 'feed', 'https://e.com/feed')
      RETURNING id
    `;
    for (const id of Object.keys(VECTORS)) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${id}, ${`https://e.com/${id}`}, ${`https://e.com/${id}`}, ${id}, now(), ${id})
      `;
      await handle.sql`
        INSERT INTO item_sources (item_id, source_id) VALUES (${id}, ${source?.id as string})
      `;
    }
  });

  /** Bring embeddings up and load the controlled vectors. */
  async function ready(overrides: Record<string, string> = {}) {
    const cfg = config(overrides);
    const embeddings = createEmbeddingService({ sql: handle.sql, config: cfg });
    await embeddings.start();
    await embeddings.stop();
    await insertEmbeddings(
      handle.sql,
      Object.entries(VECTORS).map(([itemId, vector]) => ({
        itemId,
        vector: `[${vector.join(",")}]`,
      })),
    );
    const interest = createInterestService({ sql: handle.sql, config: cfg, embeddings });
    return { interest, embeddings };
  }

  async function signal(itemId: string, kind: "read" | "starred" | "skipped") {
    const column = `${kind}_at`;
    await handle.sql.unsafe(
      `INSERT INTO item_state (user_id, item_id, ${column}) VALUES ($1, $2, now())
       ON CONFLICT (user_id, item_id) DO UPDATE SET ${column} = now()`,
      [DEFAULT_USER_ID, itemId],
    );
  }

  test("builds a profile from reading history", async () => {
    const { interest } = await ready();
    for (const id of ["rust-a", "rust-b", "rust-c", "cooking-a"]) await signal(id, "read");

    const result = await interest.rebuild();
    expect(result.clusters).toBeGreaterThan(0);
    expect(result.signals).toBe(4);

    const status = await interest.status();
    expect(status.active).toBe(true);
    expect(status.builtAt).not.toBeNull();
  });

  test("ranks what matches the history above what does not", async () => {
    const { interest } = await ready();
    for (const id of ["rust-a", "rust-b", "rust-c"]) await signal(id, "starred");
    await interest.rebuild();

    const page = await interest.rank({ limit: 10, unreadOnly: false, sourceId: null });
    expect(page.scoring.active).toBe(true);
    const ids = page.items.map((item) => item.id);
    // Everything on the Rust axis outranks everything off it.
    expect(ids.indexOf("rust-a")).toBeLessThan(ids.indexOf("cooking-a"));
    expect(ids.indexOf("rust-a")).toBeLessThan(ids.indexOf("sport-a"));
  });

  test("a rebuild over unchanged history produces an unchanged profile", async () => {
    // Without a seeded PRNG the same history would give a different timeline
    // on every rebuild, and nothing here could be asserted.
    const { interest } = await ready();
    for (const id of ["rust-a", "rust-b", "cooking-a", "cooking-b"]) await signal(id, "read");

    await interest.rebuild();
    const first = await handle.sql<Array<{ centroid: string }>>`
      SELECT centroid::text AS centroid FROM interest_clusters ORDER BY ordinal
    `;
    await interest.rebuild();
    const second = await handle.sql<Array<{ centroid: string }>>`
      SELECT centroid::text AS centroid FROM interest_clusters ORDER BY ordinal
    `;
    expect(second.map((row) => row.centroid)).toEqual(first.map((row) => row.centroid));
  });

  test("skips charge the interest they sit closest to, and lower its score", async () => {
    const { interest } = await ready();
    for (const id of ["rust-a", "rust-b", "cooking-a", "cooking-b"]) await signal(id, "read");
    await interest.rebuild();
    const before = await interest.rank({ limit: 10, unreadOnly: false, sourceId: null });
    const rustBefore = before.items.find((item) => item.id === "rust-c")?.interest as number;

    // Skipping on the Rust axis must cost the Rust cluster, not the cooking one.
    await signal("rust-c", "skipped");
    await interest.rebuild();

    const rows = await handle.sql<Array<{ skipped: number; positive: number }>>`
      SELECT skipped_weight AS skipped, positive_weight AS positive
      FROM interest_clusters ORDER BY skipped_weight DESC
    `;
    expect(rows[0]?.skipped).toBeGreaterThan(0);
    // Exactly one cluster carries it; the others are untouched, which is what
    // makes affinity exactly 1 for an interest nothing has been skipped near.
    expect(rows.slice(1).every((row) => row.skipped === 0)).toBe(true);

    const after = await interest.rank({ limit: 10, unreadOnly: false, sourceId: null });
    const rustAfter = after.items.find((item) => item.id === "rust-c")?.interest as number;
    expect(rustAfter).toBeLessThan(rustBefore);
  });

  test("never writes a cluster with no positive weight", async () => {
    const { interest } = await ready();
    // Skips alone: there is nothing positive to cluster, so there is no profile.
    for (const id of ["rust-a", "rust-b", "cooking-a"]) await signal(id, "skipped");
    const result = await interest.rebuild();
    expect(result.clusters).toBe(0);
  });

  test("reserves exploration slots and labels them", async () => {
    const { interest } = await ready({ INTEREST_EXPLORATION_RATIO: "0.4" });
    for (const id of ["rust-a", "rust-b", "rust-c"]) await signal(id, "read");
    await interest.rebuild();

    const page = await interest.rank({ limit: 5, unreadOnly: false, sourceId: null });
    const explored = page.items.filter((item) => item.exploration);
    expect(explored.length).toBeGreaterThan(0);
    // An unlabelled item that ranking did not choose is indistinguishable from
    // a ranking bug, which is the whole reason the flag is on the wire.
    expect(explored.every((item) => item.interest === 0)).toBe(true);
    expect(new Set(page.items.map((item) => item.id)).size).toBe(page.items.length);
  });

  test("stays inactive, with a reason, below the signal threshold", async () => {
    const { interest } = await ready({ INTEREST_MIN_SIGNALS: "50" });
    await signal("rust-a", "read");
    const page = await interest.rank({ limit: 10, unreadOnly: false, sourceId: null });
    expect(page.scoring.active).toBe(false);
    expect(page.items).toHaveLength(0);
    if (!page.scoring.active) {
      expect(page.scoring.reason).toBe("not enough reading history yet");
      expect(page.scoring.required).toBe(50);
    }
  });

  test("says the profile is missing rather than ranking against nothing", async () => {
    const { interest } = await ready();
    for (const id of ["rust-a", "rust-b", "rust-c"]) await signal(id, "read");
    const page = await interest.rank({ limit: 10, unreadOnly: false, sourceId: null });
    expect(page.scoring.active).toBe(false);
    if (!page.scoring.active) {
      expect(page.scoring.reason).toBe("the interest profile has not been built yet");
    }
  });

  test("refuses to build when scoring is switched off", async () => {
    const { interest } = await ready({ INTEREST_SCORING_ENABLED: "false" });
    await expect(interest.rebuild()).rejects.toThrow(/INTEREST_SCORING_ENABLED/);
  });
});
