import type { FetchResult, SourceKind } from "./types.ts";

/**
 * What a source knows about its own last fetch.
 *
 * Passed in rather than read from the database by the source itself, so that
 * sources stay pure functions of their input and can be tested without a DB.
 */
export type FetchState = {
  etag: string | null;
  lastModified: string | null;
  /** Hash of the last body we actually processed. */
  contentHash: string | null;
};

/** Everything a source implementation is allowed to reach for. */
export type SourceContext = {
  /** The subscription's configured URL. */
  url: string;
  /** Free-form per-source configuration, validated by the implementation. */
  config: Record<string, unknown>;
  state: FetchState;
  /** Fetch with the pipeline's timeout, user agent and rate limiting applied. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
};

/**
 * A way of turning a subscription into items.
 *
 * The pipeline holds only this interface. Feeds, external generators,
 * declarative rules and TypeScript plugins are all just implementations, which
 * is what keeps "add a new kind of source" from meaning "edit the core".
 */
export type Source = {
  kind: SourceKind;
  /** Stable identifier, unique within a kind. */
  id: string;
  /** Decide whether this implementation handles a given URL. Used at subscribe time. */
  matches?: (url: string) => boolean;
  fetchItems: (ctx: SourceContext) => Promise<FetchResult>;
};

/** Identity helper that gives plugin authors type checking without a build step. */
export function defineSource(source: Source): Source {
  return source;
}
