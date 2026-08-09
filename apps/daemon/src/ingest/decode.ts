/**
 * Decode a fetched feed body to text.
 *
 * Feeds still ship in Shift_JIS and EUC-JP, and the declared encoding
 * disagrees with the HTTP header often enough that picking the wrong source of
 * truth produces mojibake rather than an error. The order below follows what
 * feed parsers have converged on:
 *
 *   1. a UTF-8 BOM, which overrides everything and must be stripped or the XML
 *      parser fails on the very first character
 *   2. the XML declaration or HTML meta charset inside the document
 *   3. the charset parameter on the Content-Type header
 *   4. UTF-8
 *
 * The header loses to the document because a huge number of servers send
 * "Content-Type: text/xml" with no charset (which formally means ISO-8859-1)
 * while the document itself declares the truth.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/** How far into the body to look for an encoding declaration. */
const SNIFF_BYTES = 1024;

const XML_DECLARATION_ENCODING = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i;
const HTML_META_CHARSET = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i;
const CONTENT_TYPE_CHARSET = /charset\s*=\s*"?([\w-]+)"?/i;

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * The runtime accepts every WHATWG encoding label, but the type definitions
 * only enumerate a handful. Encoding names here come from the document itself,
 * so they cannot be constrained at compile time; an unrecognised one throws and
 * is handled below.
 */
type EncodingLabel = ConstructorParameters<typeof TextDecoder>[0];

function decodeWith(bytes: Uint8Array, label: string): string | null {
  try {
    // fatal:false so a few bad bytes degrade to replacement characters rather
    // than losing the whole feed.
    return new TextDecoder(label as EncodingLabel, { fatal: false }).decode(bytes);
  } catch {
    // Unknown label. Caller falls through to the next candidate.
    return null;
  }
}

export type DecodeResult = {
  text: string;
  /** Encoding actually used, for logging and for diagnosing mojibake reports. */
  encoding: string;
};

export function decodeBody(input: Uint8Array, contentType?: string | null): DecodeResult {
  let bytes = input;

  if (startsWith(bytes, UTF8_BOM)) {
    return { text: decodeWith(bytes.subarray(3), "utf-8") ?? "", encoding: "utf-8" };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { text: decodeWith(bytes.subarray(2), "utf-16le") ?? "", encoding: "utf-16le" };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { text: decodeWith(bytes.subarray(2), "utf-16be") ?? "", encoding: "utf-16be" };
  }

  // The declaration is ASCII-compatible in every encoding we care about, so
  // sniffing it as latin1 is safe even when the body is not.
  const head = new TextDecoder("latin1" as EncodingLabel).decode(bytes.subarray(0, SNIFF_BYTES));

  const declared =
    XML_DECLARATION_ENCODING.exec(head)?.[1] ??
    HTML_META_CHARSET.exec(head)?.[1] ??
    (contentType ? CONTENT_TYPE_CHARSET.exec(contentType)?.[1] : undefined);

  if (declared) {
    const label = declared.toLowerCase();
    const decoded = decodeWith(bytes, label);
    if (decoded !== null) return { text: decoded, encoding: label };
  }

  bytes = input;
  return { text: decodeWith(bytes, "utf-8") ?? "", encoding: "utf-8" };
}
