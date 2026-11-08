import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parquetMetadata } from "hyparquet";

import {
  type ColumnType as ColumnTypeName,
  readParquet,
  type Schema,
  writeParquet,
} from "./parquet.ts";

function metadataOf(bytes: Uint8Array) {
  return parquetMetadata(bytes.slice().buffer);
}

describe("file format", () => {
  test("pins SNAPPY compression and millisecond INT64 timestamps, because files are a public contract", () => {
    const meta = metadataOf(
      writeParquet([{ at: new Date(0), s: "x" }], { at: "TIMESTAMP", s: "STRING" }),
    );
    expect(meta.row_groups[0]?.columns.map((column) => column.meta_data?.codec)).toEqual([
      "SNAPPY",
      "SNAPPY",
    ]);
    const at = meta.schema.find((element) => element.name === "at");
    expect(at?.type).toBe("INT64");
    expect(at?.converted_type).toBe("TIMESTAMP_MILLIS");
  });

  test("a zero-row file still declares every schema column", () => {
    const meta = metadataOf(writeParquet([], { id: "STRING", n: "INT32" }));
    expect(meta.schema.slice(1).map((element) => element.name)).toEqual(["id", "n"]);
  });

  // fixtures/zstd.parquet was written by DuckDB:
  // COPY (SELECT 'z-' || i::VARCHAR AS id, i AS n FROM range(3) t(i)) TO 'zstd.parquet' (FORMAT parquet, COMPRESSION zstd)
  test("reads a zstd file written by another tool", async () => {
    const bytes = new Uint8Array(
      await Bun.file(join(import.meta.dir, "fixtures/zstd.parquet")).arrayBuffer(),
    );
    expect(await readParquet(bytes)).toEqual([
      { id: "z-0", n: 0n },
      { id: "z-1", n: 1n },
      { id: "z-2", n: 2n },
    ]);
  });

  test("reads from a view that does not start at the beginning of its buffer", async () => {
    const file = writeParquet([{ id: "a" }], { id: "STRING" });
    const padded = new Uint8Array(file.byteLength + 7);
    padded.set(file, 7);
    expect(await readParquet(padded.subarray(7))).toEqual([{ id: "a" }]);
  });
});

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
    const refused: [ColumnTypeName, unknown][] = [
      ["INT32", "12"],
      ["INT32", 1.5],
      ["INT32", 2147483648],
      ["INT32", -2147483649],
      ["TIMESTAMP", "2026-11-08"],
      ["TIMESTAMP", 0],
      ["TIMESTAMP", new Date(Number.NaN)],
      ["BOOLEAN", 1],
      ["STRING", 5],
      ["DOUBLE", "1.5"],
      ["DOUBLE", Number.NaN],
      ["DOUBLE", Number.POSITIVE_INFINITY],
      ["DOUBLE", Number.NEGATIVE_INFINITY],
    ];
    for (const [type, value] of refused) {
      expect(() => writeParquet([{ v: value }], { v: type }), `${type} ${String(value)}`).toThrow(
        `column "v": expected ${type}`,
      );
    }
  });

  test("accepts both INT32 bounds", async () => {
    const back = await readParquet(
      writeParquet([{ n: 2147483647 }, { n: -2147483648 }], { n: "INT32" }),
    );
    expect(back).toEqual([{ n: 2147483647 }, { n: -2147483648 }]);
  });

  test("names the offending row by its 0-based index in the input array", () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: "4" }, { n: 5 }];
    expect(() => writeParquet(rows, { n: "INT32" })).toThrow('row 3, column "n"');
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
