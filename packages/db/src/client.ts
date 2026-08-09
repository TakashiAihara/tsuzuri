import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

export type Database = ReturnType<typeof createDatabase>["db"];

export type CreateDatabaseOptions = {
  /** libpq-style connection string. */
  url: string;
  /** Connection pool size. The daemon is the only writer, so this stays small. */
  max?: number;
};

/**
 * Open a connection pool and a Drizzle handle over it.
 *
 * Returns the raw postgres.js client too: pgroonga's operators and pgvector's
 * distance functions are expressed as raw SQL, and having the client to hand
 * avoids wrapping everything in Drizzle's sql`` template just to get there.
 *
 * The caller owns the lifetime and must call close().
 */
export function createDatabase(options: CreateDatabaseOptions) {
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    // Feed bodies and article HTML are large; leaving prepared statements on
    // for one-shot admin queries buys nothing.
    prepare: true,
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
