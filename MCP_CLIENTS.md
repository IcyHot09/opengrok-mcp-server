# MCP Client Setup

Connect OpenGrok MCP Server to any AI coding client that supports the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Setup

**VS Code / Google Antigravity** → Install the VSIX extension. Done — no manual config needed. See [README.md](README.md).

**Any other MCP client** → Install and run the wizard:

```sh
npx opengrok-mcp-server setup
```

The wizard prompts for your OpenGrok URL, username, and password, tests the connection, and writes the config file for your detected client automatically. Credentials are stored in the OS keychain (`@napi-rs/keyring`) with an AES-256-GCM encrypted file fallback for headless/CI environments. Your password is **never** stored in any MCP client config file.

Verify anytime:

```sh
opengrok-mcp status
```

Non-interactive checks and scripted updates (CI, dotfiles, containers):

```sh
opengrok-mcp setup --test                      # test the stored connection, no prompts
opengrok-mcp setup --set contextBudget=generous  # update one stored setting
opengrok-mcp help                              # all commands
```

> **Note:** `status` reads your stored config automatically — it checks `~/.claude.json` (Claude Code), `~/.copilot/mcp-config.json` (GitHub Copilot CLI), and `~/.config/codex/config.toml` (Codex) in that order. No need to set `OPENGROK_BASE_URL` in your shell; it works right after `setup`.

---

## Config Format

The wizard writes this JSON structure to your MCP client's config file:

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/"
      }
    }
  }
}
```

Credentials are read from the OS keychain automatically on startup — no env vars needed.

If you customize settings during setup (e.g., SSL verification, Code Mode, default project), those are added to the `env` block as well. Only non-default values are written. For a global install (`npm install -g opengrok-mcp-server`), replace `npx opengrok-mcp-server` with just `opengrok-mcp`.

> **Note:** Some clients use slightly different key names (`"servers"` instead of `"mcpServers"`, or TOML format). The wizard handles these differences automatically.

---

## Client Configurations

| Client | Config file | Notes |
| ------ | ----------- | ----- |
| Claude Code | `.mcp.json` (project) or `~/.claude.json` (user) | Wizard detects automatically |
| VS Code (Copilot Chat) | VSIX extension (automatic) or `mcp.json` | Manual path below |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | Wizard detects `copilot` binary |
| Codex CLI | `~/.config/codex/config.toml` (TOML) | Wizard detects automatically |
| Cursor | `.cursor/mcp.json` or Settings → Features → MCP | Manual JSON below |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Manual JSON below |
| Claude Desktop | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json` | Restart after saving |
| OpenCode | `opencode.json` (project) or `~/.config/opencode/opencode.json` (global) | `"type": "local"` |
| Crush | `~/.config/crush/config.yaml` or project `crush.yaml` | YAML format below |
| Google Antigravity | VSIX extension (recommended) or MCP Store raw config | Needs `npx` in workspace |

### Claude Code

> **Quickest setup:** `npx opengrok-mcp-server setup` — detects Claude Code and writes the config.

Scope options:
- **Project** (team-shared, no secrets): `.mcp.json` in project root
- **User** (global): `~/.claude.json`

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

### VS Code (GitHub Copilot Chat)

> **Recommended:** Install the VSIX extension — it configures VS Code automatically. No CLI setup needed.

Manual config in `~/.config/Code/User/mcp.json` (Linux/macOS) or `%APPDATA%\Code\User\mcp.json` (Windows):

```json
{
  "servers": {
    "opengrok-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/"
      }
    }
  }
}
```

### GitHub Copilot CLI

Run the wizard (`npx opengrok-mcp-server setup`) — it detects the `copilot` binary or `~/.copilot/` directory and writes `~/.copilot/mcp-config.json` automatically.

```json
{
  "mcpServers": {
    "opengrok-mcp": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/"
      }
    }
  }
}
```

### Codex CLI

Run the wizard — it writes the TOML config automatically. Manual equivalent follows the same `command` + `env` shape in TOML form.

### Cursor

Edit `.cursor/mcp.json` in your project root, or open **Cursor Settings → Features → MCP**.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

Restart Claude Desktop after saving.

### OpenCode (opencode.ai)

Config files: `opencode.json` / `opencode.jsonc` (project) or `~/.config/opencode/opencode.json` (global).

```json
{
  "mcp": {
    "opengrok": {
      "type": "local",
      "command": ["npx", "opengrok-mcp-server"]
    }
  }
}
```

### Crush

Config: `~/.config/crush/config.yaml` or project-level `crush.yaml`.

```yaml
mcp:
  servers:
    opengrok:
      command: npx
      args:
        - opengrok-mcp-server
```

### Google Antigravity

**Recommended:** Install the VSIX extension — Gemini discovers tools automatically.

**Manual MCP config** (if you prefer not to use the extension): use the MCP Store in Antigravity → *View raw config* and add:

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

