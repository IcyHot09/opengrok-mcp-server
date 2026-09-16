/**
 * ObservationMasker — session memory management for long Code Mode sessions.
 * Based on JetBrains research-validated approach: keep the last N full tool
 * outputs in context, summarize older ones preserving key facts.
 *
 * Key principle: summaries MUST preserve exact file paths, line numbers,
 * and symbol names — fuzzy summaries fail all probe types. Raw code bytes
 * can be discarded (they live in OpenGrok; re-fetch if needed).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservationEntry {
  turn: number;
  tool: string;
  /** Compact args summary (not the full args — just identifying info) */
  argSummary: string;
  /** The full result text (only kept for recent entries) */
  fullResult: string;
  /** Compact summary extracted from the full result */
  summary: string;
}

// ---------------------------------------------------------------------------
// ObservationMasker
// ---------------------------------------------------------------------------
/** Default number of recent tool outputs to keep as full text in the header. */
const DEFAULT_FULL_WINDOW = 10;

/** Default maximum number of entries before FIFO eviction kicks in. */
const DEFAULT_MAX_ENTRIES = 500;

export class ObservationMasker {
  private readonly entries: ObservationEntry[] = [];
  private readonly fullWindow: number;
  private readonly maxEntries: number;

  constructor(fullWindow: number = DEFAULT_FULL_WINDOW, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.fullWindow = fullWindow;
    this.maxEntries = maxEntries;
  }

  /**
   * Record a tool execution result.
   * Call this after every opengrok_execute response.
   */
  record(
    turn: number,
    tool: string,
    argSummary: string,
    fullResult: string
  ): void {
    const summary = this.extractSummary(tool, fullResult);
    this.entries.push({ turn, tool, argSummary, summary, fullResult });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /**
   * Build a compact header summarizing masked (older) observations.
   * Returns empty string if there are no observations beyond the full window.
   */
  getMaskedHistoryHeader(): string {
    if (this.entries.length <= this.fullWindow) {
      return ""; // Everything fits in the full window — no header needed
    }

    const maskedCount = this.entries.length - this.fullWindow;
    const masked = this.entries.slice(0, maskedCount);

    // Release fullResult from masked entries to free memory — only summary is
    // used in the header, so the full text is dead weight beyond the window.
    for (const entry of masked) {
      entry.fullResult = "";
    }

    const lines: string[] = [
      `<!-- ObservationMask: ${masked.length} earlier tool calls summarized -->`,
      "EARLIER SESSION OBSERVATIONS (summarized to save tokens):",
    ];

    for (const entry of masked) {
      lines.push(`[Turn ${entry.turn}] ${entry.tool}(${entry.argSummary}): ${entry.summary}`);
    }

    lines.push("END EARLIER OBSERVATIONS\n");
    return lines.join("\n");
  }

  /** Total number of recorded entries. */
  get size(): number {
    return this.entries.length;
  }

  // ---------------------------------------------------------------------------
  // Summary extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract a compact summary preserving: file paths, line numbers, symbol names.
   * Discards raw code content (re-fetchable from OpenGrok).
   */
  private extractSummary(tool: string, result: string): string {
    // Extract file paths (project/path.cpp patterns).
    // Each component must be ≥2 chars with no dots (excludes version strings like v1.2.3).
    // Extension must start with a letter and be ≥2 chars (excludes numeric suffixes like .3).
    const pathMatches = [...result.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_-]{1,}(?:\/[a-zA-Z_][a-zA-Z0-9_-]{1,})+\.[a-zA-Z][a-zA-Z0-9]{1,}\b/g)].slice(0, 5);
    const paths = [...new Set(pathMatches.map((m) => m[0]))];

    // Extract line number references (L123 or :123)
    const lineMatches = [...result.matchAll(/[L:](\d{1,6})\b/g)].slice(0, 10);
    const lines = [...new Set(lineMatches.map((m) => m[0]))];

    // Extract symbol names (CamelCase, UPPER_CASE, snake_case, Java getters/setters)
    const symbolMatches = [
      ...result.matchAll(/\b([A-Z][A-Za-z0-9]{2,}|[A-Z_]{3,}|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|get[A-Z]\w+|set[A-Z]\w+)\b/g),
    ].slice(0, 8);
    const symbols = [...new Set(symbolMatches.map((m) => m[0]))];

    const parts: string[] = [];
    if (paths.length) parts.push(`files:${paths.join(",")}`);
    if (lines.length) parts.push(`lines:${lines.join(",")}`);
    if (symbols.length) parts.push(`syms:${symbols.join(",")}`);

    // Tool-specific extraction
    if (tool.includes("search") && result.includes("matches")) {
      const countMatch = result.match(/(\d+)\s+match/);
      if (countMatch) parts.push(`found:${countMatch[1]}`);
    }

    return parts.length ? parts.join(" | ") : "(result recorded, no key entities extracted)";
  }
}
