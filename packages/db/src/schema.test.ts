import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql as raw } from "drizzle-orm";

import { createDatabase, type Database } from "./client.ts";
import { migrate } from "./migrate.ts";
import { DEFAULT_USER_ID, itemSources, itemState, items, sources } from "./schema.ts";

/**
 * Integration test against a real PostgreSQL with pgroonga and pgvector.
 *
 * Its main job is keeping the hand-written SQL migrations and the Drizzle
 * mirror in schema.ts honest: every table is exercised through Drizzle after
 * the SQL has run, so a column renamed in one place and not the other fails
 * here rather than in production.
 *
 * Skipped when TSUZURI_TEST_DATABASE_URL is unset so that `bun test` stays
 * usable without Docker.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("schema", () => {
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 2 });
    db = handle.db;
    // Start from nothing so the test describes the real first-run path.
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  afterAll(async () => {
    await handle?.close();
  });

  test("migrations are idempotent", async () => {
    const second = await migrate(handle.sql);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  test("required extensions are installed", async () => {
    const rows = await handle.sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('pgroonga', 'vector')
    `;
    expect(rows.map((r) => r.extname).sort()).toEqual(["pgroonga", "vector"]);
  });

  test("seeds the default user so single-user installs need no setup", async () => {
    const rows = await handle.sql<{ id: string }[]>`SELECT id FROM users`;
    expect(rows.map((r) => r.id)).toEqual([DEFAULT_USER_ID]);
  });

  test("round-trips a source, an item and its state through Drizzle", async () => {
    const [source] = await db
      .insert(sources)
      .values({
        userId: DEFAULT_USER_ID,
        kind: "feed",
        url: "https://example.com/feed.xml",
        title: "Example",
      })
      .returning();
    expect(source?.status).toBe("active");
    expect(source?.fetchIntervalSeconds).toBe(3600);

    await db.insert(items).values({
      id: "a".repeat(64),
      url: "https://example.com/posts/hello",
      canonicalUrl: "https://example.com/posts/hello",
      title: "Hello",
      publishedAt: new Date("2026-08-09T00:00:00Z"),
      searchText: "Hello 機械学習の論文について",
    });

    await db.insert(itemSources).values({ itemId: "a".repeat(64), sourceId: source?.id as string });

    await db
      .insert(itemState)
      .values({ userId: DEFAULT_USER_ID, itemId: "a".repeat(64), readAt: new Date() });

    const state = await db
      .select()
      .from(itemState)
      .where(eq(itemState.itemId, "a".repeat(64)));
    expect(state).toHaveLength(1);
    expect(state[0]?.readAt).toBeInstanceOf(Date);
  });

  test("the same article can arrive from two sources without duplicating", async () => {
    // Two hundred subscriptions overlap in practice, and read state has to be
    // per article rather than per subscription.
    const [second] = await db
      .insert(sources)
      .values({ userId: DEFAULT_USER_ID, kind: "feed", url: "https://aggregator.example/feed.xml" })
      .returning();

    await db.insert(itemSources).values({ itemId: "a".repeat(64), sourceId: second?.id as string });

    const rows = await db
      .select()
      .from(itemSources)
      .where(eq(itemSources.itemId, "a".repeat(64)));
    expect(rows).toHaveLength(2);

    const itemRows = await db.select().from(items);
    expect(itemRows).toHaveLength(1);
  });

  // Drizzle query builders and postgres.js query objects are lazy thenables:
  // they only issue SQL once something awaits them. Handing one straight to
  // expect().rejects never runs the query and the test hangs, so force a real
  // promise first.
  const run = async (thenable: PromiseLike<unknown>): Promise<void> => {
    await thenable;
  };

  test("rejects a second subscription to the same URL", async () => {
    await expect(
      run(
        db
          .insert(sources)
          .values({ userId: DEFAULT_USER_ID, kind: "feed", url: "https://example.com/feed.xml" }),
      ),
    ).rejects.toThrow();
  });

  test("rejects an unknown source kind", async () => {
    await expect(
      run(handle.sql`
        INSERT INTO sources (user_id, kind, url)
        VALUES (${DEFAULT_USER_ID}, 'telepathy', 'https://example.com/x')
      `),
    ).rejects.toThrow();
  });

  test("pgroonga finds Japanese text that tsvector would not segment", async () => {
    // The whole reason pgroonga is a hard dependency: searching for a substring
    // of a Japanese phrase has to match.
    const rows = await db
      .select({ id: items.id })
      .from(items)
      .where(raw`${items.searchText} &@~ ${"機械学習"}`);
    expect(rows.map((r) => r.id)).toEqual(["a".repeat(64)]);
  });

  test("deleting a source leaves the global item but drops the link", async () => {
    const [victim] = await db
      .select()
      .from(sources)
      .where(eq(sources.url, "https://aggregator.example/feed.xml"));

    await db.delete(sources).where(eq(sources.id, victim?.id as string));

    const links = await db
      .select()
      .from(itemSources)
      .where(eq(itemSources.itemId, "a".repeat(64)));
    expect(links).toHaveLength(1);

    const itemRows = await db.select().from(items);
    expect(itemRows).toHaveLength(1);
  });
});
