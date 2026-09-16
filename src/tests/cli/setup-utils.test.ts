import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { SetupState } from '../../server/cli/tui/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks follow the same pattern as setup.test.ts: hoisted factories for the
// keychain, client detection, and per-client configure functions.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../server/cli/keychain.js', () => ({
  storeCredentials: vi.fn(() => ({ source: 'keychain' as const })),
  retrievePassword: vi.fn(() => null as string | null),
}));

vi.mock('../../server/cli/setup/detect.js', () => ({
  detectInstalledClients: vi.fn(() => ({ claudeCode: false, codex: false, copilotCli: false })),
}));

vi.mock('../../server/cli/setup/configure.js', () => ({
  configureClaudeCode: vi.fn(),
  configureCodex: vi.fn(),
  configureCopilotCli: vi.fn(),
  readStoredEnv: vi.fn(() => ({})),
}));

import { storeCredentials, retrievePassword } from '../../server/cli/keychain.js';
import { detectInstalledClients } from '../../server/cli/setup/detect.js';
import { configureClaudeCode, configureCodex, configureCopilotCli } from '../../server/cli/setup/configure.js';
import {
  createInitialState,
  normalizeBaseUrl,
  toMcpConfig,
  testConnection,
  fetchProjects,
  applyConfig,
} from '../../server/cli/setup/setup-utils.js';

function blankState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    baseUrl: '',
    username: '',
    password: '',
    hasStoredPassword: false,
    storedPassword: null,
    defaultProject: '',
    codeMode: true,
    enableMemoryTools: false,
    enableElicitation: true,
    contextBudget: 'standard',
    defaultMaxResults: '25',
    responseFormatOverride: '',
    enableFilesApi: false,
    enableSampling: false,
    samplingModel: '',
    samplingMaxTokens: '256',
    enableObservationMasker: false,
    observationMaskerTurns: '10',
    verifySsl: true,
    proxy: '',
    apiVersion: 'v1',
    rateLimitRpm: '60',
    timeout: '30',
    memoryBankDir: '',
    compileDbPaths: '',
    auditLogFile: '',
    passwordFile: '',
    maxResponseBytes: '0',
    strictSsrf: false,
    jwtIssuer: '',
    grammarDir: '',
    ...overrides,
  };
}

describe('normalizeBaseUrl', () => {
  it('prepends https:// when no scheme is present', () => {
    expect(normalizeBaseUrl('asfasf.ascasc.com')).toBe('https://asfasf.ascasc.com');
    expect(normalizeBaseUrl('  host.example.com/source/  ')).toBe('https://host.example.com/source/');
  });

  it('keeps explicit http/https URLs as typed', () => {
    expect(normalizeBaseUrl('https://og.example.com/source/')).toBe('https://og.example.com/source/');
    expect(normalizeBaseUrl('http://intranet:8080/source/')).toBe('http://intranet:8080/source/');
  });

  it('rejects blank, non-URL, and non-http(s) input', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl('not a url at all')).toBeNull();
    expect(normalizeBaseUrl('ftp://host/source/')).toBeNull();
  });
});

describe('createInitialState', () => {
  beforeEach(() => {
    vi.mocked(retrievePassword).mockReturnValue(null);
  });

  afterEach(() => vi.clearAllMocks());

  it('defaults verifySsl to true and elicitation to true', () => {
    const state = createInitialState({});
    expect(state.verifySsl).toBe(true);
    expect(state.enableElicitation).toBe(true);
    expect(state.enableMemoryTools).toBe(false);
    expect(state.codeMode).toBe(true);
    expect(state.hasStoredPassword).toBe(false);
    expect(state.storedPassword).toBeNull();
  });

  it('defaults numeric/text settings to the documented values', () => {
    const state = createInitialState({});
    expect(state).toMatchObject({
      baseUrl: '',
      username: '',
      password: '',
      defaultProject: '',
      contextBudget: 'standard',
      defaultMaxResults: '25',
      responseFormatOverride: '',
      samplingMaxTokens: '256',
      observationMaskerTurns: '10',
      apiVersion: 'v1',
      rateLimitRpm: '60',
      timeout: '30',
      maxResponseBytes: '0',
    });
  });

  it('reads stored OPENGROK_ values', () => {
    const state = createInitialState({
      OPENGROK_BASE_URL: 'https://og.example.com/source/',
      OPENGROK_USERNAME: 'alice',
      OPENGROK_VERIFY_SSL: 'false',
      OPENGROK_ENABLE_ELICITATION: 'true',
      OPENGROK_CODE_MODE: 'false',
      OPENGROK_CONTEXT_BUDGET: 'generous',
      OPENGROK_DEFAULT_PROJECT: 'backend',
      HTTP_PROXY: 'http://proxy:8080',
    });
    expect(state.baseUrl).toBe('https://og.example.com/source/');
    expect(state.username).toBe('alice');
    expect(state.verifySsl).toBe(false);
    expect(state.enableElicitation).toBe(true);
    expect(state.codeMode).toBe(false);
    expect(state.contextBudget).toBe('generous');
    expect(state.defaultProject).toBe('backend');
    expect(state.proxy).toBe('http://proxy:8080');
  });

  it('resolves a stored password for a known username', () => {
    vi.mocked(retrievePassword).mockReturnValue('s3cret');
    const state = createInitialState({ OPENGROK_USERNAME: 'alice' });
    expect(retrievePassword).toHaveBeenCalledWith('alice');
    expect(state.hasStoredPassword).toBe(true);
    expect(state.storedPassword).toBe('s3cret');
  });
});

