import { describe, it, expect, vi, afterEach } from 'vitest';

describe('checkForUpdate (via status module)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runStatus completes even when fetch throws (network failure)', async () => {
    // Mock fetch to simulate network failure
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    vi.mock('../../server/client/index.js', () => ({
      OpenGrokClient: vi.fn().mockImplementation(() => ({
        listProjects: vi.fn().mockResolvedValue([]),
      })),
    }));
    vi.mock('../../server/config.js', () => ({
      loadConfig: vi.fn().mockReturnValue({
        OPENGROK_BASE_URL: 'https://og.example.com/',
        OPENGROK_USERNAME: '',
        OPENGROK_VERIFY_SSL: true,
        OPENGROK_CONTEXT_BUDGET: 'standard',
        OPENGROK_CODE_MODE: true,
      }),
    }));
    vi.mock('../../server/cli/keychain.js', () => ({
      retrievePassword: vi.fn().mockReturnValue(null),
    }));
    vi.mock('../../server/cli/setup/detect.js', () => ({
      detectInstalledClients: vi.fn().mockReturnValue({ claudeCode: false, codex: false, copilotCli: false }),
    }));
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });

    process.env['OPENGROK_BASE_URL'] = 'https://og.example.com/';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runStatus } = await import('../../server/cli/status.js');
    await expect(runStatus()).resolves.not.toThrow();
    delete process.env['OPENGROK_BASE_URL'];
    vi.unstubAllGlobals();
  });
});
