/**
 * Server-side intelligence: pre-computed file overviews and call chains.
 * These functions run on the host process and produce structured summaries
 * that the sandbox code (Code Mode) can request via the API object,
 * avoiding expensive multi-step LLM round trips.
 *
 * Design decisions:
 * - buildCallChain traces callees using tree-sitter AST analysis for supported
 *   languages (C/C++, TypeScript, JavaScript, …). Returns empty callees for
 *   unsupported languages.
 * - getEnclosingFunction requires a non-empty project string (caller must supply it).
 * - buildSymbolTree falls back to next symbol's startLine - 1 when endLine is missing (symbols from
 *   OpenGrok sometimes lack line-end information).
 * - Max traversal depth is capped at 4 to prevent runaway recursion.
 */

import type { OpenGrokClient } from "./client/index.js";
import type {
  CallChainAPIResult,
  CallNode,
  FileOverviewAPIResult,
} from "./utils/api-types.js";
import { extractCallees } from "./intelligence/callee-extractor.js";
import { isLanguageSupported } from "./intelligence/tree-sitter.js";
import { extractSignatures, type SymbolInfo } from "./intelligence/ast-truncation.js";
import { extractImportsTreeSitter } from "./intelligence/import-extractor.js";

// ---------------------------------------------------------------------------
// Tree-sitter line budget (scales with the active context tier)
// ---------------------------------------------------------------------------

