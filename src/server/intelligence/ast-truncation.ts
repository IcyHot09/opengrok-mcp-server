/**
 * AST-aware truncation and signature extraction.
 *
 * Uses tree-sitter to identify top-level symbol boundaries (functions, classes,
 * interfaces, namespaces) so that file content can be truncated at clean
 * boundaries rather than mid-definition.
 */

import { parseSource, queryNodes, isLanguageSupported, type SyntaxNode } from "./tree-sitter.js";

export interface SymbolInfo {
  name: string;
  signature: string;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  kind: "function" | "class" | "method" | "interface" | "namespace" | "macro" | "table" | "procedure";
}

export interface TruncationResult {
  content: string;
  includedLines: number;
  totalLines: number;
  symbols: SymbolInfo[];
  truncatedAtLine: number;
}

export interface SnippetExpansion {
  expandedContent: string;
  functionName: string;
  functionStartLine: number;
  functionEndLine: number;
}

// --- Queries per language ---

const CPP_QUERIES = [
  `(function_definition) @def`,
  `(class_specifier) @def`,
  `(struct_specifier) @def`,
  `(namespace_definition) @def`,
  `(preproc_def) @def`,
  `(preproc_function_def) @def`,
];

const JS_QUERIES = [
  `(function_declaration) @def`,
  `(class_declaration) @def`,
  `(export_statement (function_declaration) @def)`,
  `(export_statement (class_declaration) @def)`,
];

const TS_QUERIES = [
  `(function_declaration) @def`,
  `(class_declaration) @def`,
  `(export_statement (function_declaration) @def)`,
  `(export_statement (class_declaration) @def)`,
  `(interface_declaration) @def`,
];

const PYTHON_QUERIES = [
  `(function_definition) @def`,
  `(class_definition) @def`,
];

const JAVA_QUERIES = [
  `(method_declaration) @def`,
  `(constructor_declaration) @def`,
  `(class_declaration) @def`,
  `(interface_declaration) @def`,
  `(enum_declaration) @def`,
  `(record_declaration) @def`,
];

const CSHARP_QUERIES = [
  `(method_declaration) @def`,
  `(constructor_declaration) @def`,
  `(class_declaration) @def`,
  `(interface_declaration) @def`,
  `(enum_declaration) @def`,
  `(struct_declaration) @def`,
  `(record_declaration) @def`,
];

const GO_QUERIES = [
  `(function_declaration) @def`,
  `(method_declaration) @def`,
];

const RUST_QUERIES = [
  `(function_item) @def`,
  `(struct_item) @def`,
  `(enum_item) @def`,
  `(trait_item) @def`,
  `(type_item) @def`,
];

const RUBY_QUERIES = [
  `(method) @def`,
  `(singleton_method) @def`,
  `(class) @def`,
  `(module) @def`,
];

const PHP_QUERIES = [
  `(function_definition) @def`,
  `(method_declaration) @def`,
  `(class_declaration) @def`,
  `(interface_declaration) @def`,
  `(trait_declaration) @def`,
];

// SQL: CREATE TABLE / CREATE FUNCTION parse cleanly in the grammar.
// CREATE PROCEDURE has no node type in this grammar, so vendor procedures
// are recovered by a regex fallback below (see extractSqlProcedures).
const SQL_QUERIES = [
  `(create_table) @def`,
  `(create_function) @def`,
];

const SQL_PROCEDURE_LINE_RE =
  /^\s*CREATE\s+(?:OR\s+ALTER\s+)?PROCEDURE\s+((?:\[[^\]\s.]+\]|"[^"\s.]+"|\w+)(?:\s*\.\s*(?:\[[^\]\s.]+\]|"[^"\s.]+"|\w+))*)/i;
const SQL_NEXT_DDL_RE =
  /^\s*(GO\b|CREATE\s+(?:OR\s+ALTER\s+)?(?:PROCEDURE|FUNCTION|TABLE|VIEW|TRIGGER|INDEX)\b)/i;

/**
 * Recover CREATE PROCEDURE definitions that the SQL grammar cannot represent
 * as AST nodes. Procedure bodies end at GO, the next DDL statement, or EOF.
 */
