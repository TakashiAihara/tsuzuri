import { afterAll, describe, expect, test } from "bun:test";

import { ChatError, createChatProvider, unwrapJson } from "./chat.ts";

/**
 * Exercised against a real HTTP server, same rationale as embedding.test.ts:
 * what breaks here is protocol-shaped (a status code, a body shape, a
 * header), and a mocked fetch would only prove that the code calls the mock.
 */

type Handler = (request: Request) => Response | Promise<Response>;

let handler: Handler = () => new Response("no handler", { status: 500 });
const requests: unknown[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requests.push(
      await request
        .clone()
        .json()
        .catch(() => null),
    );
    return handler(request);
  },
});

const baseUrl = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
});

function provider(overrides: { model?: string; apiKey?: string; requestTimeoutMs?: number } = {}) {
  const created = createChatProvider({
    provider: "openai-compatible",
    baseUrl,
    model: overrides.model ?? "test-model",
    ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
    ...(overrides.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: overrides.requestTimeoutMs }
      : {}),
  });
  if (!created) throw new Error("expected a provider");
  return created;
}

function respondWithContent(content: unknown) {
  handler = () => Response.json({ choices: [{ message: { content } }] });
}

describe("createChatProvider", () => {
  test("returns null when the provider is none, so disabled is an absence", () => {
    expect(createChatProvider({ provider: "none" })).toBeNull();
  });

  test("refuses a provider configured without a base url or model", () => {
    expect(() => createChatProvider({ provider: "openai-compatible", model: "m" })).toThrow(
      /CHAT_BASE_URL/,
    );
    expect(() => createChatProvider({ provider: "openai-compatible", baseUrl })).toThrow(
      /CHAT_MODEL/,
    );
  });

  test("sends the system and user messages in order, temperature zero, and streaming disabled", async () => {
    requests.length = 0;
    respondWithContent("ok");
    await provider().complete({ system: "be terse", user: "summarise this" });
    expect(requests.at(-1)).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "summarise this" },
      ],
      temperature: 0,
      stream: false,
    });
  });

  test("adds response_format only when json output is requested", async () => {
    requests.length = 0;
    respondWithContent("ok");
    await provider().complete({ system: "s", user: "u", json: true });
    expect(requests.at(-1)).toMatchObject({ response_format: { type: "json_object" } });

    await provider().complete({ system: "s", user: "u" });
    expect(requests.at(-1)).not.toHaveProperty("response_format");
  });

  test("adds max_tokens only when an output limit is requested", async () => {
    requests.length = 0;
    respondWithContent("ok");
    await provider().complete({ system: "s", user: "u", maxOutputTokens: 64 });
    expect(requests.at(-1)).toMatchObject({ max_tokens: 64 });

    await provider().complete({ system: "s", user: "u" });
    expect(requests.at(-1)).not.toHaveProperty("max_tokens");
  });

  // Collected rather than assigned to a local: a local written only inside the
  // handler is narrowed to its initial type by control-flow analysis, which
  // the compiler is right about and the test is not.
  const authorizations: (string | null)[] = [];

  function recordAuthorization(): void {
    authorizations.length = 0;
    handler = (request) => {
      authorizations.push(request.headers.get("authorization"));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
  }

  test("sends the api key as a bearer token, and omits the header when none is configured", async () => {
    recordAuthorization();
    await provider({ apiKey: "secret" }).complete({ system: "s", user: "u" });
    expect(authorizations.at(-1)).toBe("Bearer secret");

    await provider().complete({ system: "s", user: "u" });
    expect(authorizations.at(-1)).toBeNull();
  });

  test("treats 5xx and 429 as retryable, and other 4xx as permanent", async () => {
    handler = () => new Response("upstream is unwell", { status: 500 });
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: true,
    });

    handler = () => new Response("slow down", { status: 429 });
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: true,
    });

    handler = () => new Response("bad request", { status: 400 });
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: false,
    });

    // A bad key fails identically forever, same as the bad request above:
    // retrying it just holds the item back from every later attempt.
    handler = () => new Response("bad key", { status: 401 });
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  test("reports an unreachable endpoint as retryable", async () => {
    const unreachable = createChatProvider({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
    });
    await expect(unreachable?.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: true,
    });
  });

  test("treats malformed JSON in the body as the provider's final answer, not a transport failure", async () => {
    // A model that ignores response_format can answer with plain prose
    // instead of JSON. That is the actual answer, not a glitch, so retrying
    // it would just spend another attempt producing the same text.
    handler = () => new Response("not json");
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  test("treats a deadline firing while the body is still arriving as transport, not a bad answer", async () => {
    // Distinct from the case above: here the response starts fine and the
    // connection just stalls mid-body, so the abort fires before any JSON.parse
    // runs. That is indistinguishable from any other dropped connection and
    // must be retried the same way, not blamed on the article.
    handler = () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"choices":'));
            await new Promise((resolve) => setTimeout(resolve, 500));
            controller.enqueue(new TextEncoder().encode("[]}"));
            controller.close();
          },
        }),
      );
    const slow = provider({ requestTimeoutMs: 30 });
    await expect(slow.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: true,
    });
  });

  test("returns plain string content as-is", async () => {
    respondWithContent("a plain answer");
    expect(await provider().complete({ system: "s", user: "u" })).toBe("a plain answer");
  });

  test("joins content given as an array of text parts", async () => {
    // Some servers answer in parts rather than a flat string; keeping only
    // the first part would silently truncate every such answer.
    respondWithContent([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(await provider().complete({ system: "s", user: "u" })).toBe("hello world");
  });

  test("raises a non-retryable error for a tool-call-only answer, rather than an empty summary", async () => {
    // content: null alongside a tool_calls field is a valid completion shape
    // from a model that chose to call a tool instead of answering. Returning
    // "" here would let that silently become an empty article summary.
    respondWithContent(null);
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toThrow(ChatError);
    await expect(provider().complete({ system: "s", user: "u" })).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe("unwrapJson", () => {
  test("strips a ```json fence", () => {
    expect(unwrapJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("strips a bare ``` fence", () => {
    expect(unwrapJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("leaves unfenced text alone", () => {
    expect(unwrapJson('{"a":1}')).toBe('{"a":1}');
  });

  test("does not mangle JSON that merely contains backticks inside a string value", () => {
    // The fence pattern is anchored to the whole trimmed answer; without that
    // anchor, a field holding a code snippet could be mistaken for a fence
    // and have its surrounding braces stripped out from under it.
    const json = '{"text":"wrap it in `code` please"}';
    expect(unwrapJson(json)).toBe(json);
  });
});
