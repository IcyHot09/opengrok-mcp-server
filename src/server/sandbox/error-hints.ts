/**
 * Error-time signature hints — matches sandbox errors to relevant method signatures.
 * When the LLM forgets a function name or uses wrong params, this provides
 * targeted help without needing expensive MCP sampling.
 */

import { METHOD_SIGNATURES } from "./api-spec.js";

const RESOURCE_POINTER = "\nFull API: call opengrok_api";

// Common method name aliases that LLMs confuse
const ALIAS_MAP: Record<string, string> = {
  getFile: "getFileContent",
  readFile: "getFileContent",
  read: "getFileContent",
  getSymbols: "getFileSymbols",
  symbols: "getFileSymbols",
  getHistory: "getFileHistory",
  history: "getFileHistory",
  getBlame: "getFileAnnotate",
  annotate: "getFileAnnotate",
  getAnnotate: "getFileAnnotate",
  blame: "getFileAnnotate",
  searchCode: "search",
  searchFiles: "findFile",
  findFiles: "findFile",
  find: "findFile",
  ls: "browseDir",
  dir: "browseDir",
  browse: "browseDir",
  listFiles: "browseDir",
  listDirectory: "browseDir",
  browseDirectory: "browseDir",
  getOverview: "getFileOverview",
  fileOverview: "getFileOverview",
  overview: "getFileOverview",
  traceCallers: "traceCallChain",
  callGraph: "traceCallChain",
  symbolContext: "getSymbolContext",
  compileInfo: "getCompileInfo",
  health: "indexHealth",
  suggest: "searchSuggest",
  diff: "getFileDiff",
  diffs: "getFileDiff",
  searches: "search",
  reads: "getFileContent",
};

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find the closest method name(s) to a given string.
 */
function findClosestMethods(name: string, maxResults = 3): string[] {
  // Check alias map first
  const alias = ALIAS_MAP[name];
  if (alias && METHOD_SIGNATURES[alias]) return [alias];

  const methods = Object.keys(METHOD_SIGNATURES);
  const scored = methods
    .map(m => ({ method: m, dist: levenshtein(name.toLowerCase(), m.toLowerCase()) }))
    .sort((a, b) => a.dist - b.dist);

  // Only return methods within reasonable distance (≤ half the name length)
  const threshold = Math.max(3, Math.ceil(name.length / 2));
  return scored.filter(s => s.dist <= threshold).slice(0, maxResults).map(s => s.method);
}

/**
 * Match a sandbox error message to a helpful signature hint.
 * Returns null if no pattern matches.
 */
export function matchErrorToHint(error: string): string | null {
  // Pattern 1: "X is not a function"
  let match = error.match(/(\w+) is not a function/);
  if (match) {
    const candidates = findClosestMethods(match[1]);
    if (candidates.length === 0) return null;
    const hints = candidates.map(c => `  ${METHOD_SIGNATURES[c]}`).join("\n");
    const prefix = candidates.length === 1
      ? `Did you mean ${candidates[0]}()?`
      : `Did you mean one of these?`;
    return `${prefix}\n${hints}\nIf methods seem unfamiliar, call opengrok_api before retrying.${RESOURCE_POINTER}`;
  }

  // Pattern 6: "X is not defined" (ReferenceError — undefined global, e.g. find/ls after context loss)
  match = error.match(/(\w+) is not defined/);
  if (match) {
    const candidates = findClosestMethods(match[1]);
    if (candidates.length === 0) return null;
    const hints = candidates.map(c => `  ${METHOD_SIGNATURES[c]}`).join("\n");
    const prefix = candidates.length === 1
      ? `Did you mean ${candidates[0]}()?`
      : `Did you mean one of these?`;
    return `${prefix}\n${hints}\nCall opengrok_api to get current methods and return shapes, then retry.${RESOURCE_POINTER}`;
  }

  // Pattern 2: "X is not initialized" (JavaScript TDZ — a const/let declaration of X
  // shadows the sandbox global, making the entire block see X as uninitialized,
  // even lines above the declaration. e.g. `const health = health()`.
  match = error.match(/\b(\w+) is not initialized\b/);
  if (match) {
    const name = match[1];
    if (METHOD_SIGNATURES[name]) {
      return `"${name}" is a sandbox global — a block-scoped declaration of "${name}" shadows it for the entire block (even lines before the declaration).\nRename the result variable: use \`const ${name}Result = ${name}(...)\` instead of \`const ${name} = ${name}(...)\`.${RESOURCE_POINTER}`;
    }
  }

  // Pattern 3: "Unknown API method: X" (from sandbox security layer)
  match = error.match(/Unknown API method: (\w+)/);
  if (match) {
    const candidates = findClosestMethods(match[1]);
    if (candidates.length === 0) return null;
    const hints = candidates.map(c => `  ${METHOD_SIGNATURES[c]}`).join("\n");
    return `Did you mean ${candidates[0]}()?\n${hints}${RESOURCE_POINTER}`;
  }

  // Also match the "Sandbox method not allowed" wording used by sandbox.ts
  match = error.match(/Sandbox method not allowed: "(\w+)"/);
  if (match) {
    const candidates = findClosestMethods(match[1]);
    if (candidates.length === 0) return null;
    const hints = candidates.map(c => `  ${METHOD_SIGNATURES[c]}`).join("\n");
    return `Did you mean ${candidates[0]}()?\n${hints}${RESOURCE_POINTER}`;
  }

  // Pattern 4: "expected N arguments" / argument count mismatch
  match = error.match(/(\w+)\s+expected \d/i);
  if (!match) match = error.match(/Expected \d.*?arguments.*?(\w+)/i);
  if (match) {
    const methodName = match[1];
    if (METHOD_SIGNATURES[methodName]) {
      return `Correct signature:\n  ${METHOD_SIGNATURES[methodName]}${RESOURCE_POINTER}`;
    }
  }

  // Pattern 5: HTTP 404 path not found
  if (/HTTP 404/.test(error)) {
    return `Path not found. Use findFile() or search() to locate correct path.${RESOURCE_POINTER}`;
  }

  return null;
}
