import { z } from "zod";
import type { MethodSchema } from "./generator.js";
import { HealthResultSchema } from "./interfaces.js";

export const healthMethod: MethodSchema = {
  name: "indexHealth",
  description: "Check OpenGrok server health and latency.",
  params: [],
  returns: HealthResultSchema,
  section: "System",
};

export const compileInfoMethod: MethodSchema = {
  name: "getCompileInfo",
  description: "Returns compile flags/includes for a file. Requires compile_commands.json configured at server level. Returns null when not configured.",
  params: [{ name: "path", type: z.string() }],
  returns: z.unknown().nullable(),
  section: "System",
};

export const listProjectsMethod: MethodSchema = {
  name: "listProjects",
  description: "List all indexed OpenGrok projects.",
  params: [{ name: "filter", type: z.string().optional() }],
  returns: z.object({ projects: z.array(z.string()) }),
  section: "System",
};

export const SYSTEM_METHODS: MethodSchema[] = [healthMethod, compileInfoMethod, listProjectsMethod];
