# Agent Instructions — opengrok-mcp-server

OpenGrok MCP server and VS Code extension. Dual-purpose package: bundles an MCP
server inside a VSIX and publishes as `opengrok-mcp-server` on npm. AI agents
call namespaced methods (`env.opengrok.search()`, `env.opengrok.readMemory()`)
inside a JavaScript sandbox — no backend selection needed.

## Commands

```bash
npm run compile          # build (dev, with sourcemaps)
npm run package          # build (production, minified)
npm run watch            # build in watch mode
npm test                 # run all tests (vitest)
npm run test:watch       # vitest interactive watch
npm run test:coverage    # coverage report (thresholds: 80% lines/functions/statements/branches)
npm run test:sandbox     # sandbox integration tests (requires npm run compile first)
npm run typecheck        # tsc --noEmit only
npm run lint             # tsc --noEmit + eslint src/
npm run lint:fix         # eslint --fix
npm run validate         # typecheck + lint + test (full pre-commit check)
npm run vsix             # build .vsix extension package
npm run generate:spec    # regenerate sandbox API spec snapshot from sandbox-schemas/
npm run copy-grammars    # copy tree-sitter WASM grammars into grammars/
```

CLI commands:

```bash
npx opengrok-mcp-server setup   # interactive setup wizard (Claude Code, VS Code/Copilot, Codex CLI)
opengrok-mcp status      # health check + client detection
opengrok-mcp setup --test                     # test stored connection without the wizard
opengrok-mcp setup --set contextBudget=generous  # update one stored setting non-interactively
opengrok-mcp export-audit --format json --output audit.jsonl  # export the audit log
opengrok-mcp version     # print version and exit (also --version)
opengrok-mcp help        # show all commands
```

Run a single test file:

```bash
npx vitest run src/tests/client.test.ts
```

## Architecture

This repo produces **three separate outputs** from a single TypeScript codebase:

| Output | Entry point | External deps | Purpose |
|---|---|---|---|
| `out/extension.js` | `src/extension.ts` | `vscode`, `@napi-rs/keyring` | VS Code extension host |
| `out/server/main.js` | `src/server/main.ts` | `@napi-rs/keyring`, `@clack/prompts`, `@iarna/toml` | Standalone MCP server (also a CLI binary) |
| `out/server/sandbox-worker.js` | `src/server/sandbox/worker.ts` | — | QuickJS worker thread for Code Mode |

All three are bundled by esbuild (`esbuild.js`). The build also copies
`emscripten-module.wasm` and the tree-sitter runtime WASM to `out/server/`,
tree-sitter grammars to `out/grammars/`, and webview files to `out/webview/`.
It injects `__VERSION__` as a compile-time constant and auto-syncs
`server.json` version with `package.json`.

Two operational modes:

### Code Mode (default, `OPENGROK_CODE_MODE=true`)

2–5 tools — most token-efficient for large multi-language codebases (`opengrok_api` + `opengrok_execute`, plus 3 memory tools when `OPENGROK_ENABLE_MEMORY_TOOLS=true`):

| Tool | Purpose |
| ---- | ------- |
| `opengrok_api` | Returns full API spec (call once per session) |
| `opengrok_execute` | Runs LLM-supplied JavaScript in a QuickJS WASM sandbox via `env.opengrok.*` methods |
| `opengrok_read_memory` | Read `active-task.md` or `investigation-log.md` from the Living Document memory bank |
| `opengrok_update_memory` | Write or append to memory files |
| `opengrok_memory_status` | Shows both memory files (status, bytes, 3-line preview) |

All sandbox API calls appear synchronous — the worker bridges async HTTP via
SharedArrayBuffer + Atomics (8 MB data region, 62 s hard timeout).

### Standard mode (`OPENGROK_CODE_MODE=false`)

20 tools, all prefixed `opengrok_` (no memory tools). See tool list in `server.ts`.

## Key Source Files

### `src/server/` — Core orchestration (flat layout, grouped by concern)

