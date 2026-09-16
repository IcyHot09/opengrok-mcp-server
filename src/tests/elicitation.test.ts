/**
 * Tests for MCP Elicitation support (Task 4.7, §4.7).
 *
 * Covers:
 * 1. elicitOrFallback() returns SDK result when elicitInput succeeds
 * 2. elicitOrFallback() returns cancel when SDK throws (client not capable)
 * 3. elicitOrFallback() passes through decline
 * 4. search tool elicits when flag enabled and no project given
 * 5. search tool skips elicitation when project already specified
 * 6. search tool continues when elicitation returns cancel
 * 7. search tool skips elicitation when feature flag is off
 * 8. search tool skips elicitation when OPENGROK_DEFAULT_PROJECT is set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../server/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../server/config.js';

// ---------------------------------------------------------------------------
// Mock elicitOrFallback for integration tests
// ---------------------------------------------------------------------------

vi.mock('../server/protocol/elicitation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/protocol/elicitation.js')>();
  return {
    ...original,
    elicitOrFallback: vi.fn().mockResolvedValue({ action: 'cancel' }),
  };
});

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
    OPENGROK_DEFAULT_PROJECT: '',
    OPENGROK_CONTEXT_BUDGET: 'minimal',
    OPENGROK_CODE_MODE: false,
    OPENGROK_MEMORY_BANK_DIR: '',
    OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
    OPENGROK_ENABLE_ELICITATION: false,
    OPENGROK_PER_TOOL_RATELIMIT: '',
    OPENGROK_ALLOWED_CLIENT_IDS: '',
    ...overrides,
  } as Config;
}

function makeMockClient() {
  return {
    search: vi.fn().mockResolvedValue({
      query: 'foo', searchType: 'full', totalCount: 0, timeMs: 1,
      results: [], startIndex: 0, endIndex: 0,
    }),
    suggest: vi.fn().mockResolvedValue({ suggestions: [], time: 0, partialResult: false }),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([
      { name: 'alpha' }, { name: 'beta' }, { name: 'gamma' },
    ]),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    warmCache: vi.fn(),
    close: vi.fn(),
    searchPattern: vi.fn(),
  };
}

async function createTestClient(
  ogClient: ReturnType<typeof makeMockClient>,
  config: Config
) {
  const server = createServer(ogClient as never, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0' });
  await client.connect(clientTransport);
  return { client, server };
}

// ---------------------------------------------------------------------------
// Unit tests for elicitOrFallback() (real implementation via importActual)
// ---------------------------------------------------------------------------

describe('elicitOrFallback (unit)', () => {
  const schema = {
    type: 'object' as const,
    properties: { project: { type: 'string' as const, enum: ['alpha', 'beta'] } },
    required: ['project'],
  };

  it('returns SDK result when elicitInput succeeds', async () => {
    const { elicitOrFallback: realElicit } = await vi.importActual<
      typeof import('../server/protocol/elicitation.js')
    >('../server/protocol/elicitation.js');

    const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { project: 'alpha' } });
    const mockServer = {
      server: { elicitInput },
    } as unknown as McpServer;

    const result = await realElicit(mockServer, 'Pick project', schema);
    expect(result.action).toBe('accept');
    expect(result.content?.project).toBe('alpha');
    expect(elicitInput).toHaveBeenCalledOnce();
  });

  it('returns cancel when elicitInput throws (client not capable)', async () => {
    const { elicitOrFallback: realElicit } = await vi.importActual<
      typeof import('../server/protocol/elicitation.js')
    >('../server/protocol/elicitation.js');

    const elicitInput = vi.fn().mockRejectedValue(new Error('Client does not support elicitation'));
    const mockServer = {
      server: { elicitInput },
    } as unknown as McpServer;

    const result = await realElicit(mockServer, 'Pick project', schema);
    expect(result.action).toBe('cancel');
    expect(result.content).toBeUndefined();
  });

  it('passes through decline action', async () => {
    const { elicitOrFallback: realElicit } = await vi.importActual<
      typeof import('../server/protocol/elicitation.js')
    >('../server/protocol/elicitation.js');

    const elicitInput = vi.fn().mockResolvedValue({ action: 'decline' });
    const mockServer = {
      server: { elicitInput },
    } as unknown as McpServer;

    const result = await realElicit(mockServer, 'Pick project', schema);
    expect(result.action).toBe('decline');
  });

  it('falls back to cancel when server.server.elicitInput is not a function (SDK API changed)', async () => {
    // This test validates that the server.server cast in elicitation.ts correctly handles
    // the case where the SDK renames or removes the internal server property.
    // If this test fails, the SDK API has changed and elicitation.ts must be updated.
    const { elicitOrFallback: realElicit } = await vi.importActual<
      typeof import('../server/protocol/elicitation.js')
    >('../server/protocol/elicitation.js');

    // Simulate a future SDK where server.server does not have elicitInput
    const mockServer = { server: {} } as unknown as McpServer;
    const result = await realElicit(mockServer, 'Pick project', schema);
    expect(result.action).toBe('cancel');
  });

  it('SDK cast is valid: real McpServer instance has server.elicitInput accessible', async () => {
    // Validates the server.server cast against the CURRENTLY INSTALLED SDK version.
    // If this test fails after an SDK upgrade, update the cast in elicitation.ts.
    const { McpServer: RealMcpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const realServer = new RealMcpServer({
      name: 'test',
      version: '1.0',
    });
    const lowLevel = (realServer as unknown as { server?: { elicitInput?: unknown } }).server;
    expect(typeof lowLevel?.elicitInput, 
      'server.server.elicitInput must be a function — if this fails, the SDK renamed or moved the property; update elicitation.ts'
    ).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Integration: opengrok_search_code elicitation behaviour
// ---------------------------------------------------------------------------

describe('opengrok_search_code elicitation integration', () => {
  let ogClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    ogClient = makeMockClient();
    vi.mocked(mockedElicit).mockClear();
    vi.mocked(mockedElicit).mockResolvedValue({ action: 'cancel' });
  });

  it('feature flag off → no elicitation even without project', async () => {
    const config = makeConfig({ OPENGROK_ENABLE_ELICITATION: false });
    const { client } = await createTestClient(ogClient, config);

    await client.callTool({
      name: 'opengrok_search_code',
      arguments: { query: 'foo', search_type: 'full', max_results: 5, start_index: 0 },
    });

    expect(ogClient.listProjects).not.toHaveBeenCalled();
    expect(mockedElicit).not.toHaveBeenCalled();
    await client.close();
  });

  it('elicitation triggered when flag enabled and no project given', async () => {
    const config = makeConfig({ OPENGROK_ENABLE_ELICITATION: true });
    const { client } = await createTestClient(ogClient, config);

    await client.callTool({
      name: 'opengrok_search_code',
      arguments: { query: 'foo', search_type: 'full', max_results: 5, start_index: 0 },
    });

    expect(ogClient.listProjects).toHaveBeenCalled();
    expect(mockedElicit).toHaveBeenCalledWith(
      expect.anything(),
      'Which project should I search?',
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          project: expect.objectContaining({ enum: ['alpha', 'beta', 'gamma'] }),
        }),
      })
    );
    await client.close();
  });

  it('elicitation skipped when project already specified', async () => {
    const config = makeConfig({ OPENGROK_ENABLE_ELICITATION: true });
    const { client } = await createTestClient(ogClient, config);

    await client.callTool({
      name: 'opengrok_search_code',
      arguments: { query: 'foo', search_type: 'full', projects: ['alpha'], max_results: 5, start_index: 0 },
    });

    expect(ogClient.listProjects).not.toHaveBeenCalled();
    expect(mockedElicit).not.toHaveBeenCalled();
    await client.close();
  });

  it('search continues without project when elicitation returns cancel', async () => {
    vi.mocked(mockedElicit).mockResolvedValue({ action: 'cancel' });
    const config = makeConfig({ OPENGROK_ENABLE_ELICITATION: true });
    const { client } = await createTestClient(ogClient, config);

    await client.callTool({
      name: 'opengrok_search_code',
      arguments: { query: 'foo', search_type: 'full', max_results: 5, start_index: 0 },
    });

    expect(ogClient.search).toHaveBeenCalledWith('foo', 'full', undefined, 5, 0, undefined, undefined, undefined, undefined, undefined);
    await client.close();
  });

  it('elicitation skipped when OPENGROK_DEFAULT_PROJECT is set', async () => {
    const config = makeConfig({ OPENGROK_ENABLE_ELICITATION: true, OPENGROK_DEFAULT_PROJECT: 'myproject' });
    const { client } = await createTestClient(ogClient, config);

    await client.callTool({
      name: 'opengrok_search_code',
      arguments: { query: 'foo', search_type: 'full', max_results: 5, start_index: 0 },
    });

    expect(ogClient.listProjects).not.toHaveBeenCalled();
    expect(mockedElicit).not.toHaveBeenCalled();
    await client.close();
  });
});
