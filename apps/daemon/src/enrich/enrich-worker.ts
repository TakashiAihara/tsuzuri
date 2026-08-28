import {
  articleInput,
  ChatError,
  type ChatProvider,
  parseSummary,
  parseTags,
  parseTranslation,
  summaryPrompt,
  tagsPrompt,
  translationPrompt,
} from "@tsuzuri/core";
import {
  approvedTags,
  clearEnrichmentFailure,
  DEFAULT_USER_ID,
  type EnrichmentKind,
  enrichmentCandidates,
  recordCandidates,
  recordEnrichmentFailure,
  setItemTags,
  writeEnrichment,
} from "@tsuzuri/db";
import type postgres from "postgres";

import type { Config } from "../config.ts";

/**
 * LLM enrichment: summaries, translations and tags for the articles worth the
 * model call.
 *
 * Deliberately not every article. Sending a day's ingest to a chat model is
 * the cost failure the two-stage pipeline exists to avoid, so this runs over
 * the top of the interest ranking and a recency window, and everything it
 * writes is replayable rather than authoritative.
 */

export type EnrichPassResult = {
  summarised: number;
  translated: number;
  tagged: number;
  failed: number;
  idle: boolean;
};

export type EnrichWorkerOptions = {
  sql: postgres.Sql;
  config: Config;
  provider: ChatProvider;
  /** True when an interest profile exists to rank candidates by. */
  scoringActive: () => Promise<boolean>;
  now?: () => Date;
  signal?: AbortSignal;
};

/**
 * Run one kind over its candidates.
 *
 * Each kind is selected and recorded independently: a model that reliably
 * summarises but cannot follow the tagging schema should keep producing
 * summaries, and a backoff on one kind must not hold back the others.
 */
async function runKind(
  kind: EnrichmentKind,
  options: EnrichWorkerOptions,
  handle: (item: { id: string; title: string | null; searchText: string }) => Promise<boolean>,
  promptVersion: string,
): Promise<{ done: number; failed: number }> {
  const { sql, config, provider } = options;
  const now = options.now?.() ?? new Date();

  const candidates = await enrichmentCandidates(sql, {
    kind,
    promptVersion,
    chatModel: provider.model,
    limit: config.ENRICH_TOP_N,
    windowHours: config.ENRICH_WINDOW_HOURS,
    userId: DEFAULT_USER_ID,
    orderByInterest: await options.scoringActive(),
    now,
  });

  let done = 0;
  let failed = 0;

  for (const item of candidates) {
    if (options.signal?.aborted) break;
    try {
      if (await handle(item)) done += 1;
      await clearEnrichmentFailure(sql, item.id, kind);
    } catch (error) {
      // Only a permanent, provider-side rejection is evidence about this
      // article. A retryable outage or a shutdown describes the run, and
      // charging it to the article would park it behind a backoff it did
      // nothing to earn -- and would stop the whole pass, since the next
      // article would hit the same outage.
      if (!(error instanceof ChatError) || error.retryable) throw error;
      await recordEnrichmentFailure(sql, item.id, kind, error.message, now);
      failed += 1;
    }
  }

  return { done, failed };
}

export async function runEnrichPass(options: EnrichWorkerOptions): Promise<EnrichPassResult> {
  const { sql, config, provider } = options;
  const now = options.now?.() ?? new Date();

  const summary = await runKind(
    "summary",
    options,
    async (item) => {
      const answer = await provider.complete(
        {
          system: summaryPrompt.system,
          user: articleInput(item.title, item.searchText),
          maxOutputTokens: 300,
        },
        options.signal,
      );
      const text = parseSummary(answer);
      // A model that answered "this cannot be summarised" is recorded as
      // having answered: writing the null keeps the article out of the next
      // pass, where it would produce the same answer at the same cost.
      await writeEnrichment(sql, {
        itemId: item.id,
        kind: "summary",
        content: { text },
        chatModel: provider.model,
        promptVersion: summaryPrompt.version,
        createdAt: now,
      });
      return text !== null;
    },
    summaryPrompt.version,
  );

  let translated = { done: 0, failed: 0 };
  if (config.ENRICH_TRANSLATE_TO) {
    const prompt = translationPrompt(config.ENRICH_TRANSLATE_TO);
    translated = await runKind(
      "translation",
      options,
      async (item) => {
        const answer = await provider.complete(
          {
            system: prompt.system,
            user: articleInput(item.title, item.searchText),
            json: true,
            maxOutputTokens: 500,
          },
          options.signal,
        );
        const parsed = parseTranslation(answer);
        await writeEnrichment(sql, {
          itemId: item.id,
          kind: "translation",
          content: parsed
            ? { ...parsed, language: config.ENRICH_TRANSLATE_TO }
            : { title: null, text: null, language: config.ENRICH_TRANSLATE_TO },
          chatModel: provider.model,
          promptVersion: prompt.version,
          createdAt: now,
        });
        return parsed !== null;
      },
      prompt.version,
    );
  }

  const vocabulary = await approvedTags(sql);
  const tagPrompt = tagsPrompt(vocabulary);
  const tagged = await runKind(
    "tags",
    options,
    async (item) => {
      const answer = await provider.complete(
        {
          system: tagPrompt.system,
          user: articleInput(item.title, item.searchText),
          json: true,
          maxOutputTokens: 200,
        },
        options.signal,
      );
      const parsed = parseTags(answer, vocabulary);
      if (!parsed) return false;

      await setItemTags(sql, item.id, parsed.tags);
      // Candidates accumulate for a human to approve. This is the only path by
      // which the vocabulary grows, which is what stops tags diverging until
      // they are useless for filtering.
      await recordCandidates(sql, parsed.candidates);
      await writeEnrichment(sql, {
        itemId: item.id,
        kind: "tags",
        content: parsed,
        chatModel: provider.model,
        promptVersion: tagPrompt.version,
        createdAt: now,
      });
      return true;
    },
    tagPrompt.version,
  );

  const failed = summary.failed + translated.failed + tagged.failed;
  const touched = summary.done + translated.done + tagged.done;

  return {
    summarised: summary.done,
    translated: translated.done,
    tagged: tagged.done,
    failed,
    idle: touched === 0 && failed === 0,
  };
}

const IDLE_INTERVAL_MS = 900_000;
const BUSY_INTERVAL_MS = 1_000;

export type EnrichWorker = {
  stop: () => void;
  done: Promise<void>;
};

/**
 * Run enrichment continuously while a chat model is configured.
 *
 * Long idle interval by design: unlike the embedding backfill, every pass here
 * costs real money or real GPU time, and there is no correctness argument for
 * catching up quickly. An article enriched an hour late is an article that was
 * readable the whole time.
 */
export function startEnrichWorker(options: EnrichWorkerOptions): EnrichWorker {
  let stopping = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish;
    });

  const done = (async () => {
    while (!stopping) {
      let idle = true;
      try {
        const result = await runEnrichPass(options);
        idle = result.idle;
        if (!idle) {
          console.error(
            `enriched: ${result.summarised} summaries, ${result.translated} translations, ` +
              `${result.tagged} tagged, ${result.failed} failed`,
          );
        }
      } catch (error) {
        // The model being unreachable must not kill the loop; the reader keeps
        // working and enrichment resumes when it comes back.
        console.error("enrichment pass failed:", error);
      }
      if (stopping) break;
      await sleep(idle ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS);
    }
  })();

  return {
    stop: () => {
      stopping = true;
      wake?.();
    },
    done,
  };
}
