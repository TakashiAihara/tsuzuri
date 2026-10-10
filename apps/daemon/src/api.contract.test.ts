import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  embeddingStatusSchema,
  enrichPruneResponseSchema,
  enrichRunSchema,
  errorResponseSchema,
  importOpmlResponseSchema,
  ingestRunResponseSchema,
  interestStatusSchema,
  itemResponseSchema,
  itemStateResponseSchema,
  itemsResponseSchema,
  llmStatusSchema,
  rankedItemsResponseSchema,
  searchResponseSchema,
  sourcesResponseSchema,
  tagStatusResponseSchema,
  tagsResponseSchema,
  translateResponseSchema,
} from "@tsuzuri/api";
import { ChatError, type ChatProvider, type ChatRequest } from "@tsuzuri/core";
import { createDatabase, DEFAULT_USER_ID, migrate } from "@tsuzuri/db";
import type { z } from "zod";

import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createClusteringService } from "./enrich/clustering.ts";
import { createEmbeddingService } from "./enrich/embeddings.ts";
import { createEnrichmentService } from "./enrich/enrichment.ts";
import { createInterestService } from "./enrich/interest.ts";

/**
 * The daemon's real responses, parsed through the shared contract.
 *
 * This is what stops @tsuzuri/api from becoming a third declaration that drifts
 * alongside the two it replaced. Shared types on their own would not: the CLI
 * and the MCP server would compile against them happily while a handler
 * returned something else. Here the handler runs, and its actual output has to
 * satisfy the schema clients were written against.
 *
 * Strict parsing throughout. Zod's object() strips unknown keys and succeeds, so
 * with it the test would catch a field that disappeared and miss one that
 * appeared -- including a listing that started carrying article bodies, which
 * is the one thing the MCP surface promises not to do. strictObject catches
 * both directions.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

/**
 * A chat model that answers every prompt the same way.
 *
 * The endpoints have to be exercised against a running daemon rather than a
 * mocked service, and the pass is what a configured install actually does on
 * its first request -- so the endpoints are driven by one that is switched on.
 */
const chat: ChatProvider = {
  id: "openai-compatible",
  model: "contract-stub",
  async complete(request: ChatRequest) {
    if (request.system.includes("summarise articles")) {
      return '{"summary": "The model said this."}';
    }
    if (request.system.includes("tag articles")) {
      return '{"tags": ["databases"], "candidates": ["query planners"]}';
    }
    if (request.system.includes("article bodies")) {
      return '{"text": "the body, translated"}';
    }
    return '{"title": "題", "text": "要約"}';
  },
};

