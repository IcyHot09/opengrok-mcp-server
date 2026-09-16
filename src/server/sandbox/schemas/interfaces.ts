import { z } from "zod";
import type { InterfaceSchema } from "./generator.js";

export const SearchOptsSchema = z.object({
  searchType: z.enum(["full", "defs", "refs", "symbol", "path", "hist"]).optional(),
  projects: z.array(z.string()).optional(),
  maxResults: z.number().optional(),
  limit: z.number().optional().describe("Alias for maxResults"),
  startIndex: z.number().optional(),
  cursor: z.string().optional().describe("Opaque pagination cursor from a prior call"),
  fileType: z.string().optional(),
  sort: z.enum(["relevancy", "lastmodtime", "fullpath"]).optional(),
  maxHitsPerFile: z.number().optional(),
  dir: z.string().optional().describe("directory filter — only search within this subtree"),
  pathFilter: z.string().optional().describe("path substring filter — only search within matching paths"),
  file: z.string().optional().describe("single-file filter"),
  expandFunction: z.boolean().optional().describe("expand each result's first match to enclosing function body (max 3 files per query; adds HTTP calls)"),
});

export const BatchQuerySchema = z.object({
  query: z.string(),
  searchType: z.enum(["full", "defs", "refs", "symbol", "path", "hist"]).optional(),
  maxResults: z.number().optional(),
  limit: z.number().optional().describe("Alias for maxResults"),
  dir: z.string().optional(),
  pathFilter: z.string().optional(),
  file: z.string().optional(),
  maxHitsPerFile: z.number().optional(),
  expandFunction: z.boolean().optional().describe("expand each result's first match to enclosing function body (max 3 files per query; adds HTTP calls)"),
});

export const MatchSchema = z.object({ lineNumber: z.number(), lineContent: z.string() });

export const ResultItemSchema = z.object({
  project: z.string(),
  path: z.string(),
  matches: z.array(MatchSchema),
  lastModified: z.string().optional(),
  functionContext: z.string().optional().describe("Enclosing function body when expandFunction was requested"),
});

export const SearchResultSchema = z.object({
  query: z.string(),
  searchType: z.string(),
  totalCount: z.number(),
  timeMs: z.number(),
  results: z.array(ResultItemSchema),
  startIndex: z.number(),
  endIndex: z.number(),
  cursor: z.string().optional(),
  _suggestions: z.array(z.string()).optional(),
  _truncated: z.literal(true).optional(),
});

export const BatchErrorSchema = z.object({
  query: z.string(),
  searchType: z.string(),
  totalCount: z.literal(0),
  timeMs: z.number(),
  results: z.array(ResultItemSchema),
  startIndex: z.number(),
  endIndex: z.number(),
  _error: z.string(),
});

export const FileContentResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  content: z.string(),
  lineCount: z.number(),
  sizeBytes: z.number(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  functionName: z.string().optional().describe("Enclosing function name when expandFunction was requested"),
  functionStartLine: z.number().optional(),
  functionEndLine: z.number().optional(),
});

export const SymbolDefSchema = z.object({
  project: z.string(),
  path: z.string(),
  line: z.number(),
  context: z.string(),
  lang: z.string(),
});

export const SymbolRefSampleSchema = z.object({
  path: z.string(),
  project: z.string(),
  lineNumber: z.number(),
  content: z.string(),
});

export const SymbolContextResultSchema = z.object({
  found: z.boolean(),
  symbol: z.string(),
  kind: z.enum(["function/method", "class/struct", "unknown"]),
  definition: SymbolDefSchema.optional(),
  references: z.object({
    totalFound: z.number(),
    samples: z.array(SymbolRefSampleSchema),
  }),
  header: z.object({
    project: z.string(),
    path: z.string(),
    context: z.string(),
    lang: z.string(),
  }).optional(),
});

export const SymbolEntrySchema = z.object({
  symbol: z.string(),
  type: z.string(),
  signature: z.string().nullable(),
  line: z.number(),
  lineStart: z.number(),
  lineEnd: z.number(),
  namespace: z.string().nullable(),
});

export const HistoryEntrySchema = z.object({
  revision: z.string().describe("commit hash — use as rev1/rev2 in getFileDiff()"),
  date: z.string(),
  author: z.string(),
  message: z.string(),
});

export const AnnotateLineSchema = z.object({
  lineNumber: z.number(),
  revision: z.string(),
  author: z.string(),
  date: z.string(),
  content: z.string(),
});

export const DirEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
  path: z.string(),
  size: z.number().optional(),
  lastModified: z.string().optional(),
});

export const CallNodeSchema = z.object({
  symbol: z.string(),
  path: z.string(),
  project: z.string().optional(),
  line: z.number(),
  depth: z.number().optional(),
});

export const SuggestItemSchema = z.object({
  phrase: z.string(),
  score: z.number().optional(),
});

