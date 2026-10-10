import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ChatError, type ChatProvider, type ChatRequest } from "@tsuzuri/core";
import {
  createDatabase,
  DEFAULT_USER_ID,
  insertEmbeddings,
  interestClustersExists,
  migrate,
  recordEnrichmentFailure,
  writeEnrichment,
  writeInterestProfile,
} from "@tsuzuri/db";

import { loadConfig } from "../config.ts";
import { createEmbeddingService } from "./embeddings.ts";
import {
  createEnrichmentService,
  EnrichmentPreconditionError,
  type EnrichmentService,
} from "./enrichment.ts";
import type { InterestService } from "./interest.ts";

/**
 * The pass, end to end against a real database with a chat provider that never
 * leaves the process.
 *
 * What is under test is the part between the two: which items are chosen, what
 * is asked of the model about each, which answers are stored under which
 * prompt version, and what is recorded when one fails. The wire formats are
 * covered in @tsuzuri/core against stub servers, and the storage in
 * @tsuzuri/db.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const MODEL = "stub-chat";

type Answer = string | Error;

/**
 * A chat provider that answers from a function.
 *
 * Answering by prompt rather than by a queue of canned strings is what lets a
 * test say "it asked about the title and the summary, not the body": a queue
 * would make the assertion about position rather than about the request.
 */
