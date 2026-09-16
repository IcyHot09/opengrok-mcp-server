/**
 * OpenGrok HTTP client subsystem - split from client.ts (pure move, no logic changes).
 */

// ---------------------------------------------------------------------------
// Per-operation timeouts (ms)
// ---------------------------------------------------------------------------
export const TIMEOUTS = {
  search: 60_000,
  suggest: 10_000,
  file: 30_000,
  default: 30_000,
};


export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract a line range from content using indexOf instead of split/slice/join.
 * Avoids allocating an intermediate array for the entire file.
 *
 * Single-pass: always scans the full content so `totalLines` is accurate even
 * when we find the end of the requested range before reaching EOF.
 */
export function extractLineRange(
  content: string,
  startLine?: number,
  endLine?: number
): { text: string; totalLines: number } {
  if (startLine === undefined && endLine === undefined) {
    // Fast path: count newlines with a single regex, return full content.
    const totalLines = content.length === 0
      ? 1
      : (content.match(/\n/g)?.length ?? 0) + 1;
    return { text: content, totalLines };
  }

  const s = Math.max(0, (startLine ?? 1) - 1); // 0-based inclusive start index
  const e = endLine;                             // 1-based inclusive end (may be undefined)

  let totalLines = 0;
  let startOffset = s === 0 ? 0 : -1; // -1 means "not yet found"
  let endOffset = content.length;
  let endSet = false;

  let lineIdx = 0; // 0-based index of the line being visited
  let pos = 0;

  while (true) {
    const nl = content.indexOf("\n", pos);

    // Capture start offset when we reach the requested start line
    if (startOffset === -1 && lineIdx === s) {
      startOffset = pos;
    }

    if (nl === -1) {
      // Final line — no trailing newline
      totalLines = lineIdx + 1;
      if (!endSet && e !== undefined && lineIdx < e) {
        endOffset = content.length;
      }
      break;
    }

    totalLines = lineIdx + 2; // current line + at least one more exists

    // After processing the \n of line `lineIdx` (1-based: lineIdx+1), check if we've
    // reached the requested end line. endOffset points past the \n of that line.
    if (!endSet && e !== undefined && lineIdx + 1 >= e) {
      endOffset = nl + 1;
      endSet = true;
    }

    lineIdx++;
    pos = nl + 1;
  }

  // startLine is beyond the end of the file
  if (startOffset === -1) {
    return { text: "", totalLines };
  }

  if (e === undefined) {
    endOffset = content.length;
  }

  let text = content.substring(startOffset, endOffset);
  if (text.endsWith("\n")) text = text.slice(0, -1);

  return { text, totalLines };
}

/** Maximum response body size before rejecting (prevents OOM on huge files). Default 16 MB. */
export const MAX_RESPONSE_BODY_BYTES =
  parseInt(process.env.OPENGROK_MAX_FILE_SIZE ?? "", 10) || 16 * 1024 * 1024;

/**
 * Safely read response body as text, rejecting if body exceeds MAX_RESPONSE_BODY_BYTES.
 * Handles both Content-Length (fast path) and chunked-encoded responses (streaming path)
 * to prevent OOM when a server serves unexpectedly large files.
 */
export async function safeResponseText(response: import("undici").Response): Promise<string> {
  // Fast path: Content-Length tells us upfront
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BODY_BYTES) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new Error(
      `Response too large (${contentLength} bytes > ${MAX_RESPONSE_BODY_BYTES} limit). ` +
      "Use startLine/endLine to read a portion, or increase OPENGROK_MAX_FILE_SIZE."
    );
  }

  // Streaming path: count bytes as they arrive (handles chunked-encoded responses)
  if (!response.body) return response.text();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        throw new Error(
          `Response too large (>${MAX_RESPONSE_BODY_BYTES} bytes streamed). ` +
          "Use startLine/endLine to read a portion, or increase OPENGROK_MAX_FILE_SIZE."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
}