export const CompileInfoResultSchema = z.object({
  file: z.string(),
  compiler: z.string(),
  standard: z.string().optional(),
  includes: z.array(z.string()),
  defines: z.array(z.string()),
  extraFlags: z.array(z.string()),
});

export const HealthResultSchema = z.object({
  connected: z.boolean(),
  latencyMs: z.number(),
  baseUrl: z.string(),
  serverVersion: z.string().optional().describe("OpenGrok server version from generator meta tag"),
  suggestConfig: z.object({ enabled: z.boolean(), maxResults: z.number() }).passthrough().optional().describe("Suggester configuration when available"),
});

export const DiffLineSchema = z.object({
  type: z.enum(["added", "removed", "context"]),
  content: z.string(),
  oldLineNumber: z.number().optional(),
  newLineNumber: z.number().optional(),
});

export const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldCount: z.number(),
  newStart: z.number(),
  newCount: z.number(),
  lines: z.array(DiffLineSchema),
});

export const FileDiffResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  rev1: z.string(),
  rev2: z.string(),
  unifiedDiff: z.string().optional().describe("Unified diff string"),
  stats: z.object({ added: z.number(), removed: z.number() }),
  hunks: z.array(DiffHunkSchema).optional().describe("Structured hunks with per-line types"),
  cursor: z.string().optional(),
  total: z.number().optional(),
  _hint: z.string().optional().describe("Present when rev1 === rev2 (no diff to show)"),
});

export const TopLevelSymbolSchema = z.object({
  symbol: z.string(),
  type: z.string(),
  line: z.number(),
  endLine: z.number().optional(),
  children: z.array(z.object({
    symbol: z.string(),
    type: z.string(),
    line: z.number(),
  })).optional(),
});

export const FileOverviewResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  lang: z.string(),
  sizeLines: z.number(),
  sizeBytes: z.number(),
  imports: z.array(z.string()).optional().describe("Present only when includeImports:true was passed"),
  topLevelSymbols: z.array(TopLevelSymbolSchema),
  recentAuthors: z.array(z.string()),
  lastRevision: z.string(),
});

export const ElicitInputSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.object({
    type: z.string(),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    default: z.unknown().optional(),
  })),
  required: z.array(z.string()).optional(),
});

export const GuidanceFileSchema = z.object({
  path: z.string(),
  scope: z.enum(["nearest", "ancestor", "boundary"]),
  content: z.string(),
  truncated: z.boolean(),
});

export const GuidanceResultSchema = z.object({
  guidance: z.array(GuidanceFileSchema),
  missingCount: z.number(),
  errorCount: z.number(),
  incomplete: z.boolean(),
  capped: z.boolean(),
  searchedUpTo: z.string(),
});

// Order matters — interfaces referencing others must come after their dependencies.
export const ALL_INTERFACES: InterfaceSchema[] = [
  { name: "SearchOpts", schema: SearchOptsSchema },
  { name: "BatchQuery", schema: BatchQuerySchema },
  { name: "Match", schema: MatchSchema },
  { name: "ResultItem", schema: ResultItemSchema },
  { name: "SearchResult", schema: SearchResultSchema },
  { name: "BatchError", schema: BatchErrorSchema, description: "discriminant: '_error' in r ? handle error : '_truncated' in r ? dropped query (retry via search()) : use r.results" },
  { name: "FileContentResult", schema: FileContentResultSchema },
  { name: "SymbolDef", schema: SymbolDefSchema },
  { name: "SymbolRefSample", schema: SymbolRefSampleSchema },
  { name: "SymbolContextResult", schema: SymbolContextResultSchema },
  { name: "SymbolEntry", schema: SymbolEntrySchema, description: "symbol types: function, macro, class, enum, interface, namespace, struct, typedef, variable" },
  { name: "HistoryEntry", schema: HistoryEntrySchema },
  { name: "AnnotateLine", schema: AnnotateLineSchema },
  { name: "DirEntry", schema: DirEntrySchema },
  { name: "CallNode", schema: CallNodeSchema },
  { name: "SuggestItem", schema: SuggestItemSchema },
  { name: "CompileInfoResult", schema: CompileInfoResultSchema },
  { name: "HealthResult", schema: HealthResultSchema },
  { name: "DiffLine", schema: DiffLineSchema },
  { name: "DiffHunk", schema: DiffHunkSchema },
  { name: "FileDiffResult", schema: FileDiffResultSchema },
  { name: "TopLevelSymbol", schema: TopLevelSymbolSchema },
  { name: "FileOverviewResult", schema: FileOverviewResultSchema },
  { name: "GuidanceFile", schema: GuidanceFileSchema },
  { name: "GuidanceResult", schema: GuidanceResultSchema },
  { name: "ElicitSchema", schema: ElicitInputSchema, featureFlag: "ELICIT" },
];
