import { describe, expect, test } from "bun:test";

import { decodeBody } from "./decode.ts";

function bytes(...parts: (number[] | Uint8Array | string)[]): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === "string"
      ? new TextEncoder().encode(part)
      : part instanceof Uint8Array
        ? part
        : new Uint8Array(part),
  );
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("decodeBody", () => {
  test("strips a UTF-8 BOM so the XML parser sees a clean first character", () => {
    const result = decodeBody(bytes([0xef, 0xbb, 0xbf], '<?xml version="1.0"?><rss/>'));
    expect(result.text.startsWith("<?xml")).toBe(true);
    expect(result.encoding).toBe("utf-8");
  });

  test("honours the XML declaration over the HTTP header", () => {
    // Servers routinely send text/xml with no charset (formally ISO-8859-1)
    // while the document declares the real encoding.
    const shiftJis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]); // 日本語
    const body = bytes(
      '<?xml version="1.0" encoding="Shift_JIS"?><rss><title>',
      shiftJis,
      "</title></rss>",
    );
    const result = decodeBody(body, "text/xml");
    expect(result.encoding).toBe("shift_jis");
    expect(result.text).toContain("日本語");
  });

  test("falls back to the Content-Type charset when the document declares nothing", () => {
    const eucJp = new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec]); // 日本語
    const result = decodeBody(
      bytes("<rss><title>", eucJp, "</title></rss>"),
      "text/xml; charset=EUC-JP",
    );
    expect(result.encoding).toBe("euc-jp");
    expect(result.text).toContain("日本語");
  });

  test("defaults to UTF-8 when nothing declares an encoding", () => {
    const result = decodeBody(bytes("<rss><title>日本語</title></rss>"));
    expect(result.encoding).toBe("utf-8");
    expect(result.text).toContain("日本語");
  });

  test("falls back to UTF-8 for an encoding label the runtime does not know", () => {
    const result = decodeBody(bytes('<?xml version="1.0" encoding="X-MADE-UP"?><rss/>'));
    expect(result.encoding).toBe("utf-8");
    expect(result.text).toContain("<rss/>");
  });
});