/** Line budget for tree-sitter truncation/expansion, scaled to the active context tier. */
export function getTreeSitterLineBudget(): number {
  const tier = process.env.OPENGROK_CONTEXT_BUDGET?.toLowerCase();
  if (tier === "minimal") return 200;
  if (tier === "generous") return 600;
  return 400; // standard default
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Count path segments shared between two paths (directory proximity score).
 * Higher = closer. Used to prefer nearby definitions over global matches.
 */
export function commonPrefixSegments(a: string, b: string): number {
  const partsA = a.split("/");
  const partsB = b.split("/");
  let i = 0;
  while (i < partsA.length && i < partsB.length && partsA[i] === partsB[i]) i++;
  return i;
}

// ---------------------------------------------------------------------------
// File overview
// ---------------------------------------------------------------------------

/**
 * Build a compact file overview combining symbols, recent history, and imports.
 * Uses parallel requests for efficiency.
 */
export async function buildFileOverview(
  client: OpenGrokClient,
  project: string,
  filePath: string
): Promise<FileOverviewAPIResult> {
  const lang = langFromPath(filePath);

  // Parallel: symbols + file head (for import extraction) + history
  const [symbolsResult, headContent, historyResult] = await Promise.allSettled([
    client.getFileSymbols(project, filePath),
    client.getFileContent(project, filePath, 1, 60),
    client.getFileHistory(project, filePath, 3),
  ]);

  const allFailed = [symbolsResult, headContent, historyResult]
    .every(r => r.status === "rejected");
  if (allFailed) {
    // Extract the most informative error message from the rejections
    const firstError = [symbolsResult, headContent, historyResult]
      .find(r => r.status === "rejected") as PromiseRejectedResult;
    const msg = firstError?.reason instanceof Error ? firstError.reason.message : "all requests failed";
    throw new Error(`getFileOverview: project '${project}', path '${filePath}' — ${msg}`);
  }

  const symbols =
    symbolsResult.status === "fulfilled" ? symbolsResult.value.symbols : [];
  const headText =
    headContent.status === "fulfilled" ? headContent.value.content : "";
  const history =
    historyResult.status === "fulfilled" ? historyResult.value.entries : [];

  const imports = await extractImportsForOverview(headText, lang);
  const recentAuthors = [
    ...new Set(history.map((h) => h.author.split("<")[0].trim())),
  ].slice(0, 3);
  const lastRevision = history[0]?.revision.slice(0, 8) ?? "unknown";

  // Compute total line count and size from the head result
  const sizeLines =
    headContent.status === "fulfilled" ? headContent.value.lineCount : 0;
  const sizeBytes =
    headContent.status === "fulfilled" ? headContent.value.sizeBytes : 0;

  // Use tree-sitter for accurate symbol line numbers when language is supported.
  // The 60-line head fetch is only for import extraction; the full file is fetched
  // separately for AST analysis so all symbols across the file are included.
  let topLevelSymbols: FileOverviewAPIResult["topLevelSymbols"];
  if (isLanguageSupported(lang)) {
    try {
      let contentForAst = headContent.status === "fulfilled" ? headContent.value.content : "";
      const headLineCount = headContent.status === "fulfilled" ? headContent.value.lineCount : 0;
      if (headLineCount > 60) {
        try {
          // getFileContent always fetches the full file and caches it — no line limit
          // means tree-sitter sees all symbols, not just the first 60.
          const full = await client.getFileContent(project, filePath);
          contentForAst = full.content;
        } catch { /* use 60-line head */ }
      }
      const tsSymbols = await extractSignatures(contentForAst, lang);
      const ogTree = buildSymbolTree(symbols);
      if (tsSymbols && tsSymbols.length > 0) {
        const tsTree = buildSymbolTreeFromAst(tsSymbols);
        // Prefer the richer result. If tree-sitter partially failed (e.g. ERROR nodes from
        // C++ macros, or MAX_FILE_SIZE exceeded), OpenGrok may have more complete coverage.
        topLevelSymbols = tsTree.length >= ogTree.length ? tsTree : ogTree;
      } else {
        topLevelSymbols = ogTree;
      }
    } catch {
      topLevelSymbols = buildSymbolTree(symbols);
    }
  } else {
    topLevelSymbols = buildSymbolTree(symbols);
  }

  return {
    project,
    path: filePath,
    lang,
    sizeLines,
    sizeBytes,
    imports,
    topLevelSymbols,
    recentAuthors,
    lastRevision,
  };
}

// ---------------------------------------------------------------------------
// Call chain
// ---------------------------------------------------------------------------

const MAX_CALL_CHAIN_DEPTH = 4;

/**
 * Maximum total recursive search calls allowed in a single buildCallChain invocation.
 * Without this cap, worst-case fan-out at depth=4 is 10×3×10×3×10×3×10×3 = 810,000 searches.
 * The cap limits actual API requests to a predictable budget.
 */
const MAX_CALL_CHAIN_SEARCH_BUDGET = 50;

/**
 * Compute the longest common directory prefix from a set of file paths.
 * Returns at least 2 path segments (e.g. "/src/module/") to avoid over-broad scopes.
 * Returns undefined if no meaningful prefix can be derived (fewer than 2 paths or too shallow).
 */
function computePathScope(paths: string[]): string | undefined {
  if (paths.length < 2) return undefined;
  const segments = paths.map(p => p.split("/").filter(Boolean));
  const minLen = Math.min(...segments.map(s => s.length));
  let commonDepth = 0;
  for (let i = 0; i < minLen; i++) {
    if (segments.every(s => s[i] === segments[0][i])) commonDepth = i + 1;
    else break;
  }
  // Require at least 2 directory segments for a meaningful scope
  if (commonDepth < 2) return undefined;
  // Leading slash is required: search-result paths are absolute and
  // callers compare with startsWith. Do not strip it.
  return "/" + segments[0].slice(0, commonDepth).join("/") + "/";
}

/** Extensions recognised as source code for call-chain filtering. */
export const SOURCE_CODE_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx",
  ".java", ".py", ".js", ".jsx", ".ts", ".tsx",
  ".go", ".rs", ".rb", ".cs", ".swift", ".kt", ".kts",
  ".scala", ".m", ".mm", ".pl", ".pm", ".sh", ".bash",
  ".lua", ".r", ".php", ".ex", ".exs", ".erl", ".hs",
]);

/**
 * Map file extensions to OpenGrok file type filter values.
 * Used to auto-infer language family for deeper call chain levels,
 * preventing cross-language false positives.
 */
const LANG_FAMILY_MAP = new Map<string, string>([
  [".c", "c"], [".cc", "c++"], [".cpp", "c++"], [".cxx", "c++"],
  [".h", "c++"], [".hpp", "c++"], [".hxx", "c++"],
  [".java", "java"],
  [".py", "python"],
  [".js", "javascript"], [".jsx", "javascript"], [".ts", "typescript"], [".tsx", "typescript"],
  [".go", "golang"],
  [".rs", "rust"],
  [".cs", "csharp"],
]);

/**
 * Trace callers and/or callees of a symbol up to MAX_CALL_CHAIN_DEPTH.
 *
 * Callers: uses OpenGrok refs search to find call sites.
 * Callees: uses tree-sitter AST analysis for supported languages.
 */
