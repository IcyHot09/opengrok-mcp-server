/**
 * Configuration management for OpenGrok MCP Server.
 * Reads from environment variables, no passwords logged or exposed.
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Context budget types + limits
// ---------------------------------------------------------------------------

export type ContextBudget = "minimal" | "standard" | "generous";

/** Per-budget response size limits. Consumers import this directly from config.ts. */
export const BUDGET_LIMITS: Record<
  ContextBudget,
  {
    maxResponseBytes: number;
    maxInlineLines: number;
    contextLines: number;
    maxSearchResults: number;
    searchAndReadCap: number;
  }
> = {
  minimal:  { maxResponseBytes: 8_192,  maxInlineLines: 50,  contextLines: 3,  maxSearchResults: 5,  searchAndReadCap: 2_048 },
  standard: { maxResponseBytes: 16_384, maxInlineLines: 100, contextLines: 5,  maxSearchResults: 10, searchAndReadCap: 4_096 },
  generous: { maxResponseBytes: 32_768, maxInlineLines: 200, contextLines: 10, maxSearchResults: 25, searchAndReadCap: 8_192 },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Parse a string env var as an integer, rejecting NaN values. */
const zIntString = (defaultVal: string) =>
  z
    .string()
    .default(defaultVal)
    .transform((v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) throw new Error(`expected integer, got "${v}"`);
      return n;
    });

/**
 * Parse a boolean-ish env string. Polarity is explicit per field because
 * fields historically differ (verify-style flags treat everything-but-"false"
 * as true; opt-in flags require exactly "true"). New fields must pick a
 * polarity here — do not invent a third spelling.
 */
type EnvBoolPolarity = "true-unless-false" | "true-only";
const parseEnvBool = (v: string, polarity: EnvBoolPolarity): boolean =>
  polarity === "true-unless-false" ? v.toLowerCase() !== "false" : v.toLowerCase() === "true";

/** Like zIntString but also rejects zero and negative values. */
const zPositiveIntString = (defaultVal: string) =>
  zIntString(defaultVal).refine((n) => n >= 1, {
    message: `must be a positive integer (≥ 1)`,
  });

