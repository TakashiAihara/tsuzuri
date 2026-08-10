import { z } from "zod";

/**
 * Embedding provider abstraction.
 *
 * One implementation ships: an OpenAI-compatible HTTP client, which covers
 * Ollama, LM Studio, vLLM, OpenRouter and OpenAI itself. Anything else — a
 * native Cohere or Gemini client — is a second file implementing this type and
 * no change anywhere else.
 *
 * "Disabled" is the absence of a provider, not a null object that returns empty
 * vectors. A null object would let callers write rows that look like embeddings
 * and are not, and the whole point of the opt-in design is that nothing
 * AI-shaped happens until someone turns it on.
 *
 * Note what is deliberately NOT on this type: the vector dimension. The
 * dimension is not a property of the transport, it is a fact about this
 * installation that pgvector has frozen into a column definition. It lives in
 * the database (see the embedding_model table) and is discovered once with
 * probeDimensions().
 */
export type EmbeddingProvider = {
  /** Implementation id, recorded so that a configuration change is detectable. */
  id: "openai-compatible";
  /** Model name as the endpoint knows it. */
  model: string;
  /**
   * Embed a batch of texts.
   *
   * The returned vectors are in the same order as the input, and the array has
   * the same length. Implementations must guarantee this even when the server
   * returns results out of order.
   */
  embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
};

export type EmbeddingProviderConfig = {
  provider: "none" | "openai-compatible";
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  /**
   * Requested output dimension.
   *
   * Only meaningful for models that accept a `dimensions` request parameter and
   * genuinely produce shorter vectors on request (OpenAI's text-embedding-3
   * family, and Matryoshka-trained models generally). Left unset, the model's
   * native size is used and discovered by probing.
   */
  dimensions?: number | undefined;
  /**
   * Per-request deadline.
   *
   * Not optional in practice: the common target is a local inference server,
   * and one that accepts a connection and then stops answering would otherwise
   * hang the backfill and the daemon's shutdown with it. fetch() has no default
   * timeout of its own.
   */
  requestTimeoutMs?: number | undefined;
};

/** Default per-request deadline. Generous, because a cold local model is slow. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * OpenAI's response shape, which every compatible server reproduces.
 *
 * `index` is parsed rather than ignored because the field exists precisely so
 * that a server may answer out of order, and a batch silently transposed would
 * attach every article's vector to the wrong article — a corruption that no
 * later check could detect.
 */
const embeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * Build the configured provider, or null when embeddings are switched off.
 *
 * Throws on a configuration that asks for a provider without the settings that
 * provider needs. That is a startup error rather than a silent fallback to
 * disabled: someone who set EMBEDDING_PROVIDER meant to enable embeddings, and
 * quietly ignoring them would look identical to the feature not working.
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider | null {
  if (config.provider === "none") return null;

  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER is set");
  if (!config.model) throw new Error("EMBEDDING_MODEL is required when EMBEDDING_PROVIDER is set");

  const model = config.model;
  const dimensions = config.dimensions;
  const apiKey = config.apiKey;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    id: "openai-compatible",
    model,
    async embed(texts, signal) {
      if (texts.length === 0) return [];

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            input: texts,
            ...(dimensions ? { dimensions } : {}),
            encoding_format: "float",
          }),
          // The caller's signal still cancels; the deadline is added to it
          // rather than replacing it.
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
            : AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        // Connection refused, DNS failure, timeout: the endpoint is a local
        // runtime often enough that "not running yet" is the common case.
        throw new EmbeddingError(
          `embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }

      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 500);
        // 4xx is a bad request or a bad key and will fail identically forever.
        // 429 is the exception: it is a 4xx that asks to be retried.
        const retryable = response.status >= 500 || response.status === 429;
        throw new EmbeddingError(
          `embedding request failed (${response.status}): ${body}`,
          retryable,
        );
      }

      // The deadline also aborts the response body, so a provider that sends
      // headers and then stalls fails here. Swallowing that would report it as
      // a malformed response -- permanent, and therefore blamed on the article
      // rather than on the endpoint that was merely slow.
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const aborted = name === "AbortError" || name === "TimeoutError";
        throw new EmbeddingError(
          `embedding response body could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
          aborted,
        );
      }

      const parsed = embeddingResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new EmbeddingError("embedding response was not in the expected shape", false);
      }

      const vectors: number[][] = new Array(texts.length);
      for (const entry of parsed.data.data) {
        if (entry.index >= texts.length) {
          throw new EmbeddingError(
            `embedding response referenced index ${entry.index} for a batch of ${texts.length}`,
            false,
          );
        }
        vectors[entry.index] = entry.embedding;
      }

      for (let i = 0; i < texts.length; i += 1) {
        if (!vectors[i]) {
          throw new EmbeddingError(`embedding response was missing a vector for input ${i}`, false);
        }
      }

      // A provider that changes vector length mid-batch would corrupt a column
      // whose dimension is fixed, and the database error would surface far from
      // the cause.
      const width = vectors[0]?.length ?? 0;
      if (width === 0 || vectors.some((vector) => vector.length !== width)) {
        throw new EmbeddingError("embedding response had inconsistent vector lengths", false);
      }

      // Servers are free to ignore the `dimensions` parameter, and a model that
      // does not support it answers at its native width without complaint. Left
      // unchecked, that width silently becomes the column definition and the
      // operator runs a different model than they configured.
      if (dimensions !== undefined && width !== dimensions) {
        throw new EmbeddingError(
          `EMBEDDING_DIMENSIONS is ${dimensions} but ${model} returned ${width} dimensions; ` +
            "this model does not honour the dimensions parameter",
          false,
        );
      }

      return vectors;
    },
  };
}

/**
 * Discover the provider's output dimension by embedding one short string.
 *
 * Probed rather than configured. A dimension typed into configuration that
 * disagrees with the model is a mistake nobody notices until search quality is
 * quietly wrong, whereas the probe costs one request, once, at first
 * enablement.
 */
export async function probeDimensions(
  provider: EmbeddingProvider,
  signal?: AbortSignal,
): Promise<number> {
  const [vector] = await provider.embed(["tsuzuri"], signal);
  if (!vector || vector.length === 0) {
    throw new EmbeddingError("provider returned no vector when probing the dimension", false);
  }
  return vector.length;
}

/**
 * The text an item is embedded from.
 *
 * Truncation is by characters, which only approximates the model's token
 * limit. That is why the default limit is set well below what the common models
 * accept: the approximation is worst for CJK, where a character can be a whole
 * token, and overshooting means the provider rejects the batch.
 */
export function embeddingInput(title: string | null, searchText: string, maxChars: number): string {
  const combined = [title ?? "", searchText].join("\n\n").replace(/\s+/g, " ").trim();
  return combined.slice(0, maxChars);
}

/** Render a vector as the text form pgvector parses, for binding as a parameter. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
