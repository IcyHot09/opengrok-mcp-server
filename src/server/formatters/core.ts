/**
 * Formatter subsystem - split from formatters.ts (pure move, no logic changes).
 */
import type {
  SearchMatch,
  SearchResult,
  SearchResults,
} from "../models.js";

// ---------------------------------------------------------------------------
// Prompt-injection helpers — applied to all user-controlled strings in output
// ---------------------------------------------------------------------------

/** Escape a user-controlled field for safe inclusion in markdown (tables, inline text). */
export function escapeMarkdownField(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')        // collapse newlines to space
    .replace(/\|/g, '\\|')          // escape table cell breaks
    .replace(/`/g, "'")             // prevent inline code injection
    .slice(0, 500);                  // cap length
}

// ---------------------------------------------------------------------------
// Response format type + global format selector
// ---------------------------------------------------------------------------

export type ResponseFormat = "markdown" | "json" | "tsv" | "yaml" | "text" | "toon" | "auto";

/**
 * Resolve the effective format for a given response type.
 * Global OPENGROK_RESPONSE_FORMAT_OVERRIDE takes priority over the per-call preference.
 * "auto" defers to the responseType-specific best choice.
 */
export function selectFormat(
  responseType: "search" | "symbol" | "code" | "generic",
  perCallFormat?: ResponseFormat | null
): ResponseFormat {
  const validFormats: ResponseFormat[] = ["markdown", "json", "tsv", "yaml", "text", "toon", "auto"];
  const rawOverride = process.env.OPENGROK_RESPONSE_FORMAT_OVERRIDE?.trim().toLowerCase();
  const override = validFormats.includes(rawOverride as ResponseFormat)
    ? (rawOverride as ResponseFormat)
    : undefined;

  const effective = override ?? perCallFormat ?? "auto";

  if (effective !== "auto") return effective;

  // Auto-selection based on response type
  switch (responseType) {
    case "search":  return "tsv";      // Flat, tabular — TSV is most compact
    case "symbol":  return "yaml";     // Hierarchical — YAML preserves structure
    case "code":    return "text";     // Raw code — no markdown overhead
    case "generic": return "markdown"; // Fallback
  }
}



// Max lines returned for a full-file read (no line range specified).
// Override with OPENGROK_MAX_INLINE_LINES env var.
// Evaluated at call time so SIGHUP config reloads are respected.
export function getMaxInlineLines(): number {
  const v = process.env.OPENGROK_MAX_INLINE_LINES ?? '';
  const n = v !== '' ? parseInt(v, 10) : NaN;
  return !Number.isNaN(n) ? n : 200;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const HTML_NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  "#39": "'",
};

export function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    // Named HTML entities
    .replace(/&(lt|gt|amp|quot|apos|nbsp|#39);/g, (_, e) => /* v8 ignore next */ HTML_NAMED_ENTITIES[e] ?? _)
    // Decimal numeric references: &#60; → '<'
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    // Hex numeric references: &#x3C; → '<'
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// Context-aware search result capping (truncate rows before encoding)
// ---------------------------------------------------------------------------

/**
 * Trim a SearchResults object so that its encoded representation fits within
 * maxBytes. We estimate row sizes without encoding and drop trailing rows,
 * preserving header lines and structural validity regardless of format.
 *
 * This is the correct approach for TOON (binary-like encoding) and TSV
 * (structured rows): truncating the *encoded* bytes mid-row produces
 * malformed output. Truncating the data array before encoding guarantees
 * the formatter always receives a structurally complete dataset.
 *
 * @param results   Full SearchResults from the API
 * @param maxBytes  Budget ceiling in bytes (UTF-8)
 * @returns A new SearchResults whose results array fits within the budget
 */
export function capSearchResultsToBytes(
  results: SearchResults,
  maxBytes: number
): SearchResults {
  // Reserve ~15% for header lines, footer, and encoding overhead
  const capBytes = Math.floor(maxBytes * 0.85);
  let used = 0;
  const capped: SearchResult[] = [];

  for (const result of results.results) {
    const cappedMatches: SearchMatch[] = [];
    for (const match of result.matches.slice(0, 5)) {
      // Estimate: path + project + line number + content + separators (~4 chars)
      const rowBytes = Buffer.byteLength(
        result.path + result.project + String(match.lineNumber) +
          stripHtmlTags(match.lineContent),
        "utf8"
      ) + 4;
      if (used + rowBytes > capBytes) break;
      cappedMatches.push(match);
      used += rowBytes;
    }
    if (cappedMatches.length > 0) {
      capped.push({ ...result, matches: cappedMatches });
    }
    if (used >= capBytes) break;
  }

  return { ...results, results: capped };
}

// ---------------------------------------------------------------------------
// Structured capping — valid JSON past cap, never a raw byte-slice
// ---------------------------------------------------------------------------

/**
 * Cap a structured value's JSON encoding to maxBytes while keeping it valid.
 * Small payloads serialize byte-identically to plain JSON.stringify (no-op).
 * Oversized payloads shrink long strings iteratively (marked) instead of
 * byte-slicing, which would emit malformed JSON past the cap.
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

