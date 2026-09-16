/**
 * Tests for Task 4.10 (sandbox error sanitization) and Task 4.11 (audit logging).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sanitizeSandboxError } from '../server/sandbox/index.js';
import { auditLog, configureAuditLog, exportAuditLogAsCSV, exportAuditLogAsJSON, getAuditWriteQueue } from '../server/transport/audit.js';

// ---------------------------------------------------------------------------
// Task 4.10 — sanitizeSandboxError
// ---------------------------------------------------------------------------

describe('sanitizeSandboxError', () => {
  it('preserves short, meaningful error messages unchanged', () => {
    const msg = 'ReferenceError: foo is not defined';
    expect(sanitizeSandboxError(msg)).toBe(msg);
  });

  it('strips absolute Unix paths', () => {
    const result = sanitizeSandboxError('Cannot find module /home/user/project/node_modules/foo');
    expect(result).not.toContain('/home/user');
    expect(result).toContain('<path>');
    expect(result).toContain('Cannot find module');
  });

  it('strips stack trace lines (lines starting with "    at ")', () => {
    const error = new Error('Something went wrong');
    error.stack = `Error: Something went wrong\n    at Object.<anonymous> (/home/user/server/sandbox.ts:123:5)\n    at Module._resolveFilename (node:internal/modules/cjs/loader.js:902:15)`;
    const result = sanitizeSandboxError(error);
    expect(result).not.toMatch(/^\s+at /m);
    expect(result).toContain('Something went wrong');
  });

  it('strips node:internal module paths', () => {
    const msg = 'Error in node:internal/modules/cjs/loader.js at line 902';
    const result = sanitizeSandboxError(msg);
    expect(result).not.toContain('node:internal/modules');
    expect(result).toContain('<node-internal>');
  });

  it('handles plain Error objects', () => {
    const err = new Error('Execution failed: out of memory');
    const result = sanitizeSandboxError(err);
    expect(result).toContain('Execution failed');
    expect(result).toContain('out of memory');
  });

  it('handles unknown/null/undefined gracefully', () => {
    expect(sanitizeSandboxError(null)).toBe('Unknown sandbox error');
    expect(sanitizeSandboxError(undefined)).toBe('Unknown sandbox error');
  });

  it('handles object with message property (QuickJS-style error)', () => {
    const quickJsErr = { name: 'SyntaxError', message: 'Unexpected token }' };
    const result = sanitizeSandboxError(quickJsErr);
    expect(result).toContain('Unexpected token');
  });

  it('truncates result to 500 chars maximum', () => {
    const longMsg = 'x'.repeat(1000);
    expect(sanitizeSandboxError(longMsg).length).toBeLessThanOrEqual(500);
  });

  it('strips Windows absolute paths', () => {
    const msg = 'Cannot find C:\\Users\\user\\project\\main.js';
    const result = sanitizeSandboxError(msg);
    expect(result).not.toContain('C:\\Users\\user');
    expect(result).toContain('<path>');
  });

  it('strips /etc and /proc paths', () => {
    expect(sanitizeSandboxError('/etc/passwd')).toContain('<path>');
    expect(sanitizeSandboxError('read /proc/self/maps failed')).toContain('<path>');
  });

  it('strips relative traversal paths', () => {
    expect(sanitizeSandboxError('../../etc/passwd')).toContain('<path>');
  });

  it('strips Windows AppData and UNC paths', () => {
    expect(sanitizeSandboxError('Cannot open C:\\AppData\\Local\\secret')).toContain('<path>');
    expect(sanitizeSandboxError('\\\\server\\share\\secret')).toContain('<path>');
  });

  it('keeps multi-line errors after stripping stack frames', () => {
    const msg = 'TypeError: Cannot read properties of undefined\n    at doThing (/home/user/src/foo.js:10:5)\n    at main (/home/user/src/bar.js:20:1)';
    const result = sanitizeSandboxError(msg);
    expect(result).toContain('TypeError');
    expect(result).not.toMatch(/at doThing/);
    expect(result).not.toMatch(/at main/);
  });
});

// ---------------------------------------------------------------------------
// Task 4.11 — auditLog
// ---------------------------------------------------------------------------

describe('auditLog', () => {
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  afterEach(() => {
    stderrSpy.mockClear();
  });

  it('writes a newline-delimited JSON entry to stderr', () => {
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search_code' });
    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('tool_invoke');
    expect(parsed.tool).toBe('opengrok_search_code');
  });

  it('includes ISO timestamp', () => {
    auditLog({ type: 'sandbox_exec' });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.audit).toBe(true);
  });

  it('includes optional project and detail fields', () => {
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search_code', project: 'myproject', detail: 'search query' });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.project).toBe('myproject');
    expect(parsed.detail).toBe('search query');
  });

  it('caps detail at 200 chars to prevent log injection', () => {
    const longDetail = 'a'.repeat(300);
    auditLog({ type: 'rate_limited', detail: longDetail });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.detail.length).toBeLessThanOrEqual(200);
  });

  it('omits undefined optional fields from output', () => {
    auditLog({ type: 'config_load' });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect('tool' in parsed).toBe(false);
    expect('project' in parsed).toBe(false);
    expect('detail' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exportAuditLogAsCSV / exportAuditLogAsJSON
// ---------------------------------------------------------------------------

describe('exportAuditLogAsCSV', () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    configureAuditLog(undefined);
  });

  it('throws when file does not exist', () => {
    expect(() => exportAuditLogAsCSV('/nonexistent/path/audit.log')).toThrow('Audit log file not found');
  });

  it('returns CSV header + rows from a log file', () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    fs.writeFileSync(tmpFile,
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'tool_invoke', tool: 'opengrok_search_code', project: 'myproj', detail: 'query' }) + '\n' +
      JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', type: 'config_load' }) + '\n'
    );
    const csv = exportAuditLogAsCSV(tmpFile);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('timestamp,type,tool,project,detail');
    expect(lines[1]).toContain('tool_invoke');
    expect(lines[1]).toContain('opengrok_search_code');
    expect(lines[2]).toContain('config_load');
  });

  it('skips malformed JSON lines without throwing', () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    fs.writeFileSync(tmpFile, 'NOT_JSON\n' + JSON.stringify({ ts: 'x', type: 'config_load' }) + '\n');
    const csv = exportAuditLogAsCSV(tmpFile);
    const lines = csv.split('\n');
    expect(lines.length).toBe(2); // header + 1 valid row
  });


  it('handles entries with missing ts and type fields in CSV (covers ?? "" branches)', () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    // Entry with no ts, no type, no tool, no project, no detail
    fs.writeFileSync(tmpFile, JSON.stringify({}) + '\n');
    const csv = exportAuditLogAsCSV(tmpFile);
    const lines = csv.split('\n');
    // Should have header + 1 data row with all empty-string fields
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe('"","","","",""');
  });
  it('escapes double-quotes in field values', () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    fs.writeFileSync(tmpFile, JSON.stringify({ ts: 'x', type: 'tool_invoke', detail: 'say "hello"' }) + '\n');
    const csv = exportAuditLogAsCSV(tmpFile);
    expect(csv).toContain('say ""hello""');
  });
});

describe('exportAuditLogAsJSON', () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    configureAuditLog(undefined);
  });

  it('throws when file does not exist', () => {
    expect(() => exportAuditLogAsJSON('/nonexistent/path/audit.log')).toThrow('Audit log file not found');
  });

  it('returns JSON array from log file', () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    fs.writeFileSync(tmpFile,
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'tool_invoke' }) + '\n' +
      JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', type: 'config_load' }) + '\n'
    );
    const json = exportAuditLogAsJSON(tmpFile);
    const entries = JSON.parse(json);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('tool_invoke');
    expect(entries[1].type).toBe('config_load');
  });

  it('skips malformed JSON lines without throwing', () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    fs.writeFileSync(tmpFile, 'NOT_JSON\n' + JSON.stringify({ type: 'config_load' }) + '\n');
    const json = exportAuditLogAsJSON(tmpFile);
    const entries = JSON.parse(json);
    expect(entries).toHaveLength(1);
  });
});

describe('auditLog with file output', () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    configureAuditLog(undefined);
  });

  it('appends to file when configureAuditLog is set', async () => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
    configureAuditLog(tmpFile);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'config_load' });
    vi.restoreAllMocks();
    await getAuditWriteQueue();
    const contents = fs.readFileSync(tmpFile, 'utf-8');
    const parsed = JSON.parse(contents.trim());
    expect(parsed.type).toBe('config_load');
  });
});
