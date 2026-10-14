import { afterEach, describe, expect, test } from "bun:test";

import { ANTHROPIC_VERSION, ChatError, createChatProvider } from "./chat.ts";

/**
 * Each wire format is pinned against a fake fetch rather than a live endpoint:
 * what matters here is the request this code builds and the response shape it
 * reads, and a stub states both exactly. The error classification is the part
 * worth being careful about, since it is what decides whether an item waits.
 */

type FetchCall = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null | undefined;
  redirect: RequestInit["redirect"];
};

const calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function useFetch(respond: (call: FetchCall) => Response | Promise<Response>): void {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers ?? {})),
      body:
        init?.body === undefined || init?.body === null ? undefined : JSON.parse(String(init.body)),
      signal: init?.signal,
      redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
}

/** Answers every request with the same body, which is all a shape test needs. */
function respondWithJson(payload: unknown): void {
  useFetch(() => Response.json(payload));
}

function respondWithStatus(status: number, body: string): void {
  useFetch(() => new Response(body, { status }));
}

/** Stands in for an endpoint that accepts the connection and never answers. */
function stall(): (call: FetchCall) => Promise<Response> {
  return (call) =>
    new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const REQUEST = { system: "be terse", user: "summarise this", maxOutputTokens: 256 };

function provider(
  id: "openai-compatible" | "anthropic" | "gemini",
  overrides: { baseUrl?: string; apiKey?: string; requestTimeoutMs?: number } = {},
) {
  const created = createChatProvider({
    provider: id,
    baseUrl: "https://chat.example/v1",
    model: "test-model",
    ...overrides,
  });
  if (!created) throw new Error("expected a provider");
  return created;
}

describe("createChatProvider", () => {
  test("returns null when the provider is none, so disabled is an absence", () => {
    expect(createChatProvider({ provider: "none" })).toBeNull();
  });

  test("refuses a provider configured without a base url or a model", () => {
    expect(() => createChatProvider({ provider: "anthropic", model: "m" })).toThrow(
      /CHAT_BASE_URL/,
    );
    expect(() => createChatProvider({ provider: "gemini", model: "m" })).toThrow(/CHAT_BASE_URL/);
    expect(() =>
      createChatProvider({ provider: "openai-compatible", baseUrl: "https://chat.example" }),
    ).toThrow(/CHAT_MODEL/);
  });

  test("carries the configured model on the provider, so a change is detectable", () => {
    expect(provider("anthropic").model).toBe("test-model");
    expect(provider("gemini").id).toBe("gemini");
  });
});

describe("openai-compatible", () => {
  test("posts the system prompt as a message to /chat/completions", async () => {
    respondWithJson({ choices: [{ message: { content: "an answer" } }] });
    await provider("openai-compatible").complete(REQUEST);

    expect(calls[0]?.url).toBe("https://chat.example/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "summarise this" },
      ],
      max_tokens: 256,
      temperature: 0,
    });
  });

  test("sends the key as a bearer token, and omits the header when none is configured", async () => {
    respondWithJson({ choices: [{ message: { content: "an answer" } }] });
    await provider("openai-compatible", { apiKey: "sk-local" }).complete(REQUEST);
    expect(calls.at(-1)?.headers.authorization).toBe("Bearer sk-local");
    expect(calls.at(-1)?.headers["content-type"]).toBe("application/json");

    await provider("openai-compatible").complete(REQUEST);
    expect(calls.at(-1)?.headers).not.toHaveProperty("authorization");
  });

  test("returns the message content as the answer", async () => {
    respondWithJson({ choices: [{ message: { content: "a plain answer" } }] });
    expect(await provider("openai-compatible").complete(REQUEST)).toBe("a plain answer");
  });

  test("joins an answer given as a list of text parts", async () => {
    // Some endpoints answer in segments; keeping only the first would silently
    // truncate every such answer.
    respondWithJson({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "first half, " },
              { type: "text", text: "second half" },
            ],
          },
        },
      ],
    });
    expect(await provider("openai-compatible").complete(REQUEST)).toBe("first half, second half");
  });

  test("refuses an answer with no content rather than returning an empty string", async () => {
    // An empty summary and a bug look identical to every reader downstream.
    respondWithJson({ choices: [{ message: { content: null } }] });
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toThrow(ChatError);
  });
});

