# Contributing & Development Guide

## Project Structure

```
opengrok-mcp-server/
├── src/
│   ├── extension.ts               # VS Code extension entry point (activate/deactivate)
│   ├── server/                     # MCP Server (flat layout, grouped by concern)
│   │   ├── main.ts                # Entry point: config, client, runServer()
│   │   ├── server.ts              # Tool registrations: registerCodeModeTools(), registerLegacyTools()
│   │   ├── server-utils.ts        # capResponse(), capCodeModeResult(), budget helpers
│   │   ├── config.ts              # Environment config (Zod-validated OPENGROK_* vars, BUDGET_LIMITS)
│   │   ├── models.ts              # Zod input/output schemas
│   │   ├── client.ts              # OpenGrokClient (undici, p-retry, TTL cache, SSRF guard)
│   │   ├── parsers.ts             # HTML parsers for OpenGrok web responses
│   │   ├── unified-diff.ts        # Hunk-level diff parser
│   │   ├── formatters.ts          # Per-tool response formatters (markdown/json/tsv/toon/yaml/text)
│   │   ├── intelligence.ts        # buildFileOverview(), buildCallChain(), getTreeSitterLineBudget()
│   │   ├── intelligence/           # Tree-sitter analysis engine
│   │   │   ├── index.ts           # Barrel re-exports
│   │   │   ├── tree-sitter.ts     # web-tree-sitter WASM init + grammar loading
│   │   │   ├── ast-truncation.ts  # truncateAtBoundary(), expandToFunctionBoundary()
│   │   │   ├── callee-extractor.ts # Tree-sitter callee extraction
│   │   │   └── import-extractor.ts # Tree-sitter import/include extraction
│   │   ├── sandbox.ts             # executeInSandbox(), createSandboxAPI(), API_SPEC, SANDBOX_ALLOWED_METHODS
│   │   ├── sandbox-worker.ts      # QuickJS WASM worker thread (env.opengrok via makeMethod)
│   │   ├── sandbox-protocol.ts    # SharedArrayBuffer layout constants (8 MB data region)
│   │   ├── sandbox-buffer.ts      # fitToBuffer(), buildBatchSearchStubs()
│   │   ├── sandbox-error-hints.ts # Contextual error suggestions for sandbox failures
│   │   ├── sandbox-apispec-generated.ts # Generated API spec snapshot (do not edit manually)
│   │   ├── sandbox-schemas/       # Zod schemas for the sandbox API (source of truth for the spec)
│   │   │   ├── generator.ts       # MethodSchema type + TypeScript declaration generator
│   │   │   ├── interfaces.ts      # Shared Zod schemas (search results, call nodes, ...)
│   │   │   ├── search.ts          # search(), batchSearch(), findFile(), searchSuggest()
│   │   │   ├── read-navigate.ts   # getFileContent(), browseDir(), getFileSymbols(), ...
│   │   │   ├── history-blame.ts   # getFileAnnotate(), getFileHistory()
│   │   │   ├── code-intelligence.ts # traceCallChain(), getSymbolContext()
│   │   │   ├── system.ts          # indexHealth(), getCompileInfo(), elicit(), sample()
│   │   │   ├── feature-flag.ts    # Memory method schemas (readMemory/writeMemory)
│   │   │   └── index.ts           # Barrel exports
│   │   ├── cursor-codec.ts        # encodeCursor()/decodeCursor() shared by paginated methods
│   │   ├── memory-bank.ts         # Living Document memory bank (active-task.md + investigation-log.md)
│   │   ├── observation-masker.ts  # Session memory management for long Code Mode sessions
│   │   ├── file-cache.ts          # SHA-256 content-addressed FileReferenceCache
│   │   ├── worker-pool.ts         # Warm QuickJS worker pool (up to 2 idle workers)
│   │   ├── http-transport.ts      # Streamable HTTP transport, sessions, CORS, OAuth 2.1
│   │   ├── rbac.ts                # Role-based access control (admin/developer/readonly)
│   │   ├── audit.ts               # Structured audit logging
│   │   ├── elicitation.ts         # MCP Elicitation wrapper with graceful fallback
│   │   ├── sampling.ts            # MCP Sampling with retry/backoff/timeout
│   │   ├── tool-rate-limiter.ts   # Per-tool sliding-window rate limiting
│   │   ├── redact.ts              # Credential/path/PII redaction (single source of truth)
│   │   ├── logger.ts              # Structured stderr logger
│   │   ├── tls-ca.ts              # System CA trust bundle for undici agents
│   │   ├── api-types.ts           # OpenGrok REST API response interfaces
│   │   ├── local/                  # Local filesystem helpers
│   │   │   └── compile-info.ts    # compile_commands.json reader
│   │   └── cli/                    # CLI commands
│   │       ├── setup/             # Interactive setup wizard
│   │       ├── status.ts          # Health check command
│   │       └── keychain.ts        # OS keychain abstraction with AES-GCM file fallback
│   ├── tests/                      # Unit tests (Vitest, 1100+ tests)
│   │   ├── client.test.ts
│   │   ├── server.test.ts
│   │   ├── code-mode.test.ts
│   │   ├── sandbox.test.ts        # Sandbox integration (needs compiled build)
│   │   ├── fixtures/              # HTML fixture data
│   │   ├── cli/                   # CLI tests
│   │   └── local/                 # Local-layer tests
│   └── webview/
│       └── configManager.html   # Settings webview panel
├── grammars/                     # Tree-sitter WASM grammars (populated via copy-grammars)
├── scripts/
│   ├── generate-spec.ts         # Regenerates the sandbox API spec from sandbox-schemas/
│   ├── copy-grammars.js         # Copies tree-sitter WASM grammars into grammars/
│   └── build-vsix.js
├── package.json
├── server.json                   # MCP Registry metadata
├── tsconfig.json
├── esbuild.js                    # Multi-target build (extension + server + worker)
├── eslint.config.mjs             # ESLint strict flat config
└── vitest.config.ts              # Test runner + coverage thresholds (≥89%)
```

