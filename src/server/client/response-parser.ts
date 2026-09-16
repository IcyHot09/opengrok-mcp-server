/**
 * OpenGrok HTTP client subsystem - split from client.ts (pure move, no logic changes).
 */
import type { SearchResults, SearchTypeValue } from "../models.js";

// ---------------------------------------------------------------------------
// Internal: parse JSON search response
// ---------------------------------------------------------------------------

export function parseSearchResponse(
  data: Record<string, unknown>,
  searchType: SearchTypeValue,
  query: string
): SearchResults {
  const rawResults = (data["results"] as Record<string, Array<Record<string, unknown>>>) ?? {};
  const results: SearchResults["results"] = [];

  for (const [filePath, matches] of Object.entries(rawResults)) {
    const match = /^\/([^/]+)(\/.*)?$/.exec(filePath);
    const project = match?.[1] ?? "unknown";
    const path = match?.[2] ?? filePath;

    results.push({
      project,
      path,
      matches: matches.map((m) => ({
        lineNumber: Number(m["lineNumber"] ?? 0),
        lineContent: String(m["line"] ?? "").replace(/<\/?b>/gi, "")
          .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      })),
    });
  }

  return {
    query,
    searchType,
    totalCount: Number(data["resultCount"] ?? 0),
    timeMs: Number(data["time"] ?? 0),
    results,
    startIndex: Number(data["startDocument"] ?? 0),
    endIndex: Number(data["endDocument"] ?? 0),
  };
}
