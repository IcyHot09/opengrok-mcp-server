/**
 * Sandbox integration tests — require a prior build.
 * Run with: npm run test:sandbox  (= npm run compile && vitest run src/tests/sandbox.test.ts)
 *
 * These tests use the compiled sandbox-worker.js (not the .ts source) because
 * Worker threads cannot load TypeScript sources directly (issue #10).
 */

import { describe, it, expect } from 'vitest';
import { executeInSandbox } from '../server/sandbox/index.js';
import type { SandboxAPI } from '../server/sandbox/index.js';

// ---------------------------------------------------------------------------
// Mock SandboxAPI
// ---------------------------------------------------------------------------

function makeMockApi(overrides: Partial<SandboxAPI> = {}): SandboxAPI {
  return {
    async search() { return { results: [{ path: 'test.cpp', project: 'myproject', matches: [{ lineNumber: 1, lineContent: 'void test() {}' }] }], totalCount: 1 }; },
    async batchSearch() { return [{ results: [{ path: 'a.cpp', project: 'p', matches: [{ lineNumber: 5, lineContent: 'x' }] }], totalCount: 1 }]; },
    async getFileContent() { return { content: '#include <test.h>', lineCount: 1, sizeBytes: 17 }; },
    async getSymbolContext() { return { found: false, symbol: 'test', kind: 'unknown', references: { totalFound: 0, samples: [] } }; },
    async getFileSymbols() { return { symbols: [] }; },
    async getFileHistory() { return { entries: [] }; },
    async getFileAnnotate() { return { lines: [] }; },
    async browseDir() { return { entries: [] }; },
    async findFile() { return { results: [] }; },
    async getFileOverview() { return {}; },
    async traceCallChain() { return { callers: [], callees: [] }; },
    async searchSuggest() { return { suggestions: [] }; },
    async getCompileInfo() { return null; },
    async indexHealth() { return { connected: true, latencyMs: 1, baseUrl: '' }; },
    async getFileDiff() { return {}; },
    async readMemory(filename: string) { return `content of ${filename}`; },
    async writeMemory() { return 'written'; },
    async elicit() { return { action: 'cancel' as const }; },
    async sample() { return null; },
    ...overrides,
  } as SandboxAPI;
}

const identity = (s: string) => s;
const BUDGET = 65536; // 64KB — generous for tests

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeInSandbox', () => {
  it('1. no return value → message prompting return statement', async () => {
    const result = await executeInSandbox('const x = 1;', makeMockApi(), identity, BUDGET);
    expect(result).toContain('no return value');
    expect(result).toContain('return statement');
  }, 15_000);

  it('2. return { a: 1 } → stringified JSON result', async () => {
    const result = await executeInSandbox('return { a: 1 };', makeMockApi(), identity, BUDGET);
    const parsed = JSON.parse(result);
    expect(parsed.a).toBe(1);
  }, 15_000);

  it('3. env.opengrok.search() is accessible and returns mock data', async () => {
    const code = `
      const r = env.opengrok.search("handleCrash", { searchType: "refs", maxResults: 5 });
      return r;
    `;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    const parsed = JSON.parse(result);
    expect(parsed.results[0].path).toBe('test.cpp');
  }, 15_000);

  it('4. env.opengrok.readMemory() returns mock string', async () => {
    const code = `return env.opengrok.readMemory('symbol-index.md');`;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    expect(result).toContain('symbol-index.md');
  }, 15_000);

  it('5. env.opengrok.batchSearch() result array is accessible', async () => {
    const code = `
      const results = env.opengrok.batchSearch([{query:'EventLoop',searchType:'defs'}]);
      return results[0].results[0].path;
    `;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    expect(result).toBe('a.cpp');
  }, 15_000);

  it('5b. flat search() global matches env.opengrok.search()', async () => {
    const code = `
      const r = search("handleCrash", { searchType: "refs", maxResults: 5 });
      return r;
    `;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    const parsed = JSON.parse(result);
    expect(parsed.results[0].path).toBe('test.cpp');
  }, 15_000);

  it('5c. flat + namespaced forms can mix in one execution', async () => {
    const code = `
      const a = search("x", {});
      const b = env.opengrok.readMemory('symbol-index.md');
      return (a.totalCount === 1 && b.includes('symbol-index.md')) ? 'mixed-ok' : 'mixed-fail';
    `;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    expect(result).toBe('mixed-ok');
  }, 15_000);

  it('6. infinite loop → timeout error message', async () => {
    // No QuickJS executionTimeout in the worker (wall-clock interrupt corrupts
    // pooled heaps) — infinite loops are caught by the hardTimeout kill.
    // Use a short hardTimeout so the test stays fast (default is 62s).
    const result = await executeInSandbox('while(true){}', makeMockApi(), identity, BUDGET, undefined, {
      hardTimeout: 5_000,
    });
    expect(result).toMatch(/timed? ?out|timeout/i);
    expect(result.toLowerCase()).toContain('error');
  }, 10_000);

  it('7. syntax error → error message with description', async () => {
    const result = await executeInSandbox('const x = }{{{;', makeMockApi(), identity, BUDGET);
    expect(result).toMatch(/error/i);
    expect(result.length).toBeGreaterThan(5);
  }, 15_000);

  it('8. process is not available in sandbox (undefined or error)', async () => {
    const code = `
      try {
        return typeof process === 'undefined' ? 'undefined' : String(process.version);
      } catch (e) {
        return 'error: ' + e.message;
      }
    `;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    // Either process is undefined or accessing it throws
    expect(result === 'undefined' || result.toLowerCase().includes('error') || result.toLowerCase().includes('not')).toBe(true);
  }, 15_000);

  it('9. require("fs") fails in sandbox', async () => {
    const code = `
      try {
        const fs = require('fs');
        return 'got fs';
      } catch (e) {
        return 'error: ' + e.message;
      }
    `;
    const result = await executeInSandbox(code, makeMockApi(), identity, BUDGET);
    // require should not be available or should fail
    expect(result).not.toBe('got fs');
  }, 15_000);

  it('10. capFn is applied to the result', async () => {
    const tiny = (s: string) => s.slice(0, 5); // truncate to 5 chars
    const result = await executeInSandbox(
      'return { message: "hello world this is a long result" };',
      makeMockApi(),
      tiny,
      BUDGET
    );
    // capFn truncates to 5 chars
    expect(result.length).toBeLessThanOrEqual(5);
  }, 15_000);

  it('11. return 42 produces string "42"', async () => {
    const result = await executeInSandbox('return 42;', makeMockApi(), identity, BUDGET);
    expect(result).toBe('42');
  }, 15_000);
});
