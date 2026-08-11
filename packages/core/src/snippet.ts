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
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Named or numeric, matched together so each is decoded exactly once. */
const ENTITY = /&(#\d{1,7}|[a-zA-Z]+);/g;

/**
 * Strip highlight markup and undo HTML escaping, collapsing whitespace.
 *
 * One pass over the input, deliberately. Decoding named and numeric entities in
 * separate passes decodes some text twice: `&amp;#60;` is an article that
 * literally contains `&#60;`, and a named pass followed by a numeric one turns
 * it into `<` -- changing what the source said, and letting escaped text
 * masquerade as markup. Scanning once leaves the tail of a match as plain text.
 */
export function snippetToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(ENTITY, (match, body: string) => {
      if (body.startsWith("#")) {
        const point = Number(body.slice(1));
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}
