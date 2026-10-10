import { afterEach, describe, expect, test } from "bun:test";

import { ChatError, createChatProvider, DEFAULT_ANTHROPIC_VERSION } from "./chat.ts";

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
  overrides: {
    baseUrl?: string;
    apiKey?: string;
    requestTimeoutMs?: number;
    anthropicVersion?: string;
  } = {},
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
    expect(calls[0]?.headers["anthropic-version"]).toBe(DEFAULT_ANTHROPIC_VERSION);
    expect(JSON.stringify(calls[0]?.body)).not.toContain("sk-ant");
  });

  test("sends a configured version instead of the default", async () => {
    respondWithJson({ content: [{ type: "text", text: "an answer" }] });
    await provider("anthropic", { anthropicVersion: "2099-01-01" }).complete(REQUEST);

    expect(calls[0]?.headers["anthropic-version"]).toBe("2099-01-01");
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

  test("refuses a response carrying no candidates", async () => {
    respondWithJson({ candidates: [] });
    await expect(provider("gemini").complete(REQUEST)).rejects.toThrow(/gemini shape/);
  });
});

describe("failure classification", () => {
  test("treats 5xx and 429 as retryable, and other 4xx as permanent", async () => {
    respondWithStatus(503, "upstream is unwell");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ retryable: true });

    respondWithStatus(429, "slow down");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ retryable: true });

    // A bad key fails identically forever; retrying it just holds the item
    // back from every later attempt.
    respondWithStatus(401, "bad key");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ retryable: false });

    respondWithStatus(400, "bad request");
    await expect(provider("gemini").complete(REQUEST)).rejects.toMatchObject({ retryable: false });
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
      retryable: false,
    });
  });

  test("treats a response in an unexpected shape as permanent", async () => {
    respondWithJson({ choices: [{ text: "not a message object" }] });
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      retryable: false,
    });
  });

  test("reports an unreachable endpoint as retryable", async () => {
    useFetch(() => Promise.reject(new TypeError("connection refused")));
    await expect(provider("openai-compatible").complete(REQUEST)).rejects.toMatchObject({
      retryable: true,
    });
  });

  test("gives up on an endpoint that accepts the connection and never answers", async () => {
    // fetch() has no timeout of its own, so without a deadline the enrichment
    // pass and the daemon's shutdown would both wait on a wedged local runtime.
    useFetch(stall());
    await expect(
      provider("openai-compatible", { requestTimeoutMs: 25 }).complete(REQUEST),
    ).rejects.toMatchObject({ retryable: true });
  });

  test("adds the deadline to the caller's signal rather than replacing it", async () => {
    useFetch(stall());
    const slow = provider("openai-compatible", { requestTimeoutMs: 60_000 });
    await expect(slow.complete(REQUEST, AbortSignal.timeout(25))).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe("base url", () => {
  test("tolerates a trailing slash, so a configured URL is not a special case", async () => {
    respondWithJson({ choices: [{ message: { content: "an answer" } }] });
    await provider("openai-compatible", { baseUrl: "https://chat.example/v1/" }).complete(REQUEST);

    expect(calls[0]?.url).toBe("https://chat.example/v1/chat/completions");
  });
});
