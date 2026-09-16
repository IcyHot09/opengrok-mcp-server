import { describe, it, expect } from 'vitest';
import {
  resolveCliCommand,
  suggestCliCommand,
  getCliUsage,
  formatUnknownCommandMessage,
  COMMAND_ALIASES,
} from '../../server/cli/commands.js';

describe('resolveCliCommand', () => {
  it('defaults to server when no subcommand is provided', () => {
    expect(resolveCliCommand(undefined)).toBe('server');
  });

  it('recognizes server aliases', () => {
    expect(resolveCliCommand('server')).toBe('server');
    expect(resolveCliCommand('--server')).toBe('server');
  });

  it('recognizes setup/status/export-audit/help/version and aliases', () => {
    expect(resolveCliCommand('setup')).toBe('setup');
    expect(resolveCliCommand('--setup')).toBe('setup');
    expect(resolveCliCommand('status')).toBe('status');
    expect(resolveCliCommand('--status')).toBe('status');
    expect(resolveCliCommand('export-audit')).toBe('export-audit');
    expect(resolveCliCommand('--export-audit')).toBe('export-audit');
    expect(resolveCliCommand('help')).toBe('help');
    expect(resolveCliCommand('--help')).toBe('help');
    expect(resolveCliCommand('-h')).toBe('help');
    expect(resolveCliCommand('version')).toBe('version');
  });

  it('has no update command', () => {
    expect(resolveCliCommand('update')).toBe('unknown');
    expect(resolveCliCommand('--update')).toBe('unknown');
    expect(COMMAND_ALIASES['update']).toBeUndefined();
    expect(COMMAND_ALIASES['--update']).toBeUndefined();
  });

  it('returns unknown for mistyped commands', () => {
    expect(resolveCliCommand('statuz')).toBe('unknown');
    expect(resolveCliCommand('setpu')).toBe('unknown');
    expect(resolveCliCommand('bogus')).toBe('unknown');
  });
});

describe('suggestCliCommand', () => {
  it('suggests the nearest command for typos', () => {
    expect(suggestCliCommand('statu')).toBe('status');
    expect(suggestCliCommand('setpu')).toBe('setup');
    expect(suggestCliCommand('statuz')).toBe('status');
  });

  it('prefix fast-path suggests on prefix match', () => {
    expect(suggestCliCommand('stat')).toBe('status');
    expect(suggestCliCommand('vers')).toBe('version');
  });

  it('returns null when no reasonable suggestion exists', () => {
    expect(suggestCliCommand('zzzzzz')).toBeNull();
    expect(suggestCliCommand('totally-different')).toBeNull();
  });

  it('never suggests update (removed command)', () => {
    expect(suggestCliCommand('updat')).not.toBe('update');
  });
});

describe('getCliUsage', () => {
  it('uses opengrok-mcp bin name by default', () => {
    const usage = getCliUsage();
    expect(usage).toContain('opengrok-mcp setup');
    expect(usage).toContain('opengrok-mcp status');
    expect(usage).toContain('opengrok-mcp export-audit');
    expect(usage).toContain('opengrok-mcp help');
    expect(usage).toContain('opengrok-mcp version');
  });

  it('has no update line', () => {
    const usage = getCliUsage();
    expect(usage).not.toContain('update');
  });

  it('respects custom bin name', () => {
    const usage = getCliUsage('my-bin');
    expect(usage).toContain('my-bin setup');
  });
});

describe('formatUnknownCommandMessage', () => {
  it('includes suggestion when available', () => {
    const msg = formatUnknownCommandMessage('statu');
    expect(msg).toContain('Unknown command "statu"');
    expect(msg).toContain('Did you mean "status"?');
    expect(msg).toContain('Usage:');
  });

  it('omits suggestion when far', () => {
    const msg = formatUnknownCommandMessage('zzzzzz');
    expect(msg).toContain('Unknown command "zzzzzz"');
    expect(msg).not.toContain('Did you mean');
    expect(msg).toContain('Usage:');
  });
});
