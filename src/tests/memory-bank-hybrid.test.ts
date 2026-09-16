import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryBank } from '../server/memory/memory-bank.js';

describe('MemoryBank.getStatusLine()', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-test-'));
    bank = new MemoryBank(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "[Memory] No prior context." when no files exist', async () => {
    const status = await bank.getStatusLine();
    expect(status).toBe('[Memory] No prior context.');
  });

  it('returns "[Memory] No prior context." when both files are stubs', async () => {
    // Write stub files (they contain the sentinel prefix)
    fs.writeFileSync(path.join(tmpDir, 'active-task.md'), '<!-- OPENGROK_STUB:active-task.md -->\ntask: (none)\n');
    fs.writeFileSync(path.join(tmpDir, 'investigation-log.md'), '<!-- OPENGROK_STUB:investigation-log.md -->\n# Investigation Log\n');
    const status = await bank.getStatusLine();
    expect(status).toBe('[Memory] No prior context.');
  });

  it('includes active-task.md summary when file has real content', async () => {
    const content = 'task: Investigate auth module\nstarted: 2026-03-30T10:00:00Z\n';
    fs.writeFileSync(path.join(tmpDir, 'active-task.md'), content);
    const status = await bank.getStatusLine();
    expect(status).toContain('[Memory]');
    expect(status).toContain('active-task.md');
    expect(status).toContain('Investigate auth module');
  });

  it('includes investigation-log.md entry count', async () => {
    const log = '# Investigation Log\n## 2026-03-30 10:00: Topic A\ncontent\n## 2026-03-30 11:00: Topic B\ncontent\n';
    fs.writeFileSync(path.join(tmpDir, 'investigation-log.md'), log);
    const status = await bank.getStatusLine();
    expect(status).toContain('investigation-log.md');
    expect(status).toContain('2 entries');
  });

  it('returns status under 500 chars (≤80 tokens)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'active-task.md'), 'task: A very long task name that exceeds sixty characters but will be truncated\nstatus: idle\n');
    const status = await bank.getStatusLine();
    expect(status.length).toBeLessThanOrEqual(500);
  });
});

describe('MemoryBank migrate() method does not exist', () => {
  it('MemoryBank has no migrate method', () => {
    const bank = new MemoryBank('/tmp/test');
    expect((bank as any).migrate).toBeUndefined();
  });
});
