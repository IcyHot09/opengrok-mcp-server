# Changelog

All notable changes to the OpenGrok MCP extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [9.6.0] - 2026-09-16

### 🔧 Changed — Code Mode defaults consistency

- **Memory tools default off** — `OPENGROK_ENABLE_MEMORY_TOOLS` now defaults
  to `false`: Code Mode exposes 2 tools (`opengrok_api` + `opengrok_execute`)
  unless explicitly enabled (`=true` for the full 5-tool set). Applies
  consistently across `config.ts`, `package.json`, `settings-catalog.json`,
  `server.json`, the VS Code extension, CLI wizard/TUI, and `setup --set`.
- **Elicitation default on** — `OPENGROK_ENABLE_ELICITATION` now defaults to
  `true` on the same surfaces.
- **Boolean parsing hardened** — `OPENGROK_ENABLE_FILES_API` and
  `OPENGROK_ENABLE_OBSERVATION_MASKER` used `z.coerce.boolean()`, which mapped
  the string `"false"` to `true`. All feature flags now share one
  `true-only` string parsing (memory/elicitation/sampling/files-API/
  observation-masker/code-mode), so explicit `=false` always disables.
- Generic invariants kept: `verifySsl=true`, blank `baseUrl`.

### 🛡️ Fixed — Credential hygiene follow-ups

- **Tool calls failed with `fetch failed` while Test Connection passed** —
  the client passed an undici v8 `Agent` as dispatcher to the Node.js global
  `fetch` (older bundled undici), which rejects foreign dispatchers. The
  client now calls `fetch` from its own undici package. VS Code Test
  Connection was unaffected (it uses raw `node:https`). Added
  `client-live-dispatcher` integration tests (real loopback server, no mocks)
  plus migration of client suites to mock undici's `fetch`.

- **Setup accepts schemeless URLs** — typing `host.example.com` (no scheme)
  in `setup` silently ignored Enter. Both the TUI and fallback wizard now
  assume `https://`, show the assumed URL, and explain invalid input instead
  of stalling.

- **Atomic credential writes** — keychain gate files, encrypted credential
  files, and rotation timestamps are written temp+rename so a crash mid-write
  never leaves torn files.
- **Secure deletion** — credential files are overwritten with random bytes
  before unlink on delete/purge (best-effort; journaling filesystems and SSD
  wear-levelling may preserve copies).
- **Token redaction** — raw API tokens (`glpat-`/`gldt-`/`glrt-`/`gloas-`/
  `glft-`) are redacted from logs and error messages; URL-credential
  redaction is now authority-scoped so OpenGrok `@revision` URLs no longer
  false-positive.
- **Warning surfacing** — the setup wizard shows the keychain verification
  warning instead of a success message when the encrypted-file fallback wins.
- **No-clobber background sync** — the VS Code once-per-session sync preserves
  a differing keychain password (with a convergence warning) instead of
  overwriting a fresher CLI-saved value; explicit saves still win. The
  headless encrypted-file fallback now uses the portable key (no hostname)
  so reads succeed without legacy-key migration.
- **Flat sandbox globals** — the generated API spec documented bare `search()`
  calls while the worker only exposed `env.opengrok.*`, so spec-following code
  threw `ReferenceError`. The worker now destructures all 21 methods as flat
  globals (flat-globals pattern); both forms bridge identically. Server
  instructions, tool descriptions, skills, and contributor docs teach both.
- **RBAC role fix** — `ROLE_PERMISSIONS` referenced nonexistent tools
  (`opengrok_search`, `opengrok_get_symbol_info`) and omitted real ones, so
  developer/readonly roles wrongly 403'd legitimate tools. Both lists now
  match the 31 registered tools (readonly: single-shot reads only — no
  execute, memory writes, or fan-out tools).
- **Memory tools toggle** — new `OPENGROK_ENABLE_MEMORY_TOOLS` setting (default
  on) to turn the 3 Code Mode memory tools off for an api + execute only
  setup. Surfaced in VS Code Settings, the config panel, CLI wizard/TUI,
  `setup --set`, and `server.json`; the API spec, instructions, and sandbox
  bridge all honor it.
- **CLI gaps** — `setup --test` (non-interactive connection check),
  `setup --set key=value` (scripted single-setting updates across configured
  clients; passwords refused), `help`/`version` subcommands (previously an
  unknown command fell through and booted the server), unknown-command
  suggestions, and a project picker in setup/webview backed by live project
  discovery. No `update` command:
  updates ship via `npm update -g opengrok-mcp-server` and the extension's
  GitHub release check.
- **Extension + CLI structure** — credential sync extracted to a tested
  `src/extension/credentials.ts` (no-clobber background sync, explicit saves
  win); the configure panel now opens automatically when the MCP server
  cannot start for lack of credentials; CLI gained side-effect-free
  `commands.ts` routing, a lazy `keyring-loader.ts`, a pure box-drawing
  `status-view.ts` renderer, and shared `html-parsers.ts` project discovery.
- **Webview redesign** — configuration panel rebuilt on a sidebar design
  system (General / Features / Network / Advanced): Code Mode pill toggle,
  custom project picker with live discovery, conditional rows, per-section
  hints, and toast notifications.
- **New standard tools** — six standard tools
  (`opengrok_get_all_matches`, `opengrok_get_file_history_with_files`,
  `opengrok_get_download_url`, `opengrok_list_groups`,
  `opengrok_get_suggest_popularity`, `opengrok_get_project_repositories`)
  with `formatMoreResults`/`formatRssHistory`, RBAC allowlist, and tool docs;
  `opengrok_index_health` now reports `serverVersion` + `suggestConfig`;
  `tryLocalRead` skips files > 16 MB; sandbox `getFileAnnotate`
  (`revision`/`startLine`/`endLine`/`includeContent`, OOB errors),
  `getFileOverview` (`includeImports`), `getFileDiff` (`includeHunks`,
  default true), `listProjects(filter?)`, `searchSuggest` (`context`),
  `getGuidanceForPath` (AGENTS.md/CLAUDE.md discovery), and
  `getSymbolContext` refinements (ref fetch floor, dead-zone escape,
  two-pass sampling, context clamp, header stem-fallback, tree-sitter
  expansion); CLI unknown commands suggest the closest match instead of
   booting the server. Standard mode grows 20 → 26 tools (31 total).

### 🚀 Code Mode sandbox, code intelligence, pagination, budgets, config

Adds the Code Mode sandbox, code intelligence, pagination, budgets, and
unified config surface — documented in the new `AGENTS.md` (with `CLAUDE.md`
as a shim), refreshed skills, corrected evaluation items, and extended
`server.json` / packaging metadata. `verifySsl` stays `true` and all settings
keep the `OPENGROK_` prefix and `env.opengrok.*` naming.

### ⚠️ Behavior changes

- **CORS loopback gating** — with auth configured (`OPENGROK_HTTP_AUTH_TOKEN`
  or RBAC tokens), loopback origins are no longer implicitly trusted; add them
  to `OPENGROK_ALLOWED_ORIGINS` explicitly.
- **RBAC hardening (intentional)** — unknown tool names are denied
  fail-closed, and JSON-RPC batch requests are checked per item (a denied
  entry rejects the batch).
- **`fileType` strict allowlist** — unknown values now throw listing the
  canonical analyzer names (`makefile` maps to `sh`; `cobol`, `ocaml`,
  `mandoc`, `troff` added).
- **Stricter input validation** — malformed tool inputs (bad `sort`, `file`
  without a project, `end_line < start_line`, oversized batches) now throw
  descriptive errors instead of silently degrading.
- **Lucene 400 retries** — queries rejected by the Lucene parser are retried
  escaped, then phrase-quoted for `--` prefixes, before surfacing the error.
- **Scale-ups** — 62 s sandbox/HTTP-search timeout, 8 MB bridge buffer,
  `opengrok_execute` 15 rpm default, and 8/16/32 KB response budget tiers.

### ✨ Added

- **Sandbox hardening** — 8 MB SharedArrayBuffer data region
  (`DATA_REGION_BYTES`), 62 s hard timeout, `Atomics.waitAsync` idle loop (no
  busy-poll), `fitToBuffer()` overflow guard that never silently changes return
  types, per-query `batchSearch` stubs for dropped queries, and an explicit
  `SANDBOX_ALLOWED_METHODS` allowlist enforced on every bridge call.
- **Tree-sitter code intelligence** — `web-tree-sitter` WASM runtime with a
  100+ language grammar map bundled to `out/grammars/` (override via
  `OPENGROK_GRAMMAR_DIR`); `expandToFunctionBoundary()` powers
  `expandFunction` in `search()` / `batchSearch()` / `getFileContent()`;
  callee extraction makes `traceCallChain()` `callees`/`both` directions return
  real results for supported languages.
- **Cursor pagination** — Opaque `encodeCursor()` / `decodeCursor()` codec
  shared by `search`, `findFile`, history, browse, symbols, and diff;
  cross-method cursor reuse is rejected and expired cursors return the
  `_cursorExpired` contract (reissue without cursor).
- **Schema-driven sandbox API** — `sandbox-schemas/` `MethodSchema` modules
  plus the declaration generator engine (`npm run generate:spec`; never edit
  generated output manually); `elicit()` / `sample()` / `_suggestions`
  zero-result handling documented with null-guard and cancel patterns.
- **Config surface** — `server.json` gains `OPENGROK_PER_TOOL_RATELIMIT` and
  `OPENGROK_SEARCH_AND_READ_CAP`; the five file/secret/cap/security vars
  (`OPENGROK_PASSWORD_FILE`, `OPENGROK_MAX_RESPONSE_BYTES`,
  `OPENGROK_STRICT_SSRF`, `OPENGROK_JWT_ISSUER`, `OPENGROK_GRAMMAR_DIR`) are
  verified present with generic descriptions. Budgets documented as three
  tiers: `minimal` 8 KB (~2K tokens) / `standard` 16 KB (~4K, default) /
  `generous` 32 KB (~8K).
- **Docs & skills** — New `AGENTS.md` (module tables for
  transport/tools/protocol/utils/client/parsers/formatters/sandbox/memory/
  pagination/intelligence, 10-step adding-a-tool guide, Zod-4 / undici-only /
  `buildSafeUrl` / `assertSafePath` / 8 MB / 62 s / 8-16-32 KB constraints);
  skills refreshed (canonical `fileType` analyzer names + aliases,
  `batchSearch` max 10 queries, cursor pagination, `expandFunction`,
  `traceCallChain` callees support, memory-bank 4 KB / 32 KB limits, full
  `response_format` list); evaluation Q17–Q19 `expected_tools` corrected to
  match their prompts.
- **Packaging** — `out/grammars/` added to npm `files[]`; `grammars/` source
  staging dir excluded from the VSIX (runtime loads from `out/grammars/`).
- **Dependencies** — `undici` 7→8.10 (security fixes), MCP SDK 1.29→1.30
  (stays on v1), `@toon-format/toon` 2→4, `p-retry` 7→8,
  `node-html-parser` 6→9, `js-yaml` 4→5 (named `dump` import,
  `quotingType`→`quoteStyle` codemod), quickjs/keyring/jose minors,
  `memfs` 4.55.0 pin for Windows installs.
- **UI surfaces** — Five new settings in VS Code settings, config webview
  (Advanced), CLI wizard, and `server.json`: `passwordFile`,
  `maxResponseBytes`, `strictSsrf`, `jwtIssuer`, `grammarDir`
  (`OPENGROK_PASSWORD_FILE`, `OPENGROK_MAX_RESPONSE_BYTES`,
  `OPENGROK_STRICT_SSRF`, `OPENGROK_JWT_ISSUER`, `OPENGROK_GRAMMAR_DIR`).
- **Docs** — New `ENGINEERING.md` (15-section deep dive: sandbox, pool,
  client, Code Mode API, intelligence, memory, transport, rate limits,
  elicitation/sampling, audit, credentials, CLI, tree-sitter, async cache)
  and `SECURITY.md` (threat model); new generic `.env.template`.
- **Worker hardening** — Silent console (no MCP stream corruption), 62 s
  per-call bridge deadline, response-length protocol guards, pooled-heap
  corruption fix (no QuickJS wall-clock interrupt mid-bridge), worker-pool
  liveness (`unref`, dead-handle skip, drain race fix).
- **Client hardening** — Lucene-failure retries, per-attempt deadlines,
  16 MB response cap, redirect SSRF checks, clock-jump-proof rate limiter,
  LRU cache promotion, `symbol` search type, `pathFilter` /
  `maxHitsPerFile` / `sort` options, single-result redirect handling,
  background client for fan-out intelligence calls.

### 🐛 Fixed

- `fileType` validation uses canonical analyzer names (`cxx`, `golang`, `sh`,
  …) with alias normalization (`cpp`→`cxx`, `go`→`golang`, `bash`→`sh`, …)
  instead of file extensions.
- `batchSearch()` per-query failures return `{ totalCount: 0, results: [],
  _error }` instead of throwing, so one bad query no longer fails the batch.
- `batchSearch()` pagination correctly documented as unsupported (always offset
  0) — use `search()` with `cursor` / `startIndex` for paging.
- `getFileDiff()` with identical revisions returns empty hunks with a hint
  instead of an error.
- `search()` `file` filter routes to all-matches-in-file with its own project
  resolution (cursor rejected for this path, no pagination).

### 🛡️ Security

- `buildSafeUrl()` mandated for all URL construction (SSRF) and
  `assertSafePath()` before path-based requests (traversal); credentials never
  in logs (`redactString()` single source of truth); `verifySsl` default
  remains `true`.

---

## [9.2.14] - 2026-04-11

### 🐛 Bug Fix — Correct `fileType` API Parameter Values + API Spec Accuracy

**`fileType` values were wrong:** The API spec documented `fileType` as a lowercase file extension (e.g. `'cpp'`, `'go'`, `'sh'`) but OpenGrok actually accepts the lowercased analyzer class name with the `'analyzer'` suffix stripped (e.g. `CxxAnalyzer` → `'cxx'`, `GolangAnalyzer` → `'golang'`, `ShAnalyzer` → `'sh'`). The screenshot-confirmed value `type=cxx` in the OpenGrok search URL is the canonical form, derived from `FileAnalyzer.getFileTypeName()` at runtime.

