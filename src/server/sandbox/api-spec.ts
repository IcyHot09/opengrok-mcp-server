/**
 * API_SPEC_TS snapshot — AUTO-GENERATED from Zod schemas in ./sandbox-schemas/.
 * Run `npm run generate:spec` to regenerate. Do NOT edit manually.
 * Shape: flat globals (search, getFileContent, …); env.opengrok.* is equivalent.
 */
export const API_SPEC_TS = `\
// OpenGrok — Code search sandbox. Call methods as flat globals: search(...), getFileContent(...).
// The env.opengrok.* object form (env.opengrok.search(...)) is equivalent — use either.
// All methods are synchronous in the sandbox (the host bridges async calls).
// 'return' emits the tool result — console.log is a no-op.
// Shadowing a global (e.g., 'const search = search(...)') causes a ReferenceError at runtime.
// _truncated in any response = output cap hit; _droppedCount = items dropped; _droppedKeyNames = object keys dropped.
// Pagination: absent cursor = last page; total (when present) is the full result count. Expired/invalid cursors return {_cursorExpired:true} — reissue without cursor.
// _suggestions (on SearchResult): present when sampling is enabled.
// fileType is the lowercased analyzer class name with 'analyzer' suffix removed (e.g. CxxAnalyzer -> 'cxx').

interface SearchOpts { searchType?: 'full'|'defs'|'refs'|'symbol'|'path'|'hist'; projects?: string[]; maxResults?: number; /** Alias for maxResults */ limit?: number; startIndex?: number; /** Opaque pagination cursor from a prior call */ cursor?: string; fileType?: string; sort?: 'relevancy'|'lastmodtime'|'fullpath'; maxHitsPerFile?: number; /** directory filter — only search within this subtree */ dir?: string; /** path substring filter — only search within matching paths */ pathFilter?: string; /** single-file filter */ file?: string; /** expand each result's first match to enclosing function body (max 3 files per query; adds HTTP calls) */ expandFunction?: boolean; }
interface BatchQuery { query: string; searchType?: 'full'|'defs'|'refs'|'symbol'|'path'|'hist'; maxResults?: number; /** Alias for maxResults */ limit?: number; dir?: string; pathFilter?: string; file?: string; maxHitsPerFile?: number; /** expand each result's first match to enclosing function body (max 3 files per query; adds HTTP calls) */ expandFunction?: boolean; }
interface Match { lineNumber: number; lineContent: string; }
interface ResultItem { project: string; path: string; matches: Match[]; lastModified?: string; /** Enclosing function body when expandFunction was requested */ functionContext?: string; }
interface SearchResult { query: string; searchType: string; totalCount: number; timeMs: number; results: ResultItem[]; startIndex: number; endIndex: number; cursor?: string; _suggestions?: string[]; _truncated?: true; }
/** discriminant: '_error' in r ? handle error : '_truncated' in r ? dropped query (retry via search()) : use r.results */
interface BatchError { query: string; searchType: string; totalCount: 0; timeMs: number; results: ResultItem[]; startIndex: number; endIndex: number; _error: string; }
interface FileContentResult { project: string; path: string; content: string; lineCount: number; sizeBytes: number; startLine?: number; endLine?: number; /** Enclosing function name when expandFunction was requested */ functionName?: string; functionStartLine?: number; functionEndLine?: number; }
interface SymbolDef { project: string; path: string; line: number; context: string; lang: string; }
interface SymbolRefSample { path: string; project: string; lineNumber: number; content: string; }
interface SymbolContextResult { found: boolean; symbol: string; kind: 'function/method'|'class/struct'|'unknown'; definition?: SymbolDef; references: { totalFound: number; samples: SymbolRefSample[] }; header?: { project: string; path: string; context: string; lang: string }; }
/** symbol types: function, macro, class, enum, interface, namespace, struct, typedef, variable */
interface SymbolEntry { symbol: string; type: string; signature: string|null; line: number; lineStart: number; lineEnd: number; namespace: string|null; }
interface HistoryEntry { /** commit hash — use as rev1/rev2 in getFileDiff() */ revision: string; date: string; author: string; message: string; }
interface AnnotateLine { lineNumber: number; revision: string; author: string; date: string; content: string; }
interface DirEntry { name: string; isDirectory: boolean; path: string; size?: number; lastModified?: string; }
interface CallNode { symbol: string; path: string; project?: string; line: number; depth?: number; }
interface SuggestItem { phrase: string; score?: number; }
interface CompileInfoResult { file: string; compiler: string; standard?: string; includes: string[]; defines: string[]; extraFlags: string[]; }
interface HealthResult { connected: boolean; latencyMs: number; baseUrl: string; /** OpenGrok server version from generator meta tag */ serverVersion?: string; /** Suggester configuration when available */ suggestConfig?: { enabled: boolean; maxResults: number }; }
interface DiffLine { type: 'added'|'removed'|'context'; content: string; oldLineNumber?: number; newLineNumber?: number; }
interface DiffHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[]; }
interface FileDiffResult { project: string; path: string; rev1: string; rev2: string; /** Unified diff string */ unifiedDiff?: string; stats: { added: number; removed: number }; /** Structured hunks with per-line types */ hunks?: DiffHunk[]; cursor?: string; total?: number; /** Present when rev1 === rev2 (no diff to show) */ _hint?: string; }
interface TopLevelSymbol { symbol: string; type: string; line: number; endLine?: number; children?: Array<{ symbol: string; type: string; line: number }>; }
interface FileOverviewResult { project: string; path: string; lang: string; sizeLines: number; sizeBytes: number; /** Present only when includeImports:true was passed */ imports?: string[]; topLevelSymbols: TopLevelSymbol[]; recentAuthors: string[]; lastRevision: string; }
interface GuidanceFile { path: string; scope: 'nearest'|'ancestor'|'boundary'; content: string; truncated: boolean; }
interface GuidanceResult { guidance: GuidanceFile[]; missingCount: number; errorCount: number; incomplete: boolean; capped: boolean; searchedUpTo: string; }
interface ElicitSchema { type: 'object'; properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown }>; required?: string[]; } // [ELICIT]

// --- Search & Discovery ---
/** Lucene syntax: wildcards (prefix*), regex (/pat/), boolean (AND/OR/NOT). defs/refs searchTypes are CASE SENSITIVE; full/path/hist are not. Pass cursor from a prior result to fetch the next page. */
search(query: string, opts?: SearchOpts): SearchResult;
/** 1:1 with input queries (max 10). Host-parallelized, but Promise.all has no effect in-sandbox — calls still resolve serially via the Atomics bridge. */
batchSearch(queries: BatchQuery[], opts?: { projects?: string[]; fileType?: string; sort?: 'relevancy'|'lastmodtime'|'fullpath'; maxHitsPerFile?: number; pathFilter?: string; dir?: string; expandFunction?: boolean }): Array<SearchResult | BatchError>;
/** Path-component match. Wildcards: trailing* works, *glob* works. Bare names match path components (files AND directories). Returns full search results with per-file matches. Pass cursor from a prior result to fetch the next page. */
findFile(pattern: string, opts?: { projects?: string[]; maxResults?: number; limit?: number; cursor?: string }): SearchResult;
/** Term completion/suggestions. field 'full' returns lowercase suggestions (tokenizer behavior); 'defs' returns case-sensitive symbol completions. context shifts ranking toward domain-relevant symbols. */
searchSuggest(query: string, opts?: { field?: 'full'|'defs'|'refs'|'path'|'hist'; project?: string; projects?: string[]; context?: { full?: string; defs?: string; refs?: string; path?: string; hist?: string } }): { query: string; field: string; suggestions: string[]; time: number };

// --- Read & Navigate ---
/** File content by project + path. Use startLine/endLine (1-indexed, inclusive) to fetch a range; omit for the full file. Pass expandFunction with startLine to expand to the enclosing function body. */
getFileContent(project: string, path: string, opts?: { startLine?: number; endLine?: number; expandFunction?: boolean }): FileContentResult;
/** List directory entries for a project path. Pass cursor from a prior result to fetch the next page. */
browseDir(project: string, path?: string, opts?: { cursor?: string; limit?: number }): { project: string; path: string; entries: DirEntry[]; cursor?: string; total?: number };
/** All symbols in a file with line ranges. Pass cursor from a prior result to fetch the next page. */
getFileSymbols(project: string, path: string, opts?: { cursor?: string; limit?: number }): { project: string; path: string; symbols: SymbolEntry[]; cursor?: string; total?: number };
/** File structure summary: language, size, top-level symbols. Pass includeImports:true to include import/include statements (omitted by default to save tokens). */
getFileOverview(project: string, path: string, opts?: { includeImports?: boolean }): FileOverviewResult;
/** AGENTS.md/CLAUDE.md discovery near a file. Scope: nearest, ancestor, boundary. maxBytesPerFile defaults to ~4096 — most AGENTS.md files exceed this and will be truncated; pass a higher value if content appears incomplete. */
getGuidanceForPath(project: string, path: string, opts?: { maxFiles?: number; maxBytesPerFile?: number; maxTotalBytes?: number; guidanceRoot?: string }): GuidanceResult;

// --- History & Blame ---
/** Line-by-line annotation (revision, author, date) for a file. Opts: revision (historical blame), startLine/endLine (1-indexed inclusive range; out-of-range throws), includeContent (default true; false omits line content). */
getFileAnnotate(project: string, path: string, opts?: { startLine?: number; endLine?: number; includeContent?: boolean; revision?: string }): { project: string; path: string; lines: AnnotateLine[] };
/** Commit history for a file. Pass cursor from a prior result to fetch the next page. */
getFileHistory(project: string, path: string, opts?: { maxEntries?: number; cursor?: string }): { project?: string; path?: string; entries: HistoryEntry[]; cursor?: string; total?: number };
/** Compare two revisions of a file. includeHunks:true (default) returns structured hunks with per-line types plus unifiedDiff; includeHunks:false returns {unifiedDiff,stats} only. Pass cursor/limit to page through hunks. */
getFileDiff(project: string, path: string, rev1: string, rev2: string, opts?: { includeHunks?: boolean; cursor?: string; limit?: number }): FileDiffResult;

// --- Code Intelligence ---
/** Call chain tracing. Default direction: 'callers'. callees via tree-sitter AST for supported languages. */
traceCallChain(symbol: string, opts?: { direction?: 'callers'|'callees'|'both'; depth?: number; project?: string }): { symbol: string; direction?: 'callers'|'callees'|'both'; callers?: CallNode[]; callees?: CallNode[]; truncatedAt?: number; calleesNote?: string; budgetExhausted?: boolean; found?: boolean; error?: string };
/** Definition + references in one call. CASE SENSITIVE (uses defs internally). definition.context = ~20 lines of source code around the definition line. */
getSymbolContext(symbol: string, opts?: { projects?: string[]; contextLines?: number; maxRefs?: number; includeHeader?: boolean; fileType?: string; file?: string }): SymbolContextResult;

// --- System ---
/** Check OpenGrok server health and latency. */
indexHealth(): HealthResult;
/** Returns compile flags/includes for a file. Requires compile_commands.json configured at server level. Returns null when not configured. */
getCompileInfo(path: string): unknown|null;
/** List all indexed OpenGrok projects. */
listProjects(filter?: string): { projects: string[] };

// --- Feature-flag dependent ---
/** Read active-task.md or investigation-log.md. Returns null for uninitialized files. */ // [MEMORY]
readMemory(filename: 'active-task.md'|'investigation-log.md'): string|null; // [MEMORY]
/** Write or append to active-task.md or investigation-log.md. */ // [MEMORY]
writeMemory(filename: 'active-task.md'|'investigation-log.md', content: string, mode?: 'overwrite'|'append'): string; // [MEMORY]
/** Ask the user a question. Returns action: 'accept' (content populated), 'decline' (user rejected), or 'cancel' (disabled/unsupported). */ // [ELICIT]
elicit(message: string, schema: ElicitSchema): { action: 'accept'|'decline'|'cancel'; content?: Record<string, unknown> }; // [ELICIT]
/** Call another LLM. Returns null when sampling is disabled or unsupported. */ // [SAMPLE]
sample(prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }): string|null; // [SAMPLE]
`;

/** Backward-compatible alias. */
export const API_SPEC = API_SPEC_TS;

/** Method signatures extracted from the declaration string, keyed by method name. */
export const METHOD_SIGNATURES: Record<string, string> = {};
const sigRegex = /^(\w+)\(.*?\).*?;/gm;
let match: RegExpExecArray | null;
while ((match = sigRegex.exec(API_SPEC_TS)) !== null) {
  METHOD_SIGNATURES[match[1]] = match[0];
}
