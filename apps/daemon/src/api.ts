import { searchTerms } from "@tsuzuri/core";
import {
  type Database,
  DEFAULT_USER_ID,
  hybridSearch,
  itemSources,
  itemState,
  items,
  sources,
} from "@tsuzuri/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import PQueue from "p-queue";
import type postgres from "postgres";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { EmbeddingService } from "./enrich/embeddings.ts";
import { InterestPreconditionError, type InterestService } from "./enrich/interest.ts";
import { checkFetchTarget } from "./ingest/fetch-target.ts";
import type { Fetcher } from "./ingest/fetcher.ts";
import { dueSources, ingestSource } from "./ingest/run.ts";
import { parseOpml } from "./opml.ts";
import { parseSince } from "./search-params.ts";

/**
 * The daemon's JSON API.
 *
 * The CLI, the web UI and the MCP server are all clients of this and nothing
 * else. Keeping them off the database directly is what stops one of them
 * growing behaviour the others do not have.
 */

export type ApiDeps = {
  db: Database;
  /** Raw driver handle. Search is written in SQL that Drizzle cannot express. */
  sql: postgres.Sql;
  fetcher: Fetcher;
  config: Config;
  embeddings: EmbeddingService;
  interest: InterestService;
};

const addSourceSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  kind: z.enum(["feed", "external", "rule", "plugin"]).default("feed"),
  fetchIntervalSeconds: z.number().int().min(60).optional(),
});

/**
 * Shortest abbreviation accepted for an item id.
 *
 * Eight is what the CLI prints, so anything it shows can be pasted back. Below
 * that, collisions stop being theoretical.
 */
const MIN_ID_PREFIX = 8;

const listItemsSchema = z.object({
  unread: z.stringbool().default(true),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sourceId: z.uuid().optional(),
  /**
   * Ordering. Omitted means whatever TIMELINE_DEFAULT_SORT says, which is
   * `recent` unless someone changed it.
   */
  sort: z.enum(["recent", "score"]).optional(),
});

