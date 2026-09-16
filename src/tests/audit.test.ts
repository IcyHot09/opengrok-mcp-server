import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  auditLog,
  configureAuditLog,
  exportAuditLogAsCSV,
  exportAuditLogAsJSON,
  getAuditWriteQueue,
  resetDroppedAuditEventCount,
} from '../server/transport/audit.js';

describe('auditLog', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    // Reset audit log file configuration before each test
    configureAuditLog(undefined);
  });

  afterEach(() => {
    configureAuditLog(undefined);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('writes JSON to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search', project: 'myrepo' });
    expect(spy).toHaveBeenCalled();
    const written = String(spy.mock.calls[0][0]);
    expect(written).toContain('"tool_invoke"');
    expect(written).toContain('"opengrok_search"');
    spy.mockRestore();
  });

  it('includes audit:true and ts fields', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search' });
    const written = String(spy.mock.calls[0][0]);
    const entry = JSON.parse(written.trim());
    expect(entry.audit).toBe(true);
    expect(typeof entry.ts).toBe('string');
    spy.mockRestore();
  });

  it('caps detail field at 200 chars', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', detail: 'x'.repeat(300) });
    const written = String(spy.mock.calls[0][0]);
    const entry = JSON.parse(written.trim());
    expect(entry.detail.length).toBeLessThanOrEqual(200);
    spy.mockRestore();
  });

  it('caps tool field at 200 chars', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: 'x'.repeat(300) });
    const written = String(spy.mock.calls[0][0]);
    const entry = JSON.parse(written.trim());
    expect(entry.tool.length).toBeLessThanOrEqual(200);
    spy.mockRestore();
  });

  it('escapes newlines in string fields (single-line JSON)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', detail: 'line1\nline2' });
    const written = String(spy.mock.calls[0][0]);
    // Should be valid single-line JSON (the written string ends with \n but
    // the JSON content itself should not contain unescaped newlines)
    const jsonPart = written.trim();
    const lines = jsonPart.split('\n');
    expect(lines.length).toBe(1);
    spy.mockRestore();
  });

  it('omits optional fields when not provided', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'config_load' });
    const written = String(spy.mock.calls[0][0]);
    const entry = JSON.parse(written.trim());
    expect(entry.tool).toBeUndefined();
    expect(entry.project).toBeUndefined();
    expect(entry.detail).toBeUndefined();
    spy.mockRestore();
  });

  it('writes to file when configureAuditLog is set', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'config_load' });
    spy.mockRestore();
    await getAuditWriteQueue();
    expect(fs.existsSync(tmpFile)).toBe(true);
    const content = fs.readFileSync(tmpFile, 'utf8');
    expect(content).toContain('config_load');
  });

  it('writes both to stderr and file when file is configured', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'auth_used' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    await getAuditWriteQueue();
    const content = fs.readFileSync(tmpFile, 'utf8');
    expect(content).toContain('auth_used');
  });

  it('does not write to file when configureAuditLog is not set', () => {
    // file should not be created
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'rate_limited' });
    spy.mockRestore();
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('exportAuditLogAsCSV sanitizes formula-injection characters in fields', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: '=cmd|/C calc', project: 'p1' });
    spy.mockRestore();
    await getAuditWriteQueue();
    const csv = exportAuditLogAsCSV(tmpFile);
    // Fields starting with '=' should be prefixed with ' to prevent formula injection
    expect(csv).toContain("'=cmd");
  });

  it('exportAuditLogAsCSV round-trips to CSV', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search', project: 'p1', detail: 'test' });
    spy.mockRestore();
    await getAuditWriteQueue();
    const csv = exportAuditLogAsCSV(tmpFile);
    expect(csv).toContain('tool_invoke');
    expect(csv).toContain('opengrok_search');
    // First line should be the header
    expect(csv.split('\n')[0]).toContain('timestamp');
  });

  it('exportAuditLogAsCSV header contains all expected columns', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'config_load' });
    spy.mockRestore();
    await getAuditWriteQueue();
    const csv = exportAuditLogAsCSV(tmpFile);
    const header = csv.split('\n')[0];
    expect(header).toContain('type');
    expect(header).toContain('tool');
    expect(header).toContain('project');
    expect(header).toContain('detail');
  });

  it('exportAuditLogAsJSON returns parseable array', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'sandbox_exec', tool: 'opengrok_execute' });
    spy.mockRestore();
    await getAuditWriteQueue();
    const json = exportAuditLogAsJSON(tmpFile);
    const arr = JSON.parse(json);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    expect(arr[0].type).toBe('sandbox_exec');
  });

  it('exportAuditLogAsJSON multiple entries', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search' });
    auditLog({ type: 'config_load' });
    spy.mockRestore();
    await getAuditWriteQueue();
    const json = exportAuditLogAsJSON(tmpFile);
    const arr = JSON.parse(json);
    expect(arr.length).toBe(2);
  });

  it('exportAuditLogAsCSV throws for missing file', () => {
    expect(() => exportAuditLogAsCSV('/nonexistent/file.jsonl')).toThrow(/not found/i);
  });

  it('exportAuditLogAsJSON throws for missing file', () => {
    expect(() => exportAuditLogAsJSON('/nonexistent/file.jsonl')).toThrow(/not found/i);
  });

  it('handles elicitation_request event type', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'elicitation_request', detail: 'project picker shown' });
    const written = String(spy.mock.calls[0][0]);
    const entry = JSON.parse(written.trim());
    expect(entry.type).toBe('elicitation_request');
    spy.mockRestore();
  });

  it('handles elicitation_unsupported event type', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'elicitation_unsupported' });
    const written = String(spy.mock.calls[0][0]);
    const entry = JSON.parse(written.trim());
    expect(entry.type).toBe('elicitation_unsupported');
    spy.mockRestore();
  });

  it('appends multiple entries to file', async () => {
    configureAuditLog(tmpFile);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search' });
    auditLog({ type: 'rate_limited', tool: 'opengrok_search' });
    spy.mockRestore();
    await getAuditWriteQueue();
    const content = fs.readFileSync(tmpFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
  });
});
