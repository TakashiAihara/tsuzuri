import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { parquetWriteBuffer } from "hyparquet-writer";

export type ColumnType = "STRING" | "TIMESTAMP" | "BOOLEAN" | "INT32" | "DOUBLE";
export type Schema = Record<string, ColumnType>;

// A column a row leaves out — the key absent, or the value null or undefined —
// is written as null. Every other value is checked against the declared column
// type and never coerced on a type mismatch: a string where INT32 belongs is a
// bug in the caller, not something to fix up.
const validators: Record<ColumnType, (value: unknown) => boolean> = {
  STRING: (value) => typeof value === "string",
  TIMESTAMP: (value) => value instanceof Date && !Number.isNaN(value.getTime()),
  BOOLEAN: (value) => typeof value === "boolean",
  INT32: (value) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647,
  DOUBLE: (value) => typeof value === "number" && Number.isFinite(value),
};

function checkValue(rowIndex: number, name: string, type: ColumnType, value: unknown): void {
  if (validators[type](value)) return;
  const actual =
    value instanceof Date
      ? Number.isNaN(value.getTime())
        ? "invalid Date"
        : "Date"
      : typeof value;
  // rowIndex is the row's 0-based position in the input array.
  throw new Error(`row ${rowIndex}, column "${name}": expected ${type}, got ${actual}`);
}

/** Write row objects as a single Parquet file. TIMESTAMP columns take Date. */
export function writeParquet(rows: Record<string, unknown>[], schema: Schema): Uint8Array {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(schema, key)) {
        throw new Error(`column "${key}" is not declared in the schema`);
      }
    }
  }

  const columnData = Object.entries(schema).map(([name, type]) => ({
    name,
    type,
    data: rows.map((row, rowIndex) => {
      const value = row[name];
      if (value === null || value === undefined) return null;
      checkValue(rowIndex, name, type, value);
      return value;
    }),
  }));

  return new Uint8Array(parquetWriteBuffer({ columnData, codec: "SNAPPY" }));
}

/** Read a Parquet file back to row objects; TIMESTAMP columns come back as Date. */
export async function readParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const file = {
    byteLength: bytes.byteLength,
    // Slice the backing buffer, not the view: Buffer.slice (what storage.get
    // returns) is subarray semantics and .buffer on it would hand back the
    // whole pool, while Uint8Array.slice copies and needs no offset math.
    slice: (start: number, end?: number) =>
      bytes.buffer.slice(
        bytes.byteOffset + start,
        bytes.byteOffset + (end ?? bytes.byteLength),
      ) as ArrayBuffer,
  };
  return parquetReadObjects({ file, compressors });
}
