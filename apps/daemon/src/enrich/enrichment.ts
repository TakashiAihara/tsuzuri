import {
  BODY_TRANSLATION_PROMPT_VERSION,
  bodyTranslationPrompt,
  bodyTranslationReplySchema,
  ChatError,
  type ChatProvider,
  type ChatProviderId,
  type ChatRequest,
  completeJson,
  PromptParseError,
  SUMMARY_PROMPT_VERSION,
  summaryPrompt,
  summaryReplySchema,
  TAGS_PROMPT_VERSION,
  TRANSLATION_PROMPT_VERSION,
  tagsPrompt,
  tagsReplySchema,
  translationPrompt,
  translationReplySchema,
} from "@tsuzuri/core";
import {
  approvedTagIds,
  approvedTags,
  attachTags,
  clearEnrichmentFailure,
  currentEnrichments,
  DEFAULT_USER_ID,
  type EnrichmentInput,
  type EnrichmentKind,
  enrichedItemsSince,
  enrichmentCandidates,
  enrichmentCounts,
  enrichmentInputs,
  pruneEnrichments,
  recordEnrichmentFailure,
  scoreItems,
  setTagStatus,
  suggestTag,
  type TagRow,
  type TagStatus,
  tagsForReview,
  type WantedEnrichment,
  writeEnrichment,
} from "@tsuzuri/db";
import PQueue from "p-queue";
import type postgres from "postgres";

import type { Config } from "../config.ts";
import type { InterestService } from "./interest.ts";

/**
 * The pass: what a chat model is asked about an article, and what it says.
 *
 * An enrichment like the others -- it never writes to items, so nothing here
 * can stop an article being stored -- and off unless CHAT_PROVIDER names one.
 * Disabled is the absence of a provider rather than a null one that answers
 * with an empty summary, for the reason createEmbeddingProvider gives: a null
 * object would let callers write rows that look like enrichments and are not.
 */

/**
 * Characters of an article sent per call.
 *
 * No variable governs this: the configuration table bounds the answer
 * (CHAT_MAX_OUTPUT_TOKENS) and not the question. The value matches
 * EMBEDDING_MAX_INPUT_CHARS, which bounds the same field for the same reason.
 */
const MAX_INPUT_CHARS = 8_000;

/**
 * Candidates ranked per pass, over the ENRICH_TOP_N actually spent on.
 *
 * Ranking after selecting, rather than selecting after ranking: the top of the
 * ranked list over the whole window is made of items this pass has already paid
 * for, which would leave everything behind them unenriched until those aged
 * out. Looking further ahead than it spends is what makes the choice the ranked
 * one rather than the newest one.
 */
const RANK_LOOKAHEAD = 5;

/** Gap between passes once enrichment has caught up. */
const IDLE_INTERVAL_MS = 30_000;
/** Gap between passes while there is still work, purely to yield. */
const BUSY_INTERVAL_MS = 250;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * A request refused because the instance is not configured for it.
 *
 * The same split InterestPreconditionError makes, so the endpoint answers 400
 * for "you have not turned this on" and 5xx for a database that fell over.
 */
export class EnrichmentPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichmentPreconditionError";
  }
}

/** The prompt versions this build records, and what `enrich prune` keeps. */
export type PromptVersions = {
  summary: string;
  tags: string;
  translation: string;
  bodyTranslation: string;
};

export type EnrichmentStatus = {
  enabled: boolean;
  provider: ChatProviderId | null;
  model: string | null;
  promptVersions: PromptVersions;
  counts: {
    summarised: number;
    tagged: number;
    translated: number;
    failed: number;
  };
};

export type EnrichmentRun = {
  /** Items this run asked a model about. */
  items: number;
  summarised: number;
  tagged: number;
  translated: number;
  failed: number;
  /**
   * True when the hourly spend bound stopped the run with candidates waiting.
   *
   * Reported rather than left implicit, because a run that quietly did half of
   * what was asked looks exactly like a run that had nothing more to do.
   */
  bounded: boolean;
};

export type PassResult = EnrichmentRun & { idle: boolean };

