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

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
export type ItemStateRow = typeof itemState.$inferSelect;
