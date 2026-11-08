import type { Schema } from "./parquet.ts";

/**
 * Version of the item schema written to items/*.parquet. Bump it when the
 * columns change; loaders pick the reader by this number.
 */
export const ITEM_SCHEMA_VERSION = 1;

/**
 * The public contract for one item row (docs/parquet-schema.md). Producers
 * outside this repository write the same column names and types; readers match
 * columns by name, so the order here is only the order tsuzuri writes.
 */
export const ITEM_SCHEMA: Schema = {
  id: "STRING",
  url: "STRING",
  canonical_url: "STRING",
  title: "STRING",
  author: "STRING",
  guid: "STRING",
  published_at: "TIMESTAMP",
  published_at_estimated: "BOOLEAN",
  content_html: "STRING",
  summary: "STRING",
  fetched_at: "TIMESTAMP",
  source_id: "STRING",
  schema_version: "INT32",
  // The item as the source produced it, serialised. JSON in a STRING column
  // keeps the column set stable no matter what a source returns.
  raw: "STRING",
};

export type ItemRow = {
  id: string;
  url: string;
  canonical_url: string;
  title: string | null;
  author: string | null;
  guid: string | null;
  published_at: Date;
  published_at_estimated: boolean;
  content_html: string | null;
  summary: string | null;
  fetched_at: Date;
  source_id: string;
  schema_version: number;
  raw: string | null;
};
