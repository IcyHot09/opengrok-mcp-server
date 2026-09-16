/**
 * MemoryBank — Living Document system for persistent session knowledge.
 * Reads/writes a set of allowed markdown files (the "memory bank") enabling
 * the LLM to carry knowledge across sessions without external indexing.
 *
 * Design decisions:
 * - Strict allow-list prevents arbitrary file access
 * - Stub detection via sentinel comment, NOT startsWith('[') which would eat real content
 * - investigation-log.md trimming splits on markdown headings to preserve entries
 * - Max file sizes prevent runaway writes
 * - Uses __dirname-relative default (NOT process.cwd()) for correct VS Code subprocess behavior
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { logger } from "../utils/logger.js";
import { FileReferenceCache } from "../utils/file-cache.js";

// ---------------------------------------------------------------------------
// UTF-8 safe truncation helper
// ---------------------------------------------------------------------------

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * multi-byte codepoint sequence.  A raw `Buffer.subarray(0, maxBytes)` can
 * cut in the middle of a 2–4 byte sequence, producing U+FFFD replacement
 * characters in the output.  This helper walks backward from `maxBytes` to
 * the nearest valid codepoint boundary before slicing.
 *
 * Continuation bytes are in the range 0x80–0xBF (top two bits = 10xxxxxx).
 * Walking back past them reaches either a leading byte (0xC0–0xFF) or an
 * ASCII byte (< 0x80) — both are safe truncation points.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Walk back past any UTF-8 continuation bytes
  while (end > 0 && (buf[end] !== undefined) && (buf[end] & 0xC0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files the LLM is allowed to read/write. */
export const ALLOWED_FILES = [
  "active-task.md",
  "investigation-log.md",
] as const;

export type AllowedFile = typeof ALLOWED_FILES[number];

/** Sentinel embedded in stub files so MemoryBank can detect uninitialized stubs. */
const STUB_SENTINEL_PREFIX = "<!-- OPENGROK_STUB:";

/** Maximum bytes for any individual file. */
const MAX_FILE_BYTES: Record<AllowedFile, number> = {
  "active-task.md":        4_096,
  "investigation-log.md":  32_768,
};

/** Stub templates for first-time initialization. */
const STUB_TEMPLATES: Record<AllowedFile, string> = {
  "active-task.md": `<!-- OPENGROK_STUB:active-task.md -->
task: (none)
started: (none)
last_symbol: (none)
last_file: (none)
next_step: (none)
open_questions: []
status: idle
`,
  "investigation-log.md": `<!-- OPENGROK_STUB:investigation-log.md -->
# Investigation Log
> Append-only. Format: ## YYYY-MM-DD HH:MM: Topic
> Include what you searched, what you found, and why it matters.
`,
};

// ---------------------------------------------------------------------------
// MemoryBank class
// ---------------------------------------------------------------------------

export class MemoryBank {
  private readonly dir: string;
  private lastReadHash = new Map<string, string>();
  readonly fileRefCache = new FileReferenceCache();
  /** Per-file async mutex: serializes concurrent writes to the same file. */
  private readonly writeLocks = new Map<string, Promise<void>>();

  /**
   * @param dir — absolute path to the memory-bank directory.
   *              Caller decides the path (use __dirname or user config).
   */
  constructor(dir: string) {
    this.dir = dir;
  }

  /** Absolute path to the memory bank directory. Used by consumers that need to stat files directly. */
  get bankDir(): string {
    return this.dir;
  }

  /**
   * Returns a hash-based file reference for the given file, registering it in
   * the FileReferenceCache. If the content is unchanged since last call, returns
   * null so callers can short-circuit and emit "[unchanged]" instead.
   *
   * When MCP SDK gains Files API support, this method becomes the upload layer.
   */
  async getFileReference(filename: string): Promise<string | null> {
    const content = await this.read(filename);
    if (content === undefined) return null;
    if (this.fileRefCache.isUnchanged(filename, content)) return null;
    return this.fileRefCache.register(filename, content);
  }

