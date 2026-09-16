const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Sync server.json version with package.json (Phase 8.5)
function syncServerJsonVersion() {
  const pkgVersion = require('./package.json').version;
  const serverJsonPath = path.join(__dirname, 'server.json');
  if (!fs.existsSync(serverJsonPath)) return;
  const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
  let changed = false;
  if (serverJson.version !== pkgVersion) {
    serverJson.version = pkgVersion;
    changed = true;
  }
  if (serverJson.packages) {
    for (const pkg of serverJson.packages) {
      if (pkg.version !== pkgVersion) {
        pkg.version = pkgVersion;
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n', 'utf8');
    console.log(`Synced server.json version to ${pkgVersion}`);
  }
}

// Copy QuickJS WASM file to out/server/ so the emscripten module can find it
// at runtime via __dirname (which resolves to out/server/ in the bundled worker).
function copyQuickJsWasm() {
  const src = path.join(
    __dirname,
    'node_modules/@jitl/quickjs-ng-wasmfile-release-sync/dist/emscripten-module.wasm'
  );
  const destDir = path.join(__dirname, 'out', 'server');
  const dest = path.join(destDir, 'emscripten-module.wasm');
  if (!fs.existsSync(src)) {
    console.error('Warning: QuickJS WASM not found at', src);
    return;
  }
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  console.log('Copied emscripten-module.wasm to out/server/');
}

// Copy web-tree-sitter runtime WASM to out/server/ so the bundled server can find it.
// esbuild sets __dirname = out/server/ for bundled code, so the runtime WASM must live there.
function copyTreeSitterWasm() {
  // web-tree-sitter 0.25+ renamed the runtime module to web-tree-sitter.wasm;
  // older versions shipped tree-sitter.wasm.
  const candidates = ['web-tree-sitter.wasm', 'tree-sitter.wasm'];
  const src = candidates
    .map(f => path.join(__dirname, 'node_modules/web-tree-sitter', f))
    .find(f => fs.existsSync(f));
  if (!src) {
    console.error('Warning: web-tree-sitter WASM not found in node_modules/web-tree-sitter/');
    return;
  }
  const destDir = path.join(__dirname, 'out', 'server');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  console.log(`Copied ${path.basename(src)} to out/server/`);
}

// Copy tree-sitter grammar WASM files to out/grammars/
function collectWasmFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWasmFiles(full));
    } else if (entry.name.endsWith('.wasm')) {
      // Files are already canonically named tree-sitter-<lang>.wasm — keep basename.
      out.push({ src: full, name: entry.name });
    }
  }
  return out;
}

function copyGrammars() {
  const sourceGrammarsDir = path.join(__dirname, 'grammars');
  const dependencyGrammarsDir = path.join(__dirname, 'node_modules', 'tree-sitter-wasm', 'out');
  let grammars = [];

  if (fs.existsSync(dependencyGrammarsDir)) {
    // Primary source: tree-sitter-wasm package (nested out/<lang>/*.wasm layout) —
    // flatten during copy. Preferred over the source grammars/ dir, which may be stale.
    grammars = collectWasmFiles(dependencyGrammarsDir).filter(g => g.name.startsWith('tree-sitter-'));
    const extra = fs.existsSync(sourceGrammarsDir)
      ? fs.readdirSync(sourceGrammarsDir).filter(f => f.endsWith('.wasm') && !grammars.some(g => g.name === f))
      : [];
    for (const name of extra) {
      grammars.push({ src: path.join(sourceGrammarsDir, name), name });
    }
  } else if (fs.existsSync(sourceGrammarsDir)) {
    grammars = fs
      .readdirSync(sourceGrammarsDir)
      .filter(f => f.endsWith('.wasm'))
      .map(f => ({ src: path.join(sourceGrammarsDir, f), name: f }));
  }

  if (grammars.length === 0) {
    console.log('No tree-sitter grammars found, skipping grammar copy.');
    return;
  }

  const destDir = path.join(__dirname, 'out', 'grammars');
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  for (const { src, name } of grammars) {
    fs.copyFileSync(src, path.join(destDir, name));
  }
  console.log(`Copied ${grammars.length} grammar WASM file(s) to out/grammars/`);
}

// Copy webview files to out directory
function copyWebviewFiles() {
  const srcDir = path.join(__dirname, 'src', 'webview');
  const destDir = path.join(__dirname, 'out', 'webview');
  
  if (!fs.existsSync(srcDir)) {
    console.log('No webview directory found, skipping copy.');
    return;
  }
  
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log(`Copied ${files.length} webview file(s) to out/webview/`);
}

const sharedOptions = {
  bundle: true,
  format: /** @type {'cjs'} */ ('cjs'),
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: /** @type {'node'} */ ('node'),
  logLevel: 'info',
  define: {
    // JSON.stringify wraps the version in quotes, producing a string literal
    // that esbuild substitutes at compile time: "9.0.2" → const v = "9.0.2"
    '__VERSION__': JSON.stringify(require('./package.json').version),
  },
};

