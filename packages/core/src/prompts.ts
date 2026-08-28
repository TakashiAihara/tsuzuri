import { z } from "zod";

import { unwrapJson } from "./chat.ts";

/**
 * The prompts, and the parsers for what they ask for.
 *
 * Versions are constants next to the prompt text and bumped by hand when the
 * text changes. Hashing the prompt would version automatically but would make
 * two textually different, semantically identical prompts incomparable; a hand
 * bump states that the change was meant to change the output.
 *
 * Enrichment rows are keyed by (item, kind, prompt_version, chat_model), so a
 * bump makes replay additive: yesterday's articles can be re-run and the two
 * versions compared side by side without refetching anything.
 */

export const SUMMARY_PROMPT_VERSION = "summary.v1";
export const TRANSLATION_PROMPT_VERSION = "translation.v1";
export const TAGS_PROMPT_VERSION = "tags.v1";

/** How much of an article is sent. Beyond this a summary gains nothing and costs tokens. */
export const MAX_ARTICLE_CHARS = 12_000;

export function articleInput(title: string | null, text: string): string {
  const body = text.slice(0, MAX_ARTICLE_CHARS);
  return title ? `${title}\n\n${body}` : body;
}

export const summaryPrompt = {
  version: SUMMARY_PROMPT_VERSION,
  system:
    "You summarise news and blog articles for a reader deciding what to open. " +
    "Answer with two or three sentences of plain prose stating what happened and why it matters. " +
    "Write in the language the article is written in. " +
    "Do not open with the article's title, do not editorialise, and do not write a preamble such as " +
    '"This article discusses". If the text is too short or too garbled to summarise, answer exactly: NONE',
} as const;

export const SUMMARY_UNAVAILABLE = "NONE";

/**
 * The model is asked to say so rather than invent a summary of nothing: a
 * feed that publishes titles only would otherwise accumulate confident
 * summaries of text nobody has.
 */
export function parseSummary(answer: string): string | null {
  const text = answer.trim();
  if (text.length === 0 || text === SUMMARY_UNAVAILABLE) return null;
  return text;
}

export function translationPrompt(targetLanguage: string) {
  return {
    version: TRANSLATION_PROMPT_VERSION,
    system:
      `You translate article titles and summaries into ${targetLanguage}. ` +
      'Answer with a JSON object: {"title": string, "text": string}. ' +
      "Translate faithfully; do not summarise further, explain, or add notes. " +
      "Leave proper nouns, product names and code identifiers in their original form.",
  } as const;
}

const translationSchema = z.object({
  title: z.string(),
  text: z.string(),
});

export function parseTranslation(answer: string): { title: string; text: string } | null {
  try {
    const parsed = translationSchema.safeParse(JSON.parse(unwrapJson(answer)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Tagging is classification against a closed vocabulary, never free
 * generation: free tags diverge until they are useless for filtering. The
 * model may name concepts the vocabulary lacks, but those become candidates
 * for a human to approve, not tags.
 */
export function tagsPrompt(vocabulary: readonly string[]) {
  const list =
    vocabulary.length > 0 ? vocabulary.join(", ") : "(the vocabulary is currently empty)";
  return {
    version: TAGS_PROMPT_VERSION,
    system:
      "You tag articles. Answer with a JSON object: " +
      '{"tags": string[], "candidates": string[]}.\n' +
      `"tags" must contain only entries from this vocabulary, copied exactly: ${list}\n` +
      "Choose the ones that genuinely apply, at most four, and choose none rather than a weak fit.\n" +
      '"candidates" may name at most two topics that clearly apply and are missing from the vocabulary. ' +
      "Use short, lowercase, general topic names — the kind that would tag hundreds of future articles, " +
      "not this one. Leave it empty when the vocabulary already covers the article.",
  } as const;
}

const tagsSchema = z.object({
  tags: z.array(z.string()).default([]),
  candidates: z.array(z.string()).default([]),
});

export type TagAnswer = { tags: string[]; candidates: string[] };

/** Tag limits, mirrored here because a model that ignores the prompt must not widen the vocabulary. */
const MAX_TAGS = 4;
const MAX_CANDIDATES = 2;
const MAX_TAG_LENGTH = 40;

/**
 * Parse and enforce.
 *
 * The prompt states the vocabulary and the limits; this re-checks both,
 * because a prompt is a request and the point of a closed vocabulary is that
 * it holds when the model does not comply. Tags outside the vocabulary are
 * dropped rather than promoted to candidates: the model was told to put those
 * in `candidates`, and treating the mistake as intent would let any
 * hallucinated string enter the vocabulary through the wrong door.
 */
export function parseTags(answer: string, vocabulary: readonly string[]): TagAnswer | null {
  let parsed: z.infer<typeof tagsSchema>;
  try {
    const result = tagsSchema.safeParse(JSON.parse(unwrapJson(answer)));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }

  const allowed = new Set(vocabulary);
  const tags = dedupe(parsed.tags.map(normalizeTag)).filter((tag) => allowed.has(tag));
  const candidates = dedupe(parsed.candidates.map(normalizeTag)).filter(
    (tag) => tag.length > 0 && tag.length <= MAX_TAG_LENGTH && !allowed.has(tag),
  );

  return {
    tags: tags.slice(0, MAX_TAGS),
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/gu, " ");
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
