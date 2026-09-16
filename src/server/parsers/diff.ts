/**
 * Parser subsystem - split from parsers.ts (pure move, no logic changes).
 */
import { parse as parseHtml } from "node-html-parser";
import type { DiffHunk, DiffLine, FileDiff } from "../models.js";
import { decodeEntities } from "./html-utils.js";

// ---------------------------------------------------------------------------
// parseFileDiff — parse unified diff HTML from OpenGrok ?format=u
// ---------------------------------------------------------------------------

// Regex patterns for extracting line data from OpenGrok unified diff HTML.
// Each line within a <td> is separated by <br/> and contains one of:
const DEL_LINE_RE = /<del\s+class="d">(\d+)<\/del>([\s\S]*)/;     // deleted line
// Class-membership matching: handles any attribute order (e.g. "a it", "it a", "it ln a").
const ADD_LINE_RE = /<span\s+class="[^"]*\ba\b[^"]*">(\d+)<\/span>([\s\S]*)/; // added line (has class "a")
const CTX_LINE_RE = /<span\s+class="[^"]*\bit\b[^"]*">(\d+)<\/span>([\s\S]*)/; // context line (has class "it"; ADD checked first)

/** Strip HTML tags from a string. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/**
 * Parse unified diff HTML from OpenGrok's `?format=u` endpoint.
 *
 * The HTML structure (from diff.jsp):
 * - `<del class="d">N</del>CONTENT` = deleted line (old file)
 * - `<span class="a it">N</span>CONTENT` = added line (new file)
 * - `<span class="it">N</span>CONTENT` = context line (unchanged)
 * - Lines within each `<td>` are separated by `<br/>`
 * - `--- N unchanged lines hidden` = collapsed context separator (hunk boundary)
 *
 * Returns FileDiff with structured hunks (including context lines) + unified diff string.
 */
export function parseFileDiff(
  html: string,
  project: string,
  path: string,
  rev1: string,
  rev2: string,
): FileDiff {
  const renamedFrom = html.match(/^rename from (.+)$/m)?.[1]?.trim();
  const renamedTo = html.match(/^rename to (.+)$/m)?.[1]?.trim();
  const oldModeM = html.match(/^old mode (\d+)$/m);
  const newModeM = html.match(/^new mode (\d+)$/m);
  const modeChange = oldModeM && newModeM ? { oldMode: oldModeM[1], newMode: newModeM[1] } : undefined;

  const empty: FileDiff = { project, path, rev1, rev2, hunks: [], unifiedDiff: '', stats: { added: 0, removed: 0 }, renamedFrom, renamedTo, modeChange };
  if (!html || !html.trim()) return empty;

  let root: ReturnType<typeof parseHtml>;
  try {
    root = parseHtml(html);
  } catch {
    return empty;
  }
  const difftable = root.querySelector('#difftable');
  if (!difftable) return empty;

  // Extract all diff lines from every <td> in the diff table
  const allLines: DiffLine[] = [];
  // Positions (as allLines.length at the time) after which a collapsed-context
  // separator occurred — a forced hunk boundary even when line numbers look
  // continuous across files (e.g. removes followed by adds at a lower number).
  const forcedSplits = new Set<number>();
  const tds = difftable.querySelectorAll('td');

  for (const td of tds) {
    const fragments = td.innerHTML.split(/<br\s*\/?>/gi);
    for (const frag of fragments) {
      const trimmed = frag.trim();
      if (!trimmed) continue;
      // Skip collapsed-context separators (but record the hunk boundary)
      if (trimmed.includes('unchanged lines hidden')) {
        forcedSplits.add(allLines.length);
        continue;
      }
      // Skip plain separator markers (--- <br/>)
      if (/^-{3}\s*$/.test(stripTags(trimmed).trim())) {
        forcedSplits.add(allLines.length);
        continue;
      }

      const delM = DEL_LINE_RE.exec(trimmed);
      if (delM) {
        allLines.push({
          type: 'removed',
          oldLineNumber: parseInt(delM[1], 10),
          content: decodeEntities(stripTags(delM[2]).trimEnd()),
        });
        continue;
      }

      const addM = ADD_LINE_RE.exec(trimmed);
      if (addM) {
        allLines.push({
          type: 'added',
          newLineNumber: parseInt(addM[1], 10),
          content: decodeEntities(stripTags(addM[2]).trimEnd()),
        });
        continue;
      }

      const ctxM = CTX_LINE_RE.exec(trimmed);
      if (ctxM) {
        allLines.push({
          type: 'context',
          newLineNumber: parseInt(ctxM[1], 10),
          content: decodeEntities(stripTags(ctxM[2]).trimEnd()),
        });
        continue;
      }
    }
  }

  if (allLines.length === 0) return empty;

  // Compute oldLineNumber for context lines. In the HTML, context lines
  // only carry the new-file line number. The old-file number is derived from
  // the running offset (cumulative adds − cumulative removes).
  let addsSoFar = 0;
  let removesSoFar = 0;
  for (const line of allLines) {
    if (line.type === 'added') {
      addsSoFar++;
    } else if (line.type === 'removed') {
      removesSoFar++;
    } else {
      line.oldLineNumber = (line.newLineNumber ?? 0) - (addsSoFar - removesSoFar);
    }
  }

  // Group lines into hunks. A hunk boundary occurs when there's a gap in
  // sequential line numbering (indicating collapsed unchanged lines).
  // Track old and new line counters independently: added lines advance only
  // the new-line counter, removed lines advance only the old-line counter,
  // and context lines advance both.
  const hunks: DiffHunk[] = [];
  let currentHunkLines: DiffLine[] = [allLines[0]];

  for (let i = 1; i < allLines.length; i++) {
    const prev = allLines[i - 1];
    const curr = allLines[i];

    // Determine which counter to compare based on line type.
    let prevCounter: number;
    let currCounter: number;

    if (curr.type === 'added') {
      prevCounter = prev.newLineNumber ?? prev.oldLineNumber ?? 0;
      currCounter = curr.newLineNumber ?? 0;
    } else if (curr.type === 'removed') {
      prevCounter = prev.oldLineNumber ?? prev.newLineNumber ?? 0;
      currCounter = curr.oldLineNumber ?? 0;
    } else {
      // context line
      prevCounter = prev.newLineNumber ?? prev.oldLineNumber ?? 0;
      currCounter = curr.newLineNumber ?? curr.oldLineNumber ?? 0;
    }

    // A gap > 1 signals collapsed context between hunks. Separators skipped
    // above also force a split (counters alone can't see across files).
    if (forcedSplits.has(i) || currCounter - prevCounter > 1) {
      hunks.push(buildHunk(currentHunkLines));
      currentHunkLines = [];
    }
    currentHunkLines.push(curr);
  }
  if (currentHunkLines.length > 0) {
    hunks.push(buildHunk(currentHunkLines));
  }

  // Build unified diff string
  const diffOutput: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let totalAdded = 0, totalRemoved = 0;

  for (const hunk of hunks) {
    diffOutput.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      if (line.type === 'removed')    { diffOutput.push(`-${line.content}`); totalRemoved++; }
      else if (line.type === 'added') { diffOutput.push(`+${line.content}`); totalAdded++; }
      else                            { diffOutput.push(` ${line.content}`); }
    }
  }

  return {
    project, path, rev1, rev2,
    hunks,
    unifiedDiff: diffOutput.join('\n'),
    stats: { added: totalAdded, removed: totalRemoved },
    renamedFrom, renamedTo, modeChange,
  };
}

