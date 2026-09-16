/**
 * Unified credential and path redaction utilities.
 *
 * Single source-of-truth for all sensitive-data scrubbing across the server:
 *   - logger.ts  (redactString)
 *   - server.ts  (sanitizeErrorMessage, sanitizeSandboxError)
 *   - sandbox.ts (path stripping in error messages)
 *
 * Nothing in this module logs, throws, or has side-effects — pure transforms.
 */

// ---------------------------------------------------------------------------
// Core string redactor
// ---------------------------------------------------------------------------

/**
 * Redact credentials, auth headers, and internal filesystem paths from a string.
 * Used by the logger for all outbound log entries.
 */
export function redactString(s: string): string {
  // HTTP Basic auth header values
  let r = s.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  // URL-embedded credentials: only in authority portion (between :// and first /)
  // Avoids false positives on OpenGrok @revision URLs in path/query
  r = r.replace(/(:\/\/)([^/\s]*:[^@/\s]*@)/g, "$1***:***@");
  // Bare user:pass@host patterns (not in URL context)
  r = r.replace(/\b(?!https?:)\w+:[^\s@]+@/g, "***:***@");
  // Bearer / token schemes
  r = r.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  // Raw API tokens (personal/deploy/runner/OAuth/feed): no scheme keyword
  r = r.replace(/\bgl(?:pat|dt|rt|oas|ft)-[A-Za-z0-9_\-./=]{8,}/g, "[REDACTED]");
  // Absolute POSIX paths that may reveal internal infrastructure
  // Covers /home, /Users, /tmp, /var, /usr, /build, /opt, /mnt, /srv,
  //        /root, /etc, /proc, /run, /data, /app, /workspace (container paths)
  r = r.replace(
    /\/(?:home|Users|tmp|var|usr|build|opt|mnt|srv|root|etc|proc|run|data|app|workspace)(?:\/\S+)/g,
    "[path]"
  );
  // Windows absolute paths
  r = r.replace(/[A-Z]:\\(?:Users|Windows|Program Files|build)(?:\\\S+)/gi, "[path]");
  return r;
}

// ---------------------------------------------------------------------------
// Error-message sanitizer (used by makeToolError in server.ts)
// ---------------------------------------------------------------------------

/**
 * Sanitize an Error message before surfacing it to the LLM in a tool error
 * response.
 *
 * - Redacts credentials and paths (via redactString)
 * - Strips JavaScript stack trace lines ("    at …", "node:internal/…")
 * - Hard-caps to 2048 chars
 */
export function sanitizeErrorMessage(message: string): string {
  // Strip stack-trace lines before further redaction
  const withoutStack = message
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line) && !/node:internal/.test(line))
    .join("\n");
  return redactString(withoutStack).slice(0, 2048);
}

// ---------------------------------------------------------------------------
// Sandbox-specific path stripper (used by sandbox.ts error capture)
// ---------------------------------------------------------------------------

/**
 * Strip internal filesystem paths from sandbox error output.
 * More aggressive than sanitizeErrorMessage — also removes QuickJS WASM
 * worker paths and common container/CI path patterns.
 *
 * Uses `<path>` and `<node-internal>` markers (angle-bracket style) to
 * distinguish sandbox-context redactions from server-context redactions.
 */
export function sanitizeSandboxError(message: string): string {
  // Strip stack-trace lines (lines starting with "    at ")
  const withoutStack = message
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n");

  let r = withoutStack;
  // HTTP Basic auth header values
  r = r.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  // URL-embedded credentials: user:pass@host
  r = r.replace(/:[^:@\s]+@/g, ":***@");
  // Raw API tokens (personal/deploy/runner/OAuth/feed): no scheme keyword
  r = r.replace(/\bgl(?:pat|dt|rt|oas|ft)-[A-Za-z0-9_\-./=]{8,}/g, "[REDACTED]");
  // node:internal/* paths → inline replacement
  r = r.replace(/node:internal\/[^\s)]*/g, "<node-internal>");
  // UNC paths (\\server\share)
  r = r.replace(/\\\\[^\s]+/g, "<path>");
  // Windows absolute paths (C:\..., C:/...) including AppData, Users, Program Files, etc.
  r = r.replace(/[A-Z]:\\?(?:[^\s,'"]+)/gi, "<path>");
  // Relative traversal paths (../../...)
  r = r.replace(/(?:\.\.\/)+\S*/g, "<path>");
  // Absolute POSIX paths for all common prefixes
  r = r.replace(
    /\/(?:home|Users|tmp|var|usr|build|opt|mnt|srv|root|etc|proc|run|data|app|workspace|worker|sandbox|quickjs|wasm)(?:\/[^\s,'"]*)?/gi,
    "<path>"
  );
  // Lone /etc/passwd-style paths starting with a known sensitive dir
  r = r.replace(
    /^\/(?:home|Users|tmp|var|usr|build|opt|mnt|srv|root|etc|proc|run|data|app|workspace)$/m,
    "<path>"
  );
  return r.slice(0, 500);
}
