/**
 * Utility functions extracted from server.ts.
 * Budget helpers, response capping, formatting, error handling, and misc utilities.
 *
 * Generic only — no backend-specific strings. Response caps use OPENGROK_
 * prefixed env vars with lazy parsing (non-positive values ignored).
 */

import { ZodError } from "zod";
import type { Config } from "./config.js";
import { BUDGET_LIMITS, getConfigDirectory, checkCredentialAge } from "./config.js";
import { getActiveBudget, getMaxResponseBytes, getSearchAndReadCap } from "./config.js";
import type { ContextBudget } from "./config.js";
import type { ResponseFormat } from "./formatters/index.js";
import {
  capSearchResultsToBytes,
  formatSearchResults,
  formatSearchResultsTOON,
  formatSearchResultsTSV,
  selectFormat,
} from "./formatters/index.js";
import type { SearchResults } from "./models.js";
import { sanitizeErrorMessage } from "./utils/redact.js";
import { logger } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResourceLinkItem = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
};

export type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string } | ResourceLinkItem>;
  structuredContent?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Named constants (eliminate magic numbers)
// ---------------------------------------------------------------------------

/** Latency threshold (ms) above which the index is considered under load */
export const HIGH_LATENCY_THRESHOLD_MS = 500;

/** How often (in execute calls) to nudge the LLM to persist findings */
export const MEMORY_NUDGE_INTERVAL = 5;

/** Minimum execute calls before first memory nudge */
export const MEMORY_NUDGE_MIN_CALLS = 3;

// Re-export budget helpers from config (single source of truth)
export { getActiveBudget, getMaxResponseBytes, getSearchAndReadCap };
export type { ContextBudget };

// ---------------------------------------------------------------------------
// Structured capping — valid JSON/YAML past cap, never a raw byte-slice
// ---------------------------------------------------------------------------

/**
 * Cap a structured value's JSON encoding to maxBytes while keeping it valid.
 * Small payloads serialize byte-identically to plain JSON.stringify (no-op).
 * Oversized payloads shrink long strings iteratively (marked) instead of
 * byte-slicing, which would emit malformed JSON/YAML past the cap.
 */