| File | Purpose |
| ---- | ------- |
| `main.ts` | Entry point; loads config, constructs `OpenGrokClient` and `MemoryBank`, calls `runServer()` |
| `server.ts` | Slim orchestrator: `createServer()`, `runServer()`, `startHealthCheckPolling()`, `SERVER_INSTRUCTIONS`; executors/registration/docs moved to `tools/` + `protocol/notifications.ts` |
| `server-utils.ts` | `capResponse()`, `capCodeModeResult()`, `capStructuredToBytes()`, budget helpers |
| `config.ts` | `loadConfig()`: Zod-validated `OPENGROK_*` env vars, AES-256-GCM encrypted credential files, `BUDGET_LIMITS` tiers (minimal 8 KB / standard 16 KB / generous 32 KB) |
| `models.ts` | Zod input schemas for all tools + structured output schemas |

### Client (`client/`)

| File | Purpose |
| ---- | ------- |
| `client/opengrok-client.ts` | `OpenGrokClient` class: undici-only HTTP, `p-retry`, TTL cache, token-bucket rate limiter |
| `client/cache.ts` | `TTLCache` (entry count + byte budget) |
| `client/security.ts` | `buildSafeUrl()` (SSRF), `assertSafePath()` (path traversal), `isPrivateIp()`, file-type allowlist |
| `client/text-utils.ts` | `extractLineRange()`, `sleep()`, `TIMEOUTS`, `safeResponseText()` |
| `client/response-parser.ts` | `parseSearchResponse()` + placeholder enrichment |
| Security | `buildSafeUrl()` (SSRF) for all URL construction, `assertSafePath()` (path traversal) before path-based requests |
| Resilience | `p-retry` retry logic, redirect body consumption (no undici leaks), proxy via `ProxyAgent` |
| Cursors | Offset/page cursor helpers re-exported from `pagination/cursor-codec.ts` |

### Parsers (`parsers/`)

| File | Purpose |
| ---- | ------- |
| `parsers/projects-dirs.ts` | Projects page + directory listing parsers |
| `parsers/history-annotate.ts` | File history + annotate parsers |
| `parsers/search.ts` | Web search + single-result redirect parsers |
| `parsers/symbols.ts` | File symbols parser |
| `parsers/diff.ts` | File diff + hunk parser (`parseFileDiff()`, `buildHunk()`) |
| `parsers/feeds.ts` | RSS history + more-results parsers |
| `parsers/unified-diff.ts` | `parseUnifiedDiff()` — hunk-level diff parser; used by `diff(includeHunks:true)` |
| `shared/html-parsers.ts` | `parseProjectsFromHtml()` — project discovery from the OpenGrok root page (setup picker, webview fetch) |

### Formatters (`formatters/`)

| File | Purpose |
| ---- | ------- |
| `formatters/core.ts` | `selectFormat()` + cap helpers + strip helpers |
| `formatters/search.ts` | Search + batch + search-and-read formatters |
| `formatters/file.ts` | File content/history/directory/projects/diff formatters |
| `formatters/symbol.ts` | Symbol context + compile-info + file-symbols formatters |
| `formatters/blame.ts` | Annotate/blame/what-changed/dependency formatters |
| Budgets | All output flows through `capResponse()` / `getMaxResponseBytes()` (8/16/32 KB tiers, `OPENGROK_MAX_RESPONSE_BYTES` override) |

### Sandbox (Code Mode QuickJS sandbox)

