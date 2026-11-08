import type { createLoader, LoadResult } from "./loader.ts";

export type LoadRunnerDeps = {
  now?: () => Date;
};

export type LoadRunner = ReturnType<typeof createLoadRunner>;

/**
 * Serialises every loader run in one daemon (the flush hook, /ingest/run,
 * /rebuild, startup and shutdown) and remembers the last finished one for
 * /doctor. Concurrent loaders across processes are not guarded.
 */
export function createLoadRunner(
  loader: Pick<ReturnType<typeof createLoader>, "loadPending" | "reload" | "syncSourceState">,
  opts: LoadRunnerDeps = {},
) {
  const now = opts.now ?? (() => new Date());
  let last: ({ at: string } & LoadResult) | null = null;
  const totals = { runs: 0, inserted: 0 };
  let chain: Promise<unknown> = Promise.resolve();

  // A run that throws rejects to its caller only; the chain carries on.
  const enqueue = (apply: () => Promise<LoadResult>): Promise<LoadResult> => {
    const run = chain.then(async () => {
      const result = await apply();
      // Recorded before the sync: the rows are committed whether or not the
      // sync that follows succeeds.
      last = { at: now().toISOString(), ...result };
      totals.runs += 1;
      totals.inserted += result.inserted;
      await loader.syncSourceState();
      return result;
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    load: () => enqueue(() => loader.loadPending()),
    rebuild: () => enqueue(() => loader.reload()),
    last: () => last,
    /** Runs that applied (a run that throws before applying is not counted) and the items they inserted. */
    totals: () => ({ ...totals }),
    /** Resolves once every run queued so far has finished, failed or not. */
    settled: (): Promise<void> => chain.then(() => undefined),
  };
}
