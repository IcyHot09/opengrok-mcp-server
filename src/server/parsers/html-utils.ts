/**
 * Parser subsystem - split from parsers.ts (pure move, no logic changes).
 */

/** Decode common HTML entities. */
/** Decode common HTML entities. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?59;/g, ";")
    .replace(/&apos;/g, "'");
}
