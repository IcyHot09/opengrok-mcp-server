/**
 * Per-language import extraction using tree-sitter queries.
 *
 * Returns structured ImportInfo objects with specifier, kind classification,
 * and re-export detection. Falls back to empty array if tree-sitter unavailable.
 */

import { parseSource, queryNodes, isLanguageSupported } from "./tree-sitter.js";

export interface ImportInfo {
  specifier: string;
  kind: "local" | "external" | "builtin";
  line: number;
  isReExport: boolean;
}

// Tree-sitter queries per language family
const CPP_INCLUDE_QUERY = `(preproc_include path: (_) @path)`;

const JS_IMPORT_QUERY = `[
  (import_statement source: (string (string_fragment) @path))
  (export_statement source: (string (string_fragment) @path))
  (call_expression
    function: (identifier) @fn
    arguments: (arguments (string (string_fragment) @path))
    (#eq? @fn "require"))
]`;

// For TypeScript, the query syntax is the same as JS
const TS_IMPORT_QUERY = JS_IMPORT_QUERY;

const PYTHON_IMPORT_QUERY = `[
  (import_statement name: (dotted_name) @path)
  (import_from_statement module_name: (dotted_name) @path)
  (import_from_statement module_name: (relative_import) @path)
]`;

const JAVA_IMPORT_QUERY = `(import_declaration (scoped_identifier) @path)`;

const GO_IMPORT_QUERY = `(import_spec path: (interpreted_string_literal) @path)`;

const RUST_USE_QUERY = `(use_declaration argument: [
  (scoped_identifier) @path
  (identifier) @path
  (scoped_use_list path: (_) @rust_root list: (use_list) @rust_list)
  (use_wildcard (_) @rust_root)
  (use_as_clause path: (_) @rust_root)
])`;

const CSHARP_USING_QUERY = `(using_directive [
  (qualified_name) @path
  (identifier) @path
])`;

const RUBY_REQUIRE_QUERY = `(call
  method: (identifier) @fn
  arguments: (argument_list (string (string_content) @path))
  (#eq? @fn "require"))`;

const PHP_USE_QUERY = `(namespace_use_clause (qualified_name) @path)`;

const PERL_USE_QUERY = `(use_statement (package) @path)`;

const SWIFT_IMPORT_QUERY = `(import_declaration (identifier) @path)`;

const KOTLIN_IMPORT_QUERY = `(import_header (identifier) @path)`;

const R_LIBRARY_QUERY = `(call
  (identifier) @fn
  (arguments (argument) @path)
  (#match? @fn "^(library|require)$"))`;

function getQuery(lang: string): string | null {
  switch (lang) {
    case "c":
    case "cpp":
      return CPP_INCLUDE_QUERY;
    case "typescript":
    case "tsx":
    case "jsx":
      return TS_IMPORT_QUERY;
    case "javascript":
      return JS_IMPORT_QUERY;
    case "python":
      return PYTHON_IMPORT_QUERY;
    case "java":
      return JAVA_IMPORT_QUERY;
    case "go":
    case "golang":
      return GO_IMPORT_QUERY;
    case "rust":
      return RUST_USE_QUERY;
    case "csharp":
    case "c_sharp":
      return CSHARP_USING_QUERY;
    case "ruby":
      return RUBY_REQUIRE_QUERY;
    case "php":
      return PHP_USE_QUERY;
    case "perl":
      return PERL_USE_QUERY;
    case "swift":
      return SWIFT_IMPORT_QUERY;
    case "kotlin":
      return KOTLIN_IMPORT_QUERY;
    case "r":
      return R_LIBRARY_QUERY;
    default:
      return null;
  }
}

function classifyCpp(rawText: string): "local" | "builtin" {
  const isAngle = rawText.startsWith("<") || rawText.startsWith("&lt;");
  if (!isAngle) return "local";
  // Angle-bracket includes with a '/' are project-internal (e.g. <myapp/types.h>).
  // Angle-bracket includes ending in '.h' are also project headers — modern C++ stdlib
  // headers have no extension (<string>, <vector>). C stdlib headers (<stdio.h>) are
  // rarely indexed as project files so treating them as local is harmless.
  return rawText.includes("/") || rawText.endsWith(".h>") ? "local" : "builtin";
}

function classifyJs(specifier: string): "local" | "external" {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "local";
  return "external";
}

type QueryMatchT = ReturnType<typeof queryNodes>[number];

/**
 * Expand a Rust grouped/glob/aliased use into full-path specifiers.
 * Returns null for plain forms (handled by the generic @path loop).
 * `use std::{io, fs}` → ["std::io", "std::fs"]; `use foo::*` → ["foo"].
 */
function expandRustGroupedUse(match: QueryMatchT): ImportInfo[] | null {
  const rootCapture = match.captures.find((c) => c.name === "rust_root");
  if (!rootCapture) return null;
  const rootText: string = rootCapture.node.text;
  const line: number = rootCapture.node.startPosition.row + 1;
  const listCapture = match.captures.find((c) => c.name === "rust_list");
  if (!listCapture) return [{ specifier: rootText, kind: "external", line, isReExport: false }];
  const out: ImportInfo[] = [];
  for (const child of listCapture.node.namedChildren) {
    const text: string = child.text;
    if (!text) continue;
    // `self` refers to the root itself: `use foo::{self}` ≡ `use foo`
    const specifier = text === "self" ? rootText : `${rootText}::${text}`;
    out.push({ specifier, kind: "external", line, isReExport: false });
  }
  return out;
}

/**
 * Extract imports from source code using tree-sitter.
 * Returns empty array if language unsupported or parse fails.
 */
export async function extractImportsTreeSitter(
  content: string,
  lang: string,
): Promise<ImportInfo[]> {
  if (!isLanguageSupported(lang)) return [];

  const tree = await parseSource(content, lang);
  if (!tree) return [];

  try {
    const query = getQuery(lang);
    if (!query) return [];

    const matches = queryNodes(tree, query, lang);
    const seen = new Set<string>();
    const imports: ImportInfo[] = [];

    for (const match of matches) {
      // Rust grouped/glob/aliased uses need per-match expansion into full paths
      if (lang === "rust") {
        const expanded = expandRustGroupedUse(match);
        if (expanded) {
          for (const imp of expanded) {
            if (!imp.specifier || seen.has(imp.specifier)) continue;
            seen.add(imp.specifier);
            imports.push(imp);
          }
          continue;
        }
      }
      for (const capture of match.captures) {
        if (capture.name === "fn") continue; // skip the "require" function name capture

        const node = capture.node;
        const rawText: string = node.text;
        // Strip quotes if present
        const specifier = rawText.replace(/^["'`<]|["'`>]$/g, "");

        if (!specifier || seen.has(specifier)) continue;
        seen.add(specifier);

        const line: number = node.startPosition.row + 1; // 0-indexed → 1-indexed
        const isCpp = lang === "c" || lang === "cpp";

        // Detect re-exports: parent is export_statement
        const isReExport =
          !isCpp && node.parent?.parent?.type === "export_statement";

        const kind: ImportInfo["kind"] = isCpp
          ? classifyCpp(rawText)
          : classifyJs(specifier);

        imports.push({ specifier, kind, line, isReExport });
      }
    }

    return imports;
  } finally {
    tree.delete();
  }
}
