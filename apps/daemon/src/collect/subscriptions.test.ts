import { describe, expect, test } from "bun:test";
import type { SourceRow } from "@tsuzuri/db";

import { toSeedEntries } from "./subscriptions.ts";

const row = (extra: Partial<SourceRow>): SourceRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  userId: "u",
  kind: "feed",
  url: "https://a.example/feed.xml",
  title: null,
  siteUrl: null,
  config: {},
  status: "active",
  etag: "e1",
  lastModified: "Mon, 02 Nov 2026 00:00:00 GMT",
  contentHash: "h1",
  fetchIntervalSeconds: 3600,
  nextFetchAt: new Date("2026-11-08T14:00:00.000Z"),
  lastFetchedAt: new Date("2026-11-08T13:00:00.000Z"),
  lastSuccessAt: null,
  consecutiveFailures: 2,
  lastError: "HTTP 503",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...extra,
});

describe("toSeedEntries", () => {
  test("carries the fetch-state columns, with timestamps as ISO strings and null kept", () => {
    expect(toSeedEntries([row({ status: "degraded" })])).toEqual({
      "11111111-1111-1111-1111-111111111111": {
        etag: "e1",
        lastModified: "Mon, 02 Nov 2026 00:00:00 GMT",
        contentHash: "h1",
        nextFetchAt: "2026-11-08T14:00:00.000Z",
        lastFetchedAt: "2026-11-08T13:00:00.000Z",
        lastSuccessAt: null,
        consecutiveFailures: 2,
        lastError: "HTTP 503",
        status: "degraded",
      },
    });
  });

  test("leaves a disabled row out, since disabled is not a saved collector status", () => {
    const entries = toSeedEntries([
      row({ id: "a", status: "disabled" }),
      row({ id: "b", status: "unsupported" }),
    ]);
    expect(Object.keys(entries)).toEqual(["b"]);
  });
});
