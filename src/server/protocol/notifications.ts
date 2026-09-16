/**
 * Notification handlers - SIGHUP config reload (split from server.ts, pure move).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenGrokClient } from "../client/index.js";
import type { Config } from "../config.js";
import { loadConfig, resetConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { auditLog } from "../transport/audit.js";

// Track the registered handler so repeat calls (tests, HTTP-transport sessions)
// REPLACE the previous listener instead of accumulating duplicates — Node warns
// about a possible memory leak once 11 listeners pile up on process.
let _registeredSighupHandler: (() => void) | null = null;

/**
 * Setup handlers for notifications/tools/list_changed.
 * Monitors for config changes (SIGHUP) and connectivity status changes.
 *
 * @param configLoader - Function that resolves the full config, including keychain
 *   lookup if applicable. Passed from the entry point so SIGHUP reloads go through
 *   the same path as initial startup (preventing a stale closure over the original
 *   loadConfig reference, which would skip keychain credentials on reload).
 */
export function setupNotificationHandlers(
  _server: McpServer,
  _client: OpenGrokClient,
  config: Config,
  // Default loader is lenient: a bad env edit during SIGHUP must retain the
  // prior config, never exit the process (loadConfig's startup default stays fatal).
  configLoader: () => Config = () => loadConfig(undefined, { fatal: false })
): void {
  // On SIGHUP, reload config and notify if code mode changed.
  // Replace any previously registered handler so the active closure always
  // references the latest session's config/configLoader.
  if (_registeredSighupHandler) {
    process.off("SIGHUP", _registeredSighupHandler);
  }

  const sighupHandler = (): void => {
    try {
      auditLog({ type: "config_load", detail: "SIGHUP: config reload initiated" });
      logger.info("Received SIGHUP, reloading config...");

      // IMPORTANT: Only environment-variable-sourced fields (e.g. OPENGROK_CODE_MODE,
      // OPENGROK_CONTEXT_BUDGET) are re-read on SIGHUP. Changes to OPENGROK_BASE_URL,
      // OPENGROK_USERNAME, OPENGROK_PASSWORD, and all other credentials are NOT applied
      // because live tool handlers hold a closure over the original frozen config object
      // and the OpenGrokClient was constructed at startup with the initial credentials.
      // A full process restart is required for URL and credential changes to take effect.
      logger.warn(
        "SIGHUP: OPENGROK_BASE_URL and credential changes require a full process restart to take effect. " +
        "Only runtime flags (e.g. OPENGROK_CODE_MODE, OPENGROK_CONTEXT_BUDGET) are re-applied."
      );

      // Clear the singleton so the next loadConfig() re-reads from process.env
      resetConfig();
      const newConfig = configLoader();

      // Check if code mode changed
      if (newConfig.OPENGROK_CODE_MODE !== config.OPENGROK_CODE_MODE) {
        // Tool registrations are fixed at startup — sending toolListChanged would be
        // misleading since clients would re-query and receive the original list.
        // Code Mode changes require a server restart to take effect.
        logger.warn(
          `Code Mode changed: ${config.OPENGROK_CODE_MODE} → ${newConfig.OPENGROK_CODE_MODE}. ` +
          `Restart the server for the new tool set to take effect.`
        );
        auditLog({
          type: "config_load",
          detail: `SIGHUP: Code Mode toggled to ${newConfig.OPENGROK_CODE_MODE} (restart required)`
        });
      }
    } catch (err) {
      // Retain prior config on failure (reload != shutdown): the throw from a
      // fatal:false loader leaves live handlers on the original frozen config.
      logger.error("SIGHUP reload failed", { error: String(err) });
    }
  };

  _registeredSighupHandler = sighupHandler;
  process.on("SIGHUP", sighupHandler);
}

/** Detach the SIGHUP handler — for testing only. */
export function _resetSighupRegistered(): void {
  if (_registeredSighupHandler) {
    process.off("SIGHUP", _registeredSighupHandler);
    _registeredSighupHandler = null;
  }
}
