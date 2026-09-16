import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { parse as tomlParse, stringify as tomlStringify } from '@iarna/toml';
import type { JsonMap, AnyJson } from '@iarna/toml';
import {
  getSetting,
  getSettingsForSurface,
  settingFields,
  validateSettingValue,
} from '../../../shared/settings-catalog.js';
import type { SettingField } from '../../../shared/settings-catalog.js';

export interface McpConfig {
  url: string;
  username?: string;
  scope?: 'user' | 'local' | 'project';
  // All settings that map to server env vars
  verifySsl?: boolean;
  contextBudget?: string;
  codeMode?: boolean;
  enableMemoryTools?: boolean;
  defaultProject?: string;
  enableElicitation?: boolean;
  proxy?: string;
  apiVersion?: string;
  responseFormatOverride?: string;
  memoryBankDir?: string;
  compileDbPaths?: string;
  enableFilesApi?: boolean;
  enableSampling?: boolean;
  samplingModel?: string;
  samplingMaxTokens?: string;
  auditLogFile?: string;
  rateLimitRpm?: string;
  timeout?: string;
  defaultMaxResults?: string;
  enableObservationMasker?: boolean;
  observationMaskerTurns?: string;
  passwordFile?: string;
  maxResponseBytes?: string;
  strictSsrf?: boolean;
  jwtIssuer?: string;
  grammarDir?: string;
}

/** Build the env var object for a given config — only non-default values are written. */
export function buildEnv(config: McpConfig): Record<string, string> {
  const env: Record<string, string> = { OPENGROK_BASE_URL: config.url };
  if (config.username)                                     env['OPENGROK_USERNAME'] = config.username;
  if (config.verifySsl === false)                          env['OPENGROK_VERIFY_SSL'] = 'false';
  if (config.contextBudget && config.contextBudget !== 'standard')
                                                           env['OPENGROK_CONTEXT_BUDGET'] = config.contextBudget;
  if (config.codeMode === false)                           env['OPENGROK_CODE_MODE'] = 'false';
  if (config.enableMemoryTools)                            env['OPENGROK_ENABLE_MEMORY_TOOLS'] = 'true';
  if (config.defaultProject)                               env['OPENGROK_DEFAULT_PROJECT'] = config.defaultProject;
  if (config.enableElicitation === false)                  env['OPENGROK_ENABLE_ELICITATION'] = 'false';
  if (config.proxy) {
    env['HTTP_PROXY'] = config.proxy;
    env['HTTPS_PROXY'] = config.proxy;
  }
  if (config.apiVersion && config.apiVersion !== 'v1')    env['OPENGROK_API_VERSION'] = config.apiVersion;
  if (config.responseFormatOverride)                       env['OPENGROK_RESPONSE_FORMAT_OVERRIDE'] = config.responseFormatOverride;
  if (config.memoryBankDir)                                env['OPENGROK_MEMORY_BANK_DIR'] = config.memoryBankDir;
  if (config.compileDbPaths)                               env['OPENGROK_LOCAL_COMPILE_DB_PATHS'] = config.compileDbPaths;
  if (config.enableFilesApi)                               env['OPENGROK_ENABLE_FILES_API'] = 'true';
  if (config.enableSampling)                               env['OPENGROK_ENABLE_SAMPLING'] = 'true';
  if (config.samplingModel)                                env['OPENGROK_SAMPLING_MODEL'] = config.samplingModel;
  if (config.samplingMaxTokens && config.samplingMaxTokens !== '256')
                                                           env['OPENGROK_SAMPLING_MAX_TOKENS'] = config.samplingMaxTokens;
  if (config.auditLogFile)                                 env['OPENGROK_AUDIT_LOG_FILE'] = config.auditLogFile;
  if (config.rateLimitRpm && config.rateLimitRpm !== '60')
                                                           env['OPENGROK_RATELIMIT_RPM'] = config.rateLimitRpm;
  if (config.timeout && config.timeout !== '30')           env['OPENGROK_TIMEOUT'] = config.timeout;
  if (config.defaultMaxResults && config.defaultMaxResults !== '25')
                                                           env['OPENGROK_DEFAULT_MAX_RESULTS'] = config.defaultMaxResults;
  if (config.enableObservationMasker)                      env['OPENGROK_ENABLE_OBSERVATION_MASKER'] = 'true';
  if (config.observationMaskerTurns && config.observationMaskerTurns !== '10')
                                                           env['OPENGROK_OBSERVATION_MASKER_TURNS'] = config.observationMaskerTurns;
  if (config.passwordFile)                               env['OPENGROK_PASSWORD_FILE'] = config.passwordFile;
  if (config.maxResponseBytes && config.maxResponseBytes !== '0')
                                                           env['OPENGROK_MAX_RESPONSE_BYTES'] = config.maxResponseBytes;
  if (config.strictSsrf)                                 env['OPENGROK_STRICT_SSRF'] = 'true';
  if (config.jwtIssuer)                                  env['OPENGROK_JWT_ISSUER'] = config.jwtIssuer;
  if (config.grammarDir)                                 env['OPENGROK_GRAMMAR_DIR'] = config.grammarDir;
  return env;
}

