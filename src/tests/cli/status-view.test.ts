import { describe, it, expect, vi } from 'vitest';

vi.mock('../../server/cli/colors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/cli/colors.js')>();
  return {
    ...actual,
    isColorSupported: false,
    dim: (s: string) => s,
    bold: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    cyan: (s: string) => s,
    yellow: (s: string) => s,
  };
});

import { renderStatus, type StatusData } from '../../server/cli/status-view.js';

function makeData(overrides: Partial<StatusData> = {}): StatusData {
  return {
    version: '9.6.0',
    opengrok: {
      url: 'https://og.example.com/source/',
      username: 'admin',
      authSource: 'keychain',
      connected: true,
      projects: 12,
      latencyMs: 42,
      verifySsl: true,
    },
    config: {
      source: 'stored config',
      mode: 'Code Mode (5 tools)',
      budget: 'standard',
      project: 'myproject',
      passwordFile: undefined,
      responseCap: 'budget default',
      strictSsrf: false,
      jwtIssuer: undefined,
      grammarDir: undefined,
    },
    clients: { claudeCode: true, copilotCli: false, codex: true },
    update: { available: false },
    ...overrides,
  };
}

describe('renderStatus', () => {
  it('renders header and all generic sections', () => {
    const out = renderStatus(makeData());
    expect(out).toContain('OpenGrok MCP Server v9.6.0');
    expect(out).toContain('OpenGrok');
    expect(out).toContain('https://og.example.com/source/');
    expect(out).toContain('admin (keychain)');
    expect(out).toContain('verified');
    expect(out).toContain('12 indexed');
    expect(out).toContain('42 ms');
    expect(out).toContain('Configuration');
    expect(out).toContain('stored config');
    expect(out).toContain('Code Mode (5 tools)');
    expect(out).toContain('standard');
    expect(out).toContain('myproject');
    expect(out).toContain('Password file:');
    expect(out).toContain('Response cap:');
    expect(out).toContain('Strict SSRF:');
    expect(out).toContain('JWT issuer:');
    expect(out).toContain('Grammar dir:');
    expect(out).toContain('Clients');
    expect(out).toContain('Claude Code CLI');
    expect(out).toContain('GitHub Copilot CLI');
    expect(out).toContain('Codex CLI');
    expect(out).toContain('Up to date');
  });

  it('renders OpenGrok error with setup hint', () => {
    const out = renderStatus(
      makeData({
        opengrok: {
          url: 'https://og.example.com/source/',
          username: 'admin',
          authSource: 'keychain',
          connected: false,
          error: 'ECONNREFUSED',
          verifySsl: true,
        },
      }),
    );
    expect(out).toContain('unreachable');
    expect(out).toContain('ECONNREFUSED');
    expect(out).toContain('opengrok-mcp setup');
  });

  it('shows anonymous auth when no username', () => {
    const out = renderStatus(
      makeData({
        opengrok: {
          url: 'https://og.example.com/source/',
          username: '',
          authSource: 'anonymous',
          connected: true,
          projects: 1,
          latencyMs: 5,
          verifySsl: false,
        },
      }),
    );
    expect(out).toContain('(anonymous)');
    expect(out).toContain('disabled');
  });

  it('shows (all projects) when project is empty', () => {
    const out = renderStatus(
      makeData({ config: { source: '', mode: 'Standard Mode', budget: 'minimal', project: '' } }),
    );
    expect(out).toContain('(all projects)');
  });

  it('shows update available with npm command', () => {
    const out = renderStatus(makeData({ update: { available: true, latestVersion: '9.7.0' } }));
    expect(out).toContain('9.7.0 available');
    expect(out).toContain('npm update -g opengrok-mcp-server');
  });

  it('shows update check error gracefully', () => {
    const out = renderStatus(makeData({ update: { available: false, error: 'Network timeout' } }));
    expect(out).toContain('Could not check');
    expect(out).toContain('Network timeout');
  });

  it('hides update section when null', () => {
    const out = renderStatus(makeData({ update: null }));
    expect(out).not.toContain('Update');
  });
});
