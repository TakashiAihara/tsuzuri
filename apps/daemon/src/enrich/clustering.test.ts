import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDatabase, DEFAULT_USER_ID, migrate } from "@tsuzuri/db";

import { createApi } from "../api.ts";
import { loadConfig } from "../config.ts";
import { createClusteringService } from "./clustering.ts";
import { createEmbeddingService } from "./embeddings.ts";
import { createInterestService } from "./interest.ts";

/**
 * Clustering end to end: real text hashed by the real SimHash, assigned by the
 * real queries, then read back through the API as a collapsed timeline.
 *
 * No embedding model is configured, which is the case clustering has to work
 * in without help -- syndicated copy collapses on SimHash alone.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const STORY =
  "The city council approved the new transit plan on Tuesday, allocating funds for two additional light rail lines that will connect the harbour district with the northern suburbs by 2030. The plan also restructures the existing bus network, and land acquisition begins next fiscal year with the aim of opening in 2030. At a press conference the mayor said the main goals were easing congestion and redeveloping the areas along the route, and indicated that half of the project cost would be covered by national subsidies. Opposition members questioned the projected ridership figures, arguing that the forecasts assumed population growth the city has not seen in a decade.";

const OTHER =
  "Researchers announced a breakthrough in battery chemistry, doubling the energy density of solid-state cells while halving the charge time in laboratory conditions. The team said the main obstacle to mass production is the stability of the electrolyte, which degrades after a few hundred cycles at room temperature. A carmaker taking part in the joint research has set a target of commercial use within five years, and several suppliers have begun pilot lines.";

const id = (prefix: string) => `${prefix}${"0".repeat(64 - prefix.length)}`;
const WIRE = id("aaaa0001");
const COPY = id("aaaa0002");
const ALONE = id("bbbb0001");

describeIfDb("clustering", () => {
  let handle: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof createApi>;
  let clustering: ReturnType<typeof createClusteringService>;
  let wireFeed: string;
  let outletFeed: string;

  const readAt = async (itemId: string) => {
    const [row] = await handle.sql<Array<{ readAt: Date | null }>>`
      SELECT read_at AS "readAt" FROM item_state WHERE item_id = ${itemId}
    `;
    return row?.readAt ?? null;
  };
  const starredAt = async (itemId: string) => {
    const [row] = await handle.sql<Array<{ starredAt: Date | null }>>`
      SELECT starred_at AS "starredAt" FROM item_state WHERE item_id = ${itemId}
    `;
    return row?.starredAt ?? null;
  };
  const listing = async (query: string) => {
    const response = await app.fetch(new Request(`http://test/items?${query}`));
    return (await response.json()) as { items: Array<{ id: string; clusterSize: number }> };
  };
  const setState = (itemId: string, body: Record<string, unknown>) =>
    app.fetch(
      new Request(`http://test/items/${itemId}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    // The wire copy and an outlet's copy of it, an hour apart; an unrelated
    // story in between.
    for (const [itemId, published, text] of [
      [WIRE, "2026-10-01T00:00:00Z", STORY],
      [COPY, "2026-10-01T01:00:00Z", `WIRE — ${STORY} Reporting by staff.`],
      [ALONE, "2026-10-01T00:30:00Z", OTHER],
    ] as const) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${itemId}, ${`https://e.com/${itemId}`}, ${`https://e.com/${itemId}`},
                ${itemId.slice(0, 8)}, ${published}, ${text})
      `;
    }
    // The copy arrives through a different outlet's feed, as syndicated copy
    // does. Two items from one subscription are never clustered.
    const sources = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES (${DEFAULT_USER_ID}, 'feed', 'https://wire.example/feed'),
             (${DEFAULT_USER_ID}, 'feed', 'https://outlet.example/feed')
      RETURNING id
    `;
    [wireFeed, outletFeed] = sources.map((row) => row.id as string) as [string, string];
    for (const [itemId, sourceId] of [
      [WIRE, wireFeed],
      [COPY, outletFeed],
      [ALONE, wireFeed],
    ] as const) {
      await handle.sql`
        INSERT INTO item_sources (item_id, source_id) VALUES (${itemId}, ${sourceId as string})
      `;
    }

    const config = loadConfig({
      DATABASE_URL: DATABASE_URL as string,
      CLUSTERING_ENABLED: "true",
    });
    const embeddings = createEmbeddingService({ sql: handle.sql, config });
    await embeddings.start();
    const interest = createInterestService({ sql: handle.sql, config, embeddings });
    clustering = createClusteringService({ sql: handle.sql, config, embeddings });
    app = createApi({
      db: handle.db,
      sql: handle.sql,
      fetcher: fetch,
      config,
      embeddings,
      interest,
      clustering,
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  test("a pass puts syndicated copy in one cluster and leaves the unrelated story alone", async () => {
    const result = await clustering.runPass();
    // WIRE founds (oldest), ALONE founds, COPY joins WIRE.
    expect(result).toEqual({ joined: 1, founded: 2, idle: false });

    const rows = await handle.sql<Array<{ itemId: string; matchedBy: string | null }>>`
      SELECT item_id AS "itemId", matched_by AS "matchedBy" FROM item_clusters ORDER BY item_id
    `;
    expect([...rows]).toEqual([
      { itemId: WIRE, matchedBy: null },
      { itemId: COPY, matchedBy: "simhash" },
      { itemId: ALONE, matchedBy: null },
    ]);
  });

  test("a second pass finds nothing left to do", async () => {
    expect(await clustering.runPass()).toEqual({ joined: 0, founded: 0, idle: true });
  });

  test("the timeline shows one row per story, carrying how many reports it stands for", async () => {
    const { items } = await listing("unread=false");
    expect(items.map((item) => [item.id, item.clusterSize])).toEqual([
      // COPY (01:00) is the newest item but is hidden behind WIRE, so the
      // story is placed by its representative's 00:00 and ALONE (00:30) leads.
      [ALONE, 1],
      [WIRE, 2],
    ]);
  });

  test("collapse=false shows every report", async () => {
    const { items } = await listing("unread=false&collapse=false");
    expect(items.map((item) => item.id).sort()).toEqual([WIRE, COPY, ALONE].sort());
  });

  test("reading the story's row with scope=cluster reads every report of it", async () => {
    expect((await setState(WIRE, { read: true, scope: "cluster" })).status).toBe(200);
    expect(await readAt(WIRE)).not.toBeNull();
    expect(await readAt(COPY)).not.toBeNull();
    // A different story is untouched.
    expect(await readAt(ALONE)).toBeNull();

    // And unreading it carries back the same way.
    await setState(WIRE, { read: false, scope: "cluster" });
    expect(await readAt(WIRE)).toBeNull();
    expect(await readAt(COPY)).toBeNull();
  });

  test("scope=item reads only the report named", async () => {
    await setState(WIRE, { read: true, scope: "item" });
    expect(await readAt(WIRE)).not.toBeNull();
    expect(await readAt(COPY)).toBeNull();
    await setState(WIRE, { read: false, scope: "item" });
  });

  test("with no scope a read is carried across the story, as MCP's mark_read sends it", async () => {
    // COPY is what search returns; reading it must not leave WIRE unread in
    // the collapsed list.
    await setState(COPY, { read: true });
    expect(await readAt(WIRE)).not.toBeNull();
    await setState(COPY, { read: false });
    expect(await readAt(WIRE)).toBeNull();
  });

  test("a star is not carried across the cluster even with scope=cluster", async () => {
    // Eight syndicated copies starred would count one opinion eight times.
    await setState(WIRE, { starred: true, scope: "cluster" });
    expect(await starredAt(WIRE)).not.toBeNull();
    expect(await starredAt(COPY)).toBeNull();
  });

  test("one subscription's own view shows its reports, even ones another outlet represents", async () => {
    // COPY came through the outlet's feed but is not the representative.
    // Collapsing here would hide the outlet's only report of the story.
    const { items } = await listing(`unread=false&sourceId=${outletFeed}`);
    expect(items.map((item) => item.id)).toEqual([COPY]);
  });

  test("carrying a read across the story keeps a report's earlier read time", async () => {
    await handle.sql`
      INSERT INTO item_state (user_id, item_id, read_at)
      VALUES (${DEFAULT_USER_ID}, ${COPY}, '2026-01-01T00:00:00Z')
      ON CONFLICT (user_id, item_id) DO UPDATE SET read_at = excluded.read_at
    `;
    await setState(WIRE, { read: true, scope: "cluster" });
    // COPY was read in January; reading the story now must not rewrite when
    // COPY itself was read.
    // Raw queries return timestamptz as text here (drizzle swaps the parser).
    expect(new Date((await readAt(COPY)) as unknown as string).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(await readAt(WIRE)).not.toBeNull();
    await setState(WIRE, { read: false, scope: "cluster" });
  });

  test("doctor reports what clustering has done", async () => {
    const response = await app.fetch(new Request("http://test/doctor"));
    const body = (await response.json()) as { features: { clustering: unknown } };
    expect(body.features.clustering).toEqual({
      enabled: true,
      clusters: 2,
      clusteredItems: 3,
      pending: 0,
    });
  });

  test("deleting a source by a malformed id is a 404, not a database error", async () => {
    const response = await app.fetch(
      new Request("http://test/sources/not-a-uuid", { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
  });

  test("unsubscribing from the representative's feed leaves the story visible", async () => {
    // Last, because it removes a subscription from the shared fixture. WIRE
    // represents the story and came only through the wire feed; once that is
    // gone, COPY from the outlet must stand for the story.
    expect(
      (await app.fetch(new Request(`http://test/sources/${wireFeed}`, { method: "DELETE" })))
        .status,
    ).toBe(200);
    const { items } = await listing("unread=false");
    // WIRE can no longer be listed, so COPY stands for no other report.
    expect(items.find((item) => item.id === COPY)?.clusterSize).toBe(1);
  });
});