/**
 * Read existing opengrok-mcp env vars from the first detected MCP client config.
 * Checks Claude Code → Copilot CLI → Codex in priority order.
 * Returns an empty object if no config is found.
 */
export function readStoredEnv(): Record<string, string> {
  // Claude Code (~/.claude.json) — projects[cwd].mcpServers['opengrok-mcp'].env
  try {
    const configPath = join(homedir(), '.claude.json');
    if (existsSync(configPath)) {
      const data = JSON.parse(readFileSync(configPath, 'utf8')) as {
        projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string> }> }>;
      };
      for (const project of Object.values(data.projects ?? {})) {
        const env = project.mcpServers?.['opengrok-mcp']?.env;
        if (env?.['OPENGROK_BASE_URL']) return env;
      }
    }
  } catch { /* ignore */ }

  // GitHub Copilot CLI (~/.copilot/mcp-config.json)
  try {
    const configPath = join(homedir(), '.copilot', 'mcp-config.json');
    if (existsSync(configPath)) {
      const data = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      const env = data.mcpServers?.['opengrok-mcp']?.env;
      if (env?.['OPENGROK_BASE_URL']) return env;
    }
  } catch { /* ignore */ }

  // Codex (~/.config/codex/config.toml or %APPDATA%\codex\config.toml)
  try {
    const configPath = process.platform === 'win32'
      ? join(process.env['APPDATA'] ?? homedir(), 'codex', 'config.toml')
      : join(homedir(), '.config', 'codex', 'config.toml');
    if (existsSync(configPath)) {
      const toml = tomlParse(readFileSync(configPath, 'utf8')) as JsonMap;
      const servers = (toml['mcp_servers'] as AnyJson[] | undefined) ?? [];
      for (const s of servers as Array<Record<string, AnyJson>>) {
        if (s['name'] === 'opengrok-mcp') {
          const env = s['env'] as Record<string, string> | undefined;
          if (env?.['OPENGROK_BASE_URL']) return env;
        }
      }
    }
  } catch { /* ignore */ }

  return {};
}

export function configureClaudeCode(config: McpConfig): void {
  const scope = config.scope ?? 'local';
  const env = buildEnv(config);
  // Remove existing entry first so re-running setup is idempotent.
  spawnSync('claude', ['mcp', 'remove', '--scope', scope, 'opengrok-mcp'], { stdio: 'pipe', shell: false });
  // Server name must come before -e flags: -e is variadic (<env...>) and
  // will otherwise consume the server name as an env var value.
  const args: string[] = ['mcp', 'add', '--transport', 'stdio', '--scope', scope, 'opengrok-mcp'];
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }
  args.push('--', 'npx', '-y', 'opengrok-mcp-server');
  const result = spawnSync('claude', args, { stdio: 'pipe', encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`claude mcp add failed: ${String(result.stderr ?? '')}`);
  }
}

