/**
 * Formatter subsystem - split from formatters.ts (pure move, no logic changes).
 */
import type {
  AnnotatedFile,
  FileHistory,
} from "../models.js";
import { escapeMarkdownField } from "./core.js";

// ---------------------------------------------------------------------------
// Annotate / blame -- grouped consecutive same-author lines, respects range
// ---------------------------------------------------------------------------

export function formatAnnotate(
  annotate: AnnotatedFile,
  startLine?: number,
  endLine?: number
): string {
  const lines: string[] = [];
  const filename = /* v8 ignore next */ annotate.path.split("/").pop() ?? annotate.path;
  lines.push(`Blame: ${filename} (${annotate.project})`);

  if (!annotate.lines.length) {
    lines.push("No annotations found.");
    return lines.join("\n");
  }

  // Apply line range filter
  let displayLines = annotate.lines;
  if (startLine !== undefined || endLine !== undefined) {
    /* v8 ignore start -- coverage misreports ?? for undefined */
    const s = startLine ?? 1;
    const e = endLine ?? Infinity;
    /* v8 ignore stop */
    displayLines = annotate.lines.filter(
      (l) => l.lineNumber >= s && l.lineNumber <= e
    );
  } else {
    // Default cap: 50 lines for full-file views
    displayLines = annotate.lines.slice(0, 50);
  }

  if (!displayLines.length) {
    lines.push("No lines in specified range.");
    return lines.join("\n");
  }

  lines.push("```");

  // Show per-line blame with revision+author on first line of each group
  let prevKey = "";
  for (const line of displayLines) {
    const rev = line.revision ? line.revision.slice(0, 7) : "       ";
    const author = (line.author ?? "").padEnd(8).slice(0, 8);
    const key = `${rev}|${line.author}`;
    const prefix = key !== prevKey ? `${rev} ${author}` : "               ";
    prevKey = key;
    lines.push(`${prefix} L${line.lineNumber}: ${line.content.trimEnd()}`);
  }
  lines.push("```");

  const totalLines = annotate.lines.length;
  const shown = displayLines.length;
  if (shown < totalLines && startLine === undefined && endLine === undefined) {
    lines.push(
      `*Showing first ${shown} of ${totalLines} lines. Use start_line/end_line for a specific range.*`
    );
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Blame — markdown table format, optional line range
// ---------------------------------------------------------------------------

export function formatBlame(
  annotate: AnnotatedFile,
  lineStart?: number,
  lineEnd?: number,
  includeDiff?: boolean
): string {
  const lines: string[] = [];
  const rangeLabel =
    lineStart !== undefined || lineEnd !== undefined
      ? ` (lines ${lineStart ?? 1}–${lineEnd ?? annotate.lines.length})`
      : "";
  lines.push(`# Blame: ${annotate.path}${rangeLabel}`);

  if (!annotate.lines.length) {
    lines.push("\nNo annotations found.");
    return lines.join("\n");
  }

  // Cap at 500 lines for range requests, 200 for full-file.
  // Without a cap, blame on large files produces thousands of table rows that
  // capResponse truncates mid-row, producing malformed markdown.
  const BLAME_CAP = lineStart !== undefined || lineEnd !== undefined ? 500 : 200;
  let displayLines = annotate.lines;
  if (lineStart !== undefined || lineEnd !== undefined) {
    /* v8 ignore start -- coverage misreports ?? for undefined */
    const s = lineStart ?? 1;
    const e = lineEnd ?? Infinity;
    /* v8 ignore stop */
    displayLines = annotate.lines
      .filter((l) => l.lineNumber >= s && l.lineNumber <= e)
      .slice(0, BLAME_CAP);
  } else {
    displayLines = annotate.lines.slice(0, BLAME_CAP);
  }

  if (!displayLines.length) {
    lines.push("\nNo lines in specified range.");
    return lines.join("\n");
  }

  if (includeDiff) {
    lines.push("\n*Note: commit diff summaries are not available via the annotation endpoint.*");
  }

  lines.push("");
  lines.push("| Line | Commit | Author | Date | Content |");
  lines.push("|------|--------|--------|------|---------|");
  for (const line of displayLines) {
    const commit = line.revision ? line.revision.slice(0, 7) : "unknown";
    const author = escapeMarkdownField(line.author ?? "");
    const date = line.date ?? "";
    const content = escapeMarkdownField(line.content.trimEnd());
    lines.push(`| ${line.lineNumber} | ${commit} | ${author} | ${date} | ${content} |`);
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// What changed — recent lines grouped by commit
// ---------------------------------------------------------------------------

export function formatWhatChanged(
  history: FileHistory,
  annotation: AnnotatedFile,
  sinceDays: number
): string {
  const lines: string[] = [];
  // Use the full path in the header for traceability
  lines.push(`# Recent changes: ${annotation.path} (last ${sinceDays} days)`);

  if (!annotation.lines.length) {
    lines.push("\nNo annotation data available.");
    return lines.join("\n");
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - sinceDays);

  // Build a set of recent revision IDs from history entries within sinceDays
  const recentRevisions = new Set<string>();
  for (const entry of history.entries) {
    const entryDate = new Date(entry.date);
    if (!isNaN(entryDate.getTime()) && entryDate >= cutoff) {
      recentRevisions.add(entry.revision);
    }
  }

  // Group annotated lines by revision, filtering to recent ones only
  const byRevision = new Map<string, { author: string; date: string; lineNumbers: number[] }>();
  for (const line of annotation.lines) {
    if (!recentRevisions.has(line.revision)) continue;
    let group = byRevision.get(line.revision);
    if (!group) {
      group = { author: line.author, date: line.date, lineNumbers: [] };
      byRevision.set(line.revision, group);
    }
    group.lineNumbers.push(line.lineNumber);
  }

  if (!byRevision.size) {
    lines.push(`\nNo lines changed within the last ${sinceDays} days.`);
    return lines.join("\n");
  }

  // Sort revisions by date descending (most recent first)
  const sorted = [...byRevision.entries()].sort(([, a], [, b]) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  for (const [rev, { author, date, lineNumbers }] of sorted) {
    const revShort = rev.length > 8 ? rev.slice(0, 8) : rev;
    const authorShort = escapeMarkdownField(author.split("<")[0].trim());
    lines.push(`\n## ${revShort} — ${authorShort} (${date})`);
    lines.push(`Lines: ${compactLineRanges(lineNumbers)}`);
  }

  return lines.join("\n");
}

/** Compact consecutive line numbers into range notation: [1,2,3,5,6] → "1–3, 5–6" */

function compactLineRanges(lineNumbers: number[]): string {
  if (!lineNumbers.length) return "";
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}–${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);
  return ranges.join(", ");
}

// ---------------------------------------------------------------------------
// Compound: search_and_read
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Dependency map formatter
// ---------------------------------------------------------------------------

export interface DependencyNode {
  path: string;
  level: number;
  direction: "uses" | "used_by";
}

export function formatDependencyMap(
  filePath: string,
  depth: number,
  nodes: DependencyNode[]
): string {
  const lines: string[] = [`# Dependency map: \`${filePath}\` (depth ${depth})\n`];

  const uses = nodes.filter((n) => n.direction === "uses");
  const usedBy = nodes.filter((n) => n.direction === "used_by");

  if (uses.length > 0) {
    lines.push("## Files this file uses (imports/includes)\n");
    for (let lvl = 1; lvl <= depth; lvl++) {
      const atLevel = uses.filter((n) => n.level === lvl);
      if (atLevel.length === 0) continue;
      lines.push(`### Level ${lvl}\n`);
      for (const node of atLevel) {
        lines.push(`- \`${node.path}\``);
      }
      lines.push("");
    }
  }

  if (usedBy.length > 0) {
    lines.push("## Files that use this file (reverse deps)\n");
    for (let lvl = 1; lvl <= depth; lvl++) {
      const atLevel = usedBy.filter((n) => n.level === lvl);
      if (atLevel.length === 0) continue;
      lines.push(`### Level ${lvl}\n`);
      for (const node of atLevel) {
        lines.push(`- \`${node.path}\``);
      }
      lines.push("");
    }
  }

  if (nodes.length === 0) {
    lines.push("_No dependency relationships found._");
  }

  return lines.join("\n");
}

