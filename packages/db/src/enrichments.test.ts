import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type postgres from "postgres";

import { createDatabase } from "./client.ts";
import {
  approvedTags,
  attachTags,
  clearEnrichmentFailure,
  currentEnrichments,
  pruneEnrichments,
  recordEnrichmentFailure,
  setTagStatus,
  suggestTag,
  tagsForReview,
  writeEnrichment,
} from "./enrichments.ts";
import { migrate } from "./migrate.ts";
import { enrichments, itemTags, tagVocabulary } from "./schema.ts";

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
      await recordEnrichmentFailure(handle.sql, "a", "summary", "the model refused", at9am);

      const [first] = await rows<Failure>(handle.sql`
        SELECT failures, last_error AS error, next_attempt_at AS next
        FROM enrichment_failures WHERE item_id = 'a' AND kind = 'summary'
      `);
      expect(first?.failures).toBe(1);
      expect(first?.error).toBe("the model refused");
      expect(at(first?.next).toISOString()).toBe("2026-10-05T09:01:00.000Z");

      await recordEnrichmentFailure(handle.sql, "a", "summary", "still refusing", at9am);

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
        await recordEnrichmentFailure(handle.sql, "b", "summary", "refused", at9am);
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
      await recordEnrichmentFailure(handle.sql, "c", "summary", "refused", at9am);

      const [row] = await rows<{ kind: string }>(handle.sql`
        SELECT kind FROM enrichment_failures WHERE item_id = 'c' AND kind = 'tags'
      `);
      expect(row).toBeUndefined();
    });

    test("clearing a failure removes the backoff it was holding the item behind", async () => {
      await seedItems(["d"]);
      await recordEnrichmentFailure(handle.sql, "d", "summary", "refused", at9am);
      await clearEnrichmentFailure(handle.sql, "d", "summary");

      const left = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM enrichment_failures
      `);
      expect(left).toEqual([{ count: 0 }]);
    });

    test("clearing one kind leaves the other's backoff standing", async () => {
      await seedItems(["e"]);
      await recordEnrichmentFailure(handle.sql, "e", "summary", "refused", at9am);
      await recordEnrichmentFailure(handle.sql, "e", "tags", "refused", at9am);
      await clearEnrichmentFailure(handle.sql, "e", "summary");

      const left = await rows<{ kind: string }>(handle.sql`
        SELECT kind FROM enrichment_failures WHERE item_id = 'e'
      `);
      expect(left).toEqual([{ kind: "tags" }]);
    });
  });

  describe("the tag vocabulary", () => {
    beforeEach(async () => {
      await handle.sql`
        INSERT INTO items (id, url, canonical_url, published_at, search_text)
        VALUES ('a', 'https://example.com/a', 'https://example.com/a', '2026-10-01', 'body a'),
               ('b', 'https://example.com/b', 'https://example.com/b', '2026-10-01', 'body b')
      `;
    });

    test("a suggested tag starts as a candidate with one observation", async () => {
      type Candidate = { slug: string; label: string; status: string; observations: number };

      await suggestTag(handle.sql, "query-planners", "Query planners");

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

    test("the same suggestion again is counted rather than duplicated", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await suggestTag(handle.sql, "query-planners", "Query planners");
      }

      const [row] = await rows<{ slug: string; label: string; observations: number }>(handle.sql`
        SELECT slug, label, observations FROM tag_vocabulary
      `);
      expect(row).toEqual({ slug: "query-planners", label: "Query planners", observations: 3 });
    });

    test("an approved tag is not dragged back into candidacy by a later suggestion", async () => {
      await suggestTag(handle.sql, "query-planners", "Query planners");
      await suggestTag(handle.sql, "query-planners", "Query planners");
      expect(await setTagStatus(handle.sql, "query-planners", "approved")).toBe(true);

      await suggestTag(handle.sql, "query-planners", "Query planners");

      const [row] = await rows<{ status: string; observations: number }>(handle.sql`
        SELECT status, observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ status: "approved", observations: 2 });
    });

    test("a rejected tag is not revived by a later suggestion either", async () => {
      await suggestTag(handle.sql, "query-planners", "Query planners");
      expect(await setTagStatus(handle.sql, "query-planners", "rejected")).toBe(true);

      await suggestTag(handle.sql, "query-planners", "Query planners");

      const [row] = await rows<{ status: string; observations: number }>(handle.sql`
        SELECT status, observations FROM tag_vocabulary WHERE slug = 'query-planners'
      `);
      expect(row).toEqual({ status: "rejected", observations: 1 });
    });

    test("approving stamps the moment, and rejecting clears it", async () => {
      await suggestTag(handle.sql, "query-planners", "Query planners");
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
      await suggestTag(handle.sql, "zanzibar", "Zanzibar");
      await suggestTag(handle.sql, "apparmor", "AppArmor");
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await setTagStatus(handle.sql, "zanzibar", "approved");
      await setTagStatus(handle.sql, "apparmor", "approved");

      expect(await approvedTags(handle.sql)).toEqual(["apparmor", "zanzibar"]);
    });

    test("review lists the candidates at or above the threshold, most proposed first", async () => {
      for (const slug of ["vulkan", "zanzibar", "apparmor"]) {
        await suggestTag(handle.sql, slug, slug);
      }
      await suggestTag(handle.sql, "zanzibar", "zanzibar");
      await suggestTag(handle.sql, "apparmor", "apparmor");
      await setTagStatus(handle.sql, "vulkan", "approved");

      expect((await tagsForReview(handle.sql, 2)).map((row) => row.slug)).toEqual([
        "apparmor",
        "zanzibar",
      ]);
      expect(await tagsForReview(handle.sql, 3)).toEqual([]);
    });

    test("an approved tag is not waiting for review, however often it was proposed", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await suggestTag(handle.sql, "vulkan", "Vulkan");
      }
      await setTagStatus(handle.sql, "vulkan", "approved");

      expect(await tagsForReview(handle.sql, 1)).toEqual([]);
    });

    test("attaches an approved tag to an item", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan");
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
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      const ids = await tagIds(handle);

      expect(await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model")).toBe(0);

      const attached = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM item_tags
      `);
      expect(attached).toEqual([{ count: 0 }]);
    });

    test("attaches the approved half of a mixed request", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await suggestTag(handle.sql, "zanzibar", "Zanzibar");
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

    test("a withdrawn approval attaches the tag nowhere new", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);
      await attachTags(handle.sql, "a", [ids.get("vulkan") as string], "model");

      await setTagStatus(handle.sql, "vulkan", "rejected");
      expect(await attachTags(handle.sql, "b", [ids.get("vulkan") as string], "model")).toBe(0);

      const attached = await rows<{ item: string }>(handle.sql`
        SELECT item_id AS item FROM item_tags
      `);
      expect(attached).toEqual([{ item: "a" }]);
    });

    test("attaching the same tag twice is not a second row", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan");
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
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await suggestTag(handle.sql, "zanzibar", "Zanzibar");
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
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await setTagStatus(handle.sql, "vulkan", "approved");
      const ids = await tagIds(handle);

      await expect(
        attachTags(handle.sql, "a", [ids.get("vulkan") as string], "telepathy" as "model"),
      ).rejects.toThrow();
    });

    test("attaching no tags touches nothing", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await setTagStatus(handle.sql, "vulkan", "approved");

      expect(await attachTags(handle.sql, "a", [], "model")).toBe(0);
      const attached = await rows<{ count: number }>(handle.sql`
        SELECT count(*)::int AS count FROM item_tags
      `);
      expect(attached).toEqual([{ count: 0 }]);
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
      await suggestTag(handle.sql, "vulkan", "Vulkan");
      await setTagStatus(handle.sql, "vulkan", "approved");

      const selected = await handle.db.select().from(tagVocabulary);
      expect(selected).toHaveLength(1);
      expect(selected[0]?.slug).toBe("vulkan");
      expect(selected[0]?.label).toBe("Vulkan");
      expect(selected[0]?.status).toBe("approved");
      expect(selected[0]?.approvedAt).toBeInstanceOf(Date);
    });

    test("an attached tag is the row the mirror selects for that item", async () => {
      await suggestTag(handle.sql, "vulkan", "Vulkan");
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
