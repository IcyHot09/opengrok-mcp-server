# Security Model

This document describes the security architecture of OpenGrok MCP Server. It is intended for administrators deploying the server and for MCP client authors evaluating trust.

## Threat Model

OpenGrok MCP Server connects an AI assistant (the LLM) to source code infrastructure. The primary threats are:

1. **LLM-directed attacks** — a compromised or jailbroken model attempting to exfiltrate data or access unauthorized resources via tool calls.
2. **Credential leakage** — secrets appearing in logs, error messages, or tool responses.
3. **Infrastructure abuse** — SSRF, path traversal, or denial of service against backend services.

## Defense Layers

### 1. QuickJS WASM Sandbox (Code Mode)

In Code Mode, the LLM writes JavaScript that executes inside a **QuickJS WebAssembly VM** running in a Node.js worker thread. This provides:

- **No filesystem access** — the sandbox cannot read or write files on the host.
- **No network access** — all HTTP is mediated through a SharedArrayBuffer + Atomics bridge that only exposes allowlisted API methods.
- **No `eval`/`Function` beyond sandbox scope** — the QuickJS runtime is isolated from the Node.js process.
- **Method allowlist** — only `env.opengrok.*` methods in the sandbox allowlist can be called. Unknown method names throw immediately.
- **Execution timeout** — scripts are terminated after a hard timeout (62 s, matching the HTTP search timeout + buffer).
- **Buffer-bounded output** — results crossing the bridge are capped to the 8 MB SharedArrayBuffer data region via `fitToBuffer()`; oversized results are trimmed and marked `_truncated: true`.
- **Return-value-only output** — only the final `return` value exits the sandbox. Side effects (console, assignment to globals) do not leak.

**What the sandbox does NOT protect against:**
- Data exfiltration via the allowed API methods (e.g., searching for secrets in source code). This is mitigated by RBAC and the read-only nature of the API.
- Resource exhaustion within the sandbox (CPU loops). Mitigated by execution timeout.

### 2. Path Traversal Prevention

Every path-based HTTP request passes through `assertSafePath()` which rejects:

- Literal `../` traversal sequences
- URL-encoded variants (`%2e%2e`, `%2f`)
- Double-encoded variants (`%252e`)
- Null bytes (`\0`, `%00`, `%2500`)
- Unicode bidi/zero-width spoofing characters
- NFD normalization attacks (composed character sequences that spell `..`)
- Backslash-to-forward-slash substitution attacks

### 3. SSRF Protection

All URLs constructed from user input use `buildSafeUrl()` which:

- Validates the resulting URL only points to the configured base URL host/port.
- Rejects non-HTTP(S) schemes.
- Prevents host header injection via encoded characters.

Additionally, private-IP checks are performed during client construction. When `OPENGROK_STRICT_SSRF=true`, requests to RFC 1918 private ranges (`10.x`, `172.16-31.x`, `192.168.x`), loopback (`127.x`), link-local (`169.254.x`), and IPv6 private addresses are rejected. In non-strict mode (default), a warning is logged but the request proceeds.

Redirect safety: unsafe redirects block HTTPS→HTTP protocol downgrade and strip the Authorization header on cross-origin redirects.

### 4. Credential Management

- **Never logged** — all log output passes through `redactString()` which strips Basic auth, Bearer tokens, URL-embedded credentials, and filesystem paths.
- **Never in error responses** — `sanitizeErrorMessage()` and sandbox error sanitization redact before returning to the LLM.
- **Stored securely** — VS Code extension uses OS keychain (via SecretStorage API) with AES-256-GCM encrypted file fallback. The CLI wizard (`opengrok-mcp setup`) uses the OS keychain with the same fallback. `OPENGROK_PASSWORD_FILE` supports file-mounted secrets for containers and CI.
- **Validated at startup** — Zod schemas reject missing or malformed credentials before the server binds.

### 5. HTTP Transport Authentication (Remote Deployments)

When deployed over HTTP (non-stdio), the server supports:

- **Bearer token** — timing-safe comparison, reject with `401` and `WWW-Authenticate` challenge.
- **OAuth 2.1 JWT** — JWKS-based verification via `jose`, with configurable issuer claim (`OPENGROK_JWT_ISSUER`), audience (`OPENGROK_RESOURCE_URI`), and JWKS endpoint (`OPENGROK_JWKS_URI`). When `OPENGROK_JWT_ISSUER` is set, tokens from other issuers are rejected.
- **RBAC** — three roles (`admin`, `developer`, `readonly`) with per-tool permission checks. Fail-safe: with RBAC tokens or a static auth token configured, missing or unknown tokens are denied (`403`); with nothing configured the server runs open as `admin` (local development only). Denials are intentional hardening: unknown tool names fail closed (denied, never default-allowed), and JSON-RPC batch requests are authorized per item — one denied entry rejects the batch.

