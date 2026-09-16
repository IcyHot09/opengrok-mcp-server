/**
 * Copy tree-sitter WASM grammars from node_modules to grammars/ directory.
 * Retained as a standalone helper for source-tree setup.
 *
 * Primary source: tree-sitter-wasm (nested layout out/<lang>/tree-sitter-<lang>.wasm).
 * Fallback: legacy flat tree-sitter-wasms package (out/*.wasm).
 */
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "node_modules", "tree-sitter-wasm", "out");
const legacyDir = path.join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out");
const destDir = path.join(__dirname, "..", "grammars");

function collectWasmFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWasmFiles(full));
    } else if (entry.name.endsWith(".wasm")) {
      // Files are already canonically named tree-sitter-<lang>.wasm — keep basename.
      out.push({ src: full, name: entry.name });
    }
  }
  return out;
}

let grammars = [];
if (fs.existsSync(srcDir)) {
  grammars = collectWasmFiles(srcDir);
} else if (fs.existsSync(legacyDir)) {
  grammars = fs
    .readdirSync(legacyDir)
    .filter((f) => f.endsWith(".wasm"))
    .map((f) => ({ src: path.join(legacyDir, f), name: f }));
} else {
  console.log("No tree-sitter grammar packages installed, skipping grammar copy.");
  process.exit(0);
}

if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

for (const { src, name } of grammars) {
  fs.copyFileSync(src, path.join(destDir, name));
}
console.log(`Copied ${grammars.length} grammar WASM file(s) to grammars/`);
