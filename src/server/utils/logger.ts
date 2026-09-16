/**
 * Structured logger for the OpenGrok MCP server.
 * Writes to stderr (required by MCP protocol — stdout is reserved for JSON-RPC).
 *
 * Security: sanitizes all meta/error arguments to strip credentials, tokens,
 * and internal paths before writing to the log stream.
 *
 * Log level: set OPENGROK_LOG_LEVEL=debug to enable debug output.
 */

import { redactString } from "./redact.js";

const LOG_LEVEL = (process.env.OPENGROK_LOG_LEVEL ?? "info").toLowerCase();
const DEBUG_ENABLED = LOG_LEVEL === "debug";

/**
 * Redact sensitive values from an arbitrary log payload before writing to stderr.
 * Handles strings, Error objects, and nested plain objects.
 *
 * NOTE: Object redaction is shallow (depth 1). Nested objects beyond depth 1
 * are recursed but only their immediate string values are redacted — deeply
 * nested Authorization headers or credentials are not guaranteed to be caught.
 * For structured payloads with unknown depth, prefer redactString() at the
 * callsite instead.
 */
function sanitizeMeta(meta: unknown): unknown {
  if (meta === null || meta === undefined || meta === "") return meta;
  if (typeof meta === "string") return redactString(meta);
  if (meta instanceof Error) {
    const redacted = redactString(meta.message);
    return redacted === meta.message ? meta : new Error(redacted);
  }
  if (typeof meta === "object") {
    // Shallow-redact plain objects (e.g., request/response payloads)
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      // Redact common sensitive key names entirely
      if (/password|token|secret|authorization|auth/i.test(k)) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = redactString(v);
      } else {
        out[k] = sanitizeMeta(v);
      }
    }
    return out;
  }
  return meta;
}

function ts(): string {
  return new Date().toISOString();
}

export const logger = {
  info: (msg: string, meta?: unknown): void => {
    const sanitized = sanitizeMeta(meta);
    console.error(`${ts()} [INFO] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
  warn: (msg: string, meta?: unknown): void => {
    const sanitized = sanitizeMeta(meta);
    console.error(`${ts()} [WARN] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
  error: (msg: string, err?: unknown): void => {
    const sanitized = sanitizeMeta(err);
    console.error(`${ts()} [ERROR] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
  debug: (msg: string, meta?: unknown): void => {
    if (!DEBUG_ENABLED) return;
    const sanitized = sanitizeMeta(meta);
    console.error(`${ts()} [DEBUG] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
};