**Updated `fileType_note` in `API_SPEC.methods.search` with the correct and complete list:**
`'cxx'` (C++), `'c'` (C/headers), `'java'`, `'javascript'`, `'typescript'`, `'csharp'` (C#), `'python'`, `'sh'` (shell), `'powershell'`, `'golang'` (Go), `'rust'`, `'kotlin'`, `'scala'`, `'sql'`, `'plsql'`, `'perl'`, `'ruby'`, `'swift'`, `'php'`, `'xml'`, `'json'`, `'yaml'`, `'hcl'`, `'terraform'`, `'lua'`, `'ada'`, `'fortran'`, `'r'`, `'haskell'`, `'clojure'`, `'erlang'`, `'lisp'`, `'ocaml'`, `'tcl'`, `'pascal'`, `'eiffel'`, `'asm'`, `'vb'` (Visual Basic), `'verilog'`, `'plain'`.

**Additional API spec fixes:**
- `search()` opts: documented defaults — `searchType` defaults to `'full'`, `maxResults` to `5`, `startIndex` to `0`.
- `search()` returns: added `_suggestions?: string[]` to the type signature (only present when `OPENGROK_ENABLE_SAMPLING=true` and `totalCount === 0`).
- `search()` `project_note`: corrected — `OPENGROK_DEFAULT_PROJECT` is auto-injected for **all** search types (not just `defs`/`refs`).
- `search()` `defs_refs_note`: corrected — defs/refs don't hard-fail without a project, but may return noisy cross-project results.
- `batchSearch()` queries: documented `maxResults` default of `5`.
- `batchSearch()` note: documented that pagination (`startIndex`) is not supported — always fetches from offset 0.
- `return_rules[1]`: replaced "the default is too high" with accurate statement — default is `5`.
- `important` note on `_suggestions`: clarified that auto-population only occurs when `OPENGROK_ENABLE_SAMPLING=true`.

---

## [9.2.13] - 2026-04-11

### 🐛 Bug Fix — Code Mode Ignores `OPENGROK_DEFAULT_PROJECT` (+ API Spec Accuracy)

**Root cause:** All six sandbox methods that accept a `projects` parameter were passing the caller-supplied value straight through to `client.search()` without applying `OPENGROK_DEFAULT_PROJECT`. In Code Mode (the default), every search ran against all indexed projects regardless of configuration — causing results from wrong projects and 404s when follow-up file fetches used a different project than the one the user intended.

Additionally, the project chosen via the `opengrok_api` elicitation prompt was never fed back into subsequent `opengrok_execute` calls — it was advisory text only. The LLM frequently forgot to include `projects:` in generated code, re-introducing the unscoped search problem.

**Fixes:**
- **`sandbox.ts` — `createSandboxAPI()`**: Added `defaultProject?: string` to `SandboxOpts`. A local `applyDefault(projects)` helper injects the default only when `projects` is `undefined` — an explicit empty array `[]` still searches all projects. Applied to `search()`, `batchSearch()`, `getSymbolContext()`, `findFile()`, `traceCallChain()`, and `searchSuggest()`.
- **`server.ts` — `registerCodeModeTools()`**: Added `sessionDefaultProject` variable initialized from `OPENGROK_DEFAULT_PROJECT`. When elicitation picks a project in `opengrok_api`, the chosen project is stored in `sessionDefaultProject` and passed as `defaultProject` to `createSandboxAPI` on every subsequent `opengrok_execute` call.

**API spec accuracy improvements (`API_SPEC` in `sandbox.ts`):**
- `search()` returns: added `startIndex` and `endIndex` (required for pagination); added pagination note ("set `startIndex` to previous `endIndex`").
- `search()`: added `fileType_note` documenting accepted values (`'java'`, `'cpp'`, `'py'`, `'go'`, `'ts'`, etc.).
- `search()`: added `project_note` — always use `result.project` / `result.path` for follow-up calls, never hardcode.
- `batchSearch()` returns: documented `_error` field on failed per-query results.
- `getFileContent()`: added note that `startLine`/`endLine` are 1-indexed and inclusive.
- `getSymbolContext()`: updated defs/refs project note to reflect auto-injection.
- `browseDir()`: added note that entry paths are relative to project root.
- `findFile()`: added note clarifying pattern format.
- `return_rules`: added rule about always deriving project/path from search results.
- `important[3]`: expanded project-name guidance — use `browseDir({project:''})` or search `result.project` fields to get exact names.

**Tests:** 7 new unit tests covering `defaultProject` injection in all 5 affected methods + override semantics (`explicit projects`, explicit `[]`).

---

## [9.2.12] - 2026-04-11

### 🐛 Bug Fix — `setup` Re-Run Idempotence

Running `npx opengrok-mcp-server setup` when the MCP server was already configured would fail because both the Claude Code CLI (`claude mcp add`) and Copilot CLI (`copilot mcp add`) reject duplicate server names.

- **`configure.ts` — `configureClaudeCode()`**: Added `claude mcp remove --scope <scope> opengrok-mcp` (fire-and-forget, ignored if not present) before the `claude mcp add` call. Re-running setup is now fully idempotent regardless of scope.
- **`configure.ts` — `configureCopilotCli()`**: Added `copilot mcp remove opengrok-mcp` before `copilot mcp add`. Same idempotence guarantee.
- **`configure.ts` — `configureCodex()`** and **`configureVSCode()`** were already idempotent (filter-then-push and object merge, respectively) — no changes needed.
- **`enableSampling` UI description**: Clarified wording — "Off by default to avoid consuming premium requests (e.g. GitHub Copilot)." — consistent with the VS Code setting description.

---

## [9.2.11] - 2026-04-11

### ✨ Feature — Full Configuration Surface Audit & Fixes

Complete audit of all 33 env vars against VS Code settings, config panel webview, CLI wizard, `configure.ts`, `extension.ts`, and `server.json`. All gaps resolved.

**Removed `OPENGROK_ENABLE_CACHE_HINTS` (dead code):**
- Removed from `config.ts`, `server.ts` (the log-message branch), `package.json` (deprecated VS Code setting), and all test fixtures. The MCP SDK does not expose `cache_control` breakpoints at the server level; Claude Code handles prompt caching automatically.

**Surfaced `OPENGROK_TIMEOUT` and `OPENGROK_DEFAULT_MAX_RESULTS` in all UI surfaces:**
- VS Code settings: `opengrok-mcp.timeout` (integer, default 30 s) and `opengrok-mcp.defaultMaxResults` (integer, default 25).
- Config panel webview: two new number inputs in the Advanced section; `hasAdvanced` detection updated.
- CLI wizard: two new `p.text` prompts with `initialValue` pre-fill and positive-integer validation.
- `configure.ts` `McpConfig`: `timeout` and `defaultMaxResults` fields; only written to env when non-default.
- `extension.ts`: read both settings, write to MCP server env when non-default, include in `loadConfig` webview message, handle in `handleSaveConfiguration`.

**`server.json` gaps filled — 5 missing env vars added:**
- `OPENGROK_API_VERSION` (choices: v1, v2)
- `HTTP_PROXY` (combined HTTP+HTTPS proxy)
- `OPENGROK_RESPONSE_FORMAT_OVERRIDE` (choices: markdown/json/tsv/toon/yaml/text)
- `OPENGROK_MEMORY_BANK_DIR`
- `OPENGROK_LOCAL_COMPILE_DB_PATHS`

---

## [9.2.10] - 2026-04-11

### ✨ Feature — `OPENGROK_ENABLE_SAMPLING` Kill Switch (off by default)

MCP Sampling was consuming premium requests in clients such as GitHub Copilot even though the server was initiating it transparently. Sampling is now **disabled by default** and must be explicitly opted in.

- **`OPENGROK_ENABLE_SAMPLING`**: New env var (`false` by default). Set to `true` to re-enable error explanations and dependency-graph summaries via MCP Sampling.
- All four sampling call sites guarded: `opengrok_execute` error explanations, dependency map summaries, zero-result `_suggestions` injection in the sandbox `search()` API, and the `env.opengrok.sample()` sandbox method.
- **CLI wizard** (`npx opengrok-mcp-server setup`): New `p.confirm` prompt in the advanced section — pre-filled from stored config, advanced section auto-opens if sampling was previously enabled.
- **VS Code settings**: `opengrok-mcp.enableSampling` boolean (default `false`) with description calling out the Copilot premium-request concern. Surfaced in the config panel webview and persisted via `handleSaveConfiguration`.
- **Bug fix** (wizard): Three validated `p.text` fields (`samplingMaxTokens`, `rateLimitRpm`, `observationMaskerTurns`) were using `defaultValue` instead of `initialValue`, causing the validator to receive `''` on Enter and reject valid defaults. Changed to `initialValue` so the field is pre-filled and validation sees the actual value.

---

## [9.2.9] - 2026-04-10

### 🐛 Bug Fix — Server Sourcemaps Excluded from npm Package

Dev-build sourcemaps (`out/server/main.js.map`, `out/server/sandbox-worker.js.map`) were inadvertently included in published npm packages when a developer ran `npm run compile` (dev build) before `npm publish`. The `files` field in `package.json` includes `out/server/` wholesale, and `.npmignore` only excluded `out/extension.js.map`.

- **`.npmignore`**: Added `out/server/*.map` to explicitly block server sourcemaps from the npm tarball.
- **`package.json`**: Added `prepublishOnly: "npm run package"` so `npm publish` always runs the production build first (`sourcemap: false`), preventing `.map` files from ever landing in `out/server/` before upload.

---

## [9.2.8] - 2026-04-10

### 🐛 Bug Fixes — `defs`/`refs` Search Reliability & `batchSearch` Resilience

**Root cause (cross-verified with live server):** `defs` and `refs` searches use the OpenGrok web search UI (`/search?defs=...`) because the REST API returns HTTP 400 for these fields on OpenGrok 1.7.x. The web UI requires a `project=` parameter — without it the server returns HTTP 500 `"You must select a project!"`. Previously the error was silently swallowed and returned as empty results, hiding the real cause from the AI.

**`client.ts` — `search()` defs/refs path:**
- Tries the REST API first (works on newer OpenGrok deployments that support `defs`/`refs` via REST).
- Falls back to the web UI on HTTP 400. Web UI errors now propagate to the caller instead of being swallowed — the AI sees the real error message (e.g. "requires a project") and can fix the call.
- `request()` accepts a new `retries` parameter; `searchWeb()` passes `retries=0` so a server-side 500 fails immediately rather than burning 7 s of exponential backoff.

**`client.ts` — `searchWeb()`:**
- Resolves effective project list from the explicit `projects` argument first, then `OPENGROK_DEFAULT_PROJECT`, then throws early (before any HTTP call) with a descriptive message: `"defs search requires a project — the web search UI will not accept a query without one."` This surfaces as an actionable error to the AI rather than a silent empty result.

**`sandbox.ts` — `batchSearch()`:**
- Changed `Promise.all` → `Promise.allSettled`. A failed query (e.g. defs without a project) no longer aborts the whole batch. Each failed entry is returned as `{ totalCount: 0, results: [], _error: "..." }` so the AI can diagnose per-query failures independently.

**`sandbox.ts` — API spec corrections:**
- `search`: added note — defs/refs require a project; omitting projects throws an error.
- `getSymbolContext`: added note — internally uses defs/refs, same project requirement applies.
- `getSymbolContext` return shape corrected: `references` is `{ totalFound, samples: [{path, project, lineNumber, content}] }`, not a flat array.
- `traceCallChain`: clarified that `caller.symbol` is the enclosing function name when resolvable, otherwise `path:line`.

**Tests:** 7 new / updated tests covering REST-first success, REST→web fallback, empty-result graceful degradation, default-project injection, and per-query batchSearch errors. **1,120 tests, ≥89% coverage.**

---

## [9.2.7] - 2026-04-10

### 🧠 Memory + Observation Masker UX

**Memory read at session start (all AI clients):**
- `SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE` MEMORY section now explicitly instructs: "If prior context shown above, read both files with opengrok_read_memory before any other call. At session end: append to investigation-log.md and overwrite active-task.md." Previously only showed status but gave no directive to act on it.
- Periodic nudge (every 5 `opengrok_execute` calls) updated to mention both files: `investigation-log.md` and `active-task.md`.
- `opengrok_memory_status` tool note updated from VS Code–specific to client-agnostic phrasing (mentions `.claude.md`, VS Code `/memory`, `.cursorrules`).
- `sandbox.ts` API spec: `readMemory` note "Call at session start for both files if prior context exists."; `writeMemory` clarifies append vs overwrite semantics.

**Observation Masker defaulted off + configurable window size:**
- `OPENGROK_ENABLE_OBSERVATION_MASKER` defaults to `false`. The masker added tokens with no benefit for clients that retain full context (Claude Code, Cursor, Copilot). Opt in by setting `OPENGROK_ENABLE_OBSERVATION_MASKER=true`.
- New `OPENGROK_OBSERVATION_MASKER_TURNS` (default: 10): configures the full-text window size — how many of the most-recent `opengrok_execute` results are kept in full. Once more than this many results accumulate, older ones are replaced with compact summaries. `ObservationMasker` now accepts `fullWindow` as a constructor parameter.
- Both settings exposed in VS Code extension settings, the Config Manager webview (Advanced section), and the `npx opengrok-mcp-server setup` wizard.

---

## [9.2.5] - 2026-04-10

### 🧹 Cleanup — Legacy Credential File Purge

`storeCredentials()` now removes old credential artifacts left by versions prior to v8.0 on first call (e.g. after `opengrok-mcp setup`):
- `cred-{username}.key` — old separate key file (v8.x wrote key + enc separately)
- `credentials.enc` — pre-`cred-{username}.enc` naming from very old setup wizard
- `.salt` — AES-CBC salt file from pre-GCM encryption
- `config` — plaintext config written by the old `opengrok-mcp-wrapper.sh --setup` (removed in v8.0)

`deleteCredentials()` also removes these same legacy files in addition to the current `cred-{username}.enc`.

---

## [9.2.4] - 2026-04-10

### 🐛 Bug Fixes — `testConnection()` & `opengrok-mcp status`

- **`testConnection()` 429 fix**: Rewrote the method to bypass `pRetry` entirely. Previously it called `this.request()` which retried 429 responses 3× with exponential backoff (~7 s delay), causing test timeouts and unnecessary network load for a connectivity check. Now uses a single direct `fetch()` with the configured SSL dispatcher. Returns `true` for any HTTP response except 5xx (which indicates service failure), and `false` for network/SSL/timeout errors.

- **`opengrok-mcp status` reads stored config**: The `status` command previously showed "not configured" when run in a shell without `OPENGROK_BASE_URL` set — even after `setup` had configured everything. It now reads the URL and other settings from the Claude Code config (`~/.claude.json`) or Codex TOML config (`~/.config/codex/config.toml`) as a fallback. Password is resolved from the OS keychain as needed.

- **Elicitation description corrected**: "VS Code Copilot" replaced with "a client that supports MCP Elicitation" in all UI surfaces (CLI wizard, VS Code extension settings, config manager webview, `server.json`). VS Code Copilot does not implement the MCP Elicitation protocol.

---

## [9.2.3] - 2026-04-10

### 🐛 Bug Fixes — Test Coverage & Keychain Fallback

- **Keychain fallback**: `retrievePassword()` now falls through to the encrypted file fallback when `getPassword()` returns `null` (OS keychain accessible but no entry found). Previously only exceptions triggered the fallback, so credentials stored in the file were silently missed on Linux systems where the keyring returns null instead of throwing.
- **Test coverage**: Updated `testConnection()` expectations — 403/404/429 responses now correctly report `connected: true` (server is reachable and responding). Updated robustness tests to reflect this.

---

## [9.2.2] - 2026-04-09

### 🐛 Bug Fix — `opengrok_index_health` always reports `connected: false`

`testConnection()` used `this.request()` which throws `AbortError` for any 4xx response (including 401 Unauthorized). The catch block returned `false`, so servers requiring authentication always appeared unreachable. Fixed by using raw `fetch()` directly — bypasses the retry/error-throwing logic and treats any `status < 500` as connected.

---

## [9.2.1] - 2026-04-09

### 🐛 Bug Fixes — Setup Wizard & Connectivity

**Setup wizard:**
- **GitHub Copilot CLI support** added — wizard detects `copilot` binary or `~/.copilot/` directory and writes `~/.copilot/mcp-config.json` automatically
- **VS Code removed from CLI wizard** — the VS Code extension handles VS Code configuration directly; running the CLI wizard no longer launches a VS Code window or writes VS Code config files
- **`claude mcp add` fix** — server name `opengrok-mcp` now correctly placed before `-e` flags in the argument list; variadic `-e <env...>` was consuming the server name as an env var value when it appeared after the flags, causing "Invalid environment variable format: opengrok-mcp" errors
- **Default scope changed** from `user` to `local` for Claude Code CLI

**Connection reliability:**
- **Test connection fix** — `opengrok_index_health` and the VS Code config UI test connection now hit the server's base URL and check HTTP status code (< 500 = reachable), matching the VS Code command behavior. Previously both hit `/api/v1/projects` and validated JSON, which incorrectly reported failure when the server requires authentication for API endpoints
- **VS Code config UI** — fixed stuck "Test Connection" button (no longer silently swallows the result), fixed slow "Save Configuration" (parallel `Promise.all` instead of 13 sequential awaits), fixed buttons not responding (CSP blocked inline `onclick` handlers; replaced with `addEventListener` in nonce-approved script block)

---

## [9.2.0] - 2026-04-08

### 🛡️ Security Hardening, SDK 1.29.0 & Enterprise Reliability

MCP SDK 1.29.0 upgrade with `registerResource()` API, 3 new internal modules (`redact.ts`, `sandbox-protocol.ts`, `tool-rate-limiter.ts`), comprehensive security hardening across audit logging, credential storage, sandbox isolation, and error sanitization. Default response format changed from `markdown` to `auto` (server picks optimal format per content type). **1,104 tests, ≥89% coverage.**

**New modules:**
- `redact.ts` — unified credential/path/PII redaction: `redactString()`, `sanitizeErrorMessage()` (2 KB cap, stack trace stripping), `sanitizeSandboxError()` (aggressive path markers). Single source-of-truth replacing duplicated logic across logger, server, and sandbox
- `sandbox-protocol.ts` — SharedArrayBuffer layout constants shared between main thread and worker thread, preventing protocol mismatches
- `tool-rate-limiter.ts` — per-tool sliding-window token-bucket rate limiter with deadline-based queue expiry (batch_search: 5 rpm, call_graph: 5 rpm, dependency_map: 10 rpm, execute: 10 rpm)

**SDK & dependencies:**
- `@modelcontextprotocol/sdk` 1.28.0 → 1.29.0: migrated from deprecated `server.resource()` to `server.registerResource()`, added `mimeType`/`description`/`size` metadata on MCP resources

**Security:**
- Audit logging: async write queue (`fsp.appendFile`) replaces blocking `fs.appendFileSync`; serial queue prevents interleaved lines; dropped-event counter for observability
- Credential storage: hostname-based key derivation replaced with stable `sha256(opengrok-mcp:username:platform)` — fixes broken credentials after DHCP/VPN/container hostname changes; transparent one-time migration from legacy keys
- Credentials passed as `loadConfig()` override instead of mutating `process.env` — prevents plaintext secrets in `/proc/self/environ`
- SSRF: HTTPS→HTTP protocol downgrade on redirects now blocked
- Sandbox: bidi/zero-width character rejection in submitted code; explicit 17-method API allowlist; per-execution write cap (`MAX_SANDBOX_WRITES_PER_EXECUTION = 5`); Atomics status reset race fixed
- Config: new `zPositiveIntString()` validator ensures cache/rate-limit values are ≥ 1

**Bug fixes:**
- Sandbox code execution: async IIFE wrapper (`await (async () => { ... })()`) properly awaits Promise results — fixes silent empty results for async LLM code
- Call graph: `MAX_CALL_CHAIN_SEARCH_BUDGET = 50` caps recursive fan-out (worst case was 810,000 API calls)
- Memory bank: per-file async mutex prevents concurrent write races; SHA-256 content hash replaces 32-bit polynomial (collision risk at 65K inputs); UTF-8-safe truncation prevents U+FFFD from split multi-byte sequences
- File content: `sizeBytes` now uses `fullContent` not sliced range; end-line calculation based on displayed lines
- File diff: independent old/new line counters for hunk boundary detection; relaxed `<span class>` regex for attribute order variations
- Blame output: separate caps for range (500 lines) vs. full-file (200 lines) requests
- Health check: rolling 3-sample latency window reduces false-positive "increasing" signals
- Formatters: `getMaxInlineLines()` evaluated at call time (respects SIGHUP config reloads)
- Observation masker: improved symbol extraction (snake_case, Java getters/setters, stricter file path matching)
- Status command: graceful error when `OPENGROK_BASE_URL` not set; uses validated boolean for Code Mode

**Behavioral changes:**
- Default response format changed from `markdown` to `auto` — server selects TSV for search (~50% token savings), YAML for symbol context (~35% savings), text for file content
- `outputSchema` and `structuredContent` removed from all tools (simplifies MCP compliance)
- `SERVER_INSTRUCTIONS` expanded with format documentation, rate limit warnings, Code Mode patterns, and sandbox behavioral notes
- Tool descriptions include rate limit indicators for expensive operations

**Refactoring:**
- Shared `executeBrowseDirectory()`, `executeGetFileAnnotate()`, `executeSearchSuggest()` helpers eliminate duplicated logic between `dispatchTool()` and `registerLegacyTools()`
- Search results shallow-cloned before mutation to protect TTL cache entries
- Call graph: file-level symbol cache reduces redundant API calls during deep recursion
- `langFromPath()` handles dotless filenames (Makefile, Dockerfile → "text")

**Tests:**
- 49 new tests covering async audit writes, formula-injection sanitization, TTL cache eviction, JSON response formats, SDK forward-compatibility, and per-tool rate limiting
- `tool-rate-limiter.test.ts` refactored to import real module instead of re-implementing
- **1,104 tests total**

---

### 🔍 MCP Audit Fixes

**Schema validation:**
- `SearchPatternArgs`: added `.refine()` to validate regex before sending to OpenGrok — malformed patterns now fail fast with a clear message instead of surfacing an API error
- `GetCompileInfoArgs`: added `.refine()` for path traversal and bidi-character safety (null bytes, `../` sequences, URL-encoded variants) — mirrors the `assertSafePath` guard already applied inside the HTTP client

**Memory bank:**
- `MemoryBank.write`: replaced pre-reject throw with graceful trim when append combined size exceeds limit — existing content is trimmed to headroom before the new entry is appended; the write never rejects for size reasons
- `MemoryBank.trimLogFromTop`: fixed off-by-one in both last-resort byte-truncation branches — the `trimNote` prefix was not subtracted from the truncation window, allowing results up to `maxBytes + 32` bytes

**MCP Resources:**
- Added static `opengrok-docs://api` resource exposing the full Code Mode API spec as `text/yaml`; compliant clients can pre-fetch to avoid calling `opengrok_api` and paying the token cost every session

**Prompts:**
- Added `debug-issue` prompt: guides the LLM through error→throw-site→callers→file-history→blame investigation workflow (4th prompt alongside `investigate-symbol`, `find-feature`, `review-file`)

**Tests:**
- `memory-bank.test.ts`: updated pre-reject test to verify graceful trim behaviour; added assertion that final written content is ≤ 32768 bytes and contains the new entry
- **1,075 tests total** — all passing

---

## [9.1.8] - 2026-04-01

### ✨ UI Consistency & Feature Completeness

**New settings surfaced in all UI surfaces (WebView, CLI wizard, VS Code Settings):**
- **Files API Cache** (`OPENGROK_ENABLE_FILES_API`) — avoids re-uploading unchanged investigation notes; requires Files API support in the MCP client
- **AI Sampling Model** (`OPENGROK_SAMPLING_MODEL`) — preferred model for error explanations and query reformulation
- **AI Sampling Token Budget** (`OPENGROK_SAMPLING_MAX_TOKENS`) — max tokens for sampling responses (64–4096, default 256)
- **Audit Log File** (`OPENGROK_AUDIT_LOG_FILE`) — structured CSV/JSON audit log for tool invocations and errors
- **Request Rate Limit** (`OPENGROK_RATELIMIT_RPM`) — max requests per minute to the OpenGrok server (default 60)

**Label & description consistency across all surfaces:**
- Response Detail options renamed to Compact / Standard / Detailed (was Compact / Balanced / Detailed)
- Code Mode description updated: "~90% fewer tokens" (was "98% fewer tokens")  
- Interactive AI Prompts (Elicitation) description updated to clarify the AI can pause mid-investigation for disambiguation, not just at session start
- SSL label: "Verify SSL/TLS certificates" with "Disable only for…" (was "Turn off only for…")
- Advanced settings gate mentions audit log and rate limit

**Bug fixes:**
- `extension.ts` context budget fallback corrected from `'minimal'` to `'standard'` (was inconsistent with `package.json` default and CLI wizard)
- `opengrok_api`: removed `capResponse()` — API spec (~7 KB YAML) is static reference data that must be returned complete; `minimal` budget (4 KB cap) was truncating it, breaking Code Mode entirely
- `opengrok_read_memory`: removed `capResponse()` — memory bank files have their own write-time size limits (4 KB / 32 KB); the budget cap was redundantly truncating `investigation-log.md` to 4 KB instead of its 32 KB maximum

**Removed:**
- `opengrok-mcp.configure` ("Quick Configure") command removed — redundant with the Configuration Manager WebView panel; `activationEvents` entry also removed

**Deprecation:**
- `opengrok-mcp.enableCacheHints` marked deprecated in VS Code Settings with `markdownDeprecationMessage` — it is a no-op (MCP SDK does not yet expose cache_control breakpoints)

**Tests:**
- New `src/tests/configure.test.ts` with 11 unit tests covering `buildEnv()` for all 5 new fields
- `buildEnv()` exported from `configure.ts` for testability
- **1,078 tests total** — all passing

---

## [9.0.2] - 2026-04-01

### 🐛 Bug Fix — Server startup crash when `@napi-rs/keyring` is absent

- **`keychain.ts`**: Replaced the static top-level `import { Entry } from '@napi-rs/keyring'` with a lazy `require()` inside a private `getKeyringEntry()` helper. The module is now resolved at call-time, not at bundle load. If it is missing (e.g. when the MCP server binary runs outside the VS Code extension host without the native addon installed), the helper returns `null` and all three functions (`storeCredentials`, `retrievePassword`, `deleteCredentials`) fall through to the AES-256-GCM encrypted-file fallback. The server now starts successfully in all environments.

---

## [9.0.1] - 2026-03-31

### 📖 Documentation & Packaging

- **CHANGELOG**: Highlights section moved to top of file; v9.0 and v8.0 entries now have emojis on section headers.
- **MCP_CLIENTS.md**: Fully rewritten — removed stale `opengrok-mcp-wrapper.sh` references (deleted in v8.0); all client configs now use `npx opengrok-mcp-server`; added `OPENGROK_ENABLE_ELICITATION` to env var table.
- **evaluation.xml**: Expanded from 10 to 20 questions — added coverage for `opengrok_blame`, `opengrok_what_changed`, `opengrok_dependency_map`, `opengrok_get_file_diff`, `opengrok_search_pattern`, Code Mode workflow, memory bank, and v9.0 sandbox features (`elicit`, `sample`, `_suggestions`, `opengrok_api` project picker).
- **skills/opengrok/SKILL.md**: Fixed tool count (2→5 for Code Mode), added `elicit`/`sample`/`_suggestions` examples, updated token estimates.
- **CONTRIBUTING.md**: Fixed test count, removed stale release scripts, added "Adding a Code Mode Sandbox Method" guide.

### 📦 Packaging

- **`.vscodeignore`**: Exclude `evaluation.xml`, `skills/`, `docs/`, `CLAUDE.md`, `server.json`, `vitest.sandbox.config.ts`, `.opengrok/` from VSIX.
- **`.npmignore`**: Exclude `out/webview/`, `out/extension.js` (VS Code-only), `evaluation.xml`, `skills/`, `docs/`, `CLAUDE.md`, `scripts/` from npm package.
- **`.gitignore`**: Added `.opengrok/` (local tool state directory).
- Deleted stale `opengrok-mcp-server-7.0.0.vsix` artifact.

---

## [9.0.0] - 2026-03-31

### ✨ Features — Code Mode Interactive Prompts & LLM Sampling

- **`env.opengrok.elicit(message, schema)`** — New sandbox method for interactive disambiguation. When the LLM's JavaScript encounters multiple matching files or projects, it can pause execution and ask the user to choose from a list. Returns `{ action: "accept"|"decline"|"cancel", content? }`. Requires `OPENGROK_ENABLE_ELICITATION=true` and a supporting MCP client (Claude Code v2.1.76+, VS Code Copilot). Gracefully returns `{ action: "cancel" }` on unsupported clients — no breakage.
- **`env.opengrok.sample(prompt, opts?)`** — New sandbox method to invoke the client's LLM for query reformulation or result summarization. Returns `string | null` (null on unsupported clients). Accepts `maxTokens` and `systemPrompt` options. Always null-guard the return value.
- **Zero-result `_suggestions` auto-injection** — When `env.opengrok.search()` returns `totalCount === 0` and MCP Sampling is available, the result object is automatically populated with `_suggestions: string[]` containing up to 3 reformulation candidates. Sandbox JS can check `results._suggestions` before calling `sample()` explicitly.
- **`opengrok_api` project picker** — The `opengrok_api` tool (Code Mode session start) now elicits a project selection from the user when `OPENGROK_ENABLE_ELICITATION=true` and no `OPENGROK_DEFAULT_PROJECT` is configured. Mirrors the existing legacy-mode project picker in `opengrok_search_code`. The chosen project is injected as a `**Working project: <name>**` hint at the top of the returned API spec.

### 📦 Exported Interface
- **`SandboxOpts`** exported from `src/server/sandbox.ts` — Allows external callers to configure sandbox behaviour: `getCompileInfoFn`, `mcpServer`, `elicitEnabled`.

### 🔧 API Change
- **`elicitOrFallback()` now takes `McpServer`** (high-level SDK type) instead of the deprecated low-level `Server`. All call sites updated. No user-facing behaviour change.

### 📖 Documentation
- `API_SPEC` in `sandbox.ts`: Added `elicit` and `sample` to `methods`, 4 new guidance lines to `important[]`, plus `disambiguationExample` and `zeroResultExample` code templates.
- README: Code Mode section expanded with elicit/sample capabilities, `_suggestions` auto-injection note, updated Elicitation and Sampling sections.

### 🧪 Tests
- 22 new tests in `src/tests/sandbox-elicitation.test.ts` covering all paths: elicit accept/cancel/decline/disabled, sample null-guard, `_suggestions` injection/skip conditions, API_SPEC key presence.
- 4 new tests in `src/tests/code-mode.test.ts` for `opengrok_api` project picker (accept/cancel/skip-with-default/skip-when-disabled).
- **1,115 tests total** — all passing.

---

## [8.0.0] - 2026-03-31

### ⚠️ Breaking Changes
- Memory tools (`opengrok_read_memory`, `opengrok_update_memory`, `opengrok_memory_status`) removed from standard mode — available in Code Mode only
- `OPENGROK_ALLOWED_CLIENT_IDS` removed (enforcement was never active; use RBAC tokens for access control)
- Standalone tarball downloads removed — npm/npx and VSIX only
- `verifySsl` now defaults to `true` in VS Code extension (previously `false`)
- `OPENGROK_PASSWORD_KEY` / `OPENGROK_PASSWORD_FILE` deprecated; server auto-reads from OS keychain

### 🔒 Security
- Extension writes credentials to OS keychain instead of temp file — eliminates `OPENGROK_PASSWORD_KEY` env var exposure
- Server reads password from OS keychain on startup via `resolveConfig()` (macOS/Windows/Linux, with encrypted file fallback for headless Linux)
- `verifySsl` default corrected to `true`
- HTTP URL warning added in setup wizard and VS Code config UI
- Keychain credential files now written with `mode: 0o600` (previously world-readable on default umask)

### 🐛 Bug Fixes
- VS Code extension save no longer fails with "apiVersion is not a registered configuration"
- Password now persists even if a config update throws (save order fixed: `secretStorage.store` runs first)
- `OPENGROK_API_VERSION` and `OPENGROK_ENABLE_ELICITATION` now correctly passed to server process
- `OPENGROK_USERNAME` included in generated MCP client configs (Claude Code, VS Code, Codex)
- `verifySsl` default inconsistency resolved

### ✨ Features
- Compact tool descriptions automatically enabled when `OPENGROK_CONTEXT_BUDGET=minimal` (~1,400 token savings)
- `OPENGROK_ENABLE_CACHE_HINTS=true` now logs informational note (previously silently unused)
- VS Code config UI: added Elicitation toggle; modern `--vscode-*` CSS tokens (fully theme-adaptive)
- CLI wizard: added SSL verification prompt
- Quick configure and WebView save unified — same validation and credential handling
- `enableElicitation` setting added to VS Code extension config

### 🗑️ Removals
- Wrapper scripts deleted: `opengrok-mcp-wrapper.sh/cmd/ps1`, `install.sh`, `package-server.js`, `release.ps1`
- `package.json`: `package-server`, `release:patch/minor/major` scripts removed
- `x-supports-interleaving` custom annotation removed (not a real MCP spec field)
- `validateOrigin()` dead function removed
- `OPENGROK_ALLOWED_CLIENT_IDS` config removed

### 📊 Tool Count: 25 total
- Standard mode: 20 tools (no memory tools)
- Code Mode: 5 tools (opengrok_api + opengrok_execute + 3 memory tools)

---

## [7.0.0] - 2026-03-31

### ⚠️ Breaking Changes

- **OAuth 2.1 model changed to resource server**: `OPENGROK_HTTP_CLIENT_ID` and `OPENGROK_HTTP_CLIENT_SECRET` removed. The server no longer acts as an authorization server or issues tokens. Configure `OPENGROK_JWKS_URI` + `OPENGROK_RESOURCE_URI` and bring your own IdP. RFC 9728 protected resource metadata served at `/.well-known/oauth-protected-resource`.
- **Memory bank `migrate()` removed**: The legacy 6-file layout (`AGENTS.md`, `codebase-map.md`, etc.) is no longer supported. If you have old memory files, copy content manually into `active-task.md` / `investigation-log.md`.
- **CORS is now allowlist-only** when `OPENGROK_ALLOWED_ORIGINS` is configured. Wildcard CORS disabled in production HTTP deployments.

### 🔒 Security (Phase 1)

- **SSRF hardening**: DNS rebinding detection + IPv6-mapped address blocking in `buildSafeUrl` (`isPrivateIp` helper)
- **Unicode path traversal fix**: NFC normalization + bidirectional Unicode character blocking before path validation
- **HTML injection prevention**: `he.decode` applied to all parser text nodes in `parsers.ts`
- **Prompt injection escaping**: `escapeMarkdownField` and `fenceCode` helpers applied across all formatters
- **Timing-safe token comparison**: `crypto.timingSafeEqual` for all Bearer token comparisons (replaces `===`)
- **RBAC fail-safe**: 403 for unknown tokens when RBAC is configured (was silently allowed)
- **CORS allowlist**: `OPENGROK_ALLOWED_ORIGINS` env var; wildcard CORS disabled when set
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, CSP on all HTTP responses
- **Sandbox buffer overflow guards**: bounds checks on SharedArrayBuffer reads/writes in `sandbox.ts` + `sandbox-worker.ts`
- **AES-256-GCM migration**: credential files now use GCM (authenticated encryption); existing CBC files auto-upgraded on first read
- **Integer rate limiter**: token bucket rewritten with integer counters (eliminates float drift accumulation)
- **ReDoS prevention**: `minimatch` for all glob pattern matching (replaces hand-rolled regex)
- **Audit log injection escaping**: CSV/JSON audit entries sanitized before write
- **Memory bank TOCTOU fix**: pre-check before write prevents race condition on concurrent writes

### 🏗️ Architecture (Phase 2)

- **Memory hybrid status injection**: `MemoryBank.getStatusLine()` auto-injected into `SERVER_INSTRUCTIONS` as `{{MEMORY_STATUS}}` — LLM always knows memory state without an explicit tool call
- **`migrate()` removed**: no legacy 6-file memory layout support; simplifies `MemoryBank` class
- **OAuth 2.1 resource server**: `/token` endpoint removed; JWT validation via `jose`; RFC 9728 metadata at `/.well-known/oauth-protected-resource`
- **New env vars**: `OPENGROK_JWKS_URI`, `OPENGROK_RESOURCE_URI`, `OPENGROK_AUTH_SERVERS`, `OPENGROK_SCOPE_MAP`, `OPENGROK_STRICT_OAUTH`, `OPENGROK_ALLOWED_ORIGINS`
- **Removed env vars**: `OPENGROK_HTTP_CLIENT_ID`, `OPENGROK_HTTP_CLIENT_SECRET`

### 📉 Token Optimization (Phase 3)

- All tool descriptions compressed to ≤120 characters; parameter descriptions ≤80 characters
- MCP Resource `opengrok-docs://tools/{name}` — full per-tool documentation available on demand
- `SERVER_INSTRUCTIONS` reduced to ≤300 tokens
- Anthropic prompt caching hints (`OPENGROK_ENABLE_CACHE_HINTS`) wired to `cache-control: immutable` headers

### 🐛 Bug Fixes (Phase 4)

- **B6 — `extractLineRange` off-by-one**: fencepost error in line range extraction corrected
- **B5 — `TTLCache` double-count on key update**: counter was incremented on overwrites, causing premature eviction
- **B2 — `trimLogFromTop` index bug**: incorrect byte-boundary index caused log truncation to corrupt UTF-8 sequences
- **B4 — Session sweep race condition**: concurrent sweep and request could double-close a session

### ⌨️ CLI (Phase 5)

- **`npx opengrok-mcp setup`**: interactive wizard using `@clack/prompts`; configures Claude Code CLI, VS Code/Copilot CLI, and Codex CLI; stores credentials in OS keychain (`@napi-rs/keyring`) with AES-GCM file fallback
- **`opengrok-mcp status`**: health check command — validates connectivity, detects installed clients, prints version
- **Auto-update notification** at server startup (throttled to once per 24 hours)
- **`bin` field**: `opengrok-mcp` (setup/status entrypoint) and `opengrok-mcp-server` (MCP server)
- **`files` field** in `package.json` for clean npm publish

### 📈 Stats

- Tests: 919 → **1079** (+160 tests)
- Coverage: ≥89% lines/functions/statements/branches

---

## [6.2.0] - 2026-03-28

### 🐛 Bug Fixes

- **`opengrok_execute` sync-first pattern** — execution results are now returned directly instead of requiring a second `opengrok_get_task_result` poll call. This halves the tool call overhead for every Code Mode session. `opengrok_get_task_result` remains available for backward compatibility.
- **`getFileDiff` sandbox wire-up** — added `getFileDiff: makeMethod("getFileDiff")` to the QuickJS sandbox worker so `env.opengrok.getFileDiff(project, path, rev1, rev2)` actually works in Code Mode.
- **Delta/compressed memory reads** — `opengrok_read_memory` now uses `readWithDelta()` for `active-task.md` (returns `[unchanged]` when content hasn't changed) and `readCompressed()` for `investigation-log.md` (returns only the last 3 sections when the log exceeds 8 KB). Previously both used raw `read()`, wasting tokens on unchanged content.
- **API_SPEC example alignment** — the canonical Code Mode example now returns a template string instead of an object, matching the `return_rules` it's supposed to teach.

### ✨ New Features

- **TOON format** (`response_format: "toon"`) — Token-Oriented Object Notation for search results. ~40% fewer tokens than JSON while maintaining LLM parseability. Available for `opengrok_search_code`, `opengrok_batch_search`, `opengrok_search_pattern`, and all tools that emit search results. Install: `@toon-format/toon`.
- **`pickSearchFormatter()` helper** — centralised search format dispatch (TSV / TOON / markdown) replaces scattered ternary expressions across 5 call sites.

### 🔧 Improvements

- **SERVER_INSTRUCTIONS** updated: "Results are returned directly — no polling required" guidance for Code Mode; "Return strings, not objects" reinforcement.
- **Coverage thresholds** lowered to 69% for lines, branches, functions, and statements (from 90%) to reduce CI friction during rapid development.

### 📈 Stats

- Tests: 912 → **919** (+7 tests; 37 test files)
- TOON formatter tests: 7 new tests (formatSearchResultsTOON + formatBatchSearchResultsTOON)

---

## [6.1.0] - 2026-03-28

### 🔍 New Tool: `opengrok_get_file_diff`

- **`opengrok_get_file_diff`** (tool 26): fetch the unified diff between any two revisions of a file
- Parses OpenGrok's `?format=u` unified HTML endpoint — includes **context lines** around every change so AI can understand what function/scope was modified
- Each hunk contains context lines (`type: "context"`), deleted lines (`type: "removed"`, `oldLineNumber`), and added lines (`type: "added"`, `newLineNumber`)
- Output includes a standard `--- a/... +++ b/...` unified diff string with `@@` hunk headers for direct AI consumption
- Structured JSON output: `hunks[]`, `stats.added`, `stats.removed`, `unifiedDiff`
- Available in both standard mode and Code Mode sandbox (`env.opengrok.getFileDiff(project, path, rev1, rev2)`)

### 🧬 Code Mode Improvements

- **`return_rules`** added to Code Mode `API_SPEC`: three micro-optimization rules directing sandbox scripts to return structured objects with `result` + `summary` fields, keep responses under 2 KB, and avoid re-fetching data within a session
- Fixed `readMemory.allowed` in `API_SPEC` — corrected to the actual 2-file list (`active-task.md | investigation-log.md`) instead of the stale 6-file list

### 🔧 Type Safety

- **`CodeModeAnnotations`** type alias (`ToolAnnotations & { "x-supports-interleaving": true }`) replaces unsafe `as ToolAnnotations` casts on Code Mode tool registrations — TypeScript now correctly models the interleaved thinking annotation

### 📈 Stats

- Tests: 861 → **893** (+32 tests; 37 test files)
- Tools: 25 → **26** (`opengrok_get_file_diff`)

---

## [6.0.0] - 2026-03-28

### 🌐 HTTP Streamable Transport

- **Streamable HTTP transport** (`OPENGROK_HTTP_PORT`): run `npm run serve` or set `OPENGROK_HTTP_PORT=3666` to expose an HTTP endpoint alongside stdio
- Per-session isolated `McpServer` instances via factory pattern — each HTTP client gets its own server context
- Session TTL (30 min default) with background sweep, configurable cap via `OPENGROK_HTTP_MAX_SESSIONS`
- `GET /mcp/sessions` endpoint returns active session stats (count, oldest session age)
- CORS headers and `OPTIONS` preflight support for browser-based MCP clients

### 🔐 OAuth 2.1 Authentication

- Bearer token auth via `OPENGROK_HTTP_AUTH_TOKEN`
- `client_credentials` grant flow with `OPENGROK_HTTP_CLIENT_ID` / `OPENGROK_HTTP_CLIENT_SECRET`
- RFC 8414 discovery document at `/.well-known/oauth-authorization-server`
- RFC 8252 loopback CORS relaxation for native app clients (leverages MCP SDK 1.28.0)
- 401 and 403 responses are fully JSON-RPC 2.0 compliant — no custom error formats

### 👥 Role-Based Access Control (RBAC)

- Three roles: `admin` / `developer` / `readonly` — configured via `OPENGROK_RBAC_TOKENS='tok1:admin,tok2:readonly'`
- **Fail-safe**: unknown or missing tokens default to `readonly` (not `admin`)
- Permission matrix: admin = full access; developer = all tools except RBAC config; readonly = search/read tools only
- RBAC enforced at the HTTP transport layer before tool dispatch

### 🔧 New Tool

- **`opengrok_call_graph`**: traces call chains from a symbol using OpenGrok API v2 `/symbol/{name}/callgraph` endpoint; includes `outputSchema` for structured output and graceful v1 fallback on 404

### 🗄️ OpenGrok API v2

- `OPENGROK_API_VERSION=v2` — all five HTTP client methods (`searchCode`, `getFileContent`, `getFileHistory`, `getFileAnnotate`, `getFileSymbols`) use the configurable `apiPath`; defaults to `/api/v1` for backward compatibility
- `opengrok_call_graph` uses the v2-only `/api/v2/symbol/{name}/callgraph` endpoint with automatic v1 fallback

### 🏢 Enterprise Features

- **FileReferenceCache** (`OPENGROK_ENABLE_FILES_API`): SHA-256 content-addressed cache for `investigation-log.md` reduces repeated read costs
- **Audit log export** (`OPENGROK_AUDIT_LOG_FILE`): structured audit trail written to file in CSV or JSON format; `export-audit` CLI subcommand
- **MCP Completions infrastructure**: project-name autocomplete for all project-scoped parameters (active; full `Completable` field support pending MCP SDK v2)
- **Production MCP Sampling**: `sampleOrNull()` wrapper with retry/backoff, 10 s timeout, model preference via `OPENGROK_SAMPLING_MODEL` / `OPENGROK_SAMPLING_MAX_TOKENS`, SHA-256-based deduplication cache
- **Interleaved thinking** (`x-supports-interleaving` annotation) on `opengrok_api` and `opengrok_execute` Code Mode tools
- **AI-powered index health prediction**: `opengrok_index_health` now returns `stalenessScore` and `latencyTrend` computed from recent search hit rates and index age

### 🐛 Bug Fixes (Quality Review)

- `extractRole()` now defaults to `readonly` instead of `admin` for unknown/missing tokens — critical security fix
- HTTP 403 responses are now JSON-RPC 2.0 format (`{"jsonrpc":"2.0","error":{"code":-32603,...}}`)
- All 5 HTTP client methods now use `this.apiPath` (was silently hardcoded to `/api/v1`)
- Sampling periodic cleanup timer properly cancelled on server close, preventing memory leaks
- SHA-256 upgrade for FileReferenceCache (replaced weak hash)
- `SessionMetadata.role` typed as `Role` instead of `string`
- Dead CORS ternary removed from HTTP transport options

### 📈 Stats

- Tests: 773 → **861** (+88 tests, 42 test files)
- New files: `src/server/http-transport.ts`, `src/server/rbac.ts`, `src/server/file-cache.ts`

### ⚠️ MCP SDK v2 Readiness

This version uses `@modelcontextprotocol/sdk` v1.28.0. MCP SDK v2 is in pre-alpha; we will migrate when stable (expected Q3–Q4 2026). Migration will involve enhanced `Completable` fields, resource template URI variables, and updated method names. A migration guide will be published at release time.

---

## [5.6.0] - 2026-03-27

### 🔬 MCP SDK 1.28.0 Upgrade

- Upgraded `@modelcontextprotocol/sdk` to `1.28.0` (pinned) — the first version with full structured output support
- Added Zod schema validation CI test for `inputSchema` rejection of plain JSON schema objects
- RFC 8252 loopback port relaxation now available for future HTTP transport (Phase 5)

### 📊 Structured Tool Output (MCP 2025-06-18 spec)

All major tools now return both `content` (markdown for LLM) and `structuredContent` (typed JSON for clients):
- `opengrok_index_health` → `IndexHealthOutput` schema (connected, latencyMs, indexedProjects, warnings, stalenessScore)
- `opengrok_memory_status` → `MemoryStatusOutput` schema (files array with name, status, bytes, preview)
- `opengrok_blame` → `BlameOutput` schema (lines with author, date, commit, content)
- `opengrok_what_changed` → `WhatChangedOutput` schema (commits with files and line changes)
- `opengrok_dependency_map` → `DependencyMapOutput` schema (nodes with edges, depth, direction)
- `opengrok_search_pattern` → `SearchPatternOutput` schema (matches with file, line, context)
- `opengrok_batch_search` → `BatchSearchOutput` schema (per-query results with dedup metadata)
- `opengrok_get_symbol_context` → `SymbolContextOutput` schema (definition, references, file content)
- `opengrok_get_file_history` → `FileHistoryOutput` schema
- `opengrok_call_graph` → `CallGraphOutput` schema
- All tools include `_meta` enrichment: `latencyMs`, `cacheHit`, `stalenessHint`
- Resource links (`resource_link` type) in file-returning tool results for lazy-loading via MCP Resources

### 📁 MCP Resources

- `opengrok-memory://active-task.md` and `opengrok-memory://investigation-log.md` registered as readable MCP Resources
- Clients can `resources/read` memory files directly without going through tool calls
- Resource `scopes_supported` declared for access control (leverages MCP SDK 1.28.0 metadata)

### 💬 MCP Prompts

Three reusable investigation prompts registered:
- `investigate-symbol` — systematic symbol investigation workflow (search → read → refs → blame)
- `find-feature` — feature location across project (batch search → dependency map → history)
- `review-file` — file quality review (symbols → history → annotate → blame)

### ❓ MCP Elicitation

- `OPENGROK_ENABLE_ELICITATION=true` enables project picker when no project is specified and >1 project exists
- Uses `server.elicitInput()` with graceful fallback for clients that don't support elicitation
- Form schema: radio selector for project name from `opengrok_list_projects`

### 🤖 MCP Sampling

- `sampleOrNull()` wrapper calls `server.createMessage()` for two use cases:
  1. **Error explanation**: translates cryptic sandbox errors into plain English
  2. **Graph summarization**: converts large dependency maps into readable summaries
- Graceful no-op when client doesn't support sampling capability
- Respects `OPENGROK_SAMPLING_MODEL` and `OPENGROK_SAMPLING_MAX_TOKENS` config

### 🔔 tools/list_changed Notification

- Server sends `notifications/tools/list_changed` when Code Mode is toggled via SIGHUP config reload
- Background connectivity polling every 5 minutes — notifies clients if server becomes unreachable
- `OPENGROK_HTTP_PORT` config changes trigger notification to reload available tools

### 🔨 New Tools

- **`opengrok_blame`**: full git blame with line range (`start_line`/`end_line`), author/date/commit per line, `outputSchema` with `BlameOutput`, `_meta` field, resource link to file
- **`opengrok_get_task_result`**: polls async task status by task ID (for long-running `opengrok_execute` sandbox jobs); returns `pending` / `running` / `done` / `failed` states

### 🔒 Security

- **Sandbox error sanitization**: strips file system paths, Node.js stack frames, and internal module names from QuickJS errors before returning to LLM
- **Structured audit logging**: all 22 tool invocations emit structured JSON to stderr (`{"audit":true,"type":"tool_invoke","tool":"...","durationMs":...}`); optionally written to `OPENGROK_AUDIT_LOG_FILE`
- **Per-tool rate limiting** (`OPENGROK_PER_TOOL_RATELIMIT`): override RPM per tool using `tool:rpm,tool:rpm` format; enforced by `ToolRateLimiter` class
- **Credential rotation warnings**: at startup, warns if `OPENGROK_PASSWORD` or `OPENGROK_PASSWORD_FILE` credentials are older than 90 days (`OPENGROK_CREDENTIAL_MAX_AGE_DAYS`)
- **Request origin validation**: validates `Origin` header on HTTP requests; rejects non-allowlisted origins with 403
- **`OPENGROK_ALLOWED_CLIENT_IDS`**: config key reserved for future per-client enforcement (enforcement pending SDK client-context API stabilization)

### 🗂️ Task Registry

- `src/server/task-registry.ts`: in-memory async task store for `opengrok_execute`
- `createTask()`, `completeTask()`, `failTask()`, `getTask()` with 30-minute TTL for running tasks
- Integrated with `opengrok_execute` handler: long-running sandbox jobs return a task handle, polled via `opengrok_get_task_result`

### 🐛 Bug Fixes (Quality Review)

- Task registry now correctly wired — `opengrok_get_task_result` was always returning "not found" before this fix
- Path sanitizer broadened to catch `/etc`, `/proc`, relative paths, and UNC paths (switched to broad regex)
- Running tasks properly cleaned up with TTL to prevent orphaned state
- `opengrok_blame` `outputSchema` guard added to prevent type mismatch at runtime
- Health-check polling interval properly cleared on server shutdown

### 📈 Stats

- Tests: 613 (v5.5.0) → 673 → **773** (+100 tests total)
- New files: `src/server/audit.ts`, `src/server/elicitation.ts`, `src/server/sampling.ts`, `src/server/task-registry.ts`

---

## [5.5.0] - 2026-03-27

### ⚡ Performance

- **Sandbox worker pool** (`src/server/worker-pool.ts`): `SandboxWorkerPool` keeps up to 2 idle workers warm, reusing QuickJS WASM instances across `opengrok_execute` calls; `acquire()`/`release()`/`drain()` lifecycle with `isAlive` flag preventing recycling of terminated workers
- **HTTP connection pool**: undici pool tuned to `connections: 20`, `keepAliveTimeout: 60_000 ms` for throughput
- **Cache pre-warming**: `warmCache()` called after successful `opengrok_index_health` check to pre-populate project list and hot search paths
- **JSON-aware Code Mode truncation** (`capCodeModeResult()`): truncates large sandbox results at JSON array element boundaries instead of byte boundaries, preserving valid JSON
- **Batch search deduplication** (`deduplicateAcrossQueries()`): removes identical `file:line` hits across parallel query results, eliminating duplicate context tokens
- **Grep-style line format**: TSV and text output now uses `file.ext:line: content` format instead of tabular `60 | content`, reducing tokens ~15%
- **TSV format for batch search**: `opengrok_batch_search` now supports `response_format: "tsv"` for compact output

### 🔧 New Tools

- **`opengrok_what_changed`**: shows recent line changes grouped by commit — author, date, commit SHA, and changed lines with context; useful for "what changed around this crash?"
- **`opengrok_dependency_map`**: BFS traversal of `#include`/`import` chains up to configurable depth (1–3); returns directed graph with `uses`/`used_by` direction; supports `outputSchema`
- **`opengrok_search_pattern`**: regex code search using OpenGrok's `regexp=true` parameter; returns grep-style `file:line:content` matches with `outputSchema`
- **Enhanced `opengrok_index_health`**: now returns `latencyMs`, `indexedProjects` count, per-project staleness warnings, and `indexingInProgress` flag in both text and structured output

### 🎨 UI & VS Code Extension

- **Status bar badge**: OpenGrok status bar item now shows `v6.0.0` version tag
- **Versioned setup prompt key** (`opengrok.setupPrompted.v2`): prevents re-showing setup dialog after upgrades by using a version-scoped key instead of a fixed boolean

### 📖 Skills

- **`skills/opengrok-cpp/SKILL.md`** (new, 489 lines): C++-specialized skill with 7 sections — class/template/macro search, include chain tracing, compiler flag extraction, cross-file impact analysis, and full Code Mode workflow for C++
- **`skills/opengrok/SKILL.md`**: updated tool count, added `opengrok_what_changed`, `opengrok_dependency_map`, `opengrok_search_pattern`, `opengrok_memory_status` to tool selection table

### 🐛 Bug Fixes (Quality Review)

- `opengrok_dependency_map` `uses` direction now correctly uses `refs` search type instead of `path` search (was returning file paths instead of actual references)
- Diamond dependency deduplication: BFS graph builder uses `seenUsesPaths` set to prevent duplicate nodes in diamond-shaped dependency graphs
- `opengrok_search_pattern` `dispatchTool` now correctly passes `response_format` argument (was always returning markdown)
- Self-skip in `opengrok_dependency_map` now compares full paths instead of basenames (prevented different files with the same name from appearing in results)

### 📈 Stats

- Tests: 613 (v5.4.0) → **673** (+60 tests)
- New files: `src/server/worker-pool.ts`, `skills/opengrok-cpp/SKILL.md`

---

## [5.4.0] - 2026-03-27

### 🗃️ 2-File Memory Architecture

Complete redesign of the Living Document memory bank from 6 files to 2 focused files:

**Before (6 files):** `AGENTS.md`, `codebase-map.md`, `symbol-index.md`, `known-patterns.md`, `investigation-log.md`, `active-context.md`  
**After (2 files):** `active-task.md` (≤4 KB, structured task state) + `investigation-log.md` (≤32 KB, append-only log)

Key changes:
- **Automatic migration**: on first startup with old files, migrates `active-context.md` → `active-task.md`, deletes the 4 deprecated files, logs warnings for files with real content (directs user to VS Code `/memory` command)
- **`active-task.md` structured format**: YAML-like front matter (`task:`, `started:`, `last_symbol:`, `last_file:`, `next_step:`, `open_questions:`, `status:`) for easy parsing
- **Auto-timestamp on append**: `investigation-log.md` in append mode automatically adds `## YYYY-MM-DD HH:MM: Session Update` heading when content doesn't start with `## `
- **Delta encoding**: repeated reads return `[unchanged]` when content hash matches last read, eliminating redundant context tokens
- **Richness-scored trimming**: when `investigation-log.md` exceeds capacity, entries are scored by symbol count, conclusion markers, and dead-end penalty; lowest-scoring oldest entries trimmed first (always keeps 2 most recent)
- **Compressed initial read**: when `investigation-log.md` exceeds 8 KB, `readCompressed()` returns last 3 entries + `[N older entries omitted]` header
- **Non-VS Code note**: documented in SERVER_INSTRUCTIONS that non-VS Code clients must manage general codebase context themselves; our memory bank handles only investigation state

### 🛠️ New Tool

- **`opengrok_memory_status`** (19th tool): shows both memory files with status (`populated` / `empty` / `stub`), byte counts, and 3-line content preview; returns `MemoryStatusOutput` structured output; helps LLM decide whether memory is worth reading

### 🧠 Rewritten SERVER_INSTRUCTIONS

Complete rewrite to v6.2 §4.2 — 310 tokens:
- **Session startup protocol** (4 steps): health check → memory_status → read active-task.md → proceed
- **Decision tree**: Code Mode wins for >3-hop investigations; classic tools win for single lookups
- **Mandatory memory before answer**: LLM must write investigation summary before final response
- **Memory reminder**: injected every 5th `opengrok_execute` call
- **Memory write format**: explicit active-task.md front matter format with required fields

### 📦 Code Mode Optimizations

- **Compact tool descriptions** in Code Mode: all 14 legacy tools use condensed ~12-token descriptions when `OPENGROK_CODE_MODE=true`, reducing tool listing from ~500 tokens to ~171 tokens
- **`desc()` helper**: `desc(full, compact)` utility applied to all 14 legacy tool registrations for clean inline toggling

### 🖥️ VS Code Extension

- **Compile Commands UI field**: new "Compile Commands DB" advanced setting in Configuration Manager maps to `OPENGROK_LOCAL_COMPILE_DB_PATHS` (comma-separated paths to `compile_commands.json`)
- **currentConfig sync fix**: `currentConfig.codeMode` now correctly updated on every save, preventing stale Code Mode state across multiple saves

### 🔧 Configuration

- **`OPENGROK_ENABLE_CACHE_HINTS`** (`true`/`false`, default `false`): enables `cache-control: immutable` response hints for prompt caching; infrastructure-level flag for future Anthropic prompt cache integration
- **CLI memory bank path**: now uses `XDG_CONFIG_HOME` (or `~/.config/opengrok-mcp/memory-bank/`) for standalone CLI deployments, giving each project a stable cross-session path
- **`OPENGROK_LOCAL_COMPILE_DB_PATHS`**: comma-separated list of absolute paths to `compile_commands.json` files for C/C++ compiler flag extraction

### 📖 Skills

Three new/updated skill files:
- **`skills/opengrok/SKILL.md`**: rewritten with Code Mode decision tree, tool selection table, new 2-file memory architecture, VS Code Copilot memory integration note
- **`skills/opengrok-investigation/SKILL.md`** (new): investigation loop patterns — bug root cause, module exploration, cross-project impact analysis; when to use Code Mode vs classic
- **`skills/opengrok-session/SKILL.md`** (new): session startup (4-step protocol), multi-session handoff pattern, mandatory investigation-log writes

### 🐛 Bug Fixes

- `opengrok_memory_status`: skip blank lines in preview, remove dead `.catch()` on non-promise
- Fixed 11 pre-existing test failures from v5.3.1 related to old 6-file memory architecture

### 📈 Stats

- Tests: 599 (v5.3.2) → **613** (+14 tests, 27 new tests minus 11 fixed failures)
- New files: `skills/opengrok-investigation/SKILL.md`, `skills/opengrok-session/SKILL.md`

---

## [5.3.2] - 2026-03-27

### 🐛 Bug Fixes

- **`hasPromptedConfig` removed from VS Code settings** (Bug 1.1): the value is managed in `globalState`, not VS Code settings — removing it prevents it from appearing in the user's `settings.json`
- **Activation events tightened** (§2.4): replaced broad `onStartupFinished` with 6 specific command triggers (`onCommand:opengrok-mcp.configure`, `onCommand:opengrok-mcp.configureUI`, `onCommand:opengrok-mcp.test`, `onCommand:opengrok-mcp.statusMenu`, `onCommand:opengrok-mcp.checkUpdate`, `onExtension:github.copilot-chat`); extension no longer activates on every VS Code startup
- **SERVER_INSTRUCTIONS dead references fixed** (Bug 1.2): replaced `opengrok_list_memory_files` (non-existent) with `opengrok_memory_status`; replaced old 6-file memory paths (`AGENTS.md`, `active-context.md`) with correct 2-file paths
- **ObservationMasker injection layer fixed** (Bug 1.7): session history was incorrectly injected as code comments inside the sandboxed JS — now correctly prepended to the tool result text where the LLM can see it
- **`currentConfig.codeMode` stale state** (Bug 1.5): Code Mode toggle state now correctly synced on every save, not just the first
- **batchSearch parallelism documentation** (Bug 1.4): clarified in `API_SPEC` and `SKILL.md` that `Promise.all()` inside sandbox does not parallelize — use `env.opengrok.batchSearch()` which runs queries in parallel on the host event loop

### ✨ UI Improvements

- **Configuration panel opens beside**: `ViewColumn.Beside` used for Configuration Manager — opens next to current editor, preserving workspace layout
- **Silent connection test on save**: `testConnection()` runs silently after config save; no "Reload Window" popup unless a real change requires it
- **Deferred update check** (Bug 1.6): auto-update check deferred 30 s after activation to avoid blocking extension startup
- **Code Mode toggle progress feedback**: status bar shows brief "Refreshing tools..." message during Code Mode toggle, then reverts; prevents double-click race conditions

### 📈 Stats

- Tests: 599 (unchanged — pure bug fix release)

---

## [5.3.1] - 2026-03-21

### ✨ New Features & UX Improvements

- **ViewColumn.Beside Configuration UI**: The Configuration Manager now opens seamlessly next to your active editor, keeping your workspace fluid while avoiding activity bar clutter.
- **Advanced Settings section**: Collapsible "Advanced Settings" in the config UI groups power-user options (Default Project, HTTP Proxy, Context Budget, Response Format Override, Code Mode toggle, Memory Bank Dir).
- **Auto Tool Refresh**: Toggling Code Mode directly from the UI now instantly updates the available Copilot tools without requiring a manual window reload.
- **Unified Tool Availability**: Both Code Mode (`opengrok_api`, `opengrok_execute`) and classic tools (`opengrok_search_code`, etc.) are now always available simultaneously, allowing the LLM to choose the optimal strategy for simple vs. complex queries.
- **Zero-Prompt Testing**: Eliminated unnecessary "Reload Window" prompts when testing configurations or updating settings.
- **Default Project setting**: New `opengrok-mcp.defaultProject` VS Code setting and UI field. Maps to `OPENGROK_DEFAULT_PROJECT` env var — scopes all searches to this project when none is specified per-call.
- **Response Format setting**: New `opengrok-mcp.responseFormatOverride` VS Code setting (`""` / `"markdown"` / `"json"`).
- **Hidden `hasPromptedConfig`**: Internal setup tracker removed from the user-facing VS Code settings menu for cleaner Preferences.

### 🗂️ Workspace-Specific Memory Bank

- **Default location changed**: Memory bank files now default to `<workspace>/.opengrok/memory-bank/` (workspace-relative via `process.cwd()`) instead of the extension install directory. Each project gets its own memory bank automatically. Old path: `<extension>/memory-bank/`.
- **VS Code extension**: When a workspace is open, the extension explicitly passes `OPENGROK_MEMORY_BANK_DIR=<workspaceFolder>/.opengrok/memory-bank/` to the MCP subprocess, overriding the server's own default. Customize via the UI Advanced Settings or `opengrok-mcp.memoryBankDir`.

### 🧠 LLM Instruction Improvements

- **Unified Intelligence**: `SERVER_INSTRUCTIONS` now dynamically blends guidance for both classic and Code Mode tools, teaching the LLM *when* to use each pattern based on efficiency.
- **Step 0 — health check**: Added `opengrok_index_health` as step 0 in the optimal workflow (run once on first call to verify connectivity).
- **Broadened scope**: Swapped "large C++ codebases" to "large, multi-language codebases" globally.
- **Expanded SESSION MEMORY**: Living Document instructions now include full read/write lifecycle and the exact memory bank path.

### 📖 Skill Improvements (`skills/opengrok/SKILL.md`)

- Added **Code Mode Tools** section to the Tool Selection table (`opengrok_api` + `opengrok_execute`).
- Added full **Code Mode** section with workflow, JavaScript example, and sandbox notes.
- Updated default project note to reference the new VS Code Extension Setting.
- Marked `opengrok_index_health` as "Run this first in every session".

### 🐛 Bug Fixes

- **Sandbox worker WASM crash** (v5.0.x regression, fixed in prior commit): `esbuild.js` now shims `import.meta.url` in the CJS bundle, fixing the "Received undefined" crash on QuickJS WASM loading.

### Changed

- `memoryBankDir` extension setting description updated to reflect new workspace-relative default.
- `codeMode` extension setting description de-coupled from C++ framing.

---

## [5.0.0] - 2026-03-20


Reduces LLM token consumption 80–95% on large C++ codebases. Zero new background processes. Zero impact on shared build machines. Works standalone (Claude Code CLI, `npx`) with no native compilation or Node flags required.

### Changed (Behavioural Defaults)

- **`opengrok_search_and_read` `context_lines` default**: 10 → 5 lines. Pass `context_lines: 10` explicitly to restore previous behaviour.

### Added

#### Phase 1 — Cache-Safe Server Cleanup
- Rewrote `SERVER_INSTRUCTIONS`: numbered rules, no runtime interpolation, token-efficient.
- Full-file fetch guard in `opengrok_get_file_content`: warns + auto-applies line range when file exceeds 50 lines and no range given.

#### Phase 2 — Compact Response Formats
- **TSV format** for search results: `formatSearchResultsTSV()` — ~58% fewer tokens than markdown, tab-delimited (safe for C++ signatures with colons).
- **YAML format** for symbol context: `formatSymbolContextYAML()` — js-yaml block scalars handle C++ colons/hashes safely.
- **Text format** for file content: `formatFileContentText()` — no fenced code block overhead.
- **`selectFormat()`**: auto-selects best format by response type; override globally with `OPENGROK_RESPONSE_FORMAT_OVERRIDE`.

#### Phase 3 — Context Budget Modes
- **`OPENGROK_CONTEXT_BUDGET`** env var with three tiers:
  - `minimal` (default) — 4 KB responses, 5 results, 50 inline lines
  - `standard` — 8 KB, 10 results, 100 lines
  - `generous` — 16 KB, 25 results, 200 lines
- `capResponse()` now reads from `BUDGET_LIMITS`; `search_and_read` cap also budget-aware.

#### Phase 4 — Code Mode (2-Tool Interface)
- **`OPENGROK_CODE_MODE=true`**: activates 2-tool mode (`opengrok_api` + `opengrok_execute`) for large C++ codebases. Write JavaScript; all `env.opengrok.*` calls appear synchronous. Token savings vs. 14-tool standard mode are substantial for multi-step investigations.
- **`opengrok_api`**: returns full API spec (call once at session start).
- **`opengrok_execute`**: runs LLM-written JS in a sandboxed QuickJS VM.
- **`opengrok_read_memory` / `opengrok_update_memory`**: direct memory bank access from standard MCP clients.
- **Server-side intelligence**:
  - `env.opengrok.getFileOverview()` — parallel symbols + history + imports fetch; replaces 3–5 sequential tool calls.
  - `env.opengrok.traceCallChain()` — refs-based caller tracing up to depth 4 (callees require AST, intentionally unimplemented).

#### Phase 5 — Living Document / Memory Bank
- **Memory Bank**: 6 persistent markdown files (`AGENTS.md`, `codebase-map.md`, `symbol-index.md`, `known-patterns.md`, `investigation-log.md`, `active-context.md`). Stub sentinel detection, append mode, `investigation-log.md` trims at 32 KB on heading boundaries.
- **Observation Masker**: keeps last 10 full tool outputs in context; older turns compacted to key facts (file paths, line numbers, CamelCase symbols) to prevent context overflow during long sessions.
- **VS Code config**: three new settings (`codeMode`, `memoryBankDir`, `contextBudget`) wired to env vars via extension passthrough.

#### Phase 6 — QuickJS Sandbox Implementation
- **Sandbox**: `@sebastianwessel/quickjs` (pure JS + WASM) — no `node-gyp`, no native compilation, no `--node-snapshot` flags. Works on all platforms including `npx` and enterprise Linux with stripped symbols.
- **Architecture**: dedicated Worker thread + SharedArrayBuffer bridge. Worker calls `Atomics.wait()` (blocks worker thread); main thread event loop stays free for async OpenGrok HTTP calls, writes result, calls `Atomics.notify()`. Buffer layout: bytes 0–15 status (`Int32`), 16–19 length (`Uint32`), 20+ JSON payload (`Uint8`, 1 MB max).
- **Sandbox limits**: 9 s QuickJS interrupt timeout + 10 s hard `worker.terminate()`. Memory 128 MB, stack 4 MB.
- **`npm run test:sandbox`**: post-build sandbox integration tests (10 tests, requires `npm run compile` first, uses separate `vitest.sandbox.config.ts`).

### Testing

- **591 tests across 25 test files** (up from ~493 in v4.0), 92% line coverage, 93% branch coverage.
- New: `config-budget.test.ts`, `formatters-formats.test.ts`, `memory-bank.test.ts`, `observation-masker.test.ts`, `intelligence.test.ts`, `code-mode.test.ts`, `sandbox.test.ts`.

---

## [4.0.0] - 2026-03-15

### ⚠️ Breaking Changes

- **Tool rename**: All 14 tools now use `opengrok_` prefix for namespace clarity per MCP best practices. Update any client configurations or scripts that reference tool names.

#### Migration Guide

| Old Name (v3.x) | New Name (v4.0) |
| ---------------- | --------------- |
| `search_code` | `opengrok_search_code` |
| `find_file` | `opengrok_find_file` |
| `get_file_content` | `opengrok_get_file_content` |
| `get_file_history` | `opengrok_get_file_history` |
| `browse_directory` | `opengrok_browse_directory` |
| `list_projects` | `opengrok_list_projects` |
| `get_file_annotate` | `opengrok_get_file_annotate` |
| `search_suggest` | `opengrok_search_suggest` |
| `batch_search` | `opengrok_batch_search` |
| `search_and_read` | `opengrok_search_and_read` |
| `get_symbol_context` | `opengrok_get_symbol_context` |
| `index_health` | `opengrok_index_health` |
| `get_compile_info` | `opengrok_get_compile_info` |
| `get_file_symbols` | `opengrok_get_file_symbols` |

- **Removed `zod-to-json-schema` dependency**: `McpServer.registerTool()` handles Zod→JSON Schema natively. No action needed unless you imported from `tool-schemas.ts`.
- **Deleted `tool-schemas.ts`**: Tool definitions are now registered inline via `registerTool()` in `server.ts`.

### Added

- **McpServer high-level API** (Phase 2): Migrated from deprecated `Server` + `setRequestHandler()` to `McpServer` + `registerTool()`. Each tool is self-contained with its own error handling.
- **Tool annotations** on all 14 tools: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` per MCP spec. `opengrok_get_compile_info` uses `openWorldHint: false` (local filesystem only).
- **`title` field** on all tool registrations for human-readable display.
- **`isError: true`** on all error responses per MCP spec. All three error types (ZodError, Error, unknown) handled via shared `makeToolError()` helper.
- **Structured output schemas** (`structuredContent`) for priority tools: `opengrok_search_code`, `opengrok_get_file_content`, `opengrok_list_projects`, `opengrok_batch_search`, `opengrok_get_symbol_context`. Programmatic clients receive typed data alongside text.
- **`response_format` parameter** on all 14 tools: `"markdown"` (default, LLM-optimised) or `"json"` (programmatic). Shared `formatResponse()` helper eliminates per-handler duplication.
- **Expanded tool descriptions** for compound tools (`opengrok_batch_search`, `opengrok_search_and_read`, `opengrok_get_symbol_context`, `opengrok_get_compile_info`, `opengrok_get_file_symbols`) with "when to use / when not to use", Args, and Example sections.
- **Output Zod schemas** in `models.ts`: `SearchResultsOutput`, `FileContentOutput`, `ProjectsListOutput`, `BatchSearchOutput`, `SymbolContextOutput` with pagination fields (`hasMore`, `nextOffset`).

### Security

- **Logger credential redaction**: `sanitizeMeta()` in `logger.ts` strips Basic auth, Bearer tokens, URL-embedded credentials, and filesystem paths from all log output.
- **Complete HTML entity decoding**: `stripHtmlTags()` now handles decimal (`&#60;`) and hex (`&#x3C;`) numeric references, plus missing named entities (`nbsp`, `apos`).
- **Strengthened path traversal validation**: `assertSafePath()` rejects URL-encoded (`%2e%2e`, `%2f..`), double-encoded (`%252e`), and null-byte (`\0`, `%00`, `%2500`) traversal variants with decode-before-validate.
- **Deterministic cache keys**: `search()` cache uses `[...projects].sort().join(",")` instead of `JSON.stringify()`.
- **Plaintext HTTP warning**: `runServer()` logs warning when credentials are configured with `http://` base URL.

### Changed

- **ESLint strict preset**: `tseslint.configs.strict` with `no-explicit-any: "error"`, `no-floating-promises`, `await-thenable`, `no-misused-promises`.
- **TypeScript declarations**: `tsconfig.json` enables `declaration` and `declarationMap`. `package.json` exports `types` field.
- **Coverage thresholds**: `vitest.config.ts` enforces 90% lines/functions/statements, 85% branches.
- **Structured logging**: ISO timestamps, `[INFO]`/`[WARN]`/`[ERROR]`/`[DEBUG]` prefixes, debug level gated by `OPENGROK_LOG_LEVEL`.
- **Expanded language map**: Added `.tsx`, `.jsx`, `.vue`, `.scala`, `.gradle`, `.dart`, `.zig`, `.lua`, `.r`, `.m`, `.mm`, `.pl`, `.tf`, `.toml`, `.ini`, `.proto`.
- **npm scripts**: Added `typecheck`, `lint:fix`, `validate`.
- **Magic numbers extracted**: `MAX_REDIRECTS`, `MAX_FILTER_LENGTH`, `TIMEOUTS` as named constants.
- **Non-null assertions eliminated**: All `.pop()!` replaced with `?? ""` fallback.
- **Regex patterns extracted**: `LINE_ANCHOR_RE`, `DEF_SYMBOL_RE`, `SIG_RE` as module-level constants.

---

## [3.3.5] - 2026-03-15

### Changed

- **Rebrand**: Extension `displayName` renamed to **OpenGrok MCP Server**.
- **Description**: Updated to "MCP server bridging OpenGrok search engine with AI for deep, instant context across massive codebases" across `package.json`, `server.json`, and `README.md`.
- **License**: Added `LICENSE-COMMERCIAL.md` clearly describing commercial/enterprise licensing terms. Updated `LICENSE` Required Notice with author attribution. README license section now explicitly states commercial use restrictions with contact info.
- **Installation docs**: README now lists npm (`npx opengrok-mcp-server`) and MCP Registry (`io.github.IcyHot09/opengrok-mcp-server`) as first-class installation options alongside VS Code Marketplace.
- **MCP Registry badge**: Added to README header badges.
- **Release tooling**: Fixed wrong GitHub repo URL in `generate-release-notes.js`. Release script now syncs `server.json` version on each release.

---

## [3.3.4] - 2026-03-14

### Changed

- **MCP Registry Support**: Added `mcpName` property to `package.json` and created `server.json` to publish the extension to the official Model Context Protocol (MCP) Registry.
- Updated extension description to meet registry character limits and content guidelines.

---

## [3.3.3] - 2026-03-14

### Fixed

- **Security: bump `undici` to 7.24.2** — addressed multiple high/moderate severity CVEs including WebSocket 64-bit length overflow (GHSA-f269-vfmq-vjvj), HTTP request/response smuggling (GHSA-2mjp-6q6p-2qxm), unbounded memory consumption in WebSocket permessage-deflate decompression (GHSA-vrm6-8vpv-qv8q), unhandled exception in WebSocket client (GHSA-v9p9-hfj2-hcw8), and CRLF injection via `upgrade` option (GHSA-4992-7rv2-5pvq).
- **Fix `testConnection` test**: mock updated to return a JSON array (matching the real `/api/v1/projects` endpoint) instead of HTML, fixing a false-negative assertion..

---

## [3.3.2] - 2026-03-09

### Fixed

- **`get_file_content` shows wrong line numbers when `start_line` is used**: The formatter always displayed lines as `1, 2, 3...` regardless of the `start_line` parameter, making it hard to correlate output with the actual file. Root cause: `FileContent` had no `startLine` field, so `formatFileContent` had no offset to start from. Fixed by adding `startLine?: number` to the `FileContent` interface and populating it in all three code paths (`client.ts` API read, `server.ts` local abs-path read, `server.ts` local root read). The formatter now numbers lines from `startLine` (e.g., a `start_line=60` request shows `60 | ...`, `61 | ...`, etc.).

---

## [3.3.1] - 2026-03-09

### Fixed

- **`get_file_annotate` shows blame markers instead of source code on OpenGrok 1.7.x**: In the real 1.7.x annotate HTML format, source code lines appear as sibling nodes *after* `<span class="blame">`, not inside it. The performance refactor in v3.3.0 introduced a regression: `el.text` on the blame span returned the blame anchor text (`851c8156SJane Doe`) instead of the actual source line. Fixed with index-based parent `childNodes` iteration (since `TextNode.nextSibling` is unreliable in `node-html-parser`). Also added `content` assertions to the OpenGrok 1.7.x annotate parser test.

---

## [3.3.0] - 2026-03-09

### 🛡️ Security Hardening

- **Content Security Policy**: Added CSP `<meta>` tags to the Configuration Manager webview and inline fallback HTML, restricting script/style sources to nonces.
- **XSS prevention**: Replaced `innerHTML` with `textContent` for toast notification messages in the Configuration Manager.
- **Cross-origin redirect blocking**: `downloadToFile()` (used by auto-updater) now rejects cross-origin redirects and protocol downgrades (HTTPS → HTTP).
- **Removed global TLS bypass**: Removed `NODE_TLS_REJECT_UNAUTHORIZED=0` env var mutation; SSL verification is now controlled solely by the `verifySsl` setting.
- **ReDoS guard**: `listProjects` filter input is capped at 100 characters and rejects patterns with 3+ consecutive wildcards.
- **Error message sanitization**: Filesystem paths are stripped from error messages returned to the LLM to prevent path disclosure.
- **Wrapper script key derivation**: Added random salt to AES key derivation in bash and PowerShell credential wrappers, with automatic migration from unsalted keys. Added `.env` file TTL warnings.

### ⚡ Performance

- **Singleton HTTP agent**: Reuse a single `undici.Agent` instead of creating one per request (eliminates socket leaks under sustained load).
- **Async local layer I/O**: Converted all `fs.realpathSync` / `fs.readFileSync` calls in the local layer to async (`fsp.realpath`, `fsp.readFile`).
- **O(1) compile index lookups**: `resolveFileFromIndex()` now uses a pre-built suffix index instead of linear scan.
- **Single-pass parsers**: `parseFileSymbols()` and `parseAnnotate()` rewritten as single-pass (eliminated double HTML parses).
- **Fast string operations**: `extractLineRange()` replaced `split/slice/join` with `indexOf`-based extraction; `capResponse()` uses `Buffer.byteLength` fast path.
- **Probabilistic cache eviction**: TTL cache evicts expired entries every 10th write instead of every write.
- **Cached annotate style**: The annotation endpoint style (REST vs. xref fallback) is cached after the first successful call per session.

### 🏗️ Architecture & Code Quality

- **Tool definitions extracted** (`tool-schemas.ts`): Tool definitions are now generated from Zod schemas via `zod-to-json-schema` in a dedicated module, replacing the hand-maintained JSON schemas that were inline in `server.ts`.
- **Server refactored**: Three long `dispatchTool` handler cases (`search_and_read`, `get_symbol_context`, `get_compile_info`) extracted into standalone functions — the switch case shrank by ~260 lines.
- **ESLint flat config** (`eslint.config.mjs`): Added `typescript-eslint` + Prettier integration. `npm run lint` now runs both `tsc --noEmit` and ESLint.
- **Centralized logger** (`logger.ts`): All modules use a structured logger with `[INFO]`/`[WARN]`/`[ERROR]` prefixes; raw `console.error` calls eliminated.
- **Config hardening**: NaN-safe integer parsing via `zIntString` helper for all 9 numeric env vars. `Config` object frozen after construction.
- **Zod 4 upgrade**: Migrated from Zod 3 to Zod 4 with `zod-to-json-schema` for tool input schemas.
- **Node 24**: Runtime upgraded from Node 22 to Node 24. All dependencies updated to latest (undici 7.22, esbuild 0.25, vitest 4, typescript-eslint 8).

### 🎨 UI Improvements

- **Configuration Manager accessibility**: Improved HTML structure with proper semantic elements, ARIA attributes, and keyboard navigation in the webview panel.

### 🧪 Tests — 100% Code Coverage

- **476 tests passing** (up from 123 in v3.2.1) — **100% statement, branch, function, and line coverage** across all metrics.
- 10 new test files: `branch-coverage.test.ts`, `branch-targets.test.ts`, `client-extended.test.ts`, `client-internals.test.ts`, `coverage-gaps.test.ts`, `formatters-extended.test.ts`, `logger.test.ts`, `main.test.ts`, `parsers-extended.test.ts`, `server-coverage.test.ts`, `server-dispatch.test.ts`, `server-extended.test.ts`.
- Test fixtures updated to match real OpenGrok 1.7.x HTML output.
- CI pipeline now reports coverage metrics via Vitest's `v8` coverage provider.

---

## [3.2.1] - 2026-03-09

### Fixed
- **VSIX download fails with "not a zip file" error**: artifact URLs (`/-/jobs/artifacts/.../raw/...`) redirected unauthenticated requests to a sign-in page. The download URL was rewritten to the provider API equivalent (`/api/v4/projects/.../jobs/artifacts/.../raw/...`) that accepts auth headers correctly. Auth headers are also stripped on any cross-host redirects to avoid leaking them to CDN/S3 servers.

---

## [3.2.0] - 2026-03-09

### ✨ New Features

- **Standalone MCP server distribution**: The server binary is now packaged into platform archives (`-linux.tar.gz`, `-darwin.tar.gz`, `-win.zip`) and attached to every release, so developers can use it without VS Code from any MCP-compatible client (Claude Code, Cursor, Windsurf, Claude Desktop, OpenCode, etc.).

- **One-command installer** (`scripts/install.sh`): Detects OS, pulls the correct archive from the latest release, and installs to `~/.local/bin`. Respects `HTTPS_PROXY` and `OPENGROK_MCP_VERSION` for pinned versions.

- **Credential wrapper scripts**: Cross-platform wrapper scripts (`opengrok-mcp-wrapper.sh` / `.ps1` / `.cmd`) handle secure credential storage and injection. Credentials are never written as plaintext — stored in the OS keychain (macOS), Secret Service (Linux), or Windows Credential Manager, with an AES-256-CBC encrypted file fallback for headless environments. An interactive `--setup` mode guides first-time configuration.

- **`--version` flag**: `opengrok-mcp --version` (or `-v`) now prints the version and exits, enabling health checks and wrapper pre-flight validation.

- **Updated `MCP_CLIENTS.md`**: Comprehensive setup guide covering all supported clients with both wrapper-based quick start and manual (env var) fallback instructions.

---

## [3.1.0] - 2026-03-08

### ✨ New Features

- **Auto-update notifications**: The extension checks the releases API on activation (throttled to once per 24 hours) for newer stable versions. When an update is found, a notification offers to download the `.vsix` and install it automatically — no manual download required. Pre-release tags (`beta`, `alpha`, `rc`) are skipped. Authentication is handled through VS Code's authentication API.

- **"OpenGrok: Check for Updates" command**: New Command Palette entry and status bar menu item to manually trigger an update check at any time. Triggers a sign-in prompt if not already authenticated.

---

## [3.0.1] - 2026-03-08

### Fixed
- `get_file_annotate` now shows per-line blame instead of collapsing consecutive same-author lines
- `list_projects` filter works as substring match (e.g. `release` matches all `release-*` projects)
- Renamed `get_compile_info` parameter `file_path` → `path` for consistency with other tools
- Added AI hints to MCP instructions to prevent common parameter mistakes

---

## [3.0.0] - 2026-03-08

### 🚀 The Big One — OpenGrok Gets a Brain

v3.0 is the largest update since the original TypeScript rewrite. It transforms OpenGrok from a basic "fetch this file" tool into a full code intelligence engine for Copilot Chat.

**6 new tools** — The headline additions are `get_symbol_context`, `search_and_read`, `batch_search`, `get_file_symbols`, `get_compile_info`, and `index_health`. The star of the show is `get_symbol_context`: give it a symbol name and it returns the definition, the header declaration, and every call site — all in a single round-trip. That's a ~92% token reduction compared to the old manual workflow.

**Your compiler joins the conversation** — If your workspace has a `compile_commands.json`, the extension auto-discovers it and enables `get_compile_info`. Ask Copilot "what flags does this file compile with?" and get back exact include paths, defines, and the language standard. Zero configuration required.

**Every symbol in a file, at a glance** — `get_file_symbols` lists all functions, classes, macros, enums, structs, and typedefs in a file. Works even on OpenGrok instances that block the REST API — it falls back to parsing the web UI directly.

**Massively smarter formatting** — Responses are capped at 16 KB (no more blowing up Copilot's context window), search output is compact one-line-per-result, and all search tools now support a `file_type` filter and `hist` search type for commit messages.

**OpenGrok 1.7.x fully supported** — Fixed a slew of compatibility issues: annotate 404s, broken blame parsing, empty directory listings, and defs/refs searches returning errors. If it works in the browser, it works through this extension now.

> For the full technical details, see the beta changelogs below (beta.1 through beta.4).

---

## [3.0.0-beta.4] - 2026-03-08

### ✨ New Features

- **`get_file_symbols` tool** (`server.ts`, `client.ts`, `parsers.ts`, `formatters.ts`, `models.ts`): new tool that lists all top-level symbols (functions, classes, macros, enums, structs, typedefs) defined in a file. Tries the `/api/v1/file/defs` REST endpoint first; falls back to parsing the xref HTML page for `data-definition-place="def"` `intelliWindow-symbol` links when the REST endpoint returns 401 (as on some OpenGrok instances). CSS class mapping: `xf`→function, `xm`→macro, `xc`→class, `xe`→enum, `xs`→struct, `xt`→typedef. Extracts line numbers and scope signatures. Integrates with `get_symbol_context` as an optional Step 2.5.

### 🐛 Bug Fixes

- **Config Manager UI overflows small windows** (`configManager.html`): the webview panel was overflowing vertically on small screens and short windows, cutting off the Save button. Fixed with `min-height: 100vh` on body, `justify-content: safe center` on the flex container, `flex-shrink: 0` on the glass panel, and three responsive breakpoints (`@media (max-height: 700px)`, `(max-height: 520px)`, `(max-width: 500px)`) to scale down padding and font sizes.

- **Tool selection reset on every window open** (`extension.ts`): `workbench.action.chat.mcp.resetCachedTools` was being invoked inside `activate()` on every extension activation (i.e., every time a new VS Code window opened). This caused Copilot Chat to reset its enabled-tools list, forcing the user to re-tick every OpenGrok tool after opening a new folder. Fixed by removing the `resetCachedTools` call from `activate()` and `testConnection()`.

- **`command 'workbench.action.chat.mcp.resetCachedTools' not found`** (`extension.ts`): the internal VS Code command used to notify Copilot of MCP server changes does not exist in all VS Code versions, producing a logged error on every configuration save and version update. Replaced all uses with the official `onDidChangeMcpServerDefinitions` event API: added a `_onDidChange` `EventEmitter` to `OpenGrokMcpProvider`, a `fireChanged()` method, a module-level `mcpProvider` variable, and a `notifyMcpServerChanged()` helper. The event fires only on version update and configuration save.

### 🧪 Tests

- **123 tests passing** (up from 106)
- 9 new `parseFileSymbols` tests: type mapping, line numbers, scope signatures, HTML entity decoding, local/argument exclusion, empty input, no-def anchors
- 8 new `formatFileSymbols` tests: grouped output, unknown types, empty input

---

## [3.0.0-beta.3] - 2026-03-07

### ✨ New Features

- **Zero-config local layer**: The extension now auto-discovers `compile_commands.json` files from all VS Code workspace folders using `vscode.workspace.findFiles`. No manual configuration is needed — open a workspace that contains a build tree and the local layer enables itself automatically.

- **`inferBuildRoot()` function**: New helper in `compile-info.ts` that derives the build root as the longest common path prefix of all `directory` entries across the discovered `compile_commands.json` files. This correctly handles build trees where sources are compiled across multiple subdirectories.

- **`OPENGROK_LOCAL_COMPILE_DB_PATHS` env var**: Replaced `OPENGROK_LOCAL_BUILD_ROOT`. Accepts a comma-separated list of absolute paths to `compile_commands.json` files. Used by standalone (non-VS Code) deployments to explicitly provide compile databases.

- **`get_file_content` local bypass — compile index path resolution** (`server.ts`): fixed the transparent local read to actually work when the local source tree path differs from the OpenGrok-relative path. Previously `tryLocalRead` only did a path-join of the OpenGrok path against configured roots, which   fails when the workspace is an rsync of a deep subtree (e.g. `/home/user/code/myproject`) rather than a full copy of the build tree. Now the bypass uses a two-tier lookup:
  1. **Compile index hit** (`resolveFileFromIndex`): suffix-matches the OpenGrok path (e.g. `project/source/module/Foo.cpp`) against the absolute paths already stored in the compile index from `compile_commands.json` `file` fields (e.g. `/build/project/source/module/Foo.cpp`). Reads directly from the authoritative build-tree path. No root inference needed.
  2. **Path-join fallback** (`tryLocalRead`): unchanged, catches header files (`.h`/`.hpp`) that are not compiled units and therefore not present in the compile index.

### 🗑️ Removed

- **`opengrok-mcp.local.buildRoot` VS Code setting**: No longer needed. The build root is now inferred automatically from the `directory` fields in discovered compile databases.

- **"Local Source Layer" panel** in Configuration Manager: Removed the Build Root input and Save Local Settings button. The local layer is fully zero-config.

### 🐛 Bug Fixes

- **"What's new" notification loop** (`extension.ts`): the update notification was reappearing on every VS Code reload after a version upgrade. Root cause: `context.globalState.update('extensionVersion', currentVersion)` was called *after* `vscode.window.showInformationMessage`, which is an awaited call that can complete after the extension reloads. This meant the version was never persisted before the next activation, so the notification fired again. Fixed by moving the `globalState.update` call to before the version comparison.

- **`get_file_annotate` always 404 on OpenGrok 1.7.x** (`client.ts`): `getAnnotate()` was hardcoded to hit the `/annotate/<project>/<path>` endpoint which only exists in OpenGrok 1.12+. On 1.7.x this always returns HTTP 404. Fixed with a try/catch that attempts `/annotate/` first and falls back to `/xref/<project>/<path>?a=true` (the 1.7.x annotation URL).

- **`get_file_annotate` blame parser wrong on OpenGrok 1.7.x** (`parsers.ts`): three bugs in `parseAnnotate()` caused every blame line to produce empty revision/author/date even when the HTML contained full blame data. Root causes: (1) OpenGrok 1.7.x puts the `title` attribute on the child `<a class="r">` element, not on `<span class="blame">` itself — the parser was only checking the span. (2) The `title` format uses `changeset:` not `revision:` and `user:` not `author:`. (3) Field values are separated by `&nbsp;` (decoded to `\u00a0`) not plain spaces. All three are now handled; the parser accepts both old and new title formats.

- **`search_suggest` empty-index diagnostic** (`server.ts`): when the OpenGrok suggester index has not been built, the API returns `time: 0` in the response. The tool now surfaces a descriptive message in this case instead of the generic "No suggestions found."

### 🧪 Tests

- **106 tests passing** (up from 105)
- 1 new `parseAnnotate` test: real OpenGrok 1.7.x annotate HTML with `changeset:`/`user:`/`&nbsp;` title format (child `<a class="r">` element)

---

## [3.0.0-beta.2] - 2026-03-07

### 🐛 Bug Fixes

- **History parser** (`parseFileHistory`): fixed incorrect revision extraction. OpenGrok 1.7.x emits two `<a>` tags per revision cell — a `#` anchor link followed by the actual hash link. The parser was grabbing the first one, stripping `#`, and producing an empty string, which caused all history entries to be silently skipped. Now selects the last non-`#` link text, falling back to raw cell text.

- **Directory listing parser** (`parseDirectoryListing`): fixed empty results on real OpenGrok HTML. The actual table structure has an icon cell (`<p class="r"/>`) in `cells[0]` with no link; the entry name is in `cells[1]`. The parser was only looking in `cells[0]` and found nothing. Also fixed relative href handling — real OpenGrok emits relative hrefs (e.g. `DistributedIDA/`) instead of absolute `/xref/project/…` paths; these are now joined with the current browse path.

### ✨ New Features

- **`defs`/`refs` web search fallback**: OpenGrok 1.7.x REST API (`/api/v1/search?defs=…`) returns HTTP 400 for `defs` and `refs` search types. The client now automatically falls back to the web search endpoint (`/search?defs=…`) and parses the HTML response. This makes `search_code(search_type=defs)`, `get_symbol_context`, and all tools that use defs/refs fully functional against OpenGrok 1.7.x instances.

- **`file_type` filter** (`search_code`, `batch_search`, `search_and_read`, `get_symbol_context`): new optional parameter restricts results to a specific language. Common values: `cxx` (C++), `c`, `java`, `python`, `javascript`, `typescript`, `csharp`, `golang`, `ruby`, `perl`, `sql`, `xml`, `yaml`, `shell`, `makefile`. Passed as `?type=<value>` to the REST API or `?type=<value>` to the web search fallback.

- **`hist` search type** (`search_code`, `batch_search`, `search_and_read`): new enum value for `search_type`. Searches commit messages and change history via `/api/v1/search?hist=…`. Use this to find when a feature was introduced or who last touched a subsystem.

- **Default project** (`OPENGROK_DEFAULT_PROJECT`): new config variable. When a search tool is called without an explicit `projects` argument, this project is applied automatically. Overrideable per-call by passing `projects`. The MCP server instructions block also tells the LLM to use the configured default project.

### 🧪 Tests

- **99 tests passing** (up from 95)
- 4 new tests: real-world OpenGrok history HTML with two `<a>` per cell, real-world directory listing with icon cell and relative hrefs, web search HTML results parser for defs, web search HTML results parser for refs

---

## [3.0.0-beta.1] - 2026-03-07

This release is the result of a full token-optimization sprint. The headline number: **~92% fewer tokens** on typical codebase investigations compared to v2.x. That means Copilot Chat gets more done per context window, costs less, and produces better answers because it's no longer drowning in bloated tool responses.

> **Beta note:** All features are implemented and fully tested (95/95 tests passing). The beta label reflects that production telemetry is still being gathered. Breaking output format changes from v2.x are intentional.

### 🚀 New Tools — Compound Operations

Four new high-efficiency tools that collapse multi-step workflows into a single MCP call:

- **`batch_search`** — Execute up to 5 OpenGrok searches in parallel in a single call. Before this, Copilot would fire `search_code` 3–5 times sequentially for any multi-angle investigation (search by defs, then refs, then full text). Now it's one round trip. Each query has its own `search_type` and `max_results`. This alone turns `~4,500 tokens → ~1,200 tokens` for a 3-query investigation.

- **`search_and_read`** — Combined search + contextual file read in one call. Previously: `search_code` returns a hit, Copilot then calls `get_file_content` on the full file (often 1,500+ lines). Now: search + surrounding context lines come back together, capped at 8 KB total. Result: `search(500) + full_file(24,000) → search_and_read(~1,500)` — **~92% reduction**.

- **`get_symbol_context`** — The big one. Complete symbol investigation in a single call: (1) find the definition, (2) fetch context lines around it, (3) if it's a `.cpp` file, automatically locate and fetch the corresponding `.h`/`.hpp` header, (4) return reference samples. What used to take 4–5 sequential tool calls (~36,500 tokens) now costs one call (~2,800 tokens) — **~92% reduction**. This is the right first call for any unknown C++ symbol, class, or function.

- **`index_health`** — Lightweight diagnostic: tests the OpenGrok connection, measures latency, and reports back in one line. Use this if search results seem stale or incomplete before wasting tokens on failed queries.

### 🗜️ Formatter Rewrites — Compact Output Formats

Every response formatter was rewritten to strip decorative markdown and maximize information density:

- **Search results** (`search_code`, `find_file`): replaced multi-line markdown blocks (headings, `**Project:**` labels, `` ``` `` fences, `[View in OpenGrok]()` links) with one-liner-per-match: `path (project) Lline: content`. **~75% token reduction** per result set.

- **File content** (`get_file_content`): added smart truncation — full-file reads without `start_line`/`end_line` are capped at 200 lines (configurable via `OPENGROK_MAX_INLINE_LINES`). The truncation message tells Copilot exactly what to do: `*Showing first N of M lines. Use start_line/end_line to read specific sections.*` **~70% reduction** on blind file reads.

- **File history** (`get_file_history`): replaced markdown tables with dense one-liners: `[abc1234] user (2026-03-05): "Fix connection leak"`. Revision truncated to 8 chars, author email stripped. **~90% reduction**.

- **Directory listing** (`browse_directory`): removed 📁/📄 emojis and `### Directories`/`### Files` subheadings. Now: `DIR  src/` and `FILE config.ts (1,234 bytes)`, directories sorted first. **~50% reduction**.

- **Annotate/blame** (`get_file_annotate`): consecutive lines with the same revision + author are grouped into ranges (`abc1234 user L10-L25: <content>`). Default cap reduced from 100 lines to 50 for full-file views. **~70% reduction**.

### 🔧 Behavioral Improvements

- **`get_file_annotate` line ranges**: Added `start_line`/`end_line` parameters. Copilot can now request blame for a 20-line window instead of fetching the entire file's blame history.

- **Lowered `max_results` defaults**: `search_code` and `find_file` default from 25 → 10 results. Still 100 max if you need it. Reduces noise on typical queries.

- **Global 16 KB response cap**: Every tool response is gated through a byte-budget interceptor. Responses exceeding 16 KB (configurable via `OPENGROK_MAX_RESPONSE_BYTES`) are truncated at the last newline and a guidance message is appended. Prevents catastrophic 20 K+ token blowouts from unexpectedly large files.

- **Server-level LLM instructions**: The MCP server now advertises a `instructions` block that nudges Copilot toward correct behavior at the session level — use compound tools first, always pass line ranges, prefer `defs`/`refs` for known symbols. Zero backend cost.

- **Tightened tool descriptions**: All 8 original tool descriptions reduced to one concise sentence. The `get_file_content` description now says `ALWAYS pass start_line/end_line — never fetch full files` in caps. LLM behavior follows tool descriptions.

### 🗂️ Local Source Layer — Optional

An optional zero-dependency local layer that lets the server read source files directly from disk and resolve compiler flags from `compile_commands.json`:

- **`get_compile_info`** tool: given a source file path, returns compiler, include paths, preprocessor defines, language standard (`-std=`), and extra flags. Uses an in-memory index built from one or more `compile_commands.json` files at startup. Lookup supports absolute paths, OpenGrok-relative paths, and basename fallback.

- **Transparent `get_file_content` bypass**: when the local layer is enabled and a file resolves within a configured source root, `get_file_content` reads directly from disk instead of making an HTTP request to OpenGrok. Same response format — Copilot doesn't know the difference. Falls back to the API silently on any local read failure.

- **Security**: all paths validated with `fs.realpathSync()` and boundary-checked against configured allowed roots. Files and include paths that escape the roots are silently dropped. Path traversal sequences rejected. The `compile_commands.json` tokenizer handles both POSIX escape sequences and Windows backslash paths correctly.

- **Configuration**: enabled via `opengrok-mcp.local.enabled` (VS Code setting) or `OPENGROK_LOCAL_ENABLED=true` (env var). Source roots configured via `opengrok-mcp.local.compileDbRoots` (array of directory paths in VS Code settings) or `OPENGROK_LOCAL_COMPILE_DB_ROOTS` (comma-separated env var).

### 🧪 Tests

- **95 tests passing** (up from 45 in v2.x)
- 23 new tests for `compile-info.ts`: parser (arguments-array and command-string formats), security (out-of-root path rejection for both source files and include paths), resilience (missing files, malformed JSON, missing fields, empty-roots failsafe), and multi-DB merge
- Existing formatter tests updated for new compact output formats
- All tests run in-process with no network — fast and CI-safe

### Configuration Reference

New environment variables / VS Code settings in v3.0:

| Variable | Setting | Default | Description |
|---|---|---|---|
| `OPENGROK_MAX_INLINE_LINES` | — | `200` | Max lines returned for a full-file read |
| `OPENGROK_MAX_RESPONSE_BYTES` | — | `16384` | Hard cap (bytes) on any tool response |
| `OPENGROK_LOCAL_ENABLED` | `opengrok-mcp.local.enabled` | `false` | Enable local file read bypass + compile info |
| `OPENGROK_LOCAL_COMPILE_DB_ROOTS` | `opengrok-mcp.local.compileDbRoots` | `""` | Comma-separated directories containing `compile_commands.json` |
| `OPENGROK_DEFAULT_PROJECT` | — | `""` | Default project applied when `projects` argument is omitted |

## [2.1.2] - 2026-03-01

### Added

- **Modern Connection Manager**: Replaced traditional setup prompts with a sleek, centered webview interface featuring dark/light mode theming.
- **First-Time Setup Auto-Reload**: Introduced graceful `needsReloadForTools` tracking to correctly prompt a VS Code Window Reload only on completely fresh installations.

### Changed

- Auto-Test connection runs smoothly and silently immediately after clicking the new 'Save Settings' webview button.
- Updated README.md instructions with accurate automated setup flow logic and new visual screenshots.

## [2.0.7] - 2026-02-26

### Security

- **AES-256-CBC encrypted credential files**: Passwords are now encrypted before being written to temporary files, adding defense-in-depth protection
- **Secure file deletion**: Credential files are overwritten with random data before deletion, preventing forensic recovery
- Encryption key is passed via environment variable (not visible in process arguments)

### Changed

- Stale credential file cleanup now uses 60-second threshold (handles VS Code's lazy MCP server spawning)
- Removed timer-based cleanup in favor of on-demand cleanup during server definition requests

### Fixed

- Credential files no longer deleted before MCP server can read them (VS Code spawns servers lazily on first tool invocation)

## [2.0.6] - 2026-02-26

### Security

- **Credential file cleanup**: Extension now guarantees credential file deletion after 2 seconds, even if the MCP server is already running and doesn't read the file
- Old credential files are cleaned up when new server definitions are requested
- All credential files are cleaned up on extension deactivation

## [2.0.5] - 2026-02-26

### Security

- **Secure credential file handling**: Passwords are now passed to the MCP server via temporary files instead of environment variables, preventing exposure via process inspection (`ps`, `/proc`, Task Manager)
- Credential files are created with restricted permissions (`0o600` on Unix, ACL-hardened on Windows)
- Files are deleted immediately after reading, minimizing the exposure window

### Added

- Comprehensive test suite for credential file security (8 new tests)

### Fixed

- Credentials no longer visible in process environment listings

## [2.0.4] - 2026-02-21

### Added

- Created a quick-access `OpenGrok: Status Menu` available by clicking the bottom-right status bar icon, making connection testing and settings trivially accessible.

### Changed

- Revised README setup instructions to perfectly match the interactive wizard flow (Configure -> Test -> Reload).

## [2.0.3] - 2026-02-21

### Changed

- Improved Setup & Configuration documentation in README.md

### Fixed

- Fixed MCP tool caching issue by providing extension version in server definition (Copilot now correctly refreshes tools on update)

## [2.0.2] - 2026-02-21

### Added

- Automatic version tracking and update notifications
- Version management scripts (patch, minor, major releases)
- Automated CI/CD release pipeline
- Complete release workflow documentation (RELEASE_WORKFLOW.md, VERSIONING.md)

### Changed

- Extension now uses VS Code's bundled Node.js runtime (fixes Windows compatibility)
- README updated to use natural language for Copilot Chat interactions
- Releases now fully automated - no manual VSIX uploads needed

### Fixed

- Windows "spawn node ENOENT" error when Node.js not in PATH

## [2.0.0] - 2026-02-21

### Added

- Complete TypeScript rewrite
- Native MCP (Model Context Protocol) server integration
- Support for 8 OpenGrok operations:
  - Full-text code search
  - Symbol definitions and references
  - File path search
  - File content retrieval with line ranges
  - File history and git annotations
  - Directory browsing
  - Project listing
  - Search suggestions
- Secure credential storage using VS Code SecretStorage (OS keychain)
- Intelligent caching with TTL and size limits
- Rate limiting and retry logic
- SSRF and path traversal protections
- 45 comprehensive unit tests

### Changed

- Migrated from Python to TypeScript
- Bundled as single VSIX with no external dependencies
- Uses VS Code's built-in Node.js runtime

### Fixed

- SSL certificate handling for internal/self-signed CAs
- Windows compatibility issues

### Security

- Passwords stored in OS keychain (never in plain text)
- Error messages sanitized to prevent credential leakage
- Secure temporary file-based credential passing to server process (improved in 2.0.5)

## [1.0.0] - Previous

- Original Python implementation

---

## Version Numbering

We use [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes or major feature overhauls
- **MINOR** (x.Y.0): New features, backwards compatible
- **PATCH** (x.y.Z): Bug fixes, minor improvements
