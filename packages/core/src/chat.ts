import { z } from "zod";

/**
 * Chat provider abstraction: the model that writes, as opposed to the one that
 * measures.
 *
 * Shaped like EmbeddingProvider and disabled the same way -- by the absence of
 * a provider, not by a null object that returns an empty summary, which would
 * let callers write rows that look like enrichments and are not.
 *
 * Note what is deliberately not on this type: the vector dimension. A
 * dimension is a fact about the column pgvector froze, and it exists because
 * vectors are shared between models. A chat model shapes nothing on disk, so
 * changing it costs nothing; that is why every enrichment row records the model
 * and the prompt version that produced it instead.
 */
export type ChatProvider = {
  /** Implementation id, recorded so a configuration change is detectable. */
  id: "openai-compatible" | "anthropic" | "gemini";
  /** Model name as the endpoint knows it. */
  model: string;
  /** One completion. No streaming: nothing here renders as it arrives. */
  complete: (request: ChatRequest, signal?: AbortSignal) => Promise<string>;
};

export type ChatRequest = {
  system: string;
  user: string;
  maxOutputTokens: number;
};

export type ChatProviderId = ChatProvider["id"];

export type ChatProviderConfig = {
  provider: "none" | ChatProviderId;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  /**
   * Per-request deadline.
   *
   * Not optional in practice: the common target is a local runtime, and one
   * that accepts a connection and then stops answering would otherwise hang the
   * enrichment pass and the daemon's shutdown with it. fetch() has no default
   * timeout of its own.
   */
  requestTimeoutMs?: number | undefined;
};

/** CHAT_REQUEST_TIMEOUT_MS. Generous, because a local model summarising is slow. */
export const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 120_000;
/**
 * The value sent in the `anthropic-version` header.
 *
 * The wire format requires the header and the design document names it without
 * naming a value, so this constant is a property of the request this module
 * sends. Nothing here can check that an endpoint accepts it.
 */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Why a request failed, and therefore what may be done about it.
 *
 * `retryable` and `configuration` both describe the run rather than the item:
 * the endpoint was unwell, or this installation asked for something the
 * endpoint will not do. Neither says anything about the article, so neither is
 * recorded against one. They stay apart because the operator does different
 * things about them -- wait, or change the configuration -- and an answer that
 * only says "try again" is as unhelpful for a bad key as it is for an outage.
 *
 * `permanent` is the only one that is evidence about the request, and the only
 * one an item is charged with.
 */
export type ChatErrorKind = "retryable" | "configuration" | "permanent";

/**
 * Same split as EmbeddingError, for the same reason: only a permanent,
 * provider-side rejection is evidence about the request. Everything else
 * describes the run, and charging it to the item would park the item behind a
 * backoff it did nothing to earn.
 */
