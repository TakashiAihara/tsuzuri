import { describe, expect, test } from "bun:test";

import { parseSince } from "./search-params.ts";

const now = new Date("2026-08-10T12:00:00Z");

describe("parseSince", () => {
  test("absent means no lower bound", () => {
    expect(parseSince(undefined, now)).toBeNull();
    expect(parseSince(null, now)).toBeNull();
    expect(parseSince("", now)).toBeNull();
    expect(parseSince("   ", now)).toBeNull();
  });

  test("reads a duration back from now", () => {
    expect(parseSince("7d", now)?.toISOString()).toBe("2026-08-03T12:00:00.000Z");
    expect(parseSince("2h", now)?.toISOString()).toBe("2026-08-10T10:00:00.000Z");
    expect(parseSince("30m", now)?.toISOString()).toBe("2026-08-10T11:30:00.000Z");
    expect(parseSince("1w", now)?.toISOString()).toBe("2026-08-03T12:00:00.000Z");
    expect(parseSince("45s", now)?.toISOString()).toBe("2026-08-10T11:59:15.000Z");
  });

  test("tolerates spacing and case", () => {
    expect(parseSince("7 D", now)?.toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });

  test("reads an absolute instant", () => {
    expect(parseSince("2026-08-01T00:00:00Z", now)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(parseSince("2026-08-01", now)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  test("refuses a duration too large to be a date", () => {
    // Enough digits parse to Infinity, which makes an invalid Date. Returned,
    // it survives this function and fails later where toISOString() throws,
    // turning a bad input into a 500 instead of the 400 it is.
    expect(() => parseSince(`${"9".repeat(400)}d`, now)).toThrow(/could not read/);
    expect(() => parseSince("99999999999999999999d", now)).toThrow(/could not read/);
  });

  test("refuses something it cannot read rather than silently widening the search", () => {
    // Falling back to null here would quietly turn "last week" into "all of
    // history", which is the opposite of what was asked for.
    expect(() => parseSince("last tuesday", now)).toThrow(/could not read/);
    expect(() => parseSince("7 fortnights", now)).toThrow(/could not read/);
  });
});