const ConfigSchema = z.object({
  OPENGROK_BASE_URL: z.string().default(""),
  OPENGROK_USERNAME: z.string().default(""),
  OPENGROK_PASSWORD: z.string().default(""),
  OPENGROK_PASSWORD_FILE: z.string().default("")
    .describe("Path to a file containing the OpenGrok password (file-mounted secret)"),
  OPENGROK_VERIFY_SSL: z
    .string()
    .default("true")
    .transform((v) => parseEnvBool(v, "true-unless-false")),
  OPENGROK_TIMEOUT: zIntString("30"),
  OPENGROK_DEFAULT_MAX_RESULTS: zIntString("25"),
  // Cache settings
  OPENGROK_CACHE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OPENGROK_CACHE_SEARCH_TTL: zPositiveIntString("300"),
  OPENGROK_CACHE_FILE_TTL: zPositiveIntString("600"),
  OPENGROK_CACHE_HISTORY_TTL: zPositiveIntString("1800"),
  OPENGROK_CACHE_PROJECTS_TTL: zPositiveIntString("3600"),
  OPENGROK_CACHE_MAX_SIZE: zPositiveIntString("500"),
  OPENGROK_CACHE_MAX_BYTES: zPositiveIntString("52428800"), // 50 MB default total cache budget
  // Rate limit
  OPENGROK_RATELIMIT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OPENGROK_RATELIMIT_RPM: zPositiveIntString("60"),
  // Proxy
  HTTP_PROXY: z.string().default(""),
  HTTPS_PROXY: z.string().default(""),
  // Local layer — comma-separated absolute paths to compile_commands.json files
  OPENGROK_LOCAL_COMPILE_DB_PATHS: z.string().default(""),
  // Default project to scope searches to when none specified
  OPENGROK_DEFAULT_PROJECT: z.string().default(""),
  // Optimisation — context budget
  OPENGROK_CONTEXT_BUDGET: z
    .enum(["minimal", "standard", "generous"])
    .default("standard")
    .describe("Token budget mode: minimal=8KB, standard=16KB, generous=32KB"),
  // Code Mode — 2-tool sandbox (enabled by default)
  OPENGROK_CODE_MODE: z
    .string()
    .default("true")
    .transform((v) => parseEnvBool(v, "true-only")),
  // Memory tools in Code Mode — 2 tools by default, 5 when enabled
  OPENGROK_ENABLE_MEMORY_TOOLS: z
    .string()
    .default("false")
    .transform((v) => parseEnvBool(v, "true-only")),
  // Memory bank directory for Living Document system (empty = server-relative default)
  OPENGROK_MEMORY_BANK_DIR: z.string().default(""),
  // Global response format override (empty = auto per-call)
  OPENGROK_RESPONSE_FORMAT_OVERRIDE: z.string().default(""),
  // Audit log file path (appended to, in addition to stderr)
  OPENGROK_AUDIT_LOG_FILE: z.string().default(""),
  // MCP Elicitation — ask user for input during tool execution (e.g., pick project)
  OPENGROK_ENABLE_ELICITATION: z
    .string()
    .default("true")
    .transform((v) => parseEnvBool(v, "true-only")),
  // Files API cache layer — tracks investigation-log.md uploads to avoid re-sending unchanged content
  OPENGROK_ENABLE_FILES_API: z
    .string()
    .default("false")
    .transform((v) => parseEnvBool(v, "true-only"))
    .describe("Use Files API cache for investigation-log.md (when supported by SDK)"),
  // Observation Masker — prepend compact history summaries to opengrok_execute results (off by default)
  OPENGROK_ENABLE_OBSERVATION_MASKER: z
    .string()
    .default("false")
    .transform((v) => parseEnvBool(v, "true-only")),
  // Number of most-recent opengrok_execute results to keep as full text before masking older ones
  OPENGROK_OBSERVATION_MASKER_TURNS: z.coerce.number().int().min(1).default(10),
  // Per-tool rate limiting (comma-separated tool=rpm pairs, e.g. "opengrok_batch_search=5,opengrok_execute=10")
  OPENGROK_PER_TOOL_RATELIMIT: z.string().default(""),
  // OpenGrok REST API version (Task 5.7)
  OPENGROK_API_VERSION: z.enum(["v1", "v2"]).default("v1")
    .describe("OpenGrok REST API version (v1 or v2, default: v1)"),
  // Sampling — token budget and model preference (Task 5.5)
  OPENGROK_ENABLE_SAMPLING: z
    .string()
    .default("false")
    .transform((v) => parseEnvBool(v, "true-only")),
  OPENGROK_SAMPLING_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(256),
  OPENGROK_SAMPLING_MODEL: z.string().default(""),
  // HTTP transport OAuth 2.1 (Task 5.3)
  // Shared-secret Bearer token for HTTP transport auth (empty = no auth required)
  OPENGROK_HTTP_AUTH_TOKEN: z.string().default(""),
  // Expected JWT issuer (iss claim). When set, JWTs from other issuers are rejected.
  OPENGROK_JWT_ISSUER: z.string().default("")
    .describe("Expected JWT issuer (iss claim). When set, JWTs from other issuers are rejected."),
  // HTTP transport — max concurrent sessions (Task 5.2)
  OPENGROK_HTTP_MAX_SESSIONS: zIntString("100"),
  // RBAC for multi-user HTTP deployments (Task 5.10)
  OPENGROK_RBAC_TOKENS: z.string().default("")
    .describe("RBAC token config: 'token1:admin,token2:readonly' format"),
  // SSRF strict mode — reject base URL pointing at private IPs (opt-in)
  OPENGROK_STRICT_SSRF: z
    .string()
    .default("false")
    .transform((v) => parseEnvBool(v, "true-only"))
    .describe("When true, reject base URL pointing at private/loopback IPs"),
  // Tree-sitter grammar directory override (WASM grammars)
  OPENGROK_GRAMMAR_DIR: z.string().default("")
    .describe("Directory containing tree-sitter WASM grammars (overrides bundled lookup)"),
});

