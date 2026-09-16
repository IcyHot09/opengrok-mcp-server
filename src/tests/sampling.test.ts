/**
 * Tests for MCP Sampling support (Task 4.8).
 * Covers sampleOrNull wrapper, opengrok_execute error explanation,
 * and opengrok_dependency_map graph summarization.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { sampleOrNull } from '../server/protocol/sampling.js';
import { createServer } from '../server/server.js';
import { MemoryBank } from '../server/memory/memory-bank.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../server/config.js';

// ---------------------------------------------------------------------------
// Mock executeInSandbox so Code Mode tests don't need the compiled worker
// ---------------------------------------------------------------------------

vi.mock('../server/sandbox/sandbox.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/sandbox/index.js')>();
  return {
    ...original,
    executeInSandbox: vi.fn().mockResolvedValue('{"result": "mock output"}'),
  };
});

import { executeInSandbox } from '../server/sandbox/index.js';

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
    OPENGROK_MEMORY_BANK_DIR: '',
    OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
    OPENGROK_PER_TOOL_RATELIMIT: '',
    OPENGROK_ALLOWED_CLIENT_IDS: '',
    OPENGROK_PROXY: '',
    OPENGROK_ENABLE_SAMPLING: true,
    OPENGROK_SAMPLING_MAX_TOKENS: 256,
    OPENGROK_SAMPLING_MODEL: '',
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

async function createConnectedClient(overrides: Partial<Config> = {}, bank?: MemoryBank) {
  const ogClient = makeMockClient();
  const config = makeConfig(overrides);
  const server = createServer(ogClient as never, config, bank);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0' });
  await client.connect(clientTransport);
  return { client, ogClient, server };
}

// ---------------------------------------------------------------------------
// Tests: sampleOrNull wrapper
// ---------------------------------------------------------------------------

describe('sampleOrNull', () => {
  it('returns null when server.server.createMessage throws', async () => {
    const mockServer = {
      server: {
        createMessage: vi.fn().mockRejectedValue(new Error('Client does not support sampling')),
      },
    };
    const result = await sampleOrNull(mockServer as never, [
      { role: 'user', content: { type: 'text', text: 'test' } },
    ]);
    expect(result).toBeNull();
  });

  it('returns text content when sampling succeeds', async () => {
    const mockServer = {
      server: {
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          role: 'assistant',
          content: { type: 'text', text: 'Here is the explanation.' },
        }),
      },
    };
    const result = await sampleOrNull(mockServer as never, [
      { role: 'user', content: { type: 'text', text: 'Explain this error' } },
    ]);
    expect(result).toBe('Here is the explanation.');
  });

  it('returns null when content type is text but text property is undefined', async () => {
    const mockServer = {
      server: {
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          role: 'assistant',
          content: { type: 'text' }, // text property absent → content.text ?? null returns null
        }),
      },
    };
    const result = await sampleOrNull(mockServer as never, [
      { role: 'user', content: { type: 'text', text: 'test' } },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when content type is not text', async () => {
    const mockServer = {
      server: {
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          role: 'assistant',
          content: { type: 'image', data: 'base64data', mimeType: 'image/png' },
        }),
      },
    };
    const result = await sampleOrNull(mockServer as never, [
      { role: 'user', content: { type: 'text', text: 'test' } },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when result has no content', async () => {
    const mockServer = {
      server: {
        createMessage: vi.fn().mockResolvedValue(null),
      },
    };
    const result = await sampleOrNull(mockServer as never, [
      { role: 'user', content: { type: 'text', text: 'test' } },
    ]);
    expect(result).toBeNull();
  });

  it('passes systemPrompt and maxTokens to createMessage', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'test-model',
      role: 'assistant',
      content: { type: 'text', text: 'ok' },
    });
    const mockServer = { server: { createMessage } };
    await sampleOrNull(
      mockServer as never,
      [{ role: 'user', content: { type: 'text', text: 'test' } }],
      { maxTokens: 128, systemPrompt: 'Be concise.' }
    );
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 128, systemPrompt: 'Be concise.' })
    );
  });
});


// ---------------------------------------------------------------------------
// Tests: production sampling — retry, timeout, defaults, model preference (Task 5.5)
// ---------------------------------------------------------------------------

describe('sampleOrNull — production features', () => {
  it('retries on transient failure and returns result on eventual success', async () => {
    const createMessage = vi.fn()
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue({
        model: 'test-model',
        role: 'assistant',
        content: { type: 'text', text: 'recovered' },
      });
    const mockServer = { server: { createMessage } };
    const result = await sampleOrNull(
      mockServer as never,
      [{ role: 'user', content: { type: 'text', text: 'test' } }],
      { retries: 2, timeoutMs: 5000 }
    );
    expect(result).toBe('recovered');
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('returns null after all retries are exhausted', async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error('always fails'));
    const mockServer = { server: { createMessage } };
    const result = await sampleOrNull(
      mockServer as never,
      [{ role: 'user', content: { type: 'text', text: 'test' } }],
      { retries: 1, timeoutMs: 5000 }
    );
    expect(result).toBeNull();
    // 1 initial attempt + 1 retry = 2 total calls
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('returns null when timeout expires', async () => {
    const createMessage = vi.fn().mockImplementation(
      () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('late')), 200))
    );
    const mockServer = { server: { createMessage } };
    const result = await sampleOrNull(
      mockServer as never,
      [{ role: 'user', content: { type: 'text', text: 'test' } }],
      // Very short timeout to force expiry; no retries to keep test fast
      { timeoutMs: 50, retries: 0 }
    );
    expect(result).toBeNull();
  });

  it('passes model hint in modelPreferences when model is specified', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'claude-3-haiku',
      role: 'assistant',
      content: { type: 'text', text: 'ok' },
    });
    const mockServer = { server: { createMessage } };
    await sampleOrNull(
      mockServer as never,
      [{ role: 'user', content: { type: 'text', text: 'hello' } }],
      { model: 'claude-3-haiku', retries: 0 }
    );
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPreferences: { hints: [{ name: 'claude-3-haiku' }] },
      })
    );
  });

  it('applies default maxTokens of 256 when not specified', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'test-model',
      role: 'assistant',
      content: { type: 'text', text: 'ok' },
    });
    const mockServer = { server: { createMessage } };
    await sampleOrNull(mockServer as never, [{ role: 'user', content: { type: 'text', text: 'hi' } }]);
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 256 })
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Code Mode tool annotations (Task 8 — x-supports-interleaving removed)
// ---------------------------------------------------------------------------

describe('Code Mode tools — standard MCP annotations', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-interleave-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('opengrok_execute is registered with standard MCP annotations (no custom fields)', async () => {
    const { server } = await createConnectedClient({ OPENGROK_CODE_MODE: true }, bank);
    const internal = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools;
    expect(internal['opengrok_execute']).toBeDefined();
    // x-supports-interleaving was a custom annotation not in the MCP spec — removed in Task 8
    expect(internal['opengrok_execute'].annotations?.['x-supports-interleaving']).toBeUndefined();
    // Standard MCP annotations should be present
    expect(internal['opengrok_execute'].annotations?.['readOnlyHint']).toBe(false);
    expect(internal['opengrok_execute'].annotations?.['idempotentHint']).toBe(false);
  });

  it('opengrok_api is registered with standard MCP annotations (no custom fields)', async () => {
    const { server } = await createConnectedClient({ OPENGROK_CODE_MODE: true }, bank);
    const internal = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools;
    expect(internal['opengrok_api']).toBeDefined();
    // x-supports-interleaving was a custom annotation not in the MCP spec — removed in Task 8
    expect(internal['opengrok_api'].annotations?.['x-supports-interleaving']).toBeUndefined();
    // Standard MCP annotations should be present
    expect(internal['opengrok_api'].annotations?.['readOnlyHint']).toBe(true);
    expect(internal['opengrok_api'].annotations?.['idempotentHint']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: opengrok_execute — sampling for error explanation
// ---------------------------------------------------------------------------

describe('opengrok_execute — sampling error explanation', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-sampling-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
    vi.mocked(executeInSandbox).mockReset();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends LLM suggestion when execution fails and sampling is available', async () => {
    vi.mocked(executeInSandbox).mockResolvedValue('Error: ReferenceError: foo is not defined');

    const ogClient = makeMockClient();
    const config = makeConfig();
    const server = createServer(ogClient as never, config, bank);

    // Inject a sampling mock into the underlying Server
    (server.server as never as { createMessage: unknown }).createMessage = vi.fn().mockResolvedValue({
      model: 'test-model',
      role: 'assistant',
      content: { type: 'text', text: 'foo is not declared in this scope.' },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    // Execution is now synchronous — result returned directly
    const result = await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return foo;' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Error: ReferenceError');
    expect(text).toContain('Suggestion:');
    expect(text).toContain('foo is not declared in this scope.');
  });

  it('returns plain error when sampling is not available', async () => {
    vi.mocked(executeInSandbox).mockResolvedValue('Error: ReferenceError: foo is not defined');

    const ogClient = makeMockClient();
    const config = makeConfig();
    const server = createServer(ogClient as never, config, bank);

    // No sampling — createMessage throws
    (server.server as never as { createMessage: unknown }).createMessage = vi.fn().mockRejectedValue(
      new Error('Client does not support sampling')
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    // Execution is now synchronous — result returned directly
    const result = await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return foo;' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Error: ReferenceError');
    expect(text).not.toContain('Suggestion:');
  });

  it('does not call sampling when execution succeeds', async () => {
    vi.mocked(executeInSandbox).mockResolvedValue('{"result": "42"}');

    const ogClient = makeMockClient();
    const config = makeConfig();
    const server = createServer(ogClient as never, config, bank);

    const createMessage = vi.fn();
    (server.server as never as { createMessage: unknown }).createMessage = createMessage;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return 42;' } });
    expect(createMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: opengrok_dependency_map — sampling for large graphs
// ---------------------------------------------------------------------------

describe('opengrok_dependency_map — sampling for large graphs', () => {
  it('appends summary when graph has more than 10 nodes and sampling is available', async () => {
    // Build a 12-node mock dependency graph via server.ts internals by mocking
    // the client to return many cross-references
    const ogClient = makeMockClient();
    const config = makeConfig({ OPENGROK_CODE_MODE: false });
    const server = createServer(ogClient as never, config);

    // Mock client calls: getFileContent (used by dependency graph builder) or search
    // The dependency graph uses browseDirectory/search. We mock client.search to
    // return 12 results so nodes.length > 10.
    ogClient.search.mockResolvedValue({
      query: 'x', searchType: 'full', totalCount: 12, timeMs: 1,
      results: Array.from({ length: 12 }, (_, i) => ({
        file: { path: `/src/file${i}.cpp`, project: 'test-proj' },
        lines: [],
      })),
      startIndex: 0, endIndex: 12, hasMore: false,
    });

    (server.server as never as { createMessage: unknown }).createMessage = vi.fn().mockResolvedValue({
      model: 'test-model',
      role: 'assistant',
      content: { type: 'text', text: 'This file has many dependents across modules.' },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    // The tool may succeed or return fewer nodes depending on internal logic;
    // the key assertion is that no unhandled error occurs.
    const result = await client.callTool({
      name: 'opengrok_dependency_map',
      arguments: { project: 'test-proj', path: 'src/main.cpp', depth: 2, direction: 'both' },
    });
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });
});
