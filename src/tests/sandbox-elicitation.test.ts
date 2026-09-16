/**
 * Unit tests for createSandboxAPI opts object refactoring.
 * Elicit/sample/suggestions tests added in Tasks 2–5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSandboxAPI } from '../server/sandbox/index.js';
import type { OpenGrokClient } from '../server/client/index.js';
import type { MemoryBank } from '../server/memory/memory-bank.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../server/protocol/elicitation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/protocol/elicitation.js')>();
  return { ...original, elicitOrFallback: vi.fn() };
});

vi.mock('../server/protocol/sampling.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/protocol/sampling.js')>();
  return { ...original, sampleOrNull: vi.fn() };
});

import { elicitOrFallback } from '../server/protocol/elicitation.js';
import { sampleOrNull } from '../server/protocol/sampling.js';

function makeMinimalClient(): OpenGrokClient {
  return {
    search: vi.fn().mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 0,
      timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    }),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    getFileDiff: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    suggest: vi.fn().mockResolvedValue({ suggestions: [], time: 0, partialResult: false }),
    close: vi.fn(),
  } as unknown as OpenGrokClient;
}

function makeMinimalMemoryBank(): MemoryBank {
  return {
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn(),
    getStatusLine: vi.fn().mockResolvedValue(''),
    getFileReference: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryBank;
}

// ---------------------------------------------------------------------------
// Task 1: opts object refactoring — existing methods still work
// ---------------------------------------------------------------------------

describe('createSandboxAPI — opts object signature', () => {
  it('accepts opts object and getCompileInfoFn still works', async () => {
    const getCompileInfoFn = vi.fn().mockResolvedValue({ file: 'foo.cpp', compiler: 'g++', includes: [], defines: [], extraFlags: [], standard: 'c++17' });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      getCompileInfoFn,
    });
    await api.getCompileInfo('foo.cpp');
    expect(getCompileInfoFn).toHaveBeenCalledWith('foo.cpp');
  });

  it('accepts empty opts object without throwing', () => {
    expect(() =>
      createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {})
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 2: elicit()
// ---------------------------------------------------------------------------

describe('createSandboxAPI — elicit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { action: "cancel" } when elicitEnabled is false', async () => {
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: false,
    });
    const result = await api.elicit('Pick one', {
      type: 'object',
      properties: { choice: { type: 'string', enum: ['a', 'b'] } },
      required: ['choice'],
    });
    expect(result).toEqual({ action: 'cancel' });
    expect(elicitOrFallback).not.toHaveBeenCalled();
  });

  it('returns { action: "cancel" } when server is absent (elicitEnabled true, no server)', async () => {
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
    });
    const result = await api.elicit('Pick one', {
      type: 'object',
      properties: { choice: { type: 'string' } },
    });
    expect(result).toEqual({ action: 'cancel' });
    expect(elicitOrFallback).not.toHaveBeenCalled();
  });

  it('calls elicitOrFallback and returns accept result', async () => {
    const mockServer = {} as McpServer;
    vi.mocked(elicitOrFallback).mockResolvedValueOnce({
      action: 'accept',
      content: { path: 'src/auth/AuthService.ts' },
    });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
      mcpServer: mockServer,
    });
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' as const, enum: ['src/auth/AuthService.ts', 'lib/AuthService.ts'] } },
      required: ['path'],
    };
    const result = await api.elicit('Which file?', schema);
    expect(elicitOrFallback).toHaveBeenCalledWith(mockServer, 'Which file?', schema);
    expect(result).toEqual({ action: 'accept', content: { path: 'src/auth/AuthService.ts' } });
  });

  it('calls elicitOrFallback and returns cancel result', async () => {
    const mockServer = {} as McpServer;
    vi.mocked(elicitOrFallback).mockResolvedValueOnce({ action: 'cancel' });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
      mcpServer: mockServer,
    });
    const result = await api.elicit('Pick project', {
      type: 'object',
      properties: { project: { type: 'string', enum: ['proj-a', 'proj-b'] } },
    });
    expect(result).toEqual({ action: 'cancel' });
  });

  it('calls elicitOrFallback and returns decline result', async () => {
    const mockServer = {} as McpServer;
    vi.mocked(elicitOrFallback).mockResolvedValueOnce({ action: 'decline' });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
      mcpServer: mockServer,
    });
    const result = await api.elicit('Confirm?', { type: 'object', properties: {} });
    expect(result).toEqual({ action: 'decline' });
  });
});

// ---------------------------------------------------------------------------
// Task 3: sample()
// ---------------------------------------------------------------------------

describe('createSandboxAPI — sample()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when mcpServer is absent', async () => {
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {});
    const result = await api.sample('suggest search terms for foo');
    expect(result).toBeNull();
    expect(sampleOrNull).not.toHaveBeenCalled();
  });

  it('calls sampleOrNull with correct params and returns generated text', async () => {
    const mockMcpServer = {} as McpServer;
    vi.mocked(sampleOrNull).mockResolvedValueOnce('handleCrash, crash_handler, onCrash');
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      mcpServer: mockMcpServer,
      samplingEnabled: true,
    });
    const result = await api.sample('suggest alternatives for handleCrash');
    expect(sampleOrNull).toHaveBeenCalledWith(
      mockMcpServer,
      [{ role: 'user', content: { type: 'text', text: 'suggest alternatives for handleCrash' } }],
      expect.objectContaining({ maxTokens: 256, systemPrompt: '' })
    );
    expect(result).toBe('handleCrash, crash_handler, onCrash');
  });

  it('forwards maxTokens and systemPrompt opts', async () => {
    const mockMcpServer = {} as McpServer;
    vi.mocked(sampleOrNull).mockResolvedValueOnce('foo');
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      mcpServer: mockMcpServer,
      samplingEnabled: true,
    });
    await api.sample('prompt', { maxTokens: 100, systemPrompt: 'Be terse.' });
    expect(sampleOrNull).toHaveBeenCalledWith(
      mockMcpServer,
      expect.any(Array),
      expect.objectContaining({ maxTokens: 100, systemPrompt: 'Be terse.' })
    );
  });

  it('returns null when sampleOrNull returns null', async () => {
    const mockMcpServer = {} as McpServer;
    vi.mocked(sampleOrNull).mockResolvedValueOnce(null);
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      mcpServer: mockMcpServer,
      samplingEnabled: true,
    });
    const result = await api.sample('suggest something');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 4: zero-result _suggestions injection in search()
// ---------------------------------------------------------------------------

describe('createSandboxAPI — search() zero-result _suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects _suggestions when totalCount === 0 and sampling returns text', async () => {
    const mockClient = makeMinimalClient();
    const mockMcpServer = {} as McpServer;
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      query: 'handelCrash', searchType: 'defs', totalCount: 0,
      timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    vi.mocked(sampleOrNull).mockResolvedValueOnce('handleCrash, crash_handler, onCrash');

    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { mcpServer: mockMcpServer, samplingEnabled: true });
    const result = await api.search('handelCrash', { searchType: 'defs' }) as Record<string, unknown>;

    expect(result.totalCount).toBe(0);
    expect(result._suggestions).toEqual(['handleCrash', 'crash_handler', 'onCrash']);
  });

  it('does not inject _suggestions when totalCount > 0', async () => {
    const mockClient = makeMinimalClient();
    const mockMcpServer = {} as McpServer;
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      query: 'foo', searchType: 'full', totalCount: 3,
      timeMs: 1, results: [{ project: 'p', path: 'a.ts', matches: [] }], startIndex: 0, endIndex: 3,
    });

    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { mcpServer: mockMcpServer });
    const result = await api.search('foo') as Record<string, unknown>;

    expect(result.totalCount).toBe(3);
    expect(result._suggestions).toBeUndefined();
    expect(sampleOrNull).not.toHaveBeenCalled();
  });

  it('does not inject _suggestions when mcpServer is absent', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      query: 'foo', searchType: 'full', totalCount: 0,
      timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });

    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), {});
    const result = await api.search('foo') as Record<string, unknown>;

    expect(result._suggestions).toBeUndefined();
    expect(sampleOrNull).not.toHaveBeenCalled();
  });

  it('does not inject _suggestions when sampleOrNull returns null', async () => {
    const mockClient = makeMinimalClient();
    const mockMcpServer = {} as McpServer;
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      query: 'foo', searchType: 'full', totalCount: 0,
      timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    vi.mocked(sampleOrNull).mockResolvedValueOnce(null);

    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { mcpServer: mockMcpServer, samplingEnabled: true });
    const result = await api.search('foo') as Record<string, unknown>;

    expect(result._suggestions).toBeUndefined();
  });

  it('trims whitespace and limits to 3 suggestions', async () => {
    const mockClient = makeMinimalClient();
    const mockMcpServer = {} as McpServer;
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      query: 'x', searchType: 'full', totalCount: 0,
      timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    vi.mocked(sampleOrNull).mockResolvedValueOnce(' foo , bar , baz , qux ');

    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { mcpServer: mockMcpServer, samplingEnabled: true });
    const result = await api.search('x') as Record<string, unknown>;

    expect(result._suggestions).toEqual(['foo', 'bar', 'baz']); // capped at 3
  });
});

// ---------------------------------------------------------------------------
// Task 5: API_SPEC has elicit and sample entries
// ---------------------------------------------------------------------------

import { API_SPEC, METHOD_SIGNATURES } from '../server/sandbox/index.js';

describe('API_SPEC', () => {
  it('has elicit method signature', () => {
    expect(API_SPEC).toContain('elicit(message: string, schema: ElicitSchema)');
    expect(API_SPEC).toContain("'accept'");
    expect(METHOD_SIGNATURES.elicit).toContain('elicit(');
  });

  it('has sample method signature', () => {
    expect(API_SPEC).toContain('sample(prompt: string');
    expect(API_SPEC).toContain('string|null');
    expect(METHOD_SIGNATURES.sample).toContain('sample(');
  });

  it('documents all 19 sandbox methods', () => {
    for (const name of ['search', 'batchSearch', 'getFileContent', 'getSymbolContext',
      'getFileSymbols', 'getFileHistory', 'getFileAnnotate', 'browseDir',
      'findFile', 'getFileOverview', 'traceCallChain', 'searchSuggest',
      'getCompileInfo', 'indexHealth', 'getFileDiff', 'readMemory',
      'writeMemory', 'elicit', 'sample']) {
      expect(METHOD_SIGNATURES[name], `missing signature ${name}`).toContain(`${name}(`);
    }
  });

  it('documents cursor and expandFunction opts used by error hints', () => {
    expect(API_SPEC).toContain('cursor?: string');
    expect(API_SPEC).toContain('expandFunction?: boolean');
  });
});

// ---------------------------------------------------------------------------
// Task 6: defaultProject — OPENGROK_DEFAULT_PROJECT honored in Code Mode
// ---------------------------------------------------------------------------

describe('createSandboxAPI — defaultProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('search() injects defaultProject when projects not specified', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 1,
      timeMs: 1, results: [{ project: 'myproject', path: 'a.ts', matches: [] }], startIndex: 0, endIndex: 1,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { defaultProject: 'myproject' });
    await api.search('q');
    expect(mockClient.search).toHaveBeenCalledWith('q', 'full', ['myproject'], 5, 0, undefined, undefined, undefined, undefined);
  });

  it('search() does not override explicit projects array', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { defaultProject: 'myproject' });
    await api.search('q', { projects: ['other'] });
    expect(mockClient.search).toHaveBeenCalledWith('q', 'full', ['other'], 5, 0, undefined, undefined, undefined, undefined);
  });

  it('search() does not override explicit empty array (search all)', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { defaultProject: 'myproject' });
    await api.search('q', { projects: [] });
    expect(mockClient.search).toHaveBeenCalledWith('q', 'full', [], 5, 0, undefined, undefined, undefined, undefined);
  });

  it('batchSearch() injects defaultProject when projects not specified', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { defaultProject: 'myproject' });
    await api.batchSearch([{ query: 'q' }]);
    expect(mockClient.search).toHaveBeenCalledWith('q', 'full', ['myproject'], 5, 0, undefined, undefined, undefined, undefined);
  });

  it('getSymbolContext() injects defaultProject when projects not specified', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'sym', searchType: 'defs', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { defaultProject: 'myproject' });
    await api.getSymbolContext('sym');
    expect(mockClient.search).toHaveBeenCalledWith('sym', 'defs', ['myproject'], 5, 0, undefined);
  });

  it('findFile() injects defaultProject when projects not specified', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '*.ts', searchType: 'path', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), { defaultProject: 'myproject' });
    await api.findFile('*.ts');
    expect(mockClient.search).toHaveBeenCalledWith('*.ts', 'path', ['myproject'], 10, 0);
  });

  it('no defaultProject configured → passes undefined (searches all)', async () => {
    const mockClient = makeMinimalClient();
    vi.mocked(mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(mockClient, makeMinimalMemoryBank(), {});
    await api.search('q');
    expect(mockClient.search).toHaveBeenCalledWith('q', 'full', undefined, 5, 0, undefined, undefined, undefined, undefined);
  });
});
