/**
 * Date parsing for feeds and scraped pages.
 *
 * RSS 2.0 says RFC 822, Atom says RFC 3339, and the real world says whatever
 * the publisher's template produced: "2026年8月9日 12:57", "3分前",
 * "Sat, 09 Aug 2026 12:57:49 JST", or nothing at all. On top of that,
 * publishers' clocks drift, so feeds contain items dated years in the future
 * or at the Unix epoch.
 *
 * The contract here: parse generously, then refuse anything implausible so a
 * single bad timestamp cannot pin an item to the top (or bottom) of the
 * timeline forever.
 */

export type ParseFeedDateOptions = {
  /** Reference point for relative dates and the future guard. Defaults to new Date(). */
  now?: Date;
  /**
   * Offset in minutes applied to timestamps that carry no zone information.
   * Defaults to 0 (UTC). Scraped sources should pass the site's real zone;
   * feed formats almost always carry an explicit offset.
   */
  assumeOffsetMinutes?: number;
  /** Reject timestamps more than this far in the future. Defaults to 24 hours. */
  maxFutureMs?: number;
  /** Reject timestamps before this instant. Defaults to 2000-01-01T00:00:00Z. */
  minInstant?: Date;
};

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FUTURE_MS = 24 * HOUR_MS;
const DEFAULT_MIN_INSTANT = new Date("2000-01-01T00:00:00Z");

/**
 * Timezone abbreviations that JS engines do not understand but feeds still use.
 *
 * Only unambiguous abbreviations belong here. IST (India / Israel / Ireland)
 * and CST (US Central / China / Cuba) are deliberately absent: guessing wrong
 * is worse than falling through to the generic parser.
 */
const TIMEZONE_ABBREVIATIONS: Record<string, string> = {
  JST: "+0900",
  KST: "+0900",
  HKT: "+0800",
  SGT: "+0800",
  ICT: "+0700",
  MSK: "+0300",
  EEST: "+0300",
  EET: "+0200",
  CEST: "+0200",
  CET: "+0100",
  WEST: "+0100",
  BST: "+0100",
  WET: "+0000",
  AEST: "+1000",
  AEDT: "+1100",
  NZST: "+1200",
  NZDT: "+1300",
};

/**
 * "2026年8月9日", optionally followed by a weekday in brackets and a time.
 *
 * The time comes in two flavours that have to be matched separately, because
 * "12時04分" ends in a unit marker with no number after it while "12:04:05"
 * does not: colon form lands in groups 4-6, 時分秒 form in groups 7-9.
 */
const JAPANESE_DATE =
  /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*[(（][^)）]*[)）])?(?:\s*(?:(\d{1,2})\s*:\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?|(\d{1,2})\s*時\s*(\d{1,2})\s*分?(?:\s*(\d{1,2})\s*秒)?))?\s*$/;

/** "2026-08-09 12:57:49" and "2026/08/09 12:57" with no zone attached. */
const PLAIN_DATE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;

const RELATIVE_UNITS_MS: Record<string, number> = {
  second: 1000,
  minute: 60 * 1000,
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
  month: 30 * 24 * HOUR_MS,
  year: 365 * 24 * HOUR_MS,
};