export class ChatError extends Error {
  constructor(
    message: string,
    readonly kind: ChatErrorKind,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** Everything the three implementations share once a provider has been chosen. */
type ProviderContext = {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  requestTimeoutMs: number;
};

/**
 * Build the configured provider, or null when enrichment is switched off.
 *
 * Throws on a configuration that asks for a provider without the settings that
 * provider needs. That is a startup error rather than a silent fallback to
 * disabled: someone who set CHAT_PROVIDER meant to turn enrichment on, and
 * quietly ignoring it would look identical to the feature not working.
 */
export function createChatProvider(config: ChatProviderConfig): ChatProvider | null {
  if (config.provider === "none") return null;

  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("CHAT_BASE_URL is required when CHAT_PROVIDER is set");
  if (!config.model) throw new Error("CHAT_MODEL is required when CHAT_PROVIDER is set");

  const context: ProviderContext = {
    baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
  };

  switch (config.provider) {
    case "openai-compatible":
      return openAiCompatible(context);
    case "anthropic":
      return anthropic(context);
    case "gemini":
      return gemini(context);
  }
}

/**
 * One request, and the classification every implementation shares.
 *
 * The deadline also covers the response body, so an endpoint that sends headers
 * and then stalls fails here as transport rather than being blamed on the
 * article.
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { requestTimeoutMs: number; signal?: AbortSignal | undefined },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      // The caller's signal still cancels; the deadline is added to it rather
      // than replacing it.
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs)])
        : AbortSignal.timeout(options.requestTimeoutMs),
    });
  } catch (error) {
    // Connection refused, DNS failure, timeout: the endpoint is a local
    // runtime often enough that "not running yet" is the common case.
    throw new ChatError(
      `chat request failed: ${error instanceof Error ? error.message : String(error)}`,
      "retryable",
    );
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 500);
    throw new ChatError(
      `chat request failed (${response.status}): ${text}`,
      classifyStatus(response.status),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // Only malformed JSON is the endpoint's final answer. Everything else here
    // is transport -- a deadline firing mid-body, a connection dropping -- and
    // the runtime is not consistent about what it names those, so they are
    // classified by what they are not.
    const permanent = error instanceof SyntaxError;
    throw new ChatError(
      `chat response body could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      permanent ? "permanent" : "retryable",
    );
  }

  return payload;
}

/**
 * What a status says about the cause.
 *
 * 4xx asks for a different request and 5xx asks for another try, with 429 the
 * one 4xx that asks for another try. The four statuses that name a setup
 * mistake -- a key refused, a path that does not exist, a model that does not
 * exist, a body the endpoint will not accept -- are separated out because every
 * item would fail them identically, and parking every item behind a backoff for
 * a typo is how one wrong variable stops enrichment for a day.
 */
function classifyStatus(status: number): ChatErrorKind {
  if (status === 429 || status >= 500) return "retryable";
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return "configuration";
  }
  return "permanent";
}

/**
 * An answer that stopped because the output bound was reached.
 *
 * Not a parse failure: the answer is complete JSON up to the point the bound
 * bit, and retrying it with the same bound produces the same truncated answer.
 * The fix is a larger CHAT_MAX_OUTPUT_TOKENS, which is a change to this
 * installation rather than to any article, so it is classified like every other
 * configuration error.
 */
function outputLimitError(provider: string, limit: number): ChatError {
  return new ChatError(
    `${provider} reached the ${limit}-token output bound; raise CHAT_MAX_OUTPUT_TOKENS`,
    "configuration",
  );
}

/**
 * Reduce a response to the text it carries, or say that it carries none.
 *
 * A shape this cannot read is a permanent failure rather than an empty string:
 * an empty summary is indistinguishable from a model that had nothing to say,
 * and both would be stored as the same thing.
 *
 * `limit` is read from the response's own stop reason rather than guessed from
 * an empty answer, because a model that spent its whole budget reasoning
 * answers with no text and no JSON, which retries identically.
 */
function readReply<T>(
  payload: unknown,
  schema: z.ZodType<T>,
  read: (value: T) => Reply,
  shape: string,
  limit: number,
): string {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ChatError(`chat response was not in the ${shape} shape`, "permanent");
  }

  const reply = read(parsed.data);
  if (reply.stoppedAtLimit) throw outputLimitError(shape, limit);

  const text = reply.text;
  if (text === null || text.trim().length === 0) {
    throw new ChatError(`chat response carried no text in the ${shape} shape`, "permanent");
  }
  return text;
}

/** One answer, and whether the endpoint says it stopped at the output bound. */
type Reply = { text: string | null; stoppedAtLimit: boolean };

const openAiResponse = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          // The part array is what an endpoint that answers in segments sends,
          // and reading only the first part would truncate every such answer.
          content: z.union([z.string(), z.array(z.object({ text: z.string() }))]).nullable(),
          // Read only to recognise an answer that spent its whole budget
          // reasoning and produced no text; the text of either is never used.
          reasoning_content: z.string().nullish(),
          reasoning: z.string().nullish(),
        }),
      }),
    )
    .min(1),
});

function openAiText(value: z.infer<typeof openAiResponse>): string | null {
  const content = value.choices[0]?.message.content ?? null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text).join("");
  return null;
}

function openAiReply(value: z.infer<typeof openAiResponse>): Reply {
  const choice = value.choices[0];
  const text = openAiText(value);
  const reasoned =
    (choice?.message.reasoning_content?.trim().length ?? 0) > 0 ||
    (choice?.message.reasoning?.trim().length ?? 0) > 0;
  return {
    text,
    stoppedAtLimit: choice?.finish_reason === "length" || (reasoned && !text?.trim()),
  };
}

