/**
 * Setup utilities shared by the Ink TUI setup flow.
 *
 * Converts stored client env vars into TUI state, maps state back to the
 * client config shape, and applies the finished configuration.
 */
import * as http from 'http';
import * as https from 'https';
import { configureClaudeCode, configureCodex, configureCopilotCli } from './configure.js';
import type { McpConfig } from './configure.js';
import { detectInstalledClients } from './detect.js';
import { storeCredentials, retrievePassword } from '../keychain.js';
import { parseProjectsFromHtml } from '../../../shared/html-parsers.js';
import { getHttpsTlsOptions } from '../../../shared/tls-ca.js';
import type { SetupState } from '../tui/types.js';

/**
 * Normalize a user-typed server URL: trim, prepend https:// when no scheme
 * is present, and accept only http(s). Returns null when unusable.
 */
export function normalizeBaseUrl(input: string): string | null {
  const candidate = input.trim();
  if (!candidate) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)
    ? candidate
    : `https://${candidate}`;
  try {
    const parsed = new URL(withScheme);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return withScheme;
  } catch {
    return null;
  }
}

export function createInitialState(stored: Record<string, string>): SetupState {
  const username = stored['OPENGROK_USERNAME'] ?? '';
  const storedPassword = username ? retrievePassword(username) : null;

  const storedBool = (key: string, def: boolean): boolean => {
    const v = stored[key];
    return v === undefined ? def : v === 'true';
  };
  const storedStr = (key: string, def = ''): string => stored[key] ?? def;

  return {
    baseUrl: storedStr('OPENGROK_BASE_URL'),
    username,
    password: '',
    hasStoredPassword: Boolean(storedPassword),
    storedPassword,
    defaultProject: storedStr('OPENGROK_DEFAULT_PROJECT'),
    codeMode: storedBool('OPENGROK_CODE_MODE', true),
    enableMemoryTools: storedBool('OPENGROK_ENABLE_MEMORY_TOOLS', false),
    enableElicitation: storedBool('OPENGROK_ENABLE_ELICITATION', true),
    contextBudget: storedStr('OPENGROK_CONTEXT_BUDGET', 'standard'),
    defaultMaxResults: storedStr('OPENGROK_DEFAULT_MAX_RESULTS', '25'),
    responseFormatOverride: storedStr('OPENGROK_RESPONSE_FORMAT_OVERRIDE'),
    enableFilesApi: storedBool('OPENGROK_ENABLE_FILES_API', false),
    enableSampling: storedBool('OPENGROK_ENABLE_SAMPLING', false),
    samplingModel: storedStr('OPENGROK_SAMPLING_MODEL'),
    samplingMaxTokens: storedStr('OPENGROK_SAMPLING_MAX_TOKENS', '256'),
    enableObservationMasker: storedBool('OPENGROK_ENABLE_OBSERVATION_MASKER', false),
    observationMaskerTurns: storedStr('OPENGROK_OBSERVATION_MASKER_TURNS', '10'),
    verifySsl: storedBool('OPENGROK_VERIFY_SSL', true),
    proxy: stored['HTTP_PROXY'] ?? stored['HTTPS_PROXY'] ?? stored['OPENGROK_PROXY'] ?? '',
    apiVersion: storedStr('OPENGROK_API_VERSION', 'v1'),
    rateLimitRpm: storedStr('OPENGROK_RATELIMIT_RPM', '60'),
    timeout: storedStr('OPENGROK_TIMEOUT', '30'),
    memoryBankDir: storedStr('OPENGROK_MEMORY_BANK_DIR'),
    compileDbPaths: storedStr('OPENGROK_LOCAL_COMPILE_DB_PATHS'),
    auditLogFile: storedStr('OPENGROK_AUDIT_LOG_FILE'),
    passwordFile: storedStr('OPENGROK_PASSWORD_FILE'),
    maxResponseBytes: storedStr('OPENGROK_MAX_RESPONSE_BYTES', '0'),
    strictSsrf: storedBool('OPENGROK_STRICT_SSRF', false),
    jwtIssuer: storedStr('OPENGROK_JWT_ISSUER'),
    grammarDir: storedStr('OPENGROK_GRAMMAR_DIR'),
  };
}

