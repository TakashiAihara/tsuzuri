import { afterAll, describe, expect, test } from "bun:test";

import {
  createEmbeddingProvider,
  EmbeddingError,
  embeddingInput,
  probeDimensions,
  toVectorLiteral,
} from "./embedding.ts";

/**
 * The provider is exercised against a real HTTP server rather than a mocked
 * fetch, because most of what can go wrong here is protocol-shaped: a status
 * code, a body that does not match the schema, results in the wrong order.
 * A mock of fetch would only assert that the code calls the mock.
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

function provider(overrides: { model?: string; dimensions?: number; apiKey?: string } = {}) {
  const created = createEmbeddingProvider({
    provider: "openai-compatible",
    baseUrl,
    model: overrides.model ?? "test-model",
    ...(overrides.dimensions !== undefined ? { dimensions: overrides.dimensions } : {}),
    ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
  });
  if (!created) throw new Error("expected a provider");
  return created;
}

function respondWith(vectors: number[][], options: { shuffle?: boolean } = {}) {
  handler = () => {
    const data = vectors.map((embedding, index) => ({ index, embedding }));
    return Response.json({ data: options.shuffle ? [...data].reverse() : data });
  };
}

describe("createEmbeddingProvider", () => {
  test("returns null when the provider is none, so disabled is an absence", () => {
    expect(createEmbeddingProvider({ provider: "none" })).toBeNull();
  });

  test("refuses a provider configured without a base url or model", () => {
    expect(() => createEmbeddingProvider({ provider: "openai-compatible", model: "m" })).toThrow(
      /EMBEDDING_BASE_URL/,
    );
    expect(() => createEmbeddingProvider({ provider: "openai-compatible", baseUrl })).toThrow(
      /EMBEDDING_MODEL/,
    );
  });

  test("embeds a batch and returns one vector per input", async () => {
    respondWith([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const vectors = await provider().embed(["a", "b"]);
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  test("restores order from index when the server answers out of order", async () => {
    // The whole reason index is parsed: a transposed batch would attach every
    // article's vector to the wrong article, undetectably.
    respondWith(
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      { shuffle: true },
    );
    expect(await provider().embed(["a", "b"])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  // Collected rather than assigned to a local: a local written only inside the
  // handler is narrowed to its initial type by control-flow analysis, which the
  // compiler is right about and the test is not.
  const authorizations: (string | null)[] = [];

  function recordAuthorization(): void {
    authorizations.length = 0;
    handler = (request) => {
      authorizations.push(request.headers.get("authorization"));
      return Response.json({ data: [{ index: 0, embedding: [1] }] });
    };
  }

  test("sends the model, the inputs and an api key when given one", async () => {
    requests.length = 0;
    recordAuthorization();
    await provider({ apiKey: "secret" }).embed(["hello"]);
    expect(authorizations.at(-1)).toBe("Bearer secret");
    expect(requests.at(-1)).toMatchObject({ model: "test-model", input: ["hello"] });
  });

  test("omits the authorization header when no key is configured", async () => {
    recordAuthorization();
    await provider().embed(["hello"]);
    expect(authorizations.at(-1)).toBeNull();
  });

  test("passes a requested dimension through, and omits it when unset", async () => {
    requests.length = 0;
    respondWith([[1, 2]]);
    await provider({ dimensions: 2 }).embed(["a"]);
    expect(requests.at(-1)).toMatchObject({ dimensions: 2 });

    await provider().embed(["a"]);
    expect(requests.at(-1)).not.toHaveProperty("dimensions");
  });

  test("makes no request for an empty batch", async () => {
    requests.length = 0;
    expect(await provider().embed([])).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test("treats 5xx and 429 as retryable, and other 4xx as permanent", async () => {
    handler = () => new Response("upstream is unwell", { status: 503 });
    await expect(provider().embed(["a"])).rejects.toMatchObject({ retryable: true });

    handler = () => new Response("slow down", { status: 429 });
    await expect(provider().embed(["a"])).rejects.toMatchObject({ retryable: true });

    // A bad key or a bad request fails identically forever; retrying it just
    // holds the item back from every later attempt.
    handler = () => new Response("bad key", { status: 401 });
    await expect(provider().embed(["a"])).rejects.toMatchObject({ retryable: false });
  });

  test("rejects a response that does not match the schema", async () => {
    handler = () => Response.json({ nonsense: true });
    await expect(provider().embed(["a"])).rejects.toThrow(EmbeddingError);
  });

  test("rejects a response missing a vector for one of the inputs", async () => {
    handler = () => Response.json({ data: [{ index: 0, embedding: [1] }] });
    await expect(provider().embed(["a", "b"])).rejects.toThrow(/missing a vector/);
  });

  test("rejects an index outside the batch", async () => {
    handler = () => Response.json({ data: [{ index: 7, embedding: [1] }] });
    await expect(provider().embed(["a"])).rejects.toThrow(/referenced index 7/);
  });

  test("rejects vectors of differing length, which would corrupt a fixed column", async () => {
    handler = () =>
      Response.json({
        data: [
          { index: 0, embedding: [1, 2, 3] },
          { index: 1, embedding: [1, 2] },
        ],
      });
    await expect(provider().embed(["a", "b"])).rejects.toThrow(/inconsistent vector lengths/);
  });

  test("asserts a requested dimension against what came back", async () => {
    // A server is free to ignore the dimensions parameter, and a model that
    // does not support it answers at its native width without complaint. That
    // width would otherwise become the column definition.
    respondWith([[1, 2, 3, 4, 5, 6, 7, 8]]);
    await expect(provider({ dimensions: 4 }).embed(["a"])).rejects.toThrow(
      /does not honour the dimensions parameter/,
    );
  });

  test("accepts a requested dimension the model honours", async () => {
    respondWith([[1, 2, 3, 4]]);
    expect(await provider({ dimensions: 4 }).embed(["a"])).toEqual([[1, 2, 3, 4]]);
  });

  test("gives up on a server that accepts the connection and never answers", async () => {
    // fetch() has no timeout of its own, so without a deadline the backfill and
    // the daemon's shutdown would both wait forever on a wedged local runtime.
    handler = () => new Promise<Response>(() => {});
    const slow = createEmbeddingProvider({
      provider: "openai-compatible",
      baseUrl,
      model: "m",
      requestTimeoutMs: 100,
    });
    await expect(slow?.embed(["a"])).rejects.toMatchObject({ retryable: true });
  });

  test("reports an unreachable endpoint as retryable", async () => {
    const unreachable = createEmbeddingProvider({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
    });
    await expect(unreachable?.embed(["a"])).rejects.toMatchObject({ retryable: true });
  });

  test("tolerates a trailing slash on the base url", async () => {
    respondWith([[1]]);
    const created = createEmbeddingProvider({
      provider: "openai-compatible",
      baseUrl: `${baseUrl}/`,
      model: "m",
    });
    expect(await created?.embed(["a"])).toEqual([[1]]);
  });
});

describe("probeDimensions", () => {
  test("reports the width the model actually produced", async () => {
    respondWith([[0, 0, 0, 0, 0, 0]]);
    expect(await probeDimensions(provider())).toBe(6);
  });

  test("refuses an empty vector rather than recording a zero-width column", async () => {
    handler = () => Response.json({ data: [{ index: 0, embedding: [] }] });
    await expect(probeDimensions(provider())).rejects.toThrow(EmbeddingError);
  });
});

describe("embeddingInput", () => {
  test("joins the title and body and collapses whitespace", () => {
    expect(embeddingInput("Title", "body   text\n\nmore", 100)).toBe("Title body text more");
  });

  test("survives a missing title", () => {
    expect(embeddingInput(null, "body", 100)).toBe("body");
  });

  test("truncates to the character budget", () => {
    expect(embeddingInput("t", "x".repeat(50), 10)).toHaveLength(10);
  });

  test("counts CJK by character, which is where the budget matters most", () => {
    // A character can be a whole token here, so the budget has to bite on the
    // string rather than on some byte length.
    expect(embeddingInput(null, "あ".repeat(50), 10)).toBe("あ".repeat(10));
  });
});

describe("toVectorLiteral", () => {
  test("renders the text form pgvector parses", () => {
    expect(toVectorLiteral([1, -0.5, 0])).toBe("[1,-0.5,0]");
  });
});
