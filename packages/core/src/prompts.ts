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
  version: string;
  system: string;
};

export const SUMMARY_PROMPT_VERSION = "summary.v1";
export const TRANSLATION_PROMPT_VERSION = "translation.v1";
export const TAGS_PROMPT_VERSION = "tags.v1";

export const summaryPrompt: Prompt = {
  version: SUMMARY_PROMPT_VERSION,
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
    version: TRANSLATION_PROMPT_VERSION,
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
    version: TAGS_PROMPT_VERSION,
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
export type SummaryReply = z.infer<typeof summaryReplySchema>;

export const translationReplySchema = z.object({ title: z.string(), text: z.string() });
export type TranslationReply = z.infer<typeof translationReplySchema>;

export const tagsReplySchema = z.object({
  // Defaulted rather than required: an article the approved vocabulary does not
  // reach is a normal outcome, and a missing list is how a model says so.
  // Spending a second call to hear that again would be the worse trade.
  tags: z.array(z.string()).default([]),
  candidates: z.array(z.string()).default([]),
});
export type TagsReply = z.infer<typeof tagsReplySchema>;

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
 */
export async function completeJson<T>(
  provider: ChatProvider,
  request: ChatRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  let reason = "";

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
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
    const answer = await provider.complete(asked);
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
 * Strip the fence a model wrapped its JSON in.
 *
 * Anchored to the whole trimmed answer on purpose: an unanchored pattern would
 * strip the braces out from under a JSON string that merely contains a backtick
 * pair, which is how a code sample inside a summary turns into a parse error
 * and costs another call.
 */
function unwrapJson(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}
