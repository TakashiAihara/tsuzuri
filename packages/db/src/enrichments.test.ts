import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type postgres from "postgres";

import { createDatabase } from "./client.ts";
import {
  approvedTags,
  attachTags,
  clearEnrichmentFailure,
  currentEnrichments,
  type EnrichmentTarget,
  enrichmentCallsSince,
  enrichmentCandidates,
  enrichmentCounts,
  enrichmentInputs,
  inBackoff,
  pruneEnrichments,
  recordEnrichmentFailure,
  setTagStatus,
  suggestTag,
  tagsForReview,
  tagsOfItems,
  writeEnrichment,
} from "./enrichments.ts";
import { migrate } from "./migrate.ts";
import { DEFAULT_USER_ID, enrichments, itemTags, tagVocabulary } from "./schema.ts";

/**
 * The enrichments key is the whole of the replay story -- a prompt change has
 * to write beside the previous answer rather than over it -- so these tests run
 * against a real PostgreSQL and assert on the rows that survive rather than on
 * what the writer was handed.
 *
 * Skipped when TSUZURI_TEST_DATABASE_URL is unset, like the rest of the
 * database suite.
 */
const DATABASE_URL = process.env.TSUZURI_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const MODEL = "chat-large";
const PROMPT_VERSION = "summary.v1";
const TAGS_VERSION = "tags.v1";

/** The combination a failure in these tests belongs to: the model and versions selection asks about. */
function target(kind: "summary" | "tags"): EnrichmentTarget {
  return { kind, model: MODEL, promptVersion: kind === "tags" ? TAGS_VERSION : PROMPT_VERSION };
}

/**
 * postgres.js hands back a result carrying the driver's own metadata alongside
 * the rows, which a matcher will not accept as a value. Taking the rows off it
 * here lets each assertion below read as the array it is comparing.
 */
async function rows<Row extends object>(pending: postgres.PendingQuery<Row[]>): Promise<Row[]> {
  return [...(await pending)];
}

/** The driver hands back timestamptz in whichever shape it has been configured for. */
function at(value: unknown): Date {
  return new Date(value as string);
}

async function tagIds(handle: ReturnType<typeof createDatabase>): Promise<Map<string, string>> {
  const stored = await rows<{ id: string; slug: string }>(handle.sql`
    SELECT id, slug FROM tag_vocabulary ORDER BY slug
  `);
  return new Map(stored.map((row) => [row.slug, row.id]));
}

