import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { z, ZodError } from "zod";
import type { OpenGrokClient } from "../client/index.js";
import { assertSafePath, extractLineRange } from "../client/index.js";
import type { Config } from "../config.js";
import {
  capSearchResultsToBytes,
  formatAnnotate,
  formatBatchSearchResults,
  formatBatchSearchResultsTOON,
  formatBatchSearchResultsTSV,
  formatBlame,
  formatCompileInfo,
  formatDirectoryListing,
  formatFileContent,
  formatFileContentText,
  formatFileHistory,
  formatFileSymbols,
  formatMoreResults,
  formatProjectsList,
  formatRssHistory,
  formatSearchAndRead,
  formatSearchResults,
  formatSearchResultsTOON,
  formatSearchResultsTSV,
  formatSymbolContext,
  formatWhatChanged,
  formatDependencyMap,
  selectFormat,
} from "../formatters/index.js";
import type {
  SearchAndReadEntry,
  SymbolContextResult,
  DependencyNode,
} from "../formatters/index.js";
import type { CompileInfo } from "../local/compile-info.js";
import {
  inferBuildRoot,
  loadCompileCommandsJson,
  parseCompileCommands,
  resolveAllowedRoots,
} from "../local/compile-info.js";
import {
  BatchSearchArgs,
  BlameArgs,
  BrowseDirectoryArgs,
  GetAllMatchesArgs,
  GetCompileInfoArgs,
  GetDownloadUrlArgs,
  GetFileAnnotateArgs,
  GetFileContentArgs,
  GetFileHistoryArgs,
  GetFileHistoryWithFilesArgs,
  GetProjectRepositoriesArgs,
  GetSuggestPopularityArgs,
  GetFileSymbolsArgs,
  GetSymbolContextArgs,
  IndexHealthArgs,
  ListProjectsArgs,
  SearchAndReadArgs,
  SearchCodeArgs,
  SearchPatternArgs,
  SearchSuggestArgs,
  FindFileArgs,
  WhatChangedArgs,
  DependencyMapArgs,
} from "../models.js";
import type {
  FileContent,
  SearchResults,
  Project,
} from "../models.js";
import { getMaxResponseBytes, getSearchAndReadCap } from "../config.js";
import {
  capResponse as capResponseUtil,
  capCodeModeResult as capCodeModeResultUtil,
  capStructuredToBytes,
} from "../server-utils.js";
import { decodeCursor, encodeCursor, isOffsetCursorFor, CURSOR_EXPIRED } from "../pagination/cursor-codec.js";
import type { ResponseFormat } from "../formatters/index.js";
import { buildDependencyGraph as buildDependencyGraphIntel } from "../intelligence.js";
import { logger } from "../utils/logger.js";
import { sanitizeErrorMessage } from "../utils/redact.js";
/**
 * Tool executors (split from server.ts, pure move).
 */

// ---------------------------------------------------------------------------
// Response size caps (lazy env reads via config helpers — see server-utils.ts)
// ---------------------------------------------------------------------------

/**
 * Cap a response to the active budget's maxResponseBytes.
 * Delegates to server-utils (fence-close, lazy env override).
 */
export function capResponse(text: string, maxBytes?: number): string {
  return capResponseUtil(text, maxBytes);
}

export function capCodeModeResult(result: string, maxBytes: number): string {
  return capCodeModeResultUtil(result, maxBytes);
}

// ---------------------------------------------------------------------------
// Local layer — compile_commands.json index + file bypass
// ---------------------------------------------------------------------------

export interface LocalLayer {
  enabled: boolean;
  roots: string[];
  index: Map<string, CompileInfo>;
  suffixIndex: Map<string, string>;
}


