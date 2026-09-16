/**
 * Formatter subsystem - split from formatters.ts (pure move, no logic changes).
 */
import { dump as yamlDump } from "js-yaml";
import type {
  DirectoryEntry,
  FileDiff,
  FileContent,
  FileHistory,
  Project,
  RssHistoryEntry,
} from "../models.js";
import { escapeMarkdownField, getMaxInlineLines } from "./core.js";

const LANGUAGE_MAP: Record<string, string> = {
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  py: "python",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  txt: "",
  log: "",
  rb: "ruby",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  php: "php",
  html: "html",
  css: "css",
  scss: "scss",
  vue: "vue",
  scala: "scala",
  gradle: "groovy",
  dart: "dart",
  zig: "zig",
  lua: "lua",
  r: "r",
  m: "objc",
  mm: "objcpp",
  pl: "perl",
  pm: "perl",
  tf: "hcl",
  toml: "toml",
  ini: "ini",
  proto: "protobuf",
};

function langForPath(path: string): string {
  const ext = path.includes(".") ? (path.split(".").pop() ?? "").toLowerCase() : "";
  return LANGUAGE_MAP[ext] ?? "";
}


// ---------------------------------------------------------------------------
// File content -- with smart truncation for full-file reads
// ---------------------------------------------------------------------------