describeIfDb("enrichments", () => {
  let handle: ReturnType<typeof createDatabase>;

  async function seedItems(ids: readonly string[]) {
    for (const id of ids) {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES (
          ${id},
          ${`https://example.com/${id}`},
          ${`https://example.com/${id}`},
          ${`Article ${id}`},
          ${"2026-10-01T00:00:00Z"},
          ${`body of ${id}`}
        )
      `;
    }
  }

  beforeAll(async () => {
    handle = createDatabase({ url: DATABASE_URL as string, max: 4 });
    await handle.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(handle.sql);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.sql`TRUNCATE items, enrichments, enrichment_failures, item_tags, tag_vocabulary CASCADE`;
  });

  describe("the enrichments key", () => {
    test("stores an enrichment and reads back the content it was given", async () => {
      type Stored = {
        kind: string;
        lang: string;
        model: string;
        version: string;
        content: unknown;
      };

      await seedItems(["a"]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "A thing happened, and it matters." },
      });

      const stored = await rows<Stored>(handle.sql`
        SELECT kind, lang, model, prompt_version AS version, content
        FROM enrichments WHERE item_id = 'a'
      `);
      expect(stored).toEqual([
        {
          kind: "summary",
          lang: "",
          model: MODEL,
          version: PROMPT_VERSION,
          content: { summary: "A thing happened, and it matters." },
        },
      ]);
    });

    test("a rerun of the same prompt replaces the content instead of adding a row", async () => {
      await seedItems(["a"]);
      const write = (summary: string) =>
        writeEnrichment(handle.sql, {
          itemId: "a",
          kind: "summary",
          model: MODEL,
          promptVersion: PROMPT_VERSION,
          content: { summary },
        });

      await write("first attempt");
      await write("second attempt");

      const current = await currentEnrichments(handle.sql, ["a"], {
        model: MODEL,
        promptVersion: PROMPT_VERSION,
      });
      expect(current).toHaveLength(1);
      expect(current[0]?.content).toEqual({ summary: "second attempt" });
    });

    test("a prompt change writes beside the previous answer rather than over it", async () => {
      // The issue's completion criterion is a property of the key: both answers
      // have to survive so the two prompts can be compared on one article.
      await seedItems(["a"]);
      for (const [promptVersion, summary] of [
        ["summary.v1", "written by the first prompt"],
        ["summary.v2", "written by the second prompt"],
      ] as const) {
        await writeEnrichment(handle.sql, {
          itemId: "a",
          kind: "summary",
          model: MODEL,
          promptVersion,
          content: { summary },
        });
      }

      const stored = await rows<{ prompt_version: string }>(handle.sql`
        SELECT prompt_version FROM enrichments WHERE item_id = 'a' ORDER BY prompt_version
      `);
      expect(stored).toEqual([{ prompt_version: "summary.v1" }, { prompt_version: "summary.v2" }]);

      const current = await currentEnrichments(handle.sql, ["a"], {
        model: MODEL,
        promptVersion: "summary.v2",
      });
      expect(current).toHaveLength(1);
      expect(current[0]?.content).toEqual({ summary: "written by the second prompt" });
    });

    test("two languages of one kind are different rows rather than a collision", async () => {
      await seedItems(["a"]);
      for (const lang of ["ja", "fr"]) {
        await writeEnrichment(handle.sql, {
          itemId: "a",
          kind: "translation",
          lang,
          model: MODEL,
          promptVersion: "translation.v1",
          content: { title: `title in ${lang}`, text: `body in ${lang}` },
        });
      }

      const japanese = await currentEnrichments(handle.sql, ["a"], {
        kind: "translation",
        model: MODEL,
        promptVersion: "translation.v1",
        lang: "ja",
      });
      expect(japanese).toHaveLength(1);
      expect(japanese[0]?.content).toEqual({ title: "title in ja", text: "body in ja" });
    });

    test("the current enrichment is the configured model's, not the newest written", async () => {
      // A newer answer from another model is not an update to this
      // installation's configuration. Showing it would make a model switch look
      // like the summaries had been rewritten by it.
      await seedItems(["a"]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: "chat-old",
        promptVersion: PROMPT_VERSION,
        content: { summary: "from the old model" },
      });
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: "chat-new",
        promptVersion: PROMPT_VERSION,
        content: { summary: "from the new model" },
      });

      const current = await currentEnrichments(handle.sql, ["a"], {
        model: "chat-old",
        promptVersion: PROMPT_VERSION,
      });
      expect(current).toHaveLength(1);
      expect(current[0]?.content).toEqual({ summary: "from the old model" });
    });

    test("asks for one kind and gets only that kind back", async () => {
      await seedItems(["a"]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "a summary" },
      });
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "tags",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { tags: ["databases"], candidates: [] },
      });

      const tags = await currentEnrichments(handle.sql, ["a"], {
        kind: "tags",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
      });
      expect(tags.map((row) => row.content)).toEqual([{ tags: ["databases"], candidates: [] }]);

      // Nothing else was asked for, so the item's summary is not an answer to
      // a question about its tags.
      const summaries = await currentEnrichments(handle.sql, ["a"], {
        kind: "translation",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
      });
      expect(summaries).toEqual([]);
    });

    test("asks about no items and queries nothing", async () => {
      await seedItems(["a"]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "a summary" },
      });

      const none = await currentEnrichments(handle.sql, [], {
        model: MODEL,
        promptVersion: PROMPT_VERSION,
      });
      expect(none).toEqual([]);
    });

    test("reports when an enrichment was written as ISO 8601", async () => {
      await seedItems(["a"]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "a summary" },
      });

      const [row] = await currentEnrichments(handle.sql, ["a"], {
        model: MODEL,
        promptVersion: PROMPT_VERSION,
      });
      expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test("deleting an item takes its enrichments with it", async () => {
      await seedItems(["a"]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "a summary" },
      });

      await handle.sql`DELETE FROM items WHERE id = 'a'`;
      const left = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM enrichments
      `);
      expect(left).toEqual([{ count: 0 }]);
    });
  });

  describe("pruning", () => {
    test("deletes every combination it was not told to keep", async () => {
      await seedItems(["a"]);
      for (const [model, promptVersion] of [
        [MODEL, "summary.v1"],
        [MODEL, "summary.v2"],
        ["chat-other", "summary.v1"],
      ] as const) {
        await writeEnrichment(handle.sql, {
          itemId: "a",
          kind: "summary",
          model,
          promptVersion,
          content: { summary: `${model} ${promptVersion}` },
        });
      }

      const pruned = await pruneEnrichments(handle.sql, [
        { model: MODEL, promptVersion: "summary.v2" },
      ]);
      expect(pruned).toBe(2);

      const left = await rows<{ model: string; prompt_version: string }>(handle.sql`
        SELECT model, prompt_version FROM enrichments ORDER BY model, prompt_version
      `);
      expect(left).toEqual([{ model: MODEL, prompt_version: "summary.v2" }]);
    });

    test("keeps every combination it was given, across items", async () => {
      await seedItems(["a", "b"]);
      for (const itemId of ["a", "b"]) {
        await writeEnrichment(handle.sql, {
          itemId,
          kind: "summary",
          model: MODEL,
          promptVersion: PROMPT_VERSION,
          content: { summary: `a summary for ${itemId}` },
        });
      }

      expect(
        await pruneEnrichments(handle.sql, [
          { model: MODEL, promptVersion: "summary.v1" },
          { model: MODEL, promptVersion: "summary.v2" },
        ]),
      ).toBe(0);
      const left = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM enrichments
      `);
      expect(left).toEqual([{ count: 2 }]);
    });

    test("naming nothing keeps nothing, and says how many went", async () => {
      await seedItems(["a", "b"]);
      for (const itemId of ["a", "b"]) {
        await writeEnrichment(handle.sql, {
          itemId,
          kind: "summary",
          model: MODEL,
          promptVersion: PROMPT_VERSION,
          content: { summary: `a summary for ${itemId}` },
        });
      }

      expect(await pruneEnrichments(handle.sql, [])).toBe(2);
      const left = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM enrichments
      `);
      expect(left).toEqual([{ count: 0 }]);
    });
  });

  describe("failures", () => {
    const at9am = new Date("2026-10-05T09:00:00Z");

    test("the first failure waits a minute and the second waits twice as long", async () => {
      type Failure = { failures: number; error: string | null; next: unknown };

      await seedItems(["a"]);
      await recordEnrichmentFailure(handle.sql, "a", target("summary"), "the model refused", at9am);

      const [first] = await rows<Failure>(handle.sql`
        SELECT failures, last_error AS error, next_attempt_at AS next
        FROM enrichment_failures WHERE item_id = 'a' AND kind = 'summary'
      `);
      expect(first?.failures).toBe(1);
      expect(first?.error).toBe("the model refused");
      expect(at(first?.next).toISOString()).toBe("2026-10-05T09:01:00.000Z");

      await recordEnrichmentFailure(handle.sql, "a", target("summary"), "still refusing", at9am);

      const [second] = await rows<Failure>(handle.sql`
        SELECT failures, last_error AS error, next_attempt_at AS next
        FROM enrichment_failures WHERE item_id = 'a' AND kind = 'summary'
      `);
      expect(second?.failures).toBe(2);
      expect(second?.error).toBe("still refusing");
      expect(at(second?.next).toISOString()).toBe("2026-10-05T09:02:00.000Z");
    });

    test("stops doubling at a day, so a broken item is eventually retried", async () => {
      await seedItems(["b"]);

      for (let attempt = 0; attempt < 12; attempt += 1) {
        await recordEnrichmentFailure(handle.sql, "b", target("summary"), "refused", at9am);
      }

      const [row] = await rows<{ failures: number; next: unknown }>(handle.sql`
        SELECT failures, next_attempt_at AS next FROM enrichment_failures WHERE item_id = 'b'
      `);
      expect(row?.failures).toBe(12);
      // The twelfth doubling would be 60 * 2^11 seconds; the cap is what lands.
      expect(at(row?.next).toISOString()).toBe("2026-10-06T09:00:00.000Z");
    });

    test("one kind failing does not hold back the item's other kinds", async () => {
      await seedItems(["c"]);
      await recordEnrichmentFailure(handle.sql, "c", target("summary"), "refused", at9am);

      const [row] = await rows<{ kind: string }>(handle.sql`
        SELECT kind FROM enrichment_failures WHERE item_id = 'c' AND kind = 'tags'
      `);
      expect(row).toBeUndefined();
    });

    test("clearing a failure removes the backoff it was holding the item behind", async () => {
      await seedItems(["d"]);
      await recordEnrichmentFailure(handle.sql, "d", target("summary"), "refused", at9am);
      await clearEnrichmentFailure(handle.sql, "d", target("summary"));

      const left = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM enrichment_failures
      `);
      expect(left).toEqual([{ count: 0 }]);
    });

    test("clearing one kind leaves the other's backoff standing", async () => {
      await seedItems(["e"]);
      await recordEnrichmentFailure(handle.sql, "e", target("summary"), "refused", at9am);
      await recordEnrichmentFailure(handle.sql, "e", target("tags"), "refused", at9am);
      await clearEnrichmentFailure(handle.sql, "e", target("summary"));

      const left = await rows<{ kind: string }>(handle.sql`
        SELECT kind FROM enrichment_failures WHERE item_id = 'e'
      `);
      expect(left).toEqual([{ kind: "tags" }]);
    });
  });

  describe("the tag vocabulary", () => {
    /**
     * One stored `tags` enrichment, which is what an observation is counted
     * from. Written through writeEnrichment so the count and the row the
     * daemon would have written are the same thing.
     */
    async function suggestedBy(...itemIds: string[]) {
      for (const itemId of itemIds) {
        await writeEnrichment(handle.sql, {
          itemId,
          kind: "tags",
          model: MODEL,
          promptVersion: "tags.v1",
          content: { tags: [], candidates: ["query-planners"] },
        });
      }
    }

    /** Store the enrichment a given set of articles would have produced. */
    async function namedBy(itemId: string, slugs: string[]) {
      await writeEnrichment(handle.sql, {
        itemId,
        kind: "tags",
        model: MODEL,
        promptVersion: "tags.v1",
        content: { tags: [], candidates: slugs },
      });
      for (const slug of slugs) await suggestTag(handle.sql, slug, slug, MODEL, TAGS_VERSION);
    }

    beforeEach(async () => {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, published_at, search_text)
        VALUES ('a', 'https://example.com/a', 'https://example.com/a', '2026-10-01', 'body a'),
               ('b', 'https://example.com/b', 'https://example.com/b', '2026-10-01', 'body b'),
               ('c', 'https://example.com/c', 'https://example.com/c', '2026-10-01', 'body c')
      `;
    });

    test("a suggested tag starts as a candidate with one observation", async () => {
      type Candidate = { slug: string; label: string; status: string; observations: number };

      await suggestedBy("a");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);

      const [row] = await rows<Candidate>(handle.sql`
        SELECT slug, label, status, observations FROM tag_vocabulary
      `);
      expect(row).toEqual({
        slug: "query-planners",
        label: "Query planners",
        status: "candidate",
        observations: 1,
      });
    });

    test("one article re-run five times is one observation, not five", async () => {
      // The number answers "how many articles is this about". Counting
      // proposals would let a single article reach the promotion threshold on
      // its own, which is the question a threshold exists to ask.
      await suggestedBy("a");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);
      }

      const [row] = await rows<{ observations: number }>(handle.sql`
        SELECT observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ observations: 1 });
    });

    test("three articles that named it is three observations", async () => {
      await suggestedBy("a", "b", "c");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);

      const [row] = await rows<{ observations: number }>(handle.sql`
        SELECT observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ observations: 3 });
    });

    test("only this model's current tags rows are counted", async () => {
      // An answer from another model, or from yesterday's prompt, says nothing
      // about whether this build's vocabulary is earning a tag. Counting them
      // would make a model switch or a prompt replay look like evidence.
      for (const [model, promptVersion] of [
        ["chat-other", TAGS_VERSION],
        [MODEL, "tags.v0"],
      ] as const) {
        await writeEnrichment(handle.sql, {
          itemId: model === MODEL ? "a" : "b",
          kind: "tags",
          model,
          promptVersion,
          content: { tags: [], candidates: ["query-planners"] },
        });
      }

      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);

      const [row] = await rows<{ observations: number }>(handle.sql`
        SELECT observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ observations: 0 });
    });

    test("an article that named two tags counts once for each", async () => {
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "tags",
        model: MODEL,
        promptVersion: "tags.v1",
        content: { tags: ["vulkan"], candidates: ["query-planners"] },
      });
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);

      const found = await rows<{ slug: string; observations: number }>(handle.sql`
        SELECT slug, observations FROM tag_vocabulary ORDER BY slug
      `);
      // The suggestion under `candidates` counts as much as one under `tags`:
      // both are one article naming this concept.
      expect(found).toEqual([
        { slug: "query-planners", observations: 1 },
        { slug: "vulkan", observations: 1 },
      ]);
    });

    test("an approved tag is not dragged back into candidacy by a later suggestion", async () => {
      await suggestedBy("a");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);
      await suggestedBy("b");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);
      expect(await setTagStatus(handle.sql, "query-planners", "approved")).toBe(true);

      await suggestedBy("b");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);

      const [row] = await rows<{ status: string; observations: number }>(handle.sql`
        SELECT status, observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ status: "approved", observations: 2 });
    });

    test("a rejected tag is not revived by a later suggestion either", async () => {
      await suggestedBy("a");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);
      expect(await setTagStatus(handle.sql, "query-planners", "rejected")).toBe(true);

      await suggestedBy("b");
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);

      const [row] = await rows<{ status: string; observations: number }>(handle.sql`
        SELECT status, observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ status: "rejected", observations: 1 });
    });

    test("approving stamps the moment, and rejecting clears it", async () => {
      await suggestTag(handle.sql, "query-planners", "Query planners", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "query-planners", "approved");

      const [approved] = await rows<{ approved_at: unknown }>(handle.sql`
        SELECT approved_at FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(approved?.approved_at).not.toBeNull();

      await setTagStatus(handle.sql, "query-planners", "rejected");
      const [rejected] = await rows<{ approved_at: unknown }>(handle.sql`
        SELECT approved_at FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(rejected?.approved_at).toBeNull();
    });

    test("setting a status for a tag nobody suggested changes nothing", async () => {
      expect(await setTagStatus(handle.sql, "never-suggested", "approved")).toBe(false);
      expect(await approvedTags(handle.sql)).toEqual([]);
    });

    test("only approved slugs are offered to the tagging prompt", async () => {
      await suggestTag(handle.sql, "zanzibar", "Zanzibar", MODEL, TAGS_VERSION);
      await suggestTag(handle.sql, "apparmor", "AppArmor", MODEL, TAGS_VERSION);
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "zanzibar", "approved");
      await setTagStatus(handle.sql, "apparmor", "approved");

      expect(await approvedTags(handle.sql)).toEqual(["apparmor", "zanzibar"]);
    });

    test("review lists the candidates at or above the threshold, most seen first", async () => {
      // Three articles naming different sets, so the counts differ by how many
      // articles named them rather than by how often.
      await namedBy("a", ["vulkan", "zanzibar", "apparmor"]);
      await namedBy("b", ["vulkan", "zanzibar"]);
      await namedBy("c", ["vulkan"]);
      await setTagStatus(handle.sql, "apparmor", "approved");

      expect((await tagsForReview(handle.sql, 2)).map((row) => row.slug)).toEqual([
        "vulkan",
        "zanzibar",
      ]);
      // Only vulkan was named by three articles.
      expect((await tagsForReview(handle.sql, 3)).map((row) => row.slug)).toEqual(["vulkan"]);
    });

    test("an approved tag is not waiting for review, however many articles named it", async () => {
      await namedBy("a", ["vulkan"]);
      await namedBy("b", ["vulkan"]);
      await suggestTag(handle.sql, "vulkan", "vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");

      expect(await tagsForReview(handle.sql, 1)).toEqual([]);
    });

    test("attaches an approved tag to an item", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);

      expect(await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model")).toBe(1);

      const attached = await rows<{ item: string; slug: string; source: string }>(handle.sql`
        SELECT it.item_id AS item, t.slug, it.source FROM item_tags it
        JOIN tag_vocabulary t ON t.id = it.tag_id
      `);
      expect(attached).toEqual([{ item: "a", slug: "vulkan", source: "model" }]);
    });

    test("refuses to attach a candidate, however confidently the model asked", async () => {
      // Attaching one would let the model widen its own vocabulary by asking
      // twice, which is what the closed vocabulary exists to prevent.
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      const ids = await tagIds(handle);

      expect(await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model")).toBe(0);

      const attached = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM item_tags
      `);
      expect(attached).toEqual([{ count: 0 }]);
    });

    test("attaches the approved half of a mixed request", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await suggestTag(handle.sql, "zanzibar", "Zanzibar", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);

      expect(
        await attachTags(
          handle.sql,
          "a",
          [ids.get("vulkan") as string, ids.get("zanzibar") as string],
          "model",
        ),
      ).toBe(1);

      const attached = await rows<{ item: string }>(handle.sql`
        SELECT item_id AS item FROM item_tags
      `);
      expect(attached).toEqual([{ item: "a" }]);
    });

    test("a withdrawn approval detaches the tag from the articles it was on", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);
      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model");

      await setTagStatus(handle.sql, "vulkan", "rejected");

      // The filter somebody uses today must not keep the tag on the articles
      // it was on: a rejection is an answer about the word, not about the past.
      const attached = await rows<{ item: string }>(handle.sql`
        SELECT item_id AS item FROM item_tags
      `);
      expect(attached).toEqual([]);
      // And it attaches nowhere new either.
      expect(await attachTags(handle.sql, "b", [ids.get("vulkan") as string], "model")).toBe(0);
    });

    test("approving leaves the articles it was not on alone", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);
      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model");
      await handle.sql`
        INSERT INTO enrichments (item_id, kind, model, prompt_version, content)
        VALUES ('b', 'tags', ${MODEL}, 'tags.v1', '{"tags":["vulkan"],"candidates":[]}'::jsonb)
      `;

      // Approving makes it a tag from now on. It does not go and attach it to
      // the article that already named it and never got it: that is
      // `tsuzuri enrich --kind tags --force`, and doing it here would attach a
      // tag on the strength of a row no pass wrote with an approved tag in it.
      expect(await tagsOfItems(handle.sql, ["a", "b"])).toEqual(new Map([["a", ["vulkan"]]]));
    });

    test("attaching the same tag twice is not a second row", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);

      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model");
      expect(await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model")).toBe(1);

      const attached = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM item_tags
      `);
      expect(attached).toEqual([{ count: 1 }]);
    });

    test("a manual tag and a model tag on one item are both kept", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await suggestTag(handle.sql, "zanzibar", "Zanzibar", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      await setTagStatus(handle.sql, "zanzibar", "approved");
      const ids = await tagIds(handle);

      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model");
      await attachTags(handle.sql, "a", [ids.get("zanzibar") as string], "manual");

      const attached = await rows<{ source: string }>(handle.sql`
        SELECT source FROM item_tags ORDER BY source
      `);
      expect(attached).toEqual([{ source: "manual" }, { source: "model" }]);
    });

    test("refuses an attachment that came from neither the model nor a person", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);

      await expect(
        attachTags(handle.sql, "a", [ids.get("vulkan") as string], "telepathy" as "model"),
      ).rejects.toThrow();
    });

    test("attaching no tags touches nothing", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");

      expect(await attachTags(handle.sql, "a", [], "model")).toBe(0);
      const attached = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM item_tags
      `);
      expect(attached).toEqual([{ count: 0 }]);
    });

    test("reads the tags of several articles at once, by slug", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await suggestTag(handle.sql, "zanzibar", "Zanzibar", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      await setTagStatus(handle.sql, "zanzibar", "approved");
      const ids = await tagIds(handle);

      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model");
      await attachTags(
        handle.sql,
        "b",
        [ids.get("vulkan") as string, ids.get("zanzibar") as string],
        "model",
      );

      // One map rather than one query per article: a listing would otherwise
      // make fifty round trips to render fifty rows.
      expect(await tagsOfItems(handle.sql, ["a", "b", "untagged"])).toEqual(
        new Map([
          ["a", ["vulkan"]],
          ["b", ["vulkan", "zanzibar"]],
        ]),
      );
      expect(await tagsOfItems(handle.sql, [])).toEqual(new Map());
    });
  });

  describe("candidate selection", () => {
    const wantSummary = [{ kind: "summary" as const, promptVersion: PROMPT_VERSION }];

    beforeEach(async () => {
      // Enrichment only spends on articles a subscription delivers; a listing
      // joins item_sources, so one nothing carries could be paid for unseen.
      await handle.sql`
        INSERT INTO sources (user_id, kind, url)
        VALUES (${DEFAULT_USER_ID}, 'feed', 'https://selection.example/feed')
        ON CONFLICT DO NOTHING
      `;
    });

    /** Items published `hoursAgo` before now, newest first by name. */
    async function seed(
      spec: ReadonlyArray<{ id: string; hoursAgo: number; starred?: boolean }>,
    ): Promise<void> {
      for (const { id, hoursAgo, starred } of spec) {
        await handle.sql`
          INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
          VALUES (
            ${id}, ${`https://example.com/${id}`}, ${`https://example.com/${id}`},
            ${`title ${id}`},
            now() - make_interval(hours => ${hoursAgo}::int),
            ${`body of ${id}`}
          )
        `;
        await handle.sql`
          INSERT INTO item_sources (item_id, source_id)
          SELECT ${id}, id FROM sources LIMIT 1
        `;
        if (starred) {
          await handle.sql`
            INSERT INTO item_state (user_id, item_id, starred_at)
            VALUES (${DEFAULT_USER_ID}, ${id}, now())
          `;
        }
      }
    }

    const select = (overrides: Record<string, unknown> = {}) =>
      enrichmentCandidates(handle.sql, {
        userId: DEFAULT_USER_ID,
        model: MODEL,
        wanted: wantSummary,
        windowHours: 48,
        collapse: false,
        limit: 10,
        ...overrides,
      } as Parameters<typeof enrichmentCandidates>[1]);

    test("takes the newest items that have no current enrichment", async () => {
      await seed([
        { id: "old", hoursAgo: 40 },
        { id: "newest", hoursAgo: 1 },
        { id: "middle", hoursAgo: 10 },
      ]);
      await writeEnrichment(handle.sql, {
        itemId: "newest",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "already summarised" },
      });

      const { candidates, matched } = await select();
      expect(candidates).toEqual(["middle", "old"]);
      expect(matched).toBe(2);
    });

    test("an item outside the window is not a candidate", async () => {
      // The window bounds spend: a week-old article is not what a reader is
      // deciding about this morning.
      await seed([{ id: "ancient", hoursAgo: 24 * 7 }]);

      const { candidates } = await select();
      expect(candidates).toEqual([]);
    });

    test("a row from another model does not make an item enriched", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: "chat-other",
        promptVersion: PROMPT_VERSION,
        content: { summary: "somebody else's answer" },
      });

      const { candidates } = await select();
      expect(candidates).toEqual(["a"]);
    });

    test("a previous prompt version does not make an item enriched", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: "summary.v0",
        content: { summary: "written by the old prompt" },
      });

      const { candidates } = await select();
      expect(candidates).toEqual(["a"]);
    });

    test("an item missing one wanted kind is still a candidate for the others", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "summarised" },
      });

      const withTags = await select({
        wanted: [...wantSummary, { kind: "tags", promptVersion: "tags.v1" }],
      });
      expect(withTags.candidates).toEqual(["a"]);
      expect((await select()).candidates).toEqual([]);
    });

    test("a kind inside its retry backoff is left alone, and the other is not", async () => {
      // Otherwise one article the model refuses for tags would park its summary
      // behind it, and then be re-selected on every pass forever.
      await seed([{ id: "a", hoursAgo: 1 }]);
      await recordEnrichmentFailure(handle.sql, "a", target("summary"), "the model refused");

      const { candidates } = await select({
        wanted: [...wantSummary, { kind: "tags", promptVersion: "tags.v1" }],
      });
      expect(candidates).toEqual(["a"]);

      // The summary alone is inside its backoff, so the item waits.
      expect((await select()).candidates).toEqual([]);
    });

    test("another model's failure does not hold the item for this one", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      await recordEnrichmentFailure(
        handle.sql,
        "a",
        { kind: "summary", model: "older-model", promptVersion: PROMPT_VERSION },
        "the old model refused",
      );

      const { candidates } = await select();
      expect(candidates).toEqual(["a"]);
    });

    test("a failure in one translation language is not one in another", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      const into = (lang: string): EnrichmentTarget => ({
        kind: "translation",
        lang,
        model: MODEL,
        promptVersion: "translation.v1",
      });
      await recordEnrichmentFailure(handle.sql, "a", into("en"), "refused");

      expect(await inBackoff(handle.sql, "a", into("en"))).toBe(true);
      expect(await inBackoff(handle.sql, "a", into("de"))).toBe(false);
    });

    test("a backoff that has expired no longer holds the item", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      await recordEnrichmentFailure(
        handle.sql,
        "a",
        target("summary"),
        "the model refused",
        new Date(Date.now() - 2 * 60 * 60_000),
      );

      const { candidates } = await select();
      expect(candidates).toEqual(["a"]);
    });

    test("--force re-runs an item whose row is older than the cutoff", async () => {
      // The flag is what asks again about an article that already has an
      // answer, which is the whole of replaying a prompt over history. Reading
      // a stored row as answering the item made --force do nothing at all.
      await seed([{ id: "a", hoursAgo: 1 }]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "already summarised" },
      });

      const { candidates } = await select({ force: true, now: new Date(Date.now() + 1000) });
      expect(candidates).toEqual(["a"]);
    });

    test("--force measures against the cutoff it was given, not the request time", async () => {
      // One article was enriched half an hour ago and one yesterday. Asking
      // about everything older than an hour ago is the first; asking about
      // everything is the second, and which one a rerun means is the caller's
      // to say.
      await seed([
        { id: "recent", hoursAgo: 1 },
        { id: "old", hoursAgo: 3 },
      ]);
      const summarised = { summary: "already summarised" };
      await writeEnrichment(handle.sql, {
        itemId: "recent",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: summarised,
      });
      await writeEnrichment(handle.sql, {
        itemId: "old",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: summarised,
      });
      await handle.sql`
        UPDATE enrichments SET created_at = now() - interval '30 minutes'
        WHERE item_id = 'recent'
      `;
      await handle.sql`
        UPDATE enrichments SET created_at = now() - interval '3 hours'
        WHERE item_id = 'old'
      `;

      const { candidates } = await select({
        force: true,
        forceBefore: new Date(Date.now() - 60 * 60_000),
      });
      // The article answered after the cutoff is left alone; the one answered
      // before it is asked about again.
      expect(candidates).toEqual(["old"]);
    });

    test("--force re-runs an item whose row is from another prompt version", async () => {
      // The point of the flag: a prompt change writes a new row beside the old
      // one, and evaluating it needs the items that already have one.
      await seed([{ id: "a", hoursAgo: 1 }]);
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: "summary.v0",
        content: { summary: "written by the old prompt" },
      });

      const { candidates } = await select({ force: true });
      expect(candidates).toEqual(["a"]);
    });

    test("since reaches back past the window a pass looks at", async () => {
      // The rerun over history is the whole point of --since: a prompt change
      // is evaluated against articles the pass would never have selected.
      await seed([{ id: "ancient", hoursAgo: 24 * 20 }]);

      expect((await select()).candidates).toEqual([]);
      const { candidates } = await select({ since: new Date(Date.now() - 30 * 24 * 3600_000) });
      expect(candidates).toEqual(["ancient"]);
    });

    test("the starred arm returns starred items however old they are", async () => {
      // A star is an explicit request, so it is not subject to the window that
      // bounds the ranked arm's spend.
      await seed([
        { id: "stale-star", hoursAgo: 24 * 9, starred: true },
        { id: "plain", hoursAgo: 1 },
      ]);

      const { candidates } = await select({ starredOnly: true });
      expect(candidates).toEqual(["stale-star"]);
    });

    test("only the cluster representative is a candidate while clustering is on", async () => {
      // One syndicated story is one summary, not eight: this is where clustering
      // pays for enrichment (D29).
      await seed([
        { id: "wire", hoursAgo: 2 },
        { id: "copy", hoursAgo: 1 },
      ]);
      await handle.sql`
        INSERT INTO clusters (representative_item_id, size, first_published_at, last_published_at)
        VALUES ('wire', 2, now() - make_interval(hours => 2), now())
      `;
      await handle.sql`
        INSERT INTO item_clusters (item_id, cluster_id)
        SELECT item.id, c.id FROM items item, clusters c WHERE c.representative_item_id = 'wire'
      `;

      const collapsed = await select({ collapse: true });
      expect(collapsed.candidates).toEqual(["wire"]);
      const expanded = await select({ collapse: false });
      expect(expanded.candidates).toEqual(["copy", "wire"]);
    });

    test("a starred copy is a candidate however its cluster is represented", async () => {
      // The representative filter answers "one story is one call", which is
      // about the ranked arm choosing articles to spend on. A star names one
      // article, and the article somebody starred is not made less interesting
      // by another outlet having published it first.
      await seed([
        { id: "wire", hoursAgo: 2 },
        { id: "copy", hoursAgo: 1, starred: true },
      ]);
      await handle.sql`
        INSERT INTO clusters (representative_item_id, size, first_published_at, last_published_at)
        VALUES ('wire', 2, now() - make_interval(hours => 2), now())
      `;
      await handle.sql`
        INSERT INTO item_clusters (item_id, cluster_id)
        SELECT item.id, c.id FROM items item, clusters c WHERE c.representative_item_id = 'wire'
      `;

      const collapsed = await select({ collapse: true });
      expect(collapsed.candidates).toEqual(["wire"]);

      const starred = await select({ collapse: true, starredOnly: true });
      expect(starred.candidates).toEqual(["copy"]);
    });

    test("--force ignores the retry backoff, which is what it is for", async () => {
      // An explicit rerun asked for by a person is the decision the backoff was
      // waiting for. Without this the flag would be indistinguishable from not
      // passing it, since every item it wants has no row for the version being
      // replayed.
      await seed([{ id: "a", hoursAgo: 1 }]);
      await recordEnrichmentFailure(handle.sql, "a", target("summary"), "the model refused");

      expect((await select()).candidates).toEqual([]);
      expect((await select({ force: true })).candidates).toEqual(["a"]);
    });

    test("--force moves on after the items the previous call wrote", async () => {
      // A cutoff that names nothing makes every row a re-run, so a bounded
      // rerun re-picks the same newest items every time and never reaches the
      // rest. One taken from the answer the previous call gave reaches past it.
      await seed([
        { id: "newest", hoursAgo: 1 },
        { id: "older", hoursAgo: 2 },
        { id: "oldest", hoursAgo: 3 },
      ]);
      const cutoff = new Date(Date.now() - 1000);

      const first = await select({ force: true, forceBefore: cutoff, limit: 2 });
      expect(first.candidates).toEqual(["newest", "older"]);

      for (const id of ["newest", "older"]) {
        await writeEnrichment(handle.sql, {
          itemId: id,
          kind: "summary",
          model: MODEL,
          promptVersion: PROMPT_VERSION,
          content: { summary: "written by that request" },
        });
      }

      // What the first call wrote is answered as of the cutoff it was given, so
      // the second continues with the article behind it...
      const second = await select({ force: true, forceBefore: cutoff, limit: 1 });
      expect(second.candidates).toEqual(["oldest"]);

      await writeEnrichment(handle.sql, {
        itemId: "oldest",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "written by that request" },
      });

      // ...and once the third has been written too, there is nothing left to
      // reach. Re-running the command as typed instead would start again at
      // the newest item.
      expect(await select({ force: true, forceBefore: cutoff })).toEqual({
        candidates: [],
        matched: 0,
      });
    });

    test("without --force the backoff filter still holds, and with it the kinds are listed", async () => {
      // The selection query filters on backoff; enrichOne asks per kind so an
      // item chosen for one kind does not pay for another that is waiting.
      await seed([{ id: "a", hoursAgo: 1 }]);
      await recordEnrichmentFailure(handle.sql, "a", target("summary"), "refused");

      expect(await inBackoff(handle.sql, "a", target("summary"))).toBe(true);
      expect(await inBackoff(handle.sql, "a", target("tags"))).toBe(false);
      // A backoff from an hour ago is not holding anything.
      expect(
        await inBackoff(handle.sql, "a", target("summary"), new Date(Date.now() + 2 * 60 * 60_000)),
      ).toBe(false);
    });

    test("the limit bounds the list, and matched still counts the rest", async () => {
      await seed([
        { id: "a", hoursAgo: 3 },
        { id: "b", hoursAgo: 2 },
        { id: "c", hoursAgo: 1 },
      ]);

      const { candidates, matched } = await select({ limit: 2 });
      expect(candidates).toEqual(["c", "b"]);
      // So a pass that stops at the hourly bound can report a backlog rather
      // than a truncated list it believes is all of it.
      expect(matched).toBe(3);
    });

    test("an item no subscription carries is not a candidate", async () => {
      // Listings join item_sources, so an item nothing delivers could be paid
      // for and never shown.
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, title, published_at, search_text)
        VALUES ('orphan', 'https://example.com/o', 'https://example.com/o', 't', now(), 'body')
      `;

      const { candidates } = await select();
      expect(candidates).toEqual([]);
    });

    test("wanting nothing selects nothing", async () => {
      await seed([{ id: "a", hoursAgo: 1 }]);
      expect(await select({ wanted: [] })).toEqual({ candidates: [], matched: 0 });
    });

    test("fetching the bodies of chosen items returns the title and the text", async () => {
      await seed([
        { id: "a", hoursAgo: 1 },
        { id: "b", hoursAgo: 2 },
      ]);

      const inputs = await enrichmentInputs(handle.sql, ["a", "b"]);
      expect(inputs).toEqual([
        { id: "a", title: "title a", summary: null, searchText: "body of a" },
        { id: "b", title: "title b", summary: null, searchText: "body of b" },
      ]);
      expect(await enrichmentInputs(handle.sql, [])).toEqual([]);
    });
  });

  describe("counts", () => {
    beforeEach(async () => {
      await seedItems(["a", "b"]);
    });

    const PROMPT_VERSIONS = ["summary.v1", "tags.v1", "translation.v1"];

    test("counts each kind once per item for the configured model", async () => {
      for (const itemId of ["a", "b"]) {
        await writeEnrichment(handle.sql, {
          itemId,
          kind: "summary",
          model: MODEL,
          promptVersion: "summary.v1",
          content: { summary: "s" },
        });
      }
      // Two languages of one kind are one item summarised, not two.
      for (const lang of ["ja", "fr"]) {
        await writeEnrichment(handle.sql, {
          itemId: "a",
          kind: "translation",
          lang,
          model: MODEL,
          promptVersion: "translation.v1",
          content: { title: "t", text: "x" },
        });
      }

      const counts = await enrichmentCounts(handle.sql, {
        model: MODEL,
        promptVersions: PROMPT_VERSIONS,
      });
      expect(counts).toEqual({ summarised: 2, tagged: 0, translated: 1, failed: 0 });
    });

    test("an answer from another model, or an old prompt, is not this model's work", async () => {
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: "chat-other",
        promptVersion: "summary.v1",
        content: { summary: "s" },
      });
      await writeEnrichment(handle.sql, {
        itemId: "b",
        kind: "summary",
        model: MODEL,
        promptVersion: "summary.v0",
        content: { summary: "s" },
      });

      expect(
        await enrichmentCounts(handle.sql, { model: MODEL, promptVersions: PROMPT_VERSIONS }),
      ).toEqual({ summarised: 0, tagged: 0, translated: 0, failed: 0 });
    });

    test("failures are counted as a backlog whatever produced them", async () => {
      await recordEnrichmentFailure(handle.sql, "a", target("summary"), "refused");

      expect(
        await enrichmentCounts(handle.sql, { model: MODEL, promptVersions: PROMPT_VERSIONS }),
      ).toEqual({ summarised: 0, tagged: 0, translated: 0, failed: 1 });
    });

    test("the seed counts calls, so a model that answers nothing still spends", async () => {
      // Successes and failures alike: a bound counted over successes is not a
      // bound, because an endpoint refusing every article writes no rows and
      // would be called again every pass, forever.
      for (const kind of ["summary", "tags"] as const) {
        await writeEnrichment(handle.sql, {
          itemId: "a",
          kind,
          model: MODEL,
          promptVersion: PROMPT_VERSIONS[0] as string,
          content: { summary: "s", tags: [], candidates: [] },
        });
      }
      await writeEnrichment(handle.sql, {
        itemId: "b",
        kind: "summary",
        model: MODEL,
        promptVersion: "summary.v1",
        content: { summary: "s" },
      });
      await recordEnrichmentFailure(handle.sql, "b", target("tags"), "refused");

      // Three rows written, one of them by the refusal: four calls spent, not
      // two items.
      expect(await enrichmentCallsSince(handle.sql, new Date(Date.now() - 3600_000))).toBe(4);
      expect(await enrichmentCallsSince(handle.sql, new Date(Date.now() + 3600_000))).toBe(0);
    });

    test("one item answered twice is two calls, not one", async () => {
      // Two kinds on one article are two requests. The service counts its own
      // calls; this is the seed a restart reads, and it must not tell the new
      // hour that less was spent than was.
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: "summary.v1",
        content: { summary: "s" },
      });
      await writeEnrichment(handle.sql, {
        itemId: "a",
        kind: "tags",
        model: MODEL,
        promptVersion: "tags.v1",
        content: { tags: [], candidates: [] },
      });

      expect(await enrichmentCallsSince(handle.sql, new Date(Date.now() - 3600_000))).toBe(2);
    });

    test("a failure from yesterday does not count against today's hour", async () => {
      await recordEnrichmentFailure(
        handle.sql,
        "a",
        target("summary"),
        "refused",
        new Date(Date.now() - 3 * 60 * 60_000),
      );

      expect(await enrichmentCallsSince(handle.sql, new Date(Date.now() - 3600_000))).toBe(0);
    });
  });

  describe("the Drizzle mirror", () => {
    /**
     * The migration is the source of truth and schema.ts is a hand-written
     * copy of it, so the two are only as close as a test that reads a row
     * written through one of them with the other.
     */
    beforeEach(async () => {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, published_at, search_text)
        VALUES ('a', 'https://example.com/a', 'https://example.com/a', '2026-10-01', 'body a')
      `;
    });

    test("an enrichment written through Drizzle is the row the writer reads", async () => {
      await handle.db.insert(enrichments).values({
        itemId: "a",
        kind: "summary",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        content: { summary: "written through Drizzle" },
      });

      const current = await currentEnrichments(handle.sql, ["a"], {
        model: MODEL,
        promptVersion: PROMPT_VERSION,
      });
      expect(current).toHaveLength(1);
      expect(current[0]?.content).toEqual({ summary: "written through Drizzle" });
    });

    test("a tag the vocabulary approved is the row the mirror selects", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");

      const selected = await handle.db.select().from(tagVocabulary);
      expect(selected).toHaveLength(1);
      expect(selected[0]?.slug).toBe("vulkan");
      expect(selected[0]?.label).toBe("Vulkan");
      expect(selected[0]?.status).toBe("approved");
      expect(selected[0]?.approvedAt).toBeInstanceOf(Date);
    });

    test("an attached tag is the row the mirror selects for that item", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan", MODEL, TAGS_VERSION);
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);
      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "manual");

      const selected = await handle.db.select().from(itemTags).where(eq(itemTags.itemId, "a"));
      expect(selected).toHaveLength(1);
      expect(selected[0]?.tagId).toBe(ids.get("vulkan"));
      expect(selected[0]?.source).toBe("manual");
    });
  });
});