| File | Purpose |
| ---- | ------- |
| `sandbox/sandbox.ts` | `executeInSandbox()` orchestrator; `createSandboxAPI()` host-side bridge; `API_SPEC`; `SANDBOX_ALLOWED_METHODS` allowlist |
| `sandbox/worker.ts` | Worker thread: QuickJS WASM VM, `env.opengrok` object with explicit `makeMethod("name")` per method + flat-globals `destructure` preamble — new methods must be added to both |
| `sandbox/protocol.ts` | SharedArrayBuffer layout constants (`STATUS_OFFSET`, `LENGTH_OFFSET`, `DATA_OFFSET`, `DATA_REGION_BYTES` = 8 MB) shared by both threads |
| `sandbox/buffer.ts` | `fitToBuffer()`, `buildBatchSearchStubs()` — truncation never silently changes return type |
| `sandbox/error-hints.ts` | `METHOD_SIGNATURES` (from generated spec) + alias map: contextual error suggestions without MCP sampling |
| `sandbox/security.ts` | Re-exports `SANDBOX_ALLOWED_METHODS` + `sanitizeSandboxError` (single source in `sandbox.ts`/`utils/redact.ts`) |
| `sandbox/api-spec.ts` | Generated API spec snapshot (`API_SPEC_TS`/`API_SPEC`/`METHOD_SIGNATURES`) derived from `sandbox/schemas/` — run `npm run generate:spec`, do not edit manually |
| `sandbox/worker-pool.ts` | `SandboxWorkerPool`: keeps up to 2 idle QuickJS workers warm; `acquire()`/`release()`/`drain()` with `isAlive` guard |
| `pagination/cursor-codec.ts` | `encodeCursor()` / `decodeCursor()` — opaque base64url cursors shared by all paginated methods; `isOffsetCursorFor()` rejects cross-method reuse; `CURSOR_EXPIRED` shape |

### `src/server/sandbox/schemas/` — Zod schemas for the sandbox API

| File | Purpose |
| ---- | ------- |
| `generator.ts` | `MethodSchema` type + TypeScript declaration generator engine — run `npm run generate:spec` after schema changes |
| `interfaces.ts` | Shared Zod schemas: search results, call nodes, symbol context results, etc. |
| `search.ts` | `search()`, `batchSearch()`, `findFile()`, `searchSuggest()` method schemas |
| `read-navigate.ts` | `getFileContent()`, `browseDir()`, `getFileSymbols()`, `getFileOverview()`, `getFileDiff()` method schemas |
| `history-blame.ts` | `getFileAnnotate()`, `getFileHistory()` method schemas |
| `code-intelligence.ts` | `traceCallChain()`, `getSymbolContext()` method schemas |
| `system.ts` | `indexHealth()`, `getCompileInfo()`, `elicit()`, `sample()` method schemas |
| `feature-flag.ts` | Memory method schemas (`readMemory` / `writeMemory`) |
| `index.ts` | Barrel exports |

### Pagination

| File | Purpose |
| ---- | ------- |
| `pagination/cursor-codec.ts` | `encodeCursor()` / `decodeCursor()` — shared opaque codec used by all paginated sandbox and standard-mode methods |

### Memory (session memory)

| File | Purpose |
| ---- | ------- |
| `memory/memory-bank.ts` | `MemoryBank`: two-file allow-list (`active-task.md` ≤ 4 KB + `investigation-log.md` ≤ 32 KB); delta encoding, richness-scored trimming, `getStatusLine()` injected as `{{MEMORY_STATUS}}`, `getFileReference()` for Files API |
| `memory/observation-masker.ts` | Session memory management for long Code Mode sessions (keeps last N full results, summarizes older ones) |
| `utils/file-cache.ts` | `FileReferenceCache`: SHA-256 content-addressed cache for `investigation-log.md` (`OPENGROK_ENABLE_FILES_API`) |

### Intelligence (tree-sitter code intelligence)

| File | Purpose |
| ---- | ------- |
| `intelligence.ts` | Host-side intelligence: `buildFileOverview()`, `buildCallChain()` — called by tool handlers and the sandbox API surface |
| `intelligence/index.ts` | Barrel re-exports for the analysis modules |
| `intelligence/tree-sitter.ts` | `web-tree-sitter` WASM init, grammar loading (`LANGUAGE_GRAMMAR_MAP`, grammars from `out/grammars/` or `OPENGROK_GRAMMAR_DIR`), `parseSource()`, `queryNodes()`, `isLanguageSupported()` |
| `intelligence/ast-truncation.ts` | `truncateAtBoundary()`, `expandToFunctionBoundary()`, `extractSignatures()`, shared definition-name resolver |
| `intelligence/callee-extractor.ts` | Tree-sitter callee extraction for `traceCallChain()` callees direction (supported languages return real callees) |
| `intelligence/import-extractor.ts` | Tree-sitter import/include extraction for dependency analysis uses direction |

