import { searchTerms } from "@tsuzuri/core";
import {
  clusterMemberIds,
  clusters,
  clustersOfSource,
  type Database,
  DEFAULT_USER_ID,
  hybridSearch,
  itemClusters,
  itemSources,
  itemState,
  items,
  refreshCluster,
  sources,
  type TagStatus,
} from "@tsuzuri/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import PQueue from "p-queue";
import type postgres from "postgres";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { ClusteringService } from "./enrich/clustering.ts";
import type { EmbeddingService } from "./enrich/embeddings.ts";
import { EnrichmentPreconditionError, type EnrichmentService } from "./enrich/enrichment.ts";
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
  clustering: ClusteringService;
  enrichment: EnrichmentService;
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
  /**
   * One row per story rather than one per report of it. On by default: a
   * story syndicated to eight outlets occupying eight rows is the thing
   * clustering exists to stop. Has no effect while clustering is off, since
   * then nothing belongs to a cluster.
   */
  collapse: z.stringbool().default(true),
});

export function createApi(deps: ApiDeps) {
  // Aliased: `sql` in this file is Drizzle's template tag, imported above.
  const { db, sql: rawSql, fetcher, config, embeddings, interest, clustering, enrichment } = deps;
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
    const sourceId = c.req.param("id");
    if (!z.uuid().safeParse(sourceId).success) return c.json({ error: "not found" }, 404);
    // The clusters this subscription's items belong to are refreshed in the
    // same transaction as the deletion. A representative carried only by this
    // subscription can no longer be listed, and the collapsed timeline shows a
    // story through its representative alone -- so without the refresh the
    // whole story, reports from feeds still followed included, would vanish.
    const deleted = await rawSql.begin(async (tx) => {
      const affected = await clustersOfSource(tx, sourceId);
      const rows = await tx`DELETE FROM sources WHERE id = ${sourceId}::uuid RETURNING id`;
      for (const clusterId of affected) await refreshCluster(tx, clusterId);
      return rows.length;
    });
    if (deleted === 0) return c.json({ error: "not found" }, 404);
    return c.json({ deleted });
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
    // Within one subscription there is nothing to collapse: a story never holds
    // two items from the same feed, so collapsing could only hide this feed's
    // own reports behind another outlet's representative.
    const collapse = parsed.data.collapse && !sourceId;
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
        collapse,
      });
      if (page.scoring.active) {
        return c.json({ items: await withModelSummaries(page.items), scoring: page.scoring });
      }
      const fallback = await listRecent({ unread, limit, sourceId, collapse });
      return c.json({
        items: await withModelSummaries(
          fallback.map((item) => ({
            ...item,
            interest: 0,
            affinitySimilarity: 0,
            exploration: false,
          })),
        ),
        scoring: page.scoring,
      });
    }

    return c.json({
      items: await withModelSummaries(await listRecent({ unread, limit, sourceId, collapse })),
    });
  });

  /**
   * Carry the model's summary where there is one, and say which it is.
   *
   * A listing returns whatever the feed supplied, which is not what enrichment
   * is for. The current summary replaces it when one exists, and
   * `summarySource` says which of the two the reader is looking at -- without
   * it "is enrichment doing anything" cannot be answered from a response, which
   * is the failure `mode` and `reason` exist to prevent on a search (D35).
   *
   * "feed" therefore covers an item with no summary at all: the feed is the
   * only source that could have supplied one, and no summary is not a summary
   * from the model.
   */
  async function withModelSummaries<T extends { id: string; summary: string | null }>(rows: T[]) {
    const summaries = await enrichment.currentSummaries(rows.map((row) => row.id));
    return rows.map((row) => {
      const fromModel = summaries.get(row.id);
      return {
        ...row,
        summary: fromModel ?? row.summary,
        summarySource: fromModel === undefined ? ("feed" as const) : ("model" as const),
      };
    });
  }

  /** The reverse-chronological listing, shared by the plain and degraded paths. */
  async function listRecent(options: {
    unread: boolean;
    limit: number;
    sourceId?: string | undefined;
    collapse: boolean;
  }) {
    const { unread, limit, sourceId, collapse } = options;

    const conditions = [];
    if (unread) conditions.push(isNull(itemState.readAt));
    if (sourceId) conditions.push(eq(itemSources.sourceId, sourceId));
    // A story row is an item no cluster has claimed, or its cluster's stored
    // representative. Why a fixed representative rather than DISTINCT ON is
    // written beside STORY_ROW in packages/db/src/interest.ts.
    if (collapse) {
      conditions.push(
        or(isNull(itemClusters.clusterId), eq(clusters.representativeItemId, items.id)),
      );
    }

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
        // Same count as LISTED_CLUSTER_SIZE in @tsuzuri/db's interest.ts.
        clusterSize: sql<number>`(CASE WHEN ${itemClusters.clusterId} IS NULL THEN 1 ELSE (
          SELECT count(*) FROM item_clusters m
          WHERE m.cluster_id = ${itemClusters.clusterId}
            AND EXISTS (SELECT 1 FROM item_sources s WHERE s.item_id = m.item_id)
        ) END)::int`,
      })
      .from(items)
      .innerJoin(itemSources, eq(itemSources.itemId, items.id))
      .leftJoin(
        itemState,
        and(eq(itemState.itemId, items.id), eq(itemState.userId, DEFAULT_USER_ID)),
      )
      .leftJoin(itemClusters, eq(itemClusters.itemId, items.id))
      .leftJoin(clusters, eq(clusters.id, itemClusters.clusterId))
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
    // What a model said about it, beside the article. Writing a translation and
    // a set of tags nobody can read is not enrichment, it is cost.
    return c.json({ item: row, enrichment: await enrichment.currentFor(resolved.id) });
  });

  /** Mark read / unread / starred. All of these feed interest scoring later. */
  app.post("/items/:id/state", async (c) => {
    const body = z
      .object({
        read: z.boolean().optional(),
        starred: z.boolean().optional(),
        skipped: z.boolean().optional(),
        /**
         * `cluster` (the default) carries a read to every report of the same
         * story (D24), so a story read through search or MCP does not stay
         * unread in the collapsed list. `item` is for a client showing every
         * report. Only the read is carried: a star or a skip is about the
         * article in front of you. Carried reads do not inflate the interest
         * profile, which folds a cluster into one signal.
         */
        scope: z.enum(["item", "cluster"]).default("cluster"),
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

    const others =
      body.data.scope === "cluster" && body.data.read !== undefined
        ? (await clusterMemberIds(rawSql, resolved.id)).filter((id) => id !== resolved.id)
        : [];

    // One transaction, so a propagation that fails does not leave the named
    // item read and the rest of its story unread behind a 500.
    const row = await db.transaction(async (tx) => {
      const [written] = await tx
        .insert(itemState)
        .values({ userId: DEFAULT_USER_ID, itemId: resolved.id, ...patch })
        .onConflictDoUpdate({
          target: [itemState.userId, itemState.itemId],
          set: { ...patch, updatedAt: now },
        })
        .returning();

      if (others.length > 0) {
        await tx
          .insert(itemState)
          .values(
            others.map((itemId) => ({
              userId: DEFAULT_USER_ID,
              itemId,
              readAt: body.data.read ? now : null,
            })),
          )
          .onConflictDoUpdate({
            target: [itemState.userId, itemState.itemId],
            set: {
              // A report already read keeps its own read time, so unfolding
              // the story later still shows when each report was read. The
              // interest profile folds the story and takes its latest read.
              readAt: body.data.read ? sql`COALESCE(${itemState.readAt}, excluded.read_at)` : null,
              updatedAt: now,
            },
          });
      }
      return written;
    });

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
      results: await withModelSummaries(result.hits),
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

  /**
   * Re-run enrichment over history.
   *
   * `since` is required rather than defaulted: an unbounded rerun would spend
   * the whole corpus in one request, and every caller who wants one knows what
   * period they mean. Awaited, like the profile rebuild, because it runs in
   * bounded time and its result is the answer.
   */
  app.post("/enrich", async (c) => {
    const parsed = z
      .object({
        /**
         * Trimmed before the length check, so a request that sends only
         * whitespace is a 400 here rather than an absent period reaching
         * parseSince as a null the caller then has to re-check.
         */
        since: z.string().trim().min(1),
        kind: z.enum(["summary", "translation", "tags"]).optional(),
        /**
         * Re-run items the store already holds something for, ignoring any
         * retry backoff.
         *
         * A JSON boolean because that is what the CLI sends; z.stringbool()
         * would accept `force=true` from a query string and reject the boolean
         * every other client sends.
         */
        force: z.boolean().default(false),
        /**
         * The instant a forced rerun measures against, as an ISO 8601 instant
         * or a duration such as 1h.
         *
         * The value the last response returned, which is what makes a rerun
         * continue past the articles the previous one wrote rather than
         * re-picking them. Accepted as a string rather than as a Date so the
         * error for an unreadable one is the same 400 an unreadable `since`
         * gets.
         */
        forceBefore: z.string().trim().min(1).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.treeifyError(parsed.error) }, 400);

    let since: Date;
    let forceBefore: Date | null;
    try {
      // Trimmed and non-empty above, so parseSince answers with a Date or
      // throws; it returns null only for an absent value.
      since = parseSince(parsed.data.since) as Date;
      forceBefore = parseSince(parsed.data.forceBefore) as Date | null;
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    // A cutoff in the future counts nothing as answered, so every call would
    // re-pick the same articles and never get past them.
    if (forceBefore && forceBefore.getTime() > Date.now()) {
      return c.json({ error: "forceBefore is in the future" }, 400);
    }

    try {
      // 200 with the counts even when the run was cut short: a configuration
      // error after some items were written is not a request that failed, and
      // answering 500 would tell the caller nothing was enriched.
      return c.json(
        await enrichment.runOver({
          since,
          kind: parsed.data.kind ?? null,
          force: parsed.data.force,
          forceBefore,
        }),
      );
    } catch (error) {
      // As with the profile rebuild: only a precondition is the caller's fault,
      // and a database failure answered as 400 would tell a client its request
      // was malformed when retrying would have worked.
      if (error instanceof EnrichmentPreconditionError) {
        return c.json({ error: error.message }, 400);
      }
      console.error("enrichment rerun failed:", error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  /**
   * Delete enrichments that are not the current ones.
   *
   * No parameter saying which to keep, and that is the whole point: a prune
   * that could be asked to keep nothing would delete every answer this
   * installation has, including the comparison between prompt versions that
   * the key exists to make possible (D27). The CLI still makes the person type
   * `--keep-current`, because naming the intent is worth something even when
   * the API cannot express the alternative.
   */
  app.post("/enrich/prune", async (c) => {
    try {
      return c.json({ pruned: await enrichment.prune() });
    } catch (error) {
      if (error instanceof EnrichmentPreconditionError) {
        return c.json({ error: error.message }, 400);
      }
      console.error("enrichment prune failed:", error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  /** Translate one body, on request. See D30 for why this is not automatic. */
  app.post("/items/:id/translate", async (c) => {
    const resolved = await resolveItemId(c.req.param("id"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

    try {
      return c.json(await enrichment.translateBody(resolved.id));
    } catch (error) {
      if (error instanceof EnrichmentPreconditionError) {
        return c.json({ error: error.message }, 400);
      }
      console.error("translation failed:", error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  /**
   * Candidates the model has proposed often enough to be worth a decision.
   *
   * Candidates only: an approved tag is not waiting for anybody and a rejected
   * one has already been answered. Nothing here is a tag yet, which is why the
   * response says `tags` and the command says review (D28).
   */
  app.get("/tags", async (c) => c.json({ tags: await enrichment.tagsForReview() }));

  app.post("/tags/:slug/approve", async (c) => {
    const moved = await moveTag(c.req.param("slug"), "approved");
    return moved ? c.json(moved) : c.json({ error: "not found" }, 404);
  });

  app.post("/tags/:slug/reject", async (c) => {
    const moved = await moveTag(c.req.param("slug"), "rejected");
    return moved ? c.json(moved) : c.json({ error: "not found" }, 404);
  });

  /** Move a tag, or report that there is no such tag to move. */
  async function moveTag(slug: string, status: TagStatus) {
    if (!(await enrichment.setTagStatus(slug, status))) return null;
    return { tag: { slug, status } };
  }

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
        clustering: await clustering.status(),
        llm: await enrichment.status(),
        headless: { enabled: false, reason: "not implemented until P6" },
      },
      sourceKinds: ["feed"],
    });
  });

  return app;
}
