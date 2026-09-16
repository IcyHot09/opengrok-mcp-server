import { z } from "zod";
import type { MethodSchema } from "./generator.js";
import { ElicitInputSchema } from "./interfaces.js";

export const readMemoryMethod: MethodSchema = {
  name: "readMemory",
  description: "Read active-task.md or investigation-log.md. Returns null for uninitialized files.",
  params: [{ name: "filename", type: z.enum(["active-task.md", "investigation-log.md"]) }],
  returns: z.union([z.string(), z.null()]),
  featureFlag: "MEMORY",
  section: "Feature-flag dependent",
};

export const writeMemoryMethod: MethodSchema = {
  name: "writeMemory",
  description: "Write or append to active-task.md or investigation-log.md.",
  params: [
    { name: "filename", type: z.enum(["active-task.md", "investigation-log.md"]) },
    { name: "content", type: z.string() },
    { name: "mode", type: z.enum(["overwrite", "append"]).optional() },
  ],
  returns: z.string(),
  featureFlag: "MEMORY",
  section: "Feature-flag dependent",
};

export const elicitMethod: MethodSchema = {
  name: "elicit",
  description: "Ask the user a question. Returns action: 'accept' (content populated), 'decline' (user rejected), or 'cancel' (disabled/unsupported).",
  params: [
    { name: "message", type: z.string() },
    { name: "schema", type: ElicitInputSchema },
  ],
  returns: z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string(), z.unknown()).optional() }),
  featureFlag: "ELICIT",
  section: "Feature-flag dependent",
};

export const sampleMethod: MethodSchema = {
  name: "sample",
  description: "Call another LLM. Returns null when sampling is disabled or unsupported.",
  params: [
    { name: "prompt", type: z.string() },
    { name: "opts", type: z.object({ maxTokens: z.number().optional(), systemPrompt: z.string().optional() }).optional() },
  ],
  returns: z.union([z.string(), z.null()]),
  featureFlag: "SAMPLE",
  section: "Feature-flag dependent",
};

export const FEATURE_FLAG_METHODS: MethodSchema[] = [readMemoryMethod, writeMemoryMethod, elicitMethod, sampleMethod];
