import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { simhash64, toSigned64 } from "@tsuzuri/core";
import {
  clusteringStatus,
  clusterMembers,
  createDatabase,
  createEmbeddingTable,
  insertEmbeddings,
  migrate,
} from "@tsuzuri/db";

import { loadConfig } from "../config.ts";
import { runClusterPass } from "./cluster-worker.ts";

/**
 * Clustering against a real database, with real SimHashes and real pgvector
 * distances. The two signals are independent by design, so the cases that
 * matter are the ones where only one of them can fire.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const NOW = new Date("2026-08-28T12:00:00Z");
const HOUR_MS = 3_600_000;

const STORY =
  "The city council approved the new transit plan on Tuesday, allocating funds for two additional light rail lines that will connect the harbour district with the northern suburbs by 2030.";
const STORY_SYNDICATED =
  "The city council approved the new transit plan on Tuesday, allocating funds for two additional light rail lines connecting the harbour district with the northern suburbs by 2030.";
const OTHER_STORY =
  "Researchers announced a breakthrough in battery chemistry, doubling the energy density of solid-state cells while halving the charge time in laboratory conditions.";

describeIfDb("runClusterPass", () => {
  let handle: ReturnType<typeof createDatabase>;

  const config = loadConfig({ DATABASE_URL: "postgres://unused" });

  async function seedItem(
    id: string,
    text: string,
    publishedAt: Date,
    options: { hash?: boolean } = {},
  ) {
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text, simhash)
      VALUES (
        ${id},
        ${`https://example.com/${id}`},
        ${`https://example.com/${id}`},
        ${id},
        ${publishedAt.toISOString()},
        ${text},
        ${options.hash === false ? null : toSigned64(simhash64(text)).toString()}::bigint
      )
    `;
  }

  async function clusterOf(id: string): Promise<string | null> {
    const [row] = await handle.sql<{ clusterId: string | null }[]>`
      SELECT cluster_id AS "clusterId" FROM items WHERE id = ${id}
    `;
    return row?.clusterId ?? null;
  }

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 2 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.sql.unsafe("DROP TABLE IF EXISTS item_embeddings");
    await handle.sql`DELETE FROM items`;
    await handle.sql`DELETE FROM clusters`;
  });

  test("syndicated copy joins one cluster with no embedding model at all", async () => {
    await seedItem("first-outlet", STORY, NOW);
    await seedItem("second-outlet", STORY_SYNDICATED, new Date(NOW.getTime() + HOUR_MS));
    await seedItem("unrelated", OTHER_STORY, NOW);

    const result = await runClusterPass({ sql: handle.sql, config });
    expect(result.assigned).toBe(3);
    // Two stories, so two clusters: the syndicated pair and the unrelated one.
    expect(result.clustersCreated).toBe(2);

    expect(await clusterOf("second-outlet")).toBe(await clusterOf("first-outlet"));
    expect(await clusterOf("unrelated")).not.toBe(await clusterOf("first-outlet"));
  });

  test("the earliest-published member is the representative, whatever order they arrive in", async () => {
    // The later item is inserted first, so a pass that took insertion order
    // rather than publication order would elect the wrong one.
    await seedItem("later", STORY_SYNDICATED, new Date(NOW.getTime() + 2 * HOUR_MS));
    await seedItem("earlier", STORY, NOW);

    await runClusterPass({ sql: handle.sql, config });

    const clusterId = await clusterOf("earlier");
    const [row] = await handle.sql<{ representativeItem: string }[]>`
      SELECT representative_item AS "representativeItem" FROM clusters WHERE id = ${clusterId}::uuid
    `;
    expect(row?.representativeItem).toBe("earlier");

    const members = await clusterMembers(handle.sql, clusterId as string);
    expect(members.map((member) => member.id)).toEqual(["later"]);
  });

  test("a story reported a week apart is two clusters, not one", async () => {
    await seedItem("this-week", STORY, NOW);
    // Beyond CLUSTER_WINDOW_HOURS: the same event does not arrive that late,
    // and without the window every anniversary piece would join the original.
    await seedItem("last-week", STORY_SYNDICATED, new Date(NOW.getTime() - 7 * 24 * HOUR_MS));

    const result = await runClusterPass({ sql: handle.sql, config });
    expect(result.clustersCreated).toBe(2);
    expect(await clusterOf("this-week")).not.toBe(await clusterOf("last-week"));
  });

  test("the embedding signal clusters a story told in different words", async () => {
    // Different enough that SimHash cannot see it: this is exactly the case
    // the vector arm exists for.
    await seedItem("plain", "Council approves transit plan.", NOW);
    await seedItem("reworded", "Light rail expansion gets the go-ahead from the city.", NOW);
    expect(
      // Guard the premise: if these ever became SimHash-close, the test would
      // pass for the wrong reason.
      simhash64("Council approves transit plan.") !==
        simhash64("Light rail expansion gets the go-ahead from the city."),
    ).toBe(true);

    await createEmbeddingTable(handle.sql, 4);
    await insertEmbeddings(handle.sql, [
      { itemId: "plain", vector: "[1,0,0,0]" },
      { itemId: "reworded", vector: "[0.99,0.14,0,0]" },
    ]);

    const result = await runClusterPass({ sql: handle.sql, config });
    expect(result.clustersCreated).toBe(1);
    expect(await clusterOf("reworded")).toBe(await clusterOf("plain"));
  });

  test("distant vectors stay apart even inside the window", async () => {
    await seedItem("transit", "Council approves transit plan.", NOW);
    await seedItem("battery", "Solid-state battery breakthrough announced.", NOW);
    await createEmbeddingTable(handle.sql, 4);
    await insertEmbeddings(handle.sql, [
      { itemId: "transit", vector: "[1,0,0,0]" },
      { itemId: "battery", vector: "[0,1,0,0]" },
    ]);

    const result = await runClusterPass({ sql: handle.sql, config });
    expect(result.clustersCreated).toBe(2);
  });

  test("items predating the column get hashed by the pass itself", async () => {
    await seedItem("legacy", STORY, NOW, { hash: false });

    const result = await runClusterPass({ sql: handle.sql, config });
    expect(result.hashed).toBe(1);

    const [row] = await handle.sql<{ simhash: string | null }[]>`
      SELECT simhash::text AS simhash FROM items WHERE id = 'legacy'
    `;
    expect(row?.simhash).toBe(toSigned64(simhash64(STORY)).toString());
  });

  test("a second pass over settled items does nothing", async () => {
    await seedItem("a", STORY, NOW);
    await seedItem("b", STORY_SYNDICATED, NOW);
    await runClusterPass({ sql: handle.sql, config });

    const again = await runClusterPass({ sql: handle.sql, config });
    expect(again).toEqual({ hashed: 0, assigned: 0, clustersCreated: 0, idle: true });
  });

  test("status counts the clusters that actually collapse something", async () => {
    await seedItem("dup-a", STORY, NOW);
    await seedItem("dup-b", STORY_SYNDICATED, NOW);
    await seedItem("alone", OTHER_STORY, NOW);
    await runClusterPass({ sql: handle.sql, config });

    const status = await clusteringStatus(handle.sql);
    expect(status).toEqual({ clusters: 2, clustered: 3, unclustered: 0, duplicates: 1 });
  });
});
