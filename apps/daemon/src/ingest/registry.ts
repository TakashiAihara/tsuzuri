import type { Source, SourceKind } from "@tsuzuri/core";

import { feedSource } from "./feed-source.ts";

/**
 * Source implementations available to the pipeline, keyed by kind.
 *
 * P1 ships only the feed reader. Declarative YAML rules, TypeScript plugins and
 * external generators register here as they land, and nothing outside this file
 * needs to change when they do — which is the whole point of the Source
 * interface.
 */
export const registry = new Map<SourceKind, Source>([["feed", feedSource]]);
