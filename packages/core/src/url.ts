/**
 * URL handling for feed items.
 *
 * Two distinct jobs live here and must not be conflated:
 *
 *   resolveUrl()   — produce a URL we will actually fetch or link to.
 *                    Never rewrites the scheme, because plenty of sites are
 *                    still http-only and "upgrading" them breaks the fetch.
 *
 *   canonicalUrl() — produce an identity key for deduplication. This one *does*
 *                    normalise the scheme, because http:// and https:// copies
 *                    of the same article are the same article.
 *
 * Feeds are a hostile input: the same post shows up with utm parameters, with
 * Blogger's ?m=1 mobile suffix, with and without a trailing slash. All of that
 * has to collapse to one key or the reader shows duplicates forever.
 */

/** Query parameters that never identify content. Exact matches. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "vero_conv",
  "oly_anon_id",
  "oly_enc_id",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "spm",
  "cmpid",
  "ncid",
]);

/** Prefixes that mark a whole family of tracking parameters. */
const TRACKING_PREFIXES = ["utm_", "pk_", "piwik_", "matomo_", "hsa_", "at_custom"];

/**
 * Parameters that are only noise on specific hosts.
 *
 * "m=1" is Blogger's mobile variant, but "m" is a perfectly ordinary parameter
 * name elsewhere, so it cannot go in the global list.
 */
const HOST_SCOPED_TRACKING: ReadonlyArray<{
  host: (hostname: string) => boolean;
  param: string;
  value?: string;
}> = [{ host: (h) => h.endsWith(".blogspot.com") || h === "blogspot.com", param: "m", value: "1" }];

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Resolve a possibly-relative href against a base URL and drop tracking noise.
 *
 * Returns null instead of throwing: feeds contain genuinely broken hrefs
 * ("javascript:void(0)", empty strings, mailto:) and an item with one bad link
 * should not take down the whole fetch.
 */
export function resolveUrl(href: string, base?: string): string | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  stripTrackingParams(url);
  return url.toString();
}

/** Remove tracking parameters from a URL object, in place. */
function stripTrackingParams(url: URL): void {
  const doomed = [...url.searchParams.keys()].filter(isTrackingParam);
  for (const key of doomed) url.searchParams.delete(key);

  const hostname = url.hostname.toLowerCase();
  for (const rule of HOST_SCOPED_TRACKING) {
    if (!rule.host(hostname)) continue;
    if (rule.value === undefined) {
      url.searchParams.delete(rule.param);
    } else if (url.searchParams.get(rule.param) === rule.value) {
      url.searchParams.delete(rule.param);
    }
  }
}

/**
 * Identity key for an article URL.
 *
 * Normalises everything that can vary without the content varying:
 * scheme, host case, default ports, tracking parameters, parameter order,
 * a trailing slash, and the fragment.
 *
 * Deliberately does NOT strip "www." — news.example.com and www.example.com
 * are different hosts often enough that collapsing them would merge unrelated
 * articles.
 *
 * Returns null for input that is not a usable http(s) URL.
 */
export function canonicalUrl(input: string): string | null {
  const resolved = resolveUrl(input);
  if (!resolved) return null;

  const url = new URL(resolved);

  // http and https copies of one article are one article.
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  url.hash = "";

  // Parameter order is not meaningful for identity, but feeds do reorder them.
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  // "/posts/hello/" and "/posts/hello" are the same page. The site root is not
  // a meaningful trailing slash, so leave "/" alone.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/**
 * Rewrite every relative href/src in a fragment of article HTML to absolute.
 *
 * Without this, images and links break the moment the article is read outside
 * its original page. Uses a regex rather than a DOM parse because this runs on
 * every item and the surrounding pipeline has already sanitised the markup.
 */
export function absolutizeHtml(html: string, base: string): string {
  return html.replace(
    /\b(href|src|poster)\s*=\s*(["'])(.*?)\2/gi,
    (match, attr: string, quote: string, value: string) => {
      const trimmed = value.trim();
      // Leave anchors, data: URIs and existing absolute URLs alone.
      if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        return match;
      }
      try {
        return `${attr}=${quote}${new URL(trimmed, base).toString()}${quote}`;
      } catch {
        return match;
      }
    },
  );
}