export type BodyTranslation = {
  itemId: string;
  lang: string;
  text: string;
  /** True when the stored answer was returned without a call. */
  cached: boolean;
};

export type EnrichmentService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => Promise<EnrichmentStatus>;
  /** One pass over what is waiting. Exported for tests and for an on-demand run. */
  runPass: () => Promise<PassResult>;
  /** Re-run over history, as `tsuzuri enrich --since` asks for. */
  runOver: (options: {
    since: Date;
    kind: EnrichmentKind | null;
    force: boolean;
  }) => Promise<EnrichmentRun>;
  /** Delete every combination that is not kept. Naming nothing keeps nothing. */
  prune: (options: { keepCurrent: boolean }) => Promise<number>;
  /** One body, translated on request. */
  translateBody: (itemId: string) => Promise<BodyTranslation>;
  tagsForReview: () => Promise<TagRow[]>;
  setTagStatus: (slug: string, status: TagStatus) => Promise<boolean>;
  /** The current model summary per item, for the summaries a response carries. */
  currentSummaries: (itemIds: readonly string[]) => Promise<Map<string, string>>;
};

const PROMPT_VERSIONS: PromptVersions = {
  summary: SUMMARY_PROMPT_VERSION,
  tags: TAGS_PROMPT_VERSION,
  translation: TRANSLATION_PROMPT_VERSION,
  bodyTranslation: BODY_TRANSLATION_PROMPT_VERSION,
};

const NO_PROVIDER = "no chat model is configured; set CHAT_PROVIDER first";

/** The variable each kind is switched by, named for the message that refuses it. */
const SWITCH_FOR: Record<EnrichmentKind, string> = {
  summary: "ENRICH_SUMMARY",
  tags: "ENRICH_TAGS",
  translation: "ENRICH_TRANSLATE_TO",
};

/**
 * Normalise a suggested tag into a slug.
 *
 * Only case and spacing are touched. Stripping everything outside ASCII would
 * throw away every Japanese topic a model suggests, and a vocabulary that
 * cannot name what you read is not a vocabulary.
 */
function toTagSlug(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : null;
}

