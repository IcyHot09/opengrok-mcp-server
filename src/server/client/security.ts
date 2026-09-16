/**
 * OpenGrok HTTP client subsystem - split from client.ts (pure move, no logic changes).
 */
import { isIPv4, isIPv6 } from "node:net";

/**
 * Throw if `path` contains traversal sequences that could escape the project
 * root. Rejects literal, URL-encoded, double-encoded, null-byte, Unicode NFD
 * lookalike, and RTL-override variants.
 */
export function assertSafePath(rawPath: string): void {
  // Block bidi/zero-width characters that can spoof path display
  if (/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/.test(rawPath)) {
    throw new Error(`Unsafe path rejected (bidi/zero-width character): "${rawPath}"`);
  }

  // Null bytes — never valid
  if (rawPath.includes('\0') || rawPath.includes('%00') || rawPath.includes('%2500')) {
    throw new Error(`Unsafe path rejected (null byte): "${rawPath}"`);
  }

  // Decode once to catch single-encoding variants (%2e%2e, %2f)
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.replace(/\+/g, '%20'));
  } catch {
    throw new Error(`Unsafe path rejected (malformed encoding): "${rawPath}"`);
  }

  // NFC normalization — collapses NFD lookalike sequences that could spell '..'
  const normalized = decoded.normalize('NFC').replace(/\\/g, '/');

  // Check for traversal using path-component-aware patterns (avoid false
  // positives on '.../' which is a valid three-dot filename component).
  // A traversal '..' segment must be bounded by '/' or string boundaries.
  const lowerNorm = normalized.toLowerCase();
  if (
    lowerNorm.includes('/../') ||
    lowerNorm.startsWith('../') ||
    lowerNorm === '..' ||
    lowerNorm.endsWith('/..') ||
    lowerNorm.includes('/./') ||
    lowerNorm.startsWith('./')
  ) {
    throw new Error(`Unsafe path rejected: "${rawPath}"`);
  }

  // Encoded traversal patterns in the decoded+normalized form
  const encodedTraversalPatterns = [
    '..%2f', '%2f..', '%2e%2e', '%252e', '%252f',
  ];
  for (const p of encodedTraversalPatterns) {
    if (lowerNorm.includes(p)) {
      throw new Error(`Unsafe path rejected: "${rawPath}"`);
    }
  }

  // Also check raw path for double-encoded patterns
  const rawLower = rawPath.toLowerCase();
  if (rawLower.includes('%252e') || rawLower.includes('%252f')) {
    throw new Error(`Unsafe path rejected (double-encoded traversal): "${rawPath}"`);
  }
}

/** Strip IPv6 brackets and normalize ::ffff:-mapped IPv4 addresses. */
export function unmapIPv6(raw: string): string {
  const s = raw.replace(/^\[|\]$/g, "");
  const prefix = s.slice(0, 7).toLowerCase();
  if (prefix === "::ffff:") {
    const candidate = s.slice(7);
    if (isIPv4(candidate)) return candidate;
  }
  return s;
}

/**
 * Returns true if the IP (v4 or v6 string) is in a private/loopback/link-local range.
 * Exported for unit testing.
 */
export function isPrivateIp(raw: string): boolean {
  if (raw === "localhost") return true;
  const ip = unmapIPv6(raw);

  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      // fe80::/10 link-local: fe80 through febf
      (lower.startsWith("fe") && parseInt(lower.slice(2, 4), 16) >= 0x80 && parseInt(lower.slice(2, 4), 16) <= 0xbf)
    );
  }

  return false;
}

/**
 * Build a URL and verify the resolved host still matches `baseUrl`.
 * Also blocks base URLs that resolve to private/loopback addresses (SSRF protection).
 */
