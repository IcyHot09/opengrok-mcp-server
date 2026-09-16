/**
 * OpenGrok MCP Server - tool definitions and handlers (slim orchestrator, split into focused modules).
 * Executors, registration, docs, prompts, notifications moved to ./tools/ and ./protocol/ (pure moves).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenGrokClient } from "./client/index.js";
import type { Config } from "./config.js";
import { parsePerToolLimits, getConfigDirectory, checkCredentialAge } from "./config.js";
import { MemoryBank } from "./memory/memory-bank.js";
import { ToolRateLimiter } from "./tools/tool-rate-limiter.js";
import { logger } from "./utils/logger.js";
import { auditLog } from "./transport/audit.js";
import { buildLocalLayer } from "./tools/executors.js";
import { registerCodeModeTools, registerLegacyTools } from "./tools/register-tools.js";
import { registerToolDocResources, registerMemoryResources } from "./tools/register-resources.js";
import { registerInvestigationPrompts } from "./tools/register-prompts.js";
import { setupNotificationHandlers } from "./protocol/notifications.js";

// ---------------------------------------------------------------------------
// Server version
// ---------------------------------------------------------------------------

declare const __VERSION__: string;

/* v8 ignore start -- compile-time constant injected by esbuild */
const VERSION = (typeof __VERSION__ !== "undefined"
  ? __VERSION__
  : (process.env.npm_package_version ?? "4.0.0"));
/* v8 ignore stop */
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Server instructions (opengrok_ prefixed tool names)
// ---------------------------------------------------------------------------

export const SERVER_INSTRUCTIONS_TEMPLATE = `You are connected to an OpenGrok code search MCP server.

## TOOLS
Use opengrok_ prefixed tools to search and navigate the codebase. Run opengrok_index_health first to list available projects.

## SESSION START
{{MEMORY_STATUS}}
Run opengrok_index_health to verify connectivity, then proceed with the user's request.

## RESPONSE FORMAT
The \`response_format\` parameter controls output. Default is "auto":
- search results → TSV (compact, tabular)
- symbol context → YAML (hierarchical)
- file content → text (raw)
- other → markdown
- toon → ultra-compact search results (~60% token savings, search tools only)
- json → JSON in content text (for programmatic use; auto never selects this)
Override per-call or globally with OPENGROK_RESPONSE_FORMAT_OVERRIDE.

## RATE LIMITS
Some tools have lower per-minute limits by default:
- opengrok_batch_search: 5 rpm (expensive — runs multiple queries)
- opengrok_call_graph: 5 rpm (recursive search fan-out)
- opengrok_dependency_map: 10 rpm (BFS traversal = multiple requests)
- opengrok_search_and_read: 10 rpm (compound tool — multiple API calls)
If rate-limited, wait before retrying or narrow the query scope.

## WORKFLOW
1. Search broadly with opengrok_search_code (symbol/full/path)
2. Use opengrok_get_symbol_context for function/class deep-dives
3. Use opengrok_batch_search for 2-5 parallel queries
4. Read files via opengrok_get_file_content with line ranges
5. Use opengrok_blame / opengrok_what_changed to understand change history`.trim();

/**
 * Code Mode uses a shorter instruction set — only environment facts.
 * Method docs, disambiguation patterns, and sampling/elicitation usage live
 * in the API spec (opengrok_api), not here.
 */
export const SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE = `You are connected to an OpenGrok code search MCP server in Code Mode.

## Setup
Call opengrok_api before the first opengrok_execute in a session and after any context compaction. On errors about undefined methods or unexpected return shapes, call opengrok_api before retrying.

## Environment
- Execution sandbox: 62s hard kill, 128MB memory, serial execution; sandbox globals are synchronous (await is unnecessary)
- Rate limit: opengrok_execute 15 rpm
- Memory: if prior context is shown below, read both files (active-task.md, investigation-log.md) with opengrok_read_memory first; at session end, update them
{{MEMORY_STATUS}}

## Efficiency
Minimize token cost without compromising accuracy.`.trim();

// Alias for test-export backward compatibility
const SERVER_INSTRUCTIONS = SERVER_INSTRUCTIONS_TEMPLATE;


