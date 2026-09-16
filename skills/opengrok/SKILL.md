---
name: opengrok
description: >
  Use this skill whenever the user wants to search, navigate, or understand
  source code in a large codebase — even when they don't say "OpenGrok".
  Trigger for: finding where a function or class is defined, tracking where
  something is called or referenced, reading a remote source file, checking
  who last changed a line (blame/annotate), browsing a directory tree,
  exploring commit history, or comparing code across projects. Activate when
  the user says "search the codebase", "find where X is defined", "who changed
  this", "show me the source for", "look up that function", or mentions
  cross-referencing or OpenGrok by name. If the target code lives on a remote
  server or indexed repository rather than locally, this skill applies.
---

# OpenGrok Skill

> **OpenGrok** is Oracle's open-source, Lucene-powered source code search and
> cross-reference engine. It indexes 30+ programming languages via Universal
> Ctags, integrates with Git/Mercurial/SVN/CVS/SCCS/Perforce, and serves a REST
> API for full-text, definition, reference, path, and history searches across
> multi-project codebases. All tools in this MCP server carry the `opengrok_`
> prefix.
>
> **When not to use:** If the target files are already on the local filesystem,
> use standard file tools instead — these tools are for remote or indexed
> codebases.

## Quick Start

Find where `EventLoop` is defined and who calls it — one call does it all:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "EventLoop",
    "file_type": "cxx",
    "context_lines": 20,
    "max_refs": 10,
    "include_header": true
  }
}
```

Returns the definition source, surrounding context, reference locations, and the
matching `.h`/`.hpp` header — replacing 3+ separate tool calls.

## Tool Selection

Pick the right tool for the job — compound tools save 75–92 % of tokens compared
to chaining individual calls.

### Start Here (Compound Tools)

| Goal | Tool | Why |
|------|------|-----|
| Understand a symbol (definition + context + references) | `opengrok_get_symbol_context` | Replaces 3 separate calls. Returns definition source, surrounding context, and reference locations in one shot. Set `include_header: true` for C/C++ to also fetch the matching `.h`/`.hpp`. |
| Search and immediately read matching files | `opengrok_search_and_read` | Replaces search → read chains. Returns search hits with inline file content. Use `context_lines` (1–50, default 5) to control how much surrounding code is shown. |
| Run multiple search queries at once | `opengrok_batch_search` | Replaces sequential `opengrok_search_code` calls. Pass up to 10 queries in a `queries` array (max 25 results per query, default 5). `file_type` is top-level, not per-query. |
| Check if OpenGrok is reachable | `opengrok_index_health` | Quick connectivity and index status diagnostic. Run this first in every session. |

### Code Mode Tools (preferred when available)

When Code Mode is enabled, these tools replace all individual tools above (2 by default, 5 with `OPENGROK_ENABLE_MEMORY_TOOLS=true`):

| Goal | Tool | Why |
|------|------|-----|
| Get the API specification | `opengrok_api` | Returns the full spec of all sandbox methods. Call once per session. With `OPENGROK_ENABLE_ELICITATION=true`, also prompts the user to select a working project at startup. |
| Execute a JavaScript program against OpenGrok | `opengrok_execute` | Write JS code using flat globals (`search(...)`) or equivalently `env.opengrok.*` methods. Only the `return` value crosses back — intermediate data stays in sandbox (huge token savings). |
| Read memory bank file | `opengrok_read_memory` | Read `active-task.md` or `investigation-log.md` |
| Write/append to memory bank file | `opengrok_update_memory` | Persist findings across turns |
| Check memory bank status | `opengrok_memory_status` | See file sizes and previews without reading full content |

### Individual Tools

| Goal | Tool |
|------|------|
| Full-text, definition, reference, path, or commit message search | `opengrok_search_code` |
| Find files by name or path pattern | `opengrok_find_file` |
| Read file contents (always pass `start_line`/`end_line`) | `opengrok_get_file_content` |
| File commit history | `opengrok_get_file_history` |
| Commit history with co-changed files (RSS) | `opengrok_get_file_history_with_files` |
| All matching lines in a file (truncated search) | `opengrok_get_all_matches` |
| Direct download URL for a file | `opengrok_get_download_url` |
| List directory contents | `opengrok_browse_directory` |
| List all accessible projects | `opengrok_list_projects` |
| List project groups | `opengrok_list_groups` |
| List repositories for a project | `opengrok_get_project_repositories` |
| Popular suggestions for a project field | `opengrok_get_suggest_popularity` |
| Git blame / annotate with optional line range | `opengrok_get_file_annotate` |
| List top-level symbols in a file (functions, classes, macros) | `opengrok_get_file_symbols` |
| Autocomplete suggestions for partial queries | `opengrok_search_suggest` |
| Compiler flags and include paths (requires local `compile_commands.json`) | `opengrok_get_compile_info` |

> **`opengrok_find_file` vs `search_type: "path"`:** Use `find_file` for
> filename/glob patterns (e.g., `config.ts`, `test*.js`). Use `opengrok_search_code`
> with `search_type: "path"` for full path string searches that benefit from
> Lucene syntax (e.g., `+src -test`).
>
> **`project` vs `projects`:** File-level tools (`get_file_content`,
> `get_file_history`, `browse_directory`, `get_file_annotate`, `get_file_symbols`)
> take a single `project: string`. Search tools (`search_code`, `search_and_read`,
> `batch_search`, `get_symbol_context`) take `projects: string[]` — omit the
> field to use the configured default project (set via Extension Settings → Default Project or `OPENGROK_DEFAULT_PROJECT`).

## Session Memory

The MCP server maintains 2 persistent files across sessions:

| File | Purpose | Usage |
|------|---------|-------|
| `active-task.md` | Current task state | Overwrite at task start, update before final answer |
| `investigation-log.md` | Append-only findings history | Append after each significant discovery |

### Mandatory Agentic Loop

**On every session start (v7.0+):**
Memory status is auto-injected into SERVER_INSTRUCTIONS — no need to call `opengrok_memory_status` at startup.
1. Check `{{MEMORY_STATUS}}` in SERVER_INSTRUCTIONS — byte counts and previews are already visible
2. If `active-task.md` has content: call `opengrok_read_memory` to restore context
3. If `investigation-log.md` has content: call `opengrok_read_memory` to see recent findings
4. Begin investigation

**Before every final answer:**
- Update `active-task.md` with current task state via `opengrok_update_memory`
- Append key findings to `investigation-log.md` if new discoveries were made

### VS Code Memory Note

For general codebase context (architecture, conventions, key directories), use VS Code's built-in `/memory` command — it auto-loads at every Copilot session and doesn't cost tool call tokens. Reserve the OpenGrok memory bank for investigation-specific state.

### active-task.md format

```yaml
task: <what you're currently investigating>
started: <YYYY-MM-DD>
last_symbol: <last symbol examined>
last_file: <last file examined>
next_step: <what to do next>
open_questions: [<question1>, <question2>]
status: investigating | blocked | complete
```

## Code Mode

Code Mode reduces tool calls to just 5, saving 75–95% tokens vs standard mode's 20 tools.

### Workflow

```
1. Call opengrok_api once to get the full API spec (and pick a working project if elicitation is enabled)
2. Write JavaScript that uses env.opengrok.* methods
3. Call opengrok_execute with the code
4. Only the return value crosses back — intermediate data stays in the sandbox
```

### Example: Find the definition of a symbol and its callers

```javascript
// Passed to opengrok_execute as { code: "..." }
const [defs, refs] = env.opengrok.batchSearch([
  { query: "EventLoop", searchType: "defs" },
  { query: "EventLoop", searchType: "refs", maxResults: 5 }
]);

