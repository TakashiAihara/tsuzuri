import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of packages/db/migrations/*.sql.
 *
 * The SQL files are the source of truth — they carry the extensions, the
 * pgroonga index and the CHECK constraints that this mirror cannot express.
 * schema.test.ts runs the migrations and then queries every table through
 * these definitions, so the two cannot drift silently.
 */

/** The row seeded by 0002_core_tables.sql for the single-user default. */
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    kind: text("kind").$type<"feed" | "external" | "rule" | "plugin">().notNull(),
    url: text("url").notNull(),
    title: text("title"),
    siteUrl: text("site_url"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),

    status: text("status")
      .$type<"active" | "degraded" | "unsupported" | "disabled">()
      .notNull()
      .default("active"),

    etag: text("etag"),
    lastModified: text("last_modified"),
    contentHash: text("content_hash"),

    fetchIntervalSeconds: integer("fetch_interval_seconds").notNull().default(3600),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }).notNull().defaultNow(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("sources_user_id_url_key").on(table.userId, table.url)],
);

export const items = pgTable(
  "items",
  {
    /** SHA-256 of the canonical URL. See @tsuzuri/core itemIdentity. */
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title"),
    author: text("author"),
    guid: text("guid"),

    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    publishedAtEstimated: boolean("published_at_estimated").notNull().default(false),

    contentHtml: text("content_html"),
    summary: text("summary"),
    searchText: text("search_text").notNull().default(""),
    rawHtmlKey: text("raw_html_key"),

    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("items_published_at").on(table.publishedAt)],
);

export const itemSources = pgTable(
  "item_sources",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.sourceId] })],
);

export const itemState = pgTable(
  "item_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    starredAt: timestamp("starred_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.itemId] })],
);

/**
 * The active embedding model. At most one row, enforced by the CHECK in the
 * migration that this mirror cannot express.
 *
 * There is no mirror for item_embeddings: its column type carries a dimension
 * that is only known once a model is configured, which no static definition can
 * state. That table is created and queried in raw SQL; see ./embeddings.ts.
 */
export const embeddingModel = pgTable("embedding_model", {
  id: boolean("id").primaryKey().default(true),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const embeddingFailures = pgTable(
  "embedding_failures",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id, { onDelete: "cascade" }),
    failures: integer("failures").notNull().default(1),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("embedding_failures_next_attempt").on(table.nextAttemptAt)],
);

/**
 * Duplicate clusters, from 0005_clustering.sql.
 *
 * item_simhash is deliberately not mirrored: its column is bit(64), which
 * Drizzle has no type for, and only packages/db/src/clustering.ts touches it,
 * in raw SQL, the same way item_embeddings is handled.
 */
export const clusters = pgTable("clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  representativeItemId: text("representative_item_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  size: integer("size").notNull().default(1),
  firstPublishedAt: timestamp("first_published_at", { withTimezone: true }).notNull(),
  lastPublishedAt: timestamp("last_published_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const itemClusters = pgTable(
  "item_clusters",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    /** Null for the member that founded the cluster. */
    matchedBy: text("matched_by", { enum: ["embedding", "simhash", "both"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("item_clusters_by_cluster").on(table.clusterId)],
);

/**
 * What a chat model said about an item, from 0006_enrichments.sql.
 *
 * model and prompt_version are part of the key, so a prompt change writes
 * beside the previous answer rather than over it. The CHECK limiting kind to
 * the three there are lives in the migration; this mirror states what it can.
 */
export const enrichments = pgTable(
  "enrichments",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"summary" | "translation" | "tags">().notNull(),

    /** The language a translation targets; empty for every other kind. */
    lang: text("lang").notNull().default(""),

    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.kind, table.lang, table.model, table.promptVersion],
    }),
    index("enrichments_by_item").on(table.itemId, table.kind),
  ],
);

export const enrichmentFailures = pgTable(
  "enrichment_failures",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"summary" | "translation" | "tags">().notNull(),
    failures: integer("failures").notNull().default(1),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.kind] })],
);

/**
 * The closed set of tags a model may choose from.
 *
 * Deliberately not seeded: an empty vocabulary runs tagging in suggest-only
 * mode until somebody approves its first tags (D28).
 */
export const tagVocabulary = pgTable(
  "tag_vocabulary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    status: text("status")
      .$type<"approved" | "candidate" | "rejected">()
      .notNull()
      .default("candidate"),
    observations: integer("observations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (table) => [unique("tag_vocabulary_slug_key").on(table.slug)],
);

export const itemTags = pgTable(
  "item_tags",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tagVocabulary.id, { onDelete: "cascade" }),
    source: text("source").$type<"model" | "manual">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.tagId] }),
    index("item_tags_by_tag").on(table.tagId),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
export type ItemStateRow = typeof itemState.$inferSelect;
