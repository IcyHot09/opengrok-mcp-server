/**
 * Live-dispatcher regression tests — NO fetch mocks.
 *
 * Guards against undici cross-version dispatcher breakage: the client must
 * call fetch from the same undici package that provides its Agent, because
 * the Node.js global fetch (older bundled undici) rejects foreign dispatchers
 * with a bare "TypeError: fetch failed". Mocked-fetch suites cannot catch
 * this — only a real HTTP round-trip through the real dispatcher can.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { OpenGrokClient } from '../server/client/index.js';
import type { Config } from '../server/config.js';

// Bypass the SSRF guard for localhost only: the guard itself is covered by
// unit tests; here we need a real loopback round-trip to prove the real
// undici dispatcher works end to end.
vi.mock('../server/client/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/client/security.js')>();
  return {
    ...actual,
    buildSafeUrl: (baseUrl: URL, ...segments: string[]) =>
      new URL(segments.join('/'), baseUrl),
    isSafeRedirect: () => true,
  };
});

let server: http.Server;
let baseUrl: string;

function makeConfig(): Config {
  return {
    OPENGROK_BASE_URL: baseUrl,
    OPENGROK_USERNAME: '',
    OPENGROK_PASSWORD: '',
    OPENGROK_PASSWORD_FILE: '',
    OPENGROK_PASSWORD_KEY: '',
    OPENGROK_VERIFY_SSL: false,
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
  } as Config;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/source/api/v1/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ name: 'release-2.x' }]));
    } else if (url.pathname === '/source/api/v1/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        resultCount: 1,
        results: { '/release-2.x/file.cpp': [{ lineNumber: 5, line: 'match' }] },
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><select id="project"><option value="release-2.x">release-2.x</option></select></body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/source/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('live dispatcher (no mocks)', () => {
  it('testConnection reaches a real server through the configured dispatcher', async () => {
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(true);
  }, 15_000);

  it('listProjects round-trips through the configured dispatcher', async () => {
    const client = new OpenGrokClient(makeConfig());
    const projects = await client.listProjects();
    expect(projects.map((p) => p.name)).toContain('release-2.x');
  }, 15_000);

  it('search round-trips through dispatcher + retry wrapper', async () => {
    const client = new OpenGrokClient(makeConfig());
    const result = await client.search('match', 'full', ['release-2.x']);
    expect(result.totalCount).toBe(1);
    expect(result.results[0].path).toContain('file.cpp');
  }, 15_000);
});
