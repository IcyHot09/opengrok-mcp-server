import { z } from "zod";
import type { MethodSchema } from "./generator.js";
import { FileContentResultSchema, DirEntrySchema, SymbolEntrySchema, FileOverviewResultSchema, GuidanceResultSchema } from "./interfaces.js";

export const readMethod: MethodSchema = {
  name: "getFileContent",
  description: "File content by project + path. Use startLine/endLine (1-indexed, inclusive) to fetch a range; omit for the full file. Pass expandFunction with startLine to expand to the enclosing function body.",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "opts", type: z.object({ startLine: z.number().optional(), endLine: z.number().optional(), expandFunction: z.boolean().optional() }).optional() },
  ],
  returns: FileContentResultSchema,
  section: "Read & Navigate",
};

export const browseMethod: MethodSchema = {
  name: "browseDir",
  description: "List directory entries for a project path. Pass cursor from a prior result to fetch the next page.",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string().optional() },
    { name: "opts", type: z.object({ cursor: z.string().optional(), limit: z.number().optional() }).optional() },
  ],
  returns: z.object({ project: z.string(), path: z.string(), entries: z.array(DirEntrySchema), cursor: z.string().optional(), total: z.number().optional() }),
  section: "Read & Navigate",
};

export const symbolsMethod: MethodSchema = {
  name: "getFileSymbols",
  description: "All symbols in a file with line ranges. Pass cursor from a prior result to fetch the next page.",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "opts", type: z.object({ cursor: z.string().optional(), limit: z.number().optional() }).optional() },
  ],
  returns: z.object({ project: z.string(), path: z.string(), symbols: z.array(SymbolEntrySchema), cursor: z.string().optional(), total: z.number().optional() }),
  section: "Read & Navigate",
};

export const overviewMethod: MethodSchema = {
  name: "getFileOverview",
  description: "File structure summary: language, size, top-level symbols. Pass includeImports:true to include import/include statements (omitted by default to save tokens).",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "opts", type: z.object({ includeImports: z.boolean().optional() }).optional() },
  ],
  returns: FileOverviewResultSchema,
  section: "Read & Navigate",
};

export const guidanceMethod: MethodSchema = {
  name: "getGuidanceForPath",
  description: "AGENTS.md/CLAUDE.md discovery near a file. Scope: nearest, ancestor, boundary. maxBytesPerFile defaults to ~4096 — most AGENTS.md files exceed this and will be truncated; pass a higher value if content appears incomplete.",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "opts", type: z.object({ maxFiles: z.number().optional(), maxBytesPerFile: z.number().optional(), maxTotalBytes: z.number().optional(), guidanceRoot: z.string().optional() }).optional() },
  ],
  returns: GuidanceResultSchema,
  section: "Read & Navigate",
};

export const READ_NAVIGATE_METHODS: MethodSchema[] = [readMethod, browseMethod, symbolsMethod, overviewMethod, guidanceMethod];
