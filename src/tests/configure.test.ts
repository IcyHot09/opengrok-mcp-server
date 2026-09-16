import { describe, it, expect } from 'vitest';
import { buildEnv } from '../server/cli/setup/configure.js';
import type { McpConfig } from '../server/cli/setup/configure.js';

describe('buildEnv()', () => {
  it('sets OPENGROK_BASE_URL always', () => {
    const env = buildEnv({ url: 'https://og.example.com/' });
    expect(env['OPENGROK_BASE_URL']).toBe('https://og.example.com/');
  });

  it('omits OPENGROK_ENABLE_FILES_API when false (default)', () => {

    const env = buildEnv({ url: 'https://og.example.com/', enableFilesApi: false });
    expect(env).not.toHaveProperty('OPENGROK_ENABLE_FILES_API');
  });

  it('sets OPENGROK_ENABLE_FILES_API=true when true', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableFilesApi: true });
    expect(env['OPENGROK_ENABLE_FILES_API']).toBe('true');
  });

  it('sets OPENGROK_SAMPLING_MODEL when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingModel: 'claude-sonnet-4-6' });
    expect(env['OPENGROK_SAMPLING_MODEL']).toBe('claude-sonnet-4-6');
  });

  it('omits OPENGROK_SAMPLING_MODEL when blank', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingModel: '' });
    expect(env).not.toHaveProperty('OPENGROK_SAMPLING_MODEL');
  });

  it('omits OPENGROK_SAMPLING_MAX_TOKENS at default value 256', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingMaxTokens: '256' });
    expect(env).not.toHaveProperty('OPENGROK_SAMPLING_MAX_TOKENS');
  });

  it('sets OPENGROK_SAMPLING_MAX_TOKENS when non-default', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingMaxTokens: '512' });
    expect(env['OPENGROK_SAMPLING_MAX_TOKENS']).toBe('512');
  });

  it('sets OPENGROK_AUDIT_LOG_FILE when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', auditLogFile: '/var/log/audit.json' });
    expect(env['OPENGROK_AUDIT_LOG_FILE']).toBe('/var/log/audit.json');
  });

  it('omits OPENGROK_RATELIMIT_RPM at default value 60', () => {
    const env = buildEnv({ url: 'https://og.example.com/', rateLimitRpm: '60' });
    expect(env).not.toHaveProperty('OPENGROK_RATELIMIT_RPM');
  });

  it('sets OPENGROK_RATELIMIT_RPM when non-default', () => {
    const env = buildEnv({ url: 'https://og.example.com/', rateLimitRpm: '30' });
    expect(env['OPENGROK_RATELIMIT_RPM']).toBe('30');
  });

  it('compile-time: McpConfig accepts all new fields', () => {
    const config: McpConfig = {
      url: 'https://og.example.com/',
      enableFilesApi: true,
      samplingModel: 'claude-haiku-4-5-20251001',
      samplingMaxTokens: '128',
      auditLogFile: '/tmp/audit.csv',
      rateLimitRpm: '120',
      passwordFile: '/run/secrets/opengrok-password',
      maxResponseBytes: '8192',
      strictSsrf: true,
      jwtIssuer: 'https://idp.example.com/',
      grammarDir: '/opt/grammars',
    };
    expect(config.url).toBeTruthy();
  });

  it('sets OPENGROK_PASSWORD_FILE when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', passwordFile: '/run/secrets/pw' });
    expect(env['OPENGROK_PASSWORD_FILE']).toBe('/run/secrets/pw');
  });

  it('omits OPENGROK_PASSWORD_FILE when blank', () => {
    const env = buildEnv({ url: 'https://og.example.com/', passwordFile: '' });
    expect(env).not.toHaveProperty('OPENGROK_PASSWORD_FILE');
  });

  it('omits OPENGROK_MAX_RESPONSE_BYTES at default value 0', () => {
    const env = buildEnv({ url: 'https://og.example.com/', maxResponseBytes: '0' });
    expect(env).not.toHaveProperty('OPENGROK_MAX_RESPONSE_BYTES');
  });

  it('sets OPENGROK_MAX_RESPONSE_BYTES when non-default', () => {
    const env = buildEnv({ url: 'https://og.example.com/', maxResponseBytes: '8192' });
    expect(env['OPENGROK_MAX_RESPONSE_BYTES']).toBe('8192');
  });

  it('omits OPENGROK_STRICT_SSRF when false (default)', () => {
    const env = buildEnv({ url: 'https://og.example.com/', strictSsrf: false });
    expect(env).not.toHaveProperty('OPENGROK_STRICT_SSRF');
  });

  it('sets OPENGROK_STRICT_SSRF=true when true', () => {
    const env = buildEnv({ url: 'https://og.example.com/', strictSsrf: true });
    expect(env['OPENGROK_STRICT_SSRF']).toBe('true');
  });

  it('sets OPENGROK_JWT_ISSUER when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', jwtIssuer: 'https://idp.example.com/' });
    expect(env['OPENGROK_JWT_ISSUER']).toBe('https://idp.example.com/');
  });

  it('omits OPENGROK_JWT_ISSUER when blank', () => {
    const env = buildEnv({ url: 'https://og.example.com/', jwtIssuer: '' });
    expect(env).not.toHaveProperty('OPENGROK_JWT_ISSUER');
  });

  it('sets OPENGROK_ENABLE_MEMORY_TOOLS=true when true (default off)', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableMemoryTools: true });
    expect(env['OPENGROK_ENABLE_MEMORY_TOOLS']).toBe('true');
  });

  it('omits OPENGROK_ENABLE_MEMORY_TOOLS when false (default)', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableMemoryTools: false });
    expect(env).not.toHaveProperty('OPENGROK_ENABLE_MEMORY_TOOLS');
  });

  it('sets OPENGROK_ENABLE_ELICITATION=false when false (default on)', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableElicitation: false });
    expect(env['OPENGROK_ENABLE_ELICITATION']).toBe('false');
  });

  it('omits OPENGROK_ENABLE_ELICITATION when true (default)', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableElicitation: true });
    expect(env).not.toHaveProperty('OPENGROK_ENABLE_ELICITATION');
  });

  it('sets OPENGROK_GRAMMAR_DIR when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', grammarDir: '/opt/grammars' });
    expect(env['OPENGROK_GRAMMAR_DIR']).toBe('/opt/grammars');
  });

  it('omits OPENGROK_GRAMMAR_DIR when blank', () => {
    const env = buildEnv({ url: 'https://og.example.com/', grammarDir: '' });
    expect(env).not.toHaveProperty('OPENGROK_GRAMMAR_DIR');
  });
});