describe('toMcpConfig', () => {
  it('maps state fields onto the client config shape', () => {
    const config = toMcpConfig(
      blankState({
        baseUrl: 'https://og.example.com/source/',
        username: 'alice',
        verifySsl: false,
        contextBudget: 'generous',
        defaultProject: 'backend',
        strictSsrf: true,
        passwordFile: '/run/secrets/pw',
        jwtIssuer: 'https://idp.example.com/',
        grammarDir: '/grammars',
      }),
    );
    expect(config).toMatchObject({
      url: 'https://og.example.com/source/',
      username: 'alice',
      verifySsl: false,
      contextBudget: 'generous',
      defaultProject: 'backend',
      strictSsrf: true,
      passwordFile: '/run/secrets/pw',
      jwtIssuer: 'https://idp.example.com/',
      grammarDir: '/grammars',
    });
  });
});

describe('testConnection / fetchProjects (local http server)', () => {
  let server: http.Server;
  let baseUrl: string;
  let statusCode = 200;
  let body = '<html><body>ok</body></html>';

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'text/html' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/source/`;
    statusCode = 200;
    body = '<html><body>ok</body></html>';
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('resolves on HTTP 200', async () => {
    await expect(testConnection(blankState({ baseUrl }))).resolves.toMatch(/Connected \(HTTP 200\)/);
  });

  it('rejects on 401 with an auth message', async () => {
    statusCode = 401;
    await expect(testConnection(blankState({ baseUrl }))).rejects.toThrow(/Auth failed \(401\)/);
  });

  it('rejects invalid URLs', async () => {
    await expect(testConnection(blankState({ baseUrl: 'not a url' }))).rejects.toThrow(/Invalid URL/);
    await expect(testConnection(blankState({ baseUrl: '' }))).rejects.toThrow(/Invalid URL/);
  });

  it('parses project options from the root page', async () => {
    body = `<html><body><select id="project">
      <option value="backend">backend</option>
      <option value="frontend">frontend</option>
    </select></body></html>`;
    await expect(fetchProjects(blankState({ baseUrl }))).resolves.toEqual(['backend', 'frontend']);
  });

  it('returns [] on non-200 responses and invalid URLs', async () => {
    statusCode = 500;
    await expect(fetchProjects(blankState({ baseUrl }))).resolves.toEqual([]);
    await expect(fetchProjects(blankState({ baseUrl: '::bad' }))).resolves.toEqual([]);
  });
});

describe('applyConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(retrievePassword).mockReturnValue(null);
    vi.mocked(storeCredentials).mockReturnValue({ source: 'keychain' });
    vi.mocked(detectInstalledClients).mockReturnValue({ claudeCode: false, codex: false, copilotCli: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('stores credentials and configures detected clients', () => {
    vi.mocked(detectInstalledClients).mockReturnValue({ claudeCode: true, codex: false, copilotCli: false });
    const warnings = applyConfig(
      blankState({ baseUrl: 'https://og.example.com/source/', username: 'alice', password: 'pw' }),
    );
    expect(storeCredentials).toHaveBeenCalledWith('https://og.example.com/source/', 'alice', 'pw');
    expect(configureClaudeCode).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://og.example.com/source/' }));
    expect(configureCodex).not.toHaveBeenCalled();
    expect(configureCopilotCli).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('falls back to the stored password when no new password was typed', () => {
    applyConfig(
      blankState({ baseUrl: 'https://og.example.com/', username: 'alice', storedPassword: 's3cret', hasStoredPassword: true }),
    );
    expect(storeCredentials).toHaveBeenCalledWith('https://og.example.com/', 'alice', 's3cret');
  });

  it('warns when no MCP clients are detected', () => {
    applyConfig(blankState());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No MCP client'));
  });

  it('surfaces credential-store warnings to the caller', () => {
    vi.mocked(storeCredentials).mockReturnValue({ source: 'encrypted-file', warning: 'stale copy' });
    const warnings = applyConfig(
      blankState({ baseUrl: 'https://og.example.com/', username: 'alice', password: 'pw' }),
    );
    expect(warnings).toContain('stale copy');
  });
});
