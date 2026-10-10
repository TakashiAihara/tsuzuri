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

const daemon = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/search") return Response.json(searchResponse);
    if (url.pathname === "/items") {
      lastItemsQuery = url.searchParams;
      return Response.json(itemsResponse);
    }
    if (url.pathname.endsWith("/state")) {
      lastStateBody = await request.json();
      return Response.json({ state: {} });
    }
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
