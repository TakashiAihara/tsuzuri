import { createEmbeddingProvider, type EmbeddingProvider, probeDimensions } from "@tsuzuri/core";
import {
  createEmbeddingIndex,
  type EmbeddingCounts,
  embeddingCounts,
  embeddingIndexExists,
  ensureItemEmbeddings,
  readEmbeddingModel,
  rebuildItemEmbeddings,
  writeEmbeddingModel,
} from "@tsuzuri/db";
import type postgres from "postgres";

import type { Config } from "../config.ts";
import { type EmbedWorker, runEmbedPass, startEmbedWorker } from "./embed-worker.ts";
import { decideEmbeddingState, describeMismatch, type EmbeddingState } from "./embedding-state.ts";

/**
 * Owns everything about the embedding feature at runtime: which model is
 * active, whether the worker should be running, and the one operation that
 * destroys vectors.
 *
 * Kept apart from ingest on purpose. Nothing here can prevent an article being
 * stored, which is what makes it safe for the whole feature to be absent.
 */

export type EmbeddingStatus = {
  state: EmbeddingState["status"];
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  /** Set when state is "mismatch", explaining what to do about it. */
  message?: string;
  indexBuilt: boolean;
  reindexing: boolean;
  /**
   * Why the last rebuild stopped, when it did not finish.
   *
   * A rebuild runs detached from the request that asked for it, so without
   * this a failure is visible only in the daemon's log: status would flip
   * reindexing back to false and every caller would read that as success.
   */
  lastReindexError: string | null;
  counts: EmbeddingCounts;
};

export type EmbeddingService = {
  /** Resolve state, initialising on first enablement, and start the worker if ready. */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => Promise<EmbeddingStatus>;
  /** The provider, only when vectors may actually be produced or queried. */
  activeProvider: () => { provider: EmbeddingProvider; dimensions: number } | null;
  reindex: (options: { model: string }) => Promise<void>;
};

export function createEmbeddingService(deps: {
  sql: postgres.Sql;
  config: Config;
}): EmbeddingService {
  const { sql, config } = deps;

  const provider = createEmbeddingProvider({
    provider: config.EMBEDDING_PROVIDER,
    baseUrl: config.EMBEDDING_BASE_URL,
    apiKey: config.EMBEDDING_API_KEY,
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    requestTimeoutMs: config.EMBEDDING_REQUEST_TIMEOUT_MS,
  });

  const configured = provider ? { provider: provider.id, model: provider.model } : null;

  let state: EmbeddingState = { status: "disabled" };
  let dimensions: number | null = null;
  let worker: EmbedWorker | null = null;
  let reindexing = false;
  let lastReindexError: string | null = null;
  /** Set once stop() has been called, so nothing starts the worker again. */
  let stopped = false;

  const workerOptions = (active: EmbeddingProvider) => ({
    sql,
    provider: active,
    batchSize: config.EMBEDDING_BATCH_SIZE,
    concurrency: config.EMBEDDING_CONCURRENCY,
    maxInputChars: config.EMBEDDING_MAX_INPUT_CHARS,
  });

  async function resolve(): Promise<void> {
    state = decideEmbeddingState(configured, await readEmbeddingModel(sql));

    if (state.status === "uninitialised" && provider) {
      // First enablement: ask the provider how wide its vectors are, then build
      // the column to fit. This is the only moment the dimension is decided.
      const probed = await probeDimensions(provider);
      await ensureItemEmbeddings(sql, probed);
      await writeEmbeddingModel(sql, {
        provider: provider.id,
        model: provider.model,
        dimensions: probed,
      });
      console.error(`embeddings enabled: ${provider.id}/${provider.model}, ${probed} dimensions`);
      state = { status: "ready", configured: state.configured, dimensions: probed };
    }

    if (state.status === "ready") {
      dimensions = state.dimensions;
      // A record can exist while the table does not, if a rebuild was
      // interrupted between the two. Cheap to assert, and it makes the restart
      // path self-healing.
      await ensureItemEmbeddings(sql, state.dimensions);
    } else {
      dimensions = null;
    }

    if (state.status === "mismatch") console.error(describeMismatch(state));
  }

  function startWorker(): void {
    if (stopped || state.status !== "ready" || !provider || worker) return;
    worker = startEmbedWorker(workerOptions(provider));
  }

  async function stopWorker(): Promise<void> {
    if (!worker) return;
    worker.stop();
    await worker.done;
    worker = null;
  }

  return {
    async start() {
      await resolve();
      startWorker();
    },

    async stop() {
      // Before stopWorker(), so that a reindex finishing concurrently cannot
      // start a fresh worker from its finally block and outlive shutdown.
      stopped = true;
      await stopWorker();
    },

    activeProvider() {
      if (state.status !== "ready" || !provider || dimensions === null) return null;
      return { provider, dimensions };
    },

    async status() {
      return {
        state: state.status,
        provider: state.status === "disabled" ? null : (configured?.provider ?? null),
        model: state.status === "disabled" ? null : (configured?.model ?? null),
        dimensions,
        ...(state.status === "mismatch" ? { message: describeMismatch(state) } : {}),
        indexBuilt: await embeddingIndexExists(sql),
        reindexing,
        lastReindexError,
        counts: await embeddingCounts(sql),
      };
    },

    /**
     * Re-embed everything into the configured model.
     *
     * The `model` argument must name the model that is already configured in
     * the environment. It does not select a model: configuration has exactly
     * one home, and a flag that also configured would be a second one that
     * disagreed with it on the next restart. What the argument buys is that a
     * command which destroys every vector cannot be run without naming what is
     * being rebuilt.
     */
    async reindex({ model }) {
      if (!provider) {
        throw new Error("no embedding provider is configured; set EMBEDDING_PROVIDER first");
      }
      if (model !== provider.model) {
        throw new Error(
          `--embedding-model ${model} does not match the configured EMBEDDING_MODEL ` +
            `(${provider.model}). Change the environment first, then run this to rebuild.`,
        );
      }
      if (reindexing) throw new Error("a reindex is already running");

      reindexing = true;
      lastReindexError = null;
      try {
        await stopWorker();

        const probed = await probeDimensions(provider);
        await rebuildItemEmbeddings(sql, probed);
        await writeEmbeddingModel(sql, {
          provider: provider.id,
          model: provider.model,
          dimensions: probed,
        });
        state = {
          status: "ready",
          configured: { provider: provider.id, model: provider.model },
          dimensions: probed,
        };
        dimensions = probed;

        // Backfill with the index off, then build it once over the full table.
        for (;;) {
          const pass = await runEmbedPass(workerOptions(provider));
          if (pass.idle) break;
        }
        await createEmbeddingIndex(sql);
      } catch (error) {
        lastReindexError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        reindexing = false;
        startWorker();
      }
    },
  };
}
