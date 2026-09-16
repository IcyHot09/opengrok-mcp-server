/**
 * Offline-safe runner for scripts/generate-spec.ts.
 *
 * Bundles the TypeScript generator (plus sandbox-schemas/) with esbuild and
 * executes the bundle. Used by `npm run generate:spec` so regeneration works
 * without extra devDependencies (tsx is not installed).
 */
const { buildSync } = require("esbuild");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Bundle next to this runner so import.meta.url (used for __dirname inside
// generate-spec.ts) still resolves to scripts/. Deleted after the run.
const outfile = path.join(__dirname, ".generate-spec.bundle.mjs");
try {
  buildSync({
    entryPoints: [path.join(__dirname, "generate-spec.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
  });
  execFileSync(process.execPath, [outfile], { stdio: "inherit" });
} finally {
  fs.rmSync(outfile, { force: true });
}
