import { z } from "zod";
import type { MethodSchema } from "./generator.js";
import { SearchOptsSchema, BatchQuerySchema, SearchResultSchema, BatchErrorSchema } from "./interfaces.js";

export const searchMethod: MethodSchema = {
  name: "search",
  description: "Lucene syntax: wildcards (prefix*), regex (/pat/), boolean (AND/OR/NOT). defs/refs searchTypes are CASE SENSITIVE; full/path/hist are not. Pass cursor from a prior result to fetch the next page.",
  params: [
    { name: "query", type: z.string() },
    { name: "opts", type: SearchOptsSchema.optional() },
  ],
  returns: SearchResultSchema,
  section: "Search & Discovery",
};

export const batchSearchMethod: MethodSchema = {
  name: "batchSearch",
  description: "1:1 with input queries (max 10). Host-parallelized, but Promise.all has no effect in-sandbox — calls still resolve serially via the Atomics bridge.",
  params: [
    { name: "queries", type: z.array(BatchQuerySchema) },
    { name: "opts", type: z.object({ projects: z.array(z.string()).optional(), fileType: z.string().optional(), sort: z.enum(["relevancy", "lastmodtime", "fullpath"]).optional(), maxHitsPerFile: z.number().optional(), pathFilter: z.string().optional(), dir: z.string().optional(), expandFunction: z.boolean().optional() }).optional() },
  ],
  returns: z.array(z.union([SearchResultSchema, BatchErrorSchema])),
  section: "Search & Discovery",
};

export const findFileMethod: MethodSchema = {
  name: "findFile",
  description: "Path-component match. Wildcards: trailing* works, *glob* works. Bare names match path components (files AND directories). Returns full search results with per-file matches. Pass cursor from a prior result to fetch the next page.",
  params: [
    { name: "pattern", type: z.string() },
    { name: "opts", type: z.object({ projects: z.array(z.string()).optional(), maxResults: z.number().optional(), limit: z.number().optional(), cursor: z.string().optional() }).optional() },
  ],
  returns: SearchResultSchema,
  section: "Search & Discovery",
};

export const suggestMethod: MethodSchema = {
  name: "searchSuggest",
  description: "Term completion/suggestions. field 'full' returns lowercase suggestions (tokenizer behavior); 'defs' returns case-sensitive symbol completions. context shifts ranking toward domain-relevant symbols.",
  params: [
    { name: "query", type: z.string() },
    { name: "opts", type: z.object({
      field: z.enum(["full", "defs", "refs", "path", "hist"]).optional(),
      project: z.string().optional(),
      projects: z.array(z.string()).optional(),
      context: z.object({ full: z.string().optional(), defs: z.string().optional(), refs: z.string().optional(), path: z.string().optional(), hist: z.string().optional() }).optional(),
    }).optional() },
  ],
  returns: z.object({ query: z.string(), field: z.string(), suggestions: z.array(z.string()), time: z.number() }),
  section: "Search & Discovery",
};

export const SEARCH_METHODS: MethodSchema[] = [searchMethod, batchSearchMethod, findFileMethod, suggestMethod];
