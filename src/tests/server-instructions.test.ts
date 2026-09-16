import { describe, it, expect } from 'vitest';

describe('SERVER_INSTRUCTIONS token budget', () => {
  it('standard template is ≤1600 chars (≈320 tokens)', async () => {
    const { SERVER_INSTRUCTIONS_TEMPLATE } = await import('../server/server.js');
    const filled = SERVER_INSTRUCTIONS_TEMPLATE.replace('{{MEMORY_STATUS}}', '[Memory] No prior context.');
    expect(filled.length).toBeLessThanOrEqual(1600);
  });

  it('code mode template is ≤800 chars (≈160 tokens)', async () => {
    const { SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE } = await import('../server/server.js');
    const filled = SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE.replace('{{MEMORY_STATUS}}', '[Memory] No prior context.');
    expect(filled.length).toBeLessThanOrEqual(1800);
  });

  it('template contains {{MEMORY_STATUS}} placeholder', async () => {
    const { SERVER_INSTRUCTIONS_TEMPLATE } = await import('../server/server.js');
    expect(SERVER_INSTRUCTIONS_TEMPLATE).toContain('{{MEMORY_STATUS}}');
  });

  it('no 3-step SESSION STARTUP sequence in template', async () => {
    const { SERVER_INSTRUCTIONS_TEMPLATE } = await import('../server/server.js');
    expect(SERVER_INSTRUCTIONS_TEMPLATE).not.toContain('Step 1');
    expect(SERVER_INSTRUCTIONS_TEMPLATE).not.toContain('Step 2');
    expect(SERVER_INSTRUCTIONS_TEMPLATE).not.toContain('Step 3');
  });
});

describe('TOOL_REGISTRATION_ORDER', () => {
  it('contains 26 tool names', async () => {
    const { TOOL_REGISTRATION_ORDER } = await import('../server/server.js');
    expect(TOOL_REGISTRATION_ORDER.length).toBeGreaterThanOrEqual(20);
  });

  it('all names start with opengrok_', async () => {
    const { TOOL_REGISTRATION_ORDER } = await import('../server/server.js');
    for (const name of TOOL_REGISTRATION_ORDER) {
      expect(name).toMatch(/^opengrok_/);
    }
  });
});