export async function buildCallChain(
  client: OpenGrokClient,
  symbol: string,
  direction: "callers" | "callees" | "both",
  depth: number,
  project?: string,
  fileType?: string
): Promise<CallChainAPIResult> {
  const cappedDepth = Math.min(depth, MAX_CALL_CHAIN_DEPTH);

  // Shared mutable budget counter — passed by reference through recursion so
  // all branches share the same call budget and total searches are bounded.
  const searchBudget = { remaining: MAX_CALL_CHAIN_SEARCH_BUDGET };

  const callers: CallNode[] =
    direction === "callees"
      ? []
      : await traceCallChain(client, symbol, cappedDepth, cappedDepth, project, new Set(), new Map(), searchBudget, fileType, undefined);

  // Callees: trace what this function calls using tree-sitter AST analysis
  const callees: CallNode[] =
    direction === "callers"
      ? []
      : await traceCallees(client, symbol, cappedDepth, cappedDepth, project, new Set(), searchBudget);

  let truncatedAt: number | undefined;
  if (cappedDepth < depth) {
    truncatedAt = cappedDepth;
  }

  // If nothing was found and budget wasn't exhausted, check defs to:
  // 1. Distinguish "symbol has no callers" from "symbol not in index" (found field)
  // 2. Determine if the language is unsupported (calleesNote field)
  let found: boolean | undefined;
  let calleesNote: string | undefined;
  const calleesRequested = direction === "callees" || direction === "both";
  if ((callers.length === 0 && callees.length === 0 && searchBudget.remaining > 0) ||
      (calleesRequested && callees.length === 0)) {
    try {
      const projects = project !== undefined && project !== "" ? [project] : undefined;
      const defsResult = await client.search(symbol, "defs", projects, 1);
      found = defsResult.results.length > 0;
      if (calleesRequested && callees.length === 0 && found) {
        const defPath = defsResult.results[0]?.path ?? "";
        const lang = langFromPath(defPath);
        if (!isLanguageSupported(lang)) {
          calleesNote = `Callees not available — tree-sitter does not support ${lang || "this language"}.`;
        } else {
          calleesNote = "Leaf function — no callees found.";
        }
      }
    } catch { /* best-effort */ }
  }

  return {
    symbol,
    direction,
    callers,
    callees,
    truncatedAt,
    ...(calleesNote ? { calleesNote } : {}),
    budgetExhausted: searchBudget.remaining <= 0,
    ...(found === false ? { found: false, error: `Symbol '${symbol}' not found in the index` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

export interface DependencyGraphNode {
  path: string;
  level: number;
  direction: "uses" | "used_by";
}

const DEPENDENCY_GRAPH_MAX_NODES = 50;

/**
 * Build a dependency graph for a file by searching up to `depth` levels.
 * "uses"    — finds files that this file imports/includes: reads the target file's
 *             content, extracts import/include/require directives, then searches by
 *             path for each imported module name to find indexed files.
 * "used_by" — finds files that reference/call symbols from this file (refs search by filename).
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
): Promise<DependencyGraphNode[]> {
  const bg = backgroundClient ?? client;
  const nodes: DependencyGraphNode[] = [];
  const seenUsesPaths = new Set<string>();
  const seenUsedByPaths = new Set<string>();

  const rootName = filePath.split("/").pop() ?? "";

  // "uses" direction: find files this file imports/includes via BFS.
  // For each frontier file: fetch its content, extract import/include statements,
  // then search by path for each imported name to find the actual indexed files.
  if (direction === "uses" || direction === "both") {
    let frontier: string[] = [filePath];
    const expandedUses = new Set<string>();

    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      if (seenUsesPaths.size >= DEPENDENCY_GRAPH_MAX_NODES) break;
      const toExpand = frontier.filter((p) => !expandedUses.has(p));
      toExpand.forEach((p) => expandedUses.add(p));
      frontier = [];

      if (toExpand.length === 0) break;

      // Fetch full file content — imports can appear anywhere in the file.
      const contentResults = await Promise.all(
        toExpand.map((currentPath) =>
          bg.getFileContent(project, currentPath).catch(() => null)
        )
      );

      // For each file, extract its imports and search for them by path
      const searchPromises: Promise<void>[] = [];
      for (let i = 0; i < toExpand.length; i++) {
        const contentResult = contentResults[i];
        if (!contentResult) continue;

        const lang = langFromPath(toExpand[i]);
        const imports = await extractImportsForOverview(contentResult.content, lang);
        if (imports.length === 0) continue;

        for (const imp of imports) {
          // Use the leaf filename stem (no extension) as the path search term
          const leaf = imp.split("/").pop() ?? imp;
          const stem = leaf.includes(".") ? leaf.slice(0, leaf.lastIndexOf(".")) : leaf;
          if (!stem) continue;

          searchPromises.push(
            bg.search(stem, "path", [project], 10)
              .then((results) => {
                for (const r of results.results) {
                  if (r.path === filePath) continue;
                  if (!seenUsesPaths.has(r.path)) {
                    if (seenUsesPaths.size >= DEPENDENCY_GRAPH_MAX_NODES) return;
                    seenUsesPaths.add(r.path);
                    nodes.push({ path: r.path, level, direction: "uses" });
                  }
                  if (level < depth && !expandedUses.has(r.path)) frontier.push(r.path);
                }
              })
              .catch(() => { /* ignore individual search errors */ })
          );
        }
      }

      await Promise.all(searchPromises);
    }
  }

  // "used_by" direction: level-parallel BFS — find files that reference this file's symbols.
  if (direction === "used_by" || direction === "both") {
    let frontier: string[] = [rootName];
    const expandedUsedBy = new Set<string>();

    outerLoop: for (let level = 1; level <= depth && frontier.length > 0; level++) {
      if (seenUsedByPaths.size >= DEPENDENCY_GRAPH_MAX_NODES) break;
      const toExpand = frontier.filter((n) => !expandedUsedBy.has(n));
      toExpand.forEach((n) => expandedUsedBy.add(n));
      frontier = [];

      if (toExpand.length === 0) break;

      // Issue all searches at this BFS level in parallel
      const levelResults = await Promise.all(
        toExpand.map((filename) =>
          bg.search(filename, "refs", [project], 20)
        )
      );

      for (const results of levelResults) {
        for (const r of results.results) {
          if (r.path === filePath) continue;
          const rName = r.path.split("/").pop() ?? "";
          if (!seenUsedByPaths.has(r.path)) {
            if (seenUsedByPaths.size >= DEPENDENCY_GRAPH_MAX_NODES) break outerLoop;
            seenUsedByPaths.add(r.path);
            nodes.push({ path: r.path, level, direction: "used_by" });
          }
          if (level < depth && !expandedUsedBy.has(rName)) frontier.push(rName);
        }
      }
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function traceCallChain(
  client: OpenGrokClient,
  symbol: string,
  depth: number,
  maxDepth: number,
  project: string | undefined,
  visited: Set<string>,
  symbolsCache: Map<string, import("./models.js").FileSymbols> = new Map(),
  searchBudget: { remaining: number } = { remaining: MAX_CALL_CHAIN_SEARCH_BUDGET },
  fileType?: string,
  pathScope?: string
): Promise<CallNode[]> {
  // Enforce the total search budget across all recursive branches.
  if (searchBudget.remaining <= 0) {
    return [];
  }
  searchBudget.remaining--;

  const projects = project !== undefined && project !== "" ? [project] : undefined;
  let searchResult;
  try {
    // Limit search to same language family, reducing cross-language false positives at depth > 1
    searchResult = await client.search(symbol, "refs", projects, 10, 0, fileType);
  } catch {
    return [];
  }

  const nodes: CallNode[] = [];

  // At the top level (depth === maxDepth), auto-infer file type
  // from the first result's extension if not explicitly provided.
  // This prevents cross-language noise at deeper recursive levels.
  let inferredFileType = fileType;
  if (!inferredFileType && depth === maxDepth && searchResult.results.length > 0) {
    const firstExt = searchResult.results[0].path.slice(searchResult.results[0].path.lastIndexOf(".")).toLowerCase();
    inferredFileType = LANG_FAMILY_MAP.get(firstExt);
  }

  // At the top level, derive a path scope from all depth-1
  // result paths. This scope is passed to recursive calls to filter out matches
  // from vendored libraries that share the same language but are unrelated
  // to the application code.
  let derivedPathScope = pathScope;
  if (!derivedPathScope && depth === maxDepth && searchResult.results.length >= 2) {
    derivedPathScope = computePathScope(searchResult.results.map(r => r.path));
  }

  for (const result of searchResult.results) {
    // Skip non-source-code files (Makefile, .md, .xml, .txt, .rst, etc.)
    const dotIdx = result.path.lastIndexOf(".");
    if (dotIdx < 0 || !SOURCE_CODE_EXTS.has(result.path.slice(dotIdx).toLowerCase())) continue;

    // At depth-2+, filter results outside the derived path scope
    if (derivedPathScope && depth < maxDepth && !result.path.startsWith(derivedPathScope)) continue;

    for (const match of result.matches.slice(0, 3)) {
      const enclosing = await getEnclosingFunction(
        client,
        result.project,
        result.path,
        match.lineNumber,
        symbolsCache
      );
      const callerSym = enclosing?.symbol ?? null;

      // Skip header-file declarations: a null enclosing function in a .h/.hpp/.hxx
      // file is almost always the declaration line of the symbol itself, not a call site.
      if (!callerSym && /\.(h|hpp|hxx)$/i.test(result.path)) continue;

      // Skip refs where the enclosing symbol is a class or struct — the ref is inside
      // a class declaration body (e.g. a method declaration), not an actual call site.
      if (enclosing && (enclosing.type === "class" || enclosing.type === "struct")) continue;

      // Skip self-references: the function's own definition line shows up in refs
      // with callerSym === symbol, which is not a meaningful caller.
      if (callerSym === symbol) continue;

      const node: CallNode = {
        symbol: callerSym ?? `${result.path}:${match.lineNumber}`,
        path: result.path,
        project: result.project,
        line: match.lineNumber,
        depth: maxDepth - depth + 1,
      };
      nodes.push(node);

      const callerKey = `${result.path}:${callerSym}`;
      if (callerSym && depth > 1 && !visited.has(callerKey) && searchBudget.remaining > 0) {
        visited.add(callerKey);
        const subCallers = await traceCallChain(
          client,
          callerSym,
          depth - 1,
          maxDepth,
          project,
          visited,
          symbolsCache,
          searchBudget,
          inferredFileType,
          derivedPathScope
        );
        nodes.push(...subCallers);
      }
    }
  }

  return nodes;
}

/**
 * Trace callees of a symbol using tree-sitter AST analysis.
 * 1. Find the symbol's definition file via "defs" search
 * 2. Fetch file content and parse with tree-sitter
 * 3. Extract function calls within the body
 * 4. For each callee, resolve to a file via "defs" search
 * 5. Recurse to requested depth
 */
async function traceCallees(
  client: OpenGrokClient,
  symbol: string,
  depth: number,
  maxDepth: number,
  project: string | undefined,
  visited: Set<string>,
  searchBudget: { remaining: number },
  pathScope?: string  // at depth<maxDepth, restricts resolution to paths sharing this prefix
): Promise<CallNode[]> {
  // Require at least 2 budget units: 1 for defs search + 1 for file content fetch.
  if (depth <= 0 || searchBudget.remaining < 2) return [];
  searchBudget.remaining--;

  // Step 1: Find the symbol's definition
  const projects = project !== undefined && project !== "" ? [project] : undefined;
  let defsResult;
  try {
    defsResult = await client.search(symbol, "defs", projects, 5);
  } catch {
    return [];
  }

  if (defsResult.results.length === 0) return [];

  const defResult = defsResult.results[0];

  // Use path-qualified key so same-named symbols in different files are treated
  // as distinct, while still breaking cycles (A→B→A terminates on the second A).
  const qualifiedKey = `${defResult.path}:${symbol}`;
  if (visited.has(qualifiedKey)) return [];
  visited.add(qualifiedKey);

  const lang = langFromPath(defResult.path);

  // Check if language is supported by tree-sitter
  if (!isLanguageSupported(lang)) return [];

  // Step 2: Fetch full file content for callee extraction.
  // getFileContent always downloads the full file and caches it — no line limit needed.
  searchBudget.remaining--;
  let fileContent;
  try {
    fileContent = await client.getFileContent(defResult.project, defResult.path);
  } catch {
    return [];
  }

  // Step 3: Extract callees using tree-sitter
  const source = fileContent?.content;
  if (!source) return [];
  const calleeInfos = await extractCallees(source, symbol, lang);
  if (calleeInfos.length === 0) return [];

  const nodes: CallNode[] = [];

  // Step 4: Resolve each callee to a file
  for (const callee of calleeInfos) {
    if (searchBudget.remaining <= 0) break;
    searchBudget.remaining--;

    let calleeResult;
    try {
      calleeResult = await client.search(callee.name, "defs", projects, 3);
    } catch {
      continue;
    }

    if (calleeResult.results.length === 0) {
      // Unresolved callee — add with current file context
      nodes.push({
        symbol: callee.name,
        path: defResult.path,
        project: defResult.project,
        line: callee.line,
        depth: maxDepth - depth + 1,
      });
      continue;
    }

    // Rank defs candidates by proximity to the calling file.
    // Global defs searches for common names return results from unrelated
    // libraries. Pick the closest candidate; if none share enough path
    // segments with the caller, treat as unresolved.
    const callerSegments = defResult.path.split("/").length;
    const minProximity = Math.max(3, callerSegments - 2);
    const ranked = calleeResult.results
      .map(r => ({ r, score: commonPrefixSegments(r.path, defResult.path) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < minProximity) {
      // No nearby definition — treat as unresolved (standard/external function)
      nodes.push({
        symbol: callee.name,
        path: defResult.path,
        project: defResult.project,
        line: callee.line,
        depth: maxDepth - depth + 1,
      });
      continue;
    }
    const resolved = best.r;
    // At depth < maxDepth, also enforce pathScope to prevent drift into
    // unrelated modules during deep recursion.
    if (pathScope && !resolved.path.startsWith(pathScope)) {
      nodes.push({
        symbol: callee.name,
        path: defResult.path,
        project: defResult.project,
        line: callee.line,
        depth: maxDepth - depth + 1,
      });
      continue;
    }

    const resolvedPath = resolved.path;  // captured before any further awaits
    nodes.push({
      symbol: callee.name,
      path: resolvedPath,
      project: resolved.project,
      line: resolved.matches[0]?.lineNumber ?? 0,
      depth: maxDepth - depth + 1,
    });

    // Recurse for deeper levels — derive pathScope from depth-1 resolved paths
    // to prevent depth-2+ from drifting outside the original module.
    if (depth > 1 && !visited.has(`${resolvedPath}:${callee.name}`) && searchBudget.remaining > 0) {
      let derivedScope = pathScope;
      if (!derivedScope && depth === maxDepth) {
        // Collect all resolved callee paths to compute the common module prefix
        const resolvedPaths = nodes.filter(n => n.path !== defResult.path).map(n => n.path);
        if (resolvedPaths.length >= 2) {
          derivedScope = computePathScope(resolvedPaths) ?? undefined;
        }
      }
      const subCallees = await traceCallees(
        client, callee.name, depth - 1, maxDepth, project, visited, searchBudget, derivedScope
      );
      nodes.push(...subCallees);
    }
  }

  return nodes;
}

/**
 * Find the symbol that encloses a given line number in a file.
 * Requires a non-empty project string.
 */
async function getEnclosingFunction(
  client: OpenGrokClient,
  project: string,
  filePath: string,
  lineNumber: number,
  symbolsCache: Map<string, import("./models.js").FileSymbols> = new Map()
): Promise<{ symbol: string; type: string } | null> {
  if (!project) return null;

  const cacheKey = `${project}:${filePath}`;
  let symbols = symbolsCache.get(cacheKey);
  if (!symbols) {
    try {
      symbols = await client.getFileSymbols(project, filePath);
      symbolsCache.set(cacheKey, symbols);
    } catch {
      return null;
    }
  }

  // Find symbol whose range encloses the target line
  let best: { symbol: string; type: string; lineStart: number; lineEnd: number } | null = null;

  // Sort symbols by start line for implicit boundary calculation
  const sorted = [...symbols.symbols].sort((a, b) => (a.lineStart ?? a.line) - (b.lineStart ?? b.line));

  for (let i = 0; i < sorted.length; i++) {
    const sym = sorted[i];
    const start = sym.lineStart ?? sym.line;
    // Fall back to next symbol's startLine - 1 when endLine is missing;
    // for the last symbol, use Infinity.
    const end = sym.lineEnd ?? (sorted[i + 1] ? (sorted[i + 1].lineStart ?? sorted[i + 1].line) - 1 : Infinity);

    if (start <= lineNumber && lineNumber <= end) {
      // Prefer the smallest enclosing range (most specific function)
      if (!best || end - start < best.lineEnd - best.lineStart) {
        best = { symbol: sym.symbol, type: sym.type, lineStart: start, lineEnd: end };
      }
    }
  }

  return best ? { symbol: best.symbol, type: best.type } : null;
}

/**
 * Build a hierarchical symbol tree from flat symbols array.
 * Falls back to next symbol's startLine - 1 when endLine is absent.
 */
export function buildSymbolTree(
  symbols: Array<{
    symbol: string;
    type: string;
    line: number;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    namespace: string | null;
  }>
): FileOverviewAPIResult["topLevelSymbols"] {
  // Sort by line number
  const sorted = [...symbols].sort(
    (a, b) => (a.lineStart ?? a.line) - (b.lineStart ?? b.line)
  );

  // Effective end lines: fall back to the next symbol's startLine - 1 when
  // endLine is missing; a trailing symbol without endLine is a single line.
  const effEnd = sorted.map((sym, i) => {
    if (sym.lineEnd) return sym.lineEnd;
    const start = sym.lineStart ?? sym.line;
    const next = sorted[i + 1];
    const nextStart = next ? (next.lineStart ?? next.line) : undefined;
    return nextStart !== undefined && nextStart > start ? nextStart - 1 : start;
  });

  const topLevel: FileOverviewAPIResult["topLevelSymbols"] = [];
  const topEnd: number[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const sym = sorted[i];
    const symLine = sym.lineStart ?? sym.line;

    // Check if this symbol is enclosed by a top-level symbol
    let isChild = false;
    for (let t = 0; t < topLevel.length; t++) {
      const top = topLevel[t];
      if (symLine > top.line && symLine <= topEnd[t]) {
        if (!top.children) top.children = [];
        top.children.push({ symbol: sym.symbol, type: sym.type, line: symLine });
        isChild = true;
        break;
      }
    }

    if (!isChild) {
      topLevel.push({
        symbol: sym.symbol,
        type: sym.type,
        line: symLine,
        endLine: effEnd[i] !== symLine ? effEnd[i] : undefined,
        children: undefined,
      });
      topEnd.push(effEnd[i]);
    }
  }

  return topLevel;
}

/**
 * Build topLevelSymbols entries from tree-sitter AST symbol info.
 */
export function buildSymbolTreeFromAst(
  symbols: SymbolInfo[]
): FileOverviewAPIResult["topLevelSymbols"] {
  return symbols.map(s => ({
    symbol: s.name,
    type: s.kind,
    line: s.startLine,
    endLine: s.endLine !== s.startLine ? s.endLine : undefined,
    children: undefined,
  }));
}

/**
 * Extract import/include statements from file header text.
 * Prefers tree-sitter AST extraction for supported languages; falls back to regex.
 */
async function extractImportsForOverview(text: string, lang: string): Promise<string[]> {
  if (isLanguageSupported(lang)) {
    try {
      const tsImports = await extractImportsTreeSitter(text, lang);
      if (tsImports.length > 0) {
        return [...new Set(tsImports.map((imp) => imp.specifier))].slice(0, 20);
      }
    } catch { /* fall through to regex */ }
  }
  return extractImports(text, lang);
}

/**
 * Extract import/include statements from file header text.
 */
export function extractImports(text: string, lang: string): string[] {
  const imports: string[] = [];

  if (lang === "cpp" || lang === "c") {
    // C/C++: #include "..." or <...>
    const matches = text.matchAll(/#include\s+["<]([^">]+)[">]/g);
    for (const m of matches) {
      if (m[1]) imports.push(m[1]);
    }
  } else {
    // Generic: import / require / from statements
    const matches = text.matchAll(/(?:import|require|from)\s+["'`]([^"'`]+)["'`]/g);
    for (const m of matches) {
      if (m[1]) imports.push(m[1]);
    }
  }

  return [...new Set(imports)].slice(0, 20);
}

const LANGUAGE_MAP: Record<string, string> = {
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  rb: "ruby",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  php: "php",
  html: "html",
  css: "css",
  scss: "scss",
  vue: "vue",
  scala: "scala",
  gradle: "groovy",
  dart: "dart",
  zig: "zig",
  lua: "lua",
  r: "r",
  m: "objc",
  mm: "objcpp",
  pl: "perl",
  pm: "perl",
  tf: "hcl",
  toml: "toml",
  ini: "ini",
  proto: "protobuf",
};

export function langFromPath(filePath: string): string {
  // Dotless filenames (Makefile, Dockerfile, etc.) have no extension — return "text"
  // instead of the full filename, which would be a bogus language tag.
  if (!filePath.includes(".")) return "text";
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  return LANGUAGE_MAP[ext] ?? ext;
}