### Transport (HTTP transport & auth)

| File | Purpose |
| ---- | ------- |
| `transport/http-transport.ts` | Streamable HTTP transport (`OPENGROK_HTTP_PORT`); per-session McpServer factory, session TTL sweep, CORS allowlist, security headers; OAuth 2.1 resource server via `jose` |
| `transport/rbac.ts` | RBAC engine: admin/developer/readonly roles, `hasPermission()`, `parseRbacConfig()`, fail-safe readonly default |
| `transport/audit.ts` | `auditLog()`: structured audit logging to stderr + optional CSV/JSON file (`OPENGROK_AUDIT_LOG_FILE`) |

### Protocol (MCP protocol extensions)

| File | Purpose |
| ---- | ------- |
| `protocol/elicitation.ts` | MCP Elicitation wrapper (`elicitOrFallback()`) with graceful fallback for unsupported clients |
| `protocol/sampling.ts` | `sampleOrNull()`: MCP Sampling with retry/backoff/timeout and model preference |
| `protocol/notifications.ts` | SIGHUP config reload + notification handlers (extracted from `server.ts`) |

### Tools (`tools/` — executors + registration, extracted from `server.ts`)

| File | Purpose |
| ---- | ------- |
| `tools/executors.ts` | `execute*` handlers + `dispatchTool()` + local-layer helpers |
| `tools/register-tools.ts` | `registerMemoryTools()`, `registerCodeModeTools()`, `registerLegacyTools()` |
| `tools/register-resources.ts` | `registerToolDocResources()`, `registerMemoryResources()` |
| `tools/register-prompts.ts` | `registerInvestigationPrompts()` |
| `tools/tool-docs.ts` | `TOOL_DOCS`, `TOOL_REGISTRATION_ORDER`, `TOOL_DEFS` |
| `tools/tool-annotations.ts` | `READ_ONLY_*`, `CODE_MODE_*` annotations |
| `tools/tool-rate-limiter.ts` | `ToolRateLimiter`: per-tool sliding-window rate limiting (`OPENGROK_PER_TOOL_RATELIMIT`, `DEFAULT_PER_TOOL_LIMITS`) |

### Utils (shared utilities)

| File | Purpose |
| ---- | ------- |
| `utils/redact.ts` | `redactString()`, `sanitizeErrorMessage()`, `sanitizeSandboxError()` — single source of truth for credential/path/PII redaction |
| `utils/logger.ts` | Structured stderr logger (JSON in production) |
| `shared/tls-ca.ts` | System CA trust bundle for undici agents and `node:https` paths |
| `utils/api-types.ts` | Shared TypeScript interfaces for OpenGrok REST API response shapes |
| `local/compile-info.ts` | `compile_commands.json` reader for C/C++ compiler flags and include paths |

### CLI (`src/server/cli/` — routed from `main.ts`: `setup` / `status` / `export-audit` / `version` / `help`)

| File | Purpose |
| ---- | ------- |
| `commands.ts` | `resolveCliCommand()` / levenshtein `suggestCliCommand()` / usage text (no side effects — unit-tested) |
| `setup/wizard.ts` | Interactive setup wizard (`npx opengrok-mcp-server setup`); pre-fills from stored client configs; offers discovered projects via `fetchAvailableProjects()` |
| `setup/configure.ts` | `buildEnv()` (writes only non-default values), `readStoredEnv()` (Claude Code → Copilot CLI → Codex priority), per-client config writers, `updateStoredSetting()` for `setup --set` |
| `setup/detect.ts` | MCP client auto-detection (Claude Code, Codex, Copilot CLI) |
| `status.ts` | `opengrok-mcp status` health check (same config resolution chain as the server); `runSetupTest()` for `setup --test` |
| `status-view.ts` | Pure `renderStatus()` box-drawing renderer (OpenGrok/config/clients/update sections) |
| `colors.ts` | TTY-gated terminal colors for CLI output |
| `keychain.ts` | OS keychain abstraction (`@napi-rs/keyring`) with AES-256-GCM encrypted file fallback |
| `keyring-loader.ts` | Lazy optional `@napi-rs/keyring` loader (null when the native module is absent) |

