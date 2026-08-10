import {
  type Database,
  DEFAULT_USER_ID,
  itemSources,
  itemState,
  items,
  sources,
} from "@tsuzuri/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import PQueue from "p-queue";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { EmbeddingService } from "./enrich/embeddings.ts";
import type { Fetcher } from "./ingest/fetcher.ts";
import { dueSources, ingestSource } from "./ingest/run.ts";
import { parseOpml } from "./opml.ts";

/**
 * The daemon's JSON API.
 *
 * The CLI, the web UI and the MCP server are all clients of this and nothing
 * else. Keeping them off the database directly is what stops one of them
 * growing behaviour the others do not have.
 */

export type ApiDeps = {
  db: Database;
  fetcher: Fetcher;
  config: Config;
  embeddings: EmbeddingService;
};

const addSourceSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  kind: z.enum(["feed", "external", "rule", "plugin"]).default("feed"),
  fetchIntervalSeconds: z.number().int().min(60).optional(),
});

const listItemsSchema = z.object({
  unread: z.stringbool().default(true),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sourceId: z.uuid().optional(),
});

export function createApi(deps: ApiDeps) {
  const { db, fetcher, config, embeddings } = deps;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/sources", async (c) => {
    const rows = await db.select().from(sources).orderBy(sources.createdAt);
    return c.json({ sources: rows });
  });

  app.post("/sources", async (c) => {
    const parsed = addSourceSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

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

    return c.json({ items: rows });
  });

  app.get("/items/:id", async (c) => {
    const [row] = await db
      .select()
      .from(items)
      .where(eq(items.id, c.req.param("id")));
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

    const now = new Date();
    const patch: Record<string, Date | null> = {};
    if (body.data.read !== undefined) patch.readAt = body.data.read ? now : null;
    if (body.data.starred !== undefined) patch.starredAt = body.data.starred ? now : null;
    if (body.data.skipped !== undefined) patch.skippedAt = body.data.skipped ? now : null;

    const [row] = await db
      .insert(itemState)
      .values({ userId: DEFAULT_USER_ID, itemId: c.req.param("id"), ...patch })
      .onConflictDoUpdate({
        target: [itemState.userId, itemState.itemId],
        set: { ...patch, updatedAt: now },
      })
      .returning();

    return c.json({ state: row });
  });

  app.get("/embeddings/status", async (c) => c.json(await embeddings.status()));

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