// ---------------------------------------------------------------------------
// createServer / health / runServer (kept in server.ts per layout spec)
// ---------------------------------------------------------------------------

export function createServer(
  client: OpenGrokClient,
  config: Config,
  memoryBank?: MemoryBank,
  instructionsOverride?: string
): McpServer {
  const codeMode = config.OPENGROK_CODE_MODE;

  const baseInstructions = codeMode ? SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE : SERVER_INSTRUCTIONS_TEMPLATE;
  const instructions = instructionsOverride ?? baseInstructions;

  const server = new McpServer(
    { name: "opengrok-mcp", version: VERSION },
    { instructions }
  );

  const local = buildLocalLayer(config);

  // Initialize per-tool rate limiter
  const perToolLimits = parsePerToolLimits(config.OPENGROK_PER_TOOL_RATELIMIT);
  // The ToolRateLimiter default (60 rpm) matches the global client rate limit.
  // This is intentional: the per-tool limiter only constrains specific expensive
  // tools (batch_search: 5rpm, execute: 10rpm, dependency_map: 10rpm). All other
  // tools fall through to the global OpenGrokClient rate limiter.
  const toolRateLimiter = new ToolRateLimiter(perToolLimits);

  if (codeMode && memoryBank) {
    // Code Mode: 2–5 tools exposed (api + execute, + 3 memory tools when enabled).
    // ~130 token cost vs ~1,900 with all legacy tools — 93% savings per turn.
    // LLM cannot see or call legacy tools in this mode; all queries go through the sandbox.
    registerCodeModeTools(server, client, config, memoryBank, local, toolRateLimiter);
  } else {
    // Standard mode: legacy tools only. Memory tools are exclusive to Code Mode.
    // Compact descriptions when budget=minimal to save ~1,400 tokens.
    const compactDescriptions = config.OPENGROK_CONTEXT_BUDGET === "minimal";
    registerLegacyTools(server, client, config, local, compactDescriptions, toolRateLimiter);
  }

  // Register memory files as MCP Resources (memory tools only).
  // Disabled by default (Zod default is false; only explicit true opts in).
  if (memoryBank && config.OPENGROK_ENABLE_MEMORY_TOOLS) {
    registerMemoryResources(server, memoryBank);
  }

  // Task 3B: Register tool documentation as MCP Resources at opengrok-docs://tools/{name}
  registerToolDocResources(server, config);

  // Register MCP Prompts
  registerInvestigationPrompts(server);

  // Task 5.13: MCP Completions infrastructure ready for SDK v2
  // When SDK v2 is released with completion support, uncomment this:
  // server.setCompletionRequestHandler(async (request) => {
  //   if (request.ref.name === "project" || request.ref.argument?.name === "project") {
  //     try {
  //       const projects = await client.listProjects();
  //       const query = request.argument?.value ?? "";
  //       const matching = projects
  //         .filter(p => p.toLowerCase().includes(query.toLowerCase()))
  //         .slice(0, 10);
  //       return { completion: { values: matching } };
  //     } catch {
  //       return { completion: { values: [] } };
  //     }
  //   }
  //   return { completion: { values: [] } };
  // });

  return server;
}

export function startHealthCheckPolling(server: McpServer, client: OpenGrokClient): NodeJS.Timeout {
  let lastConnected = false;

  return setInterval(() => {
    void (async () => {
      try {
        const ok = await client.testConnection();
        if (ok !== lastConnected) {
          lastConnected = ok;
          logger.info(`Connectivity status changed: ${ok ? "connected" : "disconnected"}`);
          auditLog({
            type: "config_load",
            detail: `Connectivity status changed to ${ok ? "connected" : "disconnected"}`
          });
        }
      } catch {
        // Silently ignore health check errors
      }
    })();
  }, 5 * 60 * 1000);
}

