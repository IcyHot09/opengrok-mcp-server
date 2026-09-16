#!/usr/bin/env node
/**
 * Generates the GitHub Release body for the given version.
 * Extracts the version's section from CHANGELOG.md and wraps it
 * in a formatted template mirroring the original release layout.
 *
 * Usage: node scripts/generate-release-notes.js <version> > release-body.md
 *        node scripts/generate-release-notes.js 3.3.2 > release-body.md
 */

const fs = require('fs');
const path = require('path');

const ver = process.argv[2];
if (!ver) {
  console.error('Usage: node scripts/generate-release-notes.js <version>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const base = 'https://github.com/IcyHot09/opengrok-mcp-server';

const start = log.indexOf('## [' + ver + ']');
if (start === -1) {
  console.error('Version ' + ver + ' not found in CHANGELOG.md');
  process.exit(1);
}
const end = log.indexOf('\n## [', start + 1);
const section = (end === -1 ? log.slice(start) : log.slice(start, end)).trim();

const body = [
  "## 🚀 What's New",
  '',
  'See the [CHANGELOG](' + base + '/blob/main/CHANGELOG.md) for the full list of changes in this release.',
  '',
  section,
  '',
  '---',
  '',
  '## 📦 Getting Started',
  '',
  '### VS Code Extension',
  '',
  '1. Download **opengrok-mcp-server-' + ver + '.vsix** from the Assets section below',
  '2. Open VS Code → **Extensions** → **···** → **Install from VSIX…**',
  '3. Select the downloaded file — done!',
  '',
  '> 💡 Already on v3.1 or later? The extension checks for updates automatically.',
  '',
  '### Standalone MCP Server',
  '',
  'One-line install for any MCP-compatible client:',
  '',
  'See the [install guide](' + base + '/blob/main/MCP_CLIENTS.md#quick-start) for setup instructions.',
  '',
  'Supported clients: **Claude Code** · **Cursor** · **Windsurf** · **Claude Desktop** · **OpenCode** · and [more](' + base + '/blob/main/MCP_CLIENTS.md)',
  '',
  '---',
  '',
  '## 📖 Documentation',
  '',
  '| Resource | Description |',
  '|----------|-------------|',
  '| [README](' + base + '/blob/main/README.md) | VS Code extension setup & configuration |',
  '| [MCP Clients Guide](' + base + '/blob/main/MCP_CLIENTS.md) | Per-client config for standalone server |',
  '| [Changelog](' + base + '/blob/main/CHANGELOG.md) | Full version history |',
].join('\n');

process.stdout.write(body);