export function buildLocalLayer(config: Config): LocalLayer {
  const rawPaths = config.OPENGROK_LOCAL_COMPILE_DB_PATHS.trim();
  if (!rawPaths) {
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const dbPaths = rawPaths.split(",").map((p) => p.trim()).filter(Boolean);
  if (!dbPaths.length) {
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const loaded = loadCompileCommandsJson(dbPaths);
  const inferredRoot = inferBuildRoot(dbPaths, loaded);

  let resolvedInferredRoot: string | undefined;
  if (inferredRoot) {
    try {
      resolvedInferredRoot = fs.realpathSync(inferredRoot);
    } catch {
      logger.warn(`Local layer: inferred build root not found locally: ${inferredRoot}`);
    }
  }

  const allowedRoots: string[] = resolvedInferredRoot ? [resolvedInferredRoot] : [];
  for (const r of resolveAllowedRoots(dbPaths)) {
    if (!allowedRoots.includes(r)) allowedRoots.push(r);
  }

  if (!allowedRoots.length) {
    logger.warn("Local layer: no valid allowed roots — local layer disabled");
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const index = parseCompileCommands(dbPaths, allowedRoots, loaded);

  const suffixIndex = new Map<string, string>();
  for (const key of index.keys()) {
    const normalized = key.replace(/\\/g, "/");
    const parts = normalized.split("/");
    for (let i = Math.max(0, parts.length - 4); i < parts.length; i++) {
      const suffix = "/" + parts.slice(i).join("/");
      /* v8 ignore start */
      if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, key);
      /* v8 ignore stop */
    }
  }

  logger.info(
    `Local layer enabled: ${index.size} compile entries from ${dbPaths.length} compile_commands.json` +
      (resolvedInferredRoot ? `, build root: ${resolvedInferredRoot}` : "")
  );

  return { enabled: true, roots: allowedRoots, index, suffixIndex };
}


export async function tryLocalRead(
  filePath: string,
  roots: string[],
  startLine?: number,
  endLine?: number
): Promise<FileContent | null> {
  try {
    assertSafePath(filePath);
  } catch {
    return null;
  }
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    normalized.includes("../") ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized === ".."
  ) {
    return null;
  }

  for (const root of roots) {
    // Canonicalize root to resolve any symlinks, preventing symlink traversal escapes
    let canonicalRoot: string;
    try {
      canonicalRoot = await fsp.realpath(root);
    } catch {
      canonicalRoot = root; // root doesn't exist yet, use as-is
    }

    const candidate = path.join(canonicalRoot, normalized);
    let resolved: string;
    try {
      resolved = await fsp.realpath(candidate);
    } catch {
      continue;
    }

    if (!resolved.startsWith(canonicalRoot + path.sep) && resolved !== canonicalRoot) {
      continue;
    }

    try {
      const fileStat = await fsp.stat(resolved);
      if (fileStat.size > 16 * 1024 * 1024) {
        // Skip files larger than 16 MB to prevent OOM
        continue;
      }
      const rawContent = await fsp.readFile(resolved, "utf8");
      const { text: content, totalLines } = extractLineRange(rawContent, startLine, endLine);

      return {
        project: "local",
        path: normalized,
        content,
        lineCount: totalLines,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        startLine,
      };
    } catch {
      /* v8 ignore start -- requires unreadable file on real filesystem */
      continue;
      /* v8 ignore stop */
    }
  }

  return null;
}


export function resolveFileFromIndex(
  opengrokPath: string,
  index: Map<string, CompileInfo>,
  suffixIndex: Map<string, string>
): string | null {
  if (!index.size) return null;
  if (index.has(opengrokPath)) return opengrokPath;
  const normalizedRequest = opengrokPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const suffix = "/" + normalizedRequest;
  const hit = suffixIndex.get(suffix);
  if (hit) return hit;
  for (const key of index.keys()) {
    if (key.replace(/\\/g, "/").endsWith(suffix)) return key;
  }
  return null;
}


export async function readFileAtAbsPath(
  absPath: string,
  startLine?: number,
  endLine?: number
): Promise<FileContent | null> {
  try {
    assertSafePath(absPath);
  } catch {
    return null;
  }
  try {
    const rawContent = await fsp.readFile(absPath, "utf8");
    const { text: content, totalLines } = extractLineRange(rawContent, startLine, endLine);

    return {
      project: "local",
      path: path.basename(absPath),
      content,
      lineCount: totalLines,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      startLine,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool result types and utilities
// ---------------------------------------------------------------------------


type ResourceLinkItem = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
};

export type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string } | ResourceLinkItem>;
  structuredContent?: Record<string, unknown>;
};


export function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    c: "text/x-c", h: "text/x-c", cpp: "text/x-c++", cc: "text/x-c++",
    cxx: "text/x-c++", hpp: "text/x-c++", hxx: "text/x-c++",
    java: "text/x-java-source", py: "text/x-python", js: "text/javascript",
    ts: "text/typescript", go: "text/x-go", rs: "text/x-rustsrc",
    rb: "text/x-ruby", sh: "text/x-sh", xml: "text/xml",
    json: "application/json", yaml: "text/yaml", yml: "text/yaml",
    md: "text/markdown", txt: "text/plain",
  };
  return map[ext] ?? "text/plain";
}


