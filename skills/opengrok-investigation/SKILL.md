---
name: opengrok-investigation
description: >
  Use this skill when conducting a structured investigation into a bug, unknown
  module, or impact analysis using OpenGrok. Provides step-by-step methodology
  for systematic codebase investigation with memory-backed state management.
  Trigger when: diagnosing a bug with unknown root cause, exploring an unfamiliar
  module, tracing a call chain, or assessing the impact of a change.
---

# OpenGrok Investigation Skill

Structured investigation methodology for large codebases. Use this alongside the
`opengrok` skill for tool reference.

## Investigation Loops

### Bug Investigation Loop

```
1. Reproduce → find the failing call site via opengrok_search_code (defs/refs)
2. Trace → opengrok_get_symbol_context on key symbols
3. Hypothesize → form a root cause hypothesis
4. Validate → search for evidence (refs, history, blame)
5. Record → append to investigation-log.md with: what you searched, what you found, why it matters
6. Repeat until root cause confirmed
```

### Module Exploration Loop

```
1. Entry points → opengrok_browse_directory + opengrok_get_file_symbols on main files
2. Key abstractions → opengrok_get_symbol_context on core types/interfaces
3. Data flow → trace via refs (where is this type used?)
4. Update active-task.md → record what you learned
```

### Impact Analysis Loop

```
1. Identify the changed symbol/file
2. opengrok_get_symbol_context with max_refs: 20 → find all callers
3. For each caller module: opengrok_get_file_symbols → understand the module
4. Group by layer/component → classify impact
5. Record findings in investigation-log.md
```

## Example: Full Bug Investigation

```javascript
// Step 1: Find where the crash happens
const defs = env.opengrok.search('handleCrash', { searchType: 'defs', fileType: 'cxx' });
const crashFile = defs.results[0];

// Step 2: Read the implementation (expand to the enclosing function body)
const impl = env.opengrok.getFileContent(crashFile.project, crashFile.path, {
  startLine: crashFile.matches[0].lineNumber - 5,
  endLine: crashFile.matches[0].lineNumber + 30,
  expandFunction: true,
});

// Step 3: Check who changed it recently
const hist = env.opengrok.getFileHistory(crashFile.project, crashFile.path, { maxEntries: 5 });
const recentCommit = hist.entries[0];

// Step 4: Blame the suspicious region
const bl = env.opengrok.getFileAnnotate(crashFile.project, crashFile.path);

return {
  file: crashFile.path,
  code: impl.content,
  lastChange: recentCommit,
  annotations: bl.lines?.slice(0, 10),
};
```

## Memory Usage During Investigation

```
Session start (v7.0+):
  Memory status is auto-injected into SERVER_INSTRUCTIONS.
  1. Check {{MEMORY_STATUS}} in SERVER_INSTRUCTIONS — no tool call needed
  2. opengrok_read_memory active-task.md  — restore task if content exists

During investigation (every 3-5 finds):
  3. opengrok_update_memory investigation-log.md (append):
     ## YYYY-MM-DD HH:MM: <brief topic>
     Searched: <what>
     Found: <key finding>
     Why it matters: <significance>

Before final answer (MANDATORY):
  4. opengrok_update_memory active-task.md (overwrite):
     task: <task description>
     last_symbol: <last symbol>
     last_file: <last file>
     next_step: <next step if needed>
     status: complete
```

### active-task.md — Current state (overwrite)

```yaml
task: Investigating crash in EventLoop socket handling
started: 2026-04-11
last_symbol: EventLoop::handleCrash
last_file: src/server/EventLoop.cpp
next_step: Check blame on the timeout path
open_questions:
  - Is the socket handle reused after close?
  - Was the timeout value changed recently?
status: investigating
```

### investigation-log.md — Findings (append)

```
## 2026-04-11 14:32 — EventLoop timeout analysis

**Searched:** `handleCrash` refs in server module
**Found:** 3 call sites set a timeout, all use a hardcoded 30s
**Implication:** Timeout isn't the issue — something else causes the hang

## 2026-04-11 14:45 — Connection reuse bug

**Searched:** blame on EventLoop.cpp:263 (handleCrash)
**Found:** Last modified recently by the networking team
**Implication:** Possible regression in the latest change
```

## Investigation Principles

1. **Search before reading** — Don't read entire files. Find the right lines first.
2. **Use batchSearch for parallel hypotheses** — Test multiple theories in one call.
3. **Record as you go** — Write findings to memory after each significant discovery.
4. **Narrow progressively** — Start broad (cross-project), narrow to specific files.
5. **Use blame for attribution** — When you find the bug, blame tells you who and when.
6. **Expand to function boundaries** — Pass `expandFunction: true` in Code Mode to get the full enclosing function instead of guessing line ranges.

## Code Mode for Deep Investigations

For 5+ step investigations, switch to Code Mode — it saves 75-95% of tokens:

```javascript
// Single execute call replaces 5+ individual calls
const [defs, refs, history] = env.opengrok.batchSearch([
  { query: "BuggyFunction", searchType: "defs" },
  { query: "BuggyFunction", searchType: "refs", maxResults: 20 },
  { query: "BuggyFunction", searchType: "hist" }
]);

const defPath = defs.results[0]?.path;
const defProject = defs.results[0]?.project;
const blame = defPath
  ? env.opengrok.getFileAnnotate(defProject, defPath)
  : null;

return {
  definition: defPath,
  callers: refs.results.slice(0, 10).map(r => r.path),
  recentCommits: history.results.slice(0, 5).map(r => r.matches[0]?.lineContent),
  blameAuthors: [...new Set(blame?.annotations?.map(a => a.author))]
};
```
