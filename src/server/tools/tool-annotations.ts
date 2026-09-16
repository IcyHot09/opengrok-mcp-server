/**
 * Tool annotation constants (split from server.ts, pure move).
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const READ_ONLY_OPEN: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const READ_ONLY_LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Code Mode tools are well-suited for Claude's extended thinking between tool calls,
// but enabling that is a client-side API concern — no MCP annotation needed.
export const CODE_MODE_API_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  idempotentHint: true,
  destructiveHint: false,
};

export const CODE_MODE_EXECUTE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: true,
  idempotentHint: false,
  destructiveHint: false,
};
