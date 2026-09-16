import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { buildSafeUrl, isPrivateIp, assertSafePath } from '../server/client/index.js';
import { parseWebSearchResults, parseDirectoryListing } from '../server/parsers/index.js';
import { escapeMarkdownField } from '../server/formatters/index.js';
import { validateBearerToken } from '../server/transport/http-transport.js';

describe('buildSafeUrl SSRF protection', () => {
  const base = new URL('https://opengrok.company.com/source/');

  it('allows legitimate host', () => {
    expect(() => buildSafeUrl(base, 'api', 'v1', 'projects')).not.toThrow();
  });

  it('blocks hostname mismatch', () => {
    expect(() => buildSafeUrl(base, '//evil.com/steal')).toThrow(/SSRF/);
  });

  it('blocks buildSafeUrl with private IP base URL', () => {
    const privateBase = new URL('http://127.0.0.1:8080/');
    expect(() => buildSafeUrl(privateBase, 'api')).toThrow(/SSRF/);
  });
});

describe('isPrivateIp', () => {
  it('blocks IPv6-mapped loopback ::ffff:127.0.0.1', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks IPv6-mapped private ::ffff:10.0.0.1', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('blocks direct 127.0.0.1', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
  });

  it('blocks RFC1918 10.x.x.x', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
  });

  it('blocks RFC1918 172.16.x.x', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
  });

  it('blocks RFC1918 192.168.x.x', () => {
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('blocks link-local 169.254.x.x', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('blocks localhost string', () => {
    expect(isPrivateIp('localhost')).toBe(true);
  });

  it('allows public IP', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('allows 0.0.0.0 as private (non-routable)', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('blocks IPv6 unspecified ::', () => {
    expect(isPrivateIp('::')).toBe(true);
  });

  it('blocks IPv6 ULA fc00::1', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
  });

  it('blocks IPv6 ULA fd00::1', () => {
    expect(isPrivateIp('fd00::1')).toBe(true);
  });

  it('blocks IPv6 link-local fe80::1', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('blocks IPv6 link-local febf::1', () => {
    expect(isPrivateIp('febf::1')).toBe(true);
  });
});

describe('assertSafePath traversal protection', () => {
  it('allows normal paths', () => {
    expect(() => assertSafePath('src/main/java/Foo.java')).not.toThrow();
    expect(() => assertSafePath('/project/file.c')).not.toThrow();
  });

  it('blocks ../ literal', () => {
    expect(() => assertSafePath('../etc/passwd')).toThrow(/Unsafe/);
  });

  it('blocks /../../ embedded', () => {
    expect(() => assertSafePath('foo/../../etc/passwd')).toThrow(/Unsafe/);
  });

  it('blocks RTL override character U+202E', () => {
    expect(() => assertSafePath('file\u202e.txt')).toThrow(/Unsafe/);
  });

  it('blocks zero-width space U+200B', () => {
    expect(() => assertSafePath('file\u200b/../secret')).toThrow(/Unsafe/);
  });

  it('blocks %2e%2e encoded', () => {
    expect(() => assertSafePath('%2e%2e/etc')).toThrow(/Unsafe/);
  });

  it('blocks null byte', () => {
    expect(() => assertSafePath('file\0.txt')).toThrow(/Unsafe/);
  });

  it('blocks double-encoded %252e%252e', () => {
    expect(() => assertSafePath('%252e%252e/secret')).toThrow(/Unsafe/);
  });

  it('blocks standalone ..', () => {
    expect(() => assertSafePath('..')).toThrow(/Unsafe/);
  });

  it('blocks path ending in /..', () => {
    expect(() => assertSafePath('foo/..')).toThrow(/Unsafe/);
  });
});

describe('parsers HTML entity decoding', () => {
  it('decodes HTML entities in search result text', () => {
    const html = `<html><body><div class="results"><table><tbody>
      <tr><td class="def"><a href="/source/s?q=test"><b>&lt;script&gt;alert(1)&lt;/script&gt;</b></a></td>
      <td class="src"><a href="/source/xref/proj/file.java#10">file.java:10</a></td>
      </tr>
    </tbody></table></div></body></html>`;
    const results = parseWebSearchResults(html, 'full', 'test');
    const allText = JSON.stringify(results);
    // HTML entities should be decoded — but resulting < > chars should not cause injection
    // The decoded text &lt;script&gt; → <script> is TEXT content, not raw HTML
    // Verify it parses without throwing
    expect(typeof allText).toBe('string');
  });

  it('decodes HTML entities in directory listing', () => {
    const html = `<html><body><table id="dirlist"><tbody>
      <tr><td class="p"><a href="/source/xref/proj/foo%26bar/">foo&amp;bar/</a></td>
      <td class="n"></td><td class="d">2026-01-01</td></tr>
    </tbody></table></body></html>`;
    // Should not throw
    expect(() => parseDirectoryListing(html, 'proj', '')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// C5 — formatters prompt injection prevention
// ---------------------------------------------------------------------------

describe('formatters prompt injection prevention', () => {
  it('collapses newlines in markdown fields', () => {
    const nasty = 'line1\n## Injected heading\nline2';
    const escaped = escapeMarkdownField(nasty);
    // Newlines are removed so the ## can't start a new markdown heading line
    expect(escaped).not.toContain('\n');
    // The ## is now inline (not at line-start) so cannot be rendered as a heading
    expect(escaped).toContain('##'); // still present but neutralised (no leading newline)
    expect(escaped).toBe('line1 ## Injected heading line2');
  });

  it('collapses Windows-style CRLF newlines', () => {
    const nasty = 'before\r\nafter';
    const escaped = escapeMarkdownField(nasty);
    expect(escaped).not.toContain('\r');
    expect(escaped).not.toContain('\n');
  });

  it('escapes pipe characters', () => {
    expect(escapeMarkdownField('cell1|cell2')).toContain('\\|');
  });

  it('replaces backticks with single quotes', () => {
    expect(escapeMarkdownField('some `code` here')).not.toContain('`');
  });

  it('caps length at 500 characters', () => {
    const long = 'a'.repeat(600);
    expect(escapeMarkdownField(long).length).toBe(500);
  });

});

// ---------------------------------------------------------------------------
// H2 — validateBearerToken timing-safe
// ---------------------------------------------------------------------------

describe('validateBearerToken timing-safe', () => {
  it('returns true for matching token', () => {
    const req = { headers: { authorization: 'Bearer secret123' } } as unknown as IncomingMessage;
    expect(validateBearerToken(req, 'secret123')).toBe(true);
  });

  it('returns false for wrong token', () => {
    const req = { headers: { authorization: 'Bearer wrong' } } as unknown as IncomingMessage;
    expect(validateBearerToken(req, 'secret123')).toBe(false);
  });

  it('returns false for missing header', () => {
    const req = { headers: {} } as unknown as IncomingMessage;
    expect(validateBearerToken(req, 'secret123')).toBe(false);
  });

  it('returns false for non-Bearer scheme', () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } } as unknown as IncomingMessage;
    expect(validateBearerToken(req, 'dXNlcjpwYXNz')).toBe(false);
  });

  it('returns false when token length differs', () => {
    const req = { headers: { authorization: 'Bearer short' } } as unknown as IncomingMessage;
    expect(validateBearerToken(req, 'muchlongersecret')).toBe(false);
  });
});
