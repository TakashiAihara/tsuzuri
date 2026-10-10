import { describe, expect, test } from "bun:test";

import { ChatError, type ChatProvider, type ChatRequest } from "./chat.ts";
import {
  BODY_TRANSLATION_PROMPT_VERSION,
  bodyTranslationPrompt,
  bodyTranslationReplySchema,
  completeJson,
  PromptParseError,
  SUMMARY_PROMPT_VERSION,
  summaryPrompt,
  summaryReplySchema,
  TAGS_PROMPT_VERSION,
  TRANSLATION_PROMPT_VERSION,
  tagsPrompt,
  tagsReplySchema,
  translationPrompt,
  translationReplySchema,
} from "./prompts.ts";

/**
 * The provider is a stub recording what it was asked, because what is under
 * test is the retry: one call, and on a reply that does not parse exactly one
 * more carrying the reason, and a second failure the caller can record.
 */

function stubProvider(answers: readonly (string | Error)[]) {
  const asked: ChatRequest[] = [];
  const queue = [...answers];

  const provider: ChatProvider = {
    id: "openai-compatible",
    model: "stub-model",
    async complete(request) {
      asked.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error("the stub has no answer left");
      if (next instanceof Error) throw next;
      return next;
    },
  };

  return { provider, asked };
}

const REQUEST: ChatRequest = {
  system: "be terse",
  user: "Summarise this article.",
  maxOutputTokens: 256,
};

describe("prompt versions", () => {
  test("each prompt has its own version, so one can change without the others", () => {
    expect(SUMMARY_PROMPT_VERSION).toBe("summary.v1");
    expect(TRANSLATION_PROMPT_VERSION).toBe("translation.v1");
    expect(TAGS_PROMPT_VERSION).toBe("tags.v1");
    expect(BODY_TRANSLATION_PROMPT_VERSION).toBe("translation-body.v1");

    const versions = new Set([
      summaryPrompt.version,
      translationPrompt("Japanese").version,
      tagsPrompt([]).version,
      bodyTranslationPrompt("Japanese").version,
    ]);
    expect(versions.size).toBe(4);
  });

  test("a built prompt carries the version it was built from", () => {
    expect(summaryPrompt.version).toBe(SUMMARY_PROMPT_VERSION);
    expect(tagsPrompt(["ai"]).version).toBe(TAGS_PROMPT_VERSION);
  });
});

describe("prompt text", () => {
  test("the summary prompt asks for a JSON object and not for prose alone", () => {
    expect(summaryPrompt.system).toContain("JSON");
    expect(summaryPrompt.system).toContain('"summary"');
  });

  test("the translation prompt names the language it is translating into", () => {
    const prompt = translationPrompt("Japanese");
    expect(prompt.system).toContain("Japanese");
    expect(prompt.system).toContain('"title"');
    expect(prompt.system).toContain('"text"');
  });

  test("the tags prompt carries the approved slugs and asks for a subset of them", () => {
    const prompt = tagsPrompt(["postgres", "machine learning"]);
    expect(prompt.system).toContain("postgres, machine learning");
    expect(prompt.system).toContain("subset");
    expect(prompt.system).toContain('"candidates"');
  });

  test("an empty vocabulary says so rather than rendering as a blank list", () => {
    // The first days of an install have no approved tags at all, and a prompt
    // with an empty list reads as a model that was sent nothing.
    const prompt = tagsPrompt([]);
    expect(prompt.system).toContain("no tags are approved yet");
  });

  test("the body prompt asks for the body alone and names the language", () => {
    const prompt = bodyTranslationPrompt("English");
    expect(prompt.system).toContain("English");
    expect(prompt.system).toContain('"text"');
    // It asks for a whole article rather than the two short fields the pass
    // asks for, so it must not demand a title it would then throw away.
    expect(prompt.system).not.toContain('"title"');
  });

  test("a body translation is a different answer from the pass's, so it is a different version", () => {
    // Both write kind `translation` for one language and model, which is one
    // row per (item, kind, lang, model, prompt version). A shared version would
    // have `tsuzuri translate <id>` overwrite the title and summary the pass
    // wrote, and the other way round.
    expect(BODY_TRANSLATION_PROMPT_VERSION).toBe("translation-body.v1");
    expect(bodyTranslationPrompt("English").version).not.toBe(translationPrompt("English").version);
  });
});

