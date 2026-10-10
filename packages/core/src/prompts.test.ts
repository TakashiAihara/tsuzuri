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
    expect(BODY_TRANSLATION_PROMPT_VERSION).not.toBe(TRANSLATION_PROMPT_VERSION);
    expect(BODY_TRANSLATION_PROMPT_VERSION).toBe("translation-body.v1");
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

  test("reads the object out of an answer that wrapped it in prose", async () => {
    // A model that introduces the answer and signs off after it has answered
    // the question correctly, and spending the retry on it buys nothing.
    const { provider, asked } = stubProvider([
      'Here is the summary you asked for:\n```json\n{"summary": "a short summary"}\n```\nLet me know if you need more detail.',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("takes the fenced block over a brace somewhere in the prose around it", async () => {
    // Falling back to the outermost braces here would span from the model's
    // running commentary to the end of the answer, and spend the retry on JSON
    // that was never going to parse.
    const { provider, asked } = stubProvider([
      'I looked at {"unclear": true} and then:\n```json\n{"summary": "a short summary"}\n```',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("takes the outermost object when there is no fence at all", async () => {
    const { provider, asked } = stubProvider([
      'Sure. {"summary": "a short summary"} Hope that helps.',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("a brace in the prose that never closes does not hide the answer after it", async () => {
    const { provider, asked } = stubProvider([
      'Note: { this aside never closes. {"summary": "a short summary"}',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("a quote mark in the prose does not hide the answer after it", async () => {
    const { provider, asked } = stubProvider(['The 5" disk: {"summary": "a short summary"}']);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("a whole-reply object whose value holds a fenced block is read whole", async () => {
    // The case that tells the whole-reply step from the fence step: looking for
    // a fence first would return the inner block, which has the wrong shape.
    const inner = '```json\n{"other": 1}\n```';
    const { provider, asked } = stubProvider([JSON.stringify({ summary: `see ${inner}` })]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: `see ${inner}` });
    expect(asked).toHaveLength(1);
  });

  test("a brace inside a string value does not end the object early", async () => {
    // The balanced span is what makes this parse: stopping at the first "}"
    // would hand JSON.parse half an object and spend the retry on it.
    const { provider, asked } = stubProvider(['{"summary": "the {brace} inside a quote"}']);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "the {brace} inside a quote" });
    expect(asked).toHaveLength(1);
  });

  test("takes the whole reply when it is one object, backticks in its values and all", async () => {
    // The order that broke this: a fence is looked for first, so three
    // backticks inside a string value cut the answer down to what was between
    // them, which is not JSON, and the retry was spent on a correct reply.
    const { provider, asked } = stubProvider([
      '{"summary": "```js\\nconst x = 1;\\n``` was in the article"}',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "```js\nconst x = 1;\n``` was in the article" });
    expect(asked).toHaveLength(1);
  });

  test("reads a fence whose language is written in capitals", async () => {
    // The tag is decoration: a model that writes ```JSON wrote the same object
    // as one that wrote ```json, and the reply was usable.
    const { provider, asked } = stubProvider(['```JSON\n{"summary": "a short summary"}\n```']);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("skips a stray brace in the prose before the object", async () => {
    // Spanning from that brace to the end of the answer is not JSON, and
    // refusing to look past it would spend the retry on a correct reply.
    const { provider, asked } = stubProvider([
      'The article opens with {and closes with} that. {"summary": "a short summary"}',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: "a short summary" });
    expect(asked).toHaveLength(1);
  });

  test("takes the first object that parses when the answer holds two", async () => {
    // A model that worked an example through before giving its answer names
    // the shape twice; the one that fits is the one it settled on.
    const { provider, asked } = stubProvider([
      '{"summary": "how I read it: \\"{}\\""}\n{"summary": "a short summary"}',
    ]);
    const result = await completeJson(provider, REQUEST, summaryReplySchema);

    expect(result).toEqual({ summary: 'how I read it: "{}"' });
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
    const failure = new ChatError("chat request failed (503)", "retryable");
    const { provider, asked } = stubProvider([failure, '{"summary": "unused"}']);

    await expect(completeJson(provider, REQUEST, summaryReplySchema)).rejects.toThrow(ChatError);
    expect(asked).toHaveLength(1);
  });

  test("an aborted signal reaches the provider rather than racing it", async () => {
    const { provider, asked } = stubProvider(['{"summary": "unused"}']);
    const controller = new AbortController();
    controller.abort();

    await expect(
      completeJson(provider, REQUEST, summaryReplySchema, controller.signal),
    ).rejects.toBeDefined();
    expect(asked).toHaveLength(0);
  });

  test("the caller's signal is handed to every attempt", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const answers = ["not json", '{"summary": "a short summary"}'];
    const provider: ChatProvider = {
      id: "openai-compatible",
      model: "stub-model",
      async complete(_request, signal) {
        seen.push(signal);
        return answers.shift() ?? '{"summary": "unused"}';
      },
    };
    const controller = new AbortController();

    await completeJson(provider, REQUEST, summaryReplySchema, controller.signal);

    // Both attempts, so a shutdown between them still reaches the second.
    expect(seen).toEqual([controller.signal, controller.signal]);
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

describe("prompt versions", () => {
  test("each prompt has a version of its own, so one can change alone", () => {
    // The version is what goes in the primary key, so two prompts sharing one
    // would overwrite each other's answers for the same article.
    const versions = [
      SUMMARY_PROMPT_VERSION,
      TRANSLATION_PROMPT_VERSION,
      TAGS_PROMPT_VERSION,
      BODY_TRANSLATION_PROMPT_VERSION,
    ];
    expect(versions).toEqual(["summary.v1", "translation.v1", "tags.v1", "translation-body.v1"]);
    expect(new Set(versions).size).toBe(4);
  });
});