### Extension (`src/extension/` + `src/extension.ts`)

| File | Purpose |
| ---- | ------- |
| `extension/credentials.ts` | `syncServerCredentials()` with `overwriteExisting` guard (background sync preserves fresher CLI values; explicit saves win) |

## Tests

Tests are in `src/tests/` — 50+ test files covering server orchestration,
config/budgets, Code Mode sandbox, elicitation/sampling, intelligence and
tree-sitter, client security, formatters, parsers, transport/OAuth/RBAC/audit,
tools/rate limiting, memory/observation masker, and utils:

- Tests share module-level mocks — `vitest.config.ts` sets `fileParallelism: false`.
- Coverage only measures `src/server/**` (thresholds ≥ 80%).
- The `__VERSION__` constant is set to `'test'` in vitest via `define`.
- `npm run test:sandbox` requires a compiled build (`npm run compile`) and uses
  `vitest.sandbox.config.ts`.
- HTML fixtures live in `src/tests/fixtures/`; HTTP clients are mocked — no
  live OpenGrok connection needed.

## Adding a New Tool

1. **Add Zod schema** in `src/server/models.ts`
2. **Add handler** in `src/server/server.ts` (extend `registerLegacyTools()` or `registerCodeModeTools()` with a `server.registerTool()` call)
3. **Add client method** in `src/server/client/opengrok-client.ts` (use `buildSafeUrl()` for all URL construction, `assertSafePath()` before path-based requests)
4. **Add formatter** in `src/server/formatters/`
5. **Add unit tests** in `src/tests/`
6. **If rate-limited**: add a default entry to `DEFAULT_PER_TOOL_LIMITS` in `src/server/config.ts`
7. **If exposed in Code Mode sandbox**: add the method name to `SANDBOX_ALLOWED_METHODS` in `sandbox/sandbox.ts`, implement it in `createSandboxAPI()`, and expose it via `makeMethod("name")` in `sandbox/worker.ts`
8. **If the method is paginated**: mint/accept opaque offset cursors via `encodeCursor()` / `decodeCursor()` from `pagination/cursor-codec.ts` (see `getFileHistory` in `sandbox/sandbox.ts`: `resolveCursorOffset` → client call → mint `encodeCursor({ t: "offset", v: nextOffset, m: "<method>" })`); return `CURSOR_EXPIRED` for invalid or cross-method cursors
9. **If the method has a structured return schema**: add a `MethodSchema` in the appropriate `sandbox/schemas/*.ts` file and run `npm run generate:spec` (do **not** edit generated spec output manually)

## Constraints

- **Zod 4** — use native `z.toJSONSchema()` (no `zod-to-json-schema` package)
- **No axios/node-fetch** — use `undici` (not native `fetch`)
- **`buildSafeUrl()`** must be used for all URL construction in `client/opengrok-client.ts` (SSRF prevention)
- **`assertSafePath()`** must be called before any path-based HTTP request (path traversal prevention)
- **Credentials never in logs** — use `@napi-rs/keyring` or encrypted file; redact via `redactString()`
- **`strict: true`**, `target: ES2022` in `tsconfig.json`
- **8/16/32 KB budget tiers** — `minimal` (8 KB) / `standard` (16 KB, default) / `generous` (32 KB); all formatters must stay within `capResponse()` / `getMaxResponseBytes()` limits
- **Sandbox limits** — 8 MB SharedArrayBuffer data region (`DATA_REGION_BYTES`), 62 s hard timeout; `fitToBuffer()` must never silently change return types