export function createApi(deps: ApiDeps) {
  // Aliased: `sql` in this file is Drizzle's template tag, imported above.
  const { db, sql: rawSql, fetcher, config, embeddings, interest } = deps;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/sources", async (c) => {
    const rows = await db.select().from(sources).orderBy(sources.createdAt);
    return c.json({ sources: rows });
  });

  app.post("/sources", async (c) => {
    const parsed = addSourceSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

    // Subscribing is an instruction to fetch, and this endpoint is reachable
    // by an agent whose inputs include untrusted article text.
    const allowed = await checkFetchTarget(parsed.data.url, {
      allowPrivate: config.FETCH_ALLOW_PRIVATE_TARGETS,
    });
    if (!allowed.ok) return c.json({ error: `refusing to subscribe: ${allowed.reason}` }, 400);

    const [row] = await db
      .insert(sources)
      .values({
        userId: DEFAULT_USER_ID,
        kind: parsed.data.kind,
        url: parsed.data.url,
        title: parsed.data.title ?? null,
        fetchIntervalSeconds:
          parsed.data.fetchIntervalSeconds ?? config.DEFAULT_FETCH_INTERVAL_SECONDS,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) return c.json({ error: "already subscribed" }, 409);
    return c.json({ source: row }, 201);
  });

  app.delete("/sources/:id", async (c) => {
    const deleted = await db
      .delete(sources)
      .where(eq(sources.id, c.req.param("id")))
      .returning({ id: sources.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ deleted: deleted.length });
  });

  app.post("/sources/import-opml", async (c) => {
    const outlines = parseOpml(await c.req.text());
    if (outlines.length === 0) return c.json({ imported: 0, skipped: 0, sources: [] });

    const inserted = await db
      .insert(sources)
      .values(
        outlines.map((outline) => ({
          userId: DEFAULT_USER_ID,
          kind: "feed" as const,
          url: outline.xmlUrl,
          title: outline.title,
          siteUrl: outline.htmlUrl,
          fetchIntervalSeconds: config.DEFAULT_FETCH_INTERVAL_SECONDS,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: sources.id, url: sources.url });

    return c.json({
      imported: inserted.length,
      skipped: outlines.length - inserted.length,
      sources: inserted,
    });
  });

  /**
   * Poll subscriptions now.
   *
   * `all=true` ignores next_fetch_at, which is what a human wants right after
   * importing an OPML file or adding a feed.
   */
  app.post("/ingest/run", async (c) => {
    const all = c.req.query("all") === "true";
    const limit = Number(c.req.query("limit") ?? 500);

    const rows = all ? await db.select().from(sources).limit(limit) : await dueSources(db, limit);

    const queue = new PQueue({ concurrency: config.FETCH_CONCURRENCY });
    const outcomes = await Promise.all(
      rows.map((row) =>
        queue.add(() =>
          ingestSource(row, {
            db,
            fetcher,
            degradeAfterFailures: config.DEGRADE_AFTER_FAILURES,
          }),
        ),
      ),
    );

    const settled = outcomes.filter((outcome) => outcome !== undefined);
    return c.json({
      polled: settled.length,
      inserted: settled.reduce((sum, o) => sum + (o?.inserted ?? 0), 0),
      failed: settled.filter((o) => o?.status === "failed").length,
      outcomes: settled,
    });
  });

  app.get("/items", async (c) => {
    const parsed = listItemsSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);
    const { unread, limit, sourceId } = parsed.data;
    const sort = parsed.data.sort ?? config.TIMELINE_DEFAULT_SORT;

    /**
     * Ranked ordering, when it was asked for and can actually run.
     *
     * Asking for a ranked list while scoring is off is not an error. An install
     * with no embedding model, or with scoring switched off, is a supported
     * configuration rather than a broken one, so the request degrades to date
     * order and the response says which of the several possible reasons applied
     * -- exactly as /search reports why its vector arm did not run.
     */
    if (sort === "score") {
      const page = await interest.rank({
        limit,
        unreadOnly: unread,
        sourceId: sourceId ?? null,
      });
      if (page.scoring.active) return c.json({ items: page.items, scoring: page.scoring });
      const fallback = await listRecent({ unread, limit, sourceId });
      return c.json({
        items: fallback.map((item) => ({
          ...item,
          interest: 0,
          affinitySimilarity: 0,
          exploration: false,
        })),
        scoring: page.scoring,
      });
    }

    return c.json({ items: await listRecent({ unread, limit, sourceId }) });
  });

  /** The reverse-chronological listing, shared by the plain and degraded paths. */
  async function listRecent(options: {
    unread: boolean;
    limit: number;
    sourceId?: string | undefined;
  }) {
    const { unread, limit, sourceId } = options;

    const conditions = [];
    if (unread) conditions.push(isNull(itemState.readAt));
    if (sourceId) conditions.push(eq(itemSources.sourceId, sourceId));

    const rows = await db
      .selectDistinctOn([items.publishedAt, items.id], {
        id: items.id,
        url: items.url,
        title: items.title,
        author: items.author,
        publishedAt: items.publishedAt,
        publishedAtEstimated: items.publishedAtEstimated,
        summary: items.summary,
        readAt: itemState.readAt,
        starredAt: itemState.starredAt,
      })
      .from(items)
      .innerJoin(itemSources, eq(itemSources.itemId, items.id))
      .leftJoin(
        itemState,
        and(eq(itemState.itemId, items.id), eq(itemState.userId, DEFAULT_USER_ID)),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(items.publishedAt), items.id)
      .limit(limit);

    return rows;
  }

  /**
   * Resolve an item id that may have been abbreviated.
   *
   * Item ids are 64 hex characters, which nothing displays in full: the CLI
   * prints the first eight, and an agent pays for every one it repeats. Without
   * this, `tsuzuri read` and `tsuzuri show` did not compose at all -- the id you
   * were shown was not an id the next command accepted.
   *
   * Ambiguity is an error rather than a guess. Two articles sharing a prefix is
   * vanishingly unlikely at this length, but resolving to whichever one sorted
   * first would silently show the wrong article, and marking it read would
   * silently hide the wrong one.
   */
  async function resolveItemId(
    idOrPrefix: string,
  ): Promise<{ id: string } | { error: string; status: 404 | 400 }> {
    const candidate = idOrPrefix.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(candidate)) return { error: "not found", status: 404 };
    if (candidate.length < MIN_ID_PREFIX) {
      return { error: `id prefix must be at least ${MIN_ID_PREFIX} characters`, status: 400 };
    }

    // A full-length id is checked for existence too, rather than trusted. It
    // reads fine on GET, which looks the row up anyway, but a state update
    // would take it straight to an insert and turn a missing article into a
    // foreign key violation -- a 500 where the answer is 404.
    const matches = await db
      .select({ id: items.id })
      .from(items)
      .where(
        candidate.length === 64
          ? eq(items.id, candidate)
          : sql`${items.id} LIKE ${`${candidate}%`}`,
      )
      .limit(2);

    if (matches.length === 0) return { error: "not found", status: 404 };
    if (matches.length > 1) {
      return { error: `id prefix "${candidate}" matches more than one item`, status: 400 };
    }
    return { id: (matches[0] as { id: string }).id };
  }

  app.get("/items/:id", async (c) => {
    const resolved = await resolveItemId(c.req.param("id"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

    const [row] = await db.select().from(items).where(eq(items.id, resolved.id));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ item: row });
  });

  /** Mark read / unread / starred. All of these feed interest scoring later. */
  app.post("/items/:id/state", async (c) => {
    const body = z
      .object({
        read: z.boolean().optional(),
        starred: z.boolean().optional(),
        skipped: z.boolean().optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: z.treeifyError(body.error) }, 400);

    const resolved = await resolveItemId(c.req.param("id"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

    const now = new Date();
    const patch: Record<string, Date | null> = {};
    if (body.data.read !== undefined) patch.readAt = body.data.read ? now : null;
    if (body.data.starred !== undefined) patch.starredAt = body.data.starred ? now : null;
    if (body.data.skipped !== undefined) patch.skippedAt = body.data.skipped ? now : null;

    const [row] = await db
      .insert(itemState)
      .values({ userId: DEFAULT_USER_ID, itemId: resolved.id, ...patch })
      .onConflictDoUpdate({
        target: [itemState.userId, itemState.itemId],
        set: { ...patch, updatedAt: now },
      })
      .returning();

    return c.json({ state: row });
  });

  const searchSchema = z.object({
    q: z.string().trim().min(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    since: z.string().optional(),
    sourceId: z.uuid().optional(),
    unreadOnly: z.stringbool().default(false),
  });

  /**
   * Hybrid search.
   *
   * Answers with a `mode` because degrading is normal here rather than
   * exceptional: an install with no embedding model is a supported
   * configuration, not a broken one. A caller cannot tell "nothing matched"
   * from "half the search was switched off" by looking at an empty list, so the
   * response says which, and why.
   */
  app.get("/search", async (c) => {
    const parsed = searchSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

    let since: Date | null;
    try {
      since = parseSince(parsed.data.since);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }

    const embedded = await embeddings.embedQuery(parsed.data.q);

    const result = await hybridSearch(rawSql, {
      terms: searchTerms(parsed.data.q),
      queryVector: embedded.status === "ok" ? embedded.vector : null,
      limit: parsed.data.limit,
      since,
      sourceId: parsed.data.sourceId ?? null,
      unreadOnly: parsed.data.unreadOnly,
      userId: DEFAULT_USER_ID,
      maxDistance: config.SEARCH_MAX_DISTANCE,
    });

    return c.json({
      mode: result.mode,
      ...(embedded.status === "unavailable" ? { reason: embedded.reason } : {}),
      results: result.hits,
    });
  });

  app.get("/embeddings/status", async (c) => c.json(await embeddings.status()));

  app.get("/interest/status", async (c) => c.json(await interest.status()));

  /**
   * Rebuild the interest profile now.
   *
   * Awaited rather than detached, unlike the embedding reindex: a rebuild reads
   * a bounded set of signalled items and runs k-means over them in memory, so it
   * finishes in the time a request can wait. Nothing about it outlives the call.
   */
  app.post("/interest/rebuild", async (c) => {
    try {
      return c.json(await interest.rebuild());
    } catch (error) {
      // Only a precondition is the caller's fault. A database failure answered
      // as 400 tells a client its request was malformed when retrying would
      // have worked.
      if (error instanceof InterestPreconditionError) {
        return c.json({ error: error.message }, 400);
      }
      console.error("interest rebuild failed:", error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  /**
   * Re-embed everything into the configured model.
   *
   * Answers immediately rather than holding the request open: a full rebuild
   * runs for as long as the corpus takes, which is minutes on a real install.
   * Progress is read from /embeddings/status, which is also where an
   * interrupted rebuild is visible.
   */
  app.post("/embeddings/reindex", async (c) => {
    const parsed = z
      .object({ model: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

    try {
      // Deliberately not awaited. Errors surface through the status endpoint.
      const running = embeddings.reindex({ model: parsed.data.model });
      // Give it long enough to fail on its preconditions, so an obviously wrong
      // call answers with the reason instead of a cheerful 202.
      const outcome = await Promise.race([
        running.then(() => "done" as const),
        Bun.sleep(250).then(() => "running" as const),
      ]);
      if (outcome === "running")
        void running.catch((error) => console.error("reindex failed:", error));
      return c.json({ status: outcome, ...(await embeddings.status()) }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  /** What is configured and what is not, so nobody debugs a component they never enabled. */
  app.get("/doctor", async (c) => {
    const extensions = await db.execute<{ extname: string; extversion: string }>(
      sql`SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgroonga', 'vector')`,
    );
    const [counts] = await db
      .select({
        sources: sql<number>`(SELECT count(*)::int FROM ${sources})`,
        items: sql<number>`(SELECT count(*)::int FROM ${items})`,
        degraded: sql<number>`(SELECT count(*)::int FROM ${sources} WHERE status = 'degraded')`,
      })
      .from(sql`(SELECT 1) AS t`);

    const embeddingStatus = await embeddings.status();

    return c.json({
      database: { extensions: [...extensions] },
      counts,
      features: {
        embeddings: {
          enabled: embeddingStatus.state === "ready",
          ...embeddingStatus,
        },
        scoring: await interest.status(),
        // Everything below arrives in a later phase. Reporting it as "not
        // configured" beats leaving people to wonder why search is empty.
        llm: { enabled: false, reason: "not implemented until P3" },
        headless: { enabled: false, reason: "not implemented until P6" },
      },
      sourceKinds: ["feed"],
    });
  });

  return app;
}
