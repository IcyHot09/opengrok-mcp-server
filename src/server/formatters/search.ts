/**
 * Formatter subsystem - split from formatters.ts (pure move, no logic changes).
 */
import { encode as toonEncode } from "@toon-format/toon";
import type {
  SearchResults,
} from "../models.js";
import { escapeMarkdownField, stripHtmlTags } from "./core.js";

// ---------------------------------------------------------------------------
// Search results -- compact one-line-per-match format
// ---------------------------------------------------------------------------

export function formatSearchResults(
  results: SearchResults,
): string {
  const lines: string[] = [];
  lines.push(
    `Search: "${escapeMarkdownField(results.query)}" -- ${results.totalCount.toLocaleString()} matches (${results.timeMs}ms)`
  );

  if (!results.results.length) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  for (const result of results.results) {
    for (const match of result.matches.slice(0, 5)) {
      lines.push(
        `${result.path} (${result.project}) L${match.lineNumber}: ${stripHtmlTags(match.lineContent).trim()}`
      );
    }
    if (result.matches.length > 5) {
      lines.push(`  ... +${result.matches.length - 5} more in ${result.path}`);
    }
  }

  if (results.endIndex < results.totalCount) {
    lines.push(
      `Showing ${results.results.length} of ${results.totalCount} results. Narrow query or increase max_results.`
    );
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Compound: search_and_read
// ---------------------------------------------------------------------------

export interface SearchAndReadEntry {
  project: string;
  path: string;
  matchLine: number;
  context: string;
  lang: string;
}

export function formatSearchAndRead(
  query: string,
  totalCount: number,
  entries: SearchAndReadEntry[]
): string {
  const lines: string[] = [];
  lines.push(
    `Search+Read: "${query}" -- ${totalCount.toLocaleString()} total matches, showing ${entries.length}`
  );

  for (const entry of entries) {
    lines.push(
      `\n--- ${entry.path} (${entry.project}) around L${entry.matchLine} ---`
    );
    lines.push(`\`\`\`${entry.lang}`);
    lines.push(entry.context);
    lines.push("```");
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Compound: batch_search
// ---------------------------------------------------------------------------

export function formatBatchSearchResults(
  queryResults: Array<{
    query: string;
    searchType: string;
    results: SearchResults;
  }>
): string {
  const lines: string[] = [];
  const totalMatches = queryResults.reduce(
    (s, r) => s + r.results.totalCount,
    0
  );
  lines.push(
    `Batch search: ${queryResults.length} queries, ${totalMatches.toLocaleString()} total matches`
  );

  for (const { query, searchType, results } of queryResults) {
    lines.push(`\n[${searchType}] "${query}" -- ${results.totalCount} matches:`);
    if (!results.results.length) {
      lines.push("  (no results)");
      continue;
    }
    for (const result of results.results) {
      for (const match of result.matches.slice(0, 3)) {
        lines.push(
          `  ${result.path} (${result.project}) L${match.lineNumber}: ${stripHtmlTags(match.lineContent).trim()}`
        );
      }
    }
  }

  return lines.join("\n");
}


export function formatBatchSearchResultsTSV(
  queryResults: Array<{
    query: string;
    searchType: string;
    results: SearchResults;
  }>
): string {
  const rows: string[] = [];
  const totalMatches = queryResults.reduce(
    (s, r) => s + r.results.totalCount,
    0
  );
  rows.push(
    `# Batch: ${queryResults.length} queries, ${totalMatches.toLocaleString()} total matches`
  );
  rows.push("query\tsearch_type\tpath\tproject\tline\tcontent");

  for (const { query, searchType, results } of queryResults) {
    if (!results.results.length) {
      rows.push(`${query}\t${searchType}\t(no results)\t\t\t`);
      continue;
    }

    for (const result of results.results) {
      for (const match of result.matches.slice(0, 5)) {
        const content = stripHtmlTags(match.lineContent)
          .trim()
          .replace(/\t/g, "  ")
          .replace(/\n/g, " ");
        rows.push(
          `${query}\t${searchType}\t${result.path}\t${result.project}\t${match.lineNumber}\t${content}`
        );
      }
      if (result.matches.length > 5) {
        rows.push(
          `${query}\t${searchType}\t# ... +${result.matches.length - 5} more in ${result.path}\t\t\t`
        );
      }
    }
  }

  return rows.join("\n");
}

/**
 * Format batch search results as TOON for maximum token density.
 */

export function formatBatchSearchResultsTOON(
  queryResults: Array<{
    query: string;
    searchType: string;
    results: SearchResults;
  }>
): string {
  const totalMatches = queryResults.reduce(
    (s, r) => s + r.results.totalCount,
    0
  );
  const matches: { query: string; type: string; path: string; project: string; line: number; content: string }[] = [];
  for (const { query, searchType, results } of queryResults) {
    for (const result of results.results) {
      for (const match of result.matches.slice(0, 5)) {
        matches.push({
          query,
          type: searchType,
          path: result.path,
          project: result.project,
          line: match.lineNumber,
          content: stripHtmlTags(match.lineContent).trim().replace(/,/g, ";"),
        });
      }
    }
  }
  const header = `# Batch: ${queryResults.length} queries, ${totalMatches.toLocaleString()} total matches\n`;
  if (matches.length === 0) return `${header}No results found.`;
  return header + toonEncode({ matches });
}


// ---------------------------------------------------------------------------
// COMPACT FORMATTERS — Phase 2 response format upgrades
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TSV: search results (~50% token savings vs JSON)
// Format: path\tproject\tline\tcontent
// ---------------------------------------------------------------------------

/**
 * Format search results as TSV (tab-separated).
 * Header row: path, project, line, content
 * ~50% fewer tokens than JSON; safe for C++ (no comma ambiguity).
 */
export function formatSearchResultsTSV(results: SearchResults): string {
  const rows: string[] = [];
  rows.push(
    `# Search: "${escapeMarkdownField(results.query)}" -- ${results.totalCount.toLocaleString()} matches (${results.timeMs}ms)`
  );
  rows.push("path\tproject\tline\tcontent");

  for (const result of results.results) {
    for (const match of result.matches.slice(0, 5)) {
      // Tabs in content → spaces; newlines → space — keeps TSV well-formed
      const content = stripHtmlTags(match.lineContent)
        .trim()
        .replace(/\t/g, "  ")
        .replace(/\n/g, " ");
      rows.push(`${result.path}\t${result.project}\t${match.lineNumber}\t${content}`);
    }
    if (result.matches.length > 5) {
      rows.push(`# ... +${result.matches.length - 5} more in ${result.path}`);
    }
  }

  if (results.endIndex < results.totalCount) {
    rows.push(
      `# Showing ${results.results.length} of ${results.totalCount}. Narrow query or increase max_results.`
    );
  }

  return rows.join("\n");
}


// ---------------------------------------------------------------------------
// TOON: Token-Oriented Object Notation (~40-60% fewer tokens than JSON)
// ---------------------------------------------------------------------------

/**
 * Format search results as TOON — optimal for uniform arrays of matches.
 * TOON uses explicit {field} headers and CSV-style rows for maximum token
 * density while maintaining LLM parseability.
 */
export function formatSearchResultsTOON(results: SearchResults): string {
  const matches: { path: string; project: string; line: number; content: string }[] = [];
  for (const result of results.results) {
    for (const match of result.matches.slice(0, 5)) {
      matches.push({
        path: result.path,
        project: result.project,
        line: match.lineNumber,
        content: stripHtmlTags(match.lineContent).trim().replace(/,/g, ";"),
      });
    }
  }
  const header = `# Search: "${escapeMarkdownField(results.query)}" -- ${results.totalCount.toLocaleString()} matches (${results.timeMs}ms)\n`;
  if (matches.length === 0) return `${header}No results found.`;
  return header + toonEncode({ matches });
}


// ---------------------------------------------------------------------------
// formatMoreResults — all matches in a single file
// ---------------------------------------------------------------------------

export function formatMoreResults(
  matches: Array<{ lineNumber: number; lineContent: string }>,
  project: string, path: string
): string {
  const filename = path.split("/").pop() ?? path;
  const lines: string[] = [`All matches in ${filename} (${project}): ${matches.length} lines`];
  if (!matches.length) { lines.push("No matches found."); return lines.join("\n"); }
  for (const m of matches) lines.push(`L${m.lineNumber}: ${m.lineContent.trim()}`);
  return lines.join("\n");
}