export function toMcpConfig(state: SetupState): McpConfig {
  return {
    url: state.baseUrl,
    username: state.username,
    verifySsl: state.verifySsl,
    contextBudget: state.contextBudget,
    codeMode: state.codeMode,
    enableMemoryTools: state.enableMemoryTools,
    defaultProject: state.defaultProject,
    enableElicitation: state.enableElicitation,
    proxy: state.proxy,
    apiVersion: state.apiVersion,
    responseFormatOverride: state.responseFormatOverride,
    memoryBankDir: state.memoryBankDir,
    compileDbPaths: state.compileDbPaths,
    enableFilesApi: state.enableFilesApi,
    enableSampling: state.enableSampling,
    samplingModel: state.samplingModel,
    samplingMaxTokens: state.samplingMaxTokens,
    auditLogFile: state.auditLogFile,
    rateLimitRpm: state.rateLimitRpm,
    timeout: state.timeout,
    defaultMaxResults: state.defaultMaxResults,
    enableObservationMasker: state.enableObservationMasker,
    observationMaskerTurns: state.observationMaskerTurns,
    passwordFile: state.passwordFile,
    maxResponseBytes: state.maxResponseBytes,
    strictSsrf: state.strictSsrf,
    jwtIssuer: state.jwtIssuer,
    grammarDir: state.grammarDir,
  };
}

export function testConnection(state: SetupState): Promise<string> {
  return new Promise((resolve, reject) => {
    const password = state.password || state.storedPassword || '';
    let url: URL;
    try {
      url = new URL(state.baseUrl);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const options: http.RequestOptions = {
      method: 'GET',
      timeout: 10000,
      headers: {},
      ...(url.protocol === 'https:' ? getHttpsTlsOptions(state.verifySsl) : {}),
    };
    if (state.username && password) {
      options.headers = { Authorization: `Basic ${Buffer.from(`${state.username}:${password}`).toString('base64')}` };
    }

    const req = transport.request(url, options, (res) => {
      res.resume();
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 400) resolve(`✓ Connected (HTTP ${status})`);
        else if (status === 401) reject(new Error('✗ Auth failed (401)'));
        else if (status === 403) reject(new Error('✗ Access denied (403)'));
        else reject(new Error(`✗ HTTP ${status}`));
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('✗ Timeout'));
    });
    req.on('error', (e) => reject(new Error(`✗ ${e.message}`)));
    req.end();
  });
}

/**
 * Fetch the project list from an OpenGrok server.
 * Parses <select id="project"> options or /xref/ links from the root page HTML.
 */
export function fetchProjects(state: SetupState): Promise<string[]> {
  return new Promise((resolve) => {
    const password = state.password || state.storedPassword || '';
    let url: URL;
    try {
      url = new URL(state.baseUrl);
    } catch {
      resolve([]);
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const options: http.RequestOptions = {
      method: 'GET',
      timeout: 10000,
      headers: {},
      ...(url.protocol === 'https:' ? getHttpsTlsOptions(state.verifySsl) : {}),
    };
    if (state.username && password) {
      options.headers = { Authorization: `Basic ${Buffer.from(`${state.username}:${password}`).toString('base64')}` };
    }

    const req = transport.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 400) {
          resolve([]);
          return;
        }
        const html = Buffer.concat(chunks).toString('utf-8');
        resolve(parseProjectsFromHtml(html).sort());
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

export function applyConfig(state: SetupState): string[] {
  const warnings: string[] = [];
  const password = state.password || state.storedPassword || '';
  if (state.username && password) {
    const result = storeCredentials(state.baseUrl, state.username, password);
    if (result?.source === 'encrypted-file') {
      console.warn('⚠ OS keychain unavailable; OpenGrok credentials stored in encrypted file fallback.');
    }
    if (result?.warning) {
      warnings.push(result.warning);
    }
  }

  const config = toMcpConfig(state);
  const clients = detectInstalledClients();

  if (clients.claudeCode) {
    try {
      configureClaudeCode(config);
      console.log('✓ Claude Code CLI configured');
    } catch (e) {
      console.error(`✗ Claude Code: ${(e as Error).message}`);
    }
  }
  if (clients.codex) {
    try {
      configureCodex(config);
      console.log('✓ Codex CLI configured');
    } catch (e) {
      console.error(`✗ Codex: ${(e as Error).message}`);
    }
  }
  if (clients.copilotCli) {
    try {
      configureCopilotCli(config);
      console.log('✓ GitHub Copilot CLI configured');
    } catch (e) {
      console.error(`✗ Copilot CLI: ${(e as Error).message}`);
    }
  }
  if (!clients.claudeCode && !clients.codex && !clients.copilotCli) {
    console.warn('⚠ No MCP client CLIs detected.');
  }

  console.log('\nopengrok-mcp setup complete.');
  console.log('');
  console.log('  Backends:');
  console.log(`    OpenGrok  ${state.username ? '✓ ' + (state.baseUrl || '(not configured)') : '(not configured)'}`);
  console.log('\nNext steps:');
  console.log('  opengrok-mcp status   — verify connection and configuration');
  for (const warning of warnings) {
    console.warn(`\n⚠ ${warning}`);
  }
  return warnings;
}
