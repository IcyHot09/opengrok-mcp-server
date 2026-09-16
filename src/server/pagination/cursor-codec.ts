/**
 * Cursor codec — encodes/decodes pagination state into opaque cursor tokens.
 * Cursors are base64url-encoded JSON. Stateless (no server-side storage needed
 * for offset/page cursors — offsets travel inside the token itself).
 */

export type CursorState =
  | { t: "offset"; v: number; m?: OffsetCursorMethod }
  | { t: "page"; p: number }
  | { t: "raw"; v: string };

/** Methods that mint offset cursors — used to reject cross-method cursor reuse. */
export type OffsetCursorMethod = "search" | "history" | "findFile" | "browse" | "symbols" | "diff";

/** Default page size for history pagination. */
export const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Encode pagination state into an opaque cursor string.
 * The LLM passes this back verbatim on the next call.
 */
export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

/**
 * Decode an opaque cursor string back into pagination state.
 * Returns null if the cursor is invalid/corrupted (caller should treat as expired).
 */
export function decodeCursor(cursor: string): CursorState | null {
  if (cursor.length > 4096) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.t === "offset" && typeof parsed.v === "number") {
      if (!Number.isInteger(parsed.v) || parsed.v < 0 || parsed.v > 10_000_000) return null;
      //Preserved verbatim; unknown values fail closed at isOffsetCursorFor.
      const m = typeof parsed.m === "string" ? (parsed.m as OffsetCursorMethod) : undefined;
      return m === undefined ? { t: "offset", v: parsed.v } : { t: "offset", v: parsed.v, m };
    }
    if (parsed.t === "page" && typeof parsed.p === "number") {
      if (!Number.isInteger(parsed.p) || parsed.p < 0 || parsed.p > 10_000_000) return null;
      return { t: "page", p: parsed.p };
    }
    if (parsed.t === "raw" && typeof parsed.v === "string") {
      if (parsed.v.length > 1024) return null;
      return { t: "raw", v: parsed.v };
    }
    return null;
  } catch {
    return null;
  }
}

/** Standard expired-cursor response shape. */
export const CURSOR_EXPIRED = {
  _cursorExpired: true,
  message: "Cursor expired or invalid — reissue without cursor to start fresh.",
} as const;

/**
 * Validate a decoded offset cursor for the calling method. Legacy cursors
 * without a method tag are accepted (predate tagging); a mismatched tag
 * means the cursor belongs to another method's result space.
 */
export function isOffsetCursorFor(
  state: CursorState | null,
  method: OffsetCursorMethod,
): state is Extract<CursorState, { t: "offset" }> {
  if (!state || state.t !== "offset") return false;
  return state.m === undefined || state.m === method;
}
