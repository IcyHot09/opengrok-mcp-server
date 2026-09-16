/**
 * Tests for Task 4.5 (MCP Resources) and Task 4.6 (MCP Prompts).
 *
 * Task 4.5: active-task.md and investigation-log.md are exposed as MCP
 *   Resources at opengrok-memory:// URIs.
 * Task 4.6: investigate-symbol, find-feature, review-file prompts are
 *   registered and return correctly structured messages.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { createServer } from '../server/server.js';
import { MemoryBank } from '../server/memory/memory-bank.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../server/config.js';

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
    OPENGROK_CODE_MODE: false,
    OPENGROK_ENABLE_MEMORY_TOOLS: true,
    OPENGROK_MEMORY_BANK_DIR: '',
    OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
    ...overrides,
  } as Config;
}

function makeMockClient() {
  return {
    search: async () => ({ query: '', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0, hasMore: false }),
    suggest: async () => ({ suggestions: [], time: 0, partialResult: false }),
    getFileContent: async () => ({ project: 'p', path: 'f.cpp', content: '', lineCount: 0, sizeBytes: 0 }),
    getFileHistory: async () => ({ project: 'p', path: 'f.cpp', entries: [] }),
    browseDirectory: async () => [],
    listProjects: async () => [],
    getAnnotate: async () => ({ project: 'p', path: 'f.cpp', lines: [] }),
    getFileSymbols: async () => ({ project: 'p', path: 'f.cpp', symbols: [] }),
    testConnection: async () => true,
    close: async () => undefined,
  };
}

async function createTestClient(bank: MemoryBank): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const ogClient = makeMockClient();
  const config = makeConfig();
  const server = createServer(ogClient as never, config, bank);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0' });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Task 4.5: Resources
// ---------------------------------------------------------------------------

describe('Task 4.5 — MCP Resources', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-res-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('listResources returns both memory bank files', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('opengrok-memory://active-task.md');
      expect(uris).toContain('opengrok-memory://investigation-log.md');
    } finally {
      await cleanup();
    }
  });

  it('resources have text/markdown mimeType', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const { resources } = await client.listResources();
      for (const r of resources) {
        if (r.uri.startsWith('opengrok-memory://')) {
          expect(r.mimeType).toBe('text/markdown');
        }
      }
    } finally {
      await cleanup();
    }
  });

  it('readResource returns stub content for fresh active-task.md', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.readResource({ uri: 'opengrok-memory://active-task.md' });
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe('opengrok-memory://active-task.md');
      // MCP SDK may return `text` or `blob`; we expect text
      if ('text' in content) {
        expect(typeof content.text).toBe('string');
      }
    } finally {
      await cleanup();
    }
  });

  it('readResource reflects written content', async () => {
    await bank.write('active-task.md', '# My Task\nDoing something important.', 'overwrite');
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.readResource({ uri: 'opengrok-memory://active-task.md' });
      const content = result.contents[0];
      if ('text' in content) {
        expect(content.text).toContain('My Task');
        expect(content.text).toContain('Doing something important.');
      }
    } finally {
      await cleanup();
    }
  });

  it('readResource works for investigation-log.md', async () => {
    await bank.write('investigation-log.md', '## 2025-01-01: Finding\nSome note.', 'overwrite');
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.readResource({ uri: 'opengrok-memory://investigation-log.md' });
      const content = result.contents[0];
      expect(content.uri).toBe('opengrok-memory://investigation-log.md');
      if ('text' in content) {
        expect(content.text).toContain('Finding');
      }
    } finally {
      await cleanup();
    }
  });

  it('memory bank resources expose size field when files exist', async () => {
    await bank.write('active-task.md', '# Task\nSome content here.', 'overwrite');
    const { client, cleanup } = await createTestClient(bank);
    try {
      const { resources } = await client.listResources();
      const activeTask = resources.find((r) => r.uri === 'opengrok-memory://active-task.md');
      expect(activeTask).toBeDefined();
      expect(typeof activeTask!.size).toBe('number');
      expect(activeTask!.size).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('resources are NOT registered when memoryBank is omitted', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig();
    // createServer without memoryBank
    const server = createServer(ogClient as never, config);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    // When no resources are registered, the server may throw -32601 (Method not found)
    // or return an empty list; either outcome confirms no memory resources are exposed.
    let memoryUris: string[] = [];
    try {
      const { resources } = await client.listResources();
      memoryUris = resources.filter((r) => r.uri.startsWith('opengrok-memory://')).map((r) => r.uri);
    } catch {
      // -32601 Method not found — no resources registered at all, which is correct
    }
    expect(memoryUris).toHaveLength(0);

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Task 4.6: Prompts
// ---------------------------------------------------------------------------

describe('Task 4.6 — MCP Prompts', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-prom-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('listPrompts returns all 3 investigation prompts', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((p) => p.name);
      expect(names).toContain('investigate-symbol');
      expect(names).toContain('find-feature');
      expect(names).toContain('review-file');
    } finally {
      await cleanup();
    }
  });

  it('prompts are registered even without a memoryBank', async () => {
    const ogClient = makeMockClient();
    const config = makeConfig();
    const server = createServer(ogClient as never, config);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain('investigate-symbol');
    expect(names).toContain('find-feature');
    expect(names).toContain('review-file');

    await client.close();
  });

  it('investigate-symbol prompt returns a user message containing the symbol name', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.getPrompt({ name: 'investigate-symbol', arguments: { symbol: 'MyClass' } });
      expect(result.messages).toHaveLength(1);
      const msg = result.messages[0];
      expect(msg.role).toBe('user');
      if (msg.content.type === 'text') {
        expect(msg.content.text).toContain('MyClass');
        expect(msg.content.text).toContain('opengrok_search_code');
      }
    } finally {
      await cleanup();
    }
  });

  it('investigate-symbol prompt accepts optional project argument', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.getPrompt({
        name: 'investigate-symbol',
        arguments: { symbol: 'parseToken', project: 'my-project' },
      });
      expect(result.messages).toHaveLength(1);
      if (result.messages[0].content.type === 'text') {
        expect(result.messages[0].content.text).toContain('parseToken');
        expect(result.messages[0].content.text).toContain('my-project');
      }
    } finally {
      await cleanup();
    }
  });

  it('find-feature prompt returns a user message containing the feature description', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.getPrompt({ name: 'find-feature', arguments: { feature: 'rate limiting' } });
      expect(result.messages).toHaveLength(1);
      if (result.messages[0].content.type === 'text') {
        expect(result.messages[0].content.text).toContain('rate limiting');
        expect(result.messages[0].content.text).toContain('opengrok_search_code');
      }
    } finally {
      await cleanup();
    }
  });

  it('review-file prompt returns a user message with path and project', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const result = await client.getPrompt({
        name: 'review-file',
        arguments: { path: 'src/auth/login.ts', project: 'frontend' },
      });
      expect(result.messages).toHaveLength(1);
      if (result.messages[0].content.type === 'text') {
        const text = result.messages[0].content.text;
        expect(text).toContain('src/auth/login.ts');
        expect(text).toContain('frontend');
        expect(text).toContain('opengrok_get_file_content');
      }
    } finally {
      await cleanup();
    }
  });

  it('prompts have descriptions', async () => {
    const { client, cleanup } = await createTestClient(bank);
    try {
      const { prompts } = await client.listPrompts();
      for (const p of prompts.filter((p) => ['investigate-symbol', 'find-feature', 'review-file'].includes(p.name))) {
        expect(p.description).toBeTruthy();
      }
    } finally {
      await cleanup();
    }
  });
});