describe("anthropic", () => {
  test("posts the system prompt as a top-level field to /v1/messages", async () => {
    respondWithJson({ content: [{ type: "text", text: "an answer" }] });
    await provider("anthropic").complete(REQUEST);

    expect(calls[0]?.url).toBe("https://chat.example/v1/v1/messages");
    expect(calls[0]?.body).toEqual({
      model: "test-model",
      system: "be terse",
      messages: [{ role: "user", content: "summarise this" }],
      max_tokens: 256,
      temperature: 0,
    });
  });

  test("carries the key and a version in headers, not in the body", async () => {
    respondWithJson({ content: [{ type: "text", text: "an answer" }] });
    await provider("anthropic", { apiKey: "sk-ant" }).complete(REQUEST);

    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(calls[0]?.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(JSON.stringify(calls[0]?.body)).not.toContain("sk-ant");
  });

  test("omits the key header when no key is configured", async () => {
    respondWithJson({ content: [{ type: "text", text: "an answer" }] });
    await provider("anthropic").complete(REQUEST);
    expect(calls[0]?.headers).not.toHaveProperty("x-api-key");
  });

  test("concatenates the text of every block", async () => {
    // A block that carries no text must not abort the read: the answer is the
    // text of the blocks that have some.
    respondWithJson({
      content: [
        { type: "thinking", thinking: "considering" },
        { type: "text", text: "the answer, " },
        { type: "text", text: "in two blocks" },
      ],
    });
    expect(await provider("anthropic").complete(REQUEST)).toBe("the answer, in two blocks");
  });

  test("refuses a response whose blocks carry no text at all", async () => {
    respondWithJson({ content: [{ type: "tool_use", id: "t1" }] });
    await expect(provider("anthropic").complete(REQUEST)).rejects.toThrow(ChatError);
  });
});

describe("gemini", () => {
  test("puts the model in the path and the system prompt in its own field", async () => {
    respondWithJson({ candidates: [{ content: { parts: [{ text: "an answer" }] } }] });
    await provider("gemini").complete(REQUEST);

    expect(calls[0]?.url).toBe("https://chat.example/v1/v1beta/models/test-model:generateContent");
    expect(calls[0]?.body).toEqual({
      systemInstruction: { parts: [{ text: "be terse" }] },
      contents: [{ role: "user", parts: [{ text: "summarise this" }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0 },
    });
  });

  test("sends the key as a header rather than in the path or the body", async () => {
    respondWithJson({ candidates: [{ content: { parts: [{ text: "an answer" }] } }] });
    await provider("gemini", { apiKey: "goog-key" }).complete(REQUEST);

    expect(calls[0]?.headers["x-goog-api-key"]).toBe("goog-key");
    expect(calls[0]?.url).not.toContain("goog-key");
    expect(JSON.stringify(calls[0]?.body)).not.toContain("goog-key");
  });

  test("returns the joined text of the first candidate's parts", async () => {
    respondWithJson({
      candidates: [{ content: { parts: [{ text: "one " }, { text: "two" }] } }],
    });
    expect(await provider("gemini").complete(REQUEST)).toBe("one two");
  });

  test("URL-encodes the model name, which is a path segment of its own", async () => {
    // A tuned model is named with a slash, and an unencoded one asks for a
    // different resource than the one configured.
    respondWithJson({ candidates: [{ content: { parts: [{ text: "an answer" }] } }] });
    await createChatProvider({
      provider: "gemini",
      baseUrl: "https://chat.example/v1",
      model: "tunedModels/my-model",
    })?.complete(REQUEST);

    expect(calls[0]?.url).toBe(
      "https://chat.example/v1/v1beta/models/tunedModels%2Fmy-model:generateContent",
    );
  });

  test("refuses a response carrying no candidates", async () => {
    respondWithJson({ candidates: [] });
    await expect(provider("gemini").complete(REQUEST)).rejects.toThrow(/gemini shape/);
  });
});

describe("the output bound", () => {
  /**
   * Each provider names this condition in its own field, and each of the three
   * names is the only one this code checks: an answer that stops here is
   * complete JSON up to the point the bound bit, and asking again with the same
   * bound produces the same truncated answer.
   */
  test("openai-compatible: finish_reason length", async () => {
    respondWithJson({
      choices: [{ finish_reason: "length", message: { content: '{"summary": "half an ans' } }],
    });
    await expect(
      provider("openai-compatible").complete({ ...REQUEST, maxOutputTokens: 256 }),
    ).rejects.toThrow(/256-token output bound/);
  });

  test("anthropic: stop_reason max_tokens", async () => {
    respondWithJson({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '{"text": "hal' }],
    });
    await expect(
      provider("anthropic").complete({ ...REQUEST, maxOutputTokens: 512 }),
    ).rejects.toThrow(/512-token output bound/);
  });

  test("gemini: finishReason MAX_TOKENS", async () => {
    respondWithJson({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"summary":' }] } }],
    });
    await expect(
      provider("gemini").complete({ ...REQUEST, maxOutputTokens: 1024 }),
    ).rejects.toThrow(/1024-token output bound/);
  });

  test("a model that spent its budget reasoning says so, not that it had nothing to say", async () => {
    // Empty content with a reasoning field is the same event as a stop reason
    // naming the limit. Reporting "no text" would send the caller looking for a
    // model problem when the bound is the problem.
    respondWithJson({
      choices: [
        { message: { content: null, reasoning_content: "considering the article at length" } },
      ],
    });
    await expect(
      provider("openai-compatible").complete({ ...REQUEST, maxOutputTokens: 64 }),
    ).rejects.toThrow(/64-token output bound/);
  });

  test("a redirect is not followed, and says the base url is wrong", async () => {
    // Followed, it would send the API key and the article to wherever it points.
    useFetch(
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      kind: "configuration",
    });
    expect(calls[0]?.redirect).toBe("manual");
  });

  test("reaching the bound is a configuration error, not a fault of the article", async () => {
    respondWithJson({ choices: [{ finish_reason: "length", message: { content: '{"summary"' } }] });
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      kind: "configuration",
    });
  });

  test("an answer that finished on its own is not mistaken for one that did not", async () => {
    // The stop reason is checked for its value rather than its presence: an
    // answer that ran out of tokens and one that simply ended look identical
    // to anything reading only the text.
    respondWithJson({
      choices: [{ finish_reason: "stop", message: { content: '{"summary": "complete"}' } }],
    });
    expect(await provider("openai-compatible").complete(REQUEST)).toBe('{"summary": "complete"}');
  });
});

