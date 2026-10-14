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
  type EnrichmentTarget,
  enrichmentCallsSince,
  enrichmentCandidates,
  enrichmentCounts,
  enrichmentInputs,
  inBackoff,
  pruneEnrichments,
  recordEnrichmentFailure,
  scoreItems,
  setTagStatus,
  suggestTag,
  type TagRow,
  type TagStatus,
  tagsForReview,
  tagsOfItems,
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
 * Output bound for a whole-article translation, as a multiple of
 * CHAT_MAX_OUTPUT_TOKENS.
 *
 * A summary is two or three sentences and fits the configured bound several
 * times over; a translated body is the article. Answering it under a bound
 * sized for a summary produces a translation that stops mid-paragraph, so this
 * asks for a larger one rather than the operator learning a second variable.
 */
const BODY_OUTPUT_TOKEN_MULTIPLE = 8;

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
  /**
   * The last error a pass refused to record against an item, and when.
   *
   * A configuration error -- a key refused, a model that does not exist, an
   * answer that ran out of tokens -- is true of every item equally, so nothing
   * in the store records it and the pass looks like it had nothing to do. It
   * is the one thing that explains why an install with a working chat model
   * suddenly stops summarising, so it is reported here rather than only in the
   * daemon's log.
   */
  lastError: { message: string; at: string } | null;
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
   * what was asked looks exactly like a run that had nothing more to do. It is
   * the hourly bound alone: stopping at ENRICH_TOP_N or at the end of the
   * window is the run having done what it was asked, and saying otherwise
   * would send somebody to raise a limit that was never reached.
   */
  bounded: boolean;
  /**
   * The configuration error that ended this run, or null.
   *
   * Everything written before it is written, so a run that stopped this way
   * answers with what it managed rather than as a failure: a 500 would say
   * nothing was enriched and send the caller back to re-run the whole period.
   */
  error: string | null;
  /**
   * The cutoff a forced rerun measured against, ISO 8601.
   *
   * Passed back on the next call, it is what makes a rerun continue past the
   * articles the previous one wrote instead of re-picking them: a row written
   * from this instant on is an answer, and one written before it is not.
   * Null when the run was not forced, because nothing is being continued.
   */
  forceBefore: string | null;
};

export type PassResult = EnrichmentRun & { idle: boolean };

export type BodyTranslation = {
  itemId: string;
  lang: string;
  text: string;
  /** True when the stored answer was returned without a call. */
  cached: boolean;
};

/** What a chat model has said about one article, as a response carries it. */
export type ItemEnrichment = {
  /**
   * The current model summary, or null when there is none.
   *
   * The feed's own summary is on the item row, which the caller already has:
   * returning it from here as well would make two answers to one question.
   * `summarySource` says which of the two the caller should show.
   */
  summary: string | null;
  /** Which of the two summaries this is, as on a listing (D35). */
  summarySource: "feed" | "model";
  /** Title and summary translated, with the language they are in. */
  translation: { lang: string; title: string; text: string } | null;
  /** Slugs of the tags attached to this article. */
  tags: string[];
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
    /** The instant a forced rerun measures against; the request time by default. */
    forceBefore?: Date | null | undefined;
  }) => Promise<EnrichmentRun>;
  /** Delete every combination that is not current. */
  prune: () => Promise<number>;
  /** One body, translated on request. */
  translateBody: (itemId: string) => Promise<BodyTranslation>;
  tagsForReview: () => Promise<TagRow[]>;
  setTagStatus: (slug: string, status: TagStatus) => Promise<boolean>;
  /** The current model summary per item, for the summaries a response carries. */
  currentSummaries: (itemIds: readonly string[]) => Promise<Map<string, string>>;
  /** The model summary, translation and tags of these items, per id. */
  currentForItems: (itemIds: readonly string[]) => Promise<Map<string, ItemEnrichment>>;
  /** What the model has said about one article, which is an answer even when empty. */
  currentFor: (itemId: string) => Promise<ItemEnrichment>;
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