/* v8 ignore start -- runServer connects to stdio transport; integration-level */
export async function runServer(
  client: OpenGrokClient,
  config: Config,
  memoryBank?: MemoryBank,
  configLoader?: () => Config
): Promise<void> {
  // Inject memory status into instructions so the LLM sees prior context at session start.
  const codeMode = config.OPENGROK_CODE_MODE;
  const baseTemplate = codeMode ? SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE : SERVER_INSTRUCTIONS_TEMPLATE;
  let resolvedInstructions = baseTemplate;
  const memoryOn = config.OPENGROK_ENABLE_MEMORY_TOOLS && memoryBank;
  if (memoryOn) {
    try {
      const memStatus = await memoryBank.getStatusLine();
      resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", memStatus);
    } catch {
      resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", "[Memory] No prior context.");
    }
  } else if (!memoryBank) {
    resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", "[Memory] No prior context.");
  } else {
    // Memory tools disabled: no status to inject.
    resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", "");
  }
  if (!config.OPENGROK_ENABLE_MEMORY_TOOLS) {
    // Memory tools are unregistered — drop the Memory directive line so the
    // LLM never codes against readMemory/writeMemory.
    resolvedInstructions = resolvedInstructions
      .split("\n")
      .filter((line) => !line.startsWith("- Memory:"))
      .join("\n");
  }

  const server = createServer(client, config, memoryBank, resolvedInstructions);
  const transport = new StdioServerTransport();

  const state: { healthCheckInterval?: NodeJS.Timeout } = {};

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    if (state.healthCheckInterval) clearInterval(state.healthCheckInterval);
    await client.close();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // Security: warn when credentials are transmitted over plaintext HTTP
  if (
    config.OPENGROK_BASE_URL.startsWith("http://") &&
    (config.OPENGROK_USERNAME || config.OPENGROK_PASSWORD)
  ) {
    logger.warn(
      "Credentials configured but base URL uses plaintext HTTP. Use HTTPS to protect credentials in transit."
    );
  }

  logger.info(`Starting server v${VERSION}, connected to: ${config.OPENGROK_BASE_URL}`);

  if (!config.OPENGROK_USERNAME) {
    logger.warn(
      "OPENGROK_USERNAME not configured. Set OPENGROK_USERNAME and OPENGROK_PASSWORD environment variables."
    );
  }

  // Check credential age and warn if stale
  const credentialAgeWarning = getCredentialAgeWarning();
  if (credentialAgeWarning) {
    logger.warn(credentialAgeWarning);
    auditLog({ type: "config_load", detail: credentialAgeWarning });
  }

  // Monitor config changes and connectivity for tool list changes
  setupNotificationHandlers(server, client, config, configLoader);

  await server.connect(transport);

  // Start health check polling after server connects
  state.healthCheckInterval = startHealthCheckPolling(server, client);
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get credential age warning (if applicable).
 * Returns warning string if credentials are older than 90 days.
 */
function getCredentialAgeWarning(): string | null {
  try {
    const configDir = getConfigDirectory();
    return checkCredentialAge(configDir);
  } catch {
    return null; // config module or directory check failed
  }
}


// ---------------------------------------------------------------------------
// Backward-compat re-exports (exact previous server.ts surface for tests)
// ---------------------------------------------------------------------------
export { TOOL_DOCS, TOOL_REGISTRATION_ORDER, TOOL_DEFS } from "./tools/tool-docs.js";
export { dispatchTool as _dispatchTool, deduplicateAcrossQueries as _deduplicateAcrossQueries, buildLocalLayer as _buildLocalLayer, tryLocalRead as _tryLocalRead, readFileAtAbsPath as _readFileAtAbsPath, resolveFileFromIndex as _resolveFileFromIndex, applyDefaultProject as _applyDefaultProject, buildXrefUri, buildDependencyGraph } from "./tools/executors.js";
export { capResponse as _capResponse, capCodeModeResult as _capCodeModeResult } from "./tools/executors.js";
const _SERVER_INSTRUCTIONS_ALIAS = SERVER_INSTRUCTIONS;
export { _SERVER_INSTRUCTIONS_ALIAS as _SERVER_INSTRUCTIONS };
export { sanitizeErrorMessage, sanitizeErrorMessage as _sanitizeErrorMessage } from "./utils/redact.js";
export type { LocalLayer as _LocalLayer } from "./tools/executors.js";
export { _resetSighupRegistered, setupNotificationHandlers } from "./protocol/notifications.js";
