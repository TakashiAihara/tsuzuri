import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { parquetWriteBuffer } from "hyparquet-writer";

export type ColumnType = "STRING" | "TIMESTAMP" | "BOOLEAN" | "INT32" | "DOUBLE";
export type Schema = Record<string, ColumnType>;

/**
 * Values are checked against the declared column type and never coerced:
 * a string where INT32 belongs is a bug in the caller, not something to fix up.
 * Columns a row leaves out are written as null.
 */
function checkValue(name: string, type: ColumnType, value: unknown): void {
  const valid =
    type === "STRING"
      ? typeof value === "string"
      : type === "BOOLEAN"
        ? typeof value === "boolean"
        : type === "DOUBLE"
          ? typeof value === "number"
          : type === "INT32"
            ? typeof value === "number" &&
              Number.isInteger(value) &&
              value >= -2147483648 &&
              value <= 2147483647
            : value instanceof Date && !Number.isNaN(value.getTime());
  if (!valid) {
    const actual =
      value instanceof Date
        ? Number.isNaN(value.getTime())
          ? "invalid Date"
          : "Date"
        : typeof value;
    throw new Error(`column "${name}": expected ${type}, got ${actual}`);
  }
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
    data: rows.map((row) => {
      const value = row[name];
      if (value === null || value === undefined) return null;
      checkValue(name, type, value);
      return value;
    }),
  }));

  return new Uint8Array(parquetWriteBuffer({ columnData }));
}

/** Read a Parquet file back to row objects; TIMESTAMP columns come back as Date. */
export async function readParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const file = {
    byteLength: bytes.byteLength,
    slice: (start: number, end?: number) => bytes.slice(start, end).buffer,
  };
  return parquetReadObjects({ file, compressors });
}