### 6. Rate Limiting

- **Global** — token bucket rate limiter on the OpenGrok HTTP client (default: 60 rpm).
- **Per-tool** — configurable sliding-window limits for expensive tools (`opengrok_batch_search`: 5 rpm, `opengrok_execute`: 15 rpm, `opengrok_dependency_map`: 10 rpm, `opengrok_call_graph`: 5 rpm).
- **Backoff** — `p-retry` with exponential backoff on transient failures.

### 7. Response Sanitization

- **Tiered budget caps** — all tool responses are truncated via `capResponse()` to the active budget tier (`minimal` 8 KB / `standard` 16 KB / `generous` 32 KB) to prevent context window flooding. `OPENGROK_MAX_RESPONSE_BYTES` overrides the per-response cap; `OPENGROK_SEARCH_AND_READ_CAP` overrides the compound search-and-read cap.
- **Error redaction** — sandbox errors are sanitized and capped at 500 chars.
- **Path redaction** — absolute filesystem paths in any output are replaced with `[path]`.

### 8. CORS (HTTP Transport)

When running in HTTP mode, the server enforces origin-based CORS:
- Allowed origins come from `OPENGROK_ALLOWED_ORIGINS` (comma-separated).
- Loopback origins (`localhost`, `127.0.0.1`, `[::1]`) are implicitly allowed
  only when no auth is configured (local development). With auth configured
  (`OPENGROK_HTTP_AUTH_TOKEN` or RBAC tokens), loopback must be listed
  explicitly — auth-gated deployments trust no origin by default.
- Preflight (`OPTIONS`) returns allowed methods (`GET, POST, DELETE, OPTIONS`) and headers (`Content-Type, Mcp-Session-Id, Authorization`).

### 9. Bidi/Zero-Width Character Rejection

Both `opengrok_execute` code input and `assertSafePath()` reject Unicode bidirectional override characters (U+202A–U+202E, U+2066–U+2069) and zero-width joiners that can spoof displayed paths. This prevents trojan-source-style attacks.

### 10. Sandbox Write Limits

`writeMemory()` inside `opengrok_execute` is rate-limited to **5 writes per execution**. This prevents a single LLM-generated script from exhausting disk or flooding the memory bank.

### 11. Strict Mode Flags

| Flag | Effect |
| ---- | ------ |
| `OPENGROK_STRICT_SSRF=true` | Rejects requests to private IP ranges (default: warn-only) |
| `OPENGROK_STRICT_OAUTH=true` | Requires `OPENGROK_JWKS_URI` to be set — server refuses to start without it |

## Configuration Hardening

For production HTTP deployments:

```bash
# Required: authentication
OPENGROK_HTTP_AUTH_TOKEN=<random-256-bit-hex>

# Or: OAuth 2.1 JWT
OPENGROK_JWKS_URI=https://idp.example.com/.well-known/jwks.json
OPENGROK_JWT_ISSUER=https://idp.example.com
OPENGROK_RESOURCE_URI=opengrok-mcp

# RBAC: restrict tool access by role
OPENGROK_RBAC_TOKENS=token1:admin,token2:developer,token3:readonly

# Strict modes
OPENGROK_STRICT_SSRF=true
OPENGROK_STRICT_OAUTH=true

# Rate limiting
OPENGROK_RATELIMIT_RPM=30          # requests per minute
OPENGROK_PER_TOOL_RATELIMIT=opengrok_batch_search:3,opengrok_execute:5

# Response budgets (override the 8/16/32 KB tiers)
OPENGROK_MAX_RESPONSE_BYTES=16384
OPENGROK_SEARCH_AND_READ_CAP=4096

# Audit logging
OPENGROK_AUDIT_LOG_FILE=/var/log/opengrok-mcp/audit.jsonl
```

## MCP Resources

Tool documentation is exposed as MCP Resources so clients can pre-fetch without spending tool calls:

- `opengrok-docs://api` — full Code Mode API specification (YAML).
- `opengrok-docs://tools/{name}` — per-tool documentation page.
- `opengrok-memory://active-task.md` and `opengrok-memory://investigation-log.md` — memory bank files for direct browsing.

## VS Code Extension Security

The VS Code extension (VSIX):

- Uses the **VS Code Language Model API** — never imports provider SDKs directly.
- Stores credentials in the **OS keychain** (via SecretStorage API), not in settings.
- Runs the MCP server as a **child process** communicating over stdio — no network exposure.
- Supports `sandboxEnabled: true` in MCP configuration which auto-approves tool calls (only when the MCP client trusts the server).

## Reporting Vulnerabilities

Report security issues to the repository maintainers through a private channel (for example, a GitHub private security advisory). Do not file public issues for vulnerabilities.
