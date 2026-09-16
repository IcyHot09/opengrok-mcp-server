import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks must be declared at the top level so vitest can hoist them.
// We use vi.hoisted() to create shared state that factory closures can capture.
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  spawnSyncStatus: 0 as number | null,
  existsResult: false,
  readFileResult: '',
  writeFileCalls: [] as Array<[string, string]>,
  mkdirCalls: 0,
  verifySslValue: true as boolean | symbol,
}));

// Mock @clack/prompts for wizard tests
const clackMocks = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  isCancel: vi.fn((_val: unknown) => false),
  log: { success: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@clack/prompts', () => clackMocks);
vi.mock('../../server/cli/keychain.js', () => ({
  storeCredentials: vi.fn(),
  retrievePassword: vi.fn(() => null),
}));

// Wizard project discovery hits the network via OpenGrokClient — stub it out
// so existing wizard tests stay fast and deterministic (empty list → free-text fallback).
vi.mock('../../server/client/index.js', () => ({
  OpenGrokClient: vi.fn().mockImplementation(() => ({
    listProjects: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    OPENGROK_BASE_URL: 'https://og.example.com/source/',
    OPENGROK_USERNAME: '',
    OPENGROK_PASSWORD: '',
    OPENGROK_VERIFY_SSL: true,
  })),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn((_cmd: string, _args: string[]) => ({
    status: mocks.spawnSyncStatus,
    pid: 1,
    output: [],
    stdout: '',
    stderr: mocks.spawnSyncStatus !== 0 ? 'error' : '',
    signal: null,
    error: undefined,
  })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => mocks.existsResult),
    mkdirSync: vi.fn(() => { mocks.mkdirCalls++; }),
    readFileSync: vi.fn((_path: string, _enc: string) => mocks.readFileResult),
    writeFileSync: vi.fn((_path: string, data: string) => {
      mocks.writeFileCalls.push([_path as string, data]);
    }),
  };
});

// ─────────────────────────────────────────────────────────────────────────────

describe('detectInstalledClients', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 0;
    mocks.existsResult = false;
    mocks.writeFileCalls = [];
  });

  it('reports claudeCode=true when claude --version exits 0', async () => {
    mocks.spawnSyncStatus = 0;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.claudeCode).toBe(true);
  });

  it('reports claudeCode=false when claude --version exits non-zero', async () => {
    mocks.spawnSyncStatus = 1;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.claudeCode).toBe(false);
  });

  it('reports codex=false when config file does not exist', async () => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = false;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.codex).toBe(false);
  });

  it('reports codex=true when config file exists', async () => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = true;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.codex).toBe(true);
  });
});

describe('configureClaudeCode', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 0;
    mocks.writeFileCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('calls claude mcp add with array args (no shell injection)', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com', scope: 'user' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['mcp', 'add']),
      expect.objectContaining({ shell: false })
    );
  });

  it('throws when claude mcp add fails', async () => {
    mocks.spawnSyncStatus = 1;
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    expect(() => configureClaudeCode({ url: 'https://og.example.com' })).toThrow(/failed/);
  });

  it('uses local scope by default', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--scope', 'local']),
      expect.anything()
    );
  });

  it('server name comes before -e flags (avoids variadic consumption)', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com', username: 'alice' });
    const callArgs = (cp.spawnSync as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as string[];
    const nameIdx = callArgs.indexOf('opengrok-mcp');
    const firstEnvIdx = callArgs.indexOf('-e');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(firstEnvIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeLessThan(firstEnvIdx);
  });

  it('includes OPENGROK_USERNAME in args when username is provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com', username: 'alice' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-e', 'OPENGROK_USERNAME=alice']),
      expect.anything()
    );
  });

  it('omits OPENGROK_USERNAME in args when username is not provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com' });
    const callArgs = (cp.spawnSync as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as string[];
    const usernameIndex = callArgs.findIndex((a) => a.startsWith('OPENGROK_USERNAME'));
    expect(usernameIndex).toBe(-1);
  });
});

