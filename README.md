<div align="center">

<img src="images/icon.png" width="120" alt="OpenGrok MCP Server logo">

# OpenGrok MCP Server

**Code intelligence for any OpenGrok-indexed codebase — search, read, blame, symbol navigation, diffs, commit history, call graphs, dependency maps, and guided investigation. Optimized for token efficiency through Code Mode and AST-aware code reads.**

[![npm](https://img.shields.io/npm/v/opengrok-mcp-server?logo=npm)](https://www.npmjs.com/package/opengrok-mcp-server) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-blue)](https://registry.modelcontextprotocol.io) [![CI](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml) [![GitHub Release](https://img.shields.io/github/v/release/IcyHot09/opengrok-mcp-server)](https://github.com/IcyHot09/opengrok-mcp-server/releases)

</div>

---

## Quick Start

**Option 1 — VS Code Extension (recommended)**

Install **OpenGrok MCP** from the VS Code Marketplace, or search "OpenGrok" in the Extensions panel. The configuration panel opens on first launch — enter your OpenGrok endpoint, username, and password, then click **Save Settings** and reload when prompted.

The extension provides a visual configuration UI and manages the MCP server process automatically. No Python, external Node.js install, or manual environment setup required.

**Option 2 — npm / npx CLI**

```bash
npm install -g opengrok-mcp-server
opengrok-mcp setup      # interactive wizard: URL, credentials, MCP client registration
```

Or run without installing:

```bash
npx opengrok-mcp-server setup
```

Other CLI commands:

```bash
opengrok-mcp status      # health check: validates connectivity and detects installed MCP clients
opengrok-mcp setup --test                     # test the stored connection without the wizard
opengrok-mcp setup --set contextBudget=generous  # update one stored setting non-interactively
opengrok-mcp export-audit --format json --output audit.jsonl  # export the audit log
opengrok-mcp version     # print version and exit
opengrok-mcp help        # show all commands
```

Works with any MCP-compatible client (CLI or IDE). See [MCP_CLIENTS.md](MCP_CLIENTS.md) for config format and troubleshooting.

Credentials are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) with an AES-256-GCM encrypted file fallback for headless environments.

---

> [!TIP]
> **Automatic Updates** — The extension checks GitHub for new releases once per 24 hours and notifies you when one is available. Use **OpenGrok: Check for Updates** to check on demand.

---

## The Problem

Engineers working in large codebases face a specific gap when using AI coding assistants. The model's context window contains the file currently open, the conversation, and whatever has been manually shared — but a production codebase has structure, history, and cross-module relationships that exist entirely outside that window.

A symbol defined in one module and called from seventy others. A function whose behavior only becomes clear from the three commits that shaped it. An include chain stretching across a dozen directories. A call graph showing which components depend on a service before it gets refactored.

Without access to the code index, the model fills these gaps by guessing: it fabricates file paths, invents function signatures, misattributes changes to authors. The model is not wrong because it is unintelligent — it is wrong because it is isolated.

OpenGrok already solves this for human engineers. It indexes source in dozens of programming languages, maintains a full-text index across committed history, and exposes definition lookups, reference graphs, blame, directory traversal, and file history through a REST API. The problem was that AI tools had no way to reach it.

---

## How It Works

```text
┌──────────────────────────────────────────────────────┐
│  AI Client  (Claude, Copilot, Cursor, Codex …)       │
└─────────────────────┬────────────────────────────────┘
                      │  MCP  (stdio or HTTP)
┌─────────────────────▼────────────────────────────────┐
│  OpenGrok MCP Server  (Node.js)                      │
│  opengrok_api  ──── full API spec, once per session  │
│  opengrok_execute ─ run JavaScript in sandbox        │
│                                                      │
│  OpenGrok client ── search · symbols · blame · diffs │
└─────────────────────┬────────────────────────────────┘
                      │  HTTP (REST + web fallback)
┌─────────────────────▼────────────────────────────────┐
│  OpenGrok                                       │
│  search · symbols · call graphs · index health       │
└──────────────────────────────────────────────────────┘
```

The server exposes two primary tools. `opengrok_api` delivers the full API specification at session start. Every subsequent operation goes through `opengrok_execute`: the AI writes a JavaScript program using the `env.opengrok.*` object — `search`, `getFileContent`, `getFileAnnotate`, `getFileHistory`, `browseDir`, `getFileSymbols` — and submits it as a single execution.

Intermediate results stay inside the sandbox; only the final `return` value crosses back to the context window. A complete investigation — find the symbol, read the definition, check who changed it, trace the callers — is one script, not a sequence of round-trips with results flowing through the context between each. Token savings of 80–95% are typical for complex investigations.

All `env.opengrok.*` calls appear **synchronous** inside sandbox code — the QuickJS WASM VM bridges async HTTP calls transparently over a SharedArrayBuffer + Atomics channel (8 MB data region, 62 s per-call timeout, 62 s hard execution cap), while keeping the Node.js event loop free.

**Memory bank** — two files persist across turns and session restarts: `active-task.md` (4 KB) for current investigation state and `investigation-log.md` (32 KB) for append-only findings. Inside the sandbox: `env.opengrok.readMemory()` / `env.opengrok.writeMemory()`. See the [Memory Bank](#memory-bank) reference below.

---

## Reference

<details>
<summary>Tool Reference</summary>

31 tools total: **2–5 in Code Mode** (`opengrok_api` + `opengrok_execute`, plus 3 memory tools when `OPENGROK_ENABLE_MEMORY_TOOLS=true`) and **26 in standard mode** (`OPENGROK_CODE_MODE=false`).

### Primary Tools

| Tool | Purpose |
| ---- | ------- |
| `opengrok_search_code` | Full-text, definition, reference, path, and history search. Supports `file_type` filtering and `cursor` pagination. |
| `opengrok_find_file` | Locate files by name or directory pattern. Supports `cursor` pagination. |
| `opengrok_get_file_content` | Read source code. Use `start_line` / `end_line` for large files. |
| `opengrok_get_file_history` | Commit history for a file. Supports `cursor` pagination. |
| `opengrok_browse_directory` | View folder structure and contained files. Supports `cursor` / `limit` pagination. |
| `opengrok_list_projects` | List all indexed repositories. |
| `opengrok_get_file_annotate` | Line-by-line blame annotation. Supports `revision`, `start_line`/`end_line` range, `includeContent`. |
| `opengrok_get_file_symbols` | Extract classes, functions, macros, and structs from a file. Supports `cursor` pagination. |
| `opengrok_search_suggest` | Query autocomplete recommendations. Supports `context` passthrough for ranking. |

### Compound Tools

These merge multiple API calls into a single operation.

| Tool | What it replaces | Savings |
| ---- | ---------------- | ------- |
| `opengrok_get_symbol_context` | Search definition + read source + fetch headers + get references | ~92% fewer tokens |
| `opengrok_search_and_read` | Search + read surrounding context (cap: `OPENGROK_SEARCH_AND_READ_CAP`) | ~92% fewer tokens |
| `opengrok_batch_search` | 2–5 parallel searches, deduplicated results | ~73% fewer tokens |
| `opengrok_index_health` | Latency, connectivity, staleness score | Diagnostic |

### Investigation Tools

| Tool | Purpose |
| ---- | ------- |
| `opengrok_what_changed` | Recent line changes grouped by commit — author, date, SHA, changed lines with context |
| `opengrok_dependency_map` | BFS traversal of `#include`/`import` chains up to depth 3; directed graph with `uses`/`used_by` |
| `opengrok_search_pattern` | Regex code search; returns `file:line:content` matches |
| `opengrok_blame` | Blame with line range (`line_start` / `line_end`) and optional diff |
| `opengrok_call_graph` | Call chain tracing via OpenGrok API v2 (requires `OPENGROK_API_VERSION=v2`; refs-based fallback on v1) |
| `opengrok_get_file_diff` | Unified diff between two revisions with context lines |
| `opengrok_get_compile_info` | C/C++ compiler flags and include paths from local `compile_commands.json` |
| `opengrok_get_all_matches` | All matching lines in a file when search shows truncated hits |
| `opengrok_get_file_history_with_files` | Commit history with co-changed file lists via RSS feed |
| `opengrok_get_download_url` | Direct download URL for a file (no HTTP call) |
| `opengrok_list_groups` | Project groups (empty when admin auth required) |
| `opengrok_get_suggest_popularity` | Popular suggestions for a project field (empty when admin auth required) |
| `opengrok_get_project_repositories` | Repositories for a project (empty when admin auth required) |

*(Note: search tools support language filtering. Pass `file_type` using the canonical analyzer name — `cxx` for C++, `golang` for Go, `sh` for shell, `javascript` for JS. Aliases accepted: `cpp`/`c++`→`cxx`, `go`→`golang`, `bash`/`shell`→`sh`, `js`→`javascript`, `ts`→`typescript`, `cs`→`csharp`, `py`→`python`, `rb`→`ruby`, `rs`→`rust`.)*

**defs/refs/symbol fallback notes** — `defs`, `refs`, and `symbol` searches require a project scope (pass `projects` or set `OPENGROK_DEFAULT_PROJECT`); without one they may return too many cross-project hits. On instances where the REST endpoint returns an error or empty results for these types, the client automatically falls back to web-UI parsing so the LLM still gets answers. `opengrok_call_graph` needs API v2 and degrades to a refs-based view on v1.

</details>

<details>
<summary>Code Mode API</summary>

Set `OPENGROK_CODE_MODE=true` (the default). Call `opengrok_api` once at session start to receive the full API spec. All subsequent operations go through `opengrok_execute`.

All sandbox API calls are synchronous — flat globals (`search(...)`), no `await`. The `env.opengrok.*` object form (`env.opengrok.search(...)`) is equivalent.

**Search & Discovery**

| Method | Returns |
| ------ | ------- |
| `env.opengrok.search(query, opts?)` | Full text, defs, refs, symbol, path, hist. Opts: `searchType`, `projects`, `maxResults` (default 5), `startIndex`, `cursor`, `fileType`, `sort`, `maxHitsPerFile`, `dir`, `pathFilter`, `file`, `expandFunction` |
| `env.opengrok.batchSearch(queries[], opts?)` | One result-set per query (max 10), run in parallel on the host. Per-query `expandFunction: true` includes enclosing function context |
| `env.opengrok.findFile(pattern, opts?)` | `{ totalCount, results: [{project, path}], cursor? }` |
| `env.opengrok.searchSuggest(query, opts?)` | `{ query, field, suggestions, time }`. Opts: `field`, `project`/`projects`, `context` (other-field values for ranking) |
| `env.opengrok.getAllMatchesInFile(project, path, query, opts?)` | All matching lines in a file when search results show truncated hits. Also used automatically when `search()` is given a `file:` filter (no pagination) |

`search()` uses canonical file type names only (e.g. `cxx`, `golang`, `sh`) — see the alias list above. Pass `expandFunction: true` to expand matching results to their enclosing function body (adds host-side reads, up to 3 files per call).

**Cursor pagination** — Methods that return a `cursor` field (`search`, `findFile`, `browseDir`, `getFileSymbols`, `getFileHistory`, `getFileDiff`) support pagination. Pass the cursor back as `opts.cursor` on the next call to fetch the next page. If a cursor has expired (session restarted or too much time elapsed), the response contains `{ _cursorExpired: true }` — restart pagination from the beginning.

**Read & Navigate**

| Method | Returns |
| ------ | ------- |
| `env.opengrok.getFileContent(project, path, opts?)` | `{ project, path, content, lineCount, sizeBytes, startLine }`. Range reads expand to the enclosing function by default; pass `{expandFunction: false}` to keep the exact range |
| `env.opengrok.browseDir(project, path?, opts?)` | `{ project, path, entries, cursor? }` |
| `env.opengrok.getFileSymbols(project, path, opts?)` | `{ project, path, symbols, cursor? }` |
| `env.opengrok.getFileOverview(project, path, opts?)` | `{ lang, sizeLines, sizeBytes, imports, topLevelSymbols, recentAuthors, lastRevision }`. Pass `includeImports:true` to include imports (omitted by default) |

**History & Blame**

| Method | Returns |
| ------ | ------- |
| `env.opengrok.getFileAnnotate(project, path, opts?)` | `{ project, path, lines: [{lineNumber, revision, author, date, content}] }`. Opts: `revision`, `startLine`/`endLine` (OOB throws), `includeContent` (default true) |
| `env.opengrok.getFileHistory(project, path, opts?)` | `{ project, path, entries, cursor? }` (`maxEntries`, `cursor`) |
| `env.opengrok.getFileHistoryWithFiles(project, path, opts?)` | Commit history with co-changed file lists via RSS feed (`maxEntries`) |
| `env.opengrok.getFileDiff(project, path, rev1, rev2, opts?)` | `{ hunks, unifiedDiff, stats }`. `includeHunks:true` (default) keeps hunks; `false` returns `{unifiedDiff,stats}` only. Supports hunk-level cursor pagination |
| `env.opengrok.getGuidanceForPath(project, path, opts?)` | `{ guidance: [{path, scope, content, truncated}], missingCount, errorCount, incomplete, capped, searchedUpTo }` — AGENTS.md/CLAUDE.md discovery |

**Code Intelligence**

| Method | Returns |
| ------ | ------- |
| `env.opengrok.traceCallChain(symbol, opts?)` | Call chain tracing. `direction: 'callers'\|'callees'\|'both'`. ASYNC — may return `{status:'computing'}` on first call; retry the same call to collect the cached result |
| `env.opengrok.getSymbolContext(symbol, opts?)` | Definition + refs + headers combined. Definition expands to the full function body via tree-sitter |
| `env.opengrok.dependencyMap(project, path, opts?)` | Dependency graph: `uses` (imports) + `used_by` (references). ASYNC with fast-path — may return `{status:'computing'}`; retry to get the cached graph. `direction: 'uses'\|'used_by'\|'both'` |
| `env.opengrok.getCompileInfo(path)` | C/C++ compiler flags and include paths, or `null` when no local compile DB is configured |

`traceCallChain` callers come from refs search; callees come from tree-sitter AST analysis for supported languages (C/C++, Java, Go, Python, JS/TS, Rust, and more). Both long-running methods fan out over a **background client** — a rate-limit-free sibling connection with a short per-operation budget — so deep traversals don't consume the foreground rate-limit quota.

**System**

| Method | Returns |
| ------ | ------- |
| `env.opengrok.indexHealth()` | `{ connected, latencyMs, baseUrl, serverVersion?, suggestConfig? }` |
| `env.opengrok.listProjects(filter?)` | `{ projects }` — all indexed repositories (standard-mode equivalent: `opengrok_list_projects`) |
| `env.opengrok.readMemory(filename)` | Read `active-task.md` or `investigation-log.md` (`null` when uninitialized) |
| `env.opengrok.writeMemory(filename, content, mode?)` | `'overwrite'` (default) or `'append'`; max 5 writes per execution |
| `env.opengrok.elicit(message, schema)` | Ask the user to choose (requires `OPENGROK_ENABLE_ELICITATION=true`) |
| `env.opengrok.sample(prompt, opts?)` | Request AI text from the client's LLM (requires `OPENGROK_ENABLE_SAMPLING=true`; `null` when unsupported — always null-guard) |

**Example**

```javascript
// Example opengrok_execute code
const refs = env.opengrok.search("handleCrash", { searchType: "refs", maxResults: 5 });
const first = refs.results[0];
const content = env.opengrok.getFileContent(first.project, first.path, {
  startLine: first.matches[0].lineNumber - 5,
  endLine: first.matches[0].lineNumber + 10,
});
return { callerFile: first.path, code: content.content };
```

When `search()` returns **zero results** and sampling is enabled, `_suggestions: string[]` is automatically injected into the result — check it before calling `sample()` explicitly.

**Tree-sitter intelligence** — range reads and `expandFunction` expand matches to enclosing function bodies using tree-sitter AST analysis (WASM grammars, no host toolchain needed). Per-tier line budgets apply: `minimal` 200 lines, `standard` 400 lines, `generous` 600 lines. Override the grammar directory with `OPENGROK_GRAMMAR_DIR`; contribute new grammars via `npm run copy-grammars` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

**fitToBuffer truncation** — sandbox results that exceed the 8 MB bridge buffer are trimmed by `fitToBuffer()`, which keeps complete result elements rather than truncating mid-JSON. Trimmed results carry `_truncated: true` — narrow the query or page with `cursor` when you see it.

**Elicitation** (`OPENGROK_ENABLE_ELICITATION=false` to disable, default: `true`)

When enabled, `opengrok_api` prompts the user to select a working project at session start if no `OPENGROK_DEFAULT_PROJECT` is configured and more than one project exists. Sandbox code can also call `env.opengrok.elicit()` to ask the user to choose between multiple matches during execution. Requires a client that supports MCP Elicitation — Claude Code v2.1.76+ supports this. Degrades gracefully to `{ action: "cancel" }` on other clients.

**Sampling** (`OPENGROK_ENABLE_SAMPLING=true`, default: `false`)

Delegates LLM calls back to the client via MCP Sampling, using the client's model subscription without separate API keys. Triggers automatically in three places: sandbox error explanation, large dependency graph summarization (>10 nodes), and zero-result query reformulation (`_suggestions` injection). VS Code Copilot supports sampling; other clients vary. The server degrades gracefully when sampling is unavailable.

> [!WARNING]
> Sampling triggers are automatic — not on-demand. A single investigation session can generate many sampling calls across sandbox errors, zero-result searches, and large dependency graphs. Some clients consume premium requests per call after the first confirmation prompt. Enable with this in mind.

</details>

<details>
<summary>Memory Bank</summary>

Code Mode includes 2 tools by default (api + execute; 5 with `OPENGROK_ENABLE_MEMORY_TOOLS=true`). Two files persist across turns and session restarts:

| Tool | Purpose |
| ---- | ------- |
| `opengrok_memory_status` | Status, size, and 3-line preview of both memory files |
| `opengrok_read_memory` | Read `active-task.md` or `investigation-log.md` |
| `opengrok_update_memory` | Write or append; auto-timestamps `investigation-log.md` entries |

| File | Size Limit | Purpose |
| ---- | ---------- | ------- |
| `active-task.md` | ≤ 4 KB | Current task state: `task:`, `last_symbol:`, `next_step:`, `open_questions:`, `status:` |
| `investigation-log.md` | ≤ 32 KB | Append-only log of findings, grouped by `## YYYY-MM-DD HH:MM:` headings |

Delta encoding returns `[unchanged]` on repeated reads of unmodified content. Richness-scored trimming keeps the highest-value log entries when space is tight.

</details>

<details>
<summary>Configuration</summary>

#### Core

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_BASE_URL` | _(blank)_ | OpenGrok server base URL (required). Supplied by the setup wizard or VS Code settings. |
| `OPENGROK_USERNAME` | _(blank)_ | Authentication username. Leave unset for anonymous access. |
| `OPENGROK_PASSWORD` | _(blank)_ | Authentication password. Prefer OS keychain via `opengrok-mcp setup`. |
| `OPENGROK_PASSWORD_FILE` | _(blank)_ | Path to a file containing the OpenGrok password (file-mounted secret for CI/containers). Alternative to `OPENGROK_PASSWORD`. |
| `OPENGROK_VERIFY_SSL` | `true` | Set `false` to disable TLS verification for self-signed certs. |
| `OPENGROK_TIMEOUT` | `30` | HTTP request timeout in seconds. |

#### Code Mode & Performance

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_CODE_MODE` | `true` | Code Mode (2–5 tools: `opengrok_api` + `opengrok_execute` + 3 memory tools when enabled). Set `false` for the 26 legacy standard tools. |
| `OPENGROK_CONTEXT_BUDGET` | `standard` | Response size tier: `minimal` (8 KB, 200-line tree-sitter budget) / `standard` (16 KB, 400-line) / `generous` (32 KB, 600-line). |
| `OPENGROK_MAX_RESPONSE_BYTES` | — | Override the per-response byte cap (takes precedence over `OPENGROK_CONTEXT_BUDGET`). |
| `OPENGROK_SEARCH_AND_READ_CAP` | — | Override the `opengrok_search_and_read` compound cap (defaults: 2 KB / 4 KB / 8 KB per tier). |
| `OPENGROK_RESPONSE_FORMAT_OVERRIDE` | — | Force a format globally: `markdown` / `json` / `tsv` / `toon` / `yaml` / `text`. |
| `OPENGROK_DEFAULT_PROJECT` | — | Default project name to scope all searches. |
| `OPENGROK_DEFAULT_MAX_RESULTS` | `25` | Default search result limit. |
| `OPENGROK_LOCAL_COMPILE_DB_PATHS` | — | Comma-separated paths to `compile_commands.json` for C/C++ flag extraction. |
| `OPENGROK_GRAMMAR_DIR` | auto-detected | Override path to tree-sitter grammar WASM files. Default: walk up from the bundle directory to find `grammars/`. |

#### Memory Bank

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_ENABLE_MEMORY_TOOLS` | `false` | Register the 3 Code Mode memory tools (memory status, read, update). Off = api + execute only. |
| `OPENGROK_MEMORY_BANK_DIR` | server default | Override directory for `active-task.md` + `investigation-log.md`. |
| `OPENGROK_ENABLE_OBSERVATION_MASKER` | `false` | Prepend compact history summaries to `opengrok_execute` results after the full-text window fills. Only useful for clients that truncate context. |
| `OPENGROK_OBSERVATION_MASKER_TURNS` | `10` | Number of recent `opengrok_execute` results to keep in full before older ones are compacted. |

#### Rate Limiting

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_RATELIMIT_ENABLED` | `true` | Enable token-bucket rate limiting. |
| `OPENGROK_RATELIMIT_RPM` | `60` | Global requests-per-minute limit. |
| `OPENGROK_PER_TOOL_RATELIMIT` | — | Per-tool RPM overrides: `opengrok_execute:15,opengrok_batch_search:20`. Defaults: `opengrok_execute` 15 rpm, `opengrok_batch_search` 5 rpm, `opengrok_dependency_map` 10 rpm, `opengrok_call_graph` 5 rpm. |

#### Response Cache

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_CACHE_ENABLED` | `true` | Enable TTL response cache. |
| `OPENGROK_CACHE_MAX_SIZE` | `500` | Max cache entries. |
| `OPENGROK_CACHE_MAX_BYTES` | `52428800` | Max total cache size in bytes (50 MB). |
| `OPENGROK_CACHE_SEARCH_TTL` | `300` | Search result cache TTL in seconds. |
| `OPENGROK_CACHE_FILE_TTL` | `600` | File content cache TTL in seconds. |
| `OPENGROK_CACHE_HISTORY_TTL` | `1800` | File history cache TTL in seconds. |
| `OPENGROK_CACHE_PROJECTS_TTL` | `3600` | Project list cache TTL in seconds. |

#### MCP Protocol

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_ENABLE_ELICITATION` | `true` | Project picker at `opengrok_api` startup and `env.opengrok.elicit()` in sandbox. |
| `OPENGROK_ENABLE_SAMPLING` | `false` | MCP Sampling for error explanation, graph summarization, and zero-result recovery. |
| `OPENGROK_ENABLE_FILES_API` | `false` | FileReferenceCache for `investigation-log.md` (SHA-256 content-addressed). |
| `OPENGROK_SAMPLING_MODEL` | — | Model preference for sampling calls. |
| `OPENGROK_SAMPLING_MAX_TOKENS` | `256` | Token budget for sampling responses (max: 4096). |

#### OpenGrok API

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_API_VERSION` | `v1` | REST API version. Use `v2` for `opengrok_call_graph`. |

#### Security & Audit

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_AUDIT_LOG_FILE` | — | File path for structured audit log (CSV or JSON). |
| `OPENGROK_STRICT_SSRF` | `false` | Reject base URLs and redirects resolving to private/loopback IP ranges (default: warn-only). |

#### Logging

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENGROK_LOG_LEVEL` | `info` | Set `debug` for verbose structured logging to stderr. |

#### Proxy

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `HTTP_PROXY` | — | HTTP proxy for outbound requests. |
| `HTTPS_PROXY` | — | HTTPS proxy for outbound requests. |

VS Code users can set `opengrok-mcp.baseUrl`, `opengrok-mcp.codeMode`, `opengrok-mcp.contextBudget`, `opengrok-mcp.memoryBankDir`, `opengrok-mcp.defaultProject`, `opengrok-mcp.responseFormatOverride`, `opengrok-mcp.compileDbPaths`, `opengrok-mcp.enableObservationMasker`, and `opengrok-mcp.observationMaskerTurns` in VS Code settings instead. Secret values such as the password are never written to VS Code settings.

> **MCP SDK Note:** This version uses `@modelcontextprotocol/sdk` v1.30.0 (v1 line).

</details>

<details>
<summary>HTTP Transport & Auth</summary>

By default the server communicates over **stdio**. For shared team deployments, the HTTP transport layer is available as a library API (`startHttpTransport()` in `src/server/transport/http-transport.ts`) but is **not yet wired into the CLI entry point** — `OPENGROK_HTTP_PORT` is documented below but `main.ts` does not yet read it to start the HTTP server automatically. Use `startHttpTransport()` directly in custom deployments.

#### Session Management

- Each HTTP client receives an isolated `McpServer` instance (per-session factory pattern)
- Sessions expire after 30 minutes of inactivity; `OPENGROK_HTTP_MAX_SESSIONS` caps concurrent sessions (default: 100)
- `GET /mcp/sessions` returns JSON with active session count and oldest session age

#### Authentication

| Method | Configuration |
| ------ | ------------- |
| Static Bearer token | `OPENGROK_HTTP_AUTH_TOKEN=mysecret` |
| OAuth 2.1 resource server | `OPENGROK_JWKS_URI=https://idp.example.com/.well-known/jwks.json` + `OPENGROK_RESOURCE_URI=https://opengrok-mcp.example.com` |
| RBAC with named roles | `OPENGROK_RBAC_TOKENS='alice-token:admin,bot-token:readonly'` |

In resource server mode, this server validates JWTs issued by your own IdP — there is no built-in `/token` endpoint. When `OPENGROK_JWT_ISSUER` is set, tokens from other issuers are rejected. RFC 9728 protected resource metadata is served at `/.well-known/oauth-protected-resource`.

#### RBAC Roles

| Role | Permissions |
| ---- | ----------- |
| `admin` | Full access to all tools and configuration |
| `developer` | All search, read, memory, and code tools |
| `readonly` | Search and read tools only — no memory writes, no code execution |

Unknown or missing tokens are rejected with 403 Forbidden. When no authentication is configured, unauthenticated requests are granted `admin` (local dev mode).

#### CORS

Browser-based clients are gated by an origin allowlist (`OPENGROK_ALLOWED_ORIGINS`, comma-separated). Without auth configured, loopback origins (`localhost`, `127.0.0.1`, `[::1]`) are allowed for local development; once auth is configured (`OPENGROK_HTTP_AUTH_TOKEN` or RBAC tokens), loopback is no longer implicit — list every allowed origin explicitly, including local ones.

</details>

<details>
<summary>Security</summary>

| Area | Protection |
| ---- | ---------- |
| SSRF | DNS rebinding detection + IPv6-mapped address blocking in `buildSafeUrl`; strict mode via `OPENGROK_STRICT_SSRF` |
| Path traversal | NFC normalization + bidirectional Unicode character blocking in `assertSafePath` |
| HTML injection | Entity decoding on all parser text nodes before display |
| Prompt injection | Markdown-field escaping in all formatters |
| Token comparison | `crypto.timingSafeEqual` for all Bearer token comparisons |
| CORS | Allowlist via `OPENGROK_ALLOWED_ORIGINS` — no wildcard in production |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, CSP on HTTP responses |
| Credential encryption | AES-256-GCM with auto-upgrade from older encrypted files |
| Rate limiting | Integer-based token bucket (eliminates float drift); per-tool defaults (`opengrok_execute`: 15 rpm) |
| Sandbox isolation | QuickJS WASM VM — no filesystem, no network, method allowlist only; 62 s timeout, 8 MB buffer |
| Audit logs | Injection-escaped structured audit entries |

For the full security architecture (threat model, defense layers, hardening guide), see [SECURITY.md](SECURITY.md).

**Sandbox trust recommendation:** When configuring OpenGrok MCP in VS Code's MCP settings, you may set `sandboxEnabled: true` which auto-approves tool calls without confirmation prompts. This is safe because all tool execution occurs inside the QuickJS WASM sandbox with no host access — the LLM cannot execute arbitrary system commands through this server.

</details>

---

## VS Code Integration

| Command | Action |
| ------- | ------ |
| `OpenGrok: Open Configuration` | Interactive settings GUI |
| `OpenGrok: Test Connection` | Validate API access and token validity |
| `OpenGrok: Show Server Logs` | Expose background process stdout/stderr |
| `OpenGrok: Status Menu` | Quick-access status menu from the status bar |
| `OpenGrok: Check for Updates` | Manually trigger an update check |

> [!NOTE]
> VS Code manages tool authorizations per workspace. If you open a different repository, re-check the OpenGrok box in the Copilot tools panel.

The configuration panel and VS Code Settings UI cover the same settings: use the panel for guided setup, secrets, testing, and reload prompts. Use `opengrok-mcp.*` settings in `settings.json` for workspace overrides, Settings Sync, and scripted defaults. Code Mode is recommended; disabling it uses legacy standard tools and excludes new Code Mode-only capabilities.

---

## Troubleshooting

> [!TIP]
> Run `opengrok-mcp status` to check connectivity and confirm which MCP clients are configured.

> [!WARNING]
> After reloading VS Code or updating the extension, tools may temporarily disappear from the Copilot tools list. Click the tools icon, select "Update Tools", then run `Developer: Reload Window` to restore them.

**Connection failed** — Verify `OPENGROK_BASE_URL`. Check that your VPN or proxy is not blocking the endpoint.

**401 Unauthorized** — Run `OpenGrok: Open Configuration` to re-enter credentials.

**Self-signed SSL certificate errors** — Set `opengrok-mcp.verifySsl` to `false` in VS Code settings, or `OPENGROK_VERIFY_SSL=false` in your MCP client config.

**Slow queries or timeouts** — Narrow the scope with `file_type` filtering or target a specific project. Check indexing status with `opengrok_index_health`.

**Verbose logging** — Set `OPENGROK_LOG_LEVEL=debug`.

### OpenGrok Compatibility

| Engine version | Status | Notes |
| -------------- | ------ | ----- |
| v1.13.x and above | Supported | Full REST API |
| v1.7.0 — v1.12.x | Legacy mode | HTML scraping for symbols and blame |
| Below v1.7.0 | Unsupported | Unpredictable behaviour |

---

## Going Further

[Client Setup](MCP_CLIENTS.md) · [Architecture](ENGINEERING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

---

## License Information

This system is distributed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

* ✅ **Permitted:** Personal use, hobby projects, academic research, education
* ❌ **Prohibited:** Any commercial, business, enterprise, or paid utilization

**Commercial Licensing:**
To use this extension in an enterprise context (internal tooling, CI pipelines, business infrastructure), a commercial license is strictly required.
Reach out to [rudroy09@gmail.com](mailto:rudroy09@gmail.com) for enterprise tier pricing.

Read [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for full terms.
