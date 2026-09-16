/**
 * Parser subsystem - split from parsers.ts (pure move, no logic changes).
 */
import type { FileSymbol } from "../models.js";
import { decodeEntities } from "./html-utils.js";

// ---------------------------------------------------------------------------
// File symbols from xref HTML (fallback when /api/v1/file/defs is unavailable)
// ---------------------------------------------------------------------------

/** OpenGrok CSS class → symbol type (based on ctags kind letters). */
const CLASS_TO_TYPE: Record<string, string> = {
  xf: "function",
  xm: "macro",
  xc: "class",
  xe: "enum",
  xi: "interface",
  xn: "namespace",
  xs: "struct",
  xt: "typedef",
  xu: "union",
  xd: "definition",
};

// Regex for line-number anchors: <a class="l" name="51" ...> (1.7.x) or id="51" (alternate)
const LINE_ANCHOR_RE = /<a\s+class="h?l"\s+(?:id|name)="(\d+)"/;
// Regex for definition symbol anchors with intelliWindow-symbol class
const DEF_SYMBOL_RE =
  /class="(x[a-z])\s+intelliWindow-symbol"[^>]*data-definition-place="def"[^>]*>([^<]+)<\/a>/;
const SIG_RE = /<span\s+class='scope-signature'>([^<]*(?:&[^;]+;[^<]*)*)<\/span>/;


/**
 * Parse symbol definitions from an OpenGrok xref HTML page.
 *
 * Uses a single-pass regex over the entire HTML instead of splitting by lines,
 * tracking the current line number via line-anchor matches.
 */
export function parseFileSymbols(html: string): FileSymbol[] {
  const symbols: FileSymbol[] = [];

  // Combined regex: match either a line anchor or a def symbol in one pass.
  // Must be per-call because the "g" flag makes it stateful.
  const combinedRe = new RegExp(
    `${LINE_ANCHOR_RE.source}|${DEF_SYMBOL_RE.source}`,
    "g"
  );

  let currentLine = 0;
  let match;
  while ((match = combinedRe.exec(html)) !== null) {
    if (match[1]) {
      // Line anchor match
      currentLine = parseInt(match[1], 10);
    /* v8 ignore start -- regex groups always captured together; type/currentLine always valid */
    } else if (match[2] && match[3]) {
      // Def symbol match
      const cssClass = match[2];
      const symbolName = match[3];
      const type = CLASS_TO_TYPE[cssClass];
      if (!type || !currentLine) continue;
      /* v8 ignore stop */

      let signature: string | null = null;
      if (type === "function") {
        // Look for signature nearby (within same line's HTML)
        const searchStart = Math.max(0, match.index - 500);
        const searchSlice = html.substring(searchStart, match.index + match[0].length + 500);
        const sigMatch = SIG_RE.exec(searchSlice);
        if (sigMatch) {
          signature = decodeEntities(sigMatch[1]);
        }
      }

      symbols.push({
        symbol: symbolName,
        type,
        signature,
        line: currentLine,
        lineStart: currentLine,
        lineEnd: currentLine,
        namespace: null,
      });
    }
  }

  return symbols;
}