/**
 * One OpenAI-compatible client, which is also the one that reaches Ollama, LM
 * Studio, vLLM and OpenRouter: their chat routes are this one.
 */
function openAiCompatible(context: ProviderContext): ChatProvider {
  return {
    id: "openai-compatible",
    model: context.model,
    async complete(request, signal) {
      const payload = await postJson(
        `${context.baseUrl}/chat/completions`,
        context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {},
        {
          model: context.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          max_tokens: request.maxOutputTokens,
          // Enrichment is a classification and a compression, not a creative
          // task: the same article should answer the same way twice, or
          // replaying a prompt version measures the weather instead.
          temperature: 0,
        },
        { requestTimeoutMs: context.requestTimeoutMs, signal },
      );
      return readReply(
        payload,
        openAiResponse,
        openAiReply,
        "openai-compatible",
        request.maxOutputTokens,
      );
    },
  };
}

const anthropicResponse = z.object({
  stop_reason: z.string().nullish(),
  // Blocks are typed and not every block carries text, so text is collected
  // from the ones that have it rather than demanded of the first.
  content: z
    .array(z.object({ text: z.string().optional(), thinking: z.string().optional() }))
    .min(1),
});

function anthropicReply(value: z.infer<typeof anthropicResponse>): Reply {
  const text = value.content.map((block) => block.text ?? "").join("");
  const reasoned = value.content.some((block) => (block.thinking?.trim().length ?? 0) > 0);
  return {
    text,
    stoppedAtLimit: value.stop_reason === "max_tokens" || (reasoned && text.trim().length === 0),
  };
}

/** Anthropic's wire format: the system prompt is a top-level field, not a message. */
function anthropic(context: ProviderContext): ChatProvider {
  return {
    id: "anthropic",
    model: context.model,
    async complete(request, signal) {
      const payload = await postJson(
        `${context.baseUrl}/v1/messages`,
        {
          "anthropic-version": ANTHROPIC_VERSION,
          ...(context.apiKey ? { "x-api-key": context.apiKey } : {}),
        },
        {
          model: context.model,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          max_tokens: request.maxOutputTokens,
          temperature: 0,
        },
        { requestTimeoutMs: context.requestTimeoutMs, signal },
      );
      return readReply(
        payload,
        anthropicResponse,
        anthropicReply,
        "anthropic",
        request.maxOutputTokens,
      );
    },
  };
}

const geminiResponse = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().nullish(),
        content: z.object({
          // `thought` marks a part the model produced while reasoning. It is
          // read only to recognise an answer that ran out of budget mid-thought.
          parts: z.array(
            z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
          ),
        }),
      }),
    )
    .min(1),
});

function geminiReply(value: z.infer<typeof geminiResponse>): Reply {
  const candidate = value.candidates[0];
  const parts = candidate?.content.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");
  const reasoned = parts.some((part) => part.thought === true);
  return {
    text,
    stoppedAtLimit:
      candidate?.finishReason === "MAX_TOKENS" || (reasoned && text.trim().length === 0),
  };
}

/**
 * Gemini's wire format: the system prompt is its own field, the model is part
 * of the path, and the key is a header rather than a query parameter -- a
 * credential in a URL is a credential in every log between here and the
 * endpoint.
 */
function gemini(context: ProviderContext): ChatProvider {
  return {
    id: "gemini",
    model: context.model,
    async complete(request, signal) {
      const payload = await postJson(
        // A model name is a path segment and may carry a slash or a space; an
        // unencoded one asks for a different resource than the one configured.
        `${context.baseUrl}/v1beta/models/${encodeURIComponent(context.model)}:generateContent`,
        context.apiKey ? { "x-goog-api-key": context.apiKey } : {},
        {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: { maxOutputTokens: request.maxOutputTokens, temperature: 0 },
        },
        { requestTimeoutMs: context.requestTimeoutMs, signal },
      );
      return readReply(payload, geminiResponse, geminiReply, "gemini", request.maxOutputTokens);
    },
  };
}