  /** Create the directory and stub files if they don't exist. */
  async ensureDir(): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      logger.info(`MemoryBank directory: ${this.dir}`);
    } catch (err) {
      logger.warn("MemoryBank: failed to create directory:", err);
      return;
    }

    for (const filename of ALLOWED_FILES) {
      const filePath = path.join(this.dir, filename);
      if (!fs.existsSync(filePath)) {
        try {
          await fsp.writeFile(filePath, STUB_TEMPLATES[filename], "utf8");
          logger.info(`MemoryBank: created stub ${filename}`);
        } catch (err) {
          logger.warn(`MemoryBank: failed to create stub ${filename}:`, err);
        }
      }
    }
  }

  /**
   * Read a memory bank file.
   * @returns file content, or undefined if it is still a stub.
   * @throws if filename is not in the allow-list.
   */
  async read(filename: string): Promise<string | undefined> {
    this.assertAllowed(filename);
    const filePath = path.join(this.dir, filename);

    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }

    // Return undefined for uninitialised stubs so callers can skip them
    if (content.startsWith(STUB_SENTINEL_PREFIX)) {
      return undefined;
    }

    return content;
  }

  /**
   * Efficiently return file stats (size + first non-empty line) without reading
   * the entire file. Used by opengrok_memory_status to avoid a full read of
   * investigation-log.md (up to 32 KB) just to display a one-line preview.
   *
   * @returns `{ bytes, preview }` or `undefined` if file is missing / stub.
   */
  async statFile(filename: string): Promise<{ bytes: number; preview: string } | undefined> {
    this.assertAllowed(filename);
    const filePath = path.join(this.dir, filename);

    let bytes: number;
    try {
      const stat = await fsp.stat(filePath);
      bytes = stat.size;
    } catch {
      return undefined;
    }

    // Read only the first 256 bytes for the preview line — avoid loading full file
    let headBuf: Buffer;
    let fd: fsp.FileHandle | undefined;
    try {
      fd = await fsp.open(filePath, "r");
      headBuf = Buffer.allocUnsafe(256);
      const { bytesRead } = await fd.read(headBuf, 0, 256, 0);
      headBuf = headBuf.subarray(0, bytesRead);
    } catch {
      return undefined;
    } finally {
      await fd?.close();
    }

    const head = headBuf.toString("utf8");

    // Stub check — same sentinel as read()
    if (head.startsWith(STUB_SENTINEL_PREFIX)) {
      return undefined;
    }

    const preview = head
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim()
      .slice(0, 60) ?? "";

    return { bytes, preview };
  }

  /**
   * Write to a memory bank file.
   * @param mode "overwrite" replaces the file; "append" adds to it (for investigation-log)
   * @throws if filename is not in the allow-list or content exceeds size limit.
   */
  async write(
    filename: string,
    content: string,
    mode: "overwrite" | "append" = "overwrite"
  ): Promise<void> {
    this.assertAllowed(filename);
    // Serialize concurrent writes to the same file with a per-file async mutex.
    // Without this, two overlapping append calls both read the same base content,
    // each compute their own append, and the last writer silently wins.
    const prior = this.writeLocks.get(filename) ?? Promise.resolve();
    let releaseRef!: () => void;
    const lock = new Promise<void>((resolve) => { releaseRef = resolve; });
    this.writeLocks.set(filename, prior.then(() => lock));
    await prior;
    try {
      await this._writeUnlocked(filename, content, mode);
      // Delete INSIDE the try block, before releasing the lock, so that the next
      // waiting writer cannot observe a stale hash between the delete and the release.
      this.lastReadHash.delete(filename);
    } finally {
      releaseRef();
    }
  }

  private async _writeUnlocked(
    filename: string,
    content: string,
    mode: "overwrite" | "append"
  ): Promise<void> {
    const filePath = path.join(this.dir, filename);
    const maxBytes = MAX_FILE_BYTES[filename as AllowedFile];

    let newContent: string;
    if (mode === "append") {
      let existing = "";
      try {
        existing = await fsp.readFile(filePath, "utf8");
        // Strip stub sentinel if present — file is now being overwritten with real content
        if (existing.startsWith(STUB_SENTINEL_PREFIX)) {
          existing = "";
        }
      } catch {
        existing = "";
      }

      // If combined size exceeds the limit, trim existing content first to make room.
      // For investigation-log: use richness-scored trimFromTop. For others: truncate existing.
      const existingBytes = Buffer.byteLength(existing, "utf8");
      const newBytes = Buffer.byteLength(content, "utf8");
      if (existingBytes + newBytes > maxBytes) {
        const headroom = Math.max(0, maxBytes - newBytes);
        if (filename === "investigation-log.md") {
          existing = this.trimLogFromTop(existing, headroom);
        } else {
          existing = truncateUtf8(existing, headroom);
        }
      }

      if (filename === "investigation-log.md") {
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        if (!content.trimStart().startsWith("## ")) {
          content = `## ${timestamp}: Session Update\n${content}`;
        }
      }

      newContent = existing.trimEnd() + "\n" + content;
    } else {
      newContent = content;
    }

    // Enforce size limit — trim from the top for investigation-log, from the end otherwise
    const encoded = Buffer.byteLength(newContent, "utf8");
    if (encoded > maxBytes) {
      if (filename === "investigation-log.md") {
        newContent = this.trimLogFromTop(newContent, maxBytes);
      } else {
        // For other files: hard truncate at codepoint boundary
        newContent =
          truncateUtf8(newContent, maxBytes) +
          "\n<!-- Truncated to stay within size limit -->";
      }
    }

    try {
      await fsp.mkdir(this.dir, { recursive: true });
      // Atomic write: write to temp file then rename to prevent corruption
      // if the process is interrupted mid-write (Ctrl+C, SIGKILL, crash).
      const tmpPath = filePath + ".tmp";
      await fsp.writeFile(tmpPath, newContent, "utf8");
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      logger.warn(`MemoryBank: failed to write ${filename}:`, err);
      throw new Error(`Failed to write memory bank file: ${filename}`);
    }
  }

  /**
   * Read with delta encoding — returns "[unchanged]" if content hasn't changed
   * since last read. Saves tokens when LLM reads the same file repeatedly.
   */
  async readWithDelta(filename: string): Promise<string | undefined> {
    const content = await this.read(filename);
    if (content === undefined) return undefined;

    const hash = this.simpleHash(content);
    if (this.lastReadHash.get(filename) === hash) {
      return "[unchanged]";
    }
    this.lastReadHash.set(filename, hash);
    return content;
  }

  /**
   * Read investigation-log.md with compression for large files.
   * When file exceeds 8KB, returns last 3 sections + count of omitted sections.
   */
  async readCompressed(filename: string): Promise<string | undefined> {
    const content = await this.read(filename);
    if (content === undefined) return undefined;

    const COMPRESS_THRESHOLD = 8_192;
    if (filename !== "investigation-log.md" || Buffer.byteLength(content, "utf8") <= COMPRESS_THRESHOLD) {
      return content;
    }

    const sections = content.split(/(?=^## )/m).filter(Boolean);
    if (sections.length <= 3) return content;

    const omitted = sections.length - 3;
    const recent = sections.slice(-3);
    return `[${omitted} older entries omitted]\n\n` + recent.join("");
  }

  private scoreLogEntry(section: string): number {
    let score = 0;
    const symbolMatches = section.match(/[A-Z][A-Za-z0-9]{2,}(::[A-Za-z0-9]+)*/g);
    score += (symbolMatches?.length ?? 0) * 2;
    if (/found|root cause|conclusion|fixed|resolved/i.test(section)) score += 10;
    if (/dead end|no results|0 matches|nothing found/i.test(section)) score -= 5;
    return score;
  }

  /**
   * Trim investigation-log.md from the top, discarding oldest/lowest-value entries.
   * Uses richness scoring to prefer keeping high-signal entries.
   * O(n log n): scores all sections once, sorts once, then drops in order.
   */
  private trimLogFromTop(content: string, maxBytes: number): string {
    const sections = content.split(/(?=^## )/m).filter(Boolean);

    if (sections.length <= 1) {
      const suffix = "\n<!-- Older entries trimmed -->";
      const suffixBytes = Buffer.byteLength(suffix, "utf8");
      return truncateUtf8(content, Math.max(0, maxBytes - suffixBytes)) + suffix;
    }

    const trimNote = "<!-- Older entries trimmed -->\n\n";

    // Always keep the 2 most recent entries; score older ones
    const recent = sections.slice(-2);
    const older = sections.slice(0, -2);

    if (older.length === 0) {
      const candidate = trimNote + sections.join("");
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
      // Last resort: truncate at codepoint boundary
      const noteBytes = Buffer.byteLength(trimNote, "utf8");
      return trimNote + truncateUtf8(recent.join(""), Math.max(0, maxBytes - noteBytes));
    }

    // Score all older sections once — O(n)
    const scored = older.map((s, i) => ({ i, score: this.scoreLogEntry(s), bytes: Buffer.byteLength(s, "utf8") }));
    // Sort ascending by score so we drop lowest-value entries first — O(n log n)
    scored.sort((a, b) => a.score - b.score);

    // Track cumulative bytes of kept older sections (starting with all of them)
    let olderBytes = scored.reduce((sum, e) => sum + e.bytes, 0);
    const recentBytes = Buffer.byteLength(recent.join(""), "utf8");
    const noteBytes = Buffer.byteLength(trimNote, "utf8");
    const dropIndices = new Set<number>();

    // Drop sections one at a time (in score order) until we fit — O(n)
    for (const { i, bytes } of scored) {
      if (noteBytes + olderBytes + recentBytes <= maxBytes) break;
      dropIndices.add(i);
      olderBytes -= bytes;
    }

    const keptOlder = older.filter((_, idx) => !dropIndices.has(idx));
    const candidate = trimNote + keptOlder.join("") + recent.join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;

    // Only recent entries left
    const final = trimNote + recent.join("");
    if (Buffer.byteLength(final, "utf8") <= maxBytes) return final;

    // Last resort: truncate at codepoint boundary
    return trimNote + truncateUtf8(recent.join(""), Math.max(0, maxBytes - noteBytes));
  }

  private simpleHash(s: string): string {
    // SHA-256 truncated to 16 hex chars — collision-safe for delta detection.
    // (The previous 32-bit polynomial had ~1% birthday collision probability
    // at 65K inputs, which could cause readWithDelta() to return "[unchanged]"
    // when the content had actually changed.)
    return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
  }

  /**
   * Returns a ≤80-token status line summarising current memory state.
   * Injected into SERVER_INSTRUCTIONS as {{MEMORY_STATUS}}.
   */
  async getStatusLine(): Promise<string> {
    await this.ensureDir();

    const summaries: string[] = [];

    for (const filename of ALLOWED_FILES) {
      const filePath = path.join(this.dir, filename);
      // No existsSync check here — it's a TOCTOU race with the readFile below,
      // and the try/catch already handles ENOENT from readFile.
      try {
        const raw = await fsp.readFile(filePath, "utf8");
        if (raw.trimStart().startsWith(STUB_SENTINEL_PREFIX)) continue; // stub

        // Derive size from the already-read content (avoids a second syscall)
        const sizeKb = (Buffer.byteLength(raw, "utf8") / 1024).toFixed(1);
        // Use file mtime for age — one stat call per file
        const stat = await fsp.stat(filePath);
        const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60_000);
        const ageStr = ageMins < 60
          ? `${ageMins}m ago`
          : `${Math.round(ageMins / 60)}h ago`;

        if (filename === "active-task.md") {
          const taskLine = raw.split("\n").find(l => l.startsWith("task:"));
          const taskVal = taskLine ? taskLine.slice(5).trim().slice(0, 60) : "(set)";
          summaries.push(`active-task.md: "${taskVal}" (${ageStr}, ${sizeKb} KB)`);
        } else if (filename === "investigation-log.md") {
          const entryCount = (raw.match(/^## /gm) ?? []).length;
          summaries.push(`investigation-log.md: ${entryCount} entr${entryCount === 1 ? "y" : "ies"} (${ageStr})`);
        }
      } catch {
        // File unreadable or does not exist — skip silently
      }
    }

    if (summaries.length === 0) return "[Memory] No prior context.";
    return "[Memory] " + summaries.join(". ") + ".";
  }

  private assertAllowed(filename: string): void {
    if (!(ALLOWED_FILES as readonly string[]).includes(filename)) {
      throw new Error(
        `MemoryBank: "${filename}" is not in the allow-list. ` +
        `Allowed: ${ALLOWED_FILES.join(", ")}`
      );
    }
  }
}
