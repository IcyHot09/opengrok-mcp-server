import { loadConfig, type Config } from '../config.js';
import { OpenGrokClient } from '../client/index.js';
import { detectInstalledClients } from './setup/detect.js';
import { retrievePassword } from './keychain.js';
import { getKeyringEntry } from './keyring-loader.js';
import { readStoredEnv } from './setup/configure.js';
import { renderStatus, type StatusData, type OpengrokStatus, type UpdateStatus } from './status-view.js';
import * as fs from 'fs';

// __VERSION__ is injected at build time; fall back for dev/test
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : (process.env['npm_package_version'] ?? '0.0.0');

/**
 * Resolve the effective server config for CLI diagnostics: explicit env vars
 * win, otherwise fall back to the MCP client configs written by setup, with
 * the password resolved from the file mount or OS keychain. Returns null
 * (after printing guidance) when nothing is configured.
 */
export function resolveStatusConfig(): { config: Config; overrides: Record<string, string>; authSource: string } | null {
  // If OPENGROK_BASE_URL is not set in the environment, fall back to reading
  // from the MCP client config files written by `opengrok-mcp setup`.
  let configOverrides: Record<string, string> = {};
  if (!process.env['OPENGROK_BASE_URL']) {
    configOverrides = readStoredEnv();
  }

  // Resolve password from file-mounted secret or keychain if not already provided
  const username = process.env['OPENGROK_USERNAME'] ?? configOverrides['OPENGROK_USERNAME'] ?? '';
  const envPassword = process.env['OPENGROK_PASSWORD'] ?? configOverrides['OPENGROK_PASSWORD'] ?? '';
  const passwordFile = process.env['OPENGROK_PASSWORD_FILE'] ?? '';
  let authSource = 'none';
  if (!username) {
    authSource = 'anonymous';
  } else if (envPassword) {
    authSource = 'env';
  } else {
    let fileOk = false;
    if (passwordFile) {
      try {
        const filePassword = fs.readFileSync(passwordFile, 'utf8').trim();
        if (filePassword) {
          configOverrides = { ...configOverrides, OPENGROK_PASSWORD: filePassword };
          fileOk = true;
        }
      } catch { /* warn at server startup instead */ }
    }
    if (fileOk) {
      authSource = 'password-file';
    } else {
      if (!configOverrides['OPENGROK_PASSWORD']) {
        const keychainPassword = retrievePassword(username);
        if (keychainPassword) {
          configOverrides = { ...configOverrides, OPENGROK_PASSWORD: keychainPassword };
          // Distinguish keychain vs encrypted-file via a direct keyring probe.
          try {
            const entry = getKeyringEntry(username, 'opengrok-mcp');
            let keyringPw: string | null = null;
            try {
              keyringPw = entry?.getPassword() ?? null;
            } catch {
              keyringPw = null;
            }
            authSource = keyringPw !== null ? 'keychain' : 'encrypted-file';
          } catch {
            authSource = 'encrypted-file';
          }
        } else {
          authSource = 'none';
        }
      } else {
        authSource = 'env';
      }
    }
  }

  let config: Config;
  try {
    config = loadConfig(Object.keys(configOverrides).length > 0 ? configOverrides : undefined);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!process.env['OPENGROK_BASE_URL'] && !configOverrides['OPENGROK_BASE_URL']) {
      console.error(
        "OpenGrok MCP Server is not configured.\n" +
        "  Run: npx opengrok-mcp-server setup\n" +
        "  Or set the OPENGROK_BASE_URL environment variable."
      );
    } else {
      console.error(`Configuration error: ${msg}`);
    }
    process.exitCode = 1;
    return null;
  }
  // Re-derive anonymous when the resolved config has no username (e.g. stored
  // config without username).
  if (!config.OPENGROK_USERNAME) authSource = 'anonymous';
  return { config, overrides: configOverrides, authSource };
}

