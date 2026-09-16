import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BUDGET_LIMITS, loadConfig, resetConfig } from '../server/config.js';
import { createServer } from '../server/server.js';
import type { Config } from '../server/config.js';

// ---------------------------------------------------------------------------
// BUDGET_LIMITS constants
// ---------------------------------------------------------------------------

describe('BUDGET_LIMITS', () => {
  it('minimal has correct byte/line values', () => {
    expect(BUDGET_LIMITS.minimal.maxResponseBytes).toBe(8_192);
    expect(BUDGET_LIMITS.minimal.maxInlineLines).toBe(50);
    expect(BUDGET_LIMITS.minimal.contextLines).toBe(3);
    expect(BUDGET_LIMITS.minimal.maxSearchResults).toBe(5);
    expect(BUDGET_LIMITS.minimal.searchAndReadCap).toBe(2_048);
  });

  it('standard has correct byte/line values', () => {
    expect(BUDGET_LIMITS.standard.maxResponseBytes).toBe(16_384);
    expect(BUDGET_LIMITS.standard.maxInlineLines).toBe(100);
    expect(BUDGET_LIMITS.standard.contextLines).toBe(5);
    expect(BUDGET_LIMITS.standard.maxSearchResults).toBe(10);
    expect(BUDGET_LIMITS.standard.searchAndReadCap).toBe(4_096);
  });

  it('generous has correct byte/line values', () => {
    expect(BUDGET_LIMITS.generous.maxResponseBytes).toBe(32_768);
    expect(BUDGET_LIMITS.generous.maxInlineLines).toBe(200);
    expect(BUDGET_LIMITS.generous.contextLines).toBe(10);
    expect(BUDGET_LIMITS.generous.maxSearchResults).toBe(25);
    expect(BUDGET_LIMITS.generous.searchAndReadCap).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// loadConfig() env var parsing
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfig();
    // Set required URL to avoid validation error
    process.env.OPENGROK_BASE_URL = 'https://opengrok.test/source/';
  });

  afterEach(() => {
    resetConfig();
    delete process.env.OPENGROK_BASE_URL;
    delete process.env.OPENGROK_CONTEXT_BUDGET;
    delete process.env.OPENGROK_CODE_MODE;
    delete process.env.OPENGROK_ENABLE_MEMORY_TOOLS;
    delete process.env.OPENGROK_ENABLE_ELICITATION;
    delete process.env.OPENGROK_ENABLE_FILES_API;
    delete process.env.OPENGROK_ENABLE_OBSERVATION_MASKER;
    delete process.env.OPENGROK_MEMORY_BANK_DIR;
    delete process.env.OPENGROK_TIMEOUT;
  });

  it('reads OPENGROK_CONTEXT_BUDGET=standard', () => {
    process.env.OPENGROK_CONTEXT_BUDGET = 'standard';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CONTEXT_BUDGET).toBe('standard');
  });

  it('reads OPENGROK_CONTEXT_BUDGET=generous', () => {
    process.env.OPENGROK_CONTEXT_BUDGET = 'generous';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CONTEXT_BUDGET).toBe('generous');
  });

  it('defaults OPENGROK_CONTEXT_BUDGET to standard', () => {
    delete process.env.OPENGROK_CONTEXT_BUDGET;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CONTEXT_BUDGET).toBe('standard');
  });

  it('defaults OPENGROK_CODE_MODE to true', () => {
    delete process.env.OPENGROK_CODE_MODE;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CODE_MODE).toBe(true);
  });

  it('parses OPENGROK_CODE_MODE=true to boolean true', () => {
    process.env.OPENGROK_CODE_MODE = 'true';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CODE_MODE).toBe(true);
  });

  it('parses OPENGROK_CODE_MODE=false to boolean false', () => {
    process.env.OPENGROK_CODE_MODE = 'false';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CODE_MODE).toBe(false);
  });

  it('defaults OPENGROK_ENABLE_MEMORY_TOOLS to false', () => {
    delete process.env.OPENGROK_ENABLE_MEMORY_TOOLS;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_ENABLE_MEMORY_TOOLS).toBe(false);
  });

  it('parses OPENGROK_ENABLE_MEMORY_TOOLS=true to boolean true', () => {
    process.env.OPENGROK_ENABLE_MEMORY_TOOLS = 'true';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_ENABLE_MEMORY_TOOLS).toBe(true);
  });

  it('parses OPENGROK_ENABLE_MEMORY_TOOLS=false to boolean false', () => {
    process.env.OPENGROK_ENABLE_MEMORY_TOOLS = 'false';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_ENABLE_MEMORY_TOOLS).toBe(false);
  });

  it('defaults OPENGROK_ENABLE_ELICITATION to true', () => {
    delete process.env.OPENGROK_ENABLE_ELICITATION;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_ENABLE_ELICITATION).toBe(true);
  });

  it('parses OPENGROK_ENABLE_ELICITATION=false to boolean false', () => {
    process.env.OPENGROK_ENABLE_ELICITATION = 'false';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_ENABLE_ELICITATION).toBe(false);
  });

  it('parses "false" to boolean false for FILES_API and OBSERVATION_MASKER', () => {
    process.env.OPENGROK_ENABLE_FILES_API = 'false';
    process.env.OPENGROK_ENABLE_OBSERVATION_MASKER = 'false';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_ENABLE_FILES_API).toBe(false);
    expect(cfg.OPENGROK_ENABLE_OBSERVATION_MASKER).toBe(false);
    delete process.env.OPENGROK_ENABLE_FILES_API;
    delete process.env.OPENGROK_ENABLE_OBSERVATION_MASKER;
  });

  it('defaults OPENGROK_MEMORY_BANK_DIR to empty string', () => {
    delete process.env.OPENGROK_MEMORY_BANK_DIR;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_MEMORY_BANK_DIR).toBe('');
  });

  it('returns cached config on second call', () => {
    const cfg1 = loadConfig();
    const cfg2 = loadConfig();
    expect(cfg1).toBe(cfg2); // same reference — singleton
  });

  it('throws or exits on invalid OPENGROK_TIMEOUT (non-integer)', () => {
    process.env.OPENGROK_TIMEOUT = 'not-an-integer';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    let threw = false;
    try {
      loadConfig();
    } catch {
      threw = true;
    }
    // Zod v4 throws from transforms; either process.exit or an exception signals invalid config
    expect(threw || exitSpy.mock.calls.length > 0).toBe(true);
    exitSpy.mockRestore();
  });

  it('exits when HTTP_PROXY has an invalid scheme (ftp)', () => {
    process.env.HTTP_PROXY = 'ftp://proxy.example.com:8080';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error('process.exit');
    });
    expect(() => loadConfig()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    delete process.env.HTTP_PROXY;
  });

  it('exits when HTTPS_PROXY is not a valid URL', () => {
    process.env.HTTPS_PROXY = 'not-a-url';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error('process.exit');
    });
    expect(() => loadConfig()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    delete process.env.HTTPS_PROXY;
  });
});

