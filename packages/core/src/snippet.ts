/**
 * Turning a search snippet back into text.
 *
 * PGroonga's pgroonga_snippet_html() escapes the article text and then wraps
 * the matched terms in a <span>, which is right for a browser and wrong for
 * everything else this project has. Stripping the tags alone is not enough: a
 * title containing `&` arrives as `&amp;` and would reach a terminal, or an
 * agent's context, looking like that.
 *
 * Shared rather than duplicated because both the CLI and the MCP server render
 * snippets, and a decoding table that exists twice will eventually differ.
 */

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Strip highlight markup and undo HTML escaping, collapsing whitespace.
 *
 * `&amp;` is decoded last by construction: the named replacement runs in one
 * pass over the original string, so `&amp;lt;` becomes `&lt;` rather than `<`.
 * Decoding twice would let escaped text masquerade as markup.
 */
export function snippetToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => NAMED_ENTITIES[entity] ?? entity)
    .replace(/&#(\d{1,7});/g, (match, code: string) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}