function extractSqlProcedures(
  content: string,
  existing: SymbolInfo[],
): SymbolInfo[] {
  const lines = content.split("\n");
  const takenStartLines = new Set(existing.map((s) => s.startLine));
  const procedures: SymbolInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SQL_PROCEDURE_LINE_RE);
    if (!match || takenStartLines.has(i + 1)) continue;

    let endLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (SQL_NEXT_DDL_RE.test(lines[j])) break;
      endLine = j;
    }

    procedures.push({
      name: match[1].replace(/[\[\]"]/g, ""),
      signature: lines[i].trim().slice(0, 160),
      startLine: i + 1,
      endLine: endLine + 1,
      kind: "procedure",
    });
  }
  return procedures;
}

const PERL_QUERIES = [
  `(subroutine_declaration_statement) @def`,
];

const POWERSHELL_QUERIES = [
  `(function_statement) @def`,
  `(class_statement) @def`,
  `(class_method_definition) @def`,
];

const SWIFT_QUERIES = [
  `(function_declaration) @def`,
  `(class_declaration) @def`,
  `(protocol_declaration) @def`,
];

const R_QUERIES = [
  `(function_definition) @def`,
];

const LUA_QUERIES = [
  `(function_declaration) @def`,
];

const KOTLIN_QUERIES = [
  `(function_declaration) @def`,
  `(class_declaration) @def`,
];

const LISP_QUERIES = [
  `(defun) @def`,
];

function getQueries(lang: string): string[] | null {
  switch (lang) {
    case "c":
    case "cpp":
      return CPP_QUERIES;
    case "javascript":
      return JS_QUERIES;
    case "typescript":
    case "tsx":
    case "jsx":
      return TS_QUERIES;
    case "python":
      return PYTHON_QUERIES;
    case "java":
      return JAVA_QUERIES;
    case "csharp":
    case "c_sharp":
      return CSHARP_QUERIES;
    case "go":
    case "golang":
      return GO_QUERIES;
    case "rust":
      return RUST_QUERIES;
    case "ruby":
      return RUBY_QUERIES;
    case "php":
      return PHP_QUERIES;
    case "sql":
      return SQL_QUERIES;
    case "perl":
      return PERL_QUERIES;
    case "powershell":
      return POWERSHELL_QUERIES;
    case "swift":
      return SWIFT_QUERIES;
    case "r":
      return R_QUERIES;
    case "lua":
      return LUA_QUERIES;
    case "kotlin":
      return KOTLIN_QUERIES;
    case "commonlisp":
    case "lisp":
      return LISP_QUERIES;
    default:
      return null;
  }
}

function classifyKind(nodeType: string): SymbolInfo["kind"] {
  switch (nodeType) {
    case "function_definition":
    case "function_declaration":
    case "function_item":
      return "function";
    case "class_declaration":
    case "class_specifier":
    case "class_definition":
    case "class":
    case "enum_declaration":
    case "enum_item":
    case "struct_declaration":
    case "struct_specifier":
    case "record_declaration":
    case "struct_item":
    case "type_item":
      return "class";
    case "create_table":
      return "table";
    case "create_procedure":
      return "procedure";
    case "subroutine_declaration_statement": // Perl
    case "function_statement": // PowerShell
    case "defun": // Common Lisp
      return "function";
    case "class_statement":
      return "class";
    case "protocol_declaration":
      return "interface";
    case "class_method_definition":
      return "method";
    case "interface_declaration":
    case "trait_item":
    case "trait_declaration":
      return "interface";
    case "namespace_definition":
    case "module":
      return "namespace";
    case "method_definition":
    case "method_declaration":
    case "constructor_declaration":
    case "singleton_method":
      return "method";
    case "preproc_def":
    case "preproc_function_def":
      return "macro";
    default:
      return "function";
  }
}

/**
 * Definition node types recognized across grammars. Names are resolved via
 * getDefinitionName (field lookup first, then grammar-specific fallbacks).
 */