---

## Development Setup

### Prerequisites

- Node.js 22+
- VS Code 1.85+
- Git

### Install & Build

```bash
npm install
npm run compile          # esbuild bundle
npm test                 # Run Vitest unit tests
npm run lint             # TypeScript type-check + ESLint
npm run typecheck        # tsc --noEmit only
npm run generate:spec    # Regenerate sandbox API spec from sandbox-schemas/
npm run copy-grammars    # Copy tree-sitter WASM grammars into grammars/
```

### Launch in Debug Mode

1. Open the project root in VS Code
2. Press `F5` to launch Extension Development Host
3. The bundled MCP server starts automatically

---

## Architecture

### Data Flow

```
User (AI Assistant — Claude Code, Copilot, Cursor)
        │
        ▼
┌─────────────────────┐
│  MCP Client         │
│  (stdio or HTTP)    │
└──────────┬──────────┘
           │ JSON-RPC (opengrok_api, opengrok_execute)
           ▼
┌─────────────────────┐
│  OpenGrok MCP       │
│  server/main.ts     │──────────▶ OpenGrok (search, symbols, call graphs)
│  sandbox/worker     │
│                     │──────────▶ Local FS (compile_commands.json)
└─────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
| :------- | :-------- |
| TypeScript (not Python) | Bundles into extension — no separate runtime install |
| `undici` (not native `fetch`) | Persistent connection pool, `p-retry` integration, SSRF guard via `buildSafeUrl` |
| `node-html-parser` (not jsdom) | Pure JS, fast, no native deps |
| Zod 4 for config + validation | Type-safe parsing of env vars and tool args; native `z.toJSONSchema()` for MCP `inputSchema` (no `zod-to-json-schema` package) |
| `p-retry` for retries | Configurable exponential backoff |
| TTL cache with byte budget | Prevents OOM from large file caching |
| QuickJS WASM sandbox | LLM writes JS against `env.opengrok.*`; all calls in one round-trip — 80–95% token savings |
| Background client | Rate-limit-free sibling connection (short per-operation budget) for trace/dependency fan-out |
| HTML fallback parsing | Gracefully handle OpenGrok instances where REST API is disabled |
| 8/16/32 KB budget tiers | `minimal` / `standard` / `generous` caps prevent blowing up the context window |

---

## Adding a New MCP Tool

1. **Add Zod schema** in `src/server/models.ts`:

```typescript
export const MyNewToolArgs = z.object({
  param1: z.string().min(1),
  param2: z.number().int().default(10),
  response_format: RESPONSE_FORMAT,
});
```

2. **Register the tool** via `server.registerTool()` in `registerLegacyTools()` (or `registerCodeModeTools()`) in `src/server/server.ts`:

```typescript
server.registerTool(
  "opengrok_my_new_tool",
  {
    title: "My New Tool",
    description: "Description of what this tool does.",
    inputSchema: MyNewToolArgs.shape,
    annotations: READ_ONLY_OPEN,
  },
  async (args) => {
    try {
      const result = await client.myMethod(args.param1, args.param2);
      return { content: [{ type: "text", text: capResponse(formatMyResult(result)) }] };
    } catch (err) {
      return makeToolError("opengrok_my_new_tool", err);
    }
  }
);
```

3. **Add client method** in `src/server/client/opengrok-client.ts`:

```typescript
async myMethod(param1: string, param2: number): Promise<MyType> {
  const url = buildSafeUrl(this.baseUrl, `api/v1/endpoint`);
  url.searchParams.set("param", param1);
  const response = await this.request(url, TIMEOUTS.default, "application/json");
  return (await response.json()) as MyType;
}
```

`buildSafeUrl()` must be used for all URL construction (SSRF prevention). Call `assertSafePath()` before any path-based HTTP request (path traversal prevention).

4. **Add formatter** in `src/server/formatters/` for the Markdown output (plus JSON/TSV variants via `selectFormat()` where appropriate).

5. **Add unit tests** in `src/tests/` (match the source file name: `client.ts` → `client.test.ts`).

6. **If rate-limited**: add a default entry to `DEFAULT_PER_TOOL_LIMITS` in `src/server/config.ts` (e.g. `opengrok_execute: 15`).

7. **If exposed in Code Mode sandbox**: add the method to the `SandboxAPI` interface and `createSandboxAPI()` in `src/server/sandbox/sandbox.ts`, expose it via `makeMethod("myMethod")` on the `env.opengrok` object in `src/server/sandbox/worker.ts`, and add `"myMethod"` to `SANDBOX_ALLOWED_METHODS`.

8. **If the method is paginated**: mint/accept opaque offset cursors via `encodeCursor()` / `decodeCursor()` from `src/server/pagination/cursor-codec.ts` (see `getFileHistory` in `sandbox.ts`: `resolveCursorOffset` → client call → mint `encodeCursor({ t: "offset", v: nextOffset, m: "<method>" })`); return the shared `CURSOR_EXPIRED` shape for invalid or cross-method cursors.

9. **If the method has a structured return schema**: add a `MethodSchema` in the appropriate `src/server/sandbox/schemas/*.ts` file (e.g. `search.ts`, `read-navigate.ts`) and run:
   ```bash
   npm run generate:spec
   ```
   This regenerates the spec snapshot consumed by `opengrok_api`. **Do not edit generated spec output manually** — it is auto-generated from the Zod schemas in `sandbox-schemas/`.

---

## Adding a Code Mode Sandbox Method

Code Mode sandbox methods (`env.opengrok.*`) are defined in five places:

1. **`src/server/sandbox/sandbox.ts`** — `SandboxAPI` interface (type declaration) + `createSandboxAPI()` implementation (async method bodies). Import any new dependencies via `SandboxOpts` fields (e.g. `mcpServer`, `elicitEnabled`).

2. **`src/server/sandbox/worker.ts`** — `env.opengrok` object inside the QuickJS VM. Add one line: `myMethod: makeMethod("myMethod")`. The worker dispatches by method name string via the SharedArrayBuffer bridge. Also append `myMethod` to the flat-globals `destructure` template in `runJob()` so bare `myMethod()` calls work alongside `env.opengrok.myMethod()`.

3. **`src/server/sandbox/schemas/`** — Add a `MethodSchema` (Zod output schema) for the new method in the appropriate `schemas/*.ts` file. Then run:
   ```bash
   npm run generate:spec
   ```
   This regenerates the spec snapshot the LLM reads when it calls `opengrok_api`. **Do not edit generated output directly** — it is auto-generated from the Zod schemas.

4. **`src/server/sandbox/sandbox.ts` → `SANDBOX_ALLOWED_METHODS`** — Add `"myMethod"` to the allowlist (unlisted methods throw at call time).

5. **For paginated methods**: mint/accept opaque offset cursors via `encodeCursor()` / `decodeCursor()` from `src/server/pagination/cursor-codec.ts` and return the shared `CURSOR_EXPIRED` shape for invalid or cross-method cursors. There is no fire-and-forget layer — methods run synchronously within the 62 s budget.

**Example — adding `env.opengrok.myMethod()`:**

```typescript
// 1. sandbox.ts — SandboxAPI interface
myMethod(arg: string): Promise<string | null>;

// 2. sandbox.ts — createSandboxAPI() returned object
async myMethod(arg) {
  // ... implementation using client, memoryBank, mcpServer etc.
},

// 3. sandbox-worker.ts — env.opengrok object + flat-globals destructure
myMethod: makeMethod("myMethod"),
// ...and add myMethod to the `destructure` template string in runJob(),

// 4. sandbox-schemas/read-navigate.ts (for example) — Zod output schema
export const myMethodSchema: MethodSchema = {
  name: "myMethod",
  description: "Does something useful.",
  params: z.object({ arg: z.string() }),
  returns: z.union([z.string(), z.null()]),
};
// Then: npm run generate:spec   (rewrites the generated spec snapshot)

// 5. sandbox.ts — SANDBOX_ALLOWED_METHODS
"myMethod",
```

---

## Updating the Sandbox API Spec

The spec snapshot the LLM reads via `opengrok_api` is **auto-generated. Do not edit it manually.**

### How it works

```
src/server/sandbox/schemas/
  ├── generator.ts          # MethodSchema type + TypeScript declaration generator engine
  ├── interfaces.ts         # Shared Zod schemas (search results, call nodes, ...)
  ├── search.ts             # search(), batchSearch(), findFile(), searchSuggest()
  ├── read-navigate.ts      # getFileContent(), browseDir(), getFileSymbols(), ...
  ├── history-blame.ts      # getFileAnnotate(), getFileHistory()
  ├── code-intelligence.ts  # traceCallChain(), getSymbolContext()
  ├── system.ts             # indexHealth(), getCompileInfo(), elicit(), sample()
  ├── feature-flag.ts       # Memory method schemas (readMemory/writeMemory)
  └── index.ts              # Barrel exports
        │
        ▼  npm run generate:spec  (scripts/generate-spec.ts via esbuild bundle)
generated spec snapshot   ← auto-generated output
```

### When to run `npm run generate:spec`

- You added or changed a method in `createSandboxAPI()` and its `MethodSchema` in `sandbox-schemas/`.
- You changed parameter/return types that should be visible to the LLM.
- You changed feature-flag markers on any method.

```bash
npm run generate:spec   # Reads sandbox-schemas/, rewrites the generated snapshot
git add src/server/sandbox/api-spec.ts
```

> **Note:** The spec generator (`scripts/generate-spec.ts`) runs via an esbuild bundle (`scripts/generate-spec-runner.js`) — no extra dev dependencies needed.

---

## Tree-sitter Contributions

Code intelligence (function-boundary expansion, callee/import extraction) runs on tree-sitter WASM grammars:

- Grammar loading lives in `src/server/intelligence/tree-sitter.ts` (`LANGUAGE_GRAMMAR_MAP`, `parseSource()`, `queryNodes()`, `isLanguageSupported()`).
- WASM grammar files live in `grammars/` and are refreshed with:
  ```bash
  npm run copy-grammars
  ```
- To add a language: add its grammar mapping to `LANGUAGE_GRAMMAR_MAP`, ensure `npm run copy-grammars` picks up the WASM file, and cover it with tests in `src/tests/intelligence.test.ts`.
- Consumers can override the grammar directory at runtime with `OPENGROK_GRAMMAR_DIR` — no code change needed for local grammar experiments.
- Per-tier line budgets (`minimal` 200 / `standard` 400 / `generous` 600) come from `getTreeSitterLineBudget()` in `src/server/intelligence.ts` — keep new truncation logic budget-aware.

---

## Security Practices

### Credential Storage

- **VS Code Extension**: Uses `SecretStorage` API (system keychain, per-user, encrypted)
- **MCP Server**: Receives password via `OPENGROK_PASSWORD` env var (set by extension at spawn) or `OPENGROK_PASSWORD_FILE` (file-mounted secret)
- **Never** in `settings.json`, log files, or command-line args

### Input Validation

Every tool call goes through a Zod schema parse. Invalid inputs return a user-friendly error without server restart.

Path traversal is rejected in `assertSafePath()` before any HTTP request is made. SSRF is prevented via `buildSafeUrl()` which verifies the resolved URL hostname matches the configured base URL. Opt into strict private-IP rejection with `OPENGROK_STRICT_SSRF=true`.

### Error Handling

Internal errors (stack traces, URLs) are logged to stderr only. The AI agent receives only a sanitized message via `sanitizeErrorMessage()` (sandbox errors additionally capped at 500 chars).

See [SECURITY.md](SECURITY.md) for the full threat model and hardening guide.

---

## Testing

```bash
npm test               # Run all unit tests
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report (thresholds: 80% lines/functions/statements/branches)
npm run test:sandbox   # Sandbox integration tests (requires npm run compile first)
```

Test files match the source: `src/tests/client.test.ts` tests `src/server/client/opengrok-client.ts`, `src/tests/code-mode.test.ts` covers Code Mode, and so on. `cli/` and `local/` subdirectories match their source counterparts.

Fixture HTML strings are in `src/tests/fixtures/`. Tests use mocked HTTP clients — no live OpenGrok connection needed.

`sandbox.test.ts` is excluded from the default run (it needs the compiled worker) — use `npm run test:sandbox` after `npm run compile`. `sandbox.ts`, `sandbox-worker.ts`, and the related sandbox support files are excluded from coverage for the same reason.

---

## Building for Release

```bash
npm run vsix
# Creates opengrok-mcp-X.Y.Z.vsix
```

---

## Release Workflow

The extension uses [Semantic Versioning](https://semver.org/). Releases are automated via GitHub Actions.

### Version Bump

Manually edit `package.json` and `server.json` to bump the version, then:

```bash
npm test                # Confirm all tests pass
npm run package         # Production build
npm run vsix            # Build .vsix package
git add package.json server.json CHANGELOG.md
git commit -m "chore: vX.Y.Z version bump"
git tag vX.Y.Z
git push origin main --tags
```

### Push to GitHub

```bash
git push origin main
git push origin vX.Y.Z        # Tag push triggers CI/CD
```

GitHub Actions automatically runs tests, builds the VSIX, creates a [GitHub Release](https://github.com/IcyHot09/opengrok-mcp-server/releases), and attaches the VSIX as a download.

### Manual Release (Fallback)

If CI is unavailable:

```bash
npm run compile && npm run vsix
# Go to GitHub > Releases > Draft a new release
# Select tag, upload the VSIX, add release notes from CHANGELOG.md
```

### Version Tracking in Extension

On activation the extension reads its version from `package.json`, compares with the stored version in VS Code global state, and if updated, notifies the user to reload and enable new tools.

### CI/CD Pipeline (GitHub Actions)

| Trigger | What runs |
| :------ | :-------- |
| Every commit / PR | Lint + unit tests |
| Tag push (`vX.Y.Z`) | Full build + GitHub Release with artifacts |

---

## Enterprise Deployment

### Network Share

```text
\\server\tools\vscode-extensions\opengrok-mcp-X.Y.Z.vsix
```

```powershell
code --install-extension "\\server\tools\opengrok-mcp-X.Y.Z.vsix"
```

### Pre-configured Settings

```json
{
    "opengrok-mcp.baseUrl": "https://your-opengrok-server/source/",
    "opengrok-mcp.verifySsl": true
}
```

---

## Support Matrix

| Platform | VS Code | Node.js | Status |
| :------- | :------ | :------ | :----- |
| Windows 10/11 | 1.85+ | 22+ (bundled) | ✅ |
| macOS 12+ | 1.85+ | 22+ (bundled) | ✅ |
| Ubuntu 22.04+ | 1.85+ | 22+ (bundled) | ✅ |

> Node.js is bundled with VS Code so users don't need to install it separately.