/** A refusal that is true of every article equally, and so of no article at all. */
function isConfiguration(error: unknown): boolean {
  return error instanceof ChatError && error.kind === "configuration";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * What one run may still spend, in calls.
 *
 * Shared by every item the run spends on and decremented by the provider
 * wrapper, because a call is not knowable in advance of making it: an answer
 * that does not parse costs a second one.
 */
/**
 * What is left of the hour for one run. `reserved` counts calls a worker has
 * claimed but not yet made: the claim is taken synchronously, right after the
 * worker decides to call, so concurrent workers cannot each see the last call
 * as free across the awaits in between.
 */
type Allowance = { left: number; reserved: number };

/** What a response carries about an article no model has touched. */
const UNENRICHED: ItemEnrichment = {
  summary: null,
  summarySource: "feed",
  translation: null,
  tags: [],
};

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
  /**
   * Cancellation for every request this service has in flight.
   *
   * Aborting rather than waiting is what makes a stop prompt: a daemon shutting
   * down would otherwise hold a two-minute request deadline before it exits.
   * Replaced on every start, because an aborted controller refuses every
   * request it is handed and a service that cannot be started again is a
   * service that cannot be restarted.
   */
  let inFlight = new AbortController();
  let lastError: { message: string; at: string } | null = null;

  /**
   * When the model calls of the last hour were made.
   *
   * The spend bound is about calls rather than articles, so this is what counts:
   * one item can be two calls when the first answer does not parse, and a
   * refusal spends one without writing anything an article count could see.
   */
  const callTimes: number[] = [];
  /** What the store already says this hour was spent, read once at startup. */
  let seededCalls: number | null = null;
  let seededAt = 0;
  /** The run currently spending, so a call knows which allowance to take from. */
  let spending: Allowance | null = null;

  /**
   * The provider with every call it makes counted, and its successes seen.
   *
   * Counting here rather than in the workers is what makes the parse retry
   * count: two attempts on one article is two calls, and only the call sees
   * both. Clearing the reported error here is what keeps `doctor` honest --
   * a refusal that has since been answered is not why this installation is not
   * enriching, and a field that only ever moves one way is a field nobody reads.
   */
  const counted: ChatProvider | null = provider && {
    ...provider,
    complete(request, signal) {
      callTimes.push(Date.now());
      // A claimed call is already paid for; anything else -- the retry of an
      // answer that did not parse -- is paid here.
      if (spending) {
        if (spending.reserved > 0) spending.reserved -= 1;
        else spending.left -= 1;
      }
      return provider.complete(request, signal).then((answer) => {
        lastError = null;
        return answer;
      });
    },
  };

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
    const wants = (name: EnrichmentKind): boolean => kind === null || kind === name;
    const wanted: WantedEnrichment[] = [];
    if (config.ENRICH_SUMMARY && wants("summary")) {
      wanted.push({ kind: "summary", promptVersion: PROMPT_VERSIONS.summary });
    }
    if (config.ENRICH_TAGS && wants("tags")) {
      wanted.push({ kind: "tags", promptVersion: PROMPT_VERSIONS.tags });
    }
    if (lang.length > 0 && wants("translation")) {
      wanted.push({ kind: "translation", lang, promptVersion: PROMPT_VERSIONS.translation });
    }
    return wanted;
  }

  function request(system: string, user: string, maxOutputTokens?: number): ChatRequest {
    return {
      system,
      user,
      maxOutputTokens: maxOutputTokens ?? config.CHAT_MAX_OUTPUT_TOKENS,
    };
  }

  /**
   * Record one failure, or refuse to.
   *
   * Only a permanent, provider-side rejection is evidence about the article.
   * Everything else describes the run -- a retryable outage, a configuration
   * mistake, a shutdown, a database error -- and charging it to the item would
   * park it behind a backoff it did nothing to earn, on the rule the embedding
   * backfill already follows. A second parse failure is the model twice
   * refusing to answer the question asked, which is about the pair of them
   * rather than about the endpoint.
   *
   * A configuration error is kept for `status()` to report, because it is the
   * one failure with nothing in the store to show it: every item fails it
   * identically, so there is no item to record it against.
   */
  async function fail(itemId: string, target: EnrichmentTarget, error: unknown): Promise<void> {
    if (error instanceof ChatError) {
      if (error.kind === "configuration") {
        lastError = { message: error.message, at: new Date().toISOString() };
      }
      if (error.kind !== "permanent") throw error;
    }
    if (!(error instanceof ChatError) && !(error instanceof PromptParseError)) throw error;
    await recordEnrichmentFailure(sql, itemId, target, error.message);
  }

  async function summarise(chat: ChatProvider, item: EnrichmentInput): Promise<void> {
    const reply = await completeJson(
      chat,
      request(summaryPrompt.system, articleText(item)),
      summaryReplySchema,
      inFlight.signal,
    );
    await writeEnrichment(sql, {
      itemId: item.id,
      kind: "summary",
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.summary,
      content: { summary: reply.summary },
    });
    await clearEnrichmentFailure(sql, item.id, {
      kind: "summary",
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.summary,
    });
  }

  /**
   * Classify against the approved vocabulary, and record what else it saw.
   *
   * The approved tags are attached and everything else is only suggested: a tag
   * the model invented would be a filter over one article rather than a word
   * anybody chose. Only approved tags reach item_tags, and attachTags checks
   * that again in SQL, because the vocabulary can change between the prompt and
   * the write.
   *
   * The row is written before the suggestions are counted, because the count is
   * read back out of it: an observation is one article that named this tag, and
   * this is the article that just did.
   */
  async function tag(chat: ChatProvider, item: EnrichmentInput): Promise<void> {
    const vocabulary = await approvedTags(sql);
    const reply = await completeJson(
      chat,
      request(tagsPrompt(vocabulary).system, articleText(item)),
      tagsReplySchema,
      inFlight.signal,
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

    const ids = await approvedTagIds(sql, chosen);
    await attachTags(sql, item.id, ids, "model");
    for (const slug of new Set(suggested)) {
      // The label is the slug: a suggestion is a name with nothing behind it
      // yet, and inventing a second display label would be another thing to
      // keep true of a row nobody has approved.
      await suggestTag(sql, slug, slug, chat.model, PROMPT_VERSIONS.tags);
    }

    await clearEnrichmentFailure(sql, item.id, {
      kind: "tags",
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.tags,
    });
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
      inFlight.signal,
    );
    await writeEnrichment(sql, {
      itemId: item.id,
      kind: "translation",
      lang,
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.translation,
      content: { title: reply.title, text: reply.text },
    });
    await clearEnrichmentFailure(sql, item.id, {
      kind: "translation",
      lang,
      model: chat.model,
      promptVersion: PROMPT_VERSIONS.translation,
    });
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
    cutoff: Date | null,
    allowance: Allowance,
  ): Promise<EnrichmentRun> {
    const run = emptyRun();
    if (stopping) return run;

    // Selection only promises the item lacks one of the wanted combinations,
    // so the others it does want may still be inside a backoff from a previous
    // pass. Asking the store per kind is what stops a summary that failed
    // yesterday being paid for again today, on an item chosen for its tags.
    let asked = false;

    for (const want of wanted) {
      if (stopping) break;
      // Between kinds rather than once per item: one article can be several
      // calls -- one for each kind, plus a retry of an answer that did not
      // parse -- and the hour is a budget of calls.
      const lang = want.lang ?? "";
      const target: EnrichmentTarget = {
        kind: want.kind,
        lang,
        model: chat.model,
        promptVersion: want.promptVersion,
      };
      if (cutoff === null && (await inBackoff(sql, item.id, target))) continue;
      // Asked of the store rather than assumed from selection: writing a kind
      // the item already has would spend a call to overwrite an answer. Under
      // force the same cutoff as selection decides, so a kind this rerun (or
      // the one it continues) already wrote is not asked again.
      const stored = await currentEnrichments(sql, [item.id], {
        kind: want.kind,
        lang,
        model: chat.model,
        promptVersion: want.promptVersion,
      });
      const answered =
        cutoff === null
          ? stored.length > 0
          : stored.some((row) => new Date(row.createdAt) >= cutoff);
      if (answered) continue;

      // After the store has answered and with no await before the claim, so a
      // kind that needs no call does not count against the hour and two
      // workers cannot both take the last call. Only a parse retry can still
      // run past the bound.
      if (allowance.left <= 0) {
        // Kinds of this item were left unpaid, so the run is bounded even
        // when every item was reached.
        run.bounded = true;
        break;
      }
      allowance.left -= 1;
      allowance.reserved += 1;

      asked = true;
      try {
        if (want.kind === "summary") {
          await summarise(chat, item);
          run.summarised += 1;
        } else if (want.kind === "tags") {
          await tag(chat, item);
          run.tagged += 1;
        } else {
          await translate(chat, item, lang);
          run.translated += 1;
        }
      } catch (error) {
        // An aborted call is a shutdown, not an answer: charging it to the item
        // would park every article behind a backoff for the daemon going down.
        if (stopping) break;
        await fail(item.id, target, error);
        run.failed += 1;
      }
    }

    // Counted after the kinds rather than before them: an item the hour ran out
    // on is not one this run asked a model about, and counting it would make a
    // pass that could not afford its work look like a pass that did it.
    run.items = asked ? 1 : 0;
    return run;
  }

  /** The title and body as one block of text, within the input bound. */
  function articleText(input: EnrichmentInput): string {
    const body = input.searchText.slice(0, MAX_INPUT_CHARS);
    return input.title ? `${input.title}\n\n${body}` : body;
  }

  /**
   * What is left of the hour's allowance.
   *
   * Counted over calls rather than over the articles they were made about, and
   * over this service's own count rather than the store's alone: a restart must
   * not hand the pass a fresh hour, but neither must the store's rows be the
   * only evidence -- a call that wrote nothing is a call that was made.
   */
  async function callsLeft(now: Date): Promise<number> {
    const hourAgo = now.getTime() - MS_PER_HOUR;
    if (seededCalls === null) {
      seededCalls = await enrichmentCallsSince(sql, new Date(hourAgo));
      seededAt = Date.now();
    }

    while (callTimes.length > 0 && (callTimes[0] as number) < hourAgo) callTimes.shift();
    // The seed stands in for calls made before this process started, so it is
    // dropped an hour after it was taken rather than living forever.
    const seed = seededAt >= hourAgo ? seededCalls : 0;
    return Math.max(0, config.ENRICH_MAX_ITEMS_PER_HOUR - seed - callTimes.length);
  }

  /**
   * Whether the hour, rather than the work, ended a run: the allowance is spent
   * and something it was asked to do is left -- an item not reached, or kinds
   * of a reached item left unpaid. One rule for the pass and the rerun, because
   * a rerun that says it finished while the hour cut it short is never resumed.
   */
  function hourRanOut(total: EnrichmentRun, allowance: Allowance, waiting: number): boolean {
    if (allowance.left > 0) return false;
    return total.bounded || waiting > total.items;
  }

  /**
   * The inputs in the order selection chose them. The store answers by id, and
   * the order is the ranking: under the hourly bound the first items are the
   * ones paid for.
   */
  function inOrder(ids: readonly string[], inputs: readonly EnrichmentInput[]): EnrichmentInput[] {
    const byId = new Map(inputs.map((input) => [input.id, input]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  function emptyRun(): EnrichmentRun {
    return {
      items: 0,
      summarised: 0,
      tagged: 0,
      translated: 0,
      failed: 0,
      bounded: false,
      error: null,
      forceBefore: null,
    };
  }

  function add(total: EnrichmentRun, part: EnrichmentRun): void {
    total.items += part.items;
    total.summarised += part.summarised;
    total.tagged += part.tagged;
    total.translated += part.translated;
    total.failed += part.failed;
    total.bounded ||= part.bounded;
  }

  /**
   * Spend on the chosen items, ENRICH_CONCURRENCY at a time.
   *
   * A failure that is not about the article ends the spend rather than being
   * counted against one: it describes the endpoint or the configuration, every
   * item queued behind it would meet the same refusal, and the items stay
   * candidates for the next pass. A retryable error propagates for the caller
   * to log -- an outage is worth retrying -- while a configuration error is
   * returned in the counts, because the caller can only do something about it
   * and the work already done stands. Everything written stays written.
   */
  async function spend(
    chat: ChatProvider,
    items: readonly EnrichmentInput[],
    wanted: readonly WantedEnrichment[],
    cutoff: Date | null,
    allowance: Allowance,
  ): Promise<EnrichmentRun> {
    const total = emptyRun();
    if (items.length === 0) return total;

    let refused = false;
    spending = allowance;
    const queue = new PQueue({ concurrency: config.ENRICH_CONCURRENCY });
    const results = await Promise.allSettled(
      items.map((item) =>
        queue.add(async () => {
          // Set by the task that met the refusal, before it settles and so
          // before the queue can start another one.
          if (refused) return emptyRun();
          try {
            return await enrichOne(chat, item, wanted, cutoff, allowance);
          } catch (error) {
            // enrichOne throws only what it did not record against the item --
            // a configuration error, an outage, a timeout -- and every item
            // queued behind it would meet the same, spending the hour on it.
            refused = true;
            throw error;
          }
        }),
      ),
    );
    spending = null;
    for (const result of results) {
      if (result.status === "fulfilled") add(total, result.value);
    }

    const thrown = results.find((result) => result.status === "rejected");
    if (thrown?.status === "rejected" && !isConfiguration(thrown.reason)) throw thrown.reason;
    return {
      ...total,
      error: thrown?.status === "rejected" ? messageOf(thrown.reason) : null,
    };
  }

  /**
   * The candidate ids of one pass, in the order it would spend on them.
   *
   * Every candidate in the window is ranked, not a lookahead prefix of them.
   * The window bounds the pool; the interest score decides the order, and
   * truncating before ranking would hand the decision to publication date for
   * exactly the items the score exists to promote.
   */
  async function choosePass(now: Date, budget: number): Promise<string[]> {
    const wanted = wantedKinds(null);
    const chat = counted as ChatProvider;
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
    });
    // Starred items are added whatever their rank, so the top of the ranked
    // list is not what decides whether they are enriched at all.
    const starred = await enrichmentCandidates(sql, {
      ...common,
      starredOnly: true,
      limit: Math.max(budget, 1),
    });
    if (ranked.candidates.length === 0 && starred.candidates.length === 0) return [];

    const starredIds = starred.candidates;
    const starredSet = new Set(starredIds);
    let ordered = ranked.candidates;

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
    if (!counted || wanted.length === 0) return { ...emptyRun(), idle: true };

    const budget = await callsLeft(now);
    const allowance: Allowance = { left: budget, reserved: 0 };
    const ids = await choosePass(now, budget);
    if (ids.length === 0) return { ...emptyRun(), idle: true };

    const inputs = inOrder(ids.slice(0, budget), await enrichmentInputs(sql, ids.slice(0, budget)));
    const total = await spend(counted, inputs, wanted, null, allowance);
    // The list is already cut to ENRICH_TOP_N and to the window, so what the
    // pass did not reach is what the hour could not pay for.
    // Idle when nothing more can happen until something changes: nothing was
    // affordable, or a configuration error stopped the spend. A pass stopped
    // by a 401 would otherwise ask again every quarter of a second, spending
    // the hour on refusals.
    return {
      ...total,
      bounded: hourRanOut(total, allowance, ids.length),
      idle: inputs.length === 0 || total.error !== null,
    };
  }

  /**
   * Run one thing at a time.
   *
   * Both a pass and an explicit rerun take the slot: the hourly bound is
   * counted from rows both of them write, so two running at once spend against
   * one allowance and overshoot it. A caller that arrives while the slot is
   * taken waits for it and then takes the slot itself, rather than sharing a
   * run it did not ask for -- a rerun over a different period or kind would be
   * answered with the wrong one.
   *
   * Chained rather than guarded by a flag: three callers have to queue in the
   * order they arrived, and a flag with a release step gets that wrong as soon
   * as two are waiting at once.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function exclusive<T extends EnrichmentRun>(work: () => Promise<T>): Promise<T> {
    const started = queue.then(work, work);
    queue = started.catch(() => {});
    return started;
  }

  function runOnce(): Promise<PassResult> {
    return exclusive(pass);
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

  /**
   * Everything a chat model has said about these items.
   *
   * One query per kind rather than one per item: a response over 50 articles
   * would otherwise be 50 round trips, which is the difference between a
   * listing and a page that takes a second.
   *
   * Every id asked about gets an entry. Where no model has written a summary
   * the entry says so (`summarySource: "feed"`, no summary) and the caller
   * shows the article's own, because "the feed's" is an answer rather than an
   * absence.
   */
  async function enrichmentForItems(
    itemIds: readonly string[],
  ): Promise<Map<string, ItemEnrichment>> {
    const found = new Map<string, ItemEnrichment>();
    const lang = targetLanguage();
    if (itemIds.length === 0) return found;

    const ids = [...itemIds];
    for (const id of ids) found.set(id, UNENRICHED);

    const tags = await tagsOfItems(sql, ids);
    for (const [id, slugs] of tags) {
      const entry = found.get(id) as ItemEnrichment;
      found.set(id, { ...entry, tags: slugs });
    }
    if (!counted) return found;

    const filter = {
      model: counted.model,
      promptVersion: PROMPT_VERSIONS.summary,
    };
    for (const row of await currentEnrichments(sql, ids, { ...filter, kind: "summary" })) {
      const parsed = summaryReplySchema.safeParse(row.content);
      const entry = found.get(row.itemId);
      if (!parsed.success || !entry) continue;
      found.set(row.itemId, { ...entry, summary: parsed.data.summary, summarySource: "model" });
    }
    if (lang.length === 0) return found;

    for (const row of await currentEnrichments(sql, ids, {
      ...filter,
      kind: "translation",
      promptVersion: PROMPT_VERSIONS.translation,
      lang,
    })) {
      const parsed = translationReplySchema.safeParse(row.content);
      const entry = found.get(row.itemId);
      if (!parsed.success || !entry) continue;
      found.set(row.itemId, {
        ...entry,
        translation: { lang: row.lang, title: parsed.data.title, text: parsed.data.text },
      });
    }
    return found;
  }

  return {
    async start() {
      if (!counted) return;
      // Both of these per start rather than per process: an aborted controller
      // refuses every request handed to it, and a `stopping` flag left true
      // would make a second start do nothing at all.
      inFlight = new AbortController();
      stopping = false;
      loop = (async () => {
        while (!stopping) {
          let idle = true;
          try {
            const result = await runOnce();
            idle = result.idle;
            // A configuration error is not the daemon's fault and will not fix
            // itself on the next pass, so it is said once here rather than in
            // a stack trace every quarter of a second.
            if (result.error) console.error("enrichment stopped:", result.error);
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
      // Before awaiting the run rather than after: a request already in flight
      // is waiting on the endpoint, and the endpoint is not the thing being
      // shut down.
      inFlight.abort();
      wake?.();
      await queue.catch(() => {});
      await loop;
    },

    async status() {
      if (!counted) {
        return {
          enabled: false,
          provider: null,
          model: null,
          promptVersions: PROMPT_VERSIONS,
          counts: { summarised: 0, tagged: 0, translated: 0, failed: 0 },
          lastError,
        };
      }
      return {
        enabled: true,
        provider: counted.id,
        model: counted.model,
        promptVersions: PROMPT_VERSIONS,
        counts: await enrichmentCounts(sql, {
          model: counted.model,
          promptVersions: Object.values(PROMPT_VERSIONS),
        }),
        lastError,
      };
    },

    runPass: runOnce,

    /**
     * Re-run over history.
     *
     * Newest first rather than by interest: what is being asked for here is a
     * prompt replayed against articles the reader has already been shown.
     *
     * Drawn from the same hour the background pass spends, because the bound is
     * there to cap what an hour of enrichment costs and a rerun is an hour of
     * enrichment like any other; asking twice is not a way to get twice the
     * work. The cutoff the run used comes back in the answer, so a run stopped
     * by the bound can be continued from it rather than repeated.
     */
    async runOver({ since, kind, force, forceBefore }) {
      if (!counted) throw new EnrichmentPreconditionError(NO_PROVIDER);

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

      return exclusive(async () => {
        const now = new Date();
        // The request's own instant unless the caller named one, so that the
        // cutoff in the answer is a value a later call can pass back unchanged.
        const cutoff = force ? (forceBefore ?? now) : null;
        const allowance: Allowance = { left: await callsLeft(now), reserved: 0 };
        const selection = await enrichmentCandidates(sql, {
          userId,
          model: counted.model,
          wanted,
          since,
          force,
          forceBefore: cutoff,
          collapse: config.CLUSTERING_ENABLED,
          limit: Math.max(allowance.left, 1),
          now,
        });

        const ids = selection.candidates;
        const chosen = ids.slice(0, allowance.left);
        const inputs = inOrder(chosen, await enrichmentInputs(sql, chosen));
        const total = await spend(counted, inputs, wanted, cutoff, allowance);
        // From what matched rather than from what was fetched: the fetch is
        // capped by the hour, so a full fetch says nothing about what waits.
        return {
          ...total,
          bounded: hourRanOut(total, allowance, selection.matched),
          forceBefore: cutoff ? cutoff.toISOString() : null,
        };
      });
    },

    /**
     * Delete every combination that is not current.
     *
     * Always keeping the current ones is the point of the command: they are
     * what every response reads, and a prune that could be asked not to keep
     * them is a prune that can delete an install's summaries by accident. The
     * comparison between two prompt versions is what the pruning exists to
     * protect, not to apply.
     */
    async prune() {
      const chat = counted;
      if (!chat) {
        throw new EnrichmentPreconditionError(
          "there is no current combination to keep: set CHAT_PROVIDER first",
        );
      }
      const keep = Object.values(PROMPT_VERSIONS).map((promptVersion) => ({
        model: chat.model,
        promptVersion,
      }));
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
      const chat = counted;
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
      // The same hour as every other call: a body translation is the largest
      // call there is, and one that ignored the bound would make it a bound on
      // everything except the expensive part.
      if ((await callsLeft(new Date())) <= 0) {
        throw new EnrichmentPreconditionError(
          "ENRICH_MAX_ITEMS_PER_HOUR is spent for this hour; try again later",
        );
      }

      const [item] = await enrichmentInputs(sql, [itemId]);
      if (!item) throw new EnrichmentPreconditionError(`no item with id ${itemId}`);
      // Refused rather than cut: a translation that stops at 8,000 characters
      // looks like a translation, and nobody finds out that a third of the
      // article is missing until they have read it in the wrong language.
      if (item.searchText.length > MAX_INPUT_CHARS) {
        throw new EnrichmentPreconditionError(
          `this article is ${item.searchText.length} characters, over the ${MAX_INPUT_CHARS} sent per call`,
        );
      }

      const reply = await completeJson(
        chat,
        request(
          bodyTranslationPrompt(lang).system,
          item.searchText,
          config.CHAT_MAX_OUTPUT_TOKENS * BODY_OUTPUT_TOKEN_MULTIPLE,
        ),
        bodyTranslationReplySchema,
        inFlight.signal,
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
      if (!counted || itemIds.length === 0) return summaries;

      const rows = await currentEnrichments(sql, itemIds, {
        kind: "summary",
        model: counted.model,
        promptVersion: PROMPT_VERSIONS.summary,
      });
      for (const row of rows) {
        const parsed = summaryReplySchema.safeParse(row.content);
        if (parsed.success) summaries.set(row.itemId, parsed.data.summary);
      }
      return summaries;
    },

    currentForItems: enrichmentForItems,

    /**
     * What a response carries about one article.
     *
     * There is no absent case: an article no model has touched answers with the
     * feed's summary and says where it came from, because the caller asked
     * what is there and "the feed's" is an answer. A field that could be null
     * would be a second way to say the same thing.
     */
    async currentFor(itemId) {
      return (await enrichmentForItems([itemId])).get(itemId) ?? UNENRICHED;
    },
  };
}
