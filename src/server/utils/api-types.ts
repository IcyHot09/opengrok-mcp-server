/**
 * TypeScript types for the Code Mode sandbox API.
 * These types describe the data structures exchanged between the sandbox
 * (isolated-vm) and the host process via JSON serialization.
 *
 * Distinct from models.ts types (those are for legacy tool I/O).
 */

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchMatch {
  lineNumber: number;
  lineContent: string;
}

export interface SearchResultItem {
  project: string;
  path: string;
  matches: SearchMatch[];
}

export interface SearchAPIResult {
  query: string;
  searchType: string;
  totalCount: number;
  timeMs: number;
  results: SearchResultItem[];
  startIndex: number;
  endIndex: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// File content
// ---------------------------------------------------------------------------

export interface FileContentAPIResult {
  project: string;
  path: string;
  content: string;
  lineCount: number;
  sizeBytes: number;
  startLine?: number;
  endLine?: number;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export interface SymbolEntry {
  symbol: string;
  type: string;
  signature: string | null;
  line: number;
  lineStart: number;
  lineEnd: number;
  namespace: string | null;
}

export interface SymbolsAPIResult {
  project: string;
  path: string;
  symbols: SymbolEntry[];
}

// ---------------------------------------------------------------------------
// File history / blame
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  revision: string;
  date: string;
  author: string;
  message: string;
}

export interface HistoryAPIResult {
  project: string;
  path: string;
  entries: HistoryEntry[];
}

export interface AnnotateLine {
  lineNumber: number;
  revision: string;
  author: string;
  date: string;
  content: string;
}

export interface AnnotateAPIResult {
  project: string;
  path: string;
  lines: AnnotateLine[];
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  size?: number;
  lastModified?: string;
}

export interface DirAPIResult {
  project: string;
  path: string;
  entries: DirEntry[];
}

// ---------------------------------------------------------------------------
// Symbol context (compound result)
// ---------------------------------------------------------------------------

export interface SymbolDefinition {
  project: string;
  path: string;
  line: number;
  context: string;
  lang: string;
}

export interface SymbolReference {
  path: string;
  project: string;
  lineNumber: number;
  content: string;
}

export interface SymbolContextAPIResult {
  found: boolean;
  symbol: string;
  kind: string;
  definition?: SymbolDefinition;
  header?: {
    project: string;
    path: string;
    context: string;
    lang: string;
  };
  references: {
    totalFound: number;
    samples: SymbolReference[];
  };
  fileSymbols?: Array<{ symbol: string; type: string; line: number }>;
}

// ---------------------------------------------------------------------------
// File overview (server-side intelligence)
// ---------------------------------------------------------------------------

export interface FileOverviewAPIResult {
  project: string;
  path: string;
  lang: string;
  sizeLines: number;
  sizeBytes: number;
  imports: string[];          // #include / import statements
  topLevelSymbols: Array<{
    symbol: string;
    type: string;
    line: number;
    endLine?: number;
    children?: Array<{ symbol: string; type: string; line: number }>;
  }>;
  recentAuthors: string[];    // from last 3 history entries
  lastRevision: string;
}

// ---------------------------------------------------------------------------
// Call chain (server-side intelligence)
// ---------------------------------------------------------------------------

export interface CallNode {
  symbol: string;
  path: string;
  project: string;
  line: number;
  depth: number;
}

export interface CallChainAPIResult {
  symbol: string;
  direction: "callers" | "callees" | "both";
  callers: CallNode[];
  callees: CallNode[];         // populated via tree-sitter AST for supported languages
  truncatedAt?: number;        // depth at which traversal was capped
  /** Present when the requested direction includes callees but none were found. */
  calleesNote?: string;
  /** True when the shared search budget was exhausted before traversal completed. */
  budgetExhausted?: boolean;
  /** Present (false) when the symbol was not found in the index at all. */
  found?: boolean;
  /** Human-readable error when found === false. */
  error?: string;
  /** Deprecated: callees are now supported via tree-sitter. Retained for backward compat. */
  calleesUnsupportedMessage?: string;
}

// ---------------------------------------------------------------------------
// Suggest
// ---------------------------------------------------------------------------

export interface SuggestAPIResult {
  query: string;
  field: string;
  suggestions: string[];
  time: number;
}

// ---------------------------------------------------------------------------
// Compile info
// ---------------------------------------------------------------------------

export interface CompileInfoAPIResult {
  file: string;
  compiler: string;
  standard?: string;
  includes: string[];
  defines: string[];
  extraFlags: string[];
}

// ---------------------------------------------------------------------------
// Index health
// ---------------------------------------------------------------------------

export interface HealthAPIResult {
  connected: boolean;
  latencyMs: number;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// File diff — re-exported from models for sandbox/Code-Mode consumers
// ---------------------------------------------------------------------------
export type { DiffLine, DiffHunk, FileDiff as FileDiffAPIResult } from "../models.js";