export async function runStatus(): Promise<void> {
  const resolved = resolveStatusConfig();
  if (!resolved) return; // error already printed
  const { config, overrides: configOverrides, authSource } = resolved;

  let client: OpenGrokClient;
  try {
    client = new OpenGrokClient(config);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!config.OPENGROK_BASE_URL || msg.includes("OPENGROK_BASE_URL")) {
      console.error(
        "OpenGrok MCP Server is not configured.\n" +
        "  Run: npx opengrok-mcp-server setup\n" +
        "  Or set the OPENGROK_BASE_URL environment variable."
      );
    } else {
      console.error(`Configuration error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  let opengrok: OpengrokStatus;
  const baseOpengrok = {
    url: config.OPENGROK_BASE_URL,
    username: config.OPENGROK_USERNAME || '',
    authSource,
    verifySsl: config.OPENGROK_VERIFY_SSL,
  };
  const startMs = Date.now();
  try {
    const projects = await client.listProjects();
    const latencyMs = Date.now() - startMs;
    opengrok = { ...baseOpengrok, connected: true, projects: projects.length, latencyMs };
  } catch (e) {
    opengrok = { ...baseOpengrok, connected: false, error: (e as Error).message };
  }
  try {
    const maybeClose = (client as unknown as { close?: () => Promise<void> }).close;
    if (typeof maybeClose === 'function') await maybeClose.call(client).catch(() => undefined);
  } catch { /* best effort */ }

  const mode = config.OPENGROK_CODE_MODE ? 'Code Mode (5 tools)' : 'Standard Mode';
  const budget = config.OPENGROK_CONTEXT_BUDGET ?? 'standard';

  const passwordFilePath = process.env['OPENGROK_PASSWORD_FILE'] ?? configOverrides['OPENGROK_PASSWORD_FILE'] ?? '';
  const maxResponseRaw = process.env['OPENGROK_MAX_RESPONSE_BYTES'] ?? configOverrides['OPENGROK_MAX_RESPONSE_BYTES'] ?? '';
  const maxResponseNum = parseInt(maxResponseRaw, 10);
  const responseCap = Number.isFinite(maxResponseNum) && maxResponseNum >= 1
    ? `${maxResponseNum} bytes`
    : 'budget default';
  const source = process.env['OPENGROK_BASE_URL']
    ? 'environment'
    : (configOverrides['OPENGROK_BASE_URL'] ? 'stored config' : '');

  const clients = detectInstalledClients();
  const update = await checkForUpdate(VERSION);

  const data: StatusData = {
    version: VERSION,
    opengrok,
    config: {
      source,
      mode,
      budget,
      project: config.OPENGROK_DEFAULT_PROJECT ?? '',
      passwordFile: passwordFilePath || undefined,
      responseCap,
      strictSsrf: config.OPENGROK_STRICT_SSRF,
      jwtIssuer: config.OPENGROK_JWT_ISSUER || undefined,
      grammarDir: config.OPENGROK_GRAMMAR_DIR || undefined,
    },
    clients: {
      claudeCode: clients.claudeCode,
      copilotCli: clients.copilotCli,
      codex: clients.codex,
    },
    update,
  };

  console.log(renderStatus(data));
}

/**
 * Non-interactive connection check (`setup --test`): resolves the stored
 * config exactly like status, then verifies the server is reachable.
 * Sets process.exitCode (0 = reachable, 1 = failure) instead of throwing.
 */
export async function runSetupTest(): Promise<void> {
  const resolved = resolveStatusConfig();
  if (!resolved) return; // error already printed, exitCode set
  const { config } = resolved;
  let client: OpenGrokClient;
  try {
    client = new OpenGrokClient(config);
  } catch (e) {
    console.error(`Connection test failed: ${(e as Error).message ?? String(e)}`);
    process.exitCode = 1;
    return;
  }
  const startMs = Date.now();
  const connected = await client.testConnection();
  if (connected) {
    console.log(`Connection OK: ${config.OPENGROK_BASE_URL} (${Date.now() - startMs} ms)`);
  } else {
    console.error(`Connection failed: ${config.OPENGROK_BASE_URL} is unreachable (or returned 5xx).`);
    process.exitCode = 1;
  }
}

async function checkForUpdate(currentVersion: string): Promise<UpdateStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch('https://registry.npmjs.org/opengrok-mcp-server/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const data = await res.json() as { version?: string };
    if (data.version && data.version !== currentVersion) {
      return { available: true, latestVersion: data.version };
    }
    return { available: false };
  } catch (e) {
    const msg = (e as Error).message?.split('\n')[0] ?? 'unknown';
    return { available: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
