import { z } from "zod";

/**
 * Runtime configuration, read from the environment.
 *
 * Everything optional has a default that works on a fresh install. Nothing here
 * refers to a specific host, model or provider: AI is off until someone turns
 * it on, and the reader is fully usable in that state.
 */
const configSchema = z.object({
  DATABASE_URL: z.string().min(1),

  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),

  /** Identifies the crawler to site owners, with a way to reach the project. */
  USER_AGENT: z.string().default("tsuzuri/0.1 (+https://github.com/TakashiAihara/tsuzuri)"),

  /** Per-request timeout for fetching a feed. */
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  /**
   * Minimum gap between requests to the same host. Politeness, not tuning:
   * a couple of hundred subscriptions can otherwise hammer one publisher that
   * hosts many of them.
   */
  HOST_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

  /** How many feeds to fetch at once. */
  FETCH_CONCURRENCY: z.coerce.number().int().positive().default(20),

  /** Default polling interval for a new subscription. */
  DEFAULT_FETCH_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(3600),

  /** Consecutive failures before a source is marked degraded. */
  DEGRADE_AFTER_FAILURES: z.coerce.number().int().positive().default(5),

  /**
   * Embeddings. Off by default, and there is deliberately no default model:
   * a model cannot be chosen on someone's behalf when choosing one commits
   * their database to a vector dimension.
   */
  EMBEDDING_PROVIDER: z.enum(["none", "openai-compatible"]).default("none"),
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 for Ollama. */
  EMBEDDING_BASE_URL: z.string().optional(),
  /** Optional; local runtimes usually want no key at all. */
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  /**
   * Requested output width, for models that accept a `dimensions` parameter.
   * Left unset, the model's native width is discovered by probing.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(512).default(32),
  /** Concurrent requests. Low, because the common target is one local GPU. */
  EMBEDDING_CONCURRENCY: z.coerce.number().int().positive().max(32).default(2),
  /** Characters of an article sent for embedding. See embeddingInput(). */
  EMBEDDING_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(8_000),
  /** Per-request deadline for the embedding endpoint. */
  EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Cosine distance beyond which a vector candidate is not a result.
   *
   * The vector arm returns its nearest N however far away they are, so without
   * a ceiling a query few documents match textually fills its tail with
   * whatever happens to exist. Tune per corpus and per model.
   */
  SEARCH_MAX_DISTANCE: z.coerce.number().positive().max(2).default(0.6),
});

/**
 * A provider without a model or a base URL is a configuration error, not a
 * disabled feature.
 *
 * The daemon tolerates embeddings failing to start so that a broken optional
 * feature cannot stop the reader. That tolerance would otherwise turn a typo
 * into silence: someone sets EMBEDDING_PROVIDER, embeddings never run, and
 * nothing says why. Catching it in the schema makes it a startup error with
 * the missing variable named.
 */
const configSchemaWithEmbeddingRules = configSchema.superRefine((config, ctx) => {
  if (config.EMBEDDING_PROVIDER === "none") return;
  for (const key of ["EMBEDDING_BASE_URL", "EMBEDDING_MODEL"] as const) {
    if (!config[key]) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `required when EMBEDDING_PROVIDER is "${config.EMBEDDING_PROVIDER}"`,
      });
    }
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchemaWithEmbeddingRules.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
