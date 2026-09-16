/**
 * Guidance Discovery — finds AGENTS.md and CLAUDE.md in ancestor
 * directories of a known OpenGrok file path.
 *
 * Code Mode only. Probes candidate paths with limited-concurrency parallel
 * reads and returns a lean structured result.
 */

import type { OpenGrokClient } from "./client/index.js";
import { logger } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuidanceKind = "AGENTS.md" | "CLAUDE.md";
export type GuidanceScope = "nearest" | "ancestor" | "boundary";

export interface GuidanceFile {
  path: string;
  scope: GuidanceScope;
  content: string;
  truncated: boolean;
}

export interface GuidanceResult {
  guidance: GuidanceFile[];
  missingCount: number;
  errorCount: number;
  incomplete: boolean;
  capped: boolean;
  /** deepest directory searched (empty string = project root). Helps distinguish "nothing found" from "stopped early". */
  searchedUpTo: string;
}

export interface GuidanceOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  guidanceRoot?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES_PER_FILE = 4096;
const DEFAULT_MAX_TOTAL_BYTES = 16_384;
const GUIDANCE_FILENAMES: readonly GuidanceKind[] = ["AGENTS.md", "CLAUDE.md"];
const CONCURRENCY_LIMIT = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeGuidanceInputPath(input: string): string {
  const normalized = normalizeSlashes(input);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes(".") || parts.includes("..")) {
    throw new Error("Unsafe guidance path");
  }
  return parts.join("/");
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

function truncateUtf8WithFlag(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  const safeText = truncated.endsWith("\ufffd")
    ? truncated.slice(0, -1)
    : truncated;
  return { text: safeText, truncated: true };
}

function isMissingGuidanceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(404|not found|no such file|does not exist)\b/i.test(msg);
}

// ---------------------------------------------------------------------------
// Candidate Generation
// ---------------------------------------------------------------------------

export interface GuidanceCandidate {
  path: string;
  kind: GuidanceKind;
  scope: GuidanceScope;
}

export function buildGuidanceCandidatePaths(path: string, guidanceRoot?: string): GuidanceCandidate[] {
  const normalized = normalizeGuidanceInputPath(path);
  const parts = normalized.split("/");
  const directoryParts = parts.length > 1 ? parts.slice(0, -1) : [];
  const directories: string[] = [];

  let normalizedRoot = "";
  if (guidanceRoot) {
    const rootCleaned = normalizeSlashes(guidanceRoot).replace(/\/+$/, "");
    const rootParts = rootCleaned.split("/").filter(Boolean);
    if (rootParts.includes(".") || rootParts.includes("..")) {
      throw new Error("Unsafe guidance path");
    }
    normalizedRoot = rootParts.join("/");
    const containingDir = directoryParts.join("/");
    if (normalizedRoot && containingDir !== normalizedRoot && !containingDir.startsWith(normalizedRoot + "/")) {
      throw new Error("guidanceRoot must be an ancestor of path");
    }
  }

  for (let i = directoryParts.length; i >= 1; i--) {
    const dir = directoryParts.slice(0, i).join("/");
    directories.push(dir);
    if (normalizedRoot && dir === normalizedRoot) break;
  }

  if (!normalizedRoot) {
    directories.push("");
  } else if (!directories.includes(normalizedRoot)) {
    directories.push(normalizedRoot);
  }

  const stopDir = directories[directories.length - 1];
  const out: GuidanceCandidate[] = [];
  for (const directory of directories) {
    const scope: GuidanceScope =
      directory === stopDir ? "boundary" :
      directory === directories[0] ? "nearest" :
      "ancestor";
    for (const kind of GUIDANCE_FILENAMES) {
      out.push({
        path: directory ? `${directory}/${kind}` : kind,
        kind,
        scope,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guidance File Reading
// ---------------------------------------------------------------------------

export async function getGuidanceForPath(
  client: OpenGrokClient,
  project: string,
  path: string,
  opts: GuidanceOptions = {}
): Promise<GuidanceResult> {
  const maxFiles = clampPositiveInt(opts.maxFiles, DEFAULT_MAX_FILES);
  const maxBytesPerFile = clampPositiveInt(opts.maxBytesPerFile, DEFAULT_MAX_BYTES_PER_FILE);
  const maxTotalBytes = clampPositiveInt(opts.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const candidates = buildGuidanceCandidatePaths(path, opts.guidanceRoot);

  const guidance: GuidanceFile[] = [];
  let totalBytes = 0;
  let missingCount = 0;
  let errorCount = 0;

  for (let batch = 0; batch < candidates.length; batch += CONCURRENCY_LIMIT) {
    if (guidance.length >= maxFiles || totalBytes >= maxTotalBytes) break;

    const slice = candidates.slice(batch, batch + CONCURRENCY_LIMIT);
    const settled = await Promise.allSettled(
      slice.map(c => client.getFileContent(project, c.path))
    );

    for (let j = 0; j < settled.length; j++) {
      if (guidance.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      const r = settled[j];
      const candidate = candidates[batch + j];
      if (r.status === "fulfilled") {
        const remaining = Math.max(0, maxTotalBytes - totalBytes);
        if (remaining === 0) continue;
        const cap = Math.min(maxBytesPerFile, remaining);
        const raw = r.value.content ?? "";
        const { text, truncated } = truncateUtf8WithFlag(raw, cap);
        guidance.push({
          path: candidate.path,
          scope: candidate.scope,
          content: text,
          truncated,
        });
        totalBytes += Buffer.byteLength(text, "utf8");
      } else if (isMissingGuidanceError(r.reason)) {
        missingCount++;
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        logger.warn("Guidance probe error (non-404)", { path: candidate.path, error: msg.slice(0, 200) });
        errorCount++;
      }
    }
  }

  const allCandidatesConsumed = guidance.length < maxFiles && totalBytes < maxTotalBytes;
  const capped = !allCandidatesConsumed && candidates.length > 0;

  const lastProcessedIdx = Math.min(
    guidance.length + missingCount + errorCount - 1,
    candidates.length - 1
  );
  let searchedUpTo = "";
  if (lastProcessedIdx >= 0) {
    const candidatePath = candidates[lastProcessedIdx].path;
    const lastSlash = candidatePath.lastIndexOf("/");
    searchedUpTo = lastSlash >= 0 ? candidatePath.slice(0, lastSlash) : "(root)";
  }

  return { guidance, missingCount, errorCount, incomplete: errorCount > 0, capped, searchedUpTo };
}