/**
 * Build a DiffHunk from a sequence of DiffLines.
 * Computes oldStart by tracking the offset between old and new line numbers.
 */

export function buildHunk(lines: DiffLine[]): DiffHunk {
  // Compute oldStart/newStart. Pure-removal hunks without context carry no
  // new-side numbers — their insertion point precedes the removed block.
  const firstNew = lines.find((l) => l.newLineNumber !== undefined);
  const firstDel = lines.find((l) => l.type === 'removed');
  const firstCtx = lines.find((l) => l.type === 'context');
  let oldStart: number;
  let newStart: number;
  if (firstNew?.newLineNumber !== undefined) {
    newStart = firstNew.newLineNumber;
    if (firstDel?.oldLineNumber !== undefined) {
      // Count only context lines (not added lines) before the first delete to compute
      // where the old-file hunk starts.
      const ctxBefore = lines.slice(0, lines.indexOf(firstDel)).filter((l) => l.type === 'context').length;
      oldStart = firstDel.oldLineNumber - ctxBefore;
    } else if (firstCtx?.oldLineNumber !== undefined) {
      // Pure add hunk — old line matches context position in OLD file
      oldStart = firstCtx.oldLineNumber;
    } else {
      // Pure add hunk with no context — insertion point is one before the first added line
      oldStart = Math.max(0, newStart - 1);
    }
  } else {
    // Pure removal without context: every line carries oldLineNumber.
    const oldNums = lines.map((l) => l.oldLineNumber as number);
    oldStart = Math.min(...oldNums);
    newStart = Math.max(0, oldStart - 1);
  }

  const oldCount = lines.filter((l) => l.type === 'removed' || l.type === 'context').length;
  const newCount = lines.filter((l) => l.type === 'added' || l.type === 'context').length;

  return { oldStart, oldCount, newStart, newCount, lines };
}
