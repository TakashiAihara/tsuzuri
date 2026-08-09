import type { OpmlOutline } from "@tsuzuri/core";
import { XMLParser } from "fast-xml-parser";

/**
 * Extract subscriptions from an OPML export.
 *
 * Outlines nest arbitrarily because readers use them for folders, so this walks
 * the tree rather than reading one level. Folder structure itself is discarded:
 * tsuzuri organises by tag and score, and inventing a folder model just to hold
 * imported names would be a feature nothing else uses.
 */
export function parseOpml(xml: string): OpmlOutline[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Without this a body with one outline parses to an object and a body with
    // two parses to an array, and the walker has to handle both everywhere.
    isArray: (name) => name === "outline",
  });

  const parsed = parser.parse(xml) as Record<string, unknown>;
  const body = (parsed.opml as Record<string, unknown> | undefined)?.body;
  if (!body || typeof body !== "object") return [];

  const found: OpmlOutline[] = [];
  const seen = new Set<string>();

  walk((body as Record<string, unknown>).outline, (outline) => {
    const xmlUrl = outline["@_xmlUrl"];
    if (typeof xmlUrl !== "string" || !xmlUrl.trim()) return;
    if (seen.has(xmlUrl)) return;
    seen.add(xmlUrl);

    const title = outline["@_title"] ?? outline["@_text"];
    const htmlUrl = outline["@_htmlUrl"];
    found.push({
      title: typeof title === "string" && title.trim() ? title.trim() : null,
      xmlUrl: xmlUrl.trim(),
      htmlUrl: typeof htmlUrl === "string" && htmlUrl.trim() ? htmlUrl.trim() : null,
    });
  });

  return found;
}

function walk(node: unknown, visit: (outline: Record<string, unknown>) => void): void {
  if (!Array.isArray(node)) return;
  for (const child of node) {
    if (!child || typeof child !== "object") continue;
    const outline = child as Record<string, unknown>;
    visit(outline);
    walk(outline.outline, visit);
  }
}