/** Returns the VS Code user-level mcp.json path for the current platform. */
function vscodeUserMcpJsonPath(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? home, 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  // Linux / other
  return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Code', 'User', 'mcp.json');
}

/**
 * Configure VS Code MCP settings by writing to the user-level mcp.json.
 * This avoids launching a VS Code window (which `code --add-mcp` does).
 * Returns the path written.
 */
export function configureVSCode(config: McpConfig): string {
  const env = buildEnv(config);
  const mcpJsonPath = vscodeUserMcpJsonPath();
  const mcpDir = dirname(mcpJsonPath);

  mkdirSync(mcpDir, { recursive: true });

  let existing: { servers?: Record<string, unknown> } = {};
  if (existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as { servers?: Record<string, unknown> };
    } catch { /* treat as empty */ }
  }

  const servers = { ...(existing.servers ?? {}) };
  servers['opengrok-mcp'] = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env,
  };

  writeFileSync(mcpJsonPath, JSON.stringify({ ...existing, servers }, null, 2), 'utf8');
  return mcpJsonPath;
}

/**
 * Configure GitHub Copilot CLI MCP settings using `copilot mcp add`.
 * Uses the Copilot CLI's own command so config is written in the format it expects.
 */
export function configureCopilotCli(config: McpConfig): void {
  const env = buildEnv(config);
  // Remove existing entry first so re-running setup is idempotent.
  spawnSync('copilot', ['mcp', 'remove', 'opengrok-mcp'], { stdio: 'pipe', shell: false });
  // `copilot mcp add <name> --env K=V ... -- command args`
  const args: string[] = ['mcp', 'add', 'opengrok-mcp'];
  for (const [k, v] of Object.entries(env)) {
    args.push('--env', `${k}=${v}`);
  }
  args.push('--', 'npx', '-y', 'opengrok-mcp-server');
  const result = spawnSync('copilot', args, { stdio: 'pipe', encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`copilot mcp add failed: ${String(result.stderr ?? '')}`);
  }
}

export function configureCodex(config: McpConfig): void {
  const configPath = process.platform === 'win32'
    ? join(process.env['APPDATA'] ?? homedir(), 'codex', 'config.toml')
    : join(homedir(), '.config', 'codex', 'config.toml');

  mkdirSync(dirname(configPath), { recursive: true });

  let existing: JsonMap = {};
  if (existsSync(configPath)) {
    try {
      existing = tomlParse(readFileSync(configPath, 'utf8'));
    } catch { /* new file */ }
  }

  const servers = (existing['mcp_servers'] as AnyJson[] | undefined) ?? [];
  // Idempotent: remove existing entry for opengrok-mcp
  const filtered = (servers as Array<Record<string, AnyJson>>)
    .filter((s) => s['name'] !== 'opengrok-mcp');

  filtered.push({
    name: 'opengrok-mcp',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env: buildEnv(config),
  } as unknown as Record<string, AnyJson>);

  existing['mcp_servers'] = filtered as unknown as AnyJson;
  writeFileSync(configPath, tomlStringify(existing), 'utf8');
}

// ---------------------------------------------------------------------------
// Non-interactive single-setting update (`setup --set key=value`)
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied key to its catalog field. Accepts the canonical
 * camelCase id, an OPENGROK_* env var, or the legacy `url` / `opengrokBaseUrl`
 * aliases for the base URL.
 */
function resolveSetField(key: string): SettingField | undefined {
  if (key === 'url' || key === 'baseUrl' || key === 'opengrokBaseUrl') {
    try {
      return getSetting('baseUrl');
    } catch {
      return undefined;
    }
  }
  if (key === 'OPENGROK_PROXY' || key === 'HTTPS_PROXY') {
    try {
      return getSetting('proxy');
    } catch {
      return undefined;
    }
  }
  try {
    return getSetting(key);
  } catch {
    // Fall through to env-var lookup.
  }
  return settingFields.find((field) => field.env === key);
}

