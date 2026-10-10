import { z } from "zod";

import type { ChatProvider, ChatRequest } from "./chat.ts";

/**
 * The prompts enrichment asks with, and the shapes their answers must have.
 *
 * JSON is asked for in the prompt and checked here rather than through a
 * provider's structured-output mode. Those are three different mechanisms and
 * the OpenAI-compatible implementation covers servers that implement none of
 * them, so a capability the pipeline cannot rely on would still need this
 * fallback underneath it (D26).
 *
 * A version sits beside each prompt and is recorded on every row it produces,
 * because the whole point of storing model and prompt version in the primary
 * key is that a prompt change is replayable over history. A hand-written bump
 * states that the change was meant to change the answer; hashing the text would
 * version automatically and make two differently worded prompts incomparable.
 */

export type Prompt = {
  system: string;
};

export const SUMMARY_PROMPT_VERSION = "summary.v1";
export const TRANSLATION_PROMPT_VERSION = "translation.v1";
export const TAGS_PROMPT_VERSION = "tags.v1";
export const BODY_TRANSLATION_PROMPT_VERSION = "translation-body.v1";

export const summaryPrompt: Prompt = {
  system:
    "You summarise articles for a reader deciding whether to open them. " +
    'Answer with a JSON object of the form {"summary": "..."} and nothing else. ' +
    "Write two or three sentences of plain prose saying what happened and why it matters, " +
    "in the language the article is written in. Do not open with the article's title, " +
    "do not editorialise, and do not add a preamble such as 'this article discusses'.",
};

/**
 * Title and summary, not the body (D30): a body translation is a large call on
 * text the reader may never open, and the point of a translated summary is
 * deciding whether to read the body at all.
 */
export function translationPrompt(targetLanguage: string): Prompt {
  return {
    system:
      `You translate article titles and summaries into ${targetLanguage}. ` +
      'Answer with a JSON object of the form {"title": "...", "text": "..."} and nothing else. ' +
      "Translate faithfully: do not summarise further, do not explain, and do not add notes. " +
      "Leave proper nouns, product names and identifiers in their original form.",
  };
}

/**
 * Classification against a closed vocabulary, never generation (D28).
 *
 * The model may name a concept the vocabulary lacks, but only as a suggestion:
 * free tags diverge until they are useless for filtering, so what it may choose
 * from is the approved list and everything else is a candidate for a person to
 * approve.
 */
export function tagsPrompt(approvedSlugs: readonly string[]): Prompt {
  const vocabulary =
    approvedSlugs.length > 0 ? approvedSlugs.join(", ") : "(no tags are approved yet)";

  return {
    system:
      "You tag articles for a reader who subscribes to many of them. " +
      'Answer with a JSON object of the form {"tags": ["..."], "candidates": ["..."]} ' +
      "and nothing else. " +
      `"tags" must be a subset of this approved vocabulary, copied exactly: ${vocabulary}. ` +
      "Choose only the tags that genuinely apply, and choose none rather than a weak fit. " +
      '"candidates" may name topics that clearly apply and the vocabulary does not cover, ' +
      "as short lowercase names of things that would tag many future articles. " +
      "Leave it empty when the approved vocabulary already covers the article.",
  };
}

export const summaryReplySchema = z.object({ summary: z.string() });

export const translationReplySchema = z.object({ title: z.string(), text: z.string() });

/**
 * A body, on request (`tsuzuri translate <id>`).
 *
 * A different prompt from the title-and-summary one and therefore a different
 * version: both write kind `translation` for the same language and model, so
 * sharing a version would have one overwrite the other on the same key. The
 * pass's answer is two short fields; this one is a whole article, and asking
 * for it is the deliberate act the cost deserves (D30).
 */
export function bodyTranslationPrompt(targetLanguage: string): Prompt {
  return {
    system:
      `You translate article bodies into ${targetLanguage}. ` +
      'Answer with a JSON object of the form {"text": "..."} and nothing else. ' +
      "Translate the whole body faithfully: do not summarise it, do not drop paragraphs, " +
      "and do not add notes. Leave proper nouns, product names and identifiers in their original form.",
  };
}

export const bodyTranslationReplySchema = z.object({ text: z.string() });

export const tagsReplySchema = z.object({
  // Defaulted rather than required: an article the approved vocabulary does not
  // reach is a normal outcome, and a missing list is how a model says so.
  // Spending a second call to hear that again would be the worse trade.
  tags: z.array(z.string()).default([]),
  candidates: z.array(z.string()).default([]),
});

/**
 * A reply that could not be turned into the shape the caller asked for.
 *
 * Not a ChatError: nothing was wrong with the request or the endpoint, the
 * answer simply was not usable. The caller records it as an enrichment
 * failure against the item, which is what keeps one article the model will not
 * answer for from being selected on every pass.
 */
export class PromptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptParseError";
  }
}

/** One attempt, then one more. A model that ignored the shape twice will again. */
const ATTEMPTS = 2;

/**
 * Ask for JSON, check it, and try once more with the reason it was rejected.
 *
 * The retry carries the parse error rather than a bare "try again", because a
 * model that answered with prose has to be told what was wrong with it or it
 * produces the same shape of answer and the second call buys nothing.
 *
 * The signal is the caller's shutdown, and it reaches the request rather than
 * racing it: a second attempt is not made against a signal that has already
 * been aborted.
 */
export async function completeJson<T>(
  provider: ChatProvider,
  request: ChatRequest,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  let reason = "";

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason;
    const asked: ChatRequest =
      attempt === 0
        ? request
        : {
            ...request,
            user:
              `${request.user}\n\nYour previous answer could not be used: ${reason}. ` +
              "Answer again with the JSON object and nothing else.",
          };

    // A ChatError is the caller's to handle: it says the endpoint or the
    // request failed, not that the answer was unusable, and retrying it here
    // would hide the difference between the two.
    const answer = await provider.complete(asked, signal);
    const read = readReply(answer, schema);

    if (read.ok) return read.data;
    reason = read.error;
  }

  throw new PromptParseError(`chat reply was not the expected JSON: ${reason}`);
}

function readReply<T>(
  answer: string,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(unwrapJson(answer));
  } catch (error) {
    return {
      ok: false,
      error: `the answer was not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Take the JSON out of an answer that wrapped it in prose.
 *
 * In order: the whole reply, then a fenced block wherever it appears, then the
 * first balanced object in it that parses. The order is what stops each step
 * from costing a correct answer: a reply that is one JSON object whose string
 * values contain backticks has no fence to find and must not be cut down to
 * one, a fence is language-tagged by some models and bare by others, and prose
 * around the object can contain braces of its own.
 *
 * Returning the first span that parses rather than the outermost one is what
 * makes a preamble with a stray `{` usable: the span from that brace to the end
 * of the answer is not JSON, and refusing to look further would spend the
 * retry on an answer the model had already got right.
 */
function unwrapJson(answer: string): string {
  const trimmed = answer.trim();
  if (parses(trimmed)) return trimmed;

  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  if (fenced?.[1]?.trim() && parses(fenced[1].trim())) return fenced[1].trim();

  for (const span of objectSpans(trimmed)) {
    if (parses(span)) return span;
  }

  // Nothing in the reply is JSON on its own, so the retry is told what it was
  // rather than what to cut out of it.
  return trimmed;
}

/** Every balanced `{ ... }` span in the text, outermost first and left to right. */
function objectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    // A brace inside a string value is text, so the scan has to know about the
    // quotes and the backslashes that escape them.
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(text.slice(start, index + 1));
    }
  }
  return spans;
}

function parses(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}