> Since Antigravity runs in the cloud, `npx` must be available in your workspace environment. Consult the [Antigravity docs](https://antigravity.google/docs/mcp) for workspace-specific details.

---

## OpenGrok Memory Bank vs VS Code Memory

| Capability | VS Code Built-in Memory (`/memory`) | OpenGrok Memory Bank |
|-----------|-------------------------------------|---------------------|
| Scope | General codebase knowledge | Investigation-specific state |
| Files | Managed by VS Code | `active-task.md`, `investigation-log.md` |
| Auto-loaded | ✅ Every Copilot session | ❌ Requires `opengrok_memory_status` call |
| Token cost | Free (injected by VS Code) | Counts as tool calls |
| Best for | Architecture, conventions, directories | Bug investigations, multi-session research |

**Rule of thumb:** Use VS Code `/memory` for "what is this codebase". Use OpenGrok memory for "what am I currently investigating".

For non-VS Code clients:
- **Claude Code:** Put general context in `.claude.md` at project root
- **Cursor:** Put conventions in `.cursorrules`
- **Standalone CLI:** OpenGrok memory bank under the server config directory (`~/.config/opengrok-mcp/` unless `OPENGROK_MEMORY_BANK_DIR` is set)

---

## CI / Headless Environments

Pass credentials as environment variables — they take precedence over keychain:

```sh
export OPENGROK_BASE_URL="https://opengrok.example.com/source/"
export OPENGROK_USERNAME="ci-bot"
export OPENGROK_PASSWORD="$SECRET_FROM_VAULT"   # injected by your CI secrets manager
npx opengrok-mcp-server
```

For file-mounted secrets (containers, orchestrators), point at a mounted secret file and tune the response budget for log-friendly output:

```sh
export OPENGROK_BASE_URL="https://opengrok.example.com/source/"
export OPENGROK_USERNAME="ci-bot"
export OPENGROK_PASSWORD_FILE="/run/secrets/opengrok-password"
export OPENGROK_MAX_RESPONSE_BYTES="16384"
npx opengrok-mcp-server
```

Or include in your MCP client config:

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "ci-bot",
        "OPENGROK_PASSWORD": "${OPENGROK_PASSWORD}"
      }
    }
  }
}
```

Claude Code supports `${VAR}` expansion in `env` blocks — set the variable in your shell before launching.

---

## Key Environment Variables

| Variable | Required | Description |
| :------- | :------- | :---------- |
| `OPENGROK_BASE_URL` | Yes | OpenGrok server URL (e.g., `https://opengrok.example.com/source/`) |
| `OPENGROK_USERNAME` | Yes | OpenGrok username |
| `OPENGROK_PASSWORD` | No | Password — optional when stored in OS keychain via `opengrok-mcp setup` (overrides keychain) |
| `OPENGROK_PASSWORD_FILE` | No | Path to a file containing the password (file-mounted secret) |
| `OPENGROK_VERIFY_SSL` | No | `false` for self-signed certificates (default: `true`) |
| `OPENGROK_CODE_MODE` | No | `true` = 2–5 Code Mode tools (api + execute, +3 memory tools when `OPENGROK_ENABLE_MEMORY_TOOLS=true`); `false` = 26 standard tools (default: `true`) |
| `OPENGROK_CONTEXT_BUDGET` | No | `minimal` (8 KB) / `standard` (16 KB) / `generous` (32 KB) (default: `standard`) |
| `OPENGROK_MAX_RESPONSE_BYTES` | No | Override the per-response byte cap |
| `OPENGROK_DEFAULT_PROJECT` | No | Scope all searches to one project |
| `OPENGROK_ENABLE_ELICITATION` | No | `false` to disable the interactive project picker and `env.opengrok.elicit()` (default: `true`) |

Full reference: [README.md → Configuration](README.md#configuration).

---

## Manual Setup (Advanced)

> Use this if you need full control over the server binary and environment.
> **Credentials in env vars may be visible in process listings** — use a service account
> with read-only access and prefer the keychain approach for interactive use.

### Prerequisites

```bash
npm install -g opengrok-mcp-server   # global install
# OR: use npx for one-off runs without installing
```

See [Key Environment Variables](#key-environment-variables) for the full variable list.

### Example: Claude Desktop with explicit env vars

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "your-username",
        "OPENGROK_PASSWORD": "your-password",
        "OPENGROK_VERIFY_SSL": "true"
      }
    }
  }
}
```

---

## Prompt Caching

Claude Code and Claude.ai automatically cache the MCP server's system prompt
(SERVER_INSTRUCTIONS, ~310 tokens). This means:
- The first call in a session pays the full token cost for SERVER_INSTRUCTIONS
- Subsequent calls in the same session reuse the cached version at ~10% of the cost
- No configuration needed — automatic for supported clients

`OPENGROK_ENABLE_CACHE_HINTS=true` is reserved for future explicit cache-control headers
(not yet implemented by any client).

---

## Troubleshooting

| Problem | Fix |
| ------- | --- |
| `No credentials found` | Run `npx opengrok-mcp-server setup` or set `OPENGROK_PASSWORD` in env |
| `command not found: opengrok-mcp` | Use `npx opengrok-mcp-server` instead, or `npm install -g opengrok-mcp-server` |
| SSL certificate errors | During setup answer **No** to "Verify SSL certificates?", or set `OPENGROK_VERIFY_SSL=false` |
| Connection test fails | Check VPN access; verify the base URL; `curl -u username https://opengrok.example.com/source/api/v1/projects` |
| Tools disappear after reload | Click tools icon → "Update Tools" → `Developer: Reload Window` |

**Checking server logs:** add `"--verbose"` to the args, or run the server directly:

```sh
OPENGROK_BASE_URL=https://... OPENGROK_USERNAME=... OPENGROK_PASSWORD=... npx opengrok-mcp-server 2>&1 | less
```

MCP JSON-RPC traffic goes to stdout; server logs go to stderr.

**Debug logs:** `OPENGROK_LOG_LEVEL=debug npx opengrok-mcp-server 2>&1 | less`

### Client Tool Timeouts (Code Mode)

`opengrok_execute` can legitimately run up to the 62 s sandbox hard timeout (large investigations over slow indexes). If your MCP client enforces its own per-tool timeout, a client-side timeout shorter than the server budget aborts the call while the server is still working — the client reports failure but the result is simply discarded. Set the client's tool timeout to **≥ 70 s** for Code Mode (62 s server budget + headroom), or break the investigation into smaller `opengrok_execute` calls.