export type Config = z.infer<typeof ConfigSchema>;

// Per-tool rate limit defaults (calls per minute)
export const DEFAULT_PER_TOOL_LIMITS: Record<string, number> = {
  opengrok_batch_search: 5,    // expensive operation
  opengrok_execute: 15,        // Code Mode sandbox overhead
  opengrok_dependency_map: 10, // BFS = multiple requests
  opengrok_update_memory: 20,  // disk writes — allow bursting but not spamming
  opengrok_call_graph: 5,      // recursive O(n²) search fan-out; budget counter provides inner cap
  opengrok_search_and_read: 10, // compound tool — performs multiple API calls per invocation
};

// Parse per-tool rate limit config from environment string
export function parsePerToolLimits(configStr: string): Record<string, number> {
  const limits = { ...DEFAULT_PER_TOOL_LIMITS };
  if (!configStr || !configStr.trim()) return limits;

  for (const pair of configStr.split(",")) {
    // Support both "tool=rpm" and "tool:rpm" delimiters — use whichever appears first
    const colonIdx = pair.indexOf(":");
    const equalsIdx = pair.indexOf("=");
    const delimiterIdx = colonIdx >= 0
      ? (equalsIdx >= 0 ? Math.min(colonIdx, equalsIdx) : colonIdx)
      : equalsIdx;
    if (delimiterIdx < 0) continue;
    const tool = pair.slice(0, delimiterIdx).trim();
    const rpm = pair.slice(delimiterIdx + 1).trim();
    if (tool && rpm) {
      const parsed = parseInt(rpm, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limits[tool] = parsed;
      }
    }
  }

  return limits;
}

// Warn when stored credentials have not been rotated within this window.
// Advisory only — never blocks startup or auth.
const CREDENTIAL_ROTATION_WARNING_DAYS = 365;

// Check credential age and return warning if older than threshold
export function checkCredentialAge(configDir: string): string | null {
  try {
    const stateFile = path.join(configDir, "last-credential-rotation.json");
    const content = fs.readFileSync(stateFile, "utf8");
    const state = JSON.parse(content) as { rotatedAt: string };
    const ageDays = (Date.now() - new Date(state.rotatedAt).getTime()) / (1000 * 86400);
    if (!Number.isFinite(ageDays) || ageDays < 0) return null; // clock skew or corrupt
    if (ageDays > CREDENTIAL_ROTATION_WARNING_DAYS) {
      return `Credentials not rotated in ${Math.floor(ageDays)} days`;
    }
    return null;
  } catch {
    return null; // no state file = first run or inaccessible
  }
}

