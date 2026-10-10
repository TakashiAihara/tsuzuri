import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ChatError, type ChatProvider, type ChatRequest } from "@tsuzuri/core";
import {
  createDatabase,
  DEFAULT_USER_ID,
  insertEmbeddings,
  interestClustersExists,
  migrate,
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
function stubChat(answer: (request: ChatRequest) => Answer) {
  const asked: ChatRequest[] = [];
  const chat: ChatProvider = {
    id: "openai-compatible",
    model: MODEL,
    async complete(request) {
      asked.push(request);
      const next = answer(request);
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
    const { chat } = stubChat(() => new ChatError("chat request failed (503)", true));

    await expect(service(chat).runPass()).rejects.toThrow(/503/);
    expect(await failures()).toEqual([]);
  });

  test("a permanent refusal is recorded, and the item waits its turn", async () => {
    await seedItem("a");
    const { chat } = stubChat(() => new ChatError("chat request failed (400)", false));

    const result = await service(chat).runPass();

    expect(result.failed).toBe(1);
    expect(result.summarised).toBe(0);
    expect(await failures()).toEqual([{ itemId: "a", kind: "summary" }]);
    // And the next pass leaves it alone rather than paying for it again now.
    await service(chat).runPass();
    expect(await failures()).toEqual([{ itemId: "a", kind: "summary" }]);
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
        ? new ChatError("chat request failed (400)", false)
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

    expect(await service(chat).prune({ keepCurrent: true })).toBe(1);

    const left = await handle.sql<Array<{ model: string; summary: string }>>`
      SELECT model, content->>'summary' AS summary FROM enrichments
    `;
    expect([...left]).toEqual([{ model: MODEL, summary: "current" }]);
  });

  test("prune with no model configured has no current combination to keep", async () => {
    await expect(service(null).prune({ keepCurrent: true })).rejects.toThrow(
      EnrichmentPreconditionError,
    );
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
  });
});
