/**
 * Code Mode sandbox — worker_threads + QuickJS WASM execution.
 *
 * Architecture:
 * - LLM writes JavaScript code that runs inside a QuickJS WASM VM (in a Worker thread)
 * - The sandbox exposes flat API globals (search, getFileContent, …) destructured
 *   from an `env.opengrok` API object; both forms bridge identically. All calls
 *   are synchronous from the LLM's perspective (the worker blocks via Atomics.wait
 *   while the main thread performs the async HTTP call)
 * - Intermediate results stay inside the QuickJS VM — only the final return value
 *   (captured via `export default`) crosses back to the LLM context window
 *
 * Buffer layout (pinned — must exactly match sandbox-worker.ts):
 *   Bytes 0–15:  Int32Array  statusArray  — [0]: 0=idle/result_ready, 1=pending_call (worker wrote a call; main thread must handle it)
 *   Bytes 16–19: Uint32Array lengthArray  — [0]: byte count of JSON payload
 *   Bytes 20+:   Uint8Array  dataArray    — JSON payload (max 8 MB, see sandbox-protocol.ts DATA_REGION_BYTES)
 *   TOTAL: SHARED_BUFFER_SIZE = 20 + 8 MiB
 *
 * Critical design decisions:
 * - Worker spawned with __dirname path (CJS, not import.meta.url)
 * - stopped flag + safeResolve() prevents double-resolution
 * - handleWorkerCall() Atomics.waitAsync loop; sleeps until worker signals, checks stopped first
 * - Overflow guard: fitToBuffer() truncates results to fit dataArray (never silently changes type)
 * - 62s hardTimeout terminates worker unconditionally (60s = HTTP search timeout + 2s buffer)
 * - capFn applied to final output (delegates truncation to caller)
 */

import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import type { WorkerHandle } from "./worker-pool.js";
import type { OpenGrokClient } from "../client/index.js";
import type { MemoryBank } from "../memory/memory-bank.js";
import type { HealthAPIResult } from "../utils/api-types.js";
import { buildFileOverview, buildCallChain, getTreeSitterLineBudget, langFromPath } from "../intelligence.js";
import { getGuidanceForPath } from "../guidance.js";
import { expandToFunctionBoundary } from "../intelligence/ast-truncation.js";
import { isLanguageSupported } from "../intelligence/tree-sitter.js";
import { logger } from "../utils/logger.js";
import { auditLog } from "../transport/audit.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SearchResults } from "../models.js";
import { elicitOrFallback, type ElicitSchema, type ElicitResult } from "../protocol/elicitation.js";
import { sampleOrNull } from "../protocol/sampling.js";
import { sanitizeSandboxError as _sanitizeSandboxErrorCore } from "../utils/redact.js";
import { SHARED_BUFFER_SIZE, STATUS_OFFSET, LENGTH_OFFSET, DATA_OFFSET } from "./protocol.js";
import { fitToBuffer, buildBatchSearchStubs } from "./buffer.js";
import { decodeCursor, encodeCursor, isOffsetCursorFor, CURSOR_EXPIRED, type OffsetCursorMethod } from "../pagination/cursor-codec.js";
import { normalizeFileType, VALID_FILE_TYPES, matchesFileType } from "../client/index.js";