describe("failure classification", () => {
  test("treats 5xx and 429 as retryable, and other 4xx as permanent", async () => {
    respondWithStatus(503, "upstream is unwell");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ kind: "retryable" });

    respondWithStatus(429, "slow down");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ kind: "retryable" });

    respondWithStatus(422, "this article cannot be summarised");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ kind: "permanent" });
  });

  test("the three statuses that name a setup mistake are separated from the rest", async () => {
    // Each of these would fail every item identically, and recording one
    // against an item parks it behind a backoff for a variable somebody can
    // change in a second. They are neither "try again" nor "this article is
    // wrong", and the kind is what tells an operator which one it is.
    for (const status of [401, 403, 404]) {
      respondWithStatus(status, "no such model");
      await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
        kind: "configuration",
      });
    }
  });

  test("a 400 is evidence about the article, not about the installation", async () => {
    // An article too long for the model's context is refused exactly this way.
    // Charging the installation for it re-picks that article on every pass and
    // points the operator at a setup that is working.
    respondWithStatus(400, "this article is too long for the context window");
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      kind: "permanent",
    });
  });

  test("names the status and the body it was refused with", async () => {
    respondWithStatus(400, "model is not enabled");
    await expect(provider("anthropic").complete(REQUEST)).rejects.toThrow(/400.*model is not/);
  });

  test("treats malformed JSON in the body as the endpoint's final answer", async () => {
    // A model that answers in prose instead of JSON produces this, and another
    // attempt would spend another call producing the same prose.
    respondWithStatus(200, "I am afraid I cannot do that");
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      kind: "permanent",
    });
  });

  test("treats a response in an unexpected shape as permanent", async () => {
    respondWithJson({ choices: [{ text: "not a message object" }] });
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      kind: "permanent",
    });
  });

  test("reports an unreachable endpoint as retryable", async () => {
    useFetch(() => Promise.reject(new TypeError("connection refused")));
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  test("gives up on an endpoint that accepts the connection and never answers", async () => {
    // fetch() has no timeout of its own, so without a deadline the enrichment
    // pass and the daemon's shutdown would both wait on a wedged local runtime.
    useFetch(stall());
    await expect(
      provider("openai-compatible", { requestTimeoutMs: 25 }).complete(REQUEST),
    ).rejects.toMatchObject({ kind: "retryable" });
  });

  test("adds the deadline to the caller's signal rather than replacing it", async () => {
    useFetch(stall());
    const slow = provider("openai-compatible", { requestTimeoutMs: 60_000 });
    await expect(slow.complete(REQUEST, AbortSignal.timeout(25))).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  test("an aborted call is transport, so it is retryable and not the article's fault", async () => {
    useFetch(stall());
    const controller = new AbortController();
    const pending = provider("openai-compatible").complete(REQUEST, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "retryable" });
  });
});

describe("base url", () => {
  test("tolerates a trailing slash, so a configured URL is not a special case", async () => {
    respondWithJson({ choices: [{ message: { content: "an answer" } }] });
    await provider("openai-compatible", { baseUrl: "https://chat.example/v1/" }).complete(REQUEST);

    expect(calls[0]?.url).toBe("https://chat.example/v1/chat/completions");
  });
});
