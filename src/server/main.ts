/**
 * OpenGrok MCP Server — entry point.
 * v5.0: MemoryBank initialization for Living Document / Code Mode support.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { OpenGrokClient } from "./client/index.js";
import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { runServer } from "./server.js";
import { MemoryBank } from "./memory/memory-bank.js";
import { configureAuditLog, exportAuditLogAsCSV, exportAuditLogAsJSON } from "./transport/audit.js";
import { retrievePassword } from "./cli/keychain.js";
import { resolveCliCommand, formatUnknownCommandMessage } from "./cli/commands.js";
export type { CliCommand } from "./cli/commands.js";

declare const __VERSION__: string;

/**
 * Load config and auto-resolve password from OS keychain if not set via env.
 * The keychain lookup is done before the first loadConfig() call so that the
 * "username set but no password" validation in loadConfig does not exit early.
 *
 * The resolved password is passed as an override to loadConfig() rather than
 * written to process.env, preventing it from leaking into /proc/self/environ
 * or being visible to child processes and native addons.
 *
 * Exported for unit testing and for use as a configLoader callback on SIGHUP.
 */
export function resolveConfig(): ReturnType<typeof loadConfig> {
  // Peek at the relevant env vars without going through full loadConfig validation
  const username = process.env['OPENGROK_USERNAME'] ?? '';
  const envPassword = process.env['OPENGROK_PASSWORD'] ?? '';
  const passwordFile = process.env['OPENGROK_PASSWORD_FILE'] ?? '';
  const overrides: Record<string, string> = {};

  // OpenGrok password resolution: env > file > keychain
  if (username && !envPassword) {
    if (passwordFile) {
      try {
        const filePassword = fs.readFileSync(passwordFile, 'utf8').trim();
        if (filePassword) overrides.OPENGROK_PASSWORD = filePassword;
      } catch (err) {
        logger.warn(`Failed to read OPENGROK_PASSWORD_FILE (${passwordFile}): ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!overrides.OPENGROK_PASSWORD) {
      // No password in env — try the OS keychain before calling loadConfig
      const keychainPassword = retrievePassword(username);
      if (keychainPassword) {
        // Pass the keychain password as an override instead of mutating process.env.
        // This prevents the plaintext secret from appearing in /proc/self/environ,
        // being inherited by child processes, or being readable by native addons.
        overrides.OPENGROK_PASSWORD = keychainPassword;
      }
    }
  }

  return Object.keys(overrides).length > 0 ? loadConfig(overrides) : loadConfig();
}

/* v8 ignore start -- false branch falls through to main() which is integration-level */
if (process.argv.includes("--version") || process.argv.includes("-v")) {
/* v8 ignore stop */
  console.log(typeof __VERSION__ !== "undefined" ? __VERSION__ : process.env.npm_package_version ?? "0.0.0");
  process.exit(0);
}

/* v8 ignore start -- entry point; integration-level, not unit-testable */
// CLI routing — handle setup/status/version/help/export-audit subcommands
const firstArg = process.argv[2];
const cliCommand = resolveCliCommand(firstArg);

function printHelp(): void {
  console.log(`opengrok-mcp — OpenGrok MCP Server CLI

Usage:
  opengrok-mcp setup [--test] [--set key=value]   Configure MCP clients (interactive wizard)
  opengrok-mcp status                             Health check + client detection
  opengrok-mcp export-audit [--format json|csv] [--output file]
                                                   Export the audit log
  opengrok-mcp version                            Print version and exit
  opengrok-mcp help                               Show this help

setup flags:
  --test              Test the stored connection without the interactive wizard
  --set key=value     Update one stored setting non-interactively
                       (e.g. --set contextBudget=generous). Empty value restores
                       the default. Passwords are refused — run setup instead.

To update to the latest release: npm update -g opengrok-mcp-server`);
}

if (cliCommand === "help") {
  printHelp();
  process.exit(0);
} else if (cliCommand === "version") {
  console.log(typeof __VERSION__ !== "undefined" ? __VERSION__ : process.env.npm_package_version ?? "0.0.0");
  process.exit(0);
} else if (cliCommand === "setup") {
  // Dynamic import to avoid loading CLI deps in server mode
  void (async () => {
    const rest = process.argv.slice(3);
    if (rest.includes("--test")) {
      const { runSetupTest } = await import("./cli/status.js");
      await runSetupTest();
      process.exit(process.exitCode ?? 0);
    }
    const setIdx = rest.indexOf("--set");
    const setValue = setIdx >= 0
      ? rest[setIdx + 1]
      : rest.find((a) => a.startsWith("--set="))?.slice("--set=".length);
    if (setIdx >= 0 || setValue !== undefined) {
      const { parseSetArg, updateStoredSetting } = await import("./cli/setup/configure.js");
      try {
        if (setValue === undefined || setValue === "") {
          throw new Error("Missing value. Usage: setup --set key=value");
        }
        const { key, value } = parseSetArg(setValue);
        const updated = updateStoredSetting(key, value);
        if (updated.length === 0) {
          console.error("No configured clients found to update. Run `opengrok-mcp setup` first.");
          process.exit(1);
        } else {
          console.log(`Updated ${key} in: ${updated.join(", ")}`);
        }
      } catch (e) {
        console.error(`setup --set failed: ${(e as Error).message ?? String(e)}`);
        process.exit(1);
      }
      process.exit(0);
    }
    const { runSetup } = await import("./cli/setup/wizard.js");
    await runSetup();
    process.exit(0);
  })();
} else if (cliCommand === "status") {
  void (async () => {
    const { runStatus } = await import("./cli/status.js");
    await runStatus();
    process.exit(0);
  })();
} else if (cliCommand === "export-audit") {
  // Handle CLI commands like export-audit
  const args = process.argv.slice(3);
  let format = "json";
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) {
      format = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    }
  }

  const config = loadConfig();
  const auditFile = config.OPENGROK_AUDIT_LOG_FILE;

  if (!auditFile) {
    console.error("Error: OPENGROK_AUDIT_LOG_FILE not configured");
    process.exit(1);
  }

  try {
    const result = format === "csv" ? exportAuditLogAsCSV(auditFile) : exportAuditLogAsJSON(auditFile);

    if (output) {
      fs.writeFileSync(output, result);
      console.log(`Audit log exported to ${output}`);
    } else {
      console.log(result);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Export failed: ${err}`);
    process.exit(1);
  }
} else if (cliCommand === "server") {
  // cmd === 'server' || cmd === undefined || cmd === '--server' → normal MCP server startup
  async function main(): Promise<void> {
    const config = resolveConfig();
    const client = new OpenGrokClient(config);

    // Configure audit log file if set
    if (config.OPENGROK_AUDIT_LOG_FILE) {
      configureAuditLog(config.OPENGROK_AUDIT_LOG_FILE);
    }

    // Resolve memory bank directory:
    // 1. OPENGROK_MEMORY_BANK_DIR env var — always set by the VS Code extension, highest priority
    // 2. VSCODE_IPC_HOOK_CLI set — server is running in a VS Code integrated terminal (dev-time),
    //    use cwd-local path for convenience. NOTE: this branch is NOT hit by the VS Code extension
    //    because it always sets OPENGROK_MEMORY_BANK_DIR (step 1).
    // 3. All production standalone clients (Claude Desktop, Claude Code, Cursor, npx) → XDG-aware
    //    config dir: $XDG_CONFIG_HOME/opengrok-mcp/memory-bank (defaults to ~/.config/...)
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const memoryBankDir =
      config.OPENGROK_MEMORY_BANK_DIR ||
      (process.env.VSCODE_IPC_HOOK_CLI
        ? path.join(process.cwd(), ".opengrok", "memory-bank")
        : path.join(xdgConfig, "opengrok-mcp", "memory-bank"));

    const memoryBank = new MemoryBank(memoryBankDir);
    // Skip directory creation when memory tools are disabled — nothing will read them.
    if (config.OPENGROK_ENABLE_MEMORY_TOOLS) {
      await memoryBank.ensureDir();
    }

    // Best-effort grammar inventory — never blocks startup.
    try {
      const { logGrammarStatus } = await import("./intelligence/tree-sitter.js");
      logGrammarStatus();
    } catch { /* tree-sitter is optional */ }

    await runServer(client, config, memoryBank, resolveConfig);
  }

  main().catch((err) => {
    logger.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  console.error(formatUnknownCommandMessage(firstArg ?? ""));
  printHelp();
  process.exit(1);
}
/* v8 ignore stop */