export function formatFileContent(
  content: FileContent,
  showLineNumbers = true
): string {
  const lines: string[] = [];
  const filename = /* v8 ignore next */ content.path.split("/").pop() ?? content.path;
  const lang = langForPath(content.path);

  lines.push(
    `${filename} (${content.project}) -- ${content.lineCount} lines, ${content.sizeBytes.toLocaleString()} bytes`
  );

  const maxLines = getMaxInlineLines();
  const contentLines = content.content.split("\n");
  let truncated = false;
  let displayLines = contentLines;

  if (contentLines.length > maxLines) {
    displayLines = contentLines.slice(0, maxLines);
    truncated = true;
  }

  lines.push(`\`\`\`${lang}`);
  if (showLineNumbers) {
    const firstLineNum = content.startLine ?? 1;
    const width = String(firstLineNum + displayLines.length - 1).length;
    for (const [i, line] of displayLines.entries()) {
      const lineNum = firstLineNum + i;
      lines.push(`${String(lineNum).padStart(width)} | ${line}`);
    }
  } else {
    lines.push(displayLines.join("\n"));
  }
  lines.push("```");

  if (truncated) {
    lines.push(
      `*Showing first ${maxLines} of ${content.lineCount} lines. Use start_line/end_line to read specific sections.*`
    );
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// File history -- compact one-line-per-entry format
// ---------------------------------------------------------------------------

export function formatFileHistory(
  history: FileHistory,
): string {
  const lines: string[] = [];
  const filename = /* v8 ignore next */ history.path.split("/").pop() ?? history.path;
  lines.push(
    `History: ${filename} (${history.project}) -- ${history.entries.length} commits`
  );

  if (!history.entries.length) {
    lines.push("No history entries found.");
    return lines.join("\n");
  }

  for (const entry of history.entries) {
    const revShort =
      entry.revision.length > 8 ? entry.revision.slice(0, 8) : entry.revision;
    const author = escapeMarkdownField(entry.author.split("<")[0].trim());
    const rawMsg =
      entry.message.length > 72
        ? entry.message.slice(0, 72) + "..."
        : entry.message;
    const msg = escapeMarkdownField(rawMsg);
    lines.push(
      `[${revShort}] ${author} (${entry.date}): "${msg}"`
    );
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Directory listing -- compact two-column format
// ---------------------------------------------------------------------------

export function formatDirectoryListing(
  entries: DirectoryEntry[],
  project: string,
  path: string,
): string {
  const lines: string[] = [];
  const displayPath = path || "/";
  lines.push(`Directory: ${displayPath} (${project})`);

  if (!entries.length) {
    lines.push("(empty)");
    return lines.join("\n");
  }

  const dirs = entries
    .filter((e) => e.isDirectory)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const files = entries
    .filter((e) => !e.isDirectory)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  for (const d of dirs) lines.push(`DIR  ${d.name}/`);
  for (const f of files) {
    const sizeStr =
      f.size !== undefined ? ` (${f.size.toLocaleString()} bytes)` : "";
    lines.push(`FILE ${f.name}${sizeStr}`);
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Projects list
// ---------------------------------------------------------------------------

export function formatProjectsList(projects: Project[]): string {
  const lines: string[] = [];

  if (!projects.length) {
    lines.push("No projects found.");
    return lines.join("\n");
  }

  lines.push(`${projects.length} projects:`);

  const categories = new Map<string, Project[]>();
  for (const p of projects) {
    const cat = p.category ?? "Other";
    if (!categories.has(cat)) categories.set(cat, []);
    const arr = categories.get(cat);
    if (arr) arr.push(p);
  }

  for (const [category, projs] of categories) {
    lines.push(`### ${category}`);
    for (const p of projs.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ${p.name}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Text: raw file content with minimal header (no markdown code fences)
// ---------------------------------------------------------------------------

/**
 * Format file content as plain text with a compact header.
 * Saves ~15 tokens per file vs markdown (no ``` fences, no line-number padding).
 */
export function formatFileContentText(content: FileContent): string {
  const filename = /* v8 ignore next */ content.path.split("/").pop() ?? content.path;
  const maxLines = getMaxInlineLines();
  const startL = content.startLine ?? 1;
  const contentLines = content.content.split("\n");
  let displayLines = contentLines;

  if (contentLines.length > maxLines) {
    displayLines = contentLines.slice(0, maxLines);
  }

  // endL is based on the actual range in content, not the full file line count.
  const endL = startL + displayLines.length - 1;
  const header = `-- ${filename} (${content.project}) L${startL}-${endL} --\n`;

  const lines: string[] = [];
  for (const [i, line] of displayLines.entries()) {
    const lineNum = startL + i;
    lines.push(`${filename}:${lineNum}: ${line}`);
  }

  return header + lines.join("\n");
}


// ---------------------------------------------------------------------------
// formatFileDiff
// ---------------------------------------------------------------------------

/**
 * Format a FileDiff result.
 *
 * - markdown / text: standard unified diff (what AI models understand best)
 * - json: structured hunk data for programmatic analysis
 * - tsv: one-line-per-change for quick scan
 * - yaml: structured with human-readable keys
 */
export function formatFileDiff(result: FileDiff, format = "markdown"): string {
  if (format === "json") return JSON.stringify(result, null, 2);

  if (format === "tsv") {
    const rows = ["type\toldLine\tnewLine\tcontent"];
    for (const hunk of result.hunks) {
      for (const line of hunk.lines) {
        rows.push(`${line.type}\t${line.oldLineNumber ?? ''}\t${line.newLineNumber ?? ''}\t${line.content}`);
      }
    }
    return rows.join('\n');
  }

  if (format === "yaml") {
    return yamlDump({
      project: result.project,
      path: result.path,
      rev1: result.rev1,
      rev2: result.rev2,
      stats: result.stats,
      unifiedDiff: result.unifiedDiff,
    }, { lineWidth: 120 });
  }

  // markdown / text / auto — emit unified diff with a compact header
  const header = [
    `**Diff** \`${result.path}\`  rev \`${result.rev1.slice(0, 8)}\` → \`${result.rev2.slice(0, 8)}\``,
    `**Stats:** +${result.stats.added} / -${result.stats.removed} lines`,
    '',
  ].join('\n');

  if (result.hunks.length === 0) return `${header}_No changes detected._`;

  return format === "markdown"
    ? `${header}\`\`\`diff\n${result.unifiedDiff}\n\`\`\``
    : `${header}${result.unifiedDiff}`;
}


// ---------------------------------------------------------------------------
// RSS History — RSS-style commit history for a file
// ---------------------------------------------------------------------------

export function formatRssHistory(entries: RssHistoryEntry[], project: string, path: string): string {
  const filename = path.split("/").pop() ?? path;
  const lines: string[] = [`RSS History: ${filename} (${project}) — ${entries.length} commits`];
  if (!entries.length) { lines.push("No history entries."); return lines.join("\n"); }
  for (const e of entries) {
    const rev = e.revision.slice(0, 12);
    const msg = escapeMarkdownField(e.summary || e.fullMessage.slice(0, 72));
    const filesNote = e.files.length
      ? `  Files: ${e.files.slice(0, 3).map(escapeMarkdownField).join(", ")}${e.files.length > 3 ? ` +${e.files.length - 3} more` : ""}`
      : "";
    lines.push(`[${rev}] ${escapeMarkdownField(e.author)} (${e.date}): "${msg}"${filesNote}`);
  }
  return lines.join("\n");
}

