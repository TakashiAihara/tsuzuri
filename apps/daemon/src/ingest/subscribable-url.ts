import { lookup } from "node:dns/promises";

/**
 * Deciding whether a URL may be subscribed to.
 *
 * The reader fetches whatever it is subscribed to, so a subscription URL is an
 * instruction to make a request from wherever the daemon runs. That was always
 * true, but the MCP server makes it reachable by an agent, and an agent's
 * inputs include article text from the open web. An article that talks a model
 * into calling add_source with `http://169.254.169.254/…` would otherwise have
 * the daemon fetch a cloud metadata endpoint and store the result as an
 * article.
 *
 * What this covers: the scheme, and the address the host resolves to at
 * subscribe time. What it does not cover: redirects, and a name that resolves
 * differently later (DNS rebinding). Closing those means validating every hop
 * inside the fetcher, which is a change to the ingest path rather than to
 * subscription, and is tracked separately.
 */

export type UrlRejection = { ok: false; reason: string };
export type UrlAcceptance = { ok: true };

/**
 * Ranges that are never a public feed, in the sense that reaching them means
 * reaching something on the host's own network rather than the internet.
 */
function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true; // loopback, unspecified
  if (normalized.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique local
  // IPv4-mapped addresses, in both spellings. The URL parser rewrites
  // ::ffff:127.0.0.1 into ::ffff:7f00:1, so checking only the dotted form
  // would miss every mapped address that arrived through a URL.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (dotted?.[1]) return isBlockedIpv4(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isBlockedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }

  return false;
}

function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/**
 * Whether a URL is one this daemon will subscribe to.
 *
 * Resolution is done here rather than trusting the literal host, because
 * `http://localtest.me/` is a public name that resolves to 127.0.0.1. A name
 * that does not resolve is rejected too: there is nothing to subscribe to, and
 * failing at subscribe time is clearer than a subscription that never works.
 */
export async function checkSubscribableUrl(
  input: string,
  options: { resolve?: (hostname: string) => Promise<{ address: string; family: number }[]> } = {},
): Promise<UrlAcceptance | UrlRejection> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "not a URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${url.protocol} is not a feed; use http or https` };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolve =
    options.resolve ?? ((name: string) => lookup(name, { all: true, verbatim: true }));

  // A literal address needs no lookup, and asking for one would fail.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isBlockedIpv4(hostname)
      ? { ok: false, reason: `${hostname} is not a public address` }
      : { ok: true };
  }
  if (hostname.includes(":")) {
    return isBlockedIpv6(hostname)
      ? { ok: false, reason: `${hostname} is not a public address` }
      : { ok: true };
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, reason: `${hostname} does not resolve` };
  }

  if (addresses.length === 0) return { ok: false, reason: `${hostname} does not resolve` };

  // Every answer has to be acceptable. One public address alongside a private
  // one is the shape of a deliberate bypass.
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address, entry.family));
  if (blocked) {
    return { ok: false, reason: `${hostname} resolves to ${blocked.address}, which is not public` };
  }

  return { ok: true };
}
