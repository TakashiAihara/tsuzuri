import { describe, expect, test } from "bun:test";

import { readParquet, type Schema, writeParquet } from "./parquet.ts";

const SCHEMA = {
  id: "STRING",
  published_at: "TIMESTAMP",
  published_at_estimated: "BOOLEAN",
  schema_version: "INT32",
  score: "DOUBLE",
} satisfies Schema;

describe("writeParquet / readParquet", () => {
  test("round-trips every column type, nulls included", async () => {
    const rows = [
      {
        id: "a",
        published_at: new Date("2026-11-08T01:02:03.456Z"),
        published_at_estimated: false,
        schema_version: 1,
        score: 0.25,
      },
      { id: "b", published_at: null, published_at_estimated: true, schema_version: 7, score: null },
    ];

    const back = await readParquet(writeParquet(rows, SCHEMA));

    expect(back).toHaveLength(2);
    expect(back[0]?.id).toBe("a");
    expect(back[0]?.published_at).toEqual(new Date("2026-11-08T01:02:03.456Z"));
    expect(back[0]?.published_at_estimated).toBe(false);
    expect(back[0]?.schema_version).toBe(1);
    expect(back[0]?.score).toBe(0.25);
    expect(back[1]?.id).toBe("b");
    expect(back[1]?.published_at).toBeNull();
    expect(back[1]?.published_at_estimated).toBe(true);
    expect(back[1]?.schema_version).toBe(7);
    expect(back[1]?.score).toBeNull();
  });

  test("keeps Japanese text and long HTML intact", async () => {
    const html = `<p>${"市議会は新しい交通計画を承認した。".repeat(500)}</p>`;
    const back = await readParquet(
      writeParquet([{ id: "記事-1", body: html }], { id: "STRING", body: "STRING" }),
    );
    expect(back).toEqual([{ id: "記事-1", body: html }]);
  });

  test("writes a column a row leaves out as null", async () => {
    const back = await readParquet(writeParquet([{ id: "a" }], { id: "STRING", title: "STRING" }));
    expect(back).toEqual([{ id: "a", title: null }]);
  });

  test("refuses a row carrying a column the schema does not declare", () => {
    expect(() => writeParquet([{ id: "a", stray: "x" }], { id: "STRING" })).toThrow(
      'column "stray"',
    );
  });

  test("refuses a value of the wrong type instead of coercing it", () => {
    expect(() => writeParquet([{ n: "12" }], { n: "INT32" })).toThrow('column "n"');
    expect(() => writeParquet([{ at: "2026-11-08" }], { at: "TIMESTAMP" })).toThrow('column "at"');
    expect(() => writeParquet([{ ok: 1 }], { ok: "BOOLEAN" })).toThrow('column "ok"');
  });

  test("writes zero rows as a readable file with the declared columns", async () => {
    const bytes = writeParquet([], { id: "STRING" });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(await readParquet(bytes)).toEqual([]);
  });

  test("preserves row order", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `id-${String(999 - i).padStart(4, "0")}`,
    }));
    const back = await readParquet(writeParquet(rows, { id: "STRING" }));
    expect(back.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });
});
