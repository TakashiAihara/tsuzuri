/**
 * Chat provider abstraction: the model that writes, as opposed to the one that
 * measures.
 *
 * Shaped like EmbeddingProvider and disabled the same way — by the absence of
 * a provider, not by a null object that returns empty summaries. Where the two
 * differ is what a change costs: an embedding model change rewrites every
 * vector on disk, a chat model change costs nothing, because nothing stored is
 * shaped by it. That is why this type has no equivalent of the dimension.
 *
 * One implementation ships. `openai-compatible` covers Ollama, LM Studio,
 * vLLM, OpenRouter, OpenAI, and both Anthropic and Gemini through their own
 * compatible endpoints. A native client for either is a second file
 * implementing this type and no change anywhere else (design D15).
 */

export type ChatRequest = {
  system: string;
  user: string;
  /**
   * Ask for JSON. Providers that support response_format honour it; the rest
   * ignore it, so callers must still parse defensively.
   */
  json?: boolean;
  /** Upper bound on the answer. Summaries are short by nature; tags shorter. */
  maxOutputTokens?: number;
};

export type ChatProvider = {
  id: "openai-compatible";
  model: string;
  complete: (request: ChatRequest, signal?: AbortSignal) => Promise<string>;
};

export type ChatProviderConfig = {
  provider: "none" | "openai-compatible";
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  requestTimeoutMs?: number | undefined;
};

/** Two minutes: a small local model summarising a long article is genuinely slow. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Same split as EmbeddingError, for the same reason: only a permanent,
 * provider-side rejection is evidence about the article. Everything else
 * describes the run, and charging it to the article would park it behind a
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

export function createChatProvider(config: ChatProviderConfig): ChatProvider | null {
  if (config.provider === "none") return null;

  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("CHAT_BASE_URL is required when CHAT_PROVIDER is set");
  if (!config.model) throw new Error("CHAT_MODEL is required when CHAT_PROVIDER is set");

  const model = config.model;
  const apiKey = config.apiKey;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    id: "openai-compatible",
    model,
    async complete(request, signal) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            ...(request.json ? { response_format: { type: "json_object" } } : {}),
            ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
            // Enrichment is a classification and compression task, not a
            // creative one: the same article should summarise the same way
            // twice, or replaying a prompt version proves nothing.
            temperature: 0,
            stream: false,
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
            : AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new ChatError(
          `chat request failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }

      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 500);
        const retryable = response.status >= 500 || response.status === 429;
        throw new ChatError(`chat request failed (${response.status}): ${body}`, retryable);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        // Only malformed JSON is the provider's final answer; a deadline
        // firing mid-body is transport. See the same split in embedding.ts.
        throw new ChatError(
          `chat response was unreadable: ${error instanceof Error ? error.message : String(error)}`,
          !(error instanceof SyntaxError),
        );
      }

      const content = firstMessageContent(payload);
      if (content === null) {
        throw new ChatError("chat response contained no message content", false);
      }
      return content;
    },
  };
}

/**
 * Pull the answer out of a chat completion.
 *
 * Hand-written rather than schema-parsed because the shape varies more than
 * the spec suggests: some servers answer with `content: null` and a tool call,
 * some wrap content in an array of parts. Anything this cannot read is a
 * permanent failure, not a silent empty summary.
 */
function firstMessageContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;

  // Some servers answer in parts rather than a flat string.
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
    return text.length > 0 ? text : null;
  }

  return null;
}

/**
 * Strip a fenced code block a model wrapped its JSON in.
 *
 * `response_format` is honoured by some endpoints and ignored by others, and
 * the ones that ignore it very often answer with ```json ... ```. Parsing that
 * as-is fails, and the failure looks like the model refusing the task.
 */
export function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}
