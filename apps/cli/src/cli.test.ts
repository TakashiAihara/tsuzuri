import { afterAll, describe, expect, test } from "bun:test";

/**
 * The CLI, run as a process against a stub daemon.
 *
 * It had no tests at all, and that let a real defect ship: the search command
 * kept its own tag-stripping instead of the shared decoder, so a title
 * containing "&" printed as "&amp;". Unit tests could not have caught it —
 * importing the entry point runs `program.parseAsync` — so this drives the
 * binary the way a person does.
 */

let searchResponse: unknown = { mode: "text-only", results: [] };
let itemsResponse: unknown = { items: [] };
/** What the CLI last sent, so a test can assert on the request as well as the output. */
let lastItemsQuery: URLSearchParams | null = null;
let lastStateBody: unknown = null;
let enrichResponse: unknown = {
  items: 3,
  summarised: 3,
  tagged: 0,
  translated: 0,
  failed: 0,
  bounded: false,
};
let tagsResponse: unknown = { tags: [] };
let translateResponse: unknown = { itemId: "aa11", lang: "Japanese", text: "", cached: false };
/** Every path the stub was asked for, with the body it was given. */
const requests: { path: string; method: string; body: unknown }[] = [];

const daemon = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = ["POST", "PUT", "PATCH"].includes(request.method)
      ? await request.json().catch(() => undefined)
      : undefined;
    requests.push({ path: url.pathname, method: request.method, body });

    if (url.pathname === "/search") return Response.json(searchResponse);
    if (url.pathname === "/items") {
      lastItemsQuery = url.searchParams;
      return Response.json(itemsResponse);
    }
    if (url.pathname.endsWith("/state")) {
      lastStateBody = body;
      return Response.json({ state: {} });
    }
    if (url.pathname === "/enrich") return Response.json(enrichResponse);
    if (url.pathname === "/enrich/prune") return Response.json({ pruned: 4 });
    if (url.pathname === "/tags") return Response.json(tagsResponse);
    if (/^\/tags\/[^/]+\/(approve|reject)$/.test(url.pathname)) {
      const [, , slug, decision] = url.pathname.split("/");
      return Response.json({
        tag: { slug, status: decision === "approve" ? "approved" : "rejected" },
      });
    }
    if (url.pathname.endsWith("/translate")) return Response.json(translateResponse);
    return Response.json({ error: "no stub" }, { status: 404 });
  },
});

afterAll(() => {
  daemon.stop(true);
});

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/index.ts`, ...args], {
    env: { ...process.env, TSUZURI_ENDPOINT: `http://127.0.0.1:${daemon.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

const hit = (overrides: Record<string, unknown> = {}) => ({
  id: `aa11bb22${"0".repeat(56)}`,
  url: "https://example.com/a",
  title: "Rust 1.90 released & shipped",
  publishedAt: new Date().toISOString(),
  summary: null,
  snippet: 'Rust 1.90 released &amp; shipped. The <span class="keyword">borrow</span> checker.',
  rrf: 0.016,
  textRank: 1,
  vectorRank: null,
  ...overrides,
});

