import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const testConnectionMock = vi.fn().mockResolvedValue(true);

vi.mock('../../server/client/index.js', () => ({
  OpenGrokClient: vi.fn().mockImplementation(() => ({
    listProjects: vi.fn().mockResolvedValue([]),
    testConnection: testConnectionMock,
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
    claudeCode: false,
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

describe('runSetupTest', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env['OPENGROK_BASE_URL'] = 'https://og.example.com/';
    delete process.env['OPENGROK_MAX_RESPONSE_BYTES'];
    delete process.env['OPENGROK_PASSWORD_FILE'];
    process.exitCode = undefined;
    testConnectionMock.mockResolvedValue(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env['OPENGROK_BASE_URL'];
    process.exitCode = undefined;
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('prints OK and leaves exit code unset on success', async () => {
    const { runSetupTest } = await import('../../server/cli/status.js');
    await runSetupTest();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Connection OK'));
    expect(process.exitCode).toBeUndefined();
  });

  it('prints failure and sets exit code 1 when unreachable', async () => {
    testConnectionMock.mockResolvedValue(false);
    const { runSetupTest } = await import('../../server/cli/status.js');
    await runSetupTest();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Connection failed'));
    expect(process.exitCode).toBe(1);
  });
});