// Update credential rotation timestamp (atomic temp+rename so a crash
// mid-write never leaves a torn state file behind)
export function updateCredentialRotationTimestamp(configDir: string): void {
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const stateFile = path.join(configDir, "last-credential-rotation.json");
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ rotatedAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch {
      fs.writeFileSync(stateFile, JSON.stringify({ rotatedAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
    }
  } catch (err) {
    logger.warn("Failed to update credential rotation timestamp:", err);
  }
}

// ---------------------------------------------------------------------------
// Lazy response-size overrides (read at call time, not import time)
// ---------------------------------------------------------------------------

/**
 * Env override for max response bytes. Read lazily (not snapshotted at import)
 * so process-env edits apply without a restart. Non-positive values are
 * ignored — a 0/negative cap would truncate every response to empty.
 */
function maxResponseBytesOverride(): number | undefined {
  const v = parseInt(process.env.OPENGROK_MAX_RESPONSE_BYTES ?? "", 10);
  return Number.isNaN(v) || v < 1 ? undefined : v;
}

// Cap for the search_and_read compound tool (in bytes).
// Override with OPENGROK_SEARCH_AND_READ_CAP env var (same lazy semantics).
function searchAndReadCapOverride(): number | undefined {
  const v = parseInt(process.env.OPENGROK_SEARCH_AND_READ_CAP ?? "", 10);
  return Number.isNaN(v) || v < 1 ? undefined : v;
}

/** Effective max response bytes (env override → budget default). */
export function getMaxResponseBytes(): number {
  return maxResponseBytesOverride() ?? BUDGET_LIMITS[getActiveBudget()].maxResponseBytes;
}

/** Effective search-and-read compound cap (env override → budget default). */
export function getSearchAndReadCap(): number {
  return searchAndReadCapOverride() ?? BUDGET_LIMITS[getActiveBudget()].searchAndReadCap;
}

/** Get the active context budget from env, defaulting to 'standard'. */
export function getActiveBudget(): ContextBudget {
  const v = process.env.OPENGROK_CONTEXT_BUDGET?.toLowerCase();
  if (v === "standard" || v === "generous" || v === "minimal") return v;
  return "standard";
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _config: Config | undefined;

export function loadConfig(overrides?: Record<string, string>, opts?: { fatal?: boolean }): Config {
  if (!overrides && _config) return _config;

  const result = ConfigSchema.safeParse({ ...process.env, ...overrides });
  if (!result.success) {
    logger.error("Configuration error:", result.error.format());
    // SIGHUP reload passes fatal:false so a bad env edit can't kill the server —
    // the caller retains the prior config. Startup keeps the fatal default.
    if (opts?.fatal === false) {
      throw new Error(`Configuration error: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
    process.exit(1);
  }

  const data = result.data;
  const password = data.OPENGROK_PASSWORD;

  // Warn if username is set but no password provided
  if (data.OPENGROK_USERNAME && !password) {
    logger.warn("OPENGROK_USERNAME is set but OPENGROK_PASSWORD is empty. Authentication may fail.");
  }

  // Validate proxy URL scheme (for both HTTP_PROXY and HTTPS_PROXY)
  for (const proxyUrl of [data.HTTP_PROXY, data.HTTPS_PROXY].filter(Boolean)) {
    try {
      const parsedProxy = new URL(proxyUrl);
      const allowedSchemes = ["http:", "https:", "socks5:"];
      if (!allowedSchemes.includes(parsedProxy.protocol)) {
        logger.error(`Proxy URL scheme "${parsedProxy.protocol}" not allowed. Use http, https, or socks5.`);
        process.exit(1);
      }
    } catch {
      logger.error(`Proxy URL is not a valid URL: "${proxyUrl}"`);
      process.exit(1);
    }
  }

  // Validate OPENGROK_BASE_URL is a valid http/https URL when non-empty
  if (data.OPENGROK_BASE_URL && !/^https?:\/\/.+/.test(data.OPENGROK_BASE_URL)) {
    logger.error(`OPENGROK_BASE_URL must be a valid http/https URL, got: "${data.OPENGROK_BASE_URL}"`);
    process.exit(1);
  }

  // Freeze to prevent accidental mutation by consumers
  const frozen = Object.freeze({ ...data, OPENGROK_PASSWORD: password });

  // Only cache the singleton when no overrides were supplied
  if (!overrides) {
    _config = frozen;
  }

  // Warn on primary startup config only (not on override calls from CLI subcommands or keychain injection)
  if (!overrides) {
    if (!frozen.OPENGROK_USERNAME && frozen.OPENGROK_BASE_URL) {
      logger.warn("OPENGROK_USERNAME is not set. Requests to authenticated OpenGrok instances will fail.");
    }
    if (!frozen.OPENGROK_BASE_URL) {
      logger.warn("OPENGROK_BASE_URL is not set. All tool calls will fail.");
    }
  }

  return frozen;
}

// Get the config directory, respecting XDG_CONFIG_HOME
export function getConfigDirectory(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, "opengrok-mcp");
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(homeDir, ".config", "opengrok-mcp");
}

export function resetConfig(): void {
  _config = undefined;
}