export function capStructuredToBytes(value: unknown, maxBytes: number): string {
  const plain = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(plain, "utf8") <= maxBytes) return plain;
  let strCap = 2000;
  let text = plain;
  while (Buffer.byteLength(text, "utf8") > maxBytes && strCap > 50) {
    strCap = Math.floor(strCap / 2);
    text = JSON.stringify(value, (_k: string, v: unknown) =>
      typeof v === "string" && v.length > strCap ? `${v.slice(0, strCap)}…[truncated]` : v, 2);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Response capping
// ---------------------------------------------------------------------------

/**
 * Cap a response to the active budget's maxResponseBytes.
 * Accepts an optional override for per-call limits (e.g. search_and_read).
 */
export function capResponse(text: string, maxBytes?: number): string {
  const budget = BUDGET_LIMITS[getActiveBudget()];
  const limit = maxBytes ?? getMaxResponseBytes() ?? budget.maxResponseBytes;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limit) return text;

  const full = Buffer.from(text, "utf8");
  // Walk back from the byte limit to a valid UTF-8 character boundary.
  // Continuation bytes are 0x80–0xBF; a lead byte is 0x00–0x7F or 0xC0–0xFF.
  let pos = limit;
  while (pos > 0 && ((full[pos] ?? 0) & 0xC0) === 0x80) pos--;
  const truncated = full.subarray(0, pos).toString("utf8");

  const lastNl = truncated.lastIndexOf("\n");
  const safeText = lastNl > 0 ? truncated.slice(0, lastNl) : truncated;

  // Close any unclosed markdown code fence to prevent LLM parsing issues
  const fenceCount = (safeText.match(/^```/gm) ?? []).length;
  const closeFence = fenceCount % 2 !== 0 ? "\n```" : "";

  return (
    safeText +
    closeFence +
    `\n[Response truncated at ${Math.round(limit / 1024)} KB. Use line ranges or narrow query.]`
  );
}

export function capCodeModeResult(result: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes <= maxBytes) return result;

  // Try to truncate at a JSON array element boundary
  const trimmed = result.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      const marker = { _truncated: true, _droppedCount: 0 };
      // Binary search for max elements that fit (including marker)
      let lo = 0, hi = parsed.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        marker._droppedCount = parsed.length - mid;
        const candidate = [...parsed.slice(0, mid), marker];
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      if (lo > 0) {
        marker._droppedCount = parsed.length - lo;
        const kept = [...parsed.slice(0, lo), marker];
        return JSON.stringify(kept);
      }

      // No complete element fits — try trimming .results within each element
      // (batchSearch scenario: each element has totalCount + results[])
      const overhead = Buffer.byteLength(JSON.stringify([{ _truncated: true }]), "utf8");
      const budgetPerElement = Math.floor((maxBytes - overhead) / parsed.length);
      if (budgetPerElement > 100) {
        const trimmedElements: unknown[] = [];
        for (const elem of parsed) {
          if (elem !== null && typeof elem === "object" && !Array.isArray(elem)) {
            const obj = elem as Record<string, unknown>;
            const results = obj.results;
            if (Array.isArray(results) && results.length > 0) {
              // Binary-search how many results fit in this element's budget
              let rLo = 0, rHi = results.length;
              const elemFits = (n: number) =>
                Buffer.byteLength(JSON.stringify({ ...obj, results: results.slice(0, n), _truncated: true }), "utf8") <= budgetPerElement;
              while (rLo < rHi) {
                const mid = (rLo + rHi + 1) >> 1;
                if (elemFits(mid)) rLo = mid; else rHi = mid - 1;
              }
              trimmedElements.push(rLo > 0
                ? { ...obj, results: results.slice(0, rLo), _truncated: true }
                : { ...obj, results: [], _truncated: true });
            } else {
              trimmedElements.push(elem);
            }
          } else {
            trimmedElements.push(elem);
          }
        }
        const trimmedStr = JSON.stringify(trimmedElements);
        if (Buffer.byteLength(trimmedStr, "utf8") <= maxBytes) {
          return trimmedStr;
        }
      }
    } catch {
      // Not valid JSON array, fall through to byte truncation
    }
  }

  // Try to truncate at a JSON object key boundary
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const keys = Object.keys(parsed);
      let lo = 0, hi = keys.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const partial: Record<string, unknown> = Object.fromEntries(keys.slice(0, mid).map((k) => [k, parsed[k]]));
        partial._truncated = true;
        partial._droppedKeyNames = keys.slice(mid);
        if (Buffer.byteLength(JSON.stringify(partial), "utf8") <= maxBytes) lo = mid;
        else hi = mid - 1;
      }
      if (lo > 0) {
        const partial: Record<string, unknown> = Object.fromEntries(keys.slice(0, lo).map((k) => [k, parsed[k]]));
        partial._truncated = true;
        partial._droppedKeyNames = keys.slice(lo);
        return JSON.stringify(partial);
      }
    } catch {
      // Not valid JSON object, fall through
    }
  }

  // Fallback: byte truncation (existing behavior)
  return capResponse(result, maxBytes);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Shared helper: format a tool response, routing to compact formats via selectFormat.
 * Applies a compound cap on final output to protect LLM context windows.
 *
 * When response_format="json", structured data is JSON-serialised via
 * capStructuredToBytes (valid JSON past the cap, never a byte-slice).
 */
