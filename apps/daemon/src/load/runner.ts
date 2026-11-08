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
  let chain: Promise<unknown> = Promise.resolve();

  // A run that throws rejects to its caller only; the chain carries on.
  const enqueue = (apply: () => Promise<LoadResult>): Promise<LoadResult> => {
    const run = chain.then(async () => {
      const result = await apply();
      await loader.syncSourceState();
      last = { at: now().toISOString(), ...result };
      return result;
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    load: () => enqueue(() => loader.loadPending()),
    rebuild: () => enqueue(() => loader.reload()),
    last: () => last,
  };
}
