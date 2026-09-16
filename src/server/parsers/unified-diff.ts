import type { DiffHunk, DiffLine } from "../models.js";

export interface RawDiffHunk {
  raw: string;
  added: number;
  removed: number;
}

/**
 * Split a unified diff string into a file header and individual hunks.
 * Header = everything before the first @@ line (--- a/path, +++ b/path, etc.)
 * Each hunk = "@@ ..." header line + body lines until the next "@@ " or end.
 */
export function parseUnifiedDiff(unifiedDiff: string): { fileHeader: string; hunks: RawDiffHunk[] } {
  const lines = unifiedDiff.split("\n");
  const headerLines: string[] = [];
  const hunks: RawDiffHunk[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (current !== null) {
        hunks.push(buildRawHunk(current));
      }
      current = [line];
    } else if (current !== null) {
      current.push(line);
    } else {
      headerLines.push(line);
    }
  }
  if (current !== null) {
    hunks.push(buildRawHunk(current));
  }

  return { fileHeader: headerLines.join("\n"), hunks };
}

function buildRawHunk(lines: string[]): RawDiffHunk {
  let added = 0;
  let removed = 0;
  // skip first line (the @@ header). Inside a hunk body, +++ / --- can only
  // be content (added "++i;" serializes as "+++i;") — file headers precede
  // the first @@ line, so no positional guard is needed here.
  for (let i = 1; i < lines.length; i++) {
    const ch = lines[i][0];
    if (ch === "+") added++;
    else if (ch === "-") removed++;
  }
  return { raw: lines.join("\n"), added, removed };
}

export function computeHunkPageStats(hunks: RawDiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.added;
    removed += h.removed;
  }
  return { added, removed };
}

/**
 * Parse a unified diff string into structured DiffHunk objects with per-line types and
 * explicit line numbers. Suitable for line-level analysis — no prefix characters,
 * directly queryable. Returns an empty array for empty diffs.
 */
export function parseStructuredDiff(unifiedDiff: string): DiffHunk[] {
  const { hunks: rawHunks } = parseUnifiedDiff(unifiedDiff);
  return rawHunks.map((rh) => {
    const lines = rh.raw.split("\n");
    const m = lines[0].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const oldStart = m ? parseInt(m[1]) : 1;
    const oldCount = m ? parseInt(m[2] ?? "1") : 0;
    const newStart = m ? parseInt(m[3]) : 1;
    const newCount = m ? parseInt(m[4] ?? "1") : 0;
    const diffLines: DiffLine[] = [];
    let oldLine = oldStart;
    let newLine = newStart;
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln || ln === "\\ No newline at end of file") continue;
      const ch = ln[0];
      if (ch === " ") {
        diffLines.push({ type: "context", oldLineNumber: oldLine++, newLineNumber: newLine++, content: ln.slice(1) });
      } else if (ch === "-") {
        diffLines.push({ type: "removed", oldLineNumber: oldLine++, content: ln.slice(1) });
      } else if (ch === "+") {
        diffLines.push({ type: "added", newLineNumber: newLine++, content: ln.slice(1) });
      }
    }
    return { oldStart, oldCount, newStart, newCount, lines: diffLines };
  });
}

export function reassembleUnifiedDiff(fileHeader: string, hunks: RawDiffHunk[]): string {
  const parts: string[] = [];
  if (fileHeader) parts.push(fileHeader);
  for (const h of hunks) {
    parts.push(h.raw);
  }
  return parts.join("\n");
}