export function makeToolError(name: string, err: unknown): ToolResult {
  logger.error(`Tool "${name}" failed:`, err);
  let text: string;
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    text = `**Invalid arguments:** ${issues}`;
  } else if (err instanceof Error) {
    text = `**Error:** ${sanitizeErrorMessage(err.message)}`;
  } else {
    text = "**Error:** An unexpected error occurred. Check server logs.";
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Shared helper: format a tool response, routing to compact formats via selectFormat.
 * Applies capResponse to protect LLM context windows.
 *
 * When response_format="json", structured data is JSON-serialised into content[0].text
 * so programmatic consumers can parse it. No structuredContent is ever set — these
 * tools carry no outputSchema, so the SDK does not require it.
 */

export function formatResponse(
  textMarkdown: string,
  structured: Record<string, unknown>,
  format: ResponseFormat = "markdown",
  responseType: "search" | "symbol" | "code" | "generic" = "generic"
): ToolResult {
  const effective = selectFormat(responseType, format);
  let text: string;
  switch (effective) {
    case "json":
      text = capStructuredToBytes(structured, getMaxResponseBytes());
      break;
    default:
      text = capResponse(textMarkdown);
  }
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Pick the best search formatter based on the resolved format.
 *
 * When maxBytes is provided (and the format is TOON or TSV), the results
 * array is trimmed *before* encoding to guarantee structurally valid output.
 * Raw byte-truncation of TOON breaks the encoded structure; TSV is safer but
 * loses the "N more rows" footer. Pre-truncation is always correct.
 */

export function pickSearchFormatter(
  fmt: ResponseFormat,
  maxBytes?: number
): (r: SearchResults) => string {
  const cap = maxBytes
    ? (r: SearchResults) => capSearchResultsToBytes(r, maxBytes)
    : (r: SearchResults) => r;
  if (fmt === "toon") return (r) => formatSearchResultsTOON(cap(r));
  if (fmt === "tsv") return (r) => formatSearchResultsTSV(cap(r));
  return formatSearchResults;
}

// ---------------------------------------------------------------------------
// Apply default project helper
// ---------------------------------------------------------------------------


export function applyDefaultProject(
  projects: string[] | undefined,
  config: Config
): string[] | undefined {
  // Only apply the default when projects was not provided at all.
  // An explicit empty array means "search all projects" and must not be overridden.
  if (projects !== undefined && projects !== null) return projects;
  const defaultProject = config.OPENGROK_DEFAULT_PROJECT?.trim();
  return defaultProject ? [defaultProject] : undefined;
}

/**
 * Validate an optional opaque cursor before dispatching.
 * Returns an expired message when the cursor is present but invalid for the method,
 * or null when no cursor was supplied / the cursor is valid (client resolves it).
 */
export function checkCursorExpired(
  cursor: string | undefined,
  method: "search" | "history" | "findFile" | "browse" | "symbols" | "diff"
): string | null {
  if (!cursor) return null;
  const state = decodeCursor(cursor);
  if (!isOffsetCursorFor(state, method)) return CURSOR_EXPIRED.message;
  return null;
}

/** Mint a next-page cursor when more results remain. */
export function nextCursor(method: "search" | "history" | "findFile" | "browse" | "symbols" | "diff", offset: number): string {
  return encodeCursor({ t: "offset", v: offset, m: method });
}

export async function executeSearchCode(
  args: {
    query: string;
    search_type: "full" | "defs" | "refs" | "symbol" | "path" | "hist";
    projects?: string[];
    max_results: number;
    start_index: number;
    cursor?: string;
    file_type?: string;
    sort?: "relevancy" | "lastmodtime" | "fullpath";
    max_hits_per_file?: number;
    path_filter?: string;
    dir?: string;
    file?: string;
    response_format?: ResponseFormat;
  },
  client: OpenGrokClient,
  config: Config
): Promise<{ text: string; structured: SearchResults }> {
  // Single-file filter → all-matches-in-file path (no pagination).
  if (args.file) {
    if (args.cursor) throw new Error(CURSOR_EXPIRED.message);
    const fileProject = applyDefaultProject(args.projects, config)?.[0] ?? config.OPENGROK_DEFAULT_PROJECT;
    if (!fileProject) {
      throw new Error(`search: 'file' filter requires a project. Pass projects or configure OPENGROK_DEFAULT_PROJECT.`);
    }
    const normalizedFile = args.file.startsWith("/") ? args.file : `/${args.file}`;
    const effectiveType = args.search_type === "symbol" ? "defs" : args.search_type;
    const matches = await client.getAllMatchesInFile(fileProject, normalizedFile, args.query, effectiveType, args.max_results);
    const results: SearchResults = {
      query: args.query,
      searchType: args.search_type,
      totalCount: matches.length,
      timeMs: 0,
      results: [{ project: fileProject, path: normalizedFile, matches }],
      startIndex: 0,
      endIndex: matches.length,
    };
    const fmt = selectFormat("search", args.response_format);
    const maxBytes = getMaxResponseBytes();
    return { text: pickSearchFormatter(fmt, maxBytes)(results), structured: results };
  }
  const pathFilter = (args.path_filter ?? args.dir)?.replace(/^\/+|\/+$/g, "") || undefined;
  const results = await client.search(
    args.query,
    args.search_type,
    applyDefaultProject(args.projects, config),
    args.max_results,
    args.start_index,
    args.file_type,
    args.sort,
    args.max_hits_per_file,
    pathFilter,
    args.cursor
  );
  const fmt = selectFormat("search", args.response_format);
  const maxBytes = getMaxResponseBytes();
  const text = pickSearchFormatter(fmt, maxBytes)(results);
  return { text, structured: results };
}


export async function executeGetFileContent(
  args: {
    project: string;
    path: string;
    start_line?: number;
    end_line?: number;
    response_format?: ResponseFormat;
  },
  client: OpenGrokClient,
  local: LocalLayer
): Promise<{ text: string; structured: FileContent; warning?: string }> {
  let content: FileContent | null = null;

  if (local.enabled && local.index.size > 0) {
    const absPath = resolveFileFromIndex(args.path, local.index, local.suffixIndex);
    /* v8 ignore start */
    if (absPath) {
    /* v8 ignore stop */
      content = await readFileAtAbsPath(absPath, args.start_line, args.end_line);
    }
  }

  if (!content && local.enabled && local.roots.length > 0) {
    content = await tryLocalRead(args.path, local.roots, args.start_line, args.end_line);
  }

  if (!content) {
    content = await client.getFileContent(
      args.project,
      args.path,
      args.start_line,
      args.end_line
    );
  }

  const fmt = selectFormat("code", args.response_format);
  const text = fmt === "text" ? formatFileContentText(content) : formatFileContent(content);

  // Warn on full-file fetch (no line range) — returned separately so it doesn't contaminate the file text.
  if (!args.start_line && !args.end_line && content.lineCount > 50) {
    const warning = `Full file fetch (${content.lineCount} lines). Use opengrok_get_file_symbols first, then fetch only the lines you need.`;
    return { text, structured: content, warning };
  }

  return { text, structured: content };
}


export async function executeListProjects(
  args: { filter?: string; response_format?: ResponseFormat },
  client: OpenGrokClient
): Promise<{ text: string; structured: { projects: Project[]; total: number } }> {
  const projects = await client.listProjects(args.filter);
  return {
    text: formatProjectsList(projects),
    structured: { projects, total: projects.length },
  };
}


export function deduplicateAcrossQueries(
  results: Array<{
    query: string;
    searchType: string;
    results: SearchResults;
  }>
): Array<{
  query: string;
  searchType: string;
  results: SearchResults;
}> {
  const seen = new Map<string, Set<number>>(); // path → set of seen line numbers
  return results.map((queryResult) => {
    const dedupedHits = queryResult.results.results
      .map((hit) => {
        let pathSeen = seen.get(hit.path);
        if (!pathSeen) { pathSeen = new Set(); seen.set(hit.path, pathSeen); }
        const seenLines = pathSeen;
        const filteredMatches = hit.matches.filter((match) => {
          if (seenLines.has(match.lineNumber)) return false;
          seenLines.add(match.lineNumber);
          return true;
        });
        return { ...hit, matches: filteredMatches };
      })
      .filter((hit) => hit.matches.length > 0);

    // Recompute totalCount to reflect the actual number of matches returned,
    // so clients don't see a count that exceeds the actual results array.
    const dedupedMatchCount = dedupedHits.reduce((sum, hit) => sum + hit.matches.length, 0);

    return {
      ...queryResult,
      results: {
        ...queryResult.results,
        results: dedupedHits,
        totalCount: Math.min(queryResult.results.totalCount, dedupedMatchCount),
      },
    };
  });
}


export async function executeBatchSearch(
  args: {
    queries: Array<{
      query: string;
      search_type: "full" | "defs" | "refs" | "symbol" | "path" | "hist";
      max_results: number;
      path_filter?: string;
      dir?: string;
      max_hits_per_file?: number;
      file?: string;
    }>;
    projects?: string[];
    file_type?: string;
    sort?: "relevancy" | "lastmodtime" | "fullpath";
    path_filter?: string;
    dir?: string;
    file?: string;
    max_hits_per_file?: number;
    response_format?: ResponseFormat;
  },
  client: OpenGrokClient,
  config: Config
): Promise<{
  text: string;
  structured: {
    queryResults: Array<{
      query: string;
      searchType: string;
      results: SearchResults;
    }>;
  };
}> {
  const MAX_BATCH_QUERIES = 10;
  if (args.queries.length > MAX_BATCH_QUERIES) {
    throw new Error(`batchSearch: maximum ${MAX_BATCH_QUERIES} queries allowed, got ${args.queries.length}. Split into multiple batchSearch() calls.`);
  }
  const effectiveProjects = applyDefaultProject(args.projects, config);
  const topPath = (args.path_filter ?? args.dir)?.replace(/^\/+|\/+$/g, "") || undefined;
  const searchResults = await Promise.all(
    args.queries.map((q) => {
      // Per-query file filter (or top-level default) → all-matches-in-file path
      const qFile = q.file ?? args.file;
      if (qFile) {
        const fileProject = effectiveProjects?.[0] ?? config.OPENGROK_DEFAULT_PROJECT;
        if (!fileProject) {
          throw new Error(`batchSearch: query "${q.query}" uses 'file' filter but no project is set. Pass projects or configure OPENGROK_DEFAULT_PROJECT.`);
        }
        const normalizedFile = qFile.startsWith("/") ? qFile : `/${qFile}`;
        const effectiveType = q.search_type === "symbol" ? "defs" : q.search_type;
        return client.getAllMatchesInFile(fileProject, normalizedFile, q.query, effectiveType, q.max_results)
          .then((matches) => ({
            query: q.query,
            searchType: q.search_type,
            totalCount: matches.length,
            timeMs: 0,
            results: [{ project: fileProject, path: normalizedFile, matches }],
            startIndex: 0,
            endIndex: matches.length,
          }) as SearchResults);
      }
      const qPath = (q.path_filter ?? q.dir)?.replace(/^\/+|\/+$/g, "") || topPath;
      return client.search(
        q.query,
        q.search_type,
        effectiveProjects,
        q.max_results,
        0,
        args.file_type,
        args.sort,
        q.max_hits_per_file ?? args.max_hits_per_file,
        qPath
      );
    })
  );
  const queryResults = args.queries.map((q, i) => ({
    query: q.query,
    searchType: q.search_type,
    results: searchResults[i],
  }));

  const deduped = deduplicateAcrossQueries(queryResults);

  const fmt = selectFormat("search", args.response_format);
  const text =
    fmt === "toon"
      ? formatBatchSearchResultsTOON(deduped)
      : fmt === "tsv"
        ? formatBatchSearchResultsTSV(deduped)
        : formatBatchSearchResults(deduped);

  return {
    text,
    structured: { queryResults: deduped },
  };
}

// ---------------------------------------------------------------------------
// Compound tool handlers
// ---------------------------------------------------------------------------


export async function handleSearchAndRead(
  args: z.infer<typeof SearchAndReadArgs>,
  client: OpenGrokClient,
  config: Config
): Promise<string> {
  let searchResults: SearchResults;
  if (args.file) {
    const fileProject = applyDefaultProject(args.projects, config)?.[0] ?? config.OPENGROK_DEFAULT_PROJECT;
    if (!fileProject) {
      throw new Error(`search_and_read: 'file' filter requires a project. Pass projects or configure OPENGROK_DEFAULT_PROJECT.`);
    }
    const normalizedFile = args.file.startsWith("/") ? args.file : `/${args.file}`;
    const effectiveType = args.search_type === "symbol" ? "defs" : args.search_type;
    const matches = await client.getAllMatchesInFile(fileProject, normalizedFile, args.query, effectiveType, args.max_results);
    searchResults = {
      query: args.query,
      searchType: args.search_type,
      totalCount: matches.length,
      timeMs: 0,
      results: [{ project: fileProject, path: normalizedFile, matches }],
      startIndex: 0,
      endIndex: matches.length,
    };
  } else {
    const pathFilter = (args.path_filter ?? args.dir)?.replace(/^\/+|\/+$/g, "") || undefined;
    searchResults = await client.search(
      args.query,
      args.search_type,
      applyDefaultProject(args.projects, config),
      args.max_results,
      0,
      args.file_type,
      args.sort,
      args.max_hits_per_file,
      pathFilter
    );
  }

  const entries: SearchAndReadEntry[] = [];
  let totalOutputBytes = 0;

  for (const result of searchResults.results) {
    if (!result.matches.length) continue;

    const firstMatch = result.matches[0];
    const startLine = Math.max(1, firstMatch.lineNumber - args.context_lines);
    const endLine = firstMatch.lineNumber + args.context_lines;

    try {
      const fileContent = await client.getFileContent(
        result.project,
        result.path,
        startLine,
        endLine
      );

      const lang = result.path.includes(".")
        ? (/* v8 ignore next */ result.path.split(".").pop()?.toLowerCase() ?? "")
        : "";

      const contextText = fileContent.content;
      totalOutputBytes += Buffer.byteLength(contextText, "utf8");

      entries.push({
        project: result.project,
        path: result.path,
        matchLine: firstMatch.lineNumber,
        context: contextText,
        lang,
      });

      if (totalOutputBytes >= (getSearchAndReadCap())) break;
    } catch {
      // Skip files that can't be read
    }
  }

  return formatSearchAndRead(args.query, searchResults.totalCount, entries);
}


export async function handleGetSymbolContextStructured(
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config
): Promise<{ text: string; structured: SymbolContextResult }> {
  const args = GetSymbolContextArgs.parse(rawArgs);
  const effectiveProjects = applyDefaultProject(args.projects, config);

  const defResults = await client.search(
    args.symbol,
    "defs",
    effectiveProjects,
    // Fetch up to 5 results so we can find a matching .h/.hpp header without a second search
    args.include_header ? 5 : 3,
    0,
    args.file_type
  );

  // Optional file filter narrows to matching files first; falls back to all defs.
  const normalizedFile = args.file?.replace(/^\/+/, "");
  const fileScopedDefs = normalizedFile
    ? defResults.results.filter((r) => r.path === args.file || r.path.endsWith(`/${normalizedFile}`))
    : defResults.results;
  const defPool = fileScopedDefs.length > 0 ? fileScopedDefs : defResults.results;

  if (!defPool.length || !defPool[0].matches.length) {
    const result: SymbolContextResult = {
      found: false,
      symbol: args.symbol,
      kind: "unknown",
      references: { totalFound: 0, samples: [] },
    };
    return { text: formatSymbolContext(result), structured: result };
  }

  const defResult = defPool[0];
  const defMatch = defResult.matches[0];
  const defStartLine = Math.max(1, defMatch.lineNumber - args.context_lines);
  const defEndLine = defMatch.lineNumber + args.context_lines;
  const defLang = defResult.path.includes(".")
    ? (/* v8 ignore next */ defResult.path.split(".").pop()?.toLowerCase() ?? "")
    : "";

  const defContent = await client.getFileContent(
    defResult.project,
    defResult.path,
    defStartLine,
    defEndLine
  );

  let fileSymbols: SymbolContextResult["fileSymbols"];
  try {
    const symsResult = await client.getFileSymbols(defResult.project, defResult.path);
    if (symsResult.symbols.length > 0) {
      fileSymbols = symsResult.symbols.map((s) => ({
        symbol: s.symbol,
        type: s.type,
        line: s.lineStart ?? s.line,
      }));
    }
  } catch {
    // Symbol map is non-fatal
  }

  let header: SymbolContextResult["header"] | undefined;
  if (args.include_header && defResult.path.match(/\.(cpp|cc|cxx)$/i)) {
    try {
      // Reuse the already-fetched defResults (with maxResults=5) to find a header match
      // instead of issuing a second identical search. Filter for .h/.hpp files.
      const headerMatch = defResults.results.find((r) =>
        r.path.match(/\.(h|hpp|hxx)$/i)
      );
      if (headerMatch && headerMatch.matches.length) {
        const hLine = headerMatch.matches[0].lineNumber;
        const hContent = await client.getFileContent(
          headerMatch.project,
          headerMatch.path,
          Math.max(1, hLine - 10),
          hLine + 10
        );
        /* v8 ignore start -- header extension detection */
        const hLang = headerMatch.path.includes(".")
          ? (headerMatch.path.split(".").pop()?.toLowerCase() ?? "")
          : "";
        /* v8 ignore stop */
        header = {
          project: headerMatch.project,
          path: headerMatch.path,
          context: hContent.content,
          lang: hLang,
        };
      }
    } catch {
      // Header lookup failure is non-fatal
    }
  }

  const refResults = await client.search(
    args.symbol,
    "refs",
    effectiveProjects,
    args.max_refs,
    0,
    args.file_type
  );
  const refSamples = refResults.results.flatMap((r) =>
    r.matches.slice(0, 2).map((m) => ({
      path: r.path,
      project: r.project,
      lineNumber: m.lineNumber,
      content: m.lineContent,
    }))
  );

  const kind = defResult.path.match(/\.(h|hpp|hxx)$/i)
    ? "class/struct"
    : "function/method";

  const symbolResult: SymbolContextResult = {
    found: true,
    symbol: args.symbol,
    kind,
    definition: {
      project: defResult.project,
      path: defResult.path,
      line: defMatch.lineNumber,
      context: defContent.content,
      lang: defLang,
    },
    header,
    references: {
      totalFound: refResults.totalCount,
      samples: refSamples,
    },
    fileSymbols,
  };

  return { text: formatSymbolContext(symbolResult), structured: symbolResult };
}


export async function handleGetCompileInfo(
  rawArgs: Record<string, unknown>,
  config: Config,
  local: LocalLayer
): Promise<string> {
  const args = GetCompileInfoArgs.parse(rawArgs);

  if (!local.enabled) {
    return (
      "Local layer is not enabled. " +
      "Open a workspace containing compile_commands.json files to enable it automatically."
    );
  }

  if (!local.index.size) {
    return (
      "Local layer is enabled but no compile entries were loaded. " +
      "No compile_commands.json files found under the build root — build the project first."
    );
  }

  const requestedPath = args.path;
  let info: CompileInfo | undefined;

  if (path.isAbsolute(requestedPath)) {
    try {
      const resolved = await fsp.realpath(requestedPath);
      info = local.index.get(resolved);
    } catch {
      // Path doesn't exist — fall through
    }
  }

  if (!info) {
    const normalized = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
    for (const root of local.roots) {
      try {
        const resolved = await fsp.realpath(path.join(root, normalized));
        info = local.index.get(resolved);
        /* v8 ignore start */
        if (info) break;
        /* v8 ignore stop */
      } catch {
        // Try next root
      }
    }
  }

  if (!info) {
    const basename = path.basename(requestedPath);
    for (const [k, v] of local.index) {
      if (path.basename(k) === basename) {
        info = v;
        break;
      }
    }
  }

  return formatCompileInfo(info ?? null, requestedPath);
}

// ---------------------------------------------------------------------------
// Shared execute functions — used by both dispatchTool and registerLegacyTools
// to eliminate duplicated logic between the two paths (M2).
// ---------------------------------------------------------------------------


export async function executeBrowseDirectory(
  args: z.infer<typeof BrowseDirectoryArgs>,
  client: OpenGrokClient
): Promise<string> {
  const entries = await client.browseDirectory(args.project, args.path, { cursor: args.cursor });
  // Detect file path: directory listing returns a breadcrumb-like chain
  // (all directories, last entry = parent) when the path is actually a file.
  const normalPath = (args.path ?? "").replace(/^\/+/, "");
  if (args.path && entries.length > 0 && entries.length <= 10 &&
      entries.every((e) => e.isDirectory) &&
      entries[entries.length - 1]?.path === normalPath.replace(/\/[^/]+$/, "")) {
    const parentPath = args.path.replace(/\/[^/]+$/, "");
    throw new Error(
      `browse: '${args.path}' is a file, not a directory. ` +
      `Use opengrok_get_file_content for file content, or opengrok_browse_directory with path '${parentPath}' for the parent directory.`
    );
  }
  return formatDirectoryListing(entries, args.project, args.path);
}


export async function executeGetFileAnnotate(
  args: z.infer<typeof GetFileAnnotateArgs>,
  client: OpenGrokClient
): Promise<string> {
  const annotated = await client.getAnnotate(args.project, args.path, { revision: args.revision });
  return formatAnnotate(annotated, args.start_line, args.end_line);
}


export async function executeSearchSuggest(
  args: z.infer<typeof SearchSuggestArgs>,
  client: OpenGrokClient
): Promise<string> {
  try {
    const projects = args.projects ?? (args.project ? [args.project] : undefined);
    const result = await client.suggest({
      query: args.query,
      field: args.field,
      projects,
      context: args.context,
    });
    const suggestions = result.suggestions.map((s) => typeof s === "string" ? s : s.phrase);
    if (suggestions.length) {
      return "Suggestions:\n" + suggestions.map((s) => `  ${s}`).join("\n");
    }
    if (result.time === 0) {
      return "No suggestions found. The suggester index appears to be empty — an OpenGrok admin may need to rebuild it.";
    }
    return "No suggestions found.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("405") ||
        (err as { status?: number }).status === 404 ||
        (err as { status?: number }).status === 405) {
      return "Suggestions are not available on this OpenGrok instance (suggester endpoint returned 404/405). Use opengrok_search_code instead.";
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Central dispatcher — kept for backward-compatible test exports.
// @deprecated Tests should use registered tool handlers via client.callTool()
// via InMemoryTransport instead. dispatchTool will be removed in a future cleanup.
// ---------------------------------------------------------------------------


export async function dispatchTool(
  name: string,
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config,
  local: LocalLayer
): Promise<string> {
  switch (name) {
    case "opengrok_search_code": {
      const args = SearchCodeArgs.parse(rawArgs);
      const { text } = await executeSearchCode(args, client, config);
      return text;
    }

    case "opengrok_find_file": {
      const args = FindFileArgs.parse(rawArgs);
      // client.search() only honors "search"-tagged cursors — resolve the
      // findFile cursor to a start offset here (already validated above).
      let start = args.start_index;
      if (args.cursor) {
        const state = decodeCursor(args.cursor);
        if (state && isOffsetCursorFor(state, "findFile")) start = state.v;
      }
      const results = await client.search(
        args.path_pattern,
        "path",
        applyDefaultProject(args.projects, config),
        args.max_results,
        start
      );
      return formatSearchResults(results);
    }

    case "opengrok_search_pattern": {
      const args = SearchPatternArgs.parse(rawArgs);
      const results = await client.searchPattern({
        pattern: args.pattern,
        projects: applyDefaultProject(args.projects, config),
        fileType: args.file_type,
        maxResults: args.max_results,
        cursor: args.cursor,
      });
      const fmt = selectFormat("search", args.response_format as ResponseFormat | undefined);
      const maxBytes = getMaxResponseBytes();
      return pickSearchFormatter(fmt, maxBytes)(results);
    }

    case "opengrok_get_file_content": {
      const args = GetFileContentArgs.parse(rawArgs);
      const { text } = await executeGetFileContent(args, client, local);
      return text;
    }

    case "opengrok_get_file_history": {
      const args = GetFileHistoryArgs.parse(rawArgs);
      const history = await client.getFileHistory(
        args.project,
        args.path,
        args.max_entries,
        args.start_index ?? 0,
        args.cursor
      );
      return formatFileHistory(history);
    }

    case "opengrok_browse_directory": {
      const args = BrowseDirectoryArgs.parse(rawArgs);
      return executeBrowseDirectory(args, client);
    }

    case "opengrok_list_projects": {
      const args = ListProjectsArgs.parse(rawArgs);
      const { text } = await executeListProjects(args, client);
      return text;
    }

    case "opengrok_get_file_annotate": {
      const args = GetFileAnnotateArgs.parse(rawArgs);
      return executeGetFileAnnotate(args, client);
    }

    case "opengrok_search_suggest": {
      const args = SearchSuggestArgs.parse(rawArgs);
      return executeSearchSuggest(args, client);
    }

    case "opengrok_batch_search": {
      const args = BatchSearchArgs.parse(rawArgs);
      const { text } = await executeBatchSearch(args, client, config);
      return text;
    }

    case "opengrok_search_and_read":
      // rawArgs are unvalidated here — parse is required. Unlike the registered MCP handler
      // (which receives args already validated by the SDK), dispatchTool is the legacy test
      // path and receives raw Record<string, unknown>.
      return handleSearchAndRead(SearchAndReadArgs.parse(rawArgs), client, config);

    case "opengrok_get_symbol_context": {
      const { text } = await handleGetSymbolContextStructured(rawArgs, client, config);
      return text;
    }

    case "opengrok_index_health": {
      const args = IndexHealthArgs.parse(rawArgs);
      const format = selectFormat("generic", args.response_format);
      
      const start = Date.now();
      const ok = await client.testConnection();
      const latencyMs = Date.now() - start;

      // Collect project count and any warnings
      let indexedProjects = 0;
      const warnings: string[] = [];

      try {
        const projects = await client.listProjects();
        indexedProjects = projects.length;
      } catch {
        // err intentionally unused
        warnings.push("Could not retrieve project list");
      }

      // dispatchTool is a stateless test/legacy path — latency trend requires the
      // module-level tracker in registerLegacyTools, so always report "first_check" here.
      const latencyTrend: "stable" | "increasing" | "first_check" = "first_check";
      let stalenessScore: "healthy" | "possibly_stale" | "likely_stale" = "healthy";
      
      // Staleness heuristics:
      // 1. High latency (>500ms) suggests server load or indexing activity
      // 2. Increasing latency trend suggests growing load
      // 3. No projects indexed suggests potential issue
      if (latencyMs > 500) {
        stalenessScore = "possibly_stale";
      }
      if (indexedProjects === 0 && ok) {
        warnings.push("No projects indexed");
        stalenessScore = "possibly_stale";
      }
      
      if (ok) {
        client.warmCache();
      }

      const serverVersion = ok && typeof client.getServerVersion === "function"
        ? await client.getServerVersion().catch(() => null) ?? undefined
        : undefined;
      const suggestConfig = ok && typeof client.getSuggestConfig === "function"
        ? await client.getSuggestConfig().catch(() => null) ?? undefined
        : undefined;

      const message = ok
        ? `OpenGrok: connected (${latencyMs}ms, ${indexedProjects} projects, staleness: ${stalenessScore})`
        : "OpenGrok: connection failed";

      // Construct the result object
      const health = {
        connected: ok,
        latencyMs,
        indexedProjects,
        latencyTrend,
        stalenessScore,
        warnings,
        message,
        ...(serverVersion != null ? { serverVersion } : {}),
        ...(suggestConfig != null ? { suggestConfig } : {}),
      };
      
      // Format the response
      if (format === "json") {
        return JSON.stringify(health, null, 2);
      } else if (format === "yaml") {
        const yamlLines = [
          `connected: ${health.connected}`,
          `latencyMs: ${health.latencyMs}`,
          `indexedProjects: ${health.indexedProjects}`,
          `latencyTrend: ${health.latencyTrend}`,
          `stalenessScore: ${health.stalenessScore}`,
          ...(serverVersion != null ? [`serverVersion: ${serverVersion}`] : []),
          ...(health.suggestConfig != null ? [`suggestConfig:\n  enabled: ${health.suggestConfig.enabled}\n  maxResults: ${health.suggestConfig.maxResults}`] : []),
          ...(health.warnings.length > 0
            ? [`warnings:\n${health.warnings.map((w) => `  - ${w}`).join("\n")}`]
            : []),
        ];
        return yamlLines.join("\n");
      } else {
        // markdown or text (default)
        const markdown = [
          "# OpenGrok Health",
          "",
          `- **Connected:** ${health.connected}`,
          `- **Latency:** ${health.latencyMs}ms`,
          `- **Indexed projects:** ${health.indexedProjects}`,
          `- **Latency trend:** ${health.latencyTrend}`,
          `- **Staleness:** ${health.stalenessScore}`,
          ...(serverVersion != null ? [`- **Server version:** ${serverVersion}`] : []),
          ...(health.suggestConfig != null ? [`- **Suggest config:** enabled=${health.suggestConfig.enabled}, maxResults=${health.suggestConfig.maxResults}`] : []),
          ...(health.warnings.length > 0
            ? [`- **Warnings:** ${health.warnings.join(", ")}`]
            : []),
        ].join("\n");
        return markdown;
      }
    }

    case "opengrok_get_compile_info":
      return handleGetCompileInfo(rawArgs, config, local);

    case "opengrok_get_file_symbols": {
      const args = GetFileSymbolsArgs.parse(rawArgs);
      const result = await client.getFileSymbols(args.project, args.path, { cursor: args.cursor });
      if (!result.symbols.length) {
        return `No symbols found for ${args.path} in project ${args.project}. The file may not be indexed or the OpenGrok instance does not support the /api/v1/file/defs endpoint.`;
      }
      return formatFileSymbols(result);
    }

    case "opengrok_what_changed": {
      const args = WhatChangedArgs.parse(rawArgs);
      const [history, annotation] = await Promise.all([
        client.getFileHistory(args.project, args.path),
        client.getAnnotate(args.project, args.path),
      ]);
      return formatWhatChanged(history, annotation, args.since_days);
    }

    case "opengrok_dependency_map": {
      const args = DependencyMapArgs.parse(rawArgs);
      const bg = typeof client.createBackgroundClient === "function"
        ? client.createBackgroundClient()
        : undefined;
      try {
        const nodes = await buildDependencyGraph(client, args.project, args.path, args.depth, args.direction, bg);
        return formatDependencyMap(args.path, args.depth, nodes);
      } finally {
        await bg?.close().catch(() => undefined);
      }
    }

    case "opengrok_blame": {
      const args = BlameArgs.parse(rawArgs);
      const annotated = await client.getAnnotate(args.project, args.path);
      return formatBlame(annotated, args.line_start, args.line_end, args.include_diff);
    }

    case "opengrok_get_all_matches": {
      const args = GetAllMatchesArgs.parse(rawArgs);
      const matches = await client.getAllMatchesInFile(args.project, args.path, args.query, args.search_type, args.max_results);
      return formatMoreResults(matches, args.project, args.path);
    }

    case "opengrok_get_file_history_with_files": {
      const args = GetFileHistoryWithFilesArgs.parse(rawArgs);
      const result = await client.getFileHistoryWithFiles(args.project, args.path, { maxEntries: args.max_entries });
      return formatRssHistory(result.entries, args.project, args.path);
    }

    case "opengrok_get_download_url": {
      const args = GetDownloadUrlArgs.parse(rawArgs);
      return client.getDownloadUrl(args.project, args.path);
    }

    case "opengrok_list_groups": {
      const groups = await client.getProjectGroups();
      if (!groups.length) {
        return "No groups available (admin auth may be required on this server).";
      }
      return groups.map((g) => `${g.name}: [${g.projects.join(", ")}]`).join("\n");
    }

    case "opengrok_get_suggest_popularity": {
      const args = GetSuggestPopularityArgs.parse(rawArgs);
      const items = await client.getSuggestPopularity({ project: args.project, field: args.field, pageSize: args.page_size });
      if (!items.length) {
        return "No popularity data available (admin auth may be required).";
      }
      return items.join("\n");
    }

    case "opengrok_get_project_repositories": {
      const args = GetProjectRepositoriesArgs.parse(rawArgs);
      const repos = await client.getProjectRepositories(args.project);
      if (!repos.length) {
        return "No repositories available (admin auth may be required).";
      }
      return repos.map((r) => `url: ${r.url}, type: ${r.type}`).join("\n");
    }

    default:
      return `**Error:** Unknown tool: "${name}"`;
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Server factory — McpServer with per-tool registrations
// ---------------------------------------------------------------------------


/**
 * Build a safe xref URI for resource_link content items.
 * Each path segment is percent-encoded to handle spaces and special chars.
 */
export function buildXrefUri(baseUrl: string, project: string, filePath: string): string {
  // Strip any trailing slash from baseUrl to prevent double-slash in the URI
  // (e.g. "https://host/" + "/xref/..." → "https://host//xref/..." is invalid).
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const encodedProject = encodeURIComponent(project);
  const encodedPath = filePath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `${normalizedBase}/xref/${encodedProject}${encodedPath}`;
}

/**
 * Build a dependency graph for a file by searching up to `depth` levels.
 * "uses"    — finds files that this file imports/includes: reads the target file's
 *             content, extracts import/include/require directives, then searches by
 *             path for each imported module name to find indexed files.
 * "used_by" — finds files that reference/call symbols from this file (refs search by filename).
 *
 * Delegates to the tree-sitter-aware implementation in intelligence.ts.
 *
 * @param backgroundClient — optional client for background fan-out searches.
 *   Falls back to the main client when absent.
 */
export async function buildDependencyGraph(
  client: OpenGrokClient,
  project: string,
  filePath: string,
  depth: number,
  direction: "uses" | "used_by" | "both",
  backgroundClient?: OpenGrokClient
): Promise<DependencyNode[]> {
  return buildDependencyGraphIntel(client, project, filePath, depth, direction, backgroundClient);
}