async function main() {
  // ---- VS Code Extension ----
  const extCtx = await esbuild.context({    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    // vscode: provided at runtime by VS Code
    // @napi-rs/keyring: prebuilt native .node binaries, must stay external
    external: [
      'vscode',
      '@napi-rs/keyring', '@napi-rs/keyring-linux-x64-gnu', '@napi-rs/keyring-linux-x64-musl',
      '@napi-rs/keyring-darwin-x64', '@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-win32-x64-msvc',
    ],
  });

  // ---- MCP Server (standalone Node.js bundle) ----
  // Plugin to externalize the TUI dynamic import — the TUI is built separately as ESM
  const externalizeTuiPlugin = {
    name: 'externalize-tui',
    setup(build) {
      build.onResolve({ filter: /\.\/tui\.mjs$/ }, () => ({
        path: './tui.mjs',
        external: true,
      }));
    },
  };

  const srvCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/server/main.ts'],
    outfile: 'out/server/main.js',
    loader: { '.wasm': 'copy' }, // in case WASM imports leak through bundling
    plugins: [externalizeTuiPlugin],
    // CLI-only packages that must stay external:
    // - @napi-rs/keyring: ships prebuilt native .node binaries
    // - @clack/prompts: interactive terminal UI (ESM-only, CJS bundling unsupported)
    // - @iarna/toml: used only by CLI setup wizard at runtime
    external: [
      '@napi-rs/keyring', '@napi-rs/keyring-linux-x64-gnu', '@napi-rs/keyring-linux-x64-musl',
      '@napi-rs/keyring-darwin-x64', '@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-win32-x64-msvc',
      '@clack/prompts', '@iarna/toml',
    ],
    banner: {
      js: '#!/usr/bin/env node\nvar importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
    define: {
      ...sharedOptions.define,
      // web-tree-sitter 0.26's emscripten loader uses createRequire(import.meta.url)
      // to resolve its WASM file. esbuild bundles to CJS where import.meta.url is
      // undefined — same fix as the worker bundle below.
      'import.meta.url': 'importMetaUrl',
    },
  });

  // ---- TUI (separate ESM bundle for Ink/React) ----
  // Built as ESM so `ink` (ESM-only with top-level await) loads correctly.
  // Loaded at runtime via dynamic import() from wizard.ts.
  const tuiCtx = await esbuild.context({
    ...sharedOptions,
    format: /** @type {'esm'} */ ('esm'),
    jsx: 'automatic',
    entryPoints: ['src/server/cli/tui/index.tsx'],
    outfile: 'out/server/tui.mjs',
    // ink, react are ESM-only — keep external for Node.js to resolve from node_modules.
    // CLI-only packages stay external like the server bundle.
    external: [
      '@napi-rs/keyring', '@napi-rs/keyring-linux-x64-gnu', '@napi-rs/keyring-linux-x64-musl',
      '@napi-rs/keyring-darwin-x64', '@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-win32-x64-msvc',
      '@clack/prompts', '@iarna/toml',
      'ink', 'react', 'react/jsx-runtime',
    ],
    // The bundled code has CJS patterns that use require() for Node builtins.
    // ESM doesn't have require(), so we shim it with createRequire.
    banner: {
      js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
    },
  });

  // ---- Sandbox Worker (separate entry point for worker_threads) ----
  const workerCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/server/sandbox/worker.ts'],
    outfile: 'out/server/sandbox-worker.js',
    // @sebastianwessel/quickjs and @jitl/quickjs-ng-wasmfile-release-sync are
    // bundled (not external) so they work inside a VSIX where node_modules is absent.
    // The emscripten module resolves the WASM via __dirname at runtime, so we
    // explicitly copy emscripten-module.wasm to out/server/ after the build.
    //
    // FIX: The @jitl ESM emscripten loader uses `import.meta.url` to call
    // createRequire(import.meta.url) and resolve the WASM path. esbuild bundles
    // to CJS, making import.meta.url === undefined and crashing the worker.
    // We shim it with a CJS-compatible file URL derived from __filename.
    define: {
      ...sharedOptions.define,
      'import.meta.url': 'importMetaUrl',
    },
    banner: {
      js: 'var importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
  });

  if (watch) {
    await extCtx.watch();
    await srvCtx.watch();
    await tuiCtx.watch();
    await workerCtx.watch();
  } else {
    await extCtx.rebuild();
    await extCtx.dispose();
    await srvCtx.rebuild();
    await srvCtx.dispose();
    await tuiCtx.rebuild();
    await tuiCtx.dispose();
    await workerCtx.rebuild();
    await workerCtx.dispose();
  }
  
  // Production builds ship to npm/VSIX: remove stale dev sourcemaps so a
  // prior `npm run compile` can never leak .map files into artifacts.
  if (production) {
    for (const dir of [path.join(__dirname, 'out', 'server')]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.map')) {
          try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
        }
      }
    }
  }

  // Copy QuickJS WASM so sandbox-worker.js can load it at runtime
  copyQuickJsWasm();

  // Copy web-tree-sitter runtime WASM so bundled server can find it at out/server/
  copyTreeSitterWasm();

  // Copy tree-sitter grammars so intelligence module can load them at runtime
  copyGrammars();

  // Copy webview files after build
  copyWebviewFiles();

  // Sync server.json version on every build
  syncServerJsonVersion();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