// ---------------------------------------------------------------------------
// compactDescriptions — minimal budget triggers compact tool descriptions
// ---------------------------------------------------------------------------

describe('compactDescriptions — budget-driven tool description selection', () => {
  function makeMockClient() {
    return {
      search: vi.fn(),
      suggest: vi.fn(),
      getFileContent: vi.fn(),
      getFileHistory: vi.fn(),
      browseDirectory: vi.fn(),
      listProjects: vi.fn(),
      getAnnotate: vi.fn(),
      getFileSymbols: vi.fn(),
      testConnection: vi.fn(),
      close: vi.fn(),
    };
  }

  function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
      OPENGROK_BASE_URL: 'https://example.com/source/',
      OPENGROK_USERNAME: '',
      OPENGROK_PASSWORD: '',
      OPENGROK_VERIFY_SSL: true,
      OPENGROK_TIMEOUT: 30,
      OPENGROK_DEFAULT_MAX_RESULTS: 10,
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
      OPENGROK_CODE_MODE: false,
      OPENGROK_MEMORY_BANK_DIR: '',
      OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
      ...overrides,
    } as Config;
  }

  type RegisteredTool = { description?: string; annotations?: Record<string, unknown> };
  type ServerInternal = { _registeredTools: Record<string, RegisteredTool> };

  it('uses compact descriptions when OPENGROK_CONTEXT_BUDGET=minimal and Code Mode is OFF', () => {
    const client = makeMockClient();
    const config = makeConfig({ OPENGROK_CONTEXT_BUDGET: 'minimal' });
    const server = createServer(client as never, config);

    const internal = (server as unknown as ServerInternal)._registeredTools;
    // opengrok_search_code compact description is the short fallback form
    const desc = internal['opengrok_search_code']?.description ?? '';
    expect(desc).not.toContain('Full-text or symbol search across one or all OpenGrok projects');
    // Should be the compact version
    expect(desc.length).toBeLessThan(50);
  });

  it('uses full descriptions when OPENGROK_CONTEXT_BUDGET=standard and Code Mode is OFF', () => {
    const client = makeMockClient();
    const config = makeConfig({ OPENGROK_CONTEXT_BUDGET: 'standard' });
    const server = createServer(client as never, config);

    const internal = (server as unknown as ServerInternal)._registeredTools;
    // opengrok_search_code full description is the verbose form
    const desc = internal['opengrok_search_code']?.description ?? '';
    expect(desc).toContain('Full-text or symbol search across one or all OpenGrok projects');
  });

  it('uses full descriptions when OPENGROK_CONTEXT_BUDGET=generous and Code Mode is OFF', () => {
    const client = makeMockClient();
    const config = makeConfig({ OPENGROK_CONTEXT_BUDGET: 'generous' });
    const server = createServer(client as never, config);

    const internal = (server as unknown as ServerInternal)._registeredTools;
    const desc = internal['opengrok_search_code']?.description ?? '';
    expect(desc).toContain('Full-text or symbol search across one or all OpenGrok projects');
  });
});
