/**
 * Tests for Code Mode tools: opengrok_api, opengrok_execute, memory bank tools.
 * Uses InMemoryTransport + MCP Client to call tools through the proper MCP stack.
 * executeInSandbox is mocked to avoid needing the compiled worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { createServer } from '../server/server.js';
import { MemoryBank } from '../server/memory/memory-bank.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../server/config.js';
import { createSandboxAPI } from '../server/sandbox/index.js';

// ---------------------------------------------------------------------------
// Mock executeInSandbox so Code Mode tests don't need the compiled worker
// ---------------------------------------------------------------------------

vi.mock('../server/sandbox/sandbox.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/sandbox/index.js')>();
  return {
    ...original,
    executeInSandbox: vi.fn().mockResolvedValue('{"result": "mock sandbox output"}'),
  };
});

vi.mock('../server/protocol/elicitation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/protocol/elicitation.js')>();
  return { ...original, elicitOrFallback: vi.fn().mockResolvedValue({ action: 'cancel' }) };
});

import { executeInSandbox } from '../server/sandbox/index.js';
import { elicitOrFallback as mockedElicit } from '../server/protocol/elicitation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: 'https://example.com/source/',
    OPENGROK_USERNAME: '',
    OPENGROK_PASSWORD: '',
    OPENGROK_PASSWORD_FILE: '',
    OPENGROK_PASSWORD_KEY: '',
    OPENGROK_VERIFY_SSL: true,
    OPENGROK_TIMEOUT: 30,
    OPENGROK_DEFAULT_MAX_RESULTS: 25,
    OPENGROK_CACHE_ENABLED: false,
    OPENGROK_CACHE_SEARCH_TTL: 300,
    OPENGROK_CACHE_FILE_TTL: 600,
    OPENGROK_CACHE_HISTORY_TTL: 1800,
    OPENGROK_CACHE_PROJECTS_TTL: 3600,
    OPENGROK_CACHE_MAX_SIZE: 500,
    OPENGROK_CACHE_MAX_BYTES: 52428800,
    OPENGROK_RATELIMIT_ENABLED: false,
    OPENGROK_RATELIMIT_RPM: 60,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    OPENGROK_LOCAL_COMPILE_DB_PATHS: '',
    OPENGROK_DEFAULT_PROJECT: 'release-2.x',
    OPENGROK_CONTEXT_BUDGET: 'minimal',
    OPENGROK_CODE_MODE: true,
    OPENGROK_ENABLE_MEMORY_TOOLS: false,
    OPENGROK_ENABLE_ELICITATION: true,
    OPENGROK_MEMORY_BANK_DIR: '',
    OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
    ...overrides,
  } as Config;
}

function makeMockClient() {
  return {
    search: vi.fn().mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0, hasMore: false }),
    suggest: vi.fn().mockResolvedValue({ suggestions: [], time: 0, partialResult: false }),
    getFileContent: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', content: '', lineCount: 0, sizeBytes: 0 }),
    getFileHistory: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', entries: [] }),
    browseDirectory: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue([]),
    getAnnotate: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', lines: [] }),
    getFileSymbols: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', symbols: [] }),
    testConnection: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
}

async function createCodeModeClient(bank: MemoryBank, configOverrides: Partial<Config> = {}) {
  const ogClient = makeMockClient();
  const config = makeConfig(configOverrides);
  const server = createServer(ogClient as never, config, bank);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0' });
  await client.connect(clientTransport);
  return { client, ogClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Code Mode — createServer', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates server in Code Mode with memoryBank', () => {
    const client = makeMockClient();
    const config = makeConfig();
    const server = createServer(client as never, config, bank);
    expect(server).toBeDefined();
  });

  it('falls back to legacy mode when memoryBank not provided even with CODE_MODE=true', () => {
    const client = makeMockClient();
    const config = makeConfig({ OPENGROK_CODE_MODE: true });
    const server = createServer(client as never, config);
    expect(server).toBeDefined();
  });
});

describe('Code Mode — opengrok_api tool', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('opengrok_api returns API spec text', async () => {
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('env.opengrok');
    await client.close();
  });

  it('opengrok_api spec includes method signatures', async () => {
    const { client } = await createCodeModeClient(bank, { OPENGROK_ENABLE_MEMORY_TOOLS: true });
    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('batchSearch');
    expect(text).toContain('readMemory');
    await client.close();
  });
});

describe('Code Mode — opengrok_execute tool', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
    vi.mocked(executeInSandbox).mockResolvedValue('{"result": "mock output"}');
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('opengrok_execute calls executeInSandbox and returns result', async () => {
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return 42;' } });
    expect(vi.mocked(executeInSandbox)).toHaveBeenCalled();
    // Execution is now synchronous — result returned directly
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('mock output');
    await client.close();
  });

  it('opengrok_execute passes code to executeInSandbox', async () => {
    const { client } = await createCodeModeClient(bank);
    await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return { a: 1 };' } });
    const callArgs = vi.mocked(executeInSandbox).mock.calls[0];
    expect(callArgs[0]).toContain('return { a: 1 };');
    await client.close();
  });

  it('records to observation masker when OPENGROK_ENABLE_OBSERVATION_MASKER is true', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig({ OPENGROK_ENABLE_OBSERVATION_MASKER: true, OPENGROK_OBSERVATION_MASKER_TURNS: 10 } as Partial<Config>);
    const server = createServer(ogClient as never, config, bank);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return "test";' } });
    expect(result.content).toBeDefined();
    await client.close();
  });
});

describe('Code Mode — memory bank tools', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-mb-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('opengrok_read_memory returns stub message for uninitialized file', async () => {
    const { client } = await createCodeModeClient(bank, { OPENGROK_ENABLE_MEMORY_TOOLS: true });
    const result = await client.callTool({ name: 'opengrok_read_memory', arguments: { filename: 'active-task.md' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('not yet populated');
    await client.close();
  });

  it('opengrok_read_memory returns content for populated file', async () => {
    await bank.write('active-task.md', 'Investigating EventLoop crash');
    const { client } = await createCodeModeClient(bank, { OPENGROK_ENABLE_MEMORY_TOOLS: true });
    const result = await client.callTool({ name: 'opengrok_read_memory', arguments: { filename: 'active-task.md' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('EventLoop crash');
    await client.close();
  });

  it('opengrok_update_memory writes content to bank', async () => {
    const { client } = await createCodeModeClient(bank, { OPENGROK_ENABLE_MEMORY_TOOLS: true });
    await client.callTool({ name: 'opengrok_update_memory', arguments: { filename: 'active-task.md', content: 'New context', mode: 'overwrite' } });
    const content = await bank.read('active-task.md');
    expect(content).toContain('New context');
    await client.close();
  });

  it('opengrok_update_memory in append mode appends content', async () => {
    await bank.write('investigation-log.md', '## 2025-01-01: First entry\nInitial finding.');
    const { client } = await createCodeModeClient(bank, { OPENGROK_ENABLE_MEMORY_TOOLS: true });
    await client.callTool({ name: 'opengrok_update_memory', arguments: { filename: 'investigation-log.md', content: '## 2025-01-02: Second\nNew finding.', mode: 'append' } });
    const content = await bank.read('investigation-log.md');
    expect(content).toContain('First entry');
    expect(content).toContain('Second');
    await client.close();
  });
});

describe('createSandboxAPI — getCompileInfo', () => {
  let bank: MemoryBank;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-ci-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('getCompileInfo returns null when no getCompileInfoFn provided', async () => {
    const mockClient = makeMockClient();
    // createSandboxAPI called WITHOUT third arg (current behavior)
    const api = createSandboxAPI(mockClient as never, bank);
    const result = await api.getCompileInfo('/some/file.cpp');
    expect(result).toBeNull();
  });

  it('getCompileInfo delegates to getCompileInfoFn when provided', async () => {
    const fakeInfo = {
      file: '/abs/path/foo.cpp',
      compiler: 'g++',
      standard: 'c++17',
      includes: ['/usr/include'],
      defines: ['DEBUG'],
      extraFlags: ['-Wall'],
    };
    const fn = vi.fn().mockResolvedValue(fakeInfo);
    const mockClient = makeMockClient();
    const api = createSandboxAPI(mockClient as never, bank, { getCompileInfoFn: fn });
    const result = await api.getCompileInfo('/abs/path/foo.cpp');
    expect(result).toEqual(fakeInfo);
    expect(fn).toHaveBeenCalledWith('/abs/path/foo.cpp');
  });
});

describe('Standard Mode — memory tools are Code Mode only (Task 8)', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-legacy-mb-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT register memory tools in standard mode (CODE_MODE=false)', async () => {
    const ogClient = makeMockClient();
    // CODE_MODE is false — standard mode, memory tools should NOT be registered
    const config = makeConfig({ OPENGROK_CODE_MODE: false });
    const server = createServer(ogClient as never, config, bank);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    // Memory tools are Code Mode only — not available in standard mode
    expect(names).not.toContain('opengrok_read_memory');
    expect(names).not.toContain('opengrok_update_memory');
    expect(names).not.toContain('opengrok_memory_status');
    // Legacy tools should be present
    expect(names).toContain('opengrok_search_code');

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Memory tools toggle (OPENGROK_ENABLE_MEMORY_TOOLS)
// ---------------------------------------------------------------------------

describe('Code Mode — memory tools toggle', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-mem-toggle-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function listToolNames(configOverrides: Partial<Config> = {}): Promise<string[]> {
    const ogClient = makeMockClient();
    const config = makeConfig(configOverrides);
    const server = createServer(ogClient as never, config, bank);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    await client.close();
    return names;
  }

  it('registers 2 tools by default (api + execute only)', async () => {
    expect(await listToolNames()).toEqual([
      'opengrok_api',
      'opengrok_execute',
    ]);
  });

  it('registers 5 tools when OPENGROK_ENABLE_MEMORY_TOOLS=true', async () => {
    expect(await listToolNames({ OPENGROK_ENABLE_MEMORY_TOOLS: true })).toEqual([
      'opengrok_api',
      'opengrok_execute',
      'opengrok_memory_status',
      'opengrok_read_memory',
      'opengrok_update_memory',
    ]);
  });

  it('omits memory resources when disabled', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig({ OPENGROK_ENABLE_MEMORY_TOOLS: false });
    const server = createServer(ogClient as never, config, bank);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).not.toContain('opengrok-memory://active-task.md');
    expect(uris).not.toContain('opengrok-memory://investigation-log.md');
    await client.close();
  });

  it('opengrok_api omits memory methods when disabled', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig({ OPENGROK_ENABLE_MEMORY_TOOLS: false });
    const server = createServer(ogClient as never, config, bank);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).not.toContain('readMemory');
    expect(text).not.toContain('writeMemory');
    expect(text).toContain('search(');
    await client.close();
  });

  it('filterApiSpec strips [MEMORY] lines only when disabled', async () => {
    const { filterApiSpec, API_SPEC } = await import('../server/sandbox/index.js');
    expect(API_SPEC).toContain('readMemory');
    const filtered = filterApiSpec(API_SPEC, { memoryTools: false });
    expect(filtered).not.toContain('readMemory');
    expect(filtered).not.toContain('writeMemory');
    expect(filtered).toContain('search(');
    expect(filterApiSpec(API_SPEC, { memoryTools: true })).toBe(API_SPEC);
  });

  it('sandbox readMemory/writeMemory throw when memoryEnabled:false', async () => {
    const { createSandboxAPI } = await import('../server/sandbox/index.js');
    const ogClient = makeMockClient();
    const api = createSandboxAPI(ogClient as never, bank, { memoryEnabled: false });
    await expect(api.readMemory('active-task.md')).rejects.toThrow(/disabled/);
    await expect(api.writeMemory('active-task.md', 'x')).rejects.toThrow(/disabled/);
  });

  it('sandbox readMemory works when memory tools are enabled', async () => {
    const { createSandboxAPI } = await import('../server/sandbox/index.js');
    const ogClient = makeMockClient();
    const api = createSandboxAPI(ogClient as never, bank);
    await api.readMemory('active-task.md'); // must not throw
  });
});

// ---------------------------------------------------------------------------
// API_SPEC structure tests
// ---------------------------------------------------------------------------
import { API_SPEC, METHOD_SIGNATURES } from '../server/sandbox/index.js';

describe('API_SPEC — generated declaration string', () => {
  const ALL_METHODS = [
    'search', 'batchSearch', 'getFileContent', 'getSymbolContext',
    'getFileSymbols', 'getFileHistory', 'getFileAnnotate', 'browseDir',
    'findFile', 'getFileOverview', 'traceCallChain', 'searchSuggest',
    'getCompileInfo', 'indexHealth', 'readMemory', 'writeMemory',
    'getFileDiff', 'elicit', 'sample',
  ];

  it('API_SPEC is a TypeScript declaration string for env.opengrok.*', () => {
    expect(typeof API_SPEC).toBe('string');
    expect(API_SPEC).toContain('env.opengrok');
  });

  it('API_SPEC documents all 19 sandbox methods', () => {
    for (const name of ALL_METHODS) {
      expect(API_SPEC, `missing method ${name}`).toContain(`${name}(`);
    }
  });

  it('METHOD_SIGNATURES covers all 19 sandbox methods', () => {
    for (const name of ALL_METHODS) {
      expect(METHOD_SIGNATURES[name], `missing signature ${name}`).toContain(`${name}(`);
    }
  });

  it('API_SPEC documents cursor pagination and expandFunction opts', () => {
    expect(API_SPEC).toContain('cursor?: string');
    expect(API_SPEC).toContain('expandFunction?: boolean');
  });

  it('readMemory filenames are the 2-file architecture names', () => {
    expect(API_SPEC).toContain('active-task.md');
    expect(API_SPEC).toContain('investigation-log.md');
  });

  it('opengrok_api tool response serves the declaration string directly', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-spec-'));
    const specBank = new MemoryBank(tmpDir);
    await specBank.ensureDir();
    const { client } = await createCodeModeClient(specBank);
    try {
      const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      expect(text).toContain('getFileContent(');
      expect(text).toContain('traceCallChain(');
    } finally {
      await client.close();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Code Mode — opengrok_api project picker', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-picker-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('injects project hint when elicitation is enabled and user accepts', async () => {
    const ogClient = makeMockClient();
    ogClient.listProjects.mockResolvedValueOnce([
      { name: 'proj-a' }, { name: 'proj-b' }, { name: 'proj-c' },
    ]);
    vi.mocked(mockedElicit).mockResolvedValueOnce({
      action: 'accept',
      content: { project: 'proj-b' },
    });

    const config = makeConfig({
      OPENGROK_DEFAULT_PROJECT: '',
      OPENGROK_ENABLE_ELICITATION: true,
    });
    const server = createServer(ogClient as never, config, bank);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Working project: proj-b');
  });

  it('skips picker when OPENGROK_DEFAULT_PROJECT is set', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig({
      OPENGROK_DEFAULT_PROJECT: 'release-2.x',
      OPENGROK_ENABLE_ELICITATION: true,
    });
    const server = createServer(ogClient as never, config, bank);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0' });
    await client.connect(clientTransport);

    await client.callTool({ name: 'opengrok_api', arguments: {} });
    expect(mockedElicit).not.toHaveBeenCalled();
  });

  it('skips picker when OPENGROK_ENABLE_ELICITATION is false', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig({
      OPENGROK_DEFAULT_PROJECT: '',
      OPENGROK_ENABLE_ELICITATION: false,
    });
    const server = createServer(ogClient as never, config, bank);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0' });
    await client.connect(clientTransport);

    await client.callTool({ name: 'opengrok_api', arguments: {} });
    expect(mockedElicit).not.toHaveBeenCalled();
  });

  it('returns spec without hint when user cancels the picker', async () => {
    const ogClient = makeMockClient();
    ogClient.listProjects.mockResolvedValueOnce([{ name: 'proj-a' }]);
    vi.mocked(mockedElicit).mockResolvedValueOnce({ action: 'cancel' });

    const config = makeConfig({
      OPENGROK_DEFAULT_PROJECT: '',
      OPENGROK_ENABLE_ELICITATION: true,
    });
    const server = createServer(ogClient as never, config, bank);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain('Working project:');
    expect(text.length).toBeGreaterThan(100);
  });
});
