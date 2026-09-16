import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listProjectsMock = vi.fn().mockResolvedValue([{ name: 'p1' }, { name: 'p2' }]);

vi.mock('../../server/client/index.js', () => ({
  OpenGrokClient: vi.fn().mockImplementation(() => ({
    listProjects: listProjectsMock,
  })),
}));

vi.mock('../../server/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    OPENGROK_BASE_URL: 'https://og.example.com/',
    OPENGROK_USERNAME: 'admin',
    OPENGROK_VERIFY_SSL: true,
    OPENGROK_CONTEXT_BUDGET: 'standard',
    OPENGROK_CODE_MODE: true,
  }),
}));

vi.mock('../../server/cli/keychain.js', () => ({
  retrievePassword: vi.fn().mockReturnValue(null),
}));

vi.mock('../../server/cli/setup/detect.js', () => ({
  detectInstalledClients: vi.fn().mockReturnValue({
    claudeCode: true,
    codex: false,
    copilotCli: false,
  }),
}));

// Prevent status.ts from reading the real ~/.claude.json during tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
  };
});

describe('runStatus', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Ensure OPENGROK_BASE_URL is set so readEnvFromClaudeCode is skipped
    process.env['OPENGROK_BASE_URL'] = 'https://og.example.com/';
    // Clear response-cap/password-file overrides (other test files may leak them via process.env)
    delete process.env['OPENGROK_MAX_RESPONSE_BYTES'];
    delete process.env['OPENGROK_PASSWORD_FILE'];
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env['OPENGROK_BASE_URL'];
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('outputs server version line', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('OpenGrok MCP Server');
  });

  it('shows project count', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('2 indexed');
  });

  it('shows Claude Code CLI as configured', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('✓');
    expect(output).toContain('Claude Code CLI');
  });

  it('handles unreachable OpenGrok server gracefully', async () => {
    listProjectsMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { runStatus } = await import('../../server/cli/status.js');
    await expect(runStatus()).resolves.not.toThrow();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('unreachable');
  });

  it('shows new Code Mode settings with defaults when unconfigured', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Password file:');
    expect(output).toContain('Response cap:');
    expect(output).toContain('budget default');
    expect(output).toContain('Strict SSRF:');
    expect(output).toContain('disabled');
    expect(output).toContain('JWT issuer:');
    expect(output).toContain('Grammar dir:');
    expect(output).toContain('(bundled)');
  });

  it('shows effective response cap when OPENGROK_MAX_RESPONSE_BYTES is set', async () => {
    process.env['OPENGROK_MAX_RESPONSE_BYTES'] = '8192';
    try {
      const { runStatus } = await import('../../server/cli/status.js');
      await runStatus();
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('8192 bytes');
    } finally {
      delete process.env['OPENGROK_MAX_RESPONSE_BYTES'];
    }
  });

  it('shows password file path when OPENGROK_PASSWORD_FILE is set', async () => {
    process.env['OPENGROK_PASSWORD_FILE'] = '/run/secrets/pw';
    try {
      const { runStatus } = await import('../../server/cli/status.js');
      await runStatus();
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('/run/secrets/pw');
    } finally {
      delete process.env['OPENGROK_PASSWORD_FILE'];
    }
  });
});