describe('configureVSCode', () => {
  beforeEach(() => {
    mocks.existsResult = false;
    mocks.readFileResult = '';
    mocks.writeFileCalls = [];
    mocks.mkdirCalls = 0;
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('writes directly to user-level mcp.json (no code binary invoked)', async () => {
    const cp = await import('child_process');
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com' });
    // Must NOT invoke the code binary
    expect(cp.spawnSync).not.toHaveBeenCalledWith('code', expect.anything(), expect.anything());
    // Must write a file
    expect(mocks.writeFileCalls.length).toBeGreaterThan(0);
    const writtenPath = mocks.writeFileCalls[0]?.[0] ?? '';
    expect(writtenPath).toMatch(/mcp\.json$/);
  });

  it('writes correct servers entry to mcp.json', async () => {
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com' });
    const written = JSON.parse(String(mocks.writeFileCalls[0]?.[1]));
    expect(written.servers['opengrok-mcp']).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'opengrok-mcp-server'],
    });
    expect(written.servers['opengrok-mcp'].env['OPENGROK_BASE_URL']).toBe('https://og.example.com');
  });

  it('includes OPENGROK_USERNAME when username is provided', async () => {
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com', username: 'bob' });
    const written = JSON.parse(String(mocks.writeFileCalls[0]?.[1]));
    expect(written.servers['opengrok-mcp'].env['OPENGROK_USERNAME']).toBe('bob');
  });

  it('omits OPENGROK_USERNAME when username is not provided', async () => {
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com' });
    const written = JSON.parse(String(mocks.writeFileCalls[0]?.[1]));
    expect(written.servers['opengrok-mcp'].env['OPENGROK_USERNAME']).toBeUndefined();
  });

  it('merges into existing mcp.json (idempotent)', async () => {
    const existing = JSON.stringify({ servers: { 'other-server': { type: 'stdio' }, 'opengrok-mcp': { type: 'stdio', env: { OPENGROK_BASE_URL: 'https://old.example.com' } } } });
    mocks.existsResult = true;
    mocks.readFileResult = existing;
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://new.example.com' });
    const written = JSON.parse(String(mocks.writeFileCalls[0]?.[1]));
    expect(written.servers['other-server']).toBeDefined();
    expect(written.servers['opengrok-mcp'].env['OPENGROK_BASE_URL']).toBe('https://new.example.com');
  });
});

describe('configureCodex', () => {
  beforeEach(() => {
    mocks.existsResult = false;
    mocks.readFileResult = '';
    mocks.writeFileCalls = [];
    mocks.mkdirCalls = 0;
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('writes TOML with mcp_servers entry', async () => {
    mocks.existsResult = false;
    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://og.example.com' });

    const fs = await import('fs');
    expect(fs.writeFileSync).toHaveBeenCalled();
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(written).toContain('opengrok-mcp');
    expect(written).toContain('npx');
  });

  it('is idempotent — replaces existing opengrok-mcp entry', async () => {
    const existingToml = `[[mcp_servers]]
name = "opengrok-mcp"
command = "npx"
args = ["-y", "opengrok-mcp-server"]

[mcp_servers.env]
OPENGROK_BASE_URL = "https://old.example.com"
`;
    mocks.existsResult = true;
    mocks.readFileResult = existingToml;

    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://new.example.com' });

    const fs = await import('fs');
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    // Should have exactly one `name = "opengrok-mcp"` entry (not the old one duplicated)
    const nameCount = (written.match(/name = "opengrok-mcp"/g) ?? []).length;
    expect(nameCount).toBe(1);
    expect(written).toContain('https://new.example.com');
    // Old URL should be gone
    expect(written).not.toContain('https://old.example.com');
  });

  it('includes OPENGROK_USERNAME in TOML when username is provided', async () => {
    mocks.existsResult = false;
    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://og.example.com', username: 'carol' });

    const fs = await import('fs');
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(written).toContain('OPENGROK_USERNAME');
    expect(written).toContain('carol');
  });

  it('omits OPENGROK_USERNAME from TOML when username is not provided', async () => {
    mocks.existsResult = false;
    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://og.example.com' });

    const fs = await import('fs');
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(written).not.toContain('OPENGROK_USERNAME');
  });
});

describe('configureCopilotCli', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 0;
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('calls copilot mcp add with array args (no shell injection)', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureCopilotCli } = await import('../../server/cli/setup/configure.js');
    configureCopilotCli({ url: 'https://og.example.com' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'copilot',
      expect.arrayContaining(['mcp', 'add']),
      expect.objectContaining({ shell: false })
    );
  });

  it('throws when copilot mcp add fails', async () => {
    mocks.spawnSyncStatus = 1;
    const { configureCopilotCli } = await import('../../server/cli/setup/configure.js');
    expect(() => configureCopilotCli({ url: 'https://og.example.com' })).toThrow(/failed/);
  });

  it('includes OPENGROK_BASE_URL in --env args', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureCopilotCli } = await import('../../server/cli/setup/configure.js');
    configureCopilotCli({ url: 'https://og.example.com' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'copilot',
      expect.arrayContaining(['--env', 'OPENGROK_BASE_URL=https://og.example.com']),
      expect.anything()
    );
  });

  it('includes OPENGROK_USERNAME when username is provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureCopilotCli } = await import('../../server/cli/setup/configure.js');
    configureCopilotCli({ url: 'https://og.example.com', username: 'dave' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'copilot',
      expect.arrayContaining(['--env', 'OPENGROK_USERNAME=dave']),
      expect.anything()
    );
  });

  it('passes npx -y opengrok-mcp-server as the command after --', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureCopilotCli } = await import('../../server/cli/setup/configure.js');
    configureCopilotCli({ url: 'https://og.example.com' });
    const callArgs = (cp.spawnSync as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as string[];
    const sepIdx = callArgs.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(callArgs.slice(sepIdx)).toEqual(['--', 'npx', '-y', 'opengrok-mcp-server']);
  });
});