export function buildSafeUrl(baseUrl: URL, ...segments: string[]): URL {
  const joined = segments.map((s) => encodeURIComponent(s).replace(/%2F/g, "/")).join("/");
  const url = new URL(joined, baseUrl);
  if (url.hostname !== baseUrl.hostname || url.port !== baseUrl.port) {
    throw new Error(`SSRF guard: resolved URL "${url}" escapes allowed host "${baseUrl.hostname}"`);
  }
  // Block private/loopback IPs in base URL at construction time
  if (isPrivateIp(baseUrl.hostname)) {
    throw new Error(`SSRF guard: base URL hostname "${baseUrl.hostname}" is a private/loopback address`);
  }
  return url;
}

/**
 * Returns true when `target` stays on the same origin as `base`
 * (hostname + port + protocol match). Used to validate redirect destinations
 * against SSRF via open-redirect attacks.
 */
export function isSafeRedirect(target: URL, base: URL): boolean {
  if (target.hostname !== base.hostname) return false;
  if (target.protocol !== base.protocol) return false;
  const normalizePort = (u: URL): string =>
    u.port || (u.protocol === "https:" ? "443" : "80");
  return normalizePort(target) === normalizePort(base);
}

/** Normalize common fileType aliases to OpenGrok analyzer names. */
const FILE_TYPE_ALIASES: Record<string, string> = {
  cpp: "cxx", "c++": "cxx", h: "cxx", hpp: "cxx", hxx: "cxx", cc: "cxx",
  go: "golang",
  shell: "sh", bash: "sh", zsh: "sh",
  // Makefiles are indexed by the Sh analyzer (ShAnalyzerFactory lists
  // MAKEFILE/GNUMAKEFILE names) — there is no separate Makefile analyzer.
  makefile: "sh",
  js: "javascript", ts: "typescript", cs: "csharp", rb: "ruby", py: "python", rs: "rust",
};

export function normalizeFileType(fileType: string | undefined): string | undefined {
  if (!fileType) return fileType;
  return FILE_TYPE_ALIASES[fileType.toLowerCase()] ?? fileType;
}

/** Allowlist of valid OpenGrok analyzer names (lowercased, without "Analyzer" suffix). */
export const VALID_FILE_TYPES: ReadonlySet<string> = new Set([
  "cxx", "c", "java", "javascript", "typescript", "csharp", "python",
  "sh", "powershell", "golang", "rust", "kotlin", "scala", "sql", "plsql", "perl",
  "ruby", "swift", "php", "xml", "json", "yaml", "hcl", "terraform", "plain",
  "lua", "ada", "fortran", "r", "haskell", "clojure", "erlang", "lisp",
  "tcl", "pascal", "eiffel", "asm", "vb", "verilog",
  "cobol", "ocaml", "mandoc", "troff",
]);

export function validateFileType(fileType: string | undefined): string | undefined {
  const normalized = normalizeFileType(fileType);
  if (normalized && !VALID_FILE_TYPES.has(normalized.toLowerCase())) {
    throw new Error(
      `Invalid fileType '${fileType}'. Valid types: ${[...VALID_FILE_TYPES].sort().join(", ")}`
    );
  }
  return normalized;
}

// Map fileType analyzer names to their common extensions for client-side post-filtering.
// The web refs path does not reliably honor fileType server-side.
const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  cxx: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx"],
  c: [".c", ".h"],
  java: [".java"],
  javascript: [".js", ".mjs", ".cjs"],
  typescript: [".ts", ".tsx"],
  python: [".py", ".pyw"],
  golang: [".go"],
  rust: [".rs"],
  csharp: [".cs"],
  kotlin: [".kt", ".kts"],
  scala: [".scala"],
  ruby: [".rb"],
  swift: [".swift"],
  php: [".php"],
  perl: [".pl", ".pm"],
  sh: [".sh", ".bash", ".zsh"],
  sql: [".sql"],
  xml: [".xml"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
};

export function matchesFileType(path: string, fileType: string): boolean {
  const exts = FILE_TYPE_EXTENSIONS[fileType.toLowerCase()];
  if (!exts) return true; // unknown type — don't filter
  const lower = path.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}