describe("tsuzuri search", () => {
  test("decodes entities and strips highlight markup in the snippet", async () => {
    // The defect this file exists for: "&amp;" reached the terminal verbatim.
    searchResponse = { mode: "text-only", results: [hit()] };
    const { stdout, code } = await run(["search", "Rust"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Rust 1.90 released & shipped. The borrow checker.");
    expect(stdout).not.toContain("&amp;");
    expect(stdout).not.toContain("<span");
  });

  test("prints an abbreviated id and the title on the first line", async () => {
    searchResponse = { mode: "text-only", results: [hit()] };
    const { stdout } = await run(["search", "Rust"]);
    expect(stdout).toContain("aa11bb22");
    expect(stdout).toContain("Rust 1.90 released & shipped");
  });

  test("says why a search was text-only, on stderr", async () => {
    // Data on stdout, everything else on stderr, so output can be piped.
    searchResponse = {
      mode: "text-only",
      reason: "no embedding model is configured",
      results: [hit()],
    };
    const { stdout, stderr } = await run(["search", "Rust"]);
    expect(stderr).toContain("no embedding model is configured");
    expect(stdout).not.toContain("no embedding model is configured");
  });

  test("--json emits the response verbatim on stdout", async () => {
    searchResponse = { mode: "hybrid", results: [hit()] };
    const { stdout } = await run(["--json", "search", "Rust"]);
    const parsed = JSON.parse(stdout) as { mode: string; results: { snippet: string }[] };
    expect(parsed.mode).toBe("hybrid");
    // Untouched: --json is for scripts, which want what the daemon said.
    expect(parsed.results[0]?.snippet).toContain("<span");
  });

  test("reports no matches rather than printing nothing", async () => {
    searchResponse = { mode: "text-only", results: [] };
    const { stderr } = await run(["search", "nothing"]);
    expect(stderr).toContain("no matches");
  });

  test("survives a hit with no snippet, which vector-only results have", async () => {
    searchResponse = { mode: "hybrid", results: [hit({ snippet: null })] };
    const { stdout, code } = await run(["search", "Rust"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Rust 1.90 released & shipped");
  });
});

describe("read and mark with duplicate clustering", () => {
  const row = (id: string, title: string, clusterSize: number) => ({
    id: `${id}${"0".repeat(64 - id.length)}`,
    url: `https://e.com/${id}`,
    title,
    author: null,
    publishedAt: new Date().toISOString(),
    publishedAtEstimated: false,
    summary: null,
    readAt: null,
    starredAt: null,
    clusterSize,
  });

  test("a collapsed row says how many other reports it stands for", async () => {
    itemsResponse = {
      items: [row("aaaa1111", "Syndicated story", 3), row("bbbb2222", "Only one", 1)],
    };
    const { stdout, code } = await run(["read"]);
    expect(code).toBe(0);
    expect(lastItemsQuery?.has("collapse")).toBe(false);
    expect(stdout).toContain("Syndicated story  +2");
    // A story only one outlet ran carries no count.
    expect(stdout).not.toMatch(/Only one\s+\+/);
  });

  test("--no-collapse asks for every report and shows no count", async () => {
    // Every report is already on screen, so "+2" would read as two more hidden.
    itemsResponse = { items: [row("aaaa1111", "Syndicated story", 3)] };
    const { stdout } = await run(["read", "--no-collapse"]);
    expect(lastItemsQuery?.get("collapse")).toBe("false");
    expect(stdout).toContain("Syndicated story");
    expect(stdout).not.toContain("+2");
  });

  test("mark reads the whole story, and --no-collapse only the report named", async () => {
    await run(["mark", "aaaa1111"]);
    expect(lastStateBody).toEqual({ read: true, scope: "cluster" });

    await run(["mark", "--no-collapse", "aaaa1111"]);
    expect(lastStateBody).toEqual({ read: true, scope: "item" });
  });
});

describe("enrichment commands", () => {
  const lastRequest = (path: string) => requests.filter((entry) => entry.path === path).at(-1);

  test("enrich sends the period it was given, and nothing else", async () => {
    const { code } = await run(["enrich", "--since", "7d"]);
    expect(code).toBe(0);
    expect(lastRequest("/enrich")?.method).toBe("POST");
    expect(lastRequest("/enrich")?.body).toEqual({ since: "7d", force: false });
  });

  test("enrich passes --kind and --force through", async () => {
    // --force is what re-runs articles that already have an answer for the
    // current prompt version, which is how a new prompt is compared with the old.
    await run(["enrich", "--since", "30d", "--kind", "summary", "--force"]);
    expect(lastRequest("/enrich")?.body).toEqual({
      since: "30d",
      kind: "summary",
      force: true,
    });
  });

  test("enrich refuses to run without a period rather than guessing one", async () => {
    const before = requests.length;
    const { code, stderr } = await run(["enrich"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/since/);
    expect(requests.length).toBe(before);
  });

  test("enrich says when the hourly bound stopped it", async () => {
    enrichResponse = {
      items: 60,
      summarised: 60,
      tagged: 0,
      translated: 0,
      failed: 0,
      bounded: true,
    };
    const { stderr } = await run(["enrich", "--since", "30d"]);
    // Otherwise a run that did half of what was asked looks like one with
    // nothing left to do.
    expect(stderr).toMatch(/ENRICH_MAX_ITEMS_PER_HOUR/);
  });

  test("enrich prune keeps the current combination and says what went", async () => {
    const { code, stderr } = await run(["enrich", "prune", "--keep-current"]);
    expect(code).toBe(0);
    expect(lastRequest("/enrich/prune")?.body).toEqual({ keepCurrent: true });
    expect(stderr).toMatch(/pruned 4/);
  });

  test("enrich prune refuses without --keep-current, which would delete everything", async () => {
    const before = requests.length;
    const { code } = await run(["enrich", "prune"]);
    expect(code).not.toBe(0);
    expect(requests.length).toBe(before);
  });

  test("tags review lists candidates with how often they were proposed", async () => {
    tagsResponse = {
      tags: [
        {
          id: "1",
          slug: "query-planners",
          label: "query-planners",
          status: "candidate",
          observations: 7,
        },
        { id: "2", slug: "compilers", label: "compilers", status: "candidate", observations: 5 },
      ],
    };
    const { stdout, code } = await run(["tags", "review"]);
    expect(code).toBe(0);
    expect(stdout).toContain("query-planners");
    expect(stdout).toContain("compilers");
    expect(stdout).toMatch(/7\s+query-planners/);
  });

  test("tags review says so when nothing is waiting", async () => {
    tagsResponse = { tags: [] };
    const { stdout, stderr } = await run(["tags", "review"]);
    expect(stderr).toMatch(/nothing waiting/);
    expect(stdout).toBe("");
  });

  test("tags approve and reject post to the tag they name", async () => {
    await run(["tags", "approve", "query-planners"]);
    expect(lastRequest("/tags/query-planners/approve")?.method).toBe("POST");

    await run(["tags", "reject", "compilers"]);
    expect(lastRequest("/tags/compilers/reject")?.method).toBe("POST");
  });

  test("translate prints the body and says when nothing was called", async () => {
    translateResponse = {
      itemId: "aa11bb22",
      lang: "Japanese",
      text: "翻訳された本文",
      cached: true,
    };
    const { stdout, stderr, code } = await run(["translate", "aa11bb22"]);
    expect(code).toBe(0);
    expect(lastRequest("/items/aa11bb22/translate")?.method).toBe("POST");
    expect(stdout).toBe("翻訳された本文\n");
    // Silence here would read as "the model was asked again", which is the
    // difference between a free repeat and a paid one.
    expect(stderr).toMatch(/no call made/);
  });
});
