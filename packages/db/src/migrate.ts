import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Apply pending SQL migrations in filename order.
 *
 * Hand-written SQL rather than generated migrations because the schema needs
 * things a generator will not emit: CREATE EXTENSION, a pgroonga index, and
 * CHECK constraints. Each file runs inside a transaction, so a failure leaves
 * the database on the last complete migration rather than half-way through one.
 */
export async function migrate(sql: postgres.Sql): Promise<MigrationResult> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const alreadyApplied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name),
  );

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      result.skipped.push(file);
      continue;
    }

    const statements = await readFile(join(MIGRATIONS_DIR, file), "utf8");

    await sql.begin(async (tx) => {
      await tx.unsafe(statements);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });

    result.applied.push(file);
  }

  return result;
}