describe("reply schemas", () => {
  test("a summary reply is an object carrying the text", () => {
    expect(summaryReplySchema.parse({ summary: "something happened" })).toEqual({
      summary: "something happened",
    });
    expect(summaryReplySchema.safeParse({ summary: 42 }).success).toBe(false);
    expect(summaryReplySchema.safeParse("something happened").success).toBe(false);
  });

  test("a translation reply carries both the title and the text", () => {
    expect(translationReplySchema.safeParse({ title: "題" }).success).toBe(false);
    expect(translationReplySchema.parse({ title: "題", text: "本文" })).toEqual({
      title: "題",
      text: "本文",
    });
  });

  test("a body translation reply carries the text and nothing else", () => {
    // A title in the reply is not part of the shape and does not survive: the
    // caller asked for the body, and the pass's title-and-summary row already
    // holds a title.
    expect(bodyTranslationReplySchema.parse({ title: "題", text: "本文" })).toEqual({
      text: "本文",
    });
    expect(bodyTranslationReplySchema.safeParse({ title: "題" }).success).toBe(false);
  });

  test("an article the vocabulary does not reach answers with no tags at all", () => {
    expect(tagsReplySchema.parse({})).toEqual({ tags: [], candidates: [] });
    expect(tagsReplySchema.safeParse({ tags: ["ai", 3] }).success).toBe(false);
    expect(tagsReplySchema.parse({ tags: ["ai"], candidates: ["compilers"] })).toEqual({
      tags: ["ai"],
      candidates: ["compilers"],
    });
  });
});

describe("completeJson", () => {
  test("returns the parsed reply from a single call, asking the request as given", async () => {
    const { provider, asked } = stubProvider(['{"summary": "a short summary"}']);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toEqual([REQUEST]);
  });

  test("reads JSON out of a fenced answer without spending the retry on it", async () => {
    const { provider, asked } = stubProvider(['```json\n{"summary": "a short summary"}\n```']);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("retries once with the reason, and takes the second answer", async () => {
    const { provider, asked } = stubProvider([
      "I am afraid I cannot summarise that.",
      '{"summary": "a short summary"}',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(2);
    expect(asked[1]?.user).toContain(REQUEST.user);
    expect(asked[1]?.user).toContain("JSON");
  });

  test("retries once when the JSON is there but the field is the wrong shape", async () => {
    const { provider, asked } = stubProvider(['{"summary": 42}', '{"summary": "a short summary"}']);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(2);
    expect(asked[1]?.user).toContain("summary");
    expect(asked[1]?.user).toContain("string");
  });

  test("keeps the system prompt across the retry, so the task does not change", async () => {
    const { provider, asked } = stubProvider(["nope", '{"summary": "a short summary"}']);
    await completeJson(provider, REQUEST, summaryReplySchema);

    expect(asked[1]?.system).toBe(REQUEST.system);
    expect(asked[1]?.maxOutputTokens).toBe(REQUEST.maxOutputTokens);
  });

  test("gives up after the second unusable answer, so the caller can record a failure", async () => {
    const { provider, asked } = stubProvider(["nope", '{"summary": 42}']);

    await expect(completeJson(provider, REQUEST, summaryReplySchema)).rejects.toThrow(
      PromptParseError,
    );
    expect(asked).toHaveLength(2);
  });

  test("a request that never reached the model is not retried here", async () => {
    // ChatError says the endpoint or the request failed. Retrying it inside
    // this function would turn a transport failure into a parse failure and
    // charge the article for the endpoint's outage.
    const failure = new ChatError("chat request failed (503)", true);
    const { provider, asked } = stubProvider([failure, '{"summary": "unused"}']);

    await expect(completeJson(provider, REQUEST, summaryReplySchema)).rejects.toThrow(ChatError);
    expect(asked).toHaveLength(1);
  });

  test("answers a tag prompt with the tags chosen and the candidates named", async () => {
    const { provider } = stubProvider(['{"tags": ["postgres"], "candidates": ["query planners"]}']);
    const result = await completeJson(provider, REQUEST, tagsReplySchema);

    expect(result).toEqual({ tags: ["postgres"], candidates: ["query planners"] });
  });

  test("answers a translation prompt with both halves of the item", async () => {
    const { provider } = stubProvider([JSON.stringify({ title: "題", text: "本文" })]);
    const result = await completeJson(provider, REQUEST, translationReplySchema);
    expect(result).toEqual({ title: "題", text: "本文" });
  });

  test("answers a body prompt with the body", async () => {
    const { provider } = stubProvider([JSON.stringify({ text: "本文" })]);
    const result = await completeJson(provider, REQUEST, bodyTranslationReplySchema);
    expect(result).toEqual({ text: "本文" });
  });
});
