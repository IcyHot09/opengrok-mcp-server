/**
 * Additional parser tests covering uncovered branches:
 * - parseAnnotate table-based fallback (no annotate divs, use table)
 * - parseWebSearchResults edge cases (no structured matches, raw code href)
 * - parseFileSymbols edge cases
 */
import { describe, it, expect } from 'vitest';
import {
  parseAnnotate,
  parseWebSearchResults,
  parseFileSymbols,
} from '../server/parsers/index.js';

// -----------------------------------------------------------------------
// parseAnnotate — table-based fallback
// -----------------------------------------------------------------------

describe('parseAnnotate — table fallback', () => {
  it('falls back to table rows when no annotate divs exist', () => {
    const html = `
      <html><body>
        <table>
          <tr>
            <td>abc123</td>
            <td>developer</td>
            <td>2024-01-01</td>
            <td>int main() {}</td>
          </tr>
          <tr>
            <td>def456</td>
            <td>admin</td>
            <td>2024-01-02</td>
            <td>return 0;</td>
          </tr>
        </table>
      </body></html>
    `;
    const result = parseAnnotate(html, 'proj', 'file.cpp');
    expect(result.project).toBe('proj');
    expect(result.path).toBe('file.cpp');
    expect(result.lines.length).toBe(2);
    expect(result.lines[0].revision).toBe('abc123');
    expect(result.lines[0].author).toBe('developer');
    expect(result.lines[1].revision).toBe('def456');
    expect(result.lines[1].author).toBe('admin');
  });

  it('skips rows with fewer than 3 cells', () => {
    const html = `
      <html><body>
        <table>
          <tr><td>header</td></tr>
          <tr><td>abc</td><td>x</td></tr>
          <tr><td>abc123</td><td>dev</td><td>2024</td><td>code</td></tr>
        </table>
      </body></html>
    `;
    const result = parseAnnotate(html, 'proj', 'file.cpp');
    // Only the last row with 4 cells should be parsed
    expect(result.lines.length).toBe(1);
    expect(result.lines[0].revision).toBe('abc123');
  });
});

// -----------------------------------------------------------------------
// parseWebSearchResults — edge cases
// -----------------------------------------------------------------------

describe('parseWebSearchResults — edge cases', () => {
  it('extracts matches from raw code href when no a.s links', () => {
    const html = `
      <div id="results">
        <p class="pagetitle">Results 1 – 1 of 1</p>
        <table><tbody class="search-result">
          <tr>
            <td class="q">H</td>
            <td class="f"><a href="/source/xref/myproj/src/main.cpp#25">main.cpp</a></td>
            <td><code class="con">25 int main() { return 0; }</code></td>
          </tr>
        </tbody></table>
      </div>
    `;
    const result = parseWebSearchResults(html, 'defs', 'main');
    expect(result.totalCount).toBe(1);
    expect(result.results.length).toBe(1);
    expect(result.results[0].project).toBe('myproj');
    // The xref regex captures the full path after the project including the fragment
    expect(result.results[0].path).toContain('/src/main.cpp');
    expect(result.results[0].matches[0].lineNumber).toBe(25);
  });

  it('handles empty results page', () => {
    const html = `
      <div id="results">
        <p class="pagetitle">Results 0 – 0 of 0</p>
      </div>
    `;
    const result = parseWebSearchResults(html, 'defs', 'missing');
    expect(result.totalCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('skips rows without valid xref href', () => {
    const html = `
      <div id="results">
        <p class="pagetitle">Results 1 – 1 of 1</p>
        <table><tbody class="search-result">
          <tr>
            <td class="q">H</td>
            <td class="f"><a href="/invalid/path">file.cpp</a></td>
            <td><code class="con">code</code></td>
          </tr>
        </tbody></table>
      </div>
    `;
    const result = parseWebSearchResults(html, 'defs', 'test');
    expect(result.results).toHaveLength(0);
  });

  it('handles structured a.s match links with span.l line numbers', () => {
    const html = `
      <div id="results">
        <p class="pagetitle">Results 1 – 2 of 2</p>
        <table><tbody class="search-result">
          <tr>
            <td class="q">H</td>
            <td class="f"><a href="/source/xref/proj/src/app.cpp">app.cpp</a></td>
            <td><code class="con"><a class="s" href="/source/xref/proj/src/app.cpp#10"><span class="l">10</span> void run()</a></code></td>
          </tr>
        </tbody></table>
      </div>
    `;
    const result = parseWebSearchResults(html, 'refs', 'run');
    expect(result.results.length).toBe(1);
    expect(result.results[0].matches[0].lineNumber).toBe(10);
  });
});

// -----------------------------------------------------------------------
// parseFileSymbols — edge cases
// -----------------------------------------------------------------------

describe('parseFileSymbols — additional', () => {
  it('returns empty for HTML without symbol anchors', () => {
    const html = '<html><body><div>no symbols here</div></body></html>';
    const result = parseFileSymbols(html);
    expect(result).toEqual([]);
  });

  it('parses xref with def symbols and line anchors', () => {
    const html = `
      <a class="l" name="10"></a>
      <a class="xf intelliWindow-symbol" data-definition-place="def">myFunction</a>
      <a class="l" name="20"></a>
      <a class="xc intelliWindow-symbol" data-definition-place="def">MyClass</a>
    `;
    const result = parseFileSymbols(html);
    expect(result.length).toBe(2);
    expect(result[0].symbol).toBe('myFunction');
    expect(result[0].type).toBe('function');
    expect(result[0].line).toBe(10);
    expect(result[1].symbol).toBe('MyClass');
    expect(result[1].type).toBe('class');
    expect(result[1].line).toBe(20);
  });

  it('parses function with signature', () => {
    const html = `
      <a class="l" name="5"></a>
      <span class='scope-signature'>(int x, int y)</span>
      <a class="xf intelliWindow-symbol" data-definition-place="def">add</a>
    `;
    const result = parseFileSymbols(html);
    expect(result.length).toBe(1);
    expect(result[0].symbol).toBe('add');
    expect(result[0].signature).toBe('(int x, int y)');
  });

  it('handles multiple symbol types', () => {
    const html = `
      <a class="l" name="1"></a>
      <a class="xm intelliWindow-symbol" data-definition-place="def">MAX_SIZE</a>
      <a class="l" name="5"></a>
      <a class="xe intelliWindow-symbol" data-definition-place="def">Color</a>
      <a class="l" name="10"></a>
      <a class="xs intelliWindow-symbol" data-definition-place="def">Point</a>
      <a class="l" name="15"></a>
      <a class="xt intelliWindow-symbol" data-definition-place="def">size_type</a>
    `;
    const result = parseFileSymbols(html);
    expect(result.length).toBe(4);
    expect(result[0].type).toBe('macro');
    expect(result[1].type).toBe('enum');
    expect(result[2].type).toBe('struct');
    expect(result[3].type).toBe('typedef');
  });
});
