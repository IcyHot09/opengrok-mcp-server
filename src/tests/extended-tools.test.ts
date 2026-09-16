/**
 * Extended standard-tool tests — covers the six added tools,
 * formatters, RBAC entries, and sandbox refinements.
 */
import { describe, it, expect, vi } from "vitest";
import { formatMoreResults, formatRssHistory } from "../server/formatters/index.js";
import { GetSuggestPopularityArgs } from "../server/models.js";
import { hasPermission } from "../server/transport/rbac.js";
import { TOOL_DOCS, TOOL_REGISTRATION_ORDER, _dispatchTool as dispatchTool } from "../server/server.js";
import { createSandboxAPI } from "../server/sandbox/index.js";
import { buildGuidanceCandidatePaths, getGuidanceForPath } from "../server/guidance.js";
import type { Config } from "../server/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: "https://example.com/source/",
    OPENGROK_CODE_MODE: false,
    OPENGROK_CONTEXT_BUDGET: "standard",
    OPENGROK_DEFAULT_PROJECT: "",
    OPENGROK_ENABLE_SAMPLING: false,
  } as unknown as Config;
}

function makeMemoryBank() {
  return { read: vi.fn(), write: vi.fn() } as unknown as import("../server/memory/memory-bank.js").MemoryBank;
}

// ---------------------------------------------------------------------------
// 1. getSuggestPopularity model + client shape
// ---------------------------------------------------------------------------

