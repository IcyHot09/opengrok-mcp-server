import { z } from "zod";
import type { MethodSchema } from "./generator.js";
import { AnnotateLineSchema, HistoryEntrySchema, FileDiffResultSchema } from "./interfaces.js";

export const blameMethod: MethodSchema = {
  name: "getFileAnnotate",
  description: "Line-by-line annotation (revision, author, date) for a file. Opts: revision (historical blame), startLine/endLine (1-indexed inclusive range; out-of-range throws), includeContent (default true; false omits line content).",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "opts", type: z.object({ startLine: z.number().optional(), endLine: z.number().optional(), includeContent: z.boolean().optional(), revision: z.string().optional() }).optional() },
  ],
  returns: z.object({ project: z.string(), path: z.string(), lines: z.array(AnnotateLineSchema) }),
  section: "History & Blame",
};

export const historyMethod: MethodSchema = {
  name: "getFileHistory",
  description: "Commit history for a file. Pass cursor from a prior result to fetch the next page.",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "opts", type: z.object({ maxEntries: z.number().optional(), cursor: z.string().optional() }).optional() },
  ],
  returns: z.object({ project: z.string().optional(), path: z.string().optional(), entries: z.array(HistoryEntrySchema), cursor: z.string().optional(), total: z.number().optional() }),
  section: "History & Blame",
};

export const diffMethod: MethodSchema = {
  name: "getFileDiff",
  description: "Compare two revisions of a file. includeHunks:true (default) returns structured hunks with per-line types plus unifiedDiff; includeHunks:false returns {unifiedDiff,stats} only. Pass cursor/limit to page through hunks.",
  params: [
    { name: "project", type: z.string() },
    { name: "path", type: z.string() },
    { name: "rev1", type: z.string() },
    { name: "rev2", type: z.string() },
    { name: "opts", type: z.object({ includeHunks: z.boolean().optional(), cursor: z.string().optional(), limit: z.number().optional() }).optional() },
  ],
  returns: FileDiffResultSchema,
  section: "History & Blame",
};

export const HISTORY_BLAME_METHODS: MethodSchema[] = [blameMethod, historyMethod, diffMethod];