export function createEnrichmentService(deps: {
  sql: postgres.Sql;
  config: Config;
  /**
   * Interest ranking, consulted rather than used.
   *
   * Only to know whether a ranked order exists at all. The ranking query is
   * called directly rather than through InterestService.rank, because that one
   * serves reading: it filters to unread and reserves exploration slots, and
   * spending a model call on a slot chosen to broaden reading is not what
   * either feature means.
   */
  interest: InterestService;
  /** null when no chat model is configured, which is the disabled case. */
  provider: ChatProvider | null;
}): EnrichmentService {
  const { sql, config, interest, provider } = deps;
  const userId = DEFAULT_USER_ID;

  let stopping = false;
  let wake: (() => void) | null = null;
  let loop: Promise<void> | null = null;
  /** Single-flight: two passes would spend the hourly bound twice over. */
  let running: Promise<PassResult> | null = null;

  /** The target language, or "" when translation is switched off. */
  const targetLanguage = (): string => config.ENRICH_TRANSLATE_TO?.trim() ?? "";

  /**
   * What a run will ask for.
   *
   * Narrowed by `kind` rather than widened by it: ENRICH_SUMMARY=false means
   * this installation does not summarise, so asking for summaries explicitly
   * finds nothing to do rather than overriding a switch somebody set.
   */
  function wantedKinds(kind: EnrichmentKind | null): WantedEnrichment[] {
    const lang = targetLanguage();
    const wanted: WantedEnrichment[] = [];
    if (config.ENRICH_SUMMARY && kind !== "tags" && kind !== "translation") {
      wanted.push({ kind: "summary", promptVersion: PROMPT_VERSIONS.summary });
    }
    if (config.ENRICH_TAGS && kind !== "summary" && kind !== "translation") {
      wanted.push({ kind: "tags", promptVersion: PROMPT_VERSIONS.tags });
    }
    if (lang.length > 0 && kind !== "summary" && kind !== "tags") {
      wanted.push({ kind: "translation", lang, promptVersion: PROMPT_VERSIONS.translation });
    }
    return wanted;
  }

  function request(system: string, user: string): ChatRequest {
    return { system, user, maxOutputTokens: config.CHAT_MAX_OUTPUT_TOKENS };
  }

  /**
   * Record one failure, or refuse to.
   *
   * Only a permanent, provider-side rejection is evidence about the article.
   * Everything else describes the run -- a retryable outage, a shutdown, a
   * database error -- and charging it to the item would park it behind a backoff
   * it did nothing to earn, on the rule the embedding backfill already follows.
   * A second parse failure is the model twice refusing to answer the question
   * asked, which is about the pair of them rather than about the endpoint.
   */
  async function fail(itemId: string, kind: EnrichmentKind, error: unknown): Promise<void> {
    if (error instanceof ChatError && error.retryable) throw error;
    if (!(error instanceof ChatError) && !(error instanceof PromptParseError)) throw error;
    await recordEnrichmentFailure(sql, itemId, kind, error.message);
  }

  async function summarise(chat: ChatProvider, item: EnrichmentInput): Promise<void> {
    const reply = await completeJson(
      chat,
      request(summaryPrompt.system, articleText(item)),
      summaryReplySchema,
    );
    await writeEnrichment(sql, {
      itemId: item.id,
      kind: "summary",
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.summary,
      content: { summary: reply.summary },
    });
    await clearEnrichmentFailure(sql, item.id, "summary");
  }

  /**
   * Classify against the approved vocabulary, and record what else it saw.
   *
   * The approved tags are attached and everything else is only suggested: a tag
   * the model invented would be a filter over one article rather than a word
   * anybody chose. Only approved tags reach item_tags, and attachTags checks
   * that again in SQL, because the vocabulary can change between the prompt and
   * the write.
   */
  async function tag(chat: ChatProvider, item: EnrichmentInput): Promise<void> {
    const vocabulary = await approvedTags(sql);
    const reply = await completeJson(
      chat,
      request(tagsPrompt(vocabulary).system, articleText(item)),
      tagsReplySchema,
    );

    const approved = new Set(vocabulary);
    const chosen = reply.tags.map(toTagSlug).filter((slug) => slug !== null);
    // A named tag the vocabulary does not hold is a suggestion whether the
    // model put it under `tags` or under `candidates`. Discarding it would
    // throw away the one piece of evidence that it thought the topic worth
    // having a word for; attaching it would widen the vocabulary by asking
    // twice. Only somebody approving it makes it a tag.
    const suggested = [...chosen, ...reply.candidates.map(toTagSlug)]
      .filter((slug) => slug !== null)
      .filter((slug) => !approved.has(slug));

    const ids = await approvedTagIds(sql, chosen);
    await attachTags(sql, item.id, ids, "model");
    for (const slug of new Set(suggested)) {
      // The label is the slug: a suggestion is a name with nothing behind it
      // yet, and inventing a second display label would be another thing to
      // keep true of a row nobody has approved.
      await suggestTag(sql, slug, slug);
    }

    await writeEnrichment(sql, {
      itemId: item.id,
      kind: "tags",
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.tags,
      content: {
        tags: chosen.filter((slug) => approved.has(slug)),
        candidates: [...new Set(suggested)],
      },
    });
    await clearEnrichmentFailure(sql, item.id, "tags");
  }

  /**
   * Translate the title and the summary, never the body (D30).
   *
   * The summary translated is the one a response would show: this pass's own
   * when it wrote one, the feed's otherwise. A body translation here would be
   * a large call on an article nobody has decided to read, which is what
   * `tsuzuri translate <id>` is for.
   */
  async function translate(chat: ChatProvider, item: EnrichmentInput, lang: string): Promise<void> {
    const source = await summaryWritten(chat, item.id);
    const reply = await completeJson(
      chat,
      request(
        translationPrompt(lang).system,
        `Title: ${item.title ?? ""}\n\nSummary: ${source ?? item.summary ?? ""}`.slice(
          0,
          MAX_INPUT_CHARS,
        ),
      ),
      translationReplySchema,
    );
    await writeEnrichment(sql, {
      itemId: item.id,
      kind: "translation",
      lang,
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.translation,
      content: { title: reply.title, text: reply.text },
    });
    await clearEnrichmentFailure(sql, item.id, "translation");
  }

  /** What this item's current summary says, for the translation to carry. */
  async function summaryWritten(chat: ChatProvider, itemId: string): Promise<string | null> {
    const [row] = await currentEnrichments(sql, [itemId], {
      kind: "summary",
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.summary,
    });
    const parsed = summaryReplySchema.safeParse(row?.content);
    return parsed.success ? parsed.data.summary : null;
  }

  async function enrichOne(
    chat: ChatProvider,
    item: EnrichmentInput,
    wanted: readonly WantedEnrichment[],
    force: boolean,
  ): Promise<EnrichmentRun> {
    const run = emptyRun();
    run.items = 1;

    for (const want of wanted) {
      const lang = want.lang ?? "";
      // Asked of the store rather than assumed from selection: selection only
      // promises the item lacks one of the wanted combinations, and writing the
      // others again would spend a call to overwrite an answer already there.
      const stored = force
        ? []
        : await currentEnrichments(sql, [item.id], {
            kind: want.kind,
            lang,
            model: chat.model,
            promptVersion: want.promptVersion,
          });
      if (stored.length > 0) continue;

      try {
        if (want.kind === "summary") {
          await summarise(chat, item);
          run.summarised += 1;
        } else if (want.kind === "tags") {
          await tag(chat, item);
          run.tagged += 1;
        } else if ((want.lang ?? "").length > 0) {
          await translate(chat, item, want.lang as string);
          run.translated += 1;
        }
      } catch (error) {
        await fail(item.id, want.kind, error);
        run.failed += 1;
      }
    }

    return run;
  }

  /** The title and body as one block of text, within the input bound. */
  function articleText(input: EnrichmentInput): string {
    const body = input.searchText.slice(0, MAX_INPUT_CHARS);
    return input.title ? `${input.title}\n\n${body}` : body;
  }

  /**
   * What is left of the hourly spend bound.
   *
   * Counted from the rows rather than from memory, so a restart does not hand
   * the pass a fresh allowance on the hour.
   */
  async function remainingBudget(now: Date): Promise<number> {
    const spent = await enrichedItemsSince(sql, new Date(now.getTime() - MS_PER_HOUR));
    return Math.max(0, config.ENRICH_MAX_ITEMS_PER_HOUR - spent);
  }

  function emptyRun(bounded = false): EnrichmentRun {
    return { items: 0, summarised: 0, tagged: 0, translated: 0, failed: 0, bounded };
  }

  function add(total: EnrichmentRun, part: EnrichmentRun): void {
    total.items += part.items;
    total.summarised += part.summarised;
    total.tagged += part.tagged;
    total.translated += part.translated;
    total.failed += part.failed;
  }

  /**
   * Spend on the chosen items, ENRICH_CONCURRENCY at a time.
   *
   * A retryable failure propagates rather than being counted against the
   * articles: it describes the endpoint, and the items stay candidates for the
   * next pass. Everything already written stays written.
   */
  async function spend(
    chat: ChatProvider,
    items: EnrichmentInput[],
    wanted: readonly WantedEnrichment[],
    force: boolean,
  ): Promise<EnrichmentRun> {
    const total = emptyRun();
    if (items.length === 0) return total;

    const queue = new PQueue({ concurrency: config.ENRICH_CONCURRENCY });
    const results = await Promise.allSettled(
      items.map((item) => queue.add(() => enrichOne(chat, item, wanted, force))),
    );
    for (const result of results) {
      if (result.status === "fulfilled") add(total, result.value);
    }

    const thrown = results.find((result) => result.status === "rejected");
    if (thrown?.status === "rejected") throw thrown.reason;
    return total;
  }

  /** The candidate ids of one pass: the starred arm, then the ranked top N. */
  async function choosePass(now: Date, budget: number): Promise<string[]> {
    const wanted = wantedKinds(null);
    const chat = provider as ChatProvider;
    const common = {
      userId,
      model: chat.model,
      wanted,
      collapse: config.CLUSTERING_ENABLED,
      now,
    };

    const ranked = await enrichmentCandidates(sql, {
      ...common,
      windowHours: config.ENRICH_WINDOW_HOURS,
      limit: config.ENRICH_TOP_N * RANK_LOOKAHEAD,
    });
    // Starred items are added whatever their rank, so the top of the ranked
    // list is not what decides whether they are enriched at all.
    const starred = await enrichmentCandidates(sql, {
      ...common,
      starredOnly: true,
      limit: Math.max(budget, 1),
    });
    if (ranked.candidates.length === 0 && starred.candidates.length === 0) return [];

    const starredIds = starred.candidates.map((candidate) => candidate.id);
    const starredSet = new Set(starredIds);
    let ordered = ranked.candidates.map((candidate) => candidate.id);

    if (ordered.length > 0 && (await interest.status()).active) {
      const scored = await scoreItems(sql, {
        userId,
        limit: ordered.length,
        unreadOnly: false,
        sourceId: null,
        recencyHalfLifeHours: config.INTEREST_RECENCY_HALFLIFE_HOURS,
        estimatedFactor: config.INTEREST_ESTIMATED_DATE_FACTOR,
        windowDays: config.INTEREST_WINDOW_DAYS,
        collapse: config.CLUSTERING_ENABLED,
        ids: ordered,
      });
      // Anything the ranking could not score -- an item with no vector yet --
      // keeps the order selection gave it rather than being dropped: it was
      // chosen, and writing a summary needs no vector.
      const scoredIds = new Set(scored.map((row) => row.id));
      ordered = [...scored.map((row) => row.id), ...ordered.filter((id) => !scoredIds.has(id))];
    }

    const top = ordered.slice(0, config.ENRICH_TOP_N).filter((id) => !starredSet.has(id));
    return [...starredIds, ...top];
  }

  async function pass(): Promise<PassResult> {
    const now = new Date();
    const wanted = wantedKinds(null);
    if (!provider || wanted.length === 0) return { ...emptyRun(), idle: true };

    const budget = await remainingBudget(now);
    const chosen = await choosePass(now, budget);
    if (chosen.length === 0) return { ...emptyRun(), idle: true };

    const bounded = chosen.length > budget;
    const inputs = await enrichmentInputs(sql, chosen.slice(0, budget));
    const total = await spend(provider, inputs, wanted, false);
    // Idle means nothing was spent, not that nothing was waiting. A pass the
    // hourly bound empties would otherwise ask again every quarter of a second
    // until the hour turned over.
    return { ...total, bounded, idle: inputs.length === 0 };
  }

  function runOnce(): Promise<PassResult> {
    if (running) return running;
    const started = pass().finally(() => {
      if (running === started) running = null;
    });
    running = started;
    return started;
  }

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

  return {
    async start() {
      if (!provider) return;
      loop = (async () => {
        while (!stopping) {
          let idle = true;
          try {
            idle = (await runOnce()).idle;
          } catch (error) {
            // A failed pass must not kill the loop. Whatever it did not reach is
            // still waiting, and the reader keeps working meanwhile.
            console.error("enrichment pass failed:", error);
          }
          if (stopping) break;
          await sleep(idle ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS);
        }
      })();
    },

    async stop() {
      stopping = true;
      wake?.();
      await running?.catch(() => {});
      await loop;
    },

    async status() {
      if (!provider) {
        return {
          enabled: false,
          provider: null,
          model: null,
          promptVersions: PROMPT_VERSIONS,
          counts: { summarised: 0, tagged: 0, translated: 0, failed: 0 },
        };
      }
      return {
        enabled: true,
        provider: provider.id,
        model: provider.model,
        promptVersions: PROMPT_VERSIONS,
        counts: await enrichmentCounts(sql, {
          model: provider.model,
          promptVersions: Object.values(PROMPT_VERSIONS),
        }),
      };
    },

    runPass: runOnce,

    /**
     * Re-run over history.
     *
     * Newest first rather than by interest: what is being asked for here is a
     * prompt replayed against articles the reader has already been shown, and
     * the same hourly bound applies -- otherwise `--since 30d` would be the way
     * around it.
     */
    async runOver({ since, kind, force }) {
      if (!provider) throw new EnrichmentPreconditionError(NO_PROVIDER);

      const now = new Date();
      const wanted = wantedKinds(kind);
      if (wanted.length === 0) {
        // Said rather than answered with an empty run: "nothing was enabled"
        // and "nothing matched" look identical from the outside.
        throw new EnrichmentPreconditionError(
          kind === null
            ? "nothing is enabled to run; set ENRICH_SUMMARY, ENRICH_TAGS or ENRICH_TRANSLATE_TO"
            : `${kind} is switched off; set ${SWITCH_FOR[kind]} first`,
        );
      }

      const budget = await remainingBudget(now);
      const selection = await enrichmentCandidates(sql, {
        userId,
        model: provider.model,
        wanted,
        since,
        force,
        collapse: config.CLUSTERING_ENABLED,
        limit: Math.max(budget, 1),
        now,
      });

      const ids = selection.candidates.map((candidate) => candidate.id);
      const inputs = await enrichmentInputs(sql, ids.slice(0, budget));
      const total = await spend(provider, inputs, wanted, force);
      return { ...total, bounded: ids.length > budget };
    },

    async prune({ keepCurrent }) {
      const chat = provider;
      if (keepCurrent && !chat) {
        throw new EnrichmentPreconditionError(
          "there is no current combination to keep: set CHAT_PROVIDER, or prune without --keep-current",
        );
      }
      const keep =
        chat && keepCurrent
          ? Object.values(PROMPT_VERSIONS).map((promptVersion) => ({
              model: chat.model,
              promptVersion,
            }))
          : [];
      return pruneEnrichments(sql, keep);
    },

    /**
     * One body, translated on request.
     *
     * Stored under its own prompt version, so answering this never overwrites
     * the title and summary the pass wrote for the same article and language.
     * A failure is reported to the caller rather than recorded: one deliberate
     * request deserves its error in the answer, not a retry schedule nobody
     * asked to be on.
     */
    async translateBody(itemId) {
      const chat = provider;
      if (!chat) throw new EnrichmentPreconditionError(NO_PROVIDER);

      const lang = targetLanguage();
      if (lang.length === 0) {
        throw new EnrichmentPreconditionError("no target language is set; set ENRICH_TRANSLATE_TO");
      }

      const stored = await currentEnrichments(sql, [itemId], {
        kind: "translation",
        lang,
        model: chat.model,
        promptVersion: PROMPT_VERSIONS.bodyTranslation,
      });
      const answered = bodyTranslationReplySchema.safeParse(stored[0]?.content);
      if (answered.success) return { itemId, lang, text: answered.data.text, cached: true };

      const [item] = await enrichmentInputs(sql, [itemId]);
      if (!item) throw new EnrichmentPreconditionError(`no item with id ${itemId}`);

      const reply = await completeJson(
        chat,
        request(bodyTranslationPrompt(lang).system, item.searchText.slice(0, MAX_INPUT_CHARS)),
        bodyTranslationReplySchema,
      );
      await writeEnrichment(sql, {
        itemId,
        kind: "translation",
        lang,
        model: chat.model,
        promptVersion: PROMPT_VERSIONS.bodyTranslation,
        content: { text: reply.text },
      });
      return { itemId, lang, text: reply.text, cached: false };
    },

    tagsForReview() {
      return tagsForReview(sql, config.TAG_CANDIDATE_PROMOTION_THRESHOLD);
    },

    setTagStatus(slug, status) {
      return setTagStatus(sql, slug, status);
    },

    /**
     * The summary a response should carry for each item.
     *
     * Empty when no chat model is configured, because then no row is current: the
     * response falls back to whatever the feed supplied, which is what an
     * install with no model configured has.
     */
    async currentSummaries(itemIds) {
      const summaries = new Map<string, string>();
      if (!provider || itemIds.length === 0) return summaries;

      const rows = await currentEnrichments(sql, itemIds, {
        kind: "summary",
        model: provider.model,
        promptVersion: PROMPT_VERSIONS.summary,
      });
      for (const row of rows) {
        const parsed = summaryReplySchema.safeParse(row.content);
        if (parsed.success) summaries.set(row.itemId, parsed.data.summary);
      }
      return summaries;
    },
  };
}
