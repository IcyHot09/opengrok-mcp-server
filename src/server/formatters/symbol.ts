/**
 * Formatter subsystem - split from formatters.ts (pure move, no logic changes).
 */
import { dump as yamlDump } from "js-yaml";
import type {
  FileSymbols,
} from "../models.js";
import type { CompileInfo } from "../local/compile-info.js";
import { stripHtmlTags } from "./core.js";

// ---------------------------------------------------------------------------
// Compound: get_symbol_context
// ---------------------------------------------------------------------------

export interface SymbolContextResult {
  found: boolean;
  symbol: string;
  kind: string;
  definition?: {
    project: string;
    path: string;
    line: number;
    context: string;
    lang: string;
  };
  header?: {
    project: string;
    path: string;
    context: string;
    lang: string;
  };
  references: {
    totalFound: number;
    samples: Array<{
      path: string;
      project: string;
      lineNumber: number;
      content: string;
    }>;
  };
  fileSymbols?: Array<{ symbol: string; type: string; line: number }>;
}

export function formatSymbolContext(result: SymbolContextResult): string {
  if (!result.found) {
    return `Symbol "${result.symbol}" not found.`;
  }

  const lines: string[] = [];
  lines.push(`Symbol: ${result.symbol} (${result.kind})`);

  /* v8 ignore start */
  if (result.definition) {
  /* v8 ignore stop */
    const d = result.definition;
    lines.push(`\nDefinition: ${d.path} (${d.project}) L${d.line}`);
    lines.push(`\`\`\`${d.lang}`);
    lines.push(d.context);
    lines.push("```");
  }

  if (result.header) {
    const h = result.header;
    lines.push(`\nHeader: ${h.path} (${h.project})`);
    lines.push(`\`\`\`${h.lang}`);
    lines.push(h.context);
    lines.push("```");
  }

  if (result.references.totalFound > 0) {
    lines.push(`\nReferences: ${result.references.totalFound} total`);
    for (const ref of result.references.samples) {
      lines.push(
        `  ${ref.path} (${ref.project}) L${ref.lineNumber}: ${stripHtmlTags(ref.content).trim()}`
      );
    }
  } else {
    lines.push("\nReferences: none found");
  }

  if (result.fileSymbols && result.fileSymbols.length > 0) {
    lines.push(`\nFile symbols (${result.fileSymbols.length}):`);
    // Group by type for compact display
    const byType = new Map<string, typeof result.fileSymbols>();
    for (const s of result.fileSymbols) {
      if (!byType.has(s.type)) byType.set(s.type, []);
      const arr = byType.get(s.type);
      if (arr) arr.push(s);
    }
    for (const [type, syms] of byType) {
      const sorted = [...syms].sort((a, b) => a.line - b.line);
      lines.push(`  ${type}: ${sorted.map((s) => `${s.symbol}:L${s.line}`).join(", ")}`);
    }
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Local: get_compile_info
// ---------------------------------------------------------------------------

export function formatCompileInfo(
  info: CompileInfo | null,
  requestedPath: string
): string {
  if (!info) {
    const name =
      /* v8 ignore next */ requestedPath.split(/[/\\]/).pop() ?? requestedPath;
    return `No compile information found for: ${name}`;
  }

  const lines: string[] = [];
  const filename = /* v8 ignore next */ info.file.split(/[/\\]/).pop() ?? info.file;
  lines.push(`Compile: ${filename}`);
  lines.push(`  file:     ${info.file}`);
  lines.push(`  compiler: ${info.compiler}`);
  if (info.standard) {
    lines.push(`  std:      ${info.standard}`);
  }
  if (info.includes.length) {
    lines.push(`  includes (${info.includes.length}):`);
    for (const inc of info.includes) {
      lines.push(`    ${inc}`);
    }
  }
  if (info.defines.length) {
    // Compact: all defines on one line; each is short
    lines.push(`  defines:  ${info.defines.join("  ")}`);
  }
  if (info.extraFlags.length) {
    lines.push(`  flags:    ${info.extraFlags.join(" ")}`);
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// get_file_symbols
// ---------------------------------------------------------------------------

export function formatFileSymbols(result: FileSymbols): string {
  const filename = /* v8 ignore next */ result.path.split("/").pop() ?? result.path;
  const lines: string[] = [];

  if (!result.symbols.length) {
    lines.push(`Symbols: ${filename} (${result.project}) -- 0 symbols`);
    lines.push("No symbols found.");
    return lines.join("\n");
  }

  lines.push(`Symbols: ${filename} (${result.project}) -- ${result.symbols.length} symbols`);

  // Group by type, sort each group by line number
  const groups = new Map<string, typeof result.symbols>();
  for (const sym of result.symbols) {
    const key = sym.type ?? "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    const arr = groups.get(key);
    if (arr) arr.push(sym);
  }

  // Sort groups by first occurrence line (keeps logical order)
  const sortedGroups = [...groups.entries()].sort(
    ([, a], [, b]) => (a[0]?.lineStart ?? 0) - (b[0]?.lineStart ?? 0)
  );

  for (const [type, syms] of sortedGroups) {
    const sorted = [...syms].sort((a, b) => (a.lineStart ?? a.line) - (b.lineStart ?? b.line));
    lines.push(`\n${type} (${sorted.length}):`);
    for (const sym of sorted) {
      const lineNum = sym.lineStart ?? sym.line;
      let entry = `  ${sym.symbol}  L${lineNum}`;
      if (sym.signature) {
        const sig = sym.signature.length > 80 ? sym.signature.slice(0, 77) + "..." : sym.signature;
        entry += `  ${sig}`;
      }
      lines.push(entry);
    }
  }

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// YAML: symbol context (~35% savings, preserves hierarchy, handles C++ safely)
// ---------------------------------------------------------------------------

/**
 * Format symbol context result as YAML.
 * Uses js-yaml with block scalars for code content — handles C++ safely
 * (colons, braces, hashes in code won't break YAML structure).
 */
export function formatSymbolContextYAML(result: SymbolContextResult): string {
  if (!result.found) {
    return yamlDump({ found: false, symbol: result.symbol, kind: result.kind });
  }

  const doc: Record<string, unknown> = {
    found: true,
    symbol: result.symbol,
    kind: result.kind,
  };

  if (result.definition) {
    const d = result.definition;
    doc["definition"] = {
      project: d.project,
      path: d.path,
      line: d.line,
      lang: d.lang,
      // Block scalar (literal | style) prevents C++ code from breaking YAML
      context: d.context,
    };
  }

  if (result.header) {
    const h = result.header;
    doc["header"] = {
      project: h.project,
      path: h.path,
      lang: h.lang,
      context: h.context,
    };
  }

  doc["references"] = {
    totalFound: result.references.totalFound,
    samples: result.references.samples.map((s) => ({
      path: s.path,
      project: s.project,
      line: s.lineNumber,
      content: stripHtmlTags(s.content).trim(),
    })),
  };

  if (result.fileSymbols && result.fileSymbols.length > 0) {
    doc["fileSymbols"] = result.fileSymbols.map((s) => ({
      symbol: s.symbol,
      type: s.type,
      line: s.line,
    }));
  }

  return yamlDump(doc, {
    lineWidth: 120,
    quoteStyle: "single",
    forceQuotes: false,
    noRefs: true,
  });
}

