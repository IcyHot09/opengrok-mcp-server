/**
 * Sandbox security — method allowlist and error formatting.
 * Single source of truth remains in ./sandbox.ts (SANDBOX_ALLOWED_METHODS, sanitizeSandboxError)
 * and ../utils/redact.ts (core redactor). This module re-exports to keep
 * import paths stable after the split.
 */
export { SANDBOX_ALLOWED_METHODS, sanitizeSandboxError } from "./sandbox.js";
export { sanitizeSandboxError as formatSandboxError } from "./sandbox.js";
