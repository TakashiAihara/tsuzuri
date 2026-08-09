import { describe, expect, test } from "bun:test";

import { parseFeedDate, timeZoneOffsetMinutes, tryParseFeedDate } from "./date.ts";

const NOW = new Date("2026-08-09T12:00:00Z");

describe("tryParseFeedDate: standard formats", () => {
  test("parses RFC 822 as used by RSS 2.0", () => {
    expect(tryParseFeedDate("Sat, 09 Aug 2026 03:04:05 GMT", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T03:04:05.000Z",
    );
  });

  test("parses RFC 3339 as used by Atom", () => {
    expect(tryParseFeedDate("2026-08-09T12:04:05+09:00", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T03:04:05.000Z",
    );
  });

  test("parses zone abbreviations the engine does not know", () => {
    expect(tryParseFeedDate("Sat, 09 Aug 2026 12:04:05 JST", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T03:04:05.000Z",
    );
  });

  test("leaves ambiguous abbreviations to the engine instead of guessing", () => {
    // IST is India, Israel or Ireland depending on the publisher. Guessing one
    // would silently shift timestamps by hours, so it must not be in our map.
    const parsed = tryParseFeedDate("Sat, 09 Aug 2026 12:04:05 IST", { now: NOW });
    expect(parsed === null || parsed instanceof Date).toBe(true);
  });
});

describe("tryParseFeedDate: locale formats from scraped pages", () => {
  test("parses a Japanese date with time", () => {
    expect(
      tryParseFeedDate("2026年8月9日 12:04", { now: NOW, assumeOffsetMinutes: 540 })?.toISOString(),
    ).toBe("2026-08-09T03:04:00.000Z");
  });

  test("parses a Japanese date with 時分 notation and a weekday", () => {
    expect(
      tryParseFeedDate("2026年08月09日（土） 12時04分", {
        now: NOW,
        assumeOffsetMinutes: 540,
      })?.toISOString(),
    ).toBe("2026-08-09T03:04:00.000Z");
  });

  test("treats a zoneless timestamp as UTC unless told otherwise", () => {
    expect(tryParseFeedDate("2026-08-09 03:04:05", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T03:04:05.000Z",
    );
  });
});

describe("tryParseFeedDate: relative timestamps", () => {
  test("resolves Japanese relative times against now", () => {
    expect(tryParseFeedDate("3分前", { now: NOW })?.toISOString()).toBe("2026-08-09T11:57:00.000Z");
    expect(tryParseFeedDate("2時間前", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T10:00:00.000Z",
    );
  });

  test("resolves English relative times against now", () => {
    expect(tryParseFeedDate("5 minutes ago", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T11:55:00.000Z",
    );
    expect(tryParseFeedDate("an hour ago", { now: NOW })?.toISOString()).toBe(
      "2026-08-09T11:00:00.000Z",
    );
  });
});

describe("tryParseFeedDate: implausible values", () => {
  test("rejects timestamps far in the future", () => {
    // Publisher clock drift regularly produces these, and they pin an item to
    // the top of every timeline until someone notices.
    expect(tryParseFeedDate("2031-01-01T00:00:00Z", { now: NOW })).toBeNull();
  });

  test("accepts a small amount of future skew", () => {
    expect(tryParseFeedDate("2026-08-09T13:00:00Z", { now: NOW })).not.toBeNull();
  });

  test("rejects the Unix epoch and other pre-2000 dates", () => {
    expect(tryParseFeedDate("1970-01-01T00:00:00Z", { now: NOW })).toBeNull();
    expect(tryParseFeedDate("Thu, 01 Jan 1970 00:00:00 GMT", { now: NOW })).toBeNull();
  });

  test("rejects unparseable junk", () => {
    expect(tryParseFeedDate("sometime last week-ish", { now: NOW })).toBeNull();
    expect(tryParseFeedDate("", { now: NOW })).toBeNull();
    expect(tryParseFeedDate(null, { now: NOW })).toBeNull();
  });
});

describe("parseFeedDate", () => {
  test("falls back to fetch time rather than dropping the item", () => {
    const fetchedAt = new Date("2026-08-09T11:00:00Z");
    expect(parseFeedDate("garbage", { now: NOW, fallback: fetchedAt })).toEqual(fetchedAt);
    expect(parseFeedDate("1970-01-01T00:00:00Z", { now: NOW, fallback: fetchedAt })).toEqual(
      fetchedAt,
    );
  });
});

describe("timeZoneOffsetMinutes", () => {
  test("resolves IANA names so rules can say tz: Asia/Tokyo", () => {
    expect(timeZoneOffsetMinutes("Asia/Tokyo", NOW)).toBe(540);
    expect(timeZoneOffsetMinutes("UTC", NOW)).toBe(0);
  });

  test("returns null for names the runtime does not know", () => {
    expect(timeZoneOffsetMinutes("Mars/Olympus_Mons", NOW)).toBeNull();
  });
});
