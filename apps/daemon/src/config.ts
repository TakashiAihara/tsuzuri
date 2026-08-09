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
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
