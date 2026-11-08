import { describe, expect, test } from "bun:test";

import type { LoadResult } from "./loader.ts";
import { createLoadRunner } from "./runner.ts";

/**
 * The load runner: one chain for every loader run in a daemon, and the record
 * of the last run that /doctor reports.
 */
const result = (objects: number, inserted = 0): LoadResult => ({
  objects,
  inserted,
  linked: 0,
  rejected: 0,
  stoppedAt: null,
});

function fakeLoader() {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const step = async (name: string, value: LoadResult | number) => {
    calls.push(`${name}:start`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(20);
    active -= 1;
    calls.push(`${name}:end`);
    return value;
  };
  return {
    calls,
    maxActive: () => maxActive,
    loader: {
      loadPending: () => step("loadPending", result(2, 5)) as Promise<LoadResult>,
      reload: () => step("reload", result(7, 1)) as Promise<LoadResult>,
      syncSourceState: () => step("sync", 3) as Promise<number>,
    },
  };
}

describe("createLoadRunner", () => {
  test("load runs loadPending and then syncs the source state, and returns the load", async () => {
    const fake = fakeLoader();
    const runner = createLoadRunner(fake.loader);

    expect(await runner.load()).toEqual(result(2, 5));
    expect(fake.calls).toEqual(["loadPending:start", "loadPending:end", "sync:start", "sync:end"]);
  });

  test("rebuild runs reload and then syncs the source state", async () => {
    const fake = fakeLoader();
    const runner = createLoadRunner(fake.loader);

    expect(await runner.rebuild()).toEqual(result(7, 1));
    expect(fake.calls).toEqual(["reload:start", "reload:end", "sync:start", "sync:end"]);
  });

  test("runs started together never overlap", async () => {
    const fake = fakeLoader();
    const runner = createLoadRunner(fake.loader);

    await Promise.all([runner.load(), runner.rebuild(), runner.load()]);

    expect(fake.maxActive()).toBe(1);
    expect(fake.calls.filter((c) => c.endsWith(":start"))).toEqual([
      "loadPending:start",
      "sync:start",
      "reload:start",
      "sync:start",
      "loadPending:start",
      "sync:start",
    ]);
  });

  test("last is null before any run and then the latest finished run with its time", async () => {
    const fake = fakeLoader();
    let clock = new Date("2026-11-08T07:00:00.000Z");
    const runner = createLoadRunner(fake.loader, { now: () => clock });

    expect(runner.last()).toBeNull();
    await runner.load();
    clock = new Date("2026-11-08T07:05:00.000Z");
    await runner.rebuild();

    expect(runner.last()).toEqual({ at: "2026-11-08T07:05:00.000Z", ...result(7, 1) });
  });

  test("a sync that fails after a committed load still records the load", async () => {
    const fake = fakeLoader();
    const runner = createLoadRunner({
      ...fake.loader,
      syncSourceState: async () => {
        throw new Error("sync failed");
      },
    });

    const failing = async () => runner.load();
    await expect(failing()).rejects.toThrow("sync failed");
    expect(runner.last()).toMatchObject(result(2, 5));
    expect(runner.totals()).toEqual({ runs: 1, inserted: 5 });
  });

  test("settled resolves once every queued run has finished, failed ones included", async () => {
    const fake = fakeLoader();
    let failNext = false;
    const runner = createLoadRunner({
      ...fake.loader,
      loadPending: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("load failed");
        }
        return fake.loader.loadPending();
      },
    });
    void runner.load();
    failNext = true;
    runner.load().catch(() => undefined);
    void runner.rebuild();

    await runner.settled();

    expect(fake.calls.at(-1)).toBe("sync:end");
    expect(fake.calls.filter((c) => c === "reload:end")).toHaveLength(1);
    expect(runner.totals()).toEqual({ runs: 2, inserted: 6 });
  });

  test("a run that throws is reported to its caller and does not block the next one", async () => {
    const fake = fakeLoader();
    const runner = createLoadRunner({
      ...fake.loader,
      loadPending: async () => {
        throw new Error("storage list failed");
      },
    });

    const failing = async () => runner.load();
    await expect(failing()).rejects.toThrow("storage list failed");
    expect(runner.last()).toBeNull();
    expect(await runner.rebuild()).toEqual(result(7, 1));
  });
});
