---
name: opengrok-session
description: >
  Session lifecycle management for OpenGrok MCP investigations. Use this skill
  to understand how to start, maintain, and complete an OpenGrok session with
  proper memory bank state management. Trigger at session start when you know
  an investigation will span multiple turns, or when restoring a prior session.
---

# OpenGrok Session Skill

Session lifecycle and memory management for multi-turn OpenGrok investigations.

## Session Startup Protocol

As of v7.0, memory status is **auto-injected** into the server instructions at startup — you can see byte counts and file previews without calling `opengrok_memory_status` first.

```
Step 1: Read injected {{MEMORY_STATUS}} in SERVER_INSTRUCTIONS
  → Memory state (bytes, stub/populated/empty) is already visible

Step 2 (if active-task.md has content):
  opengrok_read_memory { filename: "active-task.md" }
  → Restore task state, last symbol/file, open questions

Step 3 (if investigation-log.md has content):
  opengrok_read_memory { filename: "investigation-log.md" }
  → Review recent findings (auto-compressed if large)

Step 4: Acknowledge state
  → Tell user: "Resuming investigation: [task]. Last worked on: [last_symbol]"
  → OR: "Starting fresh — no prior investigation state"
```

Call `opengrok_memory_status` explicitly only if you need up-to-date byte counts mid-session.

## Mandatory Write Before Answer

**Before EVERY final answer or summary:**

```json
{
  "tool": "opengrok_update_memory",
  "arguments": {
    "filename": "active-task.md",
    "content": "task: <what was investigated>\nstarted: <date>\nlast_symbol: <last symbol>\nlast_file: <last file>\nnext_step: <follow-up if any>\nopen_questions: []\nstatus: complete",
    "mode": "overwrite"
  }
}
```

This is non-negotiable. The LLM that picks up the next session needs this context.

## Multi-Session Pattern

```
Session 1: Investigate → Write findings → Update active-task.md (status: blocked)
Session 2: Read memory → Resume from last state → Continue investigation
Session 3: Read memory → Confirm root cause → Update active-task.md (status: complete)
```

## Session Patterns

### Fresh investigation (Code Mode)

```javascript
const status = env.opengrok.readMemory('active-task.md');
env.opengrok.writeMemory('active-task.md',
  `task: Investigating crash in EventLoop\nstarted: 2026-04-11\nstatus: investigating`,
  'overwrite'
);
return { prior: status, message: "Investigation started" };
```

### Resuming prior session (Code Mode)

```javascript
const task = env.opengrok.readMemory('active-task.md');
const log = env.opengrok.readMemory('investigation-log.md');
return { task, recentFindings: log };
```

### Completing an investigation (Code Mode)

```javascript
env.opengrok.writeMemory('active-task.md',
  `task: EventLoop crash root cause identified
started: 2026-04-11
last_symbol: EventLoop::handleCrash
last_file: src/server/EventLoop.cpp
next_step: none - root cause confirmed
status: complete`,
  'overwrite'
);

env.opengrok.writeMemory('investigation-log.md',
  `\n## 2026-04-11 15:20 — Root cause confirmed\n\n**Conclusion:** Use-after-free in socket handle reuse.\n**Fix:** Add null check before handleCrash.\n`,
  'append'
);

return "Investigation complete — findings saved to memory bank.";
```

## Memory Bank Limits

| File | Max Size | Purpose |
|------|----------|---------|
| `active-task.md` | 4 KB | Current investigation state (overwrite) |
| `investigation-log.md` | 32 KB | Append-only findings history |

When `investigation-log.md` approaches its limit, the server auto-trims older entries
using richness-scored compression (keeps the highest-value findings).

## Tips

1. **Don't over-write** — Only update memory when you have genuinely new findings.
2. **Use VS Code `/memory` for general knowledge** — Reserve OpenGrok memory for investigation state.
3. **Delta encoding** — Repeated reads return `[unchanged]` if the file hasn't been modified, saving tokens.

## VS Code Memory Integration

| What to store | Where |
|--------------|-------|
| Architecture overview, key directories | VS Code `/memory` (auto-loads) |
| Coding conventions, naming patterns | VS Code `/memory` (auto-loads) |
| Current bug investigation state | `active-task.md` (OpenGrok memory) |
| What you searched and found | `investigation-log.md` (OpenGrok memory) |

Never duplicate general codebase knowledge in OpenGrok memory — it costs tokens on every session start.

## Non-VS Code Clients

- **Claude Code:** General codebase context goes in `.claude.md` in the project root (auto-loaded)
- **Cursor:** Use `.cursorrules` for project conventions
- **Claude.ai:** Use Projects for persistent context
