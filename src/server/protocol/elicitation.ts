/**
 * MCP Elicitation support — ask the user for input during tool execution.
 *
 * Uses SDK 1.28.0 Server.elicitInput() when the connected client supports it.
 * Falls back gracefully (returns "cancel") when the client doesn't advertise
 * elicitation capabilities, so existing workflows are never broken.
 *
 * Guarded by OPENGROK_ENABLE_ELICITATION=true so it's opt-in.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditLog } from "../transport/audit.js";

export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}

/** Minimal form-mode property shapes the SDK accepts */
export type ElicitProperty =
  | { type: "string"; description?: string; enum?: string[]; default?: string }
  | { type: "number"; description?: string; default?: number }
  | { type: "boolean"; description?: string; default?: boolean };

export interface ElicitSchema {
  type: "object";
  properties: Record<string, ElicitProperty>;
  required?: string[];
}

/**
 * Request elicitation via the low-level Server, falling back to "cancel" when:
 *  - the client does not support elicitation, or
 *  - any error occurs.
 *
 * Always logs the attempt to the audit trail.
 *
 * NOTE: `server.server` accesses the raw low-level MCP `Server` inside the
 * high-level `McpServer` wrapper, because `elicitInput` is not yet promoted
 * to the `McpServer` public API surface (as of @modelcontextprotocol/sdk v1.28.0).
 * Verified against SDK v1.28.0. If a future SDK version exposes it directly
 * on `McpServer`, remove this cast and update the call site.
 */
export async function elicitOrFallback(
  server: McpServer,
  message: string,
  schema: ElicitSchema
): Promise<ElicitResult> {
  auditLog({ type: "elicitation_request", detail: message });
  try {
    // Access the underlying low-level Server for elicitInput (see NOTE above)
    const lowLevel = (server as unknown as { server: { elicitInput: (req: unknown) => Promise<unknown> } }).server;
    if (typeof lowLevel?.elicitInput !== "function") {
      return { action: "cancel" };
    }
    const result = await lowLevel.elicitInput({
      message,
      requestedSchema: schema,
    });
    return result as ElicitResult;
  } catch {
    auditLog({ type: "elicitation_unsupported", detail: message });
    return { action: "cancel" };
  }
}
