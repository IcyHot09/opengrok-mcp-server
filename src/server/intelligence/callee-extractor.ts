/**
 * Extract function calls (callees) from within a specific function body.
 *
 * Uses tree-sitter to locate the target function definition, then walks
 * call expressions within its body to identify what it calls.
 */

import { parseSource, isLanguageSupported, type SyntaxNode } from "./tree-sitter.js";
import { getDefinitionName } from "./ast-truncation.js";

export interface CalleeInfo {
  name: string;
  line: number;
}

/** Node types representing a function/method invocation across grammars. */
const CALL_NODE_TYPES = new Set([
  "call_expression", // C/C++, JS/TS, Go, Rust, C#, Swift, Kotlin
  "call", // Python, Ruby, R
  "method_invocation", // Java
  "function_call_expression", // Perl
  "method_call_expression", // Perl
  "function_call", // Lua
  "command", // PowerShell
]);

/**
 * Find the function/method definition node matching the given name.
 */
function findFunctionNode(root: SyntaxNode, funcName: string, lang: string): SyntaxNode | null {
  const isCpp = lang === "c" || lang === "cpp";

  let nodesProcessed = 0;
  const queue: SyntaxNode[] = [root];
  // Index pointer instead of shift(): identical BFS order, O(1) dequeue.
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (++nodesProcessed > 50_000) break;

    if (isCpp && node.type === "function_definition") {
      const declarator = node.childForFieldName("declarator");
      if (declarator && extractDeclaratorName(declarator) === funcName) return node;
    } else if (!isCpp) {
      if (getDefinitionName(node, lang) === funcName) return node;
      // Variable declaration with arrow function: const foo = (...) => { ... }
      if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
        for (let i = 0; i < node.childCount; i++) {
          const decl = node.child(i);
          if (decl?.type === "variable_declarator") {
            const name = decl.childForFieldName("name");
            const value = decl.childForFieldName("value");
            if (name?.text === funcName && value?.type === "arrow_function") return value;
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }

  return null;
}

/**
 * Extract the function name from a C++ declarator node.
 */
function extractDeclaratorName(node: SyntaxNode): string | null {
  if (node.type === "qualified_identifier" || node.type === "template_function") {
    // Recurse into the name field — it may itself be a qualified_identifier
    // (A::B::method) or template_function, so we keep unwrapping until we
    // reach a leaf identifier or destructor_name.
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    if (nameNode.type === "identifier" || nameNode.type === "destructor_name") return nameNode.text;
    return extractDeclaratorName(nameNode);
  }
  if (node.type === "function_declarator") {
    const declarator = node.childForFieldName("declarator");
    if (declarator) return extractDeclaratorName(declarator);
  }
  if (node.type === "identifier" || node.type === "field_identifier" || node.type === "destructor_name") {
    return node.text;
  }
  if (node.type === "pointer_declarator" || node.type === "reference_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractDeclaratorName(inner);
  }
  return null;
}

/**
 * Walk a function body and collect all call_expression nodes.
 */
function collectCallExpressions(body: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  let nodesProcessed = 0;
  const queue: SyntaxNode[] = [body];
  // Index pointer instead of shift(): identical BFS order, O(1) dequeue.
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (++nodesProcessed > 50_000) break; // guard against error-recovery tree explosion
    if (CALL_NODE_TYPES.has(node.type)) {
      calls.push(node);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }
  return calls;
}

/**
 * Extract the callee name from a call node.
 * Handles: foo(), obj.method(), obj->method(), await foo(), Python/Ruby calls,
 * Java method invocations, Go selectors, C# member access, Perl/PowerShell/Lua
 * invocations, and Swift/Kotlin first-child callee shapes.
 */
function getCalleeName(callNode: SyntaxNode): string | null {
  // Java: the invocation node itself carries the method name in a "name" field.
  if (callNode.type === "method_invocation") {
    const name = callNode.childForFieldName("name");
    return name?.text ?? null;
  }

  const fn =
    callNode.childForFieldName("function") ??
    callNode.childForFieldName("method") ?? // Perl obj->method()
    callNode.childForFieldName("command_name"); // PowerShell Start-Process …

  if (!fn) {
    // Swift/Kotlin/Lua grammars expose the callee as the first named child
    if (callNode.type === "call_expression" || callNode.type === "function_call") {
      return callNode.children.find((c) => c !== null && c.isNamed)?.text ?? null;
    }
    return null;
  }

  switch (fn.type) {
    case "identifier":
      return fn.text;
    case "field_expression":
    case "member_expression": {
      const field = fn.childForFieldName("field") ?? fn.childForFieldName("property");
      return field?.text ?? null;
    }
    case "attribute": // Python obj.method()
    case "selector_expression": {
      const field = fn.childForFieldName("attribute") ?? fn.childForFieldName("field");
      return field?.text ?? null;
    }
    case "member_access_expression": {
      const field = fn.childForFieldName("name");
      return field?.text ?? null;
    }
    case "scoped_identifier":
    case "qualified_identifier": {
      const name = fn.childForFieldName("name");
      return name?.text ?? fn.text;
    }
    case "parenthesized_expression": {
      // C/C++ casts like (DWORD)GetValue() parse as call_expression whose
      // "function" holds only a type identifier. Genuine function-pointer
      // calls like (*fp)(x) contain operator/unary nodes — keep those.
      const inner = fn.namedChildren.filter(Boolean);
      if (inner.length === 1 &&
          ["identifier", "type_identifier", "primitive_type", "sized_type_specifier", "type_descriptor"].includes(inner[0].type)) {
        return null;
      }
      return fn.text;
    }
    default:
      return fn.text;
  }
}

/**
 * Extract all callees from a named function in the given source code.
 * Returns empty array if function not found, language unsupported, or parse fails.
 */
export async function extractCallees(content: string, funcName: string, lang: string): Promise<CalleeInfo[]> {
  if (!isLanguageSupported(lang)) return [];

  const tree = await parseSource(content, lang);
  if (!tree) return [];

  try {
    const funcNode = findFunctionNode(tree.rootNode, funcName, lang);
    if (!funcNode) return [];

    // Most grammars expose the body via a "body" field; Kotlin/Swift use a
    // function_body child, PowerShell a script_block — fall back to those.
    const body =
      funcNode.childForFieldName("body") ??
      funcNode.children.find((c) =>
        c !== null &&
        (c.type === "function_body" || c.type === "script_block" || c.type === "block" || c.type === "statement_block"),
      ) ??
      null;
    if (!body) return [];

    const callExprs = collectCallExpressions(body);
    const seen = new Set<string>();
    const callees: CalleeInfo[] = [];

    for (const call of callExprs) {
      const name = getCalleeName(call);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      callees.push({ name, line: call.startPosition.row + 1 });
    }

    return callees;
  } finally {
    tree.delete();
  }
}