const DEFINITION_NODE_TYPES = new Set([
  "function_declaration", // JS/TS, Swift, Kotlin, Lua
  "method_definition", // JS/TS class methods
  "function_definition", // Python, PHP, R
  "method_declaration", // Java, C#, PHP
  "constructor_declaration", // Java, C#
  "function_item", // Rust
  "method", // Ruby
  "singleton_method", // Ruby class methods
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "enum_declaration",
  "struct_item",
  "trait_item",
  "subroutine_declaration_statement", // Perl
  "function_statement", // PowerShell
  "class_statement", // PowerShell
  "class_method_definition", // PowerShell
  "protocol_declaration", // Swift
  "defun", // Common Lisp
]);

/**
 * Resolve the name of a definition node. Falls back to grammar-specific
 * child inspection for languages whose definitions lack a "name" field.
 * Returns null when the node is not a recognized definition.
 */
export function getDefinitionName(node: SyntaxNode, lang: string): string | null {
  if (!DEFINITION_NODE_TYPES.has(node.type)) return null;

  const byField = node.childForFieldName("name");
  // R: `name <- function(...)` — the "name" field points at the keyword, not the binding
  if (byField && !(lang === "r" && node.type === "function_definition")) {
    return byField.text;
  }

  switch (node.type) {
    case "function_statement": // PowerShell: function <function_name> { }
      return node.children.find((c) => c?.type === "function_name")?.text ?? null;
    case "class_statement": // PowerShell: class <simple_name> { }
      return node.children.find((c) => c?.type === "simple_name")?.text ?? null;
    case "class_method_definition": // PowerShell: [type] <simple_name>( )
      return node.children.find((c) => c?.type === "simple_name")?.text ?? null;
    case "function_declaration": // Kotlin/Swift-style: fun <simple_identifier>(
    case "class_declaration": {
      const ident = node.children.find(
        (c) => c?.type === "simple_identifier" || c?.type === "type_identifier",
      );
      return ident?.text ?? null;
    }
    case "defun": { // Common Lisp: (defun <symbol> …) — name lives in defun_header
      const header = node.children.find((c) => c?.type === "defun_header");
      const symbol = header?.children.find((c) => c !== null && c.isNamed && c.type !== "defun_keyword");
      return symbol?.text ?? null;
    }
    case "function_definition": { // R assignment form: <name> <- function(…)
      if (lang === "r" && node.parent) {
        const binding = node.parent.children.find((c) => c !== null && c.id !== node.id && c.isNamed);
        return binding?.text ?? null;
      }
      return byField?.text ?? null;
    }
    default:
      return byField?.text ?? null;
  }
}

function extractName(node: SyntaxNode, lang: string): string {
  const nodeType = node.type as string;
  const isCpp = lang === "c" || lang === "cpp";

  if (isCpp && nodeType === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    if (declarator) {
      const name = extractDeclaratorName(declarator);
      if (name) return name;
    }
  }

  // SQL: CREATE TABLE / CREATE FUNCTION carry the name in an object_reference child
  if (nodeType === "create_table" || nodeType === "create_function" || nodeType === "create_procedure") {
    const objRef = node.children.find((c) => c?.type === "object_reference");
    if (objRef) return objRef.text;
  }

  // Grammar-specific definition-name resolution (PowerShell, Kotlin, R, Common Lisp…)
  const defName = getDefinitionName(node, lang);
  if (defName) return defName;

  // Common: childForFieldName("name")
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  return "<anonymous>";
}

function extractDeclaratorName(node: SyntaxNode): string | null {
  if (!node) return null;
  const type = node.type as string;
  if (type === "identifier" || type === "field_identifier" || type === "destructor_name") {
    return node.text;
  }
  if (type === "qualified_identifier" || type === "template_function") {
    const nameNode = node.childForFieldName("name");
    return nameNode?.text ?? node.text;
  }
  if (type === "function_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractDeclaratorName(inner);
  }
  if (type === "pointer_declarator" || type === "reference_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractDeclaratorName(inner);
  }
  return node.text ?? null;
}