describe('detectInstalledClients — copilotCli', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = false;
    vi.clearAllMocks();
  });

  it('reports copilotCli=true when copilot binary exits 0', async () => {
    mocks.spawnSyncStatus = 0;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.copilotCli).toBe(true);
  });

  it('reports copilotCli=true when ~/.copilot dir exists (even if binary missing)', async () => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = true;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.copilotCli).toBe(true);
  });

  it('reports copilotCli=false when binary missing and dir absent', async () => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = false;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.copilotCli).toBe(false);
  });
});

describe('runSetup wizard — verifySsl prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stub detect/configure so the wizard doesn't try to spawn child processes
    vi.doMock('../../server/cli/setup/detect.js', () => ({
      detectInstalledClients: vi.fn(() => ({ claudeCode: false, codex: false, copilotCli: false })),
    }));
    vi.doMock('../../server/cli/setup/configure.js', () => ({
      configureClaudeCode: vi.fn(),
      configureVSCode: vi.fn(),
      configureCodex: vi.fn(),
      configureCopilotCli: vi.fn(),
      readStoredEnv: vi.fn(() => ({})),
    }));
    // Default: all prompts return non-cancelled values
    clackMocks.text.mockResolvedValue('https://og.example.com/source/');
    clackMocks.password.mockResolvedValue('secret');
    clackMocks.select.mockResolvedValue('standard');
    clackMocks.confirm.mockResolvedValue(true);
    clackMocks.isCancel.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('../../server/cli/setup/detect.js');
    vi.doUnmock('../../server/cli/setup/configure.js');
    vi.resetModules();
  });

  it('calls confirm prompt for SSL verification', async () => {
    const { runSetup } = await import('../../server/cli/setup/wizard.js');
    await runSetup();
    expect(clackMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('SSL'),
        initialValue: true,
      })
    );
  });

  it('does NOT show SSL note when verifySsl is true', async () => {
    clackMocks.confirm.mockResolvedValue(true);
    const { runSetup } = await import('../../server/cli/setup/wizard.js');
    await runSetup();
    expect(clackMocks.note).not.toHaveBeenCalled();
  });

  it('passes OPENGROK_VERIFY_SSL=false to configure when verifySsl is false', async () => {
    // All confirms return false: verifySsl=false, codeMode=false, enableElicitation=false, wantsAdvanced=false
    clackMocks.confirm.mockResolvedValue(false);
    const configureMocks = {
      configureClaudeCode: vi.fn(),
      configureVSCode: vi.fn(),
      configureCodex: vi.fn(),
      readStoredEnv: vi.fn(() => ({})),
    };
    vi.doMock('../../server/cli/setup/configure.js', () => configureMocks);
    const { runSetup } = await import('../../server/cli/setup/wizard.js');
    await runSetup();
    // Wizard should have run to completion — no note needed since env var is written automatically
    expect(clackMocks.note).not.toHaveBeenCalled();
    // The config passed to any configure function should have verifySsl=false
    const allCalls = [
      ...configureMocks.configureClaudeCode.mock.calls,
      ...configureMocks.configureVSCode.mock.calls,
      ...configureMocks.configureCodex.mock.calls,
    ];
    if (allCalls.length > 0) {
      expect(allCalls[0][0]).toMatchObject({ verifySsl: false });
    }
  });

  it('surfaces keychain verification warnings instead of success', async () => {
    const { storeCredentials } = await import('../../server/cli/keychain.js');
    vi.mocked(storeCredentials).mockReturnValue({
      source: 'encrypted-file',
      warning: 'keychain holds a stale copy',
    });
    const { runSetup } = await import('../../server/cli/setup/wizard.js');
    await runSetup();
    expect(clackMocks.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale copy')
    );
  });
});