/** Valid `setup --set` key names (canonical camelCase ids, secrets excluded). */
export function listSetKeys(): string[] {
  return getSettingsForSurface('cli')
    .filter((field) => !field.secret)
    .map((field) => field.id);
}

/** Split a `key=value` argument on the first `=`. Throws on malformed input. */
export function parseSetArg(arg: string): { key: string; value: string } {
  const eq = arg.indexOf('=');
  if (eq <= 0) {
    throw new Error(`Expected key=value, got "${arg}". Valid keys: ${listSetKeys().join(', ')}`);
  }
  return { key: arg.slice(0, eq).trim(), value: arg.slice(eq + 1).trim() };
}

/**
 * Validate a `--set` key/value pair and normalize it to an env var assignment.
 * Returns `{ env, value }` where an empty value means "delete the var".
 * Passwords are refused — use the interactive wizard (keychain storage) instead.
 */
export function resolveSetKey(key: string, value: string): { env: string; value: string } {
  if (/^(password|OPENGROK_PASSWORD)$/i.test(key)) {
    throw new Error('Refusing to store a password via --set (it would land in shell history). Run `opengrok-mcp setup` instead.');
  }
  const field = resolveSetField(key);
  if (!field || !field.surfaces.includes('cli')) {
    throw new Error(`Unknown setting "${key}". Valid keys: ${listSetKeys().join(', ')}`);
  }
  if (field.secret) {
    throw new Error('Refusing to store a password via --set (it would land in shell history). Run `opengrok-mcp setup` instead.');
  }
  if (!field.env) {
    throw new Error(`Unknown setting "${key}". Valid keys: ${listSetKeys().join(', ')}`);
  }
  if (value === '') {
    const clearable =
      field.type === 'string' ||
      field.type === 'url' ||
      (field.type === 'enum' && field.default === '');
    if (!clearable) {
      throw new Error(`"${key}" requires a value.`);
    }
    return { env: field.env, value: '' };
  }
  switch (field.type) {
    case 'boolean':
      if (value !== 'true' && value !== 'false') throw new Error(`"${key}" must be true or false.`);
      return { env: field.env, value };
    case 'enum': {
      const choices = field.options?.map((option) => option.value) ?? [];
      if (!choices.includes(value)) throw new Error(`"${key}" must be one of: ${choices.join(', ')}.`);
      return { env: field.env, value };
    }
    case 'integer': {
      const n = Number(value);
      const minimum = field.minimum ?? 1;
      if (!Number.isInteger(n)) {
        throw new Error(
          minimum === 0
            ? `"${key}" must be a non-negative integer (0 = budget default).`
            : `"${key}" must be a positive integer.`,
        );
      }
      if (field.minimum !== undefined && n < field.minimum) {
        if (field.minimum === 1 || field.minimum === 0) {
          throw new Error(
            field.minimum === 0
              ? `"${key}" must be a non-negative integer (0 = budget default).`
              : `"${key}" must be a positive integer.`,
          );
        }
        throw new Error(`"${key}" must be a number greater than or equal to ${field.minimum}.`);
      }
      if (field.maximum !== undefined && n > field.maximum) {
        throw new Error(`"${key}" must be a number less than or equal to ${field.maximum}.`);
      }
      return { env: field.env, value: String(n) };
    }
    case 'url': {
      const validation = validateSettingValue(field, value);
      if (validation) throw new Error(`"${key}": ${validation}.`);
      return { env: field.env, value };
    }
    default:
      return { env: field.env, value };
  }
}

