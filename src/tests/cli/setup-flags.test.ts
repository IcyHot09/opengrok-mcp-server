import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseSetArg,
  resolveSetKey,
  applyEnvPatch,
  listSetKeys,
  updateStoredSetting,
} from '../../server/cli/setup/configure.js';

describe('setup --set flag parsing', () => {
  it('splits key=value on the first equals sign', () => {
    expect(parseSetArg('contextBudget=generous')).toEqual({ key: 'contextBudget', value: 'generous' });
    expect(parseSetArg('proxy=http://h:8080/?a=b')).toEqual({ key: 'proxy', value: 'http://h:8080/?a=b' });
  });

  it('rejects malformed args with the valid key list', () => {
    expect(() => parseSetArg('contextBudget')).toThrow(/key=value/);
    expect(() => parseSetArg('=x')).toThrow(/key=value/);
  });

  it('accepts camelCase and OPENGROK_* aliases', () => {
    expect(resolveSetKey('contextBudget', 'generous')).toEqual({ env: 'OPENGROK_CONTEXT_BUDGET', value: 'generous' });
    expect(resolveSetKey('OPENGROK_CONTEXT_BUDGET', 'minimal')).toEqual({ env: 'OPENGROK_CONTEXT_BUDGET', value: 'minimal' });
  });

  it('validates booleans, enums, and integers', () => {
    expect(resolveSetKey('codeMode', 'false')).toEqual({ env: 'OPENGROK_CODE_MODE', value: 'false' });
    expect(() => resolveSetKey('codeMode', 'yes')).toThrow(/true or false/);
    expect(() => resolveSetKey('contextBudget', 'huge')).toThrow(/minimal, standard, generous/);
    expect(resolveSetKey('timeout', '60')).toEqual({ env: 'OPENGROK_TIMEOUT', value: '60' });
    expect(() => resolveSetKey('timeout', '0')).toThrow(/positive integer/);
    expect(() => resolveSetKey('timeout', 'abc')).toThrow(/positive integer/);
    expect(resolveSetKey('maxResponseBytes', '0')).toEqual({ env: 'OPENGROK_MAX_RESPONSE_BYTES', value: '0' });
  });

  it('rejects unknown keys and passwords', () => {
    expect(() => resolveSetKey('nope', '1')).toThrow(/Unknown setting/);
    expect(() => resolveSetKey('password', 's3cret')).toThrow(/shell history/);
    expect(() => resolveSetKey('OPENGROK_PASSWORD', 's3cret')).toThrow(/shell history/);
  });

  it('empty value deletes deletable keys, rejects required ones', () => {
    expect(resolveSetKey('defaultProject', '')).toEqual({ env: 'OPENGROK_DEFAULT_PROJECT', value: '' });
    expect(() => resolveSetKey('timeout', '')).toThrow(/requires a value/);
  });

  it('applyEnvPatch sets and deletes entries', () => {
    expect(applyEnvPatch({ A: '1' }, { env: 'B', value: '2' })).toEqual({ A: '1', B: '2' });
    expect(applyEnvPatch({ A: '1', B: '2' }, { env: 'B', value: '' })).toEqual({ A: '1' });
  });

  it('lists all settable keys', () => {
    expect(listSetKeys()).toContain('contextBudget');
    expect(listSetKeys()).toContain('timeout');
    expect(listSetKeys()).not.toContain('password');
  });
});

describe('updateStoredSetting file merge', () => {
  let home: string;
  let origAppData: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-set-'));
    origAppData = process.env['APPDATA'];
    process.env['APPDATA'] = home;
  });

  afterEach(() => {
    if (origAppData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = origAppData;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeClaude(env: Record<string, string>): void {
    const dir = home;
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ projects: { proj: { mcpServers: { 'opengrok-mcp': { env } } } } }),
      'utf8',
    );
  }

  it('patches an existing Claude entry and reports the client', () => {
    writeClaude({ OPENGROK_BASE_URL: 'https://og.example.com/', OPENGROK_TIMEOUT: '30' });
    const updated = updateStoredSetting('timeout', '60', home);
    expect(updated).toContain('Claude Code');
    const data = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, { mcpServers: Record<string, { env: Record<string, string> }> }>;
    };
    expect(data.projects['proj'].mcpServers['opengrok-mcp'].env['OPENGROK_TIMEOUT']).toBe('60');
    expect(data.projects['proj'].mcpServers['opengrok-mcp'].env['OPENGROK_BASE_URL']).toBe('https://og.example.com/');
  });

  it('empty value removes the var', () => {
    writeClaude({ OPENGROK_BASE_URL: 'https://og.example.com/', OPENGROK_DEFAULT_PROJECT: 'old' });
    const updated = updateStoredSetting('defaultProject', '', home);
    expect(updated).toContain('Claude Code');
    const data = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, { mcpServers: Record<string, { env: Record<string, string> }> }>;
    };
    expect(data.projects['proj'].mcpServers['opengrok-mcp'].env).not.toHaveProperty('OPENGROK_DEFAULT_PROJECT');
  });

  it('returns empty when no client is configured', () => {
    expect(updateStoredSetting('timeout', '60', home)).toEqual([]);
  });
});