function stubChat(answer: (request: ChatRequest) => Answer | Promise<Answer>) {
  const asked: ChatRequest[] = [];
  const chat: ChatProvider = {
    id: "openai-compatible",
    model: MODEL,
    async complete(request) {
      asked.push(request);
      const next = await answer(request);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { chat, asked };
}

/** Answers each prompt the pass uses, with recognisable content. */
function answerEachPrompt(
  overrides: Partial<Record<"summary" | "tags" | "translation" | "body", Answer>> = {},
): (request: ChatRequest) => Answer {
  return (request) => {
    const system = request.system;
    if (system.includes("summarise articles")) {
      return overrides.summary ?? '{"summary": "The model said this."}';
    }
    if (system.includes("tag articles")) {
      return overrides.tags ?? '{"tags": [], "candidates": []}';
    }
    if (system.includes("article bodies")) {
      return overrides.body ?? '{"text": "the translated body"}';
    }
    if (system.includes("titles and summaries")) {
      return overrides.translation ?? '{"title": "題", "text": "要約"}';
    }
    return "no prompt matched";
  };
}

/**
 * Scoring off. The service asks the interest service exactly one question --
 * whether a ranked order exists -- so that is all this answers.
 */
const NO_INTEREST = { status: async () => ({ active: false }) } as unknown as InterestService;

describeIfDb("createEnrichmentService", () => {
  /**
   * Only used to create the vector column and to insert controlled vectors, so
   * that ranking can be switched on for one test. It answers every input with
   * the same vector and is never asked about an article.
   */
  const embeddings = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: string[] };
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      });
    },
  });

  const handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
  let feed: string;

  /** Scoring on, so a pass spends on the best match rather than the newest. */
  const rankingActive = {
    status: async () => ({
      enabled: true,
      builtAt: null,
      active: true as const,
      signals: 40,
      required: 30,
      clusters: 1,
    }),
  } as unknown as InterestService;

  const config = (overrides: Record<string, string> = {}) =>
    loadConfig({
      DATABASE_URL: DATABASE_URL as string,
      ENRICH_TAGS: "false",
      ...overrides,
    });

  function service(
    chat: ChatProvider | null,
    overrides: Record<string, string> = {},
    interest: InterestService = NO_INTEREST,
  ): EnrichmentService {
    return createEnrichmentService({
      sql: handle.sql,
      config: config(overrides),
      interest,
      provider: chat,
    });
  }

  async function seedItem(
    id: string,
    options: {
      hoursAgo?: number;
      title?: string;
      text?: string;
      summary?: string | null;
      starred?: boolean;
    } = {},
  ) {
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text, summary)
      VALUES (
        ${id}, ${`https://e.com/${id}`}, ${`https://e.com/${id}`},
        ${options.title ?? `title ${id}`},
        now() - make_interval(hours => ${options.hoursAgo ?? 1}::int),
        ${options.text ?? `body of ${id}`},
        ${options.summary ?? null}
      )
    `;
    await handle.sql`
      INSERT INTO item_sources (item_id, source_id) VALUES (${id}, ${feed})
    `;
    if (options.starred) {
      await handle.sql`
        INSERT INTO item_state (user_id, item_id, starred_at)
        VALUES (${DEFAULT_USER_ID}, ${id}, now())
      `;
    }
  }

  const storedSummaries = async () => {
    const rows = await handle.sql<Array<{ itemId: string; summary: string }>>`
      SELECT item_id AS "itemId", content->>'summary' AS summary
      FROM enrichments WHERE kind = 'summary' AND model = ${MODEL}
      ORDER BY item_id
    `;
    return [...rows];
  };

  const failures = async () => {
    const rows = await handle.sql<Array<{ itemId: string; kind: string }>>`
      SELECT item_id AS "itemId", kind FROM enrichment_failures ORDER BY item_id, kind
    `;
    return [...rows];
  };

  // Bun gives a hook five seconds. Every database test file shares one
  // PostgreSQL, and a DROP SCHEMA or a wide TRUNCATE under load occasionally
  // takes longer than that -- which fails the hook rather than anything this
  // file asserts, so the hooks below are given room.
  beforeAll(async () => {
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  }, 30_000);

  // The timeout is explained above beforeAll.
  beforeEach(async () => {
    // Sources are left alone: every database test file shares one database and
    // the same fixture URL, so truncating them here would delete rows another
    // file's fixture is still pointing at.
    await handle.sql.unsafe(
      "TRUNCATE items, item_state, item_sources, enrichments, enrichment_failures, item_tags, tag_vocabulary RESTART IDENTITY CASCADE",
    );
    // A profile left by an earlier test would make ranking available to a test
    // that means to run without it.
    if (await interestClustersExists(handle.sql)) {
      await handle.sql.unsafe("TRUNCATE interest_clusters");
    }
    const [source] = await handle.sql<Array<{ id: string }>>`
      INSERT INTO sources (user_id, kind, url)
      VALUES (${DEFAULT_USER_ID}, 'feed', 'https://enrich.example/feed')
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    // ON CONFLICT returns no row, so the fixture's own id is read back when
    // this test file has already created it.
    if (source?.id) {
      feed = source.id;
    } else {
      const [existing] = await handle.sql<Array<{ id: string }>>`
        SELECT id FROM sources WHERE url = 'https://enrich.example/feed' LIMIT 1
      `;
      feed = existing?.id as string;
    }
  }, 30_000);

  afterAll(async () => {
    embeddings.stop(true);
    await handle.close();
  });

  test("summarises what it selects and reports it", async () => {
    await seedItem("a", { hoursAgo: 1 });
    await seedItem("b", { hoursAgo: 2 });
    const { chat, asked } = stubChat(answerEachPrompt());

    const result = await service(chat).runPass();

    expect(result).toEqual({
      items: 2,
      summarised: 2,
      tagged: 0,
      translated: 0,
      failed: 0,
      bounded: false,
      idle: false,
    });
    expect(await storedSummaries()).toEqual([
      { itemId: "a", summary: "The model said this." },
      { itemId: "b", summary: "The model said this." },
    ]);
    // The title and the body, not a row of fields the prompt never asked for.
    expect(asked).toHaveLength(2);
    expect(asked[0]?.user).toContain("body of a");
    expect(asked[0]?.system).toContain("summarise articles");
  });

  test("a second pass has nothing to do", async () => {
    await seedItem("a");
    const { chat, asked } = stubChat(answerEachPrompt());

    await service(chat).runPass();
    expect(await service(chat).runPass()).toMatchObject({ items: 0, idle: true });
    expect(asked).toHaveLength(1);
  });

  test("an item outside the window is left alone", async () => {
    await seedItem("old", { hoursAgo: 24 * 5 });
    const { chat, asked } = stubChat(answerEachPrompt());

    expect(await service(chat).runPass()).toMatchObject({ items: 0, idle: true });
    expect(asked).toHaveLength(0);
  });

  test("does nothing at all with no chat model configured", async () => {
    await seedItem("a");

    expect(await service(null).runPass()).toMatchObject({ items: 0, idle: true });
    expect(await storedSummaries()).toEqual([]);
    expect((await service(null).status()).enabled).toBe(false);
  });

  test("tags: approved slugs are attached and the rest only suggested", async () => {
    await seedItem("a");
    await handle.sql`
      INSERT INTO tag_vocabulary (slug, label, status, observations)
      VALUES ('databases', 'Databases', 'approved', 0), ('cooking', 'Cooking', 'rejected', 0)
    `;
    const { chat } = stubChat(
      answerEachPrompt({
        tags: '{"tags": ["databases", "cooking"], "candidates": ["Query planners"]}',
      }),
    );

    const result = await service(chat, { ENRICH_TAGS: "true" }).runPass();

    expect(result.tagged).toBe(1);
    const attached = await handle.sql<Array<{ slug: string; source: string }>>`
      SELECT t.slug, it.source FROM item_tags it
      JOIN tag_vocabulary t ON t.id = it.tag_id
    `;
    // A rejected slug and one the model made up are both just suggestions:
    // only approved tags are tags.
    expect([...attached]).toEqual([{ slug: "databases", source: "model" }]);

    const vocabulary = await handle.sql<Array<{ slug: string; status: string; n: number }>>`
      SELECT slug, status, observations AS n FROM tag_vocabulary ORDER BY slug
    `;
    expect([...vocabulary]).toEqual([
      { slug: "cooking", status: "rejected", n: 0 },
      { slug: "databases", status: "approved", n: 0 },
      { slug: "query-planners", status: "candidate", n: 1 },
    ]);
  });

  test("an empty vocabulary is suggest-only, which is documented rather than broken", async () => {
    await seedItem("a");
    const { chat } = stubChat(
      answerEachPrompt({ tags: '{"tags": ["databases"], "candidates": ["compilers"]}' }),
    );

    await service(chat, { ENRICH_TAGS: "true" }).runPass();

    const attached = await handle.sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM item_tags
    `;
    expect([...attached]).toEqual([{ count: 0 }]);
    const [candidate] = await handle.sql<Array<{ slug: string; status: string }>>`
      SELECT slug, status FROM tag_vocabulary
    `;
    expect(candidate).toEqual({ slug: "databases", status: "candidate" });
  });

  test("translates the title and the summary, never the body", async () => {
    await seedItem("a", { title: "The plan", summary: "A feed summary.", text: "THE BODY" });
    const { chat, asked } = stubChat(answerEachPrompt());

    const result = await service(chat, { ENRICH_TRANSLATE_TO: "Japanese" }).runPass();

    expect(result.translated).toBe(1);
    const rows = await handle.sql<Array<{ lang: string; version: string; title: string }>>`
      SELECT lang, prompt_version AS version, content->>'title' AS title
      FROM enrichments WHERE kind = 'translation'
    `;
    expect([...rows]).toEqual([{ lang: "Japanese", version: "translation.v1", title: "題" }]);

    const translation = asked.find((request) => request.system.includes("titles and summaries"));
    expect(translation?.user).toContain("The plan");
    expect(translation?.user).toContain("The model said this.");
    expect(translation?.user).not.toContain("THE BODY");
  });

  test("no translation without a target language, however the item looks", async () => {
    await seedItem("a");
    const { chat, asked } = stubChat(answerEachPrompt());

    await service(chat).runPass();
    expect(asked.every((request) => !request.system.includes("titles and summaries"))).toBe(true);
  });

  test("a starred item is enriched however far down the list it is", async () => {
    await seedItem("newest", { hoursAgo: 1 });
    await seedItem("oldest", { hoursAgo: 20 });
    await seedItem("stale-star", { hoursAgo: 24 * 5, starred: true });
    const { chat } = stubChat(answerEachPrompt());

    const result = await service(chat, { ENRICH_TOP_N: "1" }).runPass();

    expect(result.items).toBe(2);
    // One is the top of the ranked list; the other is the star, which is added
    // whatever its rank and however long ago it was published.
    const summarised = (await storedSummaries()).map((row) => row.itemId);
    expect(summarised.sort()).toEqual(["newest", "stale-star"]);
  });

  test("spends on the best match rather than the newest article", async () => {
    await seedItem("near", { hoursAgo: 3 });
    await seedItem("new-but-unrelated", { hoursAgo: 1 });

    const cfg = config({
      EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_BASE_URL: `http://127.0.0.1:${embeddings.port}/v1`,
      EMBEDDING_MODEL: "stub",
    });
    const vectors = createEmbeddingService({ sql: handle.sql, config: cfg });
    await vectors.start();
    await vectors.stop();
    await insertEmbeddings(handle.sql, [
      { itemId: "near", vector: "[1,0,0]" },
      { itemId: "new-but-unrelated", vector: "[0,1,0]" },
    ]);
    await writeInterestProfile(handle.sql, {
      userId: DEFAULT_USER_ID,
      clusters: [
        { ordinal: 0, centroid: [1, 0, 0], positiveWeight: 3, skippedWeight: 0, members: 1 },
      ],
    });

    const { chat } = stubChat(answerEachPrompt());
    await service(chat, { ENRICH_TOP_N: "1" }, rankingActive).runPass();

    // Selection alone would have taken the newer article; it sits on the other
    // side of the interest, so ranking is what puts the older one first.
    expect((await storedSummaries()).map((row) => row.itemId)).toEqual(["near"]);
  });

  test("only the cluster representative is enriched while clustering is on", async () => {
    await seedItem("wire", { hoursAgo: 2 });
    await seedItem("copy", { hoursAgo: 1 });
    await handle.sql`
      INSERT INTO clusters (representative_item_id, size, first_published_at, last_published_at)
      VALUES ('wire', 2, now() - interval '2 hours', now())
    `;
    await handle.sql`
      INSERT INTO item_clusters (item_id, cluster_id)
      SELECT item.id, c.id FROM items item, clusters c
      WHERE c.representative_item_id = 'wire'
    `;

    const { chat } = stubChat(answerEachPrompt());
    await service(chat, { CLUSTERING_ENABLED: "true" }).runPass();

    expect((await storedSummaries()).map((row) => row.itemId)).toEqual(["wire"]);
  });

  test("a retryable failure is not recorded against the item", async () => {
    // Same rule as the embedding backfill: an endpoint that is down says
    // nothing about the article, and a failure row would park it for a backoff
    // it did nothing to earn.
    await seedItem("a");
    const { chat } = stubChat(() => new ChatError("chat request failed (503)", "retryable"));

    await expect(service(chat).runPass()).rejects.toThrow(/503/);
    expect(await failures()).toEqual([]);
  });

  test("a permanent refusal is recorded, and the item waits its turn", async () => {
    await seedItem("a");
    const { chat, asked } = stubChat(
      () => new ChatError("the model would not answer", "permanent"),
    );

    const result = await service(chat).runPass();

    expect(result.failed).toBe(1);
    expect(result.summarised).toBe(0);
    expect(await failures()).toEqual([{ itemId: "a", kind: "summary" }]);
    // And the next pass leaves it alone rather than paying for it again now.
    // Asserted on the calls, not on the failure rows: the backoff filter is
    // what makes the second pass free, and only a call count can fail when it
    // is removed.
    asked.length = 0;
    await service(chat).runPass();
    expect(asked).toHaveLength(0);
    expect(await failures()).toEqual([{ itemId: "a", kind: "summary" }]);
  });

  test("a configuration error is not recorded, and says so in the status", async () => {
    // Every item would fail this identically, so parking one behind a backoff
    // for a variable that takes a second to fix is the wrong answer twice.
    await seedItem("a");
    const { chat } = stubChat(() => new ChatError("chat request failed (401)", "configuration"));
    const enrichment = service(chat);

    await expect(enrichment.runPass()).rejects.toThrow(/401/);

    expect(await failures()).toEqual([]);
    const status = await enrichment.status();
    expect(status.lastError?.message).toMatch(/401/);
    // And an ISO instant, so "when" is answerable without reading the daemon's
    // log to work out how long this has been happening.
    expect(status.lastError?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("an answer that hit the output bound is a configuration error too", async () => {
    // Raising CHAT_MAX_OUTPUT_TOKENS is the fix, so this is not the article's
    // fault and must not be retried against the same bound.
    await seedItem("a");
    const { chat, asked } = stubChat(
      () => new ChatError("openai-compatible reached the 1024-token output bound", "configuration"),
    );
    const enrichment = service(chat);

    await expect(enrichment.runPass()).rejects.toThrow(/output bound/);

    expect(await failures()).toEqual([]);
    expect(asked).toHaveLength(1);
    expect((await enrichment.status()).lastError?.message).toMatch(/output bound/);
  });

  test("two unusable answers are recorded as a failure too", async () => {
    await seedItem("a");
    const { chat, asked } = stubChat(() => "I am afraid I cannot do that.");

    const result = await service(chat).runPass();

    expect(asked).toHaveLength(2);
    expect(result.failed).toBe(1);
    expect(await failures()).toEqual([{ itemId: "a", kind: "summary" }]);
  });

  test("a refusal of one kind does not hold back the others", async () => {
    await seedItem("a");
    const { chat } = stubChat((request) =>
      request.system.includes("tag articles")
        ? new ChatError("the model would not answer", "permanent")
        : '{"summary": "written anyway"}',
    );

    const result = await service(chat, { ENRICH_TAGS: "true" }).runPass();

    expect(result.summarised).toBe(1);
    expect(result.failed).toBe(1);
    expect(await failures()).toEqual([{ itemId: "a", kind: "tags" }]);
    expect(await storedSummaries()).toEqual([{ itemId: "a", summary: "written anyway" }]);
  });

  test("the hourly bound stops the pass and says that it did", async () => {
    for (const id of ["b1", "b2", "b3"]) await seedItem(id);
    for (const id of ["b1", "b2", "b3"]) {
      await writeEnrichment(handle.sql, {
        itemId: id,
        kind: "summary",
        model: "another-model",
        promptVersion: "summary.v1",
        content: { summary: "counted against this hour" },
      });
    }
    const { chat } = stubChat(answerEachPrompt());

    // Three of the four items an hour were spent in the last hour.
    const result = await service(chat, { ENRICH_MAX_ITEMS_PER_HOUR: "4" }).runPass();

    expect(result.items).toBe(1);
    expect(result.bounded).toBe(true);
    expect((await storedSummaries()).map((row) => row.itemId)).toEqual(["b3"]);
  });

  test("a pass with nothing left of the hourly bound is idle, not busy", async () => {
    // Otherwise the loop asks again every BUSY_INTERVAL_MS for the rest of the
    // hour, and each ask is two queries plus a ranking.
    await seedItem("waiting");
    for (const id of ["b1", "b2"]) {
      await seedItem(id);
      await writeEnrichment(handle.sql, {
        itemId: id,
        kind: "summary",
        model: "another-model",
        promptVersion: "summary.v1",
        content: { summary: "counted against this hour" },
      });
    }
    const { chat, asked } = stubChat(answerEachPrompt());

    const result = await service(chat, { ENRICH_MAX_ITEMS_PER_HOUR: "2" }).runPass();

    expect(result).toMatchObject({ items: 0, bounded: true, idle: true });
    expect(asked).toHaveLength(0);
  });

  test("the hourly bound counts calls that failed, so a refused article stops costing", async () => {
    // Counting successes alone makes the bound unbounded in exactly the case
    // it exists for: a model refusing every article writes no rows, and would
    // be called again on every pass for as long as the outage lasts.
    for (const id of ["a", "b", "c"]) await seedItem(id);
    const { chat, asked } = stubChat(
      () => new ChatError("the model would not answer", "permanent"),
    );
    const enrichment = service(chat, { ENRICH_MAX_ITEMS_PER_HOUR: "2" });

    await enrichment.runPass();
    expect(asked).toHaveLength(2);

    asked.length = 0;
    await enrichment.runPass();
    await enrichment.runPass();

    // Two of the hour's three calls are spent, so the third article waits for
    // the next hour rather than being tried now.
    expect(asked).toHaveLength(0);
  });

  test("--force over a bounded budget reaches every item, once each", async () => {
    // Re-picking the newest items on every call would make --since a way to
    // re-run the same two articles until the hour turned over.
    for (const id of ["a", "b", "c", "d", "e"]) {
      await seedItem(id, { hoursAgo: 6 * 24 });
    }
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat, { ENRICH_MAX_ITEMS_PER_HOUR: "2" });
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const run = () => enrichment.runOver({ since, kind: "summary", force: true });

    const results = [await run(), await run(), await run()];

    expect(results.map((result) => result.summarised)).toEqual([2, 2, 1]);
    expect(results.map((result) => result.bounded)).toEqual([true, true, false]);
    expect((await storedSummaries()).map((row) => row.itemId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a rerun reports bounded from what matched, not from what it fetched", async () => {
    for (const id of ["a", "b", "c"]) await seedItem(id, { hoursAgo: 6 * 24 });
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat, { ENRICH_MAX_ITEMS_PER_HOUR: "1" });

    const result = await enrichment.runOver({
      since: new Date(Date.now() - 7 * 24 * 60 * 60_000),
      kind: "summary",
      force: true,
    });

    expect(result.items).toBe(1);
    expect(result.bounded).toBe(true);
  });

  test("a well-matching article older than the newest candidates is still chosen", async () => {
    // Ranking a prefix of the window and then taking the top N would hand the
    // choice to publication date for exactly the articles the score exists to
    // promote.
    for (let index = 0; index < 7; index += 1) {
      await seedItem(`new-${index}`, { hoursAgo: index + 1 });
    }
    await seedItem("the-match", { hoursAgo: 40 });

    const cfg = config({
      EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_BASE_URL: `http://127.0.0.1:${embeddings.port}/v1`,
      EMBEDDING_MODEL: "stub",
    });
    const vectors = createEmbeddingService({ sql: handle.sql, config: cfg });
    await vectors.start();
    await vectors.stop();
    await insertEmbeddings(handle.sql, [
      { itemId: "the-match", vector: "[1,0,0]" },
      ...Array.from({ length: 7 }, (_, index) => ({
        itemId: `new-${index}`,
        vector: "[0,1,0]",
      })),
    ]);
    await writeInterestProfile(handle.sql, {
      userId: DEFAULT_USER_ID,
      clusters: [
        { ordinal: 0, centroid: [1, 0, 0], positiveWeight: 3, skippedWeight: 0, members: 1 },
      ],
    });

    const { chat } = stubChat(answerEachPrompt());
    await service(chat, { ENRICH_TOP_N: "1" }, rankingActive).runPass();

    expect((await storedSummaries()).map((row) => row.itemId)).toEqual(["the-match"]);
  });

  test("--since reaches back past the window a pass looks at", async () => {
    await seedItem("last-week", { hoursAgo: 24 * 6 });
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat);

    expect((await enrichment.runPass()).items).toBe(0);

    const result = await enrichment.runOver({
      since: new Date(Date.now() - 7 * 24 * 60 * 60_000),
      kind: "summary",
      force: true,
    });
    expect(result.items).toBe(1);
    expect((await storedSummaries()).map((row) => row.itemId)).toEqual(["last-week"]);
  });

  test("a rerun without --force leaves an item that already has a row", async () => {
    await seedItem("a", { hoursAgo: 24 * 6 });
    const { chat, asked } = stubChat(answerEachPrompt());
    const enrichment = service(chat);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);

    expect((await enrichment.runOver({ since, kind: "summary", force: true })).summarised).toBe(1);
    expect((await enrichment.runOver({ since, kind: "summary", force: false })).items).toBe(0);
    expect(asked).toHaveLength(1);
  });

  test("a rerun and the background pass do not spend the hour at the same time", async () => {
    // Both count against one allowance, so two running at once overshoot it.
    // Each run is told apart by the articles it asks about: the pass only looks
    // inside its window, the rerun only back to --since.
    await seedItem("in-window-a", { hoursAgo: 1 });
    await seedItem("in-window-b", { hoursAgo: 2 });
    await seedItem("old-a", { hoursAgo: 24 * 6 });
    await seedItem("old-b", { hoursAgo: 24 * 7 });
    const asked: string[] = [];
    const { chat } = stubChat(async (request) => {
      asked.push(request.user.includes("in-window") ? "pass" : "rerun");
      await Bun.sleep(20);
      return '{"summary": "The model said this."}';
    });
    const enrichment = service(chat);

    await Promise.all([
      enrichment.runPass(),
      enrichment.runOver({
        since: new Date(Date.now() - 30 * 24 * 60 * 60_000),
        kind: "summary",
        force: true,
      }),
    ]);

    // One run's calls, then the other's. Interleaved would be two runs
    // spending one allowance at the same time.
    expect(asked).toEqual(["pass", "pass", "rerun", "rerun"]);
  });

  test("a rerun answers 400 rather than running with no chat model", async () => {
    await expect(
      service(null).runOver({ since: new Date(), kind: null, force: false }),
    ).rejects.toThrow(EnrichmentPreconditionError);
  });

  test("a rerun for a kind that is switched off says which switch", async () => {
    // Answering with an empty run would be indistinguishable from there being
    // nothing to enrich.
    await seedItem("a");
    const { chat, asked } = stubChat(answerEachPrompt());

    await expect(
      service(chat, { ENRICH_SUMMARY: "false" }).runOver({
        since: new Date(0),
        kind: "summary",
        force: true,
      }),
    ).rejects.toThrow(/ENRICH_SUMMARY/);
    expect(asked).toHaveLength(0);
  });

  test("a rerun for translations with no target language says so", async () => {
    await expect(
      service(stubChat(answerEachPrompt()).chat).runOver({
        since: new Date(0),
        kind: "translation",
        force: true,
      }),
    ).rejects.toThrow(/ENRICH_TRANSLATE_TO/);
  });

  test("translate writes its own row and leaves the pass's translation alone", async () => {
    await seedItem("a", { title: "The plan" });
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat, { ENRICH_TRANSLATE_TO: "Japanese" });

    await enrichment.runPass();
    const translated = await enrichment.translateBody("a");

    expect(translated).toEqual({
      itemId: "a",
      lang: "Japanese",
      text: "the translated body",
      cached: false,
    });
    const rows = await handle.sql<Array<{ version: string; title: string | null }>>`
      SELECT prompt_version AS version, content->>'title' AS title
      FROM enrichments WHERE kind = 'translation' ORDER BY prompt_version
    `;
    // Two prompts, two rows. Sharing a version would have one overwrite the other.
    expect([...rows]).toEqual([
      { version: "translation-body.v1", title: null },
      { version: "translation.v1", title: "題" },
    ]);
  });

  test("a second translate answers from the store without a call", async () => {
    await seedItem("a");
    const { chat, asked } = stubChat(answerEachPrompt());
    const enrichment = service(chat, { ENRICH_TRANSLATE_TO: "Japanese" });

    await enrichment.translateBody("a");
    asked.length = 0;
    const again = await enrichment.translateBody("a");

    expect(again.cached).toBe(true);
    expect(again.text).toBe("the translated body");
    expect(asked).toHaveLength(0);
  });

  test("translate refuses without a target language rather than guessing one", async () => {
    await seedItem("a");
    const { chat } = stubChat(answerEachPrompt());

    await expect(service(chat).translateBody("a")).rejects.toThrow(/ENRICH_TRANSLATE_TO/);
  });

  test("translate refuses a body too long to send rather than cutting it", async () => {
    // A translation that stops at 8,000 characters reads as a translation, and
    // nobody finds out a third of the article is missing until they have read
    // it in the wrong language.
    await seedItem("long", { text: "x".repeat(8_001) });
    const { chat, asked } = stubChat(answerEachPrompt());

    await expect(
      service(chat, { ENRICH_TRANSLATE_TO: "Japanese" }).translateBody("long"),
    ).rejects.toThrow(/8001 characters, over the 8000 sent per call/);
    expect(asked).toHaveLength(0);
  });

  test("translate answers a whole body under a larger output bound than a summary", async () => {
    // A bound sized for two or three sentences stops a translated article
    // mid-paragraph, which is not a shorter translation but a wrong one.
    await seedItem("a", { text: "x".repeat(8_000) });
    const { chat, asked } = stubChat(answerEachPrompt());

    await service(chat, {
      ENRICH_TRANSLATE_TO: "Japanese",
      CHAT_MAX_OUTPUT_TOKENS: "512",
    }).translateBody("a");

    const body = asked.find((request) => request.system.includes("article bodies"));
    expect(body?.maxOutputTokens).toBe(4096);
  });

  test("stop interrupts a call in flight and records nothing for it", async () => {
    // A daemon shutting down would otherwise wait out the two-minute request
    // deadline, and every article it had started on would be charged a failure
    // it did not earn.
    await seedItem("a");
    let interrupted = false;
    const chat: ChatProvider = {
      id: "openai-compatible",
      model: MODEL,
      complete(_request, signal) {
        // What fetch does on an aborted signal, which is what the abort in
        // stop() has to be able to reach.
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            interrupted = true;
            reject(new Error("The operation was aborted"));
          });
        });
      },
    };
    const enrichment = service(chat);

    const running = enrichment.runPass();
    await Bun.sleep(50);
    await enrichment.stop();
    await running.catch(() => {});

    expect(interrupted).toBe(true);
    expect(await failures()).toEqual([]);
    expect(await storedSummaries()).toEqual([]);
  });

  test("a kind in backoff is not paid for again on an item chosen for another", async () => {
    // Selection only promises the item lacks one of the wanted combinations, so
    // it is picked for its tags while its summary is still waiting out a
    // backoff. Without this the tags pass re-runs the summary that failed.
    await seedItem("a");
    await recordEnrichmentFailure(handle.sql, "a", "summary", "the model would not answer");
    const { chat, asked } = stubChat(answerEachPrompt());

    const result = await service(chat, { ENRICH_TAGS: "true" }).runPass();

    // One call, for the one kind that was owed, and both counts on it.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.system).toContain("tag articles");
    expect(result).toMatchObject({ items: 1, summarised: 0, tagged: 1, failed: 0 });
    expect(await storedSummaries()).toEqual([]);
  });

  test("a starred copy of another outlet's story is enriched anyway", async () => {
    await seedItem("wire", { hoursAgo: 2 });
    await seedItem("copy", { hoursAgo: 1, starred: true });
    await handle.sql`
      INSERT INTO clusters (representative_item_id, size, first_published_at, last_published_at)
      VALUES ('wire', 2, now() - interval '2 hours', now())
    `;
    await handle.sql`
      INSERT INTO item_clusters (item_id, cluster_id)
      SELECT item.id, c.id FROM items item, clusters c
      WHERE c.representative_item_id = 'wire'
    `;

    const { chat } = stubChat(answerEachPrompt());
    await service(chat, { CLUSTERING_ENABLED: "true" }).runPass();

    // The representative filter answers "one story is one call" for the ranked
    // arm. A star names one article, and this one is the article being asked
    // about whichever outlet happened to publish first.
    expect((await storedSummaries()).map((row) => row.itemId).sort()).toEqual(["copy", "wire"]);
  });

  test("prune keeps the current combination and drops every other", async () => {
    await seedItem("a");
    await writeEnrichment(handle.sql, {
      itemId: "a",
      kind: "summary",
      model: MODEL,
      promptVersion: "summary.v1",
      content: { summary: "current" },
    });
    await writeEnrichment(handle.sql, {
      itemId: "a",
      kind: "summary",
      model: "chat-old",
      promptVersion: "summary.v1",
      content: { summary: "from the model before" },
    });
    const { chat } = stubChat(answerEachPrompt());

    expect(await service(chat).prune()).toBe(1);

    const left = await handle.sql<Array<{ model: string; summary: string }>>`
      SELECT model, content->>'summary' AS summary FROM enrichments
    `;
    expect([...left]).toEqual([{ model: MODEL, summary: "current" }]);
  });

  test("prune with no model configured has no current combination to keep", async () => {
    await expect(service(null).prune()).rejects.toThrow(EnrichmentPreconditionError);
  });

  test("tags for review lists only the candidates past the threshold", async () => {
    for (const [slug, observations] of [
      ["rare", 1],
      ["common", 4],
      ["ubiquitous", 9],
    ] as const) {
      await handle.sql`
        INSERT INTO tag_vocabulary (slug, label, status, observations)
        VALUES (${slug}, ${slug}, 'candidate', ${observations})
      `;
    }
    const { chat } = stubChat(answerEachPrompt());

    const review = await service(chat, { TAG_CANDIDATE_PROMOTION_THRESHOLD: "4" }).tagsForReview();

    expect(review.map((tag) => tag.slug)).toEqual(["ubiquitous", "common"]);
  });

  test("approving a candidate makes it a tag, rejecting answers it", async () => {
    await seedItem("a");
    for (const slug of ["wanted", "unwanted"]) {
      await handle.sql`
        INSERT INTO tag_vocabulary (slug, label, status, observations)
        VALUES (${slug}, ${slug}, 'candidate', 7)
      `;
    }
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat);

    expect(await enrichment.setTagStatus("wanted", "approved")).toBe(true);
    expect(await enrichment.setTagStatus("unwanted", "rejected")).toBe(true);
    expect(await enrichment.setTagStatus("never-suggested", "approved")).toBe(false);

    // The next pass is offered only the approved slug, and the two it names
    // that the vocabulary does not hold are suggestions rather than tags.
    const pass = stubChat(
      answerEachPrompt({
        tags: '{"tags": ["wanted", "unwanted", "never-heard-of-it"], "candidates": []}',
      }),
    );
    await service(pass.chat, { ENRICH_TAGS: "true" }).runPass();

    const attached = await handle.sql<Array<{ slug: string }>>`
      SELECT t.slug FROM item_tags it JOIN tag_vocabulary t ON t.id = it.tag_id
    `;
    expect([...attached]).toEqual([{ slug: "wanted" }]);
    const vocabulary = await handle.sql<Array<{ slug: string; status: string }>>`
      SELECT slug, status FROM tag_vocabulary ORDER BY slug
    `;
    expect([...vocabulary]).toEqual([
      { slug: "never-heard-of-it", status: "candidate" },
      { slug: "unwanted", status: "rejected" },
      { slug: "wanted", status: "approved" },
    ]);
  });

  test("the summaries a response carries come from the model when it has one", async () => {
    await seedItem("a", { summary: "The feed said this." });
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat);

    // With no model configured nothing is current, so a response falls back to
    // the feed -- which is what an install without a chat model has.
    expect(await service(null).currentSummaries(["a"])).toEqual(new Map());

    await enrichment.runPass();

    const summaries = await enrichment.currentSummaries(["a", "never-enriched"]);
    expect([...summaries]).toEqual([["a", "The model said this."]]);
  });

  test("what a response carries about an item is its summary, translation and tags", async () => {
    // Writing a translation and a set of tags nothing reads is not enrichment,
    // it is cost.
    await seedItem("a", { title: "The plan", summary: "A feed summary." });
    // Outside the window, so the pass leaves it and it stands for an article no
    // model has been asked about.
    await seedItem("untouched", { summary: "A feed summary.", hoursAgo: 24 * 10 });
    await handle.sql`
      INSERT INTO tag_vocabulary (slug, label, status)
      VALUES ('rust', 'Rust', 'approved')
    `;
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat, { ENRICH_TRANSLATE_TO: "Japanese" });

    await enrichment.runPass();
    await handle.sql`
      INSERT INTO item_tags (item_id, tag_id, source)
      SELECT 'a', id, 'model' FROM tag_vocabulary WHERE slug = 'rust'
    `;

    const carried = await enrichment.currentForItems(["a", "untouched"]);
    expect(carried.get("a")).toEqual({
      summary: "The model said this.",
      summarySource: "model",
      translation: { lang: "Japanese", title: "題", text: "要約" },
      tags: ["rust"],
    });
    // An item no model has touched still answers, saying which of the two
    // summaries is on offer rather than being absent from the map.
    expect(carried.get("untouched")).toEqual({
      summary: null,
      summarySource: "feed",
      translation: null,
      tags: [],
    });
  });

  test("what a response carries is empty of model answers with no model configured", async () => {
    await seedItem("a");
    await handle.sql`
      INSERT INTO tag_vocabulary (slug, label, status)
      VALUES ('rust', 'Rust', 'approved'), ('go', 'Go', 'approved')
    `;
    await handle.sql`
      INSERT INTO item_tags (item_id, tag_id, source)
      SELECT 'a', id, 'manual' FROM tag_vocabulary
    `;

    const carried = await service(null).currentForItems(["a"]);

    // Tags a person attached survive with no chat model configured: they are
    // rows in the store, not something the model has to be switched on for.
    expect(carried.get("a")).toEqual({
      summary: null,
      summarySource: "feed",
      translation: null,
      tags: ["go", "rust"],
    });
  });

  test("status reports what this build would record", async () => {
    await seedItem("a");
    const { chat } = stubChat(answerEachPrompt());
    const enrichment = service(chat, { ENRICH_TAGS: "true", ENRICH_TRANSLATE_TO: "Japanese" });
    await enrichment.runPass();

    const status = await enrichment.status();

    expect(status.enabled).toBe(true);
    expect(status.provider).toBe("openai-compatible");
    expect(status.model).toBe(MODEL);
    expect(status.promptVersions).toEqual({
      summary: "summary.v1",
      tags: "tags.v1",
      translation: "translation.v1",
      bodyTranslation: "translation-body.v1",
    });
    expect(status.counts).toEqual({
      summarised: 1,
      tagged: 1,
      translated: 1,
      failed: 0,
    });
    // Nothing has gone wrong yet, so there is nothing to report.
    expect(status.lastError).toBeNull();
  });

  test("one article re-run five times leaves a tag with one observation", async () => {
    await seedItem("a");
    const chat = stubChat(
      answerEachPrompt({ tags: '{"tags": [], "candidates": ["compilers"]}' }),
    ).chat;
    const enrichment = service(chat, { ENRICH_TAGS: "true" });
    const since = new Date(Date.now() - 24 * 60 * 60_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await enrichment.runOver({ since, kind: "tags", force: true });
    }

    // The threshold is about how many articles a tag has come up for, so five
    // runs over one of them must not be enough to reach a decision about it.
    const review = await enrichment.tagsForReview();
    expect(review).toEqual([]);
    const [candidate] = await handle.sql<Array<{ observations: number }>>`
      SELECT observations FROM tag_vocabulary WHERE slug = 'compilers'
    `;
    expect(candidate?.observations).toBe(1);
  });

  test("three articles that named a tag give it three observations", async () => {
    for (const id of ["a", "b", "c"]) await seedItem(id);
    const chat = stubChat(
      answerEachPrompt({ tags: '{"tags": [], "candidates": ["compilers"]}' }),
    ).chat;
    const enrichment = service(chat, { ENRICH_TAGS: "true" });

    await enrichment.runPass();

    const [candidate] = await handle.sql<Array<{ observations: number }>>`
      SELECT observations FROM tag_vocabulary WHERE slug = 'compilers'
    `;
    expect(candidate?.observations).toBe(3);
  });
});
