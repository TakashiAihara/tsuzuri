/**
 * Parsing the query parameters of /search.
 *
 * Separate from the endpoint so the fiddly part -- what "7d" means -- can be
 * tested without an HTTP server.
 */

const DURATION = /^(\d+)\s*(s|m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve `since` to an instant.
 *
 * Accepts either an absolute timestamp or a duration back from now, because the
 * two callers want different things: a human types `7d`, and a program that
 * already knows the boundary passes an ISO instant. Supporting only the latter
 * would push date arithmetic into every caller, including an agent, which is
 * exactly the sort of work an agent gets subtly wrong.
 *
 * Returns null for an absent value, and throws for one that was supplied but
 * cannot be read -- a `since` nobody understood must not silently widen the
 * search to all of history.
 */
export function parseSince(value: string | undefined | null, now = new Date()): Date | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const duration = DURATION.exec(trimmed);
  if (duration?.[1] && duration[2]) {
    const unit = UNIT_MS[duration[2].toLowerCase()];
    if (unit) return new Date(now.getTime() - Number(duration[1]) * unit);
  }

  const absolute = new Date(trimmed);
  if (!Number.isNaN(absolute.getTime())) return absolute;

  throw new Error(`could not read "${value}" as a date or a duration such as 7d`);
}