/** Apply a normalized assignment to a stored env object (empty value deletes). */
export function applyEnvPatch(env: Record<string, string>, entry: { env: string; value: string }): Record<string, string> {
  if (entry.value === '') {
    const { [entry.env]: _dropped, ...rest } = env;
    void _dropped;
    return rest;
  }
  return { ...env, [entry.env]: entry.value };
}

function claudeConfigPath(home: string): string {
  return join(home, '.claude.json');
}

function copilotConfigPath(home: string): string {
  return join(home, '.copilot', 'mcp-config.json');
}

function codexConfigPath(home: string): string {
  return process.platform === 'win32'
    ? join(process.env['APPDATA'] ?? home, 'codex', 'config.toml')
    : join(home, '.config', 'codex', 'config.toml');
}

function vscodeMcpPath(home: string): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? home, 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Code', 'User', 'mcp.json');
}

/**
 * Update one setting in every MCP client config that already contains an
 * opengrok-mcp entry. Only existing entries are patched — run `setup` first
 * to create them. Returns the names of updated clients.
 * `homeOverride` redirects home-directory resolution (tests).
 */
export function updateStoredSetting(key: string, value: string, homeOverride?: string): string[] {
  const entry = resolveSetKey(key, value);
  const home = homeOverride ?? homedir();
  const updated: string[] = [];

  const patchFileEnv = (
    file: string,
    read: (text: string) => Record<string, string> | null,
    write: (text: string, env: Record<string, string>) => string,
  ): boolean => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch { return false; }
    const env = read(text);
    if (!env) return false;
    writeFileSync(file, write(text, applyEnvPatch(env, entry)), 'utf8');
    return true;
  };

  // Claude Code — patch env in every project block containing opengrok-mcp
  try {
    const file = claudeConfigPath(home);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string> }> }>;
      };
      let touched = false;
      for (const project of Object.values(data.projects ?? {})) {
        const srv = project.mcpServers?.['opengrok-mcp'];
        if (srv?.env) {
          srv.env = applyEnvPatch(srv.env, entry);
          touched = true;
        }
      }
      if (touched) {
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        updated.push('Claude Code');
      }
    }
  } catch { /* leave file untouched on parse errors */ }

  // Copilot CLI
  if (patchFileEnv(
    copilotConfigPath(home),
    (text) => {
      try {
        const data = JSON.parse(text) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
        return data.mcpServers?.['opengrok-mcp']?.env ?? null;
      } catch { return null; }
    },
    (text, env) => {
      const data = JSON.parse(text) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      if (data.mcpServers?.['opengrok-mcp']) data.mcpServers['opengrok-mcp'].env = env;
      return JSON.stringify(data, null, 2);
    },
  )) {
    updated.push('Copilot CLI');
  }

  // Codex (TOML)
  try {
    const file = codexConfigPath(home);
    if (existsSync(file)) {
      const toml = tomlParse(readFileSync(file, 'utf8')) as JsonMap;
      const servers = (toml['mcp_servers'] as Array<Record<string, AnyJson>> | undefined) ?? [];
      let touched = false;
      for (const s of servers) {
        if (s['name'] === 'opengrok-mcp' && s['env'] && typeof s['env'] === 'object') {
          s['env'] = applyEnvPatch(s['env'] as Record<string, string>, entry) as unknown as AnyJson;
          touched = true;
        }
      }
      if (touched) {
        writeFileSync(file, tomlStringify(toml), 'utf8');
        updated.push('Codex');
      }
    }
  } catch { /* leave file untouched on parse errors */ }

  // VS Code mcp.json
  try {
    const file = vscodeMcpPath(home);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { servers?: Record<string, { env?: Record<string, string> }> };
      if (data.servers?.['opengrok-mcp']?.env) {
        data.servers['opengrok-mcp'].env = applyEnvPatch(data.servers['opengrok-mcp'].env as Record<string, string>, entry);
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        updated.push('VS Code');
      }
    }
  } catch { /* leave file untouched on parse errors */ }

  return updated;
}