const JAPANESE_RELATIVE = /^(\d+)\s*(秒|分|時間|日|週間|か?月|年)\s*前$/;
const ENGLISH_RELATIVE =
  /^(?:about\s+)?(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

const JAPANESE_UNIT_TO_MS: Record<string, number> = {
  秒: RELATIVE_UNITS_MS.second as number,
  分: RELATIVE_UNITS_MS.minute as number,
  時間: RELATIVE_UNITS_MS.hour as number,
  日: RELATIVE_UNITS_MS.day as number,
  週間: RELATIVE_UNITS_MS.week as number,
  月: RELATIVE_UNITS_MS.month as number,
  か月: RELATIVE_UNITS_MS.month as number,
  ヶ月: RELATIVE_UNITS_MS.month as number,
  年: RELATIVE_UNITS_MS.year as number,
};

function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function fromParts(parts: (string | undefined)[], assumeOffsetMinutes: number): Date | null {
  const [year, month, day, hour, minute, second] = parts;
  if (!year || !month || !day) return null;
  const iso =
    `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` +
    `T${(hour ?? "0").padStart(2, "0")}:${(minute ?? "0").padStart(2, "0")}` +
    `:${(second ?? "0").padStart(2, "0")}${offsetSuffix(assumeOffsetMinutes)}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseRelative(input: string, now: Date): Date | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === "just now" || input.trim() === "たった今" || input.trim() === "今") {
    return new Date(now);
  }
  if (normalized === "yesterday" || input.trim() === "昨日") {
    return new Date(now.getTime() - 24 * HOUR_MS);
  }

  const ja = JAPANESE_RELATIVE.exec(input.trim());
  if (ja?.[1] && ja[2]) {
    const unit = JAPANESE_UNIT_TO_MS[ja[2]];
    if (unit) return new Date(now.getTime() - Number(ja[1]) * unit);
  }

  const en = ENGLISH_RELATIVE.exec(normalized);
  if (en?.[1] && en[2]) {
    const count = en[1] === "a" || en[1] === "an" ? 1 : Number(en[1]);
    const unit = RELATIVE_UNITS_MS[en[2]];
    if (unit) return new Date(now.getTime() - count * unit);
  }

  return null;
}

/**
 * Parse a feed timestamp, returning null when it is unusable.
 *
 * "Unusable" covers both unparseable strings and timestamps that parsed fine
 * but are implausible (far future, pre-2000). Callers that need a value
 * regardless should use parseFeedDate, which falls back to fetch time.
 */
export function tryParseFeedDate(
  input: string | null | undefined,
  options: ParseFeedDateOptions = {},
): Date | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  const now = options.now ?? new Date();
  const assumeOffsetMinutes = options.assumeOffsetMinutes ?? 0;
  const maxFutureMs = options.maxFutureMs ?? DEFAULT_MAX_FUTURE_MS;
  const minInstant = options.minInstant ?? DEFAULT_MIN_INSTANT;

  const candidate = parseRelative(raw, now) ?? parseAbsolute(raw, assumeOffsetMinutes);

  if (!candidate) return null;

  const time = candidate.getTime();
  if (Number.isNaN(time)) return null;
  if (time > now.getTime() + maxFutureMs) return null;
  if (time < minInstant.getTime()) return null;

  return candidate;
}

function parseAbsolute(raw: string, assumeOffsetMinutes: number): Date | null {
  const ja = JAPANESE_DATE.exec(raw);
  if (ja) {
    return fromParts(
      [ja[1], ja[2], ja[3], ja[4] ?? ja[7], ja[5] ?? ja[8], ja[6] ?? ja[9]],
      assumeOffsetMinutes,
    );
  }

  const plain = PLAIN_DATE.exec(raw);
  if (plain) return fromParts(plain.slice(1), assumeOffsetMinutes);

  // Swap zone abbreviations the engine cannot read for numeric offsets.
  const withNumericZone = raw.replace(
    /\b([A-Z]{2,4})\s*$/,
    (match, abbrev: string) => TIMEZONE_ABBREVIATIONS[abbrev] ?? match,
  );

  const parsed = new Date(withNumericZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse a feed timestamp, falling back to a known-good instant.
 *
 * The fallback should be the time the item was fetched. An item with a broken
 * date is still an item; dropping it would be worse than showing it as "now".
 */
export function parseFeedDate(
  input: string | null | undefined,
  options: ParseFeedDateOptions & { fallback?: Date } = {},
): Date {
  return tryParseFeedDate(input, options) ?? options.fallback ?? options.now ?? new Date();
}

/**
 * Resolve an IANA timezone name to its offset in minutes at a given instant.
 *
 * Lets declarative source rules say `tz: "Asia/Tokyo"` without core taking a
 * dependency on a timezone library — Intl already ships the database.
 * Returns null for names the runtime does not recognise.
 */
export function timeZoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    });
    const part = formatter.formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
    if (!part) return null;
    if (part === "GMT") return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
  } catch {
    return null;
  }
}