const defPath = defs.results[0]?.path;
const defLine = defs.results[0]?.matches[0]?.lineNumber;
const content = defPath
  ? env.opengrok.getFileContent('myproject', defPath, { startLine: defLine - 5, endLine: defLine + 15 })
  : null;

return { definition: content?.content, callers: refs.results.map(r => r.path) };
```

### Example: File disambiguation with elicit() (v9.0+, requires OPENGROK_ENABLE_ELICITATION=true)

```javascript
const found = env.opengrok.findFile("AuthService*", { maxResults: 10 });
if (found.results.length === 0) return "No file found matching AuthService*";
if (found.results.length === 1) {
  const r = found.results[0];
  return env.opengrok.getFileContent(r.project, r.path).content;
}
const paths = found.results.map(r => r.path).slice(0, 10);
const choice = env.opengrok.elicit("Multiple files match. Which one?", {
  type: "object",
  properties: { path: { type: "string", enum: paths, description: "File to fetch" } },
  required: ["path"],
});
if (choice.action !== "accept") return "Cancelled.";
const match = found.results.find(r => r.path === choice.content.path);
return env.opengrok.getFileContent(match.project, choice.content.path).content;
```

### Example: Zero-result handling with _suggestions and sample() (v9.0+)

```javascript
const results = env.opengrok.search("handelCrash", { searchType: "defs" });
if (results.totalCount === 0) {
  const suggestions = results._suggestions?.join(", ");  // auto-injected when sampling available
  if (suggestions) return `No results. Try: ${suggestions}`;
  const s = env.opengrok.sample(`"handelCrash" returned 0 results. Suggest 3 alternative symbol names.`);
  return s ? `No results. Try: ${s}` : "No results found.";
}
// ... process results
```

### Code Mode Notes
- Client tool timeout: `opengrok_execute` may run up to the 62 s server budget — if your MCP client has its own tool timeout, set it to **≥ 70 s** or the client will abort healthy long-running investigations
- `Promise.all` does **not** parallelize inside the sandbox VM — use `env.opengrok.batchSearch()` for independent parallel searches; sequential calls for dependent operations are fine
- All `env.opengrok.*` calls are synchronous from your code's perspective
- `env.opengrok.readMemory(filename)` / `writeMemory(filename, content)` for Living Document access
- `env.opengrok.elicit(message, schema)` — pause and ask the user to choose from a list (v9.0+, requires `OPENGROK_ENABLE_ELICITATION=true`); returns `{ action, content }` — always handle `action !== "accept"`
- `env.opengrok.sample(prompt, opts?)` — call the client's LLM for suggestions (v9.0+); returns `string | null` — always null-guard
- `_suggestions` — auto-injected into zero-result `search()` responses when sampling is available (v9.0+)
- `expandFunction: true` — pass to `search()` / `batchSearch()` / `getFileContent()` to inline enclosing function bodies (up to 3 files per call, tree-sitter). Saves a separate `read` call.
- `env.opengrok.traceCallChain()` supports both `callers` and `callees` directions — callees use tree-sitter AST analysis for supported languages and return real results (not empty).
- `env.opengrok.getFileAnnotate(project, path, { revision, startLine, endLine, includeContent })` — historical blame, range filter (OOB throws), `includeContent:false` omits content
- `env.opengrok.getFileOverview(project, path, { includeImports })` — imports omitted unless `includeImports:true`
- `env.opengrok.getFileDiff(project, path, rev1, rev2, { includeHunks })` — `false` returns `{unifiedDiff,stats}` only (default `true` keeps hunks)
- `env.opengrok.searchSuggest(query, { context })` — pass other-field values for context-aware ranking
- `env.opengrok.listProjects(filter?)` — optional substring/glob filter
- `env.opengrok.getGuidanceForPath(project, path, opts?)` — AGENTS.md/CLAUDE.md discovery near a file
- `env.opengrok.indexHealth()` — also returns `serverVersion` and `suggestConfig` when available

## Search Types

`opengrok_search_code` supports these `search_type` values:

| Type | When to use |
|------|-------------|
| `full` | General text search — grep-like, matches anywhere in file content |
| `defs` | Find where a symbol is **defined** (function, class, variable declaration). Prefer this for known symbol names. |
| `refs` | Find where a symbol is **referenced** (called, imported, used). |
| `symbol` | Combined defs + refs in one search (broader than defs alone). |
| `path` | Search file paths/names. |
| `hist` | Search commit messages and changelogs. |

For known symbol names (CamelCase, snake_case identifiers), always prefer `defs` or `refs` over `full` — they use the Ctags symbol index and are faster and more precise.

## Query Syntax

OpenGrok uses Lucene query syntax under the hood. These patterns work in the `query` parameter of `opengrok_search_code`, `opengrok_search_and_read`, `opengrok_batch_search`, and `opengrok_get_symbol_context`:

| Pattern | Example | Meaning |
|---------|---------|---------|
| Plain word | `EventLoop` | Matches any occurrence of the term |
| `"exact phrase"` | `"thread pool"` | Matches the exact phrase |
| `+required -excluded` | `+init -test` | Must contain `init`, must not contain `test` |
| Wildcard `*` | `get*Config` | Matches zero or more characters |
| Wildcard `?` | `nod?` | Matches exactly one character |
| Boolean `AND` / `OR` | `EventLoop AND destroy` | Combine terms logically |

> **Note:** Wildcards and boolean operators work inside the `query` string. Do
> not confuse them with `search_type` — the type selects which Lucene field
> (full text, definitions, references, path, history) is searched.

## Narrowing Results

### file_type filter

These tools accept an optional `file_type` to restrict results by language:
- `opengrok_search_code`
- `opengrok_batch_search`
- `opengrok_search_and_read`
- `opengrok_get_symbol_context`

`file_type` is the lowercased OpenGrok analyzer name (not the file extension).
Canonical values: `c`, `cxx` (C++), `java`, `javascript`, `typescript`, `csharp`
(C#), `python`, `sh` (shell), `powershell`, `golang` (Go), `rust`, `kotlin`,
`scala`, `sql`, `plsql`, `perl`, `ruby`, `swift`, `php`, `xml`, `json`, `yaml`,
`hcl`, `terraform`, `lua`, `ada`, `fortran`, `r`, `haskell`, `clojure`,
`erlang`, `lisp`, `tcl`, `pascal`, `eiffel`, `asm`, `vb`, `verilog`, `plain`,
`cobol`, `ocaml`, `mandoc`, `troff`.

Aliases are accepted and normalized: `cpp`/`c++`/`h`/`hpp`→`cxx`,
`go`→`golang`, `bash`/`shell`/`makefile`→`sh`, `js`→`javascript`,
`ts`→`typescript`, `cs`→`csharp`, `py`→`python`, `rb`→`ruby`, `rs`→`rust`.
Anything else is rejected with an "Invalid fileType" error listing the valid types.

### response_format

All standard mode tools accept `response_format`:
- `"auto"` (default) — server picks the best format per response type
- `"markdown"` — human-readable, optimized for LLM consumption
- `"json"` — structured output for programmatic use (includes `totalCount`, `results`, `hasMore`)
- `"tsv"` — compact tabular format (~50% token savings on search results)
- `"toon"` — token-optimized notation (~40% fewer tokens than JSON)
- `"yaml"` — hierarchical data
- `"text"` — raw code, no framing

### Line ranges

Always pass `start_line` and `end_line` to `opengrok_get_file_content`. Never fetch a full file — it wastes tokens and may hit the response cap.

### Pagination

`opengrok_search_code`, `opengrok_search_and_read`, `opengrok_find_file`,
`opengrok_get_file_history`, `opengrok_browse_directory`,
`opengrok_get_file_symbols`, and `opengrok_get_file_diff` support pagination.
JSON responses include an opaque `cursor` when more pages exist — pass it back
as the `cursor` parameter for the next page (preferred). `start_index` /
`nextOffset` still works as a fallback for offset-based paging. Expired or
cross-method cursors return `_cursorExpired` — reissue the call without a
cursor to start fresh.

In Code Mode, the same applies to sandbox methods: `search()` returns `cursor`
plus `startIndex`/`endIndex` (set `startIndex` to the previous `endIndex`, or
pass `cursor` back verbatim); `findFile()`, `getFileHistory()`,
`browseDir()`, and `getFileSymbols()` accept `cursor` the same way.
`batchSearch()` does not support pagination — it always fetches from offset 0.


## Gotchas

1. **Fetch files with targeted line ranges.** Without `start_line`/`end_line`, `opengrok_get_file_content` hits the context-budget response cap and truncates — wasting tokens and losing data. Use `opengrok_get_file_symbols` first to find interesting functions or classes, then read specific ranges.

2. **`opengrok_batch_search` queries structure.** Pass queries as a top-level `queries` array (max 10). The `file_type` filter is top-level, not per-query. Each query object has its own `search_type` and `query`. Pagination (`start_index`) is not supported in batch search — use `opengrok_search_code` with `start_index`/`cursor` for paginated results.

3. **`opengrok_list_projects` filter is substring match.** Passing `"release"` matches `release-1.0`, `release-2.0`, etc. Omit the filter to list all projects.

4. **Responses are capped by context budget.** Three tiers control token usage
   (~4 chars per token): `minimal` 8 KB (~2K tokens), `standard` 16 KB (~4K
   tokens, default), `generous` 32 KB (~8K tokens) — set via
   `OPENGROK_CONTEXT_BUDGET`. Override the byte cap with
   `OPENGROK_MAX_RESPONSE_BYTES`, or the search-and-read compound cap (2/4/8 KB
   per tier) with `OPENGROK_SEARCH_AND_READ_CAP`. If results are truncated,
   narrow your query with `file_type`, specific projects, smaller
   `max_results`, or line ranges.

5. **Use the configured default project.** Unless the user specifies a different project, use whatever project is configured. Don't prompt for project selection unnecessarily.

6. **`opengrok_get_file_annotate` supports line ranges.** Pass `start_line`/`end_line` to avoid fetching blame for entire large files.

7. **`opengrok_search_suggest` is for autocomplete only.** It returns partial matches for UI-style suggestions, not full search results. Use `opengrok_search_code` for actual searches.

8. **`opengrok_get_compile_info` requires local layer.** This only works when `compile_commands.json` is configured via `OPENGROK_LOCAL_COMPILE_DB_PATHS`. It returns compiler flags, include paths, defines, and language standard for a source file.

9. **`opengrok_get_symbol_context` has `include_header`.** For C/C++ codebases, set `include_header: true` (default) to automatically fetch the matching `.h`/`.hpp` file alongside a `.cpp` definition — saves an extra read call.

10. **All tools are read-only.** Every tool has `readOnlyHint: true` and `destructiveHint: false`. They never modify the OpenGrok index or source files.

11. **VS Code memory vs OpenGrok memory.** VS Code Copilot's built-in `/memory` command stores general codebase knowledge (architecture, conventions, key directories) and auto-loads every session — free. The OpenGrok memory bank (`active-task.md`, `investigation-log.md`) is for investigation-specific state that needs to persist across multiple OpenGrok sessions. Use VS Code memory for "what is this codebase", OpenGrok memory for "what am I currently investigating".

12. **Standard mode uses 26 tools.** In token-constrained environments, enable Code Mode (5 tools) via Extension Settings or `OPENGROK_CODE_MODE=true`. When Code Mode is active, all operations go through the sandbox instead of individual tools.

## Error Recovery

| Error | Next step |
|-------|-----------|
| Connection failed / timeout | Run `opengrok_index_health` to diagnose. Check if `OPENGROK_BASE_URL` is reachable. |
| 401 Unauthorized | Credentials are wrong or expired. User needs to reconfigure via `OpenGrok: Configure Credentials`. |
| 403 Forbidden | User doesn't have access to the requested project. Try a different project or check permissions. |
| Empty search results | Try broader terms, switch `search_type` (e.g., `full` instead of `defs`), remove `file_type` filter, or check project name. |
| Response truncated | Narrow query: add `file_type`, reduce `max_results`, use line ranges for file reads. |
| "Path traversal not allowed" | File path contains `..` or encoded traversal sequences. Use clean relative paths from search results. |

## Workflow Patterns

### "Exploring an unfamiliar project for the first time"

*Step 1* — list available projects:
```json
{ "tool": "opengrok_list_projects", "arguments": {} }
```

*Step 2* — browse the directory tree:
```json
{ "tool": "opengrok_browse_directory", "arguments": { "project": "myproj", "path": "src" } }
```

*Step 3* — once you find an interesting file, see its symbols before reading it:
```json
{ "tool": "opengrok_get_file_symbols", "arguments": { "project": "myproj", "path": "src/Server.java" } }
```

### "Known symbol name — find definition + all call sites"

Use `opengrok_get_symbol_context` — see the Quick Start example at the top of this skill.

### "Search for pattern and show me the code"
```json
{
  "tool": "opengrok_search_and_read",
  "arguments": {
    "query": "\"thread pool\" AND init",
    "search_type": "full",
    "file_type": "java",
    "context_lines": 15,
    "max_results": 5
  }
}
```
Returns search hits with inline file content.

### "Compare how X is used across projects"
```json
{
  "tool": "opengrok_batch_search",
  "arguments": {
    "queries": [
      { "query": "handleRequest", "search_type": "refs" },
      { "query": "handleRequest", "search_type": "defs" }
    ],
    "file_type": "java"
  }
}
```

### "Understand a file's structure before diving in"

*Step 1* — see all symbols:
```json
{ "tool": "opengrok_get_file_symbols", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp" } }
```

*Step 2* — read the interesting function:
```json
{ "tool": "opengrok_get_file_content", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp", "start_line": 42, "end_line": 90 } }
```

### "Check recent changes to a file"

*Step 1* — see commit history:
```json
{ "tool": "opengrok_get_file_history", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp", "max_entries": 10 } }
```

*Step 2* — blame a suspicious region:
```json
{ "tool": "opengrok_get_file_annotate", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp", "start_line": 100, "end_line": 130 } }
```

### "Find all config files across the codebase"
```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "*.config.*",
    "search_type": "path",
    "max_results": 20
  }
}
```