function extractSignature(node: SyntaxNode): string {
  const text = node.text as string;
  const braceIdx = text.indexOf("{");
  // Brace-less languages (Python, Ruby, Lua…): signature ends at the first line break.
  if (braceIdx === -1) {
    const newlineIdx = text.indexOf("\n");
    return (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trimEnd();
  }
  return text.slice(0, braceIdx).trimEnd();
}

export async function extractSignatures(
  content: string,
  language: string,
): Promise<SymbolInfo[] | null> {
  if (!isLanguageSupported(language)) return null;

  const queries = getQueries(language);
  if (!queries) return null;

  const tree = await parseSource(content, language);
  if (!tree) return null;

  try {
    const seen = new Set<string>(); // dedupe by "name:startLine"
    const symbols: SymbolInfo[] = [];

    for (const q of queries) {
      const matches = queryNodes(tree, q, language);
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name !== "def") continue;
          const node = capture.node;
          const startLine = (node.startPosition.row as number) + 1;
          const endLine = (node.endPosition.row as number) + 1;
          const name = extractName(node, language);
          const key = `${name}:${startLine}:${endLine}`;
          if (seen.has(key)) continue;
          seen.add(key);

          symbols.push({
            name,
            signature: extractSignature(node),
            startLine,
            endLine,
            kind: classifyKind(node.type),
          });
        }
      }
    }

    if (language === "sql") {
      symbols.push(...extractSqlProcedures(content, symbols));
    }

    symbols.sort((a, b) => a.startLine - b.startLine);
    return symbols.length > 0 ? symbols : null;
  } finally {
    tree.delete();
  }
}

export async function truncateAtBoundary(
  content: string,
  maxLines: number,
  language: string,
): Promise<TruncationResult | null> {
  const symbols = await extractSignatures(content, language);
  if (!symbols || symbols.length === 0) return null;

  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return {
      content,
      includedLines: totalLines,
      totalLines,
      symbols,
      truncatedAtLine: totalLines,
    };
  }

  // Greedily include complete symbols whose endLine <= maxLines
  let truncatedAtLine = 0;
  for (const sym of symbols) {
    if (sym.endLine <= maxLines) {
      truncatedAtLine = sym.endLine;
    }
  }

  if (truncatedAtLine === 0) {
    // No complete symbol fits — include up to the line before the first symbol.
    // If the first symbol starts at line 1 there is nothing useful to include.
    const preBoundary = symbols[0].startLine - 1;
    if (preBoundary <= 0) return null;
    truncatedAtLine = Math.min(preBoundary, maxLines);
  }

  const includedContent = lines.slice(0, truncatedAtLine).join("\n");

  return {
    content: includedContent,
    includedLines: truncatedAtLine,
    totalLines,
    symbols,
    truncatedAtLine,
  };
}

export async function expandToFunctionBoundary(
  content: string,
  matchLine: number,
  language: string,
  maxLines: number,
): Promise<SnippetExpansion | null> {
  if (!isLanguageSupported(language)) return null;

  const symbols = await extractSignatures(content, language);
  if (!symbols) return null;

  // Find the symbol containing matchLine
  const containing = symbols.find(
    (s) =>
      matchLine >= s.startLine &&
      matchLine <= s.endLine &&
      (s.kind === "function" || s.kind === "method" || s.kind === "procedure"),
  );
  if (!containing) return null;

  const lines = content.split("\n");
  const funcLines = lines.slice(containing.startLine - 1, containing.endLine);
  const funcLength = funcLines.length;

  if (funcLength <= maxLines) {
    return {
      expandedContent: funcLines.join("\n"),
      functionName: containing.name,
      functionStartLine: containing.startLine,
      functionEndLine: containing.endLine,
    };
  }

  // Function is too long — return signature + context around matchLine + closing
  const signature = containing.signature;
  const closingLine = lines[containing.endLine - 1];

  // Calculate context window around matchLine
  const contextBudget = maxLines - 3; // reserve for signature, ..., closing
  const halfContext = Math.floor(contextBudget / 2);
  const contextStart = Math.max(containing.startLine, matchLine - halfContext);
  const contextEnd = Math.min(containing.endLine, matchLine + halfContext);

  const contextLines = lines.slice(contextStart - 1, contextEnd);
  const parts: string[] = [];

  if (contextStart > containing.startLine) {
    parts.push(signature);
    parts.push("  // ...");
  }
  parts.push(...contextLines);
  if (contextEnd < containing.endLine) {
    parts.push("  // ...");
    parts.push(closingLine);
  }

  return {
    expandedContent: parts.join("\n"),
    functionName: containing.name,
    functionStartLine: containing.startLine,
    functionEndLine: containing.endLine,
  };
}