describeIfDb("api contract", () => {
  let handle: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof createApi>;
  /**
   * The rest of the daemon, kept for a second API instance.
   *
   * A refusal is not reachable through the chat provider the suite runs on --
   * it answers everything -- so the handler that reports one is built here over
   * a service whose model says no.
   */
  let deps: Omit<Parameters<typeof createApi>[0], "enrichment">;

  const ITEM_ID = `c0ffee11${"2".repeat(56)}`;
  // Two ids sharing a prefix, so the ambiguity path is actually reachable.
  const TWIN_A = `decafbad${"0".repeat(56)}`;
  const TWIN_B = `decafbad${"1".repeat(56)}`;

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);

    await handle.sql`
      INSERT INTO sources (id, user_id, kind, url, title)
      VALUES ('11111111-1111-1111-1111-111111111111', ${DEFAULT_USER_ID}, 'feed',
              'https://a.example/feed', 'A')
    `;
    await handle.sql`
      INSERT INTO items (id, url, canonical_url, title, published_at, search_text, content_html)
      VALUES (${ITEM_ID}, 'https://e.com/a', 'https://e.com/a', 'Rust 1.90 released',
              now(), 'Rust 1.90 released. The borrow checker changed.', '<p>body</p>')
    `;
    await handle.sql`
      INSERT INTO item_sources (item_id, source_id)
      VALUES (${ITEM_ID}, '11111111-1111-1111-1111-111111111111')
    `;
    for (const id of [TWIN_A, TWIN_B]) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (${id}, ${`https://e.com/${id}`}, ${`https://e.com/${id}`}, 'twin', now(), 'twin')
      `;
    }

    const config = loadConfig({
      DATABASE_URL: DATABASE_URL as string,
      ENRICH_TRANSLATE_TO: "Japanese",
    });
    const embeddings = createEmbeddingService({ sql: handle.sql, config });
    await embeddings.start();
    const interest = createInterestService({ sql: handle.sql, config, embeddings });
    await interest.start();
    const clustering = createClusteringService({ sql: handle.sql, config, embeddings });
    const enrichment = createEnrichmentService({
      sql: handle.sql,
      config,
      interest,
      provider: chat,
    });
    deps = {
      db: handle.db,
      sql: handle.sql,
      fetcher: fetch,
      config,
      embeddings,
      interest,
      clustering,
    };
    app = createApi({ ...deps, enrichment });
  });

  /** An API over a model that refuses everything with the given status. */
  function refusingApp(): ReturnType<typeof createApi> {
    return createApi({
      ...deps,
      enrichment: createEnrichmentService({
        sql: handle.sql,
        config: deps.config,
        interest: deps.interest,
        provider: {
          id: "openai-compatible",
          model: "contract-stub",
          complete: () =>
            Promise.reject(new ChatError("chat request failed (401)", "configuration")),
        },
      }),
    });
  }

  afterAll(async () => {
    await handle?.close();
  });

  async function parsed<T extends z.ZodTypeAny>(
    schema: T,
    path: string,
    init?: RequestInit,
  ): Promise<z.infer<T>> {
    const response = await app.fetch(new Request(`http://test${path}`, init));
    const body: unknown = await response.json();
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new Error(
        `${path} did not match its contract:\n${JSON.stringify(result.error.issues, null, 2)}\n` +
          `body was:\n${JSON.stringify(body, null, 2)}`,
      );
    }
    return result.data;
  }

  test("GET /sources", async () => {
    const body = await parsed(sourcesResponseSchema, "/sources");
    expect(body.sources).toHaveLength(1);
  });

  test("GET /items", async () => {
    const body = await parsed(itemsResponseSchema, "/items?unread=false");
    // Only the item with a subscription; the twins exist to make a prefix
    // ambiguous and are not attached to one.
    expect(body.items).toHaveLength(1);
    // Nothing has been enriched yet, so the summary on offer is the feed's.
    expect(body.items[0]?.summarySource).toBe("feed");
  });

  test("GET /items/:id", async () => {
    const body = await parsed(itemResponseSchema, `/items/${ITEM_ID}`);
    expect(body.item.id).toBe(ITEM_ID);
  });

  test("POST /items/:id/state", async () => {
    const body = await parsed(itemStateResponseSchema, `/items/${ITEM_ID}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    expect(body.state.readAt).not.toBeNull();
  });

  test("GET /search", async () => {
    const body = await parsed(searchResponseSchema, "/search?q=Rust");
    expect(body.mode).toBe("text-only");
    expect(body.results[0]?.id).toBe(ITEM_ID);
  });

  test("GET /items?sort=score", async () => {
    // The degraded shape is the one every install sees until scoring is turned
    // on, so it is the one the contract has to hold.
    const body = await parsed(rankedItemsResponseSchema, "/items?sort=score&unread=false");
    expect(body.scoring.active).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.exploration).toBe(false);
    expect(body.items[0]?.summarySource).toBe("feed");
  });

  test("POST /enrich", async () => {
    const body = await parsed(enrichRunSchema, "/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "7d" }),
    });
    expect(body.items).toBe(1);
    expect(body.summarised).toBe(1);
    expect(body.bounded).toBe(false);
  });

  test("POST /enrich takes force as the boolean a client sends", async () => {
    // z.stringbool() reads "true" from a query string and rejects the boolean
    // every JSON client sends, so `--force` was a 400 for the CLI. Both forms
    // have to reach the handler; the string form is refused, in the table below.
    for (const id of [TWIN_A, TWIN_B]) {
      await handle.sql`
        INSERT INTO item_sources (item_id, source_id)
        VALUES (${id}, '11111111-1111-1111-1111-111111111111')
      `;
    }
    const answered = await parsed(enrichRunSchema, "/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "7d", force: false }),
    });
    expect(answered.summarised).toBe(2);

    // The article under test was answered by the pass above, so these two calls
    // differ in nothing but the flag.
    const withoutForce = await parsed(enrichRunSchema, "/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "7d", force: false }),
    });
    expect(withoutForce.items).toBe(0);
    expect(withoutForce.forceBefore).toBeNull();

    const withForce = await parsed(enrichRunSchema, "/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "7d", force: true }),
    });
    // All three were answered above, and a forced rerun asks about every one of
    // them again -- which is the only thing the flag is for. It also answers
    // with the cutoff to continue from.
    expect(withForce.items).toBe(3);
    expect(withForce.summarised).toBe(3);
    expect(withForce.error).toBeNull();
    expect(withForce.forceBefore).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("POST /enrich continues a forced rerun from the cutoff it was given", async () => {
    const cutoff = new Date().toISOString();

    const body = await parsed(enrichRunSchema, "/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "7d", force: true, forceBefore: cutoff }),
    });

    // Every summary here was written before the cutoff, so each article in the
    // period counts as unanswered and is asked again.
    expect(body.summarised).toBe(3);
    expect(body.forceBefore).toBe(cutoff);
  });

  test("POST /enrich refuses a cutoff in the future", async () => {
    const response = await app.fetch(
      new Request("http://test/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          since: "7d",
          force: true,
          forceBefore: new Date(Date.now() + 60_000).toISOString(),
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("POST /enrich answers 200 with the counts when a refusal ends a rerun", async () => {
    // The articles before the refusal were written. Answering 500 would say
    // nothing was enriched and that the whole period has to be run again.
    const response = await refusingApp().fetch(
      new Request("http://test/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ since: "7d", force: true }),
      }),
    );

    expect(response.status).toBe(200);
    const body = enrichRunSchema.parse(await response.json());
    expect(body.error).toMatch(/401/);
    expect(body.summarised).toBe(0);
    expect(body.forceBefore).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("GET /items/:id carries what the model said about the article", async () => {
    // A summary, a translation and tags that nothing reads is not enrichment,
    // it is cost, so they come back with the article.
    const body = await parsed(itemResponseSchema, `/items/${ITEM_ID}`);

    expect(body.item.id).toBe(ITEM_ID);
    expect(body.enrichment?.summary).toBe("The model said this.");
    expect(body.enrichment?.summarySource).toBe("model");
    expect(body.enrichment?.translation).toEqual({
      lang: "Japanese",
      title: "題",
      text: "要約",
    });
  });

  test("a listing carries the model's summary, and says where it came from", async () => {
    // The reason summarySource exists: without it a response cannot answer
    // whether enrichment is doing anything (D35).
    const body = await parsed(itemsResponseSchema, "/items?unread=false");
    expect(body.items[0]?.summary).toBe("The model said this.");
    expect(body.items[0]?.summarySource).toBe("model");

    const search = await parsed(searchResponseSchema, "/search?q=Rust");
    expect(search.results[0]?.summarySource).toBe("model");
  });

  test("GET /tags", async () => {
    // The pass suggested two tags the vocabulary does not hold, and
    // TAG_CANDIDATE_PROMOTION_THRESHOLD is 5: one observation is not yet
    // anybody's problem.
    const body = await parsed(tagsResponseSchema, "/tags");
    expect(body.tags).toEqual([]);
  });

  test("POST /tags/:slug/approve", async () => {
    const body = await parsed(tagStatusResponseSchema, "/tags/databases/approve", {
      method: "POST",
    });
    expect(body.tag).toEqual({ slug: "databases", status: "approved" });

    const rejected = await parsed(tagStatusResponseSchema, "/tags/query-planners/reject", {
      method: "POST",
    });
    expect(rejected.tag.status).toBe("rejected");

    // Neither is waiting for a decision any more: an approved tag is not a
    // candidate for anything, and a rejected one has been answered.
    const review = await parsed(tagsResponseSchema, "/tags");
    expect(review.tags).toEqual([]);
  });

  test("POST /items/:id/translate", async () => {
    const body = await parsed(translateResponseSchema, `/items/${ITEM_ID}/translate`, {
      method: "POST",
    });
    expect(body).toEqual({
      itemId: ITEM_ID,
      lang: "Japanese",
      text: "the body, translated",
      cached: false,
    });

    const again = await parsed(translateResponseSchema, `/items/${ITEM_ID}/translate`, {
      method: "POST",
    });
    expect(again.cached).toBe(true);
  });

  test("POST /enrich/prune", async () => {
    // A prompt version this build does not run, written by hand: what --force
    // replays against, and what a prune is for.
    await handle.sql`
      INSERT INTO enrichments (item_id, kind, model, prompt_version, content)
      VALUES (${ITEM_ID}, 'summary', 'contract-stub', 'summary.v0', '{"summary":"old prompt"}'::jsonb)
    `;

    // No body, and no way to send one: the endpoint always keeps the current
    // combinations, because the alternative is a request that deletes every
    // answer this installation has.
    const body = await parsed(enrichPruneResponseSchema, "/enrich/prune", { method: "POST" });
    expect(body.pruned).toBe(1);
  });

  test("GET /doctor reports the last error a pass refused to charge to an item", async () => {
    // A configuration error is true of every item equally, so nothing in the
    // store records it and this field is the only thing that says why an
    // install with a working model has stopped summarising. Asserted non-null:
    // a field hard-coded to null would pass a test that only ever saw null.
    const refusing = refusingApp();
    await refusing.fetch(
      new Request("http://test/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ since: "7d", force: true }),
      }),
    );

    const response = await refusing.fetch(new Request("http://test/doctor"));
    const body = (await response.json()) as { features: { llm: unknown } };
    const llm = llmStatusSchema.parse(body.features.llm);

    expect(llm.lastError?.message).toMatch(/401/);
    expect(llm.lastError?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // And the daemon this suite runs on has refused nothing, so its field is
    // the other shape: a message that only ever appears is a message nobody
    // believes is absent.
    const healthy = await app.fetch(new Request("http://test/doctor"));
    const healthyBody = (await healthy.json()) as { features: { llm: unknown } };
    expect(llmStatusSchema.parse(healthyBody.features.llm).lastError).toBeNull();
  });

  test("GET /doctor reports what enrichment is configured with", async () => {
    const response = await app.fetch(new Request("http://test/doctor"));
    const body = (await response.json()) as { features: { llm: unknown } };
    const llm = llmStatusSchema.parse(body.features.llm);

    expect(llm.enabled).toBe(true);
    expect(llm.provider).toBe("openai-compatible");
    expect(llm.model).toBe("contract-stub");
    expect(llm.promptVersions.summary).toBe("summary.v1");
    // Three articles have been through the pass by now: the one under test and
    // the two twins the force test attached to a subscription.
    expect(llm.counts.summarised).toBe(3);
  });

  test("GET /interest/status", async () => {
    const body = await parsed(interestStatusSchema, "/interest/status");
    expect(body.enabled).toBe(false);
  });

  test("GET /embeddings/status", async () => {
    const body = await parsed(embeddingStatusSchema, "/embeddings/status");
    expect(body.state).toBe("disabled");
  });

  test("POST /ingest/run", async () => {
    // Nothing is due, so this polls nothing and still has to answer in shape.
    await parsed(ingestRunResponseSchema, "/ingest/run", { method: "POST" });
  });

  test("POST /sources/import-opml", async () => {
    await parsed(importOpmlResponseSchema, "/sources/import-opml", {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: "<opml><body></body></opml>",
    });
  });

  describe("errors", () => {
    // Clients branch on these as much as on success bodies.
    const cases: { name: string; path: string; status: number; init?: RequestInit }[] = [
      { name: "unknown item", path: "/items/ffffffffffffffff", status: 404 },
      // "abc" used to stand in for this and reached the too-short branch
      // instead, so the ambiguity handler was never exercised. The expected
      // status is asserted for the same reason: "not ok" would have passed.
      { name: "ambiguous id", path: "/items/decafbad", status: 400 },
      { name: "id prefix too short", path: "/items/abc", status: 400 },
      { name: "missing query", path: "/search", status: 400 },
      { name: "unreadable since", path: "/search?q=x&since=whenever", status: 400 },
      // A rerun with no period would be the whole corpus in one request.
      { name: "enrich without a period", path: "/enrich", status: 400, init: { method: "POST" } },
      // --force is a boolean in the body, because that is what every client
      // sends. Read as a string it would be a 400 on `{"force": true}`, which
      // is what the CLI sends.
      {
        name: "force as the string a query would carry",
        path: "/enrich",
        status: 400,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ since: "7d", force: "true" }),
        },
      },
      {
        name: "approve a tag nobody suggested",
        path: "/tags/never-suggested/approve",
        status: 404,
        init: { method: "POST" },
      },
      {
        name: "reject a tag nobody suggested",
        path: "/tags/never-suggested/reject",
        status: 404,
        init: { method: "POST" },
      },
      {
        name: "refused subscription",
        path: "/sources",
        status: 400,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1/feed" }),
        },
      },
    ];

    for (const { name, path, status, init } of cases) {
      test(name, async () => {
        const response = await app.fetch(new Request(`http://test${path}`, init));
        expect(response.status).toBe(status);
        expect(errorResponseSchema.safeParse(await response.json()).success).toBe(true);
      });
    }
  });
});
