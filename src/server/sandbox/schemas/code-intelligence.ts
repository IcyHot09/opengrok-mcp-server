import { z } from "zod";
import type { MethodSchema } from "./generator.js";
import { CallNodeSchema, SymbolContextResultSchema } from "./interfaces.js";

export const traceCallChainMethod: MethodSchema = {
  name: "traceCallChain",
  description: "Call chain tracing. Default direction: 'callers'. callees via tree-sitter AST for supported languages.",
  params: [
    { name: "symbol", type: z.string() },
    { name: "opts", type: z.object({ direction: z.enum(["callers", "callees", "both"]).optional(), depth: z.number().optional(), project: z.string().optional() }).optional() },
  ],
  returns: z.object({
    symbol: z.string(),
    direction: z.enum(["callers", "callees", "both"]).optional(),
    callers: z.array(CallNodeSchema).optional(),
    callees: z.array(CallNodeSchema).optional(),
    truncatedAt: z.number().optional(),
    calleesNote: z.string().optional(),
    budgetExhausted: z.boolean().optional(),
    found: z.boolean().optional(),
    error: z.string().optional(),
  }),
  section: "Code Intelligence",
};

export const symbolContextMethod: MethodSchema = {
  name: "getSymbolContext",
  description: "Definition + references in one call. CASE SENSITIVE (uses defs internally). definition.context = ~20 lines of source code around the definition line.",
  params: [
    { name: "symbol", type: z.string() },
    { name: "opts", type: z.object({ projects: z.array(z.string()).optional(), contextLines: z.number().optional(), maxRefs: z.number().optional(), includeHeader: z.boolean().optional(), fileType: z.string().optional(), file: z.string().optional() }).optional() },
  ],
  returns: SymbolContextResultSchema,
  section: "Code Intelligence",
};

export const CODE_INTELLIGENCE_METHODS: MethodSchema[] = [traceCallChainMethod, symbolContextMethod];
