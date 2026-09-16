import { describe, it, expect } from 'vitest';
import { parseProjectsFromHtml } from '../../shared/html-parsers.js';

describe('parseProjectsFromHtml', () => {
  it('parses select#project options', () => {
    const html = `
      <html><body>
        <select id="project">
          <option value="alpha">alpha</option>
          <option value="beta">beta</option>
          <option value="alpha">alpha duplicate</option>
        </select>
      </body></html>`;
    expect(parseProjectsFromHtml(html)).toEqual(['alpha', 'beta']);
  });

  it('parses select name=project as fallback', () => {
    const html = `<select name="project"><option value="one">one</option></select>`;
    expect(parseProjectsFromHtml(html)).toEqual(['one']);
  });

  it('falls back to /xref/ links when no select', () => {
    const html = `
      <html><body>
        <a href="/source/xref/projA/">projA</a>
        <a href="/source/xref/projB">projB</a>
        <a href="/source/xref/projA/">duplicate</a>
      </body></html>`;
    expect(parseProjectsFromHtml(html)).toEqual(['projA', 'projB']);
  });

  it('prefers select options over xref links when both present', () => {
    const html = `
      <select id="project"><option value="fromSelect">x</option></select>
      <a href="/source/xref/fromLink/">y</a>`;
    expect(parseProjectsFromHtml(html)).toEqual(['fromSelect']);
  });

  it('returns empty when no projects found', () => {
    expect(parseProjectsFromHtml('<html><body><p>no projects</p></body></html>')).toEqual([]);
    expect(parseProjectsFromHtml('')).toEqual([]);
  });
});