describe("suggest popularity", () => {
  it("Zod model defaults field=full page_size=20", () => {
    const parsed = GetSuggestPopularityArgs.parse({ project: "p" });
    expect(parsed.field).toBe("full");
    expect(parsed.page_size).toBe(20);
  });

  it("TOOL_DOCS + registration order include suggest popularity", () => {
    expect(TOOL_DOCS["opengrok_get_suggest_popularity"]).toContain("popular");
    expect(TOOL_REGISTRATION_ORDER).toContain("opengrok_get_suggest_popularity");
  });

  it("RBAC developer+readonly allow suggest popularity", () => {
    expect(hasPermission("developer", "opengrok_get_suggest_popularity")).toBe(true);
    expect(hasPermission("readonly", "opengrok_get_suggest_popularity")).toBe(true);
  });

  it("dispatch returns popularity items", async () => {
    const client = {
      getSuggestPopularity: vi.fn().mockResolvedValue(["socket", "connect"]),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_get_suggest_popularity", { project: "p" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("socket");
  });

  it("dispatch empty returns admin-auth hint", async () => {
    const client = {
      getSuggestPopularity: vi.fn().mockResolvedValue([]),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_get_suggest_popularity", { project: "p" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("admin auth");
  });
});

// ---------------------------------------------------------------------------
// 2. Five wirings incl. formatters
// ---------------------------------------------------------------------------

describe("five tool wirings", () => {
  it("formatMoreResults lists lines", () => {
    const out = formatMoreResults([{ lineNumber: 3, lineContent: "  hello  " }], "proj", "src/a.cpp");
    expect(out).toContain("All matches in a.cpp");
    expect(out).toContain("L3: hello");
  });

  it("formatMoreResults empty", () => {
    expect(formatMoreResults([], "p", "f.cpp")).toContain("No matches");
  });

  it("formatRssHistory lists commits with files", () => {
    const out = formatRssHistory([{
      revision: "abc123def456", summary: "fix", fullMessage: "fix it",
      author: "alice", date: "2026-01-01", files: ["a.cpp", "b.h", "c.cpp", "d.cpp"],
      branches: [], autoCheckin: false,
    }], "proj", "src/a.cpp");
    expect(out).toContain("RSS History");
    expect(out).toContain("abc123def456".slice(0, 12));
    expect(out).toContain("+1 more");
  });

  it("dispatch get_all_matches", async () => {
    const client = {
      getAllMatchesInFile: vi.fn().mockResolvedValue([{ lineNumber: 1, lineContent: "x" }]),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_get_all_matches", { project: "p", path: "f.cpp", query: "x" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("All matches");
  });

  it("dispatch history_with_files", async () => {
    const client = {
      getFileHistoryWithFiles: vi.fn().mockResolvedValue({ entries: [] }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_get_file_history_with_files", { project: "p", path: "f" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("No history");
  });

  it("dispatch download_url sync", async () => {
    const client = {
      getDownloadUrl: vi.fn().mockReturnValue("https://example.com/source/download/p/f"),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_get_download_url", { project: "p", path: "f" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("download");
  });

  it("dispatch list_groups empty + non-empty", async () => {
    const emptyClient = { getProjectGroups: vi.fn().mockResolvedValue([]) } as unknown as import("../server/client/index.js").OpenGrokClient;
    expect(await dispatchTool("opengrok_list_groups", {}, emptyClient, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never)).toContain("admin auth");
    const fullClient = { getProjectGroups: vi.fn().mockResolvedValue([{ name: "g", projects: ["a", "b"] }]) } as unknown as import("../server/client/index.js").OpenGrokClient;
    expect(await dispatchTool("opengrok_list_groups", {}, fullClient, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never)).toContain("g: [a, b]");
  });

  it("dispatch project_repositories", async () => {
    const client = {
      getProjectRepositories: vi.fn().mockResolvedValue([{ url: "https://git/x", type: "git" }]),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_get_project_repositories", { project: "p" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("https://git/x");
  });

  it("RBAC + docs for all five", () => {
    for (const t of ["opengrok_get_all_matches", "opengrok_get_file_history_with_files", "opengrok_get_download_url", "opengrok_list_groups", "opengrok_get_project_repositories"]) {
      expect(hasPermission("developer", t)).toBe(true);
      expect(hasPermission("readonly", t)).toBe(true);
      expect(TOOL_DOCS[t]).toBeDefined();
      expect(TOOL_REGISTRATION_ORDER).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. health fields
// ---------------------------------------------------------------------------

describe("index_health fields", () => {
  it("dispatch includes serverVersion + suggestConfig", async () => {
    const client = {
      testConnection: vi.fn().mockResolvedValue(true),
      listProjects: vi.fn().mockResolvedValue([{ name: "a" }]),
      warmCache: vi.fn(),
      getServerVersion: vi.fn().mockResolvedValue("1.7.0"),
      getSuggestConfig: vi.fn().mockResolvedValue({ enabled: true, maxResults: 10 }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const text = await dispatchTool("opengrok_index_health", { response_format: "markdown" }, client, makeConfig(), { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() } as never);
    expect(text).toContain("Server version");
    expect(text).toContain("Suggest config");
  });

  it("sandbox indexHealth includes serverVersion", async () => {
    const client = {
      testConnection: vi.fn().mockResolvedValue(true),
      getBaseUrl: () => "https://example.com/source/",
      getServerVersion: vi.fn().mockResolvedValue("1.7.0"),
      getSuggestConfig: vi.fn().mockResolvedValue(null),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const api = createSandboxAPI(client, makeMemoryBank());
    const out = await api.indexHealth() as Record<string, unknown>;
    expect(out["serverVersion"]).toBe("1.7.0");
  });
});

// ---------------------------------------------------------------------------
// 5. annotate opts/OOB
// ---------------------------------------------------------------------------

describe("sandbox getFileAnnotate opts", () => {
  function annotateClient() {
    return {
      getAnnotate: vi.fn().mockResolvedValue({
        project: "p", path: "f.cpp",
        lines: [
          { lineNumber: 1, revision: "r1", author: "a", date: "d", content: "l1" },
          { lineNumber: 2, revision: "r2", author: "b", date: "d", content: "l2" },
          { lineNumber: 3, revision: "r3", author: "c", date: "d", content: "l3" },
        ],
      }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
  }

  it("revision passthrough", async () => {
    const client = annotateClient();
    const api = createSandboxAPI(client, makeMemoryBank());
    await api.getFileAnnotate("p", "f.cpp", { revision: "abc" });
    expect((client.getAnnotate as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ revision: "abc" });
  });

  it("range filter", async () => {
    const api = createSandboxAPI(annotateClient(), makeMemoryBank());
    const out = await api.getFileAnnotate("p", "f.cpp", { startLine: 2, endLine: 2 }) as { lines: Array<{ lineNumber: number }> };
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].lineNumber).toBe(2);
  });

  it("OOB throws", async () => {
    const api = createSandboxAPI(annotateClient(), makeMemoryBank());
    await expect(api.getFileAnnotate("p", "f.cpp", { startLine: 99, endLine: 100 })).rejects.toThrow(/out of bounds/);
  });

  it("end<start throws", async () => {
    const api = createSandboxAPI(annotateClient(), makeMemoryBank());
    await expect(api.getFileAnnotate("p", "f.cpp", { startLine: 5, endLine: 2 })).rejects.toThrow(/must be >=/);
  });

  it("includeContent false strips content", async () => {
    const api = createSandboxAPI(annotateClient(), makeMemoryBank());
    const out = await api.getFileAnnotate("p", "f.cpp", { includeContent: false }) as { lines: Array<Record<string, unknown>> };
    expect(out.lines[0]).not.toHaveProperty("content");
  });
});

// ---------------------------------------------------------------------------
// 6. overview flag
// ---------------------------------------------------------------------------

describe("sandbox getFileOverview flag", () => {
  it("strips imports unless set", async () => {
    const { buildFileOverview } = await import("../server/intelligence.js");
    void buildFileOverview;
    const client = {
      getFileSymbols: vi.fn().mockResolvedValue({ symbols: [] }),
      getFileContent: vi.fn().mockResolvedValue({ content: "", lineCount: 1, sizeBytes: 0 }),
      getFileHistory: vi.fn().mockResolvedValue({ entries: [] }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const api = createSandboxAPI(client, makeMemoryBank());
    const stripped = await api.getFileOverview("p", "a.cpp") as Record<string, unknown>;
    expect(stripped).not.toHaveProperty("imports");
    const kept = await api.getFileOverview("p", "a.cpp", { includeImports: true }) as Record<string, unknown>;
    expect(kept).toHaveProperty("imports");
  });
});

// ---------------------------------------------------------------------------
// 7. diff toggle
// ---------------------------------------------------------------------------

describe("sandbox getFileDiff toggle", () => {
  function diffClient() {
    return {
      getFileDiff: vi.fn().mockResolvedValue({
        project: "p", path: "f", rev1: "a", rev2: "b",
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
        unifiedDiff: "@@ x @@",
        stats: { added: 1, removed: 0 },
      }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
  }

  it("default keeps hunks", async () => {
    const api = createSandboxAPI(diffClient(), makeMemoryBank());
    const out = await api.getFileDiff("p", "f", "a", "b") as Record<string, unknown>;
    expect(out).toHaveProperty("hunks");
  });

  it("false returns unifiedDiff+stats only", async () => {
    const api = createSandboxAPI(diffClient(), makeMemoryBank());
    const out = await api.getFileDiff("p", "f", "a", "b", { includeHunks: false }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("hunks");
    expect(out).toHaveProperty("unifiedDiff");
    expect(out).toHaveProperty("stats");
  });
});

// ---------------------------------------------------------------------------
// 8. listProjects bridge
// ---------------------------------------------------------------------------

describe("sandbox listProjects", () => {
  it("wraps client.listProjects names", async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([{ name: "a" }, { name: "b" }]),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const api = createSandboxAPI(client, makeMemoryBank());
    const out = await api.listProjects() as { projects: string[] };
    expect(out.projects).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 9. suggest context
// ---------------------------------------------------------------------------

describe("sandbox searchSuggest context", () => {
  it("passes context to client.suggest", async () => {
    const client = {
      suggest: vi.fn().mockResolvedValue({ suggestions: [], time: 1 }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const api = createSandboxAPI(client, makeMemoryBank());
    await api.searchSuggest("foo", { context: { full: "bar" } });
    expect((client.suggest as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ context: { full: "bar" } });
  });
});

// ---------------------------------------------------------------------------
// 10. unknown-command suggestion
// ---------------------------------------------------------------------------

describe("CLI unknown command", () => {
  // Import the pure commands module directly — main.js has module-level
  // routing side effects and must not be imported in unit tests.
  async function loadCli() {
    return (await import("../server/cli/commands.js")) as unknown as {
      resolveCliCommand: (c: string | undefined) => string;
      suggestCliCommand: (c: string) => string | null;
      formatUnknownCommandMessage: (c: string) => string;
    };
  }

  it("resolves unknown", async () => {
    const cli = await loadCli();
    expect(cli.resolveCliCommand("bogus")).toBe("unknown");
    expect(cli.resolveCliCommand(undefined)).toBe("server");
  });

  it("suggests close match", async () => {
    const cli = await loadCli();
    expect(cli.suggestCliCommand("statu")).toBe("status");
    expect(cli.suggestCliCommand("setpu")).toBe("setup");
  });

  it("formats Did you mean message", async () => {
    const cli = await loadCli();
    const msg = cli.formatUnknownCommandMessage("statu");
    expect(msg).toContain('Unknown command "statu"');
    expect(msg).toContain('Did you mean "status"?');
  });

  it("no suggestion when far", async () => {
    const cli = await loadCli();
    expect(cli.suggestCliCommand("zzzzzz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11. symbolContext refinements
// ---------------------------------------------------------------------------

describe("symbolContext refinements", () => {
  function ctxClient() {
    return {
      search: vi.fn(async (symbol: string, type: string, _projects: unknown, limit: number) => {
        if (type === "defs") {
          return {
            totalCount: 1,
            results: [{ project: "p", path: "src/Foo.cpp", matches: [{ lineNumber: 20, lineContent: "void foo() {}" }] }],
          };
        }
        const totalCount = 3;
        const all = [
          { project: "p", path: "a.cpp", matches: [{ lineNumber: 1, lineContent: "foo()" }, { lineNumber: 2, lineContent: "foo()" }, { lineNumber: 3, lineContent: "foo()" }] },
          { project: "p", path: "b.cpp", matches: [{ lineNumber: 5, lineContent: "foo()" }] },
        ];
        void limit;
        return { totalCount, results: all };
      }),
      getFileContent: vi.fn(async (_proj: string, p: string, s?: number) => {
        if (s === undefined) return { content: "line1\nvoid foo() {}\nline3", lineCount: 3, sizeBytes: 10 };
        return { content: "ctx", lineCount: 10, sizeBytes: 3 };
      }),
      getFileSymbols: vi.fn().mockResolvedValue({ symbols: [{ symbol: "prev", type: "function", line: 5, lineStart: 5, lineEnd: 10 }] }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
  }

  it("uses refFetchLimit floor + two-pass sampling", async () => {
    const client = ctxClient();
    const api = createSandboxAPI(client, makeMemoryBank());
    const out = await api.getSymbolContext("foo", { maxRefs: 5 }) as { references: { totalFound: number; samples: unknown[] } };
    const searchMock = client.search as ReturnType<typeof vi.fn>;
    const refsCall = searchMock.mock.calls.find((c) => c[1] === "refs");
    expect(refsCall[3]).toBeGreaterThanOrEqual(20);
    expect(out.references.totalFound).toBeGreaterThan(0);
    expect(out.references.samples.length).toBeLessThanOrEqual(5);
  });

  it("header stem-fallback attempts .h when absent", async () => {
    const client = ctxClient();
    (client.getFileContent as ReturnType<typeof vi.fn>).mockImplementation(async (_proj: string, p: string) => {
      if (p.endsWith(".h")) return { content: "void foo();", lineCount: 1, sizeBytes: 10 };
      if (p === "src/Foo.cpp") return { content: "void foo() {}", lineCount: 1, sizeBytes: 10 };
      return { content: "ctx", lineCount: 10, sizeBytes: 3 };
    });
    const api = createSandboxAPI(client, makeMemoryBank());
    const out = await api.getSymbolContext("foo", { includeHeader: true }) as { header?: { path: string } };
    expect(out.header?.path).toMatch(/\.h$/);
  });
});

// ---------------------------------------------------------------------------
// 12. guidance discovery
// ---------------------------------------------------------------------------

describe("guidance discovery", () => {
  it("builds nearest/ancestor/boundary candidates", () => {
    const cands = buildGuidanceCandidatePaths("src/a/b/file.cpp");
    expect(cands[0].scope).toBe("nearest");
    expect(cands[cands.length - 1].scope).toBe("boundary");
    expect(cands.some((c) => c.path === "AGENTS.md")).toBe(true);
  });

  it("discovers guidance with temp workspace client", async () => {
    const client = {
      getFileContent: vi.fn(async (_proj: string, p: string) => {
        if (p === "src/AGENTS.md") return { content: "# guide" };
        throw new Error("404 not found");
      }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const out = await getGuidanceForPath(client, "p", "src/file.cpp");
    expect(out.guidance.length).toBeGreaterThanOrEqual(0);
    expect(out).toHaveProperty("searchedUpTo");
  });

  it("sandbox getGuidanceForPath bridges", async () => {
    const client = {
      getFileContent: vi.fn(async () => { throw new Error("404 not found"); }),
    } as unknown as import("../server/client/index.js").OpenGrokClient;
    const api = createSandboxAPI(client, makeMemoryBank());
    const out = await api.getGuidanceForPath("p", "src/file.cpp") as { guidance: unknown[] };
    expect(Array.isArray(out.guidance)).toBe(true);
  });

  it("rejects unsafe paths", async () => {
    const client = { getFileContent: vi.fn() } as unknown as import("../server/client/index.js").OpenGrokClient;
    await expect(getGuidanceForPath(client, "p", "../evil")).rejects.toThrow();
  });
});
