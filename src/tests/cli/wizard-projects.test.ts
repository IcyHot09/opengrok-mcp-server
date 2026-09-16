import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  isCancel: vi.fn(() => false),
  log: { success: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const clientMocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('@clack/prompts', () => clackMocks);

vi.mock('../../server/cli/keychain.js', () => ({
  storeCredentials: vi.fn(() => ({ source: 'keychain' })),
  retrievePassword: vi.fn(() => null),
}));

vi.mock('../../server/client/index.js', () => ({
  OpenGrokClient: vi.fn().mockImplementation(() => ({
    listProjects: clientMocks.listProjects,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../server/config.js', () => ({
  loadConfig: vi.fn((overrides?: Record<string, string>) => ({
    OPENGROK_BASE_URL: overrides?.['OPENGROK_BASE_URL'] ?? 'https://og.example.com/source/',
    OPENGROK_USERNAME: overrides?.['OPENGROK_USERNAME'] ?? '',
    OPENGROK_PASSWORD: overrides?.['OPENGROK_PASSWORD'] ?? '',
    OPENGROK_VERIFY_SSL: true,
  })),
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

function setupClackDefaults(opts: { projectSelectValue?: string; projectTextValue?: string } = {}): void {
  clackMocks.text.mockImplementation(async (o: { message?: string }) => {
    const msg = o.message ?? '';
    if (msg.includes('OpenGrok server URL')) return 'https://og.example.com/source/';
    if (msg.includes('Username')) return 'admin';
    if (msg.includes('Default project')) return opts.projectTextValue ?? 'myproject';
    return '';
  });
  clackMocks.password.mockResolvedValue('secret');
  clackMocks.confirm.mockResolvedValue(true);
  clackMocks.select.mockImplementation(async (o: { message?: string }) => {
    const msg = o.message ?? '';
    if (msg.includes('Default project')) return opts.projectSelectValue ?? 'p1';
    return 'standard';
  });
  clackMocks.isCancel.mockReturnValue(false);
}

describe('fetchAvailableProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupClackDefaults();
  });

  it('returns sorted unique names on success', async () => {
    clientMocks.listProjects.mockResolvedValue([{ name: 'beta' }, { name: 'alpha' }, { name: 'beta' }]);
    const { fetchAvailableProjects } = await import('../../server/cli/setup/wizard.js');
    await expect(fetchAvailableProjects('https://og.example.com/source/', 'admin', 'pw', true)).resolves.toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('returns empty when listProjects rejects', async () => {
    clientMocks.listProjects.mockRejectedValue(new Error('ECONNREFUSED'));
    const { fetchAvailableProjects } = await import('../../server/cli/setup/wizard.js');
    await expect(fetchAvailableProjects('https://og.example.com/source/', 'admin', 'pw', true)).resolves.toEqual([]);
  });
});

describe('runSetup project picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers a select when projects are available', async () => {
    clientMocks.listProjects.mockResolvedValue([{ name: 'p1' }, { name: 'p2' }]);
    setupClackDefaults({ projectSelectValue: 'p2' });
    const { runSetup } = await import('../../server/cli/setup/wizard.js');
    await runSetup();
    const projectSelectCalls = clackMocks.select.mock.calls.filter((c) =>
      String((c[0] as { message?: string }).message ?? '').includes('Default project'),
    );
    expect(projectSelectCalls.length).toBe(1);
    const opts = (projectSelectCalls[0][0] as { options: Array<{ value: string }> }).options;
    expect(opts.map((o) => o.value)).toContain('p1');
    expect(opts.map((o) => o.value)).toContain('p2');
  });

  it('falls back to free-text when fetch fails', async () => {
    clientMocks.listProjects.mockRejectedValue(new Error('down'));
    setupClackDefaults({ projectTextValue: 'typed-project' });
    const { runSetup } = await import('../../server/cli/setup/wizard.js');
    await runSetup();
    const projectSelectCalls = clackMocks.select.mock.calls.filter((c) =>
      String((c[0] as { message?: string }).message ?? '').includes('Default project'),
    );
    expect(projectSelectCalls.length).toBe(0);
    const projectTextCalls = clackMocks.text.mock.calls.filter((c) =>
      String((c[0] as { message?: string }).message ?? '').includes('Default project'),
    );
    expect(projectTextCalls.length).toBe(1);
  });
});