/** Clamp a user-supplied limit to a sane range [1, max]. Handles NaN/Infinity. */
function clampLimit(val: number | undefined, fallback: number, max = 10_000): number {
  const n = val ?? fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function validateFileTypeOption(fileType: string | undefined): string | undefined {
  const normalized = normalizeFileType(fileType);
  if (normalized && ![...VALID_FILE_TYPES].map((s) => s.toLowerCase()).includes(normalized.toLowerCase())) {
    throw new Error(`Invalid fileType '${fileType}'. Valid types: ${[...VALID_FILE_TYPES].sort().join(", ")}`);
  }
  return normalized;
}

/** Resolve an optional opaque cursor to a start offset. Returns null when expired/invalid. */
function resolveCursorOffset(cursor: string | undefined, method: OffsetCursorMethod, fallback: number): number | null {
  if (!cursor) return fallback;
  const state = decodeCursor(cursor);
  if (!isOffsetCursorFor(state, method)) return null;
  return state.v;
}

// ---------------------------------------------------------------------------
// Buffer layout constants are imported from sandbox-protocol.ts (shared with sandbox-worker.ts)

// ---------------------------------------------------------------------------
// sanitizeSandboxError — strips sensitive data from error messages
// ---------------------------------------------------------------------------

/**
 * Sanitize an error from the sandbox before returning it to the LLM caller.
 * Extracts the message from various error shapes, then delegates redaction
 * to the unified sanitizeSandboxError from redact.ts.
 * Truncates to 500 chars maximum.
 */
export function sanitizeSandboxError(err: unknown): string {
  let message: string;
  if (typeof err === "string") {
    message = err;
  } else if (err instanceof Error) {
    message = err.message;
  } else if (err !== null && err !== undefined && typeof (err as Record<string, unknown>).message === "string") {
    message = (err as Record<string, unknown>).message as string;
  } else {
    message = "Unknown sandbox error";
  }
  return _sanitizeSandboxErrorCore(message).slice(0, 500);
}

// ---------------------------------------------------------------------------
// API_SPEC — single source of truth in ./sandbox-schemas/ (generated file)
// ---------------------------------------------------------------------------

/**
 * Code Mode API specification served by the opengrok_api tool and the
 * opengrok-docs://api resource.
 *
 * Single-source-of-truth: the Zod schemas in ./sandbox-schemas/ generate
 * sandbox-apispec-generated.ts via `npm run generate:spec`. Do NOT hand-edit
 * the spec here — update the schemas and regenerate.
 *
 * API_SPEC is a TypeScript declaration string for the flat sandbox globals
 * (env.opengrok.* is equivalent; served directly as text by server.ts).
 */
export { API_SPEC_TS, API_SPEC, METHOD_SIGNATURES } from "./api-spec.js";

/**
 * Filter feature-flagged lines out of the API spec string.
 * Drops [MEMORY] method docs/signatures when memory tools are disabled so
 * the LLM never codes against unregistered tools.
 */
export function filterApiSpec(spec: string, opts: { memoryTools: boolean }): string {
  if (opts.memoryTools) return spec;
  return spec
    .split("\n")
    .filter((line) => !line.includes("[MEMORY]"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Sandbox API interface
// ---------------------------------------------------------------------------

export interface SandboxAPI {
  search(query: string, opts?: {
    searchType?: string;
    projects?: string[];
    maxResults?: number;
    startIndex?: number;
    cursor?: string;
    fileType?: string;
    sort?: string;
    maxHitsPerFile?: number;
    dir?: string;
    pathFilter?: string;
    file?: string;
    expandFunction?: boolean;
  }): Promise<unknown>;

  batchSearch(queries: Array<{ query: string; searchType?: string; maxResults?: number; expandFunction?: boolean; dir?: string; pathFilter?: string; file?: string; maxHitsPerFile?: number }>, opts?: {
    projects?: string[];
    fileType?: string;
    sort?: string;
    maxHitsPerFile?: number;
    pathFilter?: string;
    dir?: string;
    expandFunction?: boolean;
  }): Promise<unknown>;

  getFileContent(project: string, path: string, opts?: {
    startLine?: number;
    endLine?: number;
    expandFunction?: boolean;
  }): Promise<unknown>;

  getSymbolContext(symbol: string, opts?: {
    projects?: string[];
    contextLines?: number;
    maxRefs?: number;
    includeHeader?: boolean;
    fileType?: string;
    file?: string;
  }): Promise<unknown>;

  getFileSymbols(project: string, path: string, opts?: { cursor?: string; limit?: number }): Promise<unknown>;
  getFileHistory(project: string, path: string, opts?: { maxEntries?: number; cursor?: string }): Promise<unknown>;
  getFileAnnotate(project: string, path: string, opts?: { startLine?: number; endLine?: number; includeContent?: boolean; revision?: string }): Promise<unknown>;
  browseDir(project: string, path?: string, opts?: { cursor?: string; limit?: number }): Promise<unknown>;
  findFile(pattern: string, opts?: { projects?: string[]; maxResults?: number; cursor?: string }): Promise<unknown>;
  getFileOverview(project: string, path: string, opts?: { includeImports?: boolean }): Promise<unknown>;
  traceCallChain(symbol: string, opts?: {
    direction?: "callers" | "callees" | "both";
    depth?: number;
    project?: string;
  }): Promise<unknown>;
  searchSuggest(query: string, opts?: { project?: string; projects?: string[]; field?: string; context?: { full?: string; defs?: string; refs?: string; path?: string; hist?: string } }): Promise<unknown>;
  getCompileInfo(path: string): Promise<unknown>;
  indexHealth(): Promise<unknown>;
  getFileDiff(project: string, path: string, rev1: string, rev2: string, opts?: { cursor?: string; limit?: number; includeHunks?: boolean }): Promise<unknown>;
  listProjects(filter?: string): Promise<unknown>;
  getGuidanceForPath(project: string, path: string, opts?: { maxFiles?: number; maxBytesPerFile?: number; maxTotalBytes?: number; guidanceRoot?: string }): Promise<unknown>;
  readMemory(filename: string): Promise<unknown>;
  writeMemory(filename: string, content: string, mode?: "overwrite" | "append"): Promise<unknown>;
  elicit(
    message: string,
    schema: ElicitSchema
  ): Promise<ElicitResult>;
  sample(
    prompt: string,
    opts?: { maxTokens?: number; systemPrompt?: string }
  ): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// createSandboxAPI — synchronous factory (no async)
// ---------------------------------------------------------------------------

/**
 * Create the host-side API object that bridges sandbox method calls to the real
 * OpenGrokClient. This function is synchronous — it returns immediately.
 * The actual async work happens when sandbox code triggers these methods via
 * the SharedArrayBuffer bridge from the worker thread.
 */
export interface SandboxOpts {
  getCompileInfoFn?: (path: string) => Promise<unknown>;
  mcpServer?: McpServer;
  elicitEnabled?: boolean;
  samplingEnabled?: boolean;
  defaultProject?: string;
  /** When false, readMemory/writeMemory throw (memory tools disabled). Default true. */
  memoryEnabled?: boolean;
}

const MAX_SANDBOX_WRITES_PER_EXECUTION = 5;

export function createSandboxAPI(
  client: OpenGrokClient,
  memoryBank: MemoryBank,
  sandboxOpts: SandboxOpts = {}
): SandboxAPI {
  const { getCompileInfoFn, mcpServer, elicitEnabled, samplingEnabled = false, defaultProject, memoryEnabled = true } = sandboxOpts;
  let writeCallCount = 0;

  // Apply default project only when projects was not provided (undefined).
  // An explicit empty array means "search all projects" and must not be overridden.
  function applyDefault(projects: string[] | undefined): string[] | undefined {
    if (projects !== undefined) return projects;
    return defaultProject ? [defaultProject] : undefined;
  }

  type ExpandableResult = { path: string; matches: Array<{ lineNumber?: number; line?: number }> };

  /**
   * Expand the first 3 result files, reading each from its own originating
   * project: a search may span projects, and results carry per-result
   * `project`. Falls back to `fallbackProject` for results without one.
   * Preserves the max-3-files budget.
   */
  async function expandResultsByProject(
    rawResults: Array<{ project?: string }> | undefined,
    compactResults: ExpandableResult[],
    fallbackProject: string,
  ): Promise<void> {
    const groups = new Map<string, ExpandableResult[]>();
    let taken = 0;
    for (let i = 0; i < compactResults.length && taken < 3; i++) {
      const item = compactResults[i];
      taken++;
      const project = rawResults?.[i]?.project ?? fallbackProject;
      const list = groups.get(project);
      if (list) list.push(item);
      else groups.set(project, [item]);
    }
    for (const [project, items] of groups) {
      await expandResultFunctions(project, items);
    }
  }

  /** Expand the first match of each result (max 3 files) to its enclosing function body. */
  async function expandResultFunctions(
    expansionProject: string,
    results: ExpandableResult[],
  ): Promise<void> {
    const filesToExpand = results.slice(0, 3);
    await Promise.allSettled(filesToExpand.map(async (resultItem) => {
      const fileLang = langFromPath(resultItem.path);
      if (!isLanguageSupported(fileLang)) return;
      const firstMatch = resultItem.matches[0];
      if (!firstMatch) return;
      const matchLine = firstMatch.lineNumber ?? firstMatch.line;
      if (!matchLine) return;
      try {
        // Full-file fetch (cached after first call) — a mid-file window can
        // start inside a multi-line string/expression, producing unparseable
        // fragments where expansion silently fails.
        const fileContent = await client.getFileContent(expansionProject, resultItem.path);
        const expansion = await expandToFunctionBoundary(
          fileContent.content, matchLine, fileLang, getTreeSitterLineBudget()
        );
        if (expansion) {
          (resultItem as Record<string, unknown>).functionContext = expansion.expandedContent;
        }
      } catch { /* best-effort */ }
    }));
  }

  return {
    async search(query, opts = {}) {
      if (typeof query !== "string") throw new Error(`search: 'query' must be a string, got ${typeof query}. Use positional args: search(query, opts)`);
      if (!query.trim()) throw new Error("search: query must be non-empty");
      if (typeof opts === "string") throw new Error(`search: 2nd arg must be an options object {searchType, projects, limit}, not a string.`);
      const { searchType = "full", projects, cursor, fileType, sort, dir: rawDir, pathFilter: rawPathFilter, file, expandFunction } = opts as {
        searchType?: string; projects?: string[]; maxResults?: number; limit?: number; cursor?: string;
        fileType?: string; sort?: string; maxHitsPerFile?: number; dir?: string; pathFilter?: string;
        file?: string; expandFunction?: boolean;
      };
      const validatedFileType = validateFileTypeOption(fileType);
      const VALID_SORTS = new Set(["relevancy", "lastmodtime", "fullpath"]);
      if (sort && !VALID_SORTS.has(sort)) {
        throw new Error(`Invalid sort '${sort}'. Valid values: ${[...VALID_SORTS].join(", ")}`);
      }
      if (searchType === "hist" && (rawDir ?? rawPathFilter)) {
        throw new Error(`search: 'dir' filter is not supported for searchType:'hist' — history search is always global.`);
      }
      const pathFilter = (rawPathFilter ?? rawDir)?.replace(/^\/+|\/+$/g, "") || undefined;
      const limit = clampLimit((opts as { maxResults?: number; limit?: number }).maxResults ?? (opts as { limit?: number }).limit, 5);
      const rawMaxHits = (opts as { maxHitsPerFile?: number }).maxHitsPerFile;
      const maxHitsPerFile = rawMaxHits != null && Number.isFinite(rawMaxHits) && rawMaxHits > 0 ? Math.min(Math.floor(rawMaxHits), 10_000) : undefined;

      // file filter → dispatch to getAllMatchesInFile (no pagination)
      if (file) {
        if (cursor) return { ...CURSOR_EXPIRED };
        const effectiveType = searchType === "symbol" ? "defs" : searchType;
        const fileProject = applyDefault(undefined)?.[0] ?? defaultProject;
        if (!fileProject) throw new Error(`search: 'file' filter requires a project. Pass projects or configure a default.`);
        const normalizedFile = file.startsWith("/") ? file : `/${file}`;
        const matches = await client.getAllMatchesInFile(fileProject, normalizedFile, query, effectiveType as "full" | "defs" | "refs" | "path" | "hist", limit);
        const fileResult: Record<string, unknown> = {
          query,
          searchType,
          totalCount: matches.length,
          timeMs: 0,
          results: [{
            project: fileProject,
            path: normalizedFile,
            matches,
          }],
          startIndex: 0,
          endIndex: matches.length,
        };
        if (expandFunction && matches.length > 0) {
          await expandResultsByProject(
            [{ project: fileProject }],
            fileResult.results as unknown as ExpandableResult[],
            fileProject,
          );
        }
        return fileResult;
      }

      const resolvedStart = resolveCursorOffset(cursor, "search", (opts as { startIndex?: number }).startIndex ?? 0);
      if (resolvedStart === null) return { ...CURSOR_EXPIRED };
      const cached = await client.search(
        query,
        searchType as "full" | "defs" | "refs" | "symbol" | "path" | "hist",
        applyDefault(projects), limit, resolvedStart, validatedFileType,
        sort as "relevancy" | "lastmodtime" | "fullpath" | undefined,
        maxHitsPerFile, pathFilter
      );
      // Shallow-clone before any mutation so the TTLCache entry is not modified.
      const result = { ...cached } as SearchResults & Record<string, unknown>;
      if (result.endIndex < result.totalCount) {
        result.cursor = encodeCursor({ t: "offset", v: result.endIndex, m: "search" });
      }
      if (result.totalCount === 0 && mcpServer && samplingEnabled) {
        const raw = await sampleOrNull(mcpServer, [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Code search for "${query}" returned 0 results. ` +
                `Suggest 3 alternative search terms, comma-separated, no explanation.`,
            },
          },
        ], {
          maxTokens: 60,
          systemPrompt: "You are a code search assistant. Be terse.",
        });
        if (raw) {
          (result as unknown as Record<string, unknown>)._suggestions =
            raw.split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 3);
        }
      }
      if (expandFunction && (result as unknown as { results: unknown[] }).results.length > 0) {
        const fallbackProject = applyDefault(projects)?.[0] ?? defaultProject ?? "";
        await expandResultsByProject(
          (result as unknown as { results: Array<{ project?: string }> }).results,
          (result as unknown as { results: ExpandableResult[] }).results,
          fallbackProject,
        );
      }
      return result;
    },

    async batchSearch(queries, opts = {}) {
      const MAX_BATCH_QUERIES = 10;
      if (queries.length > MAX_BATCH_QUERIES) {
        throw new Error(`batchSearch: maximum ${MAX_BATCH_QUERIES} queries allowed, got ${queries.length}. Split into multiple batchSearch() calls.`);
      }
      const { projects, fileType, sort, maxHitsPerFile: batchMaxHits, pathFilter: batchPathFilter, dir: batchDir, expandFunction: expandAll } = opts as {
        projects?: string[]; fileType?: string; sort?: string; maxHitsPerFile?: number;
        pathFilter?: string; dir?: string; expandFunction?: boolean;
      };
      const validatedFileType = validateFileTypeOption(fileType);
      const effectiveProjects = applyDefault(projects);
      const batchPath = (batchPathFilter ?? batchDir)?.replace(/^\/+|\/+$/g, "") || undefined;
      const settled = await Promise.allSettled(queries.map((q: { query: string; searchType?: string; maxResults?: number; limit?: number; dir?: string; pathFilter?: string; file?: string; maxHitsPerFile?: number; expandFunction?: boolean }) => {
        if (q.file) {
          const fileProject = effectiveProjects?.[0] ?? defaultProject;
          if (!fileProject) throw new Error(`batchSearch: query "${q.query}" uses 'file' filter but no project is set.`);
          const normalizedFile = q.file.startsWith("/") ? q.file : `/${q.file}`;
          const effectiveType = q.searchType === "symbol" ? "defs" : (q.searchType ?? "full");
          return client.getAllMatchesInFile(fileProject, normalizedFile, q.query, effectiveType as "full" | "defs" | "refs" | "path" | "hist", q.maxResults ?? q.limit ?? 5)
            .then((matches) => ({
              query: q.query,
              searchType: q.searchType ?? "full",
              totalCount: matches.length,
              timeMs: 0,
              results: [{ project: fileProject, path: normalizedFile, matches }],
              startIndex: 0,
              endIndex: matches.length,
            } as unknown as import("../models.js").SearchResults));
        }
        const qPath = (q.pathFilter ?? q.dir)?.replace(/^\/+|\/+$/g, "") || batchPath;
        return client.search(q.query, (q.searchType ?? "full") as "full" | "defs" | "refs" | "symbol" | "path" | "hist", effectiveProjects, clampLimit(q.maxResults ?? q.limit, 5), 0, validatedFileType, sort as "relevancy" | "lastmodtime" | "fullpath" | undefined, q.maxHitsPerFile ?? batchMaxHits, qPath);
      }));
      const expanded = await Promise.all(settled.map(async (r, i) => {
        if (r.status === "fulfilled") {
          if ((queries[i].expandFunction || expandAll) && r.value.results.length > 0) {
            const fallbackProject = effectiveProjects?.[0] ?? defaultProject ?? "";
            await expandResultsByProject(
              r.value.results,
              r.value.results as unknown as ExpandableResult[],
              fallbackProject,
            );
          }
          return r.value;
        }
        // Propagate per-query errors so the LLM can diagnose and fix them
        const q = queries[i];
        return {
          query: q.query,
          searchType: q.searchType ?? "full",
          totalCount: 0,
          timeMs: 0,
          results: [],
          startIndex: 0,
          endIndex: -1,
          _error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      }));
      return expanded;
    },

    async getFileContent(project, path, opts = {}) {
      const result = await client.getFileContent(project, path, opts.startLine, opts.endLine);
      if (opts.expandFunction && opts.startLine !== undefined) {
        const fileLang = langFromPath(path);
        if (isLanguageSupported(fileLang)) {
          try {
            // Full-file fetch for accurate AST boundaries (cached after first call).
            const full = (opts.startLine === undefined && opts.endLine === undefined)
              ? result
              : await client.getFileContent(project, path);
            const expansion = await expandToFunctionBoundary(
              full.content, opts.startLine, fileLang, getTreeSitterLineBudget()
            );
            if (expansion) {
              return {
                ...result,
                content: expansion.expandedContent,
                functionName: expansion.functionName,
                functionStartLine: expansion.functionStartLine,
                functionEndLine: expansion.functionEndLine,
              };
            }
          } catch { /* fall through to the plain result */ }
        }
      }
      return result;
    },

    async getSymbolContext(symbol, opts = {}) {
      const { projects, contextLines = 10, maxRefs = 5, includeHeader = true, fileType, file } = opts as {
        projects?: string[]; contextLines?: number; maxRefs?: number; includeHeader?: boolean;
        fileType?: string; file?: string;
      };
      const validatedFileType = validateFileTypeOption(fileType);
      const effectiveProjects = applyDefault(projects);
      // Fetch refs at a minimum of 20 so results contain the .h declaration
      // when includeHeader is true and the header is only in refs.
      const refFetchLimit = Math.max(maxRefs, 20);
      const [defResults, rawRefResults] = await Promise.all([
        client.search(symbol, "defs", effectiveProjects, 5, 0, validatedFileType),
        client.search(symbol, "refs", effectiveProjects, refFetchLimit, 0, validatedFileType),
      ]);
      // Escape OpenGrok's page-size dead zone: when refFetchLimit lands in (pageSize, totalCount],
      // the web UI returns pageSize results and the REST API may also cap at pageSize regardless.
      let refResults = rawRefResults;
      if (refFetchLimit > rawRefResults.results.length && rawRefResults.totalCount > rawRefResults.results.length) {
        const escapeLimit = Math.min(rawRefResults.totalCount + 5, refFetchLimit + 100);
        const escaped = await client.search(symbol, "refs", effectiveProjects, escapeLimit, 0, validatedFileType);
        if (escaped.results.length > rawRefResults.results.length) {
          refResults = escaped;
        } else {
          const remaining = rawRefResults.totalCount - rawRefResults.results.length;
          if (remaining > 0) {
            try {
              const page2 = await client.search(symbol, "refs", effectiveProjects, remaining, rawRefResults.results.length, validatedFileType);
              if (page2.results.length > 0) {
                refResults = { ...rawRefResults, results: [...rawRefResults.results, ...page2.results] };
              }
            } catch { /* page 2 unavailable — proceed with page 1 */ }
          }
        }
      }

      const normalizedFile = file?.replace(/^\/+/, "");
      const fileScopedDefs = normalizedFile
        ? defResults.results.filter((r) => r.path === file || r.path.endsWith(`/${normalizedFile}`))
        : defResults.results;
      const defPool = fileScopedDefs.length > 0 ? fileScopedDefs : defResults.results;

      if (!defPool.length || !defPool[0].matches.length) {
        const noDefRefResults = refResults.results;
        const noDefPerFile = noDefRefResults.length > 0
          ? Math.max(2, Math.ceil(maxRefs / noDefRefResults.length))
          : 2;
        const noDefToSample = (limit: number) => noDefRefResults.flatMap((r) =>
          r.matches.slice(0, limit).map((m) => ({
            path: r.path, project: r.project,
            lineNumber: m.lineNumber, content: m.lineContent,
          }))
        ).slice(0, maxRefs);
        let samples = noDefToSample(noDefPerFile);
        const noDefMatchCount = noDefRefResults.reduce((sum, r) => sum + r.matches.length, 0);
        if (samples.length < maxRefs && samples.length < noDefMatchCount) {
          samples = noDefToSample(Number.MAX_SAFE_INTEGER);
        }
        const noDefRefs: Record<string, unknown> = {
          totalFound: noDefMatchCount,
          samples,
        };
        if (refResults.totalCount > noDefRefResults.length) {
          noDefRefs._note = `Sampled ${noDefRefResults.length} of ${refResults.totalCount} matching files; increase maxRefs to scan more files`;
        }
        return {
          found: false,
          symbol,
          kind: "unknown",
          references: noDefRefs,
        };
      }

      // Promote .cpp to primary when includeHeader is true and both .h and .cpp exist in defs.
      const cppInDefs = defPool.find((r) => r.path.match(/\.(cpp|cc|cxx)$/i));
      const defResult = (includeHeader && cppInDefs) ? cppInDefs : defPool[0];
      const defMatch = defResult.matches[0];
      // Clamp context start to the enclosing symbol boundary to prevent bleed into preceding function
      let contextStart = Math.max(1, defMatch.lineNumber - contextLines);
      try {
        const syms = await client.getFileSymbols(defResult.project, defResult.path);
        const preceding = syms.symbols
          .filter(s => s.lineEnd !== undefined && s.lineEnd < defMatch.lineNumber && s.type === "function")
          .sort((a, b) => (b.lineEnd ?? 0) - (a.lineEnd ?? 0))[0];
        if (preceding && preceding.lineEnd !== undefined && contextStart <= preceding.lineEnd) {
          contextStart = preceding.lineEnd + 1;
        }
      } catch { /* getFileSymbols failure is non-fatal — use unclamped start */ }
      // Try to expand to full function boundary via tree-sitter
      const defLang = langFromPath(defResult.path);
      let defContext = "";
      let defStartLine = defMatch.lineNumber;
      if (isLanguageSupported(defLang)) {
        try {
          const fullContent = await client.getFileContent(defResult.project, defResult.path);
          const expansion = await expandToFunctionBoundary(
            fullContent.content, defMatch.lineNumber, defLang, getTreeSitterLineBudget()
          );
          if (expansion) {
            defContext = expansion.expandedContent;
            defStartLine = expansion.functionStartLine;
          }
        } catch { /* fallback below */ }
      }
      if (!defContext) {
        const defContent = await client.getFileContent(
          defResult.project,
          defResult.path,
          contextStart,
          defMatch.lineNumber + contextLines
        );
        defContext = defContent.content;
      }

      let header;
      if (includeHeader && defResult.path.match(/\.(cpp|cc|cxx)$/i)) {
        // Try defs/refs results first (zero extra HTTP calls)
        const headerResult =
          defResults.results.find((r) => r.path.match(/\.(h|hpp|hxx)$/i)) ||
          refResults.results.find((r) => r.path.match(/\.(h|hpp|hxx)$/i));
        if (headerResult?.matches.length) {
          const hLine = headerResult.matches[0].lineNumber;
          const hContent = await client.getFileContent(
            headerResult.project, headerResult.path,
            Math.max(1, hLine - 10), hLine + 10
          );
          header = { project: headerResult.project, path: headerResult.path, context: hContent.content, lang: "cpp" };
        } else {
          // Stem-based fallback: look for co-located .h/.hpp/.hxx file
          const stem = defResult.path.replace(/\.(cpp|cc|cxx)$/i, "");
          for (const ext of [".h", ".hpp", ".hxx"]) {
            try {
              const candidatePath = stem + ext;
              const hContent = await client.getFileContent(defResult.project, candidatePath, 1, 100);
              const lines = hContent.content.split("\n");
              const symIdx = lines.findIndex(l => l.includes(symbol));
              const windowContent = symIdx >= 0
                ? lines.slice(Math.max(0, symIdx - 5), symIdx + 6).join("\n")
                : hContent.content;
              header = { project: defResult.project, path: candidatePath, context: windowContent, lang: ext.slice(1) };
              break;
            } catch { /* file not found — try next extension */ }
          }
        }
      }

      const filteredRefResults = validatedFileType
        ? refResults.results.filter((r) => matchesFileType(r.path, validatedFileType))
        : refResults.results;
      const totalMatchCount = filteredRefResults.reduce((sum, r) => sum + r.matches.length, 0);
      const perFileSampleCount = filteredRefResults.length > 0
        ? Math.max(2, Math.ceil(maxRefs / filteredRefResults.length))
        : 2;
      const toSample = (limit: number) => filteredRefResults
        .flatMap((r) =>
          r.matches.slice(0, limit).map((m) => ({
            path: r.path, project: r.project,
            lineNumber: m.lineNumber, content: m.lineContent,
          }))
        ).slice(0, maxRefs);
      let refSamples = toSample(perFileSampleCount);
      // Second pass: if per-file cap dropped matches and we're still under maxRefs,
      // lift the cap so high-occurrence files fill the remaining budget.
      if (refSamples.length < maxRefs && refSamples.length < totalMatchCount) {
        refSamples = toSample(Number.MAX_SAFE_INTEGER);
      }

      const refsOut: Record<string, unknown> = {
        totalFound: totalMatchCount,
        samples: refSamples,
      };
      if (refResults.totalCount > filteredRefResults.length) {
        refsOut._note = `Sampled ${filteredRefResults.length} of ${refResults.totalCount} matching files; increase maxRefs to scan more files`;
      }

      return {
        found: true,
        symbol,
        kind: defResults.results[0].path.match(/\.(h|hpp|hxx)$/i) ? "class/struct" : "function/method",
        definition: {
          project: defResult.project,
          path: defResult.path,
          line: defStartLine,
          context: defContext,
          lang: defResult.path.split(".").pop() ?? "",
        },
        header,
        references: refsOut,
      };
    },

    async getFileSymbols(project, path, opts = {}) {
      const o = opts as { cursor?: string; limit?: number };
      if (o.cursor === undefined && o.limit === undefined) {
        return client.getFileSymbols(project, path);
      }
      const resolvedStart = resolveCursorOffset(o.cursor, "symbols", 0);
      if (resolvedStart === null) return { ...CURSOR_EXPIRED };
      const limit = clampLimit(o.limit, 50);
      // Full list is cached client-side; slice locally so total stays accurate.
      const full = await client.getFileSymbols(project, path);
      const page = full.symbols.slice(resolvedStart, resolvedStart + limit);
      const out: Record<string, unknown> = {
        project: full.project,
        path: full.path,
        symbols: page,
        total: full.symbols.length,
      };
      if (resolvedStart + limit < full.symbols.length) {
        out.cursor = encodeCursor({ t: "offset", v: resolvedStart + limit, m: "symbols" });
      }
      return out;
    },

    async getFileHistory(project, path, opts = {}) {
      const resolvedStart = resolveCursorOffset((opts as { cursor?: string }).cursor, "history", 0);
      if (resolvedStart === null) return { ...CURSOR_EXPIRED };
      const limit = clampLimit((opts as { maxEntries?: number }).maxEntries, 10);
      const result = await client.getFileHistory(project, path, limit + 1, resolvedStart);
      const entries = result.entries.slice(0, limit);
      const out: Record<string, unknown> = { ...result, entries };
      if (result.entries.length > limit) {
        out.cursor = encodeCursor({ t: "offset", v: resolvedStart + limit, m: "history" });
      }
      return out;
    },

    async getFileAnnotate(project, path, opts = {}) {
      const o = opts as { revision?: string; includeContent?: boolean; startLine?: number; endLine?: number };
      if (o.startLine !== undefined && o.endLine !== undefined && o.endLine < o.startLine) {
        throw new Error(`getFileAnnotate: endLine (${o.endLine}) must be >= startLine (${o.startLine})`);
      }
      const result = await client.getAnnotate(project, path, o.revision !== undefined ? { revision: o.revision } : undefined);
      let lines = result.lines.map((l) => {
        const entry: Record<string, unknown> = { lineNumber: l.lineNumber, revision: l.revision, author: l.author, date: l.date };
        if (o.includeContent !== false) entry.content = l.content;
        return entry;
      });
      if (o.startLine !== undefined || o.endLine !== undefined) {
        const start = o.startLine ?? 1;
        const end = o.endLine ?? Infinity;
        const filtered = lines.filter((l) => (l.lineNumber as number) >= start && (l.lineNumber as number) <= end);
        if (filtered.length === 0 && lines.length > 0) {
          const totalLines = (lines[lines.length - 1]?.lineNumber as number) ?? lines.length;
          throw new Error(`getFileAnnotate: range ${start}–${end === Infinity ? totalLines : end} is out of bounds (file has ${totalLines} lines)`);
        }
        lines = filtered;
      }
      // Preserve default content inclusion; strip only when includeContent === false.
      return { project: result.project, path: result.path, lines };
    },

    async browseDir(project, path = "", opts = {}) {
      const o = opts as { cursor?: string; limit?: number };
      if (o.cursor === undefined && o.limit === undefined) {
        const entries = await client.browseDirectory(project, path);
        return { project, path, entries };
      }
      const resolvedStart = resolveCursorOffset(o.cursor, "browse", 0);
      if (resolvedStart === null) return { ...CURSOR_EXPIRED };
      const limit = clampLimit(o.limit, 50);
      const entries = await client.browseDirectory(project, path);
      const page = entries.slice(resolvedStart, resolvedStart + limit);
      const out: Record<string, unknown> = { project, path, entries: page, total: entries.length };
      if (resolvedStart + limit < entries.length) {
        out.cursor = encodeCursor({ t: "offset", v: resolvedStart + limit, m: "browse" });
      }
      return out;
    },

    async findFile(pattern, opts = {}) {
      const resolvedStart = resolveCursorOffset(opts.cursor, "findFile", 0);
      if (resolvedStart === null) return { ...CURSOR_EXPIRED };
      const result = await client.search(pattern, "path", applyDefault(opts.projects), opts.maxResults ?? 10, resolvedStart);
      const r = { ...result } as SearchResults & Record<string, unknown>;
      if (r.endIndex < r.totalCount) {
        r.cursor = encodeCursor({ t: "offset", v: r.endIndex, m: "findFile" });
      }
      return r;
    },

    async getFileOverview(project, path, opts = {}) {
      const full = await buildFileOverview(client, project, path);
      if ((opts as { includeImports?: boolean }).includeImports) return full;
      const rest = { ...(full as unknown as Record<string, unknown>) };
      delete rest.imports;
      return rest;
    },

    async traceCallChain(symbol, opts = {}) {
      const { direction = "callers", depth = 2, project } = opts;
      const maybeBg = client as unknown as { createBackgroundClient?: () => typeof client };
      const bg = typeof maybeBg.createBackgroundClient === "function" ? maybeBg.createBackgroundClient() : client;
      try {
        return await buildCallChain(bg, symbol, direction, depth, project ?? defaultProject);
      } finally {
        if (bg !== client) await bg.close().catch(() => undefined);
      }
    },

    async searchSuggest(query, opts = {}) {
      const projects = (opts as { projects?: string[]; project?: string }).projects
        ?? ((opts as { project?: string }).project ?? defaultProject ? [((opts as { project?: string }).project ?? defaultProject) as string] : undefined);
      const result = await client.suggest({
        query,
        field: ((opts as { field?: string }).field ?? "full") as "full" | "defs" | "refs" | "path" | "hist",
        projects,
        context: (opts as { context?: { full?: string; defs?: string; refs?: string; path?: string; hist?: string } }).context,
      });
      const suggestions = (result.suggestions as Array<string | { phrase: string }>).map((s) => typeof s === "string" ? s : s.phrase);
      return { query, field: (opts as { field?: string }).field ?? "full", suggestions, time: result.time };
    },

    async getCompileInfo(path) {
      if (getCompileInfoFn) return getCompileInfoFn(path);
      return null;
    },

    async listProjects(filter) {
      const projects = await client.listProjects(typeof filter === "string" ? filter : undefined);
      return { projects: projects.map((p) => p.name) };
    },

    async getGuidanceForPath(project, path, opts = {}) {
      return getGuidanceForPath(client, project, path, (opts ?? {}) as { maxFiles?: number; maxBytesPerFile?: number; maxTotalBytes?: number; guidanceRoot?: string });
    },

    async indexHealth() {
      const start = Date.now();
      const connected = await client.testConnection();
      const serverVersion = connected && typeof client.getServerVersion === "function"
        ? await client.getServerVersion().catch(() => null)
        : null;
      const suggestConfig = connected && typeof client.getSuggestConfig === "function"
        ? await client.getSuggestConfig().catch(() => null)
        : null;
      const result: HealthAPIResult & { serverVersion?: string; suggestConfig?: unknown } = {
        connected,
        latencyMs: Date.now() - start,
        baseUrl: client.getBaseUrl(),
        ...(serverVersion != null ? { serverVersion } : {}),
        ...(suggestConfig != null ? { suggestConfig } : {}),
      };
      return result;
    },

    async getFileDiff(project, path, rev1, rev2, opts = {}) {
      const o = opts as { cursor?: string; limit?: number; includeHunks?: boolean };
      const includeHunks = o.includeHunks !== false;
      if (rev1 === rev2) {
        const empty: Record<string, unknown> = { project, path, rev1, rev2, unifiedDiff: "", stats: { added: 0, removed: 0 }, _hint: "rev1 and rev2 are identical — pass two different revisions to see a diff." };
        if (includeHunks) empty.hunks = [];
        return empty;
      }
      if (o.cursor === undefined && o.limit === undefined && includeHunks) {
        return client.getFileDiff(project, path, rev1, rev2);
      }
      if (o.cursor === undefined && o.limit === undefined && !includeHunks) {
        const full = await client.getFileDiff(project, path, rev1, rev2);
        const rest = { ...(full as unknown as Record<string, unknown>) };
        delete rest.hunks;
        return rest;
      }
      const resolvedStart = resolveCursorOffset(o.cursor, "diff", 0);
      if (resolvedStart === null) return { ...CURSOR_EXPIRED };
      const limit = clampLimit(o.limit, 20);
      const full = await client.getFileDiff(project, path, rev1, rev2);
      if (!includeHunks) {
        const rest = { ...(full as unknown as Record<string, unknown>) };
        delete rest.hunks;
        return rest;
      }
      const page = full.hunks.slice(resolvedStart, resolvedStart + limit);
      const out: Record<string, unknown> = { ...full, hunks: page, total: full.hunks.length };
      if (resolvedStart + limit < full.hunks.length) {
        out.cursor = encodeCursor({ t: "offset", v: resolvedStart + limit, m: "diff" });
      }
      return out;
    },

    async readMemory(filename) {
      if (!memoryEnabled) throw new Error("Memory tools are disabled (OPENGROK_ENABLE_MEMORY_TOOLS=false).");
      return memoryBank.read(filename);
    },

    async writeMemory(filename, content, mode = "overwrite") {
      if (!memoryEnabled) throw new Error("Memory tools are disabled (OPENGROK_ENABLE_MEMORY_TOOLS=false).");
      if (++writeCallCount > MAX_SANDBOX_WRITES_PER_EXECUTION) {
        throw new Error(`writeMemory rate limit: max ${MAX_SANDBOX_WRITES_PER_EXECUTION} writes per execution`);
      }
      await memoryBank.write(filename, content, mode);
      return `Written: ${filename}`;
    },

    async elicit(message, schema) {
      if (!elicitEnabled || !mcpServer) return { action: "cancel" as const };
      return elicitOrFallback(mcpServer, message, schema);
    },

    async sample(prompt, sampleCallOpts = {}) {
      if (!mcpServer || !samplingEnabled) return null;
      return sampleOrNull(mcpServer, [
        { role: "user", content: { type: "text", text: prompt } },
      ], {
        maxTokens: sampleCallOpts.maxTokens ?? 256,
        systemPrompt: sampleCallOpts.systemPrompt ?? "",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// executeInSandbox — core execution engine
// ---------------------------------------------------------------------------

/**
 * Explicit allowlist of SandboxAPI method names that LLM-written code may
 * invoke via the SharedArrayBuffer bridge.
 *
 * Any method NOT in this set is rejected, preventing inherited Object.prototype
 * properties or future methods accidentally added to SandboxAPI from being
 * callable by untrusted code.
 */
export const SANDBOX_ALLOWED_METHODS = new Set<string>([
  "search", "batchSearch", "getFileContent", "getSymbolContext",
  "getFileSymbols", "getFileHistory", "getFileAnnotate", "browseDir",
  "findFile", "getFileOverview", "traceCallChain", "searchSuggest",
  "getCompileInfo", "indexHealth", "listProjects", "getGuidanceForPath",
  "readMemory", "writeMemory",
  "getFileDiff", "elicit", "sample",
]);

/**
 * Execute LLM-written JavaScript inside a QuickJS WASM sandbox (Worker thread).
 * The code has access to flat API globals (equivalently `env.opengrok.*`)
 * that bridge back to the host via SharedArrayBuffer + Atomics
 * (synchronous from code's perspective).
 *
 * @param capFn  — response-size cap function (e.g. capResponse from server.ts)
 * Returns: capFn-capped result string, or an error message.
 */
export async function executeInSandbox(
  code: string,
  api: SandboxAPI,
  capFn: (text: string) => string,
  _budgetBytes: number,
  pooledWorker?: WorkerHandle,
  timeouts?: { hardTimeout?: number }
): Promise<string> {
  // Create shared communication buffer (layout pinned — must match sandbox-worker.ts)
  const sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const statusArray = new Int32Array(sharedBuffer, STATUS_OFFSET, 4);
  const lengthArray = new Uint32Array(sharedBuffer, LENGTH_OFFSET, 1);
  const dataArray   = new Uint8Array(sharedBuffer, DATA_OFFSET);

  const hardTimeout = timeouts?.hardTimeout ?? 62_000;

  let stopped = false;
  let _resolve!: (value: string) => void;

  function safeResolve(value: string): void {
    if (stopped) return;
    stopped = true;
    _resolve(value);
  }

  // ---------------------------------------------------------------------------
  // Wait loop — processes pending API calls from the worker
  //
  // Uses Atomics.waitAsync so the main thread sleeps while the worker is
  // blocked in Atomics.wait() — eliminating the setImmediate busy-poll that
  // previously consumed ~15–25% CPU on shared machines during sandbox execution.
  //
  // Protocol:
  //   worker sets statusArray[0] = 1 and calls Atomics.notify → wakes this loop
  //   this loop handles the call, resets statusArray[0] = 0, calls Atomics.notify → wakes worker
  // ---------------------------------------------------------------------------

  async function handleWorkerCall(): Promise<void> {
    while (!stopped) {
      // Sleep until the worker signals a pending call (status 0 → 1).
      // Pre-check: if already 1 (worker wrote before we started waiting), skip sleep.
      if (Atomics.load(statusArray, 0) !== 1) {
        const r = Atomics.waitAsync(statusArray, 0, 0, Infinity);
        if (r.async) await r.value;
        // !r.async → value was already ≠ 0 when called; proceed immediately
      }
      if (stopped) return;
      // Recheck after wakeup — handles spurious wakes (permitted by spec)
      if (Atomics.load(statusArray, 0) !== 1) continue;

      // Worker has a pending API call — deserialize it
      try {
        const callLen  = lengthArray[0];
        const callJson = Buffer.from(dataArray.subarray(0, callLen)).toString("utf8");
        const { method, args } = JSON.parse(callJson) as { method: string; args: unknown[] };

        // Enforce explicit allowlist — reject any method not in the pre-approved set
        if (!SANDBOX_ALLOWED_METHODS.has(method)) {
          throw new Error(`Sandbox method not allowed: "${method}"`);
        }
        const apiMethod = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        if (typeof apiMethod !== "function") {
          throw new Error(`Unknown API method: ${method}`);
        }

        // Execute the real async HTTP call on the main thread
        const result = await apiMethod(...args);

        // If timeout fired while we were awaiting, skip writing — worker is dead
        if (stopped) return;

        // Write result back into the buffer, truncating if needed
        let fittedResult: unknown = fitToBuffer(result ?? null, dataArray.length);

        // Type guard: fitToBuffer must NEVER silently change the return type.
        // If it does, throw a descriptive error so the LLM gets a diagnosable
        // message instead of a cryptic "not a function" when calling .map().
        if (result !== null && result !== undefined) {
          const wasArray = Array.isArray(result);
          const isArray  = Array.isArray(fittedResult);
          if (wasArray !== isArray) {
            throw new Error(
              `fitToBuffer type violation for "${method}": expected ${wasArray ? "array" : "object"} ` +
              `but got ${isArray ? "array" : "object"} after truncation. ` +
              `Original size: ${Buffer.byteLength(JSON.stringify({ data: result }), "utf8")} bytes, ` +
              `buffer limit: ${dataArray.length} bytes. Reduce maxResults or add filters.`
            );
          }
        }

        // For batchSearch: guarantee N elements out for N queries in.
        // Replace the single truncation marker with per-query stubs so the
        // LLM knows exactly which queries were dropped and can retry them.
        if (method === "batchSearch" && Array.isArray(fittedResult) && Array.isArray(args[0])) {
          const queries = args[0] as Array<{ query: string }>;
          const arr = fittedResult as unknown[];
          const last = arr[arr.length - 1] as Record<string, unknown> | undefined;
          if (last && typeof last === "object" && last._truncated === true) {
            const keptCount = (last._kept as number | undefined) ?? (arr.length - 1);
            const keptElements = arr.slice(0, keptCount);

            const stubs = buildBatchSearchStubs(queries, keptCount, result as unknown[]);

            const candidate = [...keptElements, ...stubs];
            const candidateSize = Buffer.byteLength(JSON.stringify({ data: candidate }), "utf8");
            if (candidateSize <= dataArray.length) {
              fittedResult = candidate;
            }
            // else: keep the generic marker (stubs don't fit — extremely unlikely)
          }
        }

        const resultJson    = JSON.stringify({ data: fittedResult });
        const resultEncoded = Buffer.from(resultJson, "utf8");
        if (resultEncoded.length > dataArray.length) {
          // Post-processing expanded beyond buffer — re-fit without marker fix
          const refitted = fitToBuffer(result ?? null, dataArray.length);
          const refittedJson = JSON.stringify({ data: refitted });
          const refittedBuf = Buffer.from(refittedJson, "utf8");
          lengthArray[0] = refittedBuf.length;
          dataArray.set(refittedBuf, 0);
        } else {
          lengthArray[0] = resultEncoded.length;
          dataArray.set(resultEncoded, 0);
        }
      } catch (err) {
        // Write error back into the buffer using __error sentinel
        const errMsg = ((err as Error).message ?? "Unknown API error").slice(0, 4096);
        const errJson    = JSON.stringify({ __error: errMsg });
        const errEncoded = Buffer.from(errJson, "utf8");
        if (errEncoded.length > dataArray.length) {
          const fallback = Buffer.from(JSON.stringify({ __error: "API error (message truncated)" }), "utf8");
          lengthArray[0] = fallback.length;
          dataArray.set(fallback, 0);
        } else {
          lengthArray[0] = errEncoded.length;
          dataArray.set(errEncoded, 0);
        }
      }

      // Signal: result_ready — wake up the blocked worker thread.
      // Reset status to idle (0) BEFORE notifying, rather than in a deferred
      // setImmediate after. This eliminates the race where a new call from the
      // worker could set status=1 between Atomics.notify and the deferred reset,
      // causing the deferred reset to clobber the pending status=1.
      // The worker's Atomics.wait(statusArray, 0, 1) returns "ok" upon Atomics.notify
      // regardless of the current value, so it safely reads the buffer contents
      // that were written above before we cleared the status flag.
      Atomics.store(statusArray, 0, 0);
      Atomics.notify(statusArray, 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn worker and wire up result handling
  // ---------------------------------------------------------------------------

  // Resolve worker path: works in both compiled (out/server/) and test (src/server/sandbox/) contexts
  const localWorkerPath = path.join(__dirname, "sandbox-worker.js");
  const devWorkerPath = path.join(__dirname, "..", "..", "..", "out", "server", "sandbox-worker.js");
  const workerPath = fs.existsSync(localWorkerPath) ? localWorkerPath : devWorkerPath;

  let worker: Worker;
  if (pooledWorker) {
    // Use the pre-warmed worker from the pool; send job via message
    worker = pooledWorker.worker;
    worker.postMessage({ sharedBuffer, code });
  } else {
    worker = new Worker(workerPath, { workerData: { sharedBuffer, code } });
  }

  return new Promise<string>((resolve) => {
    _resolve = resolve;

    auditLog({ type: "sandbox_exec", detail: "executing user JS in QuickJS sandbox" });

    // Hard timeout — terminates worker unconditionally (default 62s, configurable for tests)
    // (60s matches the HTTP search timeout; +2s buffer lets HTTP errors propagate cleanly)
    const hardTimeoutId = setTimeout(() => {
      cleanup();
      void (pooledWorker ? pooledWorker.terminate() : worker.terminate());
      safeResolve(
        "Error: Sandbox execution timed out (62s limit). Simplify your code or reduce the number of API calls."
      );
    }, hardTimeout);

    // Cleanup removes all three listeners to prevent accumulation on reused pool workers
    function cleanup(): void {
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
    }

    function onMessage(result: { ok: boolean; data?: unknown; error?: { name: string; message: string }; type?: string }): void {
      if (result.type === "ready") return;  // pool startup ack — ignore
      cleanup();
      clearTimeout(hardTimeoutId);

      if (!result.ok) {
        const { name, message } = result.error ?? { name: "Error", message: "Unknown" };
        if (name === "ExecutionTimeout" || (name === "InternalError" && message === "interrupted")) {
          safeResolve(
            "Error: Sandbox execution timed out (59s limit). Simplify your code or reduce the number of API calls."
          );
          return;
        }
        if (message?.toLowerCase().includes("memory limit") || message?.toLowerCase().includes("out of memory")) {
          safeResolve(
            "Error: Sandbox memory limit exceeded (128 MB). Reduce data volume — filter results before storing."
          );
          return;
        }
        logger.error("Sandbox execution error:", `${name}: ${message}`);
        safeResolve(`Error: ${sanitizeSandboxError(message)}`);
        return;
      }

      const data = result.data;
      if (data === undefined || data === null) {
        safeResolve("(no return value — add a return statement to your code)");
        return;
      }

      const serialized =
        typeof data === "string" ? data : JSON.stringify(data, null, 2);
      safeResolve(capFn(serialized));
    }

    function onError(err: Error): void {
      cleanup();
      clearTimeout(hardTimeoutId);
      logger.error("Sandbox worker error:", err);
      safeResolve(`Error: ${sanitizeSandboxError(err)}`);
    }

    function onExit(code: number): void {
      if (!stopped) {
        cleanup();
        clearTimeout(hardTimeoutId);
        safeResolve(`Error: Sandbox worker exited unexpectedly (code ${code})`);
      }
    }

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);

    // Start the poll loop
    handleWorkerCall().catch((err) => {
      logger.error("Sandbox poll startup error:", err);
    });
  });
}