export function formatResponse(
  textMarkdown: string,
  structured: Record<string, unknown>,
  format: ResponseFormat = "markdown",
  responseType: "search" | "symbol" | "code" | "generic" = "generic"
): ToolResult {
  const effective = selectFormat(responseType, format);
  let text: string;
  switch (effective) {
    case "json":
      text = capStructuredToBytes(structured, getMaxResponseBytes());
      break;
    default:
      text = capResponse(textMarkdown);
  }
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Pick the best search formatter based on the resolved format.
 *
 * When maxBytes is provided (and the format is TOON or TSV), the results
 * array is trimmed *before* encoding to guarantee structurally valid output.
 * Raw byte-truncation of TOON breaks the encoded structure; TSV is safer but
 * loses the "N more rows" footer. Pre-truncation is always correct.
 */
export function pickSearchFormatter(
  fmt: ResponseFormat,
  maxBytes?: number
): (r: SearchResults) => string {
  const cap = maxBytes
    ? (r: SearchResults) => capSearchResultsToBytes(r, maxBytes)
    : (r: SearchResults) => r;
  if (fmt === "toon") return (r) => formatSearchResultsTOON(cap(r));
  if (fmt === "tsv") return (r) => formatSearchResultsTSV(cap(r));
  return formatSearchResults;
}

// ---------------------------------------------------------------------------
// Apply default project helper
// ---------------------------------------------------------------------------

export function applyDefaultProject(
  projects: string[] | undefined,
  config: Config
): string[] | undefined {
  // Only apply the default when projects was not provided at all.
  // An explicit empty array means "search all projects" and must not be overridden.
  if (projects !== undefined && projects !== null) return projects;
  const defaultProject = config.OPENGROK_DEFAULT_PROJECT?.trim();
  return defaultProject ? [defaultProject] : undefined;
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

export function makeToolError(name: string, err: unknown): ToolResult {
  logger.error(`Tool "${name}" failed:`, err);
  let text: string;
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    text = `**Invalid arguments:** ${issues}`;
  } else if (err instanceof Error) {
    text = `**Error:** ${sanitizeErrorMessage(err.message)}`;
  } else {
    text = "**Error:** An unexpected error occurred. Check server logs.";
  }
  return { isError: true, content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------

export function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    c: "text/x-c", h: "text/x-c", cpp: "text/x-c++", cc: "text/x-c++",
    cxx: "text/x-c++", hpp: "text/x-c++", hxx: "text/x-c++",
    java: "text/x-java-source", py: "text/x-python", js: "text/javascript",
    ts: "text/typescript", go: "text/x-go", rs: "text/x-rustsrc",
    rb: "text/x-ruby", sh: "text/x-sh", xml: "text/xml",
    json: "application/json", yaml: "text/yaml", yml: "text/yaml",
    md: "text/markdown", txt: "text/plain",
  };
  return map[ext] ?? "text/plain";
}

// ---------------------------------------------------------------------------
// Credential age warning
// ---------------------------------------------------------------------------

/**
 * Get credential age warning (if applicable).
 * Returns warning string if credentials are older than the rotation window.
 */
export function getCredentialAgeWarning(): string | null {
  try {
    const configDir = getConfigDirectory();
    return checkCredentialAge(configDir);
  } catch {
    return null; // config module or directory check failed
  }
}

// ---------------------------------------------------------------------------
// Prompt sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize user-supplied prompt arguments to prevent injection of template
 * directives or tool instructions into the prompt messages.
 * Strips backtick sequences (MCP tool-call syntax), angle brackets, and
 * removes embedded newlines that could inject extra instructions.
 */
export function sanitizePromptArg(value: string): string {
  return value
    .replace(/`([^`]*)`/g, (_, inner: string) => inner.replace(/[<>]/g, ""))  // strip backtick delimiters and angle brackets inside
    .replace(/[\r\n]+/g, " ")                                          // collapse newlines → space
    .replace(/[*_#[\]()]/g, "")                                        // strip markdown emphasis/heading/link chars
    .trim()
    .slice(0, 256);                                        // hard cap to prevent oversized inputs
}
