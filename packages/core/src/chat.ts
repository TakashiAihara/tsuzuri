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
  /**
   * Value for the `anthropic-version` header. See DEFAULT_ANTHROPIC_VERSION for
   * why this is the one setting a caller may have to supply.
   */
  anthropicVersion?: string | undefined;
};

/** CHAT_REQUEST_TIMEOUT_MS. Generous, because a local model summarising is slow. */
export const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 120_000;
/**
 * The value sent in the `anthropic-version` header.
 *
 * That wire format requires the header and the design document names it
 * without naming a value, so this constant is a property of the request this
 * module sends rather than a claim about any provider -- nothing here can
 * verify it. It is configurable for an endpoint that expects a different one.
 */
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * Same split as EmbeddingError, for the same reason: only a permanent,
 * provider-side rejection is evidence about the request. Everything else
 * describes the run, and charging it to the item would park the item behind a
 * backoff it did nothing to earn.
 */
export class ChatError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
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
  anthropicVersion: string;
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
    anthropicVersion: config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
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
 * 4xx is a bad request or a bad key and will fail identically forever, except
 * for 429, which is a 4xx asking to be retried. The deadline also covers the
 * response body, so an endpoint that sends headers and then stalls fails here
 * as transport rather than being blamed on the article.
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
      true,
    );
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 500);
    throw new ChatError(
      `chat request failed (${response.status}): ${text}`,
      isRetryable(response.status),
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
      !permanent,
    );
  }

  return payload;
}

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Reduce a response to the text it carries, or say that it carries none.
 *
 * A shape this cannot read is a permanent failure rather than an empty string:
 * an empty summary is indistinguishable from a model that had nothing to say,
 * and both would be stored as the same thing.
 */
function readReply<T>(
  payload: unknown,
  schema: z.ZodType<T>,
  extract: (value: T) => string | null,
  shape: string,
): string {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ChatError(`chat response was not in the ${shape} shape`, false);
  }

  const text = extract(parsed.data);
  if (text === null || text.trim().length === 0) {
    throw new ChatError(`chat response carried no text in the ${shape} shape`, false);
  }
  return text;
}

const openAiResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          // The part array is what an endpoint that answers in segments sends,
          // and reading only the first part would truncate every such answer.
          content: z.union([z.string(), z.array(z.object({ text: z.string() }))]).nullable(),
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
      return readReply(payload, openAiResponse, openAiText, "openai-compatible");
    },
  };
}

const anthropicResponse = z.object({
  // Blocks are typed and not every block carries text, so text is collected
  // from the ones that have it rather than demanded of the first.
  content: z.array(z.object({ text: z.string().optional() })).min(1),
});

function anthropicText(value: z.infer<typeof anthropicResponse>): string | null {
  return value.content.map((block) => block.text ?? "").join("");
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
          "anthropic-version": context.anthropicVersion,
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
      return readReply(payload, anthropicResponse, anthropicText, "anthropic");
    },
  };
}

const geminiResponse = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string() })) }) }))
    .min(1),
});

function geminiText(value: z.infer<typeof geminiResponse>): string | null {
  return (value.candidates[0]?.content.parts ?? []).map((part) => part.text).join("");
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
        `${context.baseUrl}/v1beta/models/${context.model}:generateContent`,
        context.apiKey ? { "x-goog-api-key": context.apiKey } : {},
        {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: { maxOutputTokens: request.maxOutputTokens, temperature: 0 },
        },
        { requestTimeoutMs: context.requestTimeoutMs, signal },
      );
      return readReply(payload, geminiResponse, geminiText, "gemini");
    },
  };
}
