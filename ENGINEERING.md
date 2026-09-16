# opengrok-mcp-server — Engineering Deep Dive

A comprehensive tour of the interesting engineering in this codebase.

---

## Why Code Mode Exists

Standard MCP configurations expose tools as individual operations, and every
context window loads the full schema for every tool — names, parameter
descriptions, usage examples. With twenty tools, that overhead reaches several
thousand tokens before the first search is made. In a 128,000-token context
window, it is a tax paid on every message.

The overhead compounds during an investigation. A dependency traversal that
should be a single logical operation becomes a sequence of round-trips:
search, read the results, fetch the file, read that, follow the imports, read
each of those. Intermediate results flow through the context window between
each tool call. The model reasons about orchestration when it should be
reasoning about code.

Code Mode fixes both problems. The schema overhead is reduced to two core
tools (`opengrok_api` + `opengrok_execute`, plus three optional memory tools).
The round-trip problem is eliminated by running the entire investigation as a
single JavaScript program inside a sandbox: intermediate results stay in the
sandbox; only the final `return` value crosses back to the context window.

---

## Table of Contents

1. [The Sandbox — QuickJS WASM + Atomics Bridge](#1-the-sandbox)
2. [Worker Pool — Pre-warmed QuickJS Instances](#2-worker-pool)
3. [HTTP Client — Rate Limiter, TTL Cache, SSRF Guard](#3-http-client)
4. [Code Mode API — What the LLM Actually Calls](#4-code-mode-api)
5. [Server Intelligence — File Overviews and Call Chains](#5-server-intelligence)
6. [Memory Bank — Living Document System](#6-memory-bank)
7. [Observation Masker — Long Session Context Management](#7-observation-masker)
8. [HTTP Transport — Multi-session, OAuth 2.1, RBAC](#8-http-transport)
9. [Per-Tool Rate Limiting](#9-per-tool-rate-limiting)
10. [MCP Protocol Extensions — Elicitation and Sampling](#10-mcp-protocol-extensions)
11. [Audit Logging and Redaction](#11-audit-logging-and-redaction)
12. [Credential Security](#12-credential-security)
13. [CLI Layer](#13-cli-layer)
14. [Tree-sitter Code Analysis Engine](#14-tree-sitter-code-analysis-engine)
15. [Long-Running Calls (Synchronous Execution)](#15-long-running-calls-synchronous-execution)

---

## 1. The Sandbox

**Files:** `src/server/sandbox/sandbox.ts`, `src/server/sandbox/worker.ts`, `src/server/sandbox/protocol.ts`

This is the most novel piece of engineering in the entire codebase. It solves a
hard problem: how do you let an LLM run arbitrary JavaScript that calls async
HTTP APIs, while making those calls *appear synchronous* to the code — all
without blocking Node.js's event loop?

### The Problem

The LLM writes code like this:

```javascript
const result = env.opengrok.search("MyClass", { searchType: "defs" });
const content = env.opengrok.getFileContent(result.results[0].project, result.results[0].path);
return content;
```

From the code's perspective, every call is synchronous — it returns a value
directly. But `search()` and `getFileContent()` are HTTP calls that take
hundreds of milliseconds. You can't use `await` because the JavaScript runs
inside a sandboxed QuickJS WASM VM, not in real Node.js. Promises don't exist
across that boundary.

### The Architecture

```
┌─────────────────────────────────────────┐    ┌────────────────────────────────────┐
│          Main Thread (Node.js)          │    │        Worker Thread               │
│                                         │    │                                    │
│  executeInSandbox()                     │    │  QuickJS WASM VM                   │
│    │                                    │    │    env.opengrok.search(...)        │
│    ├─ spawns Worker ──────────────────────────►   │                               │
│    ├─ creates SharedArrayBuffer         │    │   callHostSync("search", args)     │
│    └─ awaits handleWorkerCall()         │    │     │                              │
│         │                              │    │     ├─ write call to SAB           │
│         │  Atomics.waitAsync           │    │     ├─ Atomics.store(status, 1)    │
│         │  (status, 0, 0) → Promise    │◄───────── ├─ Atomics.wait(status, 1)   │
│         │                              │    │     │   (BLOCKS worker thread)     │
│    ┌────┴──────────────────────┐       │    │     │                              │
│    │  reads call from SAB      │       │    │     │                              │
│    │  calls real async HTTP    │       │    │     │                              │
│    │  writes result to SAB     │       │    │     │                              │
│    │  Atomics.store(status, 0) │       │    │     │                              │
│    │  Atomics.notify()  ───────────────────────► Atomics.wait() returns         │
│    └───────────────────────────┘       │    │     │                              │
│                                         │    │     └─ reads result from SAB      │
│    onMessage(result) ◄──────────────────────── parentPort.postMessage(result)   │
└─────────────────────────────────────────┘    └────────────────────────────────────┘
```

### The SharedArrayBuffer Protocol

The two threads share a single `8,388,628`-byte buffer with a strict layout
defined in `src/server/sandbox/protocol.ts`:

```
Offset 0–15:   Int32Array  statusArray  — [0] = 0 (idle) or 1 (pending call)
Offset 16–19:  Uint32Array lengthArray  — [0] = byte count of JSON payload
Offset 20+:    Uint8Array  dataArray    — up to 8 MB of JSON payload
```

Exported as `STATUS_OFFSET`, `LENGTH_OFFSET`, `DATA_OFFSET`,
`DATA_REGION_BYTES` (8 MB), and `SHARED_BUFFER_SIZE`. Both
`src/server/sandbox/sandbox.ts` and `src/server/sandbox/worker.ts` import these
constants from `sandbox-protocol.ts`. A mismatch would silently corrupt
everything, so both sides share one source of truth.

### The Call Flow, Step by Step

1. **Worker writes the call.** `callHostSync("search", [query, opts])`
   serializes `{method, args}` as JSON into `dataArray`, sets
   `lengthArray[0]` to the byte count, then does
   `Atomics.store(statusArray, 0, 1)`. The status flag is now `1 =
   pending_call`. Then `Atomics.notify(statusArray, 0)` wakes the main thread.

2. **Worker blocks.** `Atomics.wait(statusArray, 0, 1, 62_000)` blocks the
   worker thread until someone changes status away from `1`, or the 62-second
   timeout fires. The worker thread is frozen here. The Node.js event loop is
   completely free.

3. **Main thread waits.** `Atomics.waitAsync(statusArray, 0, 0)` returns a
   Promise that resolves when the worker sets status to `1`. The main thread
   awaits it, reads `{method, args}` from the buffer, looks up the API method,
   and calls it with `await`. This replaced the prior `setImmediate` poll
   loop — no busy-wait overhead (the old loop consumed ~15–25% CPU on shared
   machines during sandbox execution).

4. **Main thread writes the result.** After the async HTTP call completes, the
   result is JSON-serialized, passed through `fitToBuffer()`, and written into
   `dataArray` with `lengthArray[0]` updated. Then the critical race-free
   sequence: `Atomics.store(statusArray, 0, 0)` resets to idle first, then
   `Atomics.notify(statusArray, 0)` wakes the worker. The ordering matters —
   see the race note below. A type-preservation guard then verifies
   `fitToBuffer()` did not silently change an array into an object (or vice
   versa); violations throw a diagnosable error instead of a cryptic
   "not a function" at the call site.

5. **Worker resumes.** `Atomics.wait()` returns. The worker reads the response
   from the buffer. If the response contains `__error`, it throws. If the
   response lacks a `data` field, it throws a protocol error listing the keys
   received. Otherwise it returns `data` synchronously to the LLM code.

6. **Done.** When the LLM code's `return` statement fires, QuickJS sends the
   final result via `parentPort.postMessage(result)`. The main thread's
   `onMessage` handler fires, calls `safeResolve()`, and the whole
   `executeInSandbox()` promise resolves.

### The Race Condition That Was Fixed

Naive implementations reset status in a deferred callback:

```javascript
// WRONG: creates a race window
Atomics.notify(statusArray, 0);
// ← worker could write status=1 here before the reset lands
Atomics.store(statusArray, 0, 0);  // too late — next Atomics.waitAsync misses it
```

The fix is to reset status to `0` *before* notifying (`sandbox.ts`
`handleWorkerCall`). The worker's `Atomics.wait()` returns based on the
notification, not the current value, so it correctly reads the result that was
already written before the reset. This eliminates a window where a new call
from the worker could set status=1 between the store and the reset.

### Why executionTimeout is Omitted from QuickJS

The QuickJS `executionTimeout` option uses a wall-clock interrupt. If it fires
while the worker is blocked in `Atomics.wait()` (waiting for the main
thread), it kills the QuickJS context mid-bridge call, corrupting the WASM
heap. Pooled workers can't recover from this.

Instead, there are two separate timeout mechanisms:

- **62-second per-call `Atomics.wait()` timeout**: if the main thread doesn't
  respond in 62 seconds (the HTTP search timeout is 60s + 2s buffer), the
  bridge throws a clean error.
- **62-second hard `setTimeout` in `executeInSandbox()`** (overridable via
  `timeouts.hardTimeout`): unconditionally kills the worker via
  `worker.terminate()`. This fires regardless of what the worker is doing.

The worker instead runs with a 128 MB `memoryLimit`, a 4 MB `maxStackSize`,
`allowFetch: false`, `allowFs: false`, and a silenced `console` (all methods
are no-ops so sandbox code can never write to the parent stdout, which
carries the MCP protocol stream).

### The IIFE Wrapper Trick

LLM code uses `return value` to produce output. But QuickJS's module system
uses `export default`. Without adaptation, a `return` at module scope would be
a syntax error.

The solution wraps all LLM code in an `async` IIFE, captures its result, and
exports it:

```javascript
const __result = await (async () => {
  // LLM code goes here
  return env.opengrok.search("MyClass");
})();
export default __result;
```

The `async` wrapper is also why `return await somePromise` works: the IIFE is
genuinely async, so Promise objects returned from the LLM code are awaited
before becoming `__result`.

### fitToBuffer — Type-Preserving Trimming

When an API result is too large to fit in the 8 MB SharedArrayBuffer,
`fitToBuffer()` (in `src/server/sandbox/buffer.ts`) trims it intelligently
rather than truncating mid-JSON — and never silently changes the return type:

- **Strings**: binary-search the longest prefix that fits, append
  `"\n[truncated]"`.
- **Arrays** (e.g. `batchSearch`): keep as many complete elements as fit
  (using pre-computed per-item sizes, not O(n²) re-serialization), append a
  `{_truncated: true, ...}` marker. If no complete element fits, trim `results`
  within each element proportionally via binary search. If nothing fits,
  return per-query stubs via `buildBatchSearchStubs()` that preserve each
  query's `totalCount` so the LLM knows real matches exist and can retry with
  `search()`.
- **Objects**: binary-search trim of the largest known array field
  (`results`, `matches`, `lines`, `entries`, `projects`, `symbols`,
  `topLevelSymbols`, `hunks`, `suggestions`, `callers`, `callees`,
  `guidance`, `samples` — including nested ones like
  `references.samples`), then fall back to truncating the largest string
  field, then to a `{_truncated: true, _hint, totalCount?, cursor?}` stub.

For `batchSearch`, N queries in always produce N elements out: dropped queries
get explicit stubs instead of a single truncation marker.

### Method Allowlist

The main thread enforces an explicit allowlist before dispatching any method
call from the worker:

```typescript
const SANDBOX_ALLOWED_METHODS = new Set<string>([
  "search", "batchSearch", "getFileContent", "getSymbolContext",
  "getFileSymbols", "getFileHistory", "getFileAnnotate", "browseDir",
  "findFile", "getFileOverview", "traceCallChain", "searchSuggest",
  "getCompileInfo", "indexHealth", "readMemory", "writeMemory",
  "getFileDiff", "elicit", "sample",
]);

if (!SANDBOX_ALLOWED_METHODS.has(method)) {
  throw new Error(`Sandbox method not allowed: "${method}"`);
}
```

This prevents inherited `Object.prototype` properties or future methods
accidentally added to `SandboxAPI` from being callable by LLM-written code.
Defense in depth.

### double-resolution Guard (`safeResolve`)

The worker's main thread side is a `Promise`. Three different things can
resolve it: `onMessage` (success/error), `onError` (worker crash), `onExit`
(unexpected exit). Without a guard, all three could fire in a crash scenario.

`safeResolve()` sets `stopped = true` on first call and ignores all subsequent
calls. The same flag prevents any pending `Atomics.waitAsync` Promise
continuation from dispatching after the sandbox has already resolved, and
skips buffer writes when the hard timeout already killed the worker.

### Error Hints Without Sampling

**File:** `src/server/sandbox/error-hints.ts`

When the LLM misspells a method or passes wrong arguments, the sandbox
provides targeted help without an expensive sampling round-trip.
`METHOD_SIGNATURES` holds the canonical signature for all 19 `env.opengrok.*`
methods (extracted from the generated `API_SPEC` declaration string), `ALIAS_MAP` maps common confusions (`read` →
`getFileContent`, `blame` → `getFileAnnotate`, `traceCallers` →
`traceCallChain`, …), and `matchErrorToHint()` matches error shapes ("X is
not a function", "X is not defined", TDZ "not initialized" shadowing,
"Unknown API method", argument-count mismatches, HTTP 404) to hints, using
Levenshtein distance for closest-method suggestions. Every hint ends with a
pointer to `opengrok_api` for the full spec.

---

## 2. Worker Pool

**File:** `src/server/sandbox/worker-pool.ts`

Starting a Worker thread and loading the QuickJS WASM binary costs ~50ms per
`opengrok_execute` call. The `SandboxWorkerPool` pre-warms up to 2 idle
workers.

### How Pool Mode Works

Workers are spawned once and reused: each job reuses the already-loaded
QuickJS instance instead of paying the spawn + WASM load cost on every call.

The pool itself uses `idle.pop()` to acquire workers atomically (no
concurrent acquire races are possible — Node.js is single-threaded). Dead
workers are detected via the `isAlive` flag, which is set to `false` by the
worker's `error` event handler (this also prevents unhandled `error` events,
e.g. WASM init failures in test environments, from crashing the process):

```typescript
worker.on("error", () => { alive = false; });
```

After each job completes, the worker is returned to the pool via `release()`.
If the pool is already at capacity (2 idle), the worker is terminated
instead. The worker path is resolved to match `sandbox.ts` (bundled
`sandbox-worker.js` next to `__dirname`, with an `out/server/` dev fallback).

Idle workers are cleaned up after 30 seconds (timer `unref()`'d so pool
cleanup never keeps the process alive), and `drain()` clears timers and the
idle list *before* awaiting termination to prevent a race with concurrent
`release()` calls.

> **Memory tradeoff:** every non-pooled execution allocates a fresh 8 MB
> `SharedArrayBuffer` plus a new Worker + QuickJS heap (~128 MB sandbox
> limit) — pooled reuse avoids both costs, so keep the pool enabled unless
> isolation between executions matters more than memory churn.

---

## 3. HTTP Client

**File:** `src/server/client/opengrok-client.ts`

### Token Bucket Rate Limiter

The global rate limiter uses a token bucket algorithm, but with a key
optimization: **the queue uses a single persistent `processQueue` loop**
rather than spawning a new `setTimeout` for each waiter. Token accounting uses
integer token-milliseconds to avoid floating-point drift:

```
intervalMs = 60_000 / RPM;  maxTokensMs = RPM * intervalMs (start full)
on acquire():
  enqueue waiter, start processQueue if not running
processQueue():
  loop forever until queue empty:
    refill based on elapsed time
    if token available: shift() next waiter and resolve()
    else: sleep(ms_until_next_token)
```

The queue is bounded (`maxQueueSize = 100`); overflow throws "Rate limit queue
full" instead of growing memory without bound. A `tryAcquire()` /
`msUntilAvailable()` pair supports non-blocking checks.

### TTL Cache with Dual Budget

The cache enforces *two* independent limits: entry count (`maxEntries`) and
total byte size (`maxBytes`). Most caches only do one. The byte budget matters
because file content can be huge — 500 small entries at 1 KB each is fine,
but 50 large files at 500 KB each is 25 MB. Entries that individually exceed
the byte budget are rejected outright.

Eviction is LRU-style using `Map`'s insertion-order iteration (entries are
promoted to the end on every `get`). Expired entries are swept every 10
writes rather than on every access.

There are five caches splitting the `OPENGROK_CACHE_MAX_BYTES` budget (50 MB
default) five ways, each with its own TTL bucket:

- Search results: 5 min (`OPENGROK_CACHE_SEARCH_TTL=300`)
- Match lists: 5 min (same bucket)
- File content: 10 min (`OPENGROK_CACHE_FILE_TTL=600`)
- File history: 30 min (`OPENGROK_CACHE_HISTORY_TTL=1800`)
- Project list: 1 hour (`OPENGROK_CACHE_PROJECTS_TTL=3600`, single entry)

Results are shallow-cloned before the sandbox mutates them (cursor stamping,
`_suggestions`, function expansion) so TTL entries are never corrupted.

### SSRF Protection (`buildSafeUrl`)

All URL construction goes through `buildSafeUrl()`, which validates the URL
parses and rejects non-HTTP/HTTPS schemes. `isPrivateIp()` blocks private
ranges, loopback, and link-local addresses (including bracketed and
IPv4-mapped IPv6 forms). Redirects are followed manually (up to 10) with two
guards: credentials are stripped on cross-origin redirect so `Authorization`
never leaks to another origin, and `isSafeRedirect()` re-applies the SSRF
check to every hop. `OPENGROK_STRICT_SSRF=true` additionally rejects a base
URL that itself points at private/loopback space.

### Path Traversal Prevention (`assertSafePath`)

All path-based API calls go through `assertSafePath()`, which rejects
bidi/zero-width characters, null bytes (including encoded forms), malformed
percent-encoding, `..` segments after normalization, and double-encoded
traversal sequences. This prevents crafted paths from escaping the project
root via the file content APIs.

### Retry Strategy (`p-retry`)

All HTTP calls use `p-retry` with `retries: 3` (4 attempts total),
`minTimeout: 1000`, `maxTimeout: 10_000`, `factor: 2` exponential backoff.
4xx responses abort immediately via `AbortError` — no point retrying a bad
request or auth failure. Each attempt gets a fresh `AbortSignal.timeout()`
deadline (a shared signal would stay fired after the first timeout and fail
all retries instantly).

Per-operation timeouts: search 60s, suggest 10s, file/default 30s.
`createBackgroundClient()` returns a sibling client with rate limiting
disabled, an 8s timeout, and no retries for best-effort background work (call
chains) so a slow query fails fast instead of consuming the foreground
budget.

---

## 4. Code Mode API

**Files:** `src/server/sandbox/sandbox.ts` (`createSandboxAPI`), `src/server/sandbox/worker.ts` (`makeMethod`), `src/server/sandbox/api-spec.ts` (generated snapshot), `src/server/sandbox/schemas/` (Zod sources + `generator.ts`)

`createSandboxAPI()` is a synchronous factory returning a `SandboxAPI` object
that bridges LLM method calls to real `OpenGrokClient` calls. The worker
exposes all 19 methods as explicit `makeMethod("name")` entries on the single
`env.opengrok` namespace object — new methods must be added in both places
(plus `SANDBOX_ALLOWED_METHODS`). Several methods do more than a simple
pass-through. The authoritative signatures live as Zod `MethodSchema`s in
`sandbox-schemas/`; `sandbox-apispec-generated.ts` is the generated TypeScript declaration
snapshot served by `opengrok_api` (regenerate with `npm run generate:spec`,
never edit by hand).

### Full-shape results — no compaction

The bridge returns full `SearchResults` shapes (`query`, `searchType`,
`timeMs`, `startIndex`, `endIndex`, per-result `project`, matches as
`{lineNumber, lineContent}`) without stripping or renaming fields —
formatters, cursor-minting, and skills all depend on these shapes. Output size
is enforced by `fitToBuffer()` (8 MB bridge cap) and the
response-budget tiers, not by reshaping the payload.

### batchSearch — True Parallelism on the Host

Inside the sandbox, `Atomics.wait()` serializes all calls. But `batchSearch()`
is special: when the LLM calls it, the main thread uses `Promise.allSettled()`
to fire up to 10 sub-queries concurrently on the host event loop. The worker
blocks only once — while all N searches run in parallel on the main thread.
Per-query failures become `{_error}` result entries so one bad query doesn't
fail the batch, and the LLM is told to diagnose and fix them.

This is explicitly documented in the API spec to prevent LLMs from trying to
use `Promise.all()` (which doesn't help — all those calls still queue through
the bridge sequentially).

### getSymbolContext — Compound Tool

Rather than requiring the LLM to issue 2–4 searches to understand a symbol,
`getSymbolContext()` does all of it server-side:

1. Parallel `defs` and `refs` search (`contextLines` default 10, `maxRefs`
   default 5)
2. Fetch surrounding context lines from the definition file
3. For C++ implementation files, reuse the already-fetched `defs` results to
   find the matching header (no extra search)
4. Optional `file` scoping narrows definitions to one file (falls back to all
   defs when the scope matches nothing)
5. Return structured `{ found, symbol, kind, definition, header?, references }`
   in one call; `{found: false}` when the symbol is not in the index at all

### `traceCallChain` — Bidirectional

`traceCallChain(symbol, {direction, depth, project})` supports three
directions:

- `'callers'` (default) — BFS through callers of the symbol using `refs`
  search
- `'callees'` — extracts call expressions from the function body via the
  tree-sitter callee extractor, then resolves each callee with a `defs`
  search (ranked by path proximity to the calling file)
- `'both'` — runs both directions and merges results

The result distinguishes `"language not supported"` from `"Leaf function — no
callees found"` via `calleesNote`, reports `budgetExhausted` when the shared
search budget runs out, and runs on a background client (no rate limiting, 8s
best-effort timeout) so deep chains don't stall foreground queries.

### `expandFunction` — Inline Function Body Expansion

Passing `expandFunction: true` to `search()`, `batchSearch()`, or
`getFileContent()` triggers tree-sitter expansion of matches to their
enclosing function bodies (first match of up to 3 result files per call,
grouped by each result's own originating project). `getFileContent` returns
`functionName`/`functionStartLine`/`functionEndLine` alongside the expanded
content; search results gain a `functionContext` field. Expansion fetches the
full file (cache-hot after the first call) because mid-file windows can start
inside multi-line strings and produce unparseable fragments. This saves the
caller a separate read call when the function body context is needed
immediately after a `defs` search.

### Zero-Result Sampling Assist

When `search()` returns zero results and sampling is enabled, the API
automatically asks the client's LLM for alternative query suggestions:

```typescript
if (result.totalCount === 0 && mcpServer && samplingEnabled) {
  const raw = await sampleOrNull(mcpServer, [{
    role: "user",
    content: {
      type: "text",
      text: `Code search for "${query}" returned 0 results. ` +
            `Suggest 3 alternative search terms, comma-separated, no explanation.`,
    },
  }], { maxTokens: 60, systemPrompt: "You are a code search assistant. Be terse." });
  if (raw) result._suggestions = raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);
}
```

The server is asking the *client's* LLM to help reformulate bad queries — the
MCP server and the LLM are collaborating.

### Default Project Injection

`OPENGROK_DEFAULT_PROJECT` is injected for every `search()`, `batchSearch()`,
`findFile()`, and `searchSuggest()` call where `projects` is `undefined`. An
explicitly passed empty array `[]` means "search all projects" and is never
overridden.

### Cursor Pagination

All paginated sandbox methods (`search`, `findFile`, `getFileHistory`,
`browseDir`, `getFileSymbols`, `getFileDiff`) mint and accept opaque cursors
via the shared codec in `src/server/pagination/cursor-codec.ts` (`encodeCursor()` /
`decodeCursor()`): base64url-encoded JSON states (`{t:"offset",v,m}`,
`{t:"page",p}`, `{t:"raw",v}`), tagged per method so cross-method reuse is
rejected by `isOffsetCursorFor()`. An expired or malformed cursor returns the
`CURSOR_EXPIRED` sentinel (`{_cursorExpired: true, ...}`) rather than
throwing, so the LLM can detect it and restart pagination cleanly. The
`file`-filtered search path rejects cursors (no pagination there). Cursors are
stateless offset tokens — no server-side page storage is needed.

### Write Guard

`writeMemory` is capped at 5 calls per sandbox execution
(`MAX_SANDBOX_WRITES_PER_EXECUTION`) so runaway LLM code can't churn the
memory bank. `elicit` short-circuits to `{action: "cancel"}` unless
`OPENGROK_ENABLE_ELICITATION` is on, and `sample` returns `null` unless
sampling is enabled — both null-safe by contract.

---

## 5. Server Intelligence

**Files:** `src/server/intelligence.ts`, `src/server/intelligence/tree-sitter.ts`, `src/server/intelligence/ast-truncation.ts`, `src/server/intelligence/callee-extractor.ts`, `src/server/intelligence/import-extractor.ts`

> **Note on module structure:** The high-level functions `buildFileOverview()`,
> `buildCallChain()`, and `buildSymbolTree()` live in the flat
> `src/server/intelligence.ts` file. The `src/server/intelligence/`
> subdirectory contains the lower-level tree-sitter engine (`tree-sitter.ts`,
> `ast-truncation.ts`, `callee-extractor.ts`, `import-extractor.ts`), which is
> imported by both `intelligence.ts` and `sandbox.ts`.

### buildFileOverview — Tree-sitter Enhanced Symbol Extraction

One call to `buildFileOverview()` fans out into three parallel requests via
`Promise.allSettled()` (partial failures don't block the overview):

- `getFileSymbols()` — all symbols in the file
- `getFileContent(startLine=1, endLine=60)` — just the header, for import
  extraction
- `getFileHistory(maxEntries=3)` — recent authors and last revision

When the file language is tree-sitter supported, the overview compares the
AST-derived symbol tree against the index-derived one and prefers whichever
covers more of the file — tree-sitter operates on the actual AST so it
handles cases the index attributes to the wrong line, while the index wins
when AST extraction comes up short (macros, grammar gaps, files over the 4 MB
parse limit).

### buildSymbolTree — Cluster Detection

Raw symbols from the index are a flat list. `buildSymbolTree()` converts them
to a compact string array and detects when multiple symbols share the same
`lineStart:lineEnd` range, which indicates class methods all attributed to
the class body range:

```
Individual symbol:   "MyClass:class:L10-250"
Class methods:       "L10-250 [8 fn]: constructor, parse, render, format, validate, ..."
```

This collapses a 20-line symbol list into 3 lines when a class has many
methods, saving significant tokens. The algorithm groups symbols by
`lineStart:lineEnd` key; groups with 3+ members are "clusters" collapsed into
one line, single symbols are emitted individually. Missing `endLine` values
fall back to the next symbol's `startLine - 1`. `buildSymbolTreeFromAst()`
renders the same compact format from AST-extracted signatures.

### buildCallChain — Budget-Bounded BFS

Tracing callers of a symbol recursively is O(results × depth × branching
factor). At depth=4 with 10 results per search, worst case is 10^4 = 10,000
HTTP calls.

The implementation uses a shared mutable budget counter passed by reference
through all recursive branches (cap: depth 4, 50 searches):

```typescript
const searchBudget = { remaining: 50 };
await traceCallChain(client, symbol, depth, maxDepth, project, new Set(), new Map(), searchBudget, ...);
// All branches decrement searchBudget.remaining before each search call
// When remaining hits 0, branches return [] immediately
```

A `visited: Set<string>` prevents infinite recursion when symbols call each
other. A `symbolsCache: Map<string, FileSymbols>` caches per-file symbol
lookups so the same file is only fetched once across all branches. The
enclosing-function lookup (`getEnclosingFunction`) finds the smallest symbol
range containing a given line — "smallest" means most specific, e.g. a method
inside a class rather than the class itself. Header-file declarations (null
enclosing function in a header) and self-references are filtered to avoid
false positives in the caller graph.

The callee direction (`traceCallees`) resolves the symbol's definition, parses
the file with tree-sitter, and extracts real call expressions from the
function body — genuine callees, not text guesses. When several definitions
exist, candidates are ranked by path proximity to the calling file
(`computePathScope` / directory proximity score), eliminating cross-module
false positives for common names like `init` or `get`.

---

## 6. Memory Bank

**File:** `src/server/memory/memory-bank.ts` (+ `src/server/utils/file-cache.ts`)

The Memory Bank gives the LLM persistent cross-session storage. It's
intentionally minimal: only two files, strict size limits, controlled by a
locked write path. The directory is resolved in `main.ts`:
`OPENGROK_MEMORY_BANK_DIR` first (always set by the extension), then a
cwd-local `.opengrok/memory-bank` for dev-time terminal use, then the
XDG-aware config dir (`$XDG_CONFIG_HOME/opengrok-mcp/memory-bank`, defaulting
to `~/.config/...`) for all standalone clients.

### The Two Files

| File | Limit | Purpose |
|------|-------|---------|
| `active-task.md` | 4 KB | Current task state: what you're doing, last symbol, next step |
| `investigation-log.md` | 32 KB | Append-only history of what was searched and found |

### Stub Sentinel

Files are pre-created with template content. The sentinel
`<!-- OPENGROK_STUB:filename -->` marks uninitialized files. `read()` checks
for this prefix and returns `undefined` instead of stub content, so the LLM
skips processing an empty stub (and `readMemory` returns `null`). This is more
reliable than checking `startsWith('[')`, which could eat real content that
begins with a bracket.

### Per-File Async Mutex

Concurrent `writeMemory()` calls without a lock would produce lost updates:
both reads see the same base, both append, last writer wins. The lock is
implemented as a chained Promise:

```typescript
const prior = this.writeLocks.get(filename) ?? Promise.resolve();
let releaseRef!: () => void;
const lock = new Promise<void>((resolve) => { releaseRef = resolve; });
this.writeLocks.set(filename, prior.then(() => lock));
await prior;   // wait for previous write to finish
try {
  await this._writeUnlocked(filename, content, mode);
} finally {
  releaseRef(); // release lock regardless of success/failure
}
```

Each write appends to the chain. The lock is released in a `finally` block so
a failed write doesn't deadlock all future writes.

### trimLogFromTop — Richness-Scored Eviction

When `investigation-log.md` is full and a new entry needs to be appended, old
entries must be evicted. Instead of simple FIFO, the trimmer scores each `##
Header` section by information density:

```typescript
private scoreLogEntry(section: string): number {
  let score = 0;
  // Symbol names like CamelCase or ::namespaced are high signal
  score += symbolMatches.length * 2;
  // Conclusive entries are very valuable
  if (/found|root cause|conclusion|fixed|resolved/i.test(section)) score += 10;
  // Dead ends can be discarded sooner
  if (/dead end|no results|0 matches|nothing found/i.test(section)) score -= 5;
  return score;
}
```

The 2 most recent entries are always kept. Older entries are sorted by score
ascending and dropped one at a time until the file fits. Appends are stamped
`## YYYY-MM-DD HH:MM`.

### Delta Encoding

`readWithDelta()` tracks a SHA-256 hash (truncated to 16 hex chars) of the
last-read content for each file. If the content hasn't changed since last
read, it returns `"[unchanged]"` instead of the full content. This saves
tokens when the LLM reads the same file multiple times per session. The hash
uses SHA-256 rather than a 32-bit polynomial to avoid birthday collisions at
scale (~1% probability at 65K inputs for 32-bit). `getFileReference()` layers
a SHA-256 content-addressed `FileReferenceCache` on top for the optional Files
API path (`OPENGROK_ENABLE_FILES_API`), and large log reads are compressed
past an 8 KB threshold.

### UTF-8 Safe Truncation

`truncateUtf8()` walks backward from the byte limit to find a valid codepoint
boundary before slicing. A naive `Buffer.subarray(0, n)` can cut in the
middle of a 2–4 byte UTF-8 sequence and produce U+FFFD replacement
characters. The fix:

```typescript
while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
// 0x80-0xBF = continuation bytes — walk back past them
```

### statFile — Partial Read Optimization

`opengrok_memory_status` needs file size and a one-line preview without
reading the whole 32 KB log. `statFile()` stats the file for the size and
reads only the first 256 bytes for the preview.

---

## 7. Observation Masker

**File:** `src/server/memory/observation-masker.ts`

Long Code Mode sessions accumulate large tool results in the LLM's context
window. The Observation Masker (inspired by JetBrains research) keeps the last
N results as full text and summarizes older ones. Opt-in via
`OPENGROK_ENABLE_OBSERVATION_MASKER` (window size
`OPENGROK_OBSERVATION_MASKER_TURNS`, default 10; at most 500 entries retained,
FIFO).

### Summary Extraction

The masker does not use an LLM to summarize — it uses regex extraction to
preserve the only things that actually matter for code navigation:

- **File paths**: `project/path/file.ext` patterns (component rules exclude
  version strings like `v1.2.3`)
- **Line numbers**: `L123` and `:123` patterns
- **Symbol names**: CamelCase, UPPER_CASE, snake_case, getter/setter names
- **Match counts**: `N matches` patterns

Raw code content is discarded — it lives in the index and can be re-fetched.
The summary format: `files:a,b | lines:L10,L25 | syms:MyClass,parse |
found:42`.

### Masked History Header

When entries exceed the full window, older entries are prepended to the tool
result as a compact block (their full text is released to free memory):

```
<!-- ObservationMask: 7 earlier tool calls summarized -->
EARLIER SESSION OBSERVATIONS (summarized to save tokens):
[Turn 2] opengrok_execute(search "MyClass"): files:src/MyClass.cpp | syms:MyClass,parse | found:3
[Turn 4] opengrok_execute(getFileContent): files:src/MyClass.cpp | lines:L45,L67
...
END EARLIER OBSERVATIONS
```

---

## 8. HTTP Transport

**File:** `src/server/transport/http-transport.ts`

The standard MCP transport is stdio. The HTTP transport is an optional
additive layer for multi-user team deployments.

### Per-Session McpServer Instances

Every new client connection gets an entirely isolated `McpServer` instance via
`serverFactory()`. Sessions are keyed by `Mcp-Session-Id` headers. This allows
concurrent sessions with independent state (memory bank, rate limiting
context, etc.).

### Session Lifecycle

Sessions are tracked in a `Map<string, TransportHandle>`. An idle TTL sweep
runs every 5 minutes (timer `unref()`'d) and closes sessions inactive for 30
minutes:

```typescript
setInterval(() => {
  for (const [sid, handle] of sessions) {
    if (now - handle.meta.lastActivity > SESSION_TTL_MS) {
      sessions.delete(sid);   // delete BEFORE closing to prevent new requests racing in
      void handle.transport.close();
    }
  }
}, SESSION_SWEEP_INTERVAL_MS);
```

Sessions are deleted from the map *before* closing the transport, preventing a
race where a request could arrive for a session that's being closed and
resurrect it.

The session cap (default 100, `OPENGROK_HTTP_MAX_SESSIONS`) rejects new
`Initialize` requests with `503 Service Unavailable` when the limit is
reached.

### CORS

CORS is enforced with a custom allowlist. Loopback origins (`localhost`,
`127.0.0.1`, `[::1]`) are allowed only when no auth is configured (local
development); with auth configured (`OPENGROK_HTTP_AUTH_TOKEN` or RBAC
tokens), loopback must be listed explicitly in `OPENGROK_ALLOWED_ORIGINS`.
The `Vary: Origin` header is set whenever the
origin is reflected, so proxies cache correctly.

Security headers are set unconditionally: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, and a `Content-Security-Policy` of `default-src
'none'`.

### OAuth 2.1 Resource Server (RFC 9728)

The server implements the protected resource metadata endpoint:

```
GET /.well-known/oauth-protected-resource
→ { resource, authorization_servers, bearer_methods_supported: ["header"] }
```

JWT validation uses `jose`'s `createRemoteJWKSet()` with lazy initialization
(JWKS fetched on first use, then cached). The JWT's `scope` or `scp` claim is
mapped to an RBAC role via `scopeToRole()` (`opengrok:admin` → admin,
`opengrok:write` → developer, `opengrok:read` → readonly, overridable via
`OPENGROK_SCOPE_MAP`).

In `OPENGROK_STRICT_OAUTH=true` mode (which requires `OPENGROK_JWKS_URI`),
static Bearer tokens are disabled and only JWTs are accepted. The expected
issuer can be pinned with `OPENGROK_JWT_ISSUER`.

### RBAC

**File:** `src/server/transport/rbac.ts`

Three roles with a tool-level permission model, configured via
`OPENGROK_RBAC_TOKENS` (`'token1:admin,token2:readonly'` format; malformed
entries are ignored):

| Role | What they can do |
|------|-----------------|
| `admin` | All tools (wildcard `*`, covers future tools automatically) |
| `developer` | Search, read, execute sandbox, memory tools (explicit allow-list) |
| `readonly` | Read-only tools only — no execute, no memory writes, no batch |

RBAC is checked per tool call, not per session. Role is captured at session
creation (from the Bearer token or JWT scopes), then checked on every
`tools/call` request.

Token comparison uses `timingSafeEqual` to prevent timing attacks:

```typescript
const a = Buffer.from(provided, 'utf8');
const b = Buffer.from(secret, 'utf8');
if (a.length !== b.length) return false;
return timingSafeEqual(a, b);
```

---

## 9. Per-Tool Rate Limiting

**File:** `src/server/tools/tool-rate-limiter.ts`

There are two independent rate limiting layers:

### Layer 1 — Global Client Rate Limit (`client.ts`)

A single token bucket limits total HTTP requests to the index (default: 60
RPM via `OPENGROK_RATELIMIT_RPM`). This protects the server from overload.

### Layer 2 — Per-Tool Rate Limit (`ToolRateLimiter`)

Different tools have different costs. `opengrok_batch_search` can fan out into
10 HTTP calls per invocation; `opengrok_call_graph` can fan out recursively.
Per-tool limits prevent any single expensive tool from starving others
(defaults from `DEFAULT_PER_TOOL_LIMITS` in `config.ts`, overridable per tool
via `OPENGROK_PER_TOOL_RATELIMIT` accepting `tool=rpm` or `tool:rpm` pairs):

| Tool | Default Limit |
|------|--------------|
| `opengrok_batch_search` | 5 RPM |
| `opengrok_execute` | 15 RPM |
| `opengrok_dependency_map` | 10 RPM |
| `opengrok_call_graph` | 5 RPM |
| `opengrok_search_and_read` | 10 RPM |
| `opengrok_update_memory` | 20 RPM |

The key design decision: **one persistent `processQueue` loop per tool**
rather than a new `setTimeout` per waiter. If 50 callers pile up on a 5 RPM
tool and each registered its own `setTimeout`, you'd have 50 timers firing at
once. The single loop wakes up, serves one caller, then sleeps until the next
token is available.

Callers that wait beyond their `maxWaitMs` deadline (default: 30s) are
rejected with an error and removed from the queue. The audit log records each
rejection.

---

## 10. MCP Protocol Extensions

### Elicitation — Asking the User Mid-Execution

**File:** `src/server/protocol/elicitation.ts`

MCP Elicitation lets the server pause tool execution and ask the user a
question, gated by `OPENGROK_ENABLE_ELICITATION`. In Code Mode this is used
when `findFile()` or `search()` returns multiple matches that are ambiguous.

The LLM code calls:

```javascript
const result = env.opengrok.elicit("Which file do you mean?", {
  type: "object",
  properties: {
    file: { type: "string", enum: ["src/Foo.cpp", "lib/Foo.cpp", "test/Foo.cpp"] }
  },
  required: ["file"]
});
if (result.action !== "accept") return "Cancelled — please specify the file.";
```

`elicitOrFallback()` accesses the low-level `server.server.elicitInput()`
(not exposed on the public `McpServer` API surface as of SDK v1.28.0) and
returns `{ action: "cancel" }` if elicitation is disabled, unsupported, or
errors — keeping older clients working. Every attempt is audit-logged.

### Sampling — The Server Asking the LLM

**File:** `src/server/protocol/sampling.ts`

MCP Sampling inverts the normal direction: the *server* asks the *client's
LLM* to generate text. This is used for:

- Auto-suggestions when search returns zero results (the LLM reformulates the
  query)
- The `sample()` sandbox method which LLM-written code can call explicitly
- Server-side reformulation help and summaries in standard-mode tools

`sampleOrNull()` wraps this with:

- **Deadline-bounded retries**: 2 retries by default
- **Exponential backoff**: 500ms, 1000ms, 2000ms between retries
- **Per-attempt timeout** (default 10s) via `Promise.race()` with a
  `setTimeout` rejection
- **Model preference** via `OPENGROK_SAMPLING_MODEL`, token budget via
  `OPENGROK_SAMPLING_MAX_TOKENS` (64–4096, default 256)
- **Null on all failure modes**: sampling unavailable, timeout, error — never
  throws, so callers must always null-guard

```
attempt 0: race(callSampling(), timeout(10s))
  on success: return result
  on failure: if retries remain, sleep(500ms * 2^attempt), try again
  on retries exhausted: return null
```

---

## 11. Audit Logging and Redaction

### Audit Log

**File:** `src/server/transport/audit.ts`

Every security-sensitive operation writes a structured NDJSON entry to
`stderr`. Never to `stdout` — that's the MCP protocol stream. Entries carry
only safe metadata (tool name, project, short detail — each capped at 200
chars); credentials, tokens, and full content are never passed in.

Events logged: `tool_invoke`, `rate_limited`, `sandbox_exec`, `auth_used`,
`config_load`, `elicitation_request`, `elicitation_unsupported`.

When `OPENGROK_AUDIT_LOG_FILE` is set, entries are also appended to file. The
file write is **fire-and-forget** via an async write queue that serializes
concurrent appends:

```typescript
_writeQueue = _writeQueue.then(() => fsp.appendFile(filePath, line).catch(handleError));
```

Each new write chains onto the previous one, guaranteeing serialization
without blocking the caller. Dropped writes are counted; a warning is emitted
on the first drop and every 10th thereafter.

The log can be exported as JSON or CSV with `export-audit` (`--format`,
`--output`). The CSV exporter prevents formula injection (`=`, `+`, `-`,
`@`, tab, CR prefixes are escaped with `'`) so audit logs can be safely
opened in spreadsheets.

### Redaction

**File:** `src/server/utils/redact.ts`

Three separate sanitizers (pure transforms — no logging, no side effects):

**`redactString()`** — used by the logger on all outbound strings:

- Strips Basic auth header values
- Strips URL-embedded credentials (`user:pass@host`)
- Strips Bearer tokens
- Redacts absolute POSIX paths under `/home`, `/Users`, `/tmp`, `/var`,
  `/etc`, `/proc`, container paths, etc.
- Redacts Windows paths

**`sanitizeErrorMessage()`** — used before surfacing errors to the LLM:

- Strips JavaScript stack trace lines (`at ...`, `node:internal/...`)
- Applies `redactString()`
- Hard-caps at 2048 chars

**`sanitizeSandboxError()`** — more aggressive, sandbox-specific (also used
for the sandbox error capture path, capped at 500 chars):

- Also strips QuickJS WASM worker paths
- Also strips UNC paths (`\\server\share`)
- Also strips relative traversal paths (`../../...`)
- Uses `<path>` / `<node-internal>` markers (angle-bracket style) to
  distinguish from server-context redactions
- Hard-caps at 500 chars

---

## 12. Credential Security

**Files:** `src/server/cli/keychain.ts`, `src/server/config.ts`, `src/server/main.ts`, `src/extension.ts`

Credentials are never stored in plaintext on disk and never appear in process
environment tables. There are three storage tiers used in priority order.

### Priority Chain at Server Startup

`resolveConfig()` in `main.ts` runs before `loadConfig()` and determines where
the password comes from:

```
resolveConfig() — main.ts
  │
  ├─ OPENGROK_PASSWORD set in env?       → pass directly to loadConfig() as-is
  ├─ OPENGROK_PASSWORD_FILE set in env?  → read file; pass content as override
  └─ neither set, OPENGROK_USERNAME present?
        │
        ├─ OS keychain (@napi-rs/keyring) → found? inject as loadConfig({ OPENGROK_PASSWORD })
        ├─ AES-256-GCM encrypted file     → found? inject as loadConfig({ OPENGROK_PASSWORD })
        └─ nothing found                  → loadConfig() warns; auth calls will fail
```

The critical design: the resolved password is passed as a `loadConfig()`
**override parameter**, not written to `process.env`. This keeps plaintext out
of:

- `/proc/self/environ` (readable by any process with the same UID on Linux)
- Child process environments (native addons, spawned subprocesses)
- Memory dumps that scan environment tables

`status.ts` follows the same chain (with stored-config fallback) so health
checks authenticate exactly like the server.

### Tier 1 — Environment Variable (CI / Docker)

`OPENGROK_PASSWORD` is accepted directly by `loadConfig()`. This is the
lowest-trust path, intended for container deployments where a secrets manager
injects the variable at runtime — or a file-mounted secret via
`OPENGROK_PASSWORD_FILE`. The server never logs or exposes it.

### Tier 2 — OS Keychain via `@napi-rs/keyring`

On platforms with a system keychain (macOS Keychain, Windows Credential
Manager, Linux `libsecret`/kwallet), credentials are stored natively under
service `opengrok-mcp`, account = username.

**Writing from the CLI setup wizard** (`keychain.ts:storeCredentials`):
purges legacy files first, then writes to the keychain, then stamps the
rotation timestamp — falling through to the encrypted file if
`setPassword()` throws.

**Writing from the extension** (`extension.ts`, guarded by `_credentialsSynced`
so it happens once per process — no-clobber): writes to the OS keychain, or
to the encrypted-file envelope on headless systems. The password itself is
never placed in the spawned server's environment; the server re-reads it via
`resolveConfig()` at startup.

**Reading at server startup** (`keychain.ts:retrievePassword`): returns the
keychain password, or `null` (keyring accessible but no entry) to fall through
to the encrypted file. `getKeyringEntry()` catches all `require()` errors and
returns `null`, so the entire keychain path silently degrades on systems
where the native addon doesn't load.

### Tier 3 — AES-256-GCM Encrypted File (Headless Fallback)

When the keychain is unavailable, credentials are stored in an encrypted file
under the XDG config dir (`~/.config/opengrok-mcp/cred-<hash>.enc` by
default). Permissions are `0o600` — owner read/write only. Usernames are
hashed (SHA-256, 32 hex chars) for the filename, and every path is
resolved-and-contained to block traversal.

#### Key Derivation

```typescript
function deriveFileKey(username: string): string {
  return crypto.createHash('sha256')
    .update(`opengrok-mcp:${username}:${os.platform()}`)
    .digest('hex');   // 64 hex chars = 32 bytes when parsed
}
```

Platform is used instead of hostname because hostname changes on DHCP
reassignment, VPN connect, container restarts, and renames — all of which
would silently break decryption.

#### Encryption (`encryptWithGcm`)

```typescript
function encryptWithGcm(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');        // 32-byte AES key
  const iv  = crypto.randomBytes(12);             // fresh random 12-byte IV per write
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();               // 16-byte GCM authentication tag
  // Pack: IV (12) || tag (16) || ciphertext (N)
  return 'gcm:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}
```

Authenticated encryption; tampering makes decryption throw. Fresh random IV
per write; `gcm:` version prefix; `0o600` enforced at write time.

#### Legacy Key Migration (Transparent, One-Time)

The old key format included the hostname. On read, the new key is tried
first; on failure the legacy hostname-based key is tried, and on success the
password is immediately re-encrypted under the new key. Legacy raw-username
filenames are also probed. No user interaction required.

### Credential Rotation Tracking

Every `storeCredentials()` call writes a rotation timestamp
(`last-credential-rotation.json` in the config dir).
`checkCredentialAge()` returns a warning string if credentials haven't been
rotated in over 365 days; `status` surfaces it. Advisory only — never blocks
startup or auth.

### Legacy File Purge

Every `storeCredentials()` call deletes older-format artifacts
(`cred-*.key`, `credentials.enc`, `.salt`, `config`) so stale key material
doesn't linger next to the current envelope. `deleteCredentials()` removes
keychain entries plus current and legacy files.

---

## 13. CLI Layer

**Files:** `src/server/main.ts` (routing), `src/server/cli/setup/wizard.ts`, `src/server/cli/setup/configure.ts`, `src/server/cli/setup/detect.ts`, `src/server/cli/status.ts`, `src/server/cli/keychain.ts`

`main.ts` routes the first argv token to three subcommands
(`setup`/`status`/`export-audit`, plus `--version`); anything else starts the
MCP server.

| Command | File | Purpose |
| ------- | ---- | ------- |
| `setup` | `cli/setup/wizard.ts` | Interactive wizard — writes MCP client configs, stores credentials |
| `status` | `cli/status.ts` | Health check: connectivity, latency, mode, client detection, credential age |
| `export-audit` | `main.ts` + `audit.ts` | Export audit log as CSV or JSON (`--format`, `--output`) |

### setup

Built on `@clack/prompts`. Previously stored values are pre-filled via
`readStoredEnv()` (which checks Claude Code → Copilot CLI → Codex configs in
priority order), and the password prompt offers "press Enter to keep
existing" — stored secrets are never clobbered by an empty answer. The
wizard collects connection details (URL, username, password, SSL), response
budget, and opt-in flags (elicitation, sampling, observation masker, Files
API cache), then writes per-client configs: Claude Code CLI, Codex CLI, and
the Copilot CLI (via its own `mcp add` command), plus a VS Code settings
helper. `buildEnv()` in `configure.ts` emits only non-default values so
stored configs stay minimal.

### status

Resolves configuration exactly like the server (stored-env fallback, then the
password file/keychain chain) and prints URL, username, SSL mode, indexed
project count, latency, mode/budget, password-file/response-cap/SSRF/JWT
settings, grammar dir, per-client configuration ticks, and the credential-age
warning. A non-blocking latest-version check (3s abort) prints an update hint
when the published package is newer; network failures are silent.

---

## 14. Tree-sitter Code Analysis Engine

**Files:** `src/server/intelligence/tree-sitter.ts`, `src/server/intelligence/ast-truncation.ts`, `src/server/intelligence/callee-extractor.ts`, `src/server/intelligence/import-extractor.ts`

Tree-sitter is a deterministic parser generator used here to produce accurate
ASTs for code navigation. Index symbol positions are approximate — they are
derived from tokenization, not from parsing. Tree-sitter gives exact line
ranges for every function, class, and method definition.

### Language Support

Grammar WASM files are copied into `grammars/` by `npm run copy-grammars` and
bundled to `out/grammars/` by esbuild. The `LANGUAGE_GRAMMAR_MAP` in
`tree-sitter.ts` maps **117 language keys** (C family, JS/TS ecosystem,
JVM languages, scripting/dynamic languages, systems languages, data/config
formats, and more) to grammar files — parsing succeeds for all of them, with
AST-aware features (symbol extraction, truncation, function expansion,
imports, callees) layered on top for the grammars with definition/call/import
queries.

Languages without a bundled grammar are detected via
`isLanguageSupported(lang)` and fall through to index-only mode gracefully —
no errors, just no AST enhancement.

Tree-sitter operations are **best-effort throughout**: all parse/query
failures are silently caught and the caller falls back to raw index results.
A broken grammar, a file that exceeds the 4 MB `MAX_FILE_SIZE` limit, or a
malformed AST never propagates as an error to the LLM.

Grammar files are resolved by walking up from `__dirname` to find a
`grammars/` directory. Override via the `OPENGROK_GRAMMAR_DIR` environment
variable.

### Initialization and Deadlock Prevention

`web-tree-sitter`'s `Parser.init()` loads a shared runtime WASM binary. Three
guards prevent failures:

1. **Singleton promise** (`initPromise ??=`) — multiple callers awaiting
   `ensureInit()` share the same in-flight init, preventing duplicate WASM
   loads. A failed init resets the promise so the next caller retries instead
   of caching the rejection.

2. **10-second timeout race** — `Parser.init()` is raced against a 10-second
   timer. If the WASM file is missing from the bundle directory, the hang is
   limited to 10 seconds, not 62 seconds.

3. **Language load deduplication** (`languageLoadPromises`) — concurrent
   `loadLanguage()` calls for the same grammar share one in-flight promise
   (deleted on settle). Without this, two concurrent callers could both call
   `Parser.Language.load()` and deadlock the WASM runtime's single-threaded
   environment.

### AST-Aware Truncation

**`truncateAtBoundary(content, maxLines, language)`** — the primary truncation
function.

Algorithm:

1. Parse the file with tree-sitter to get all top-level symbol boundaries
   (functions, classes, structs, namespaces, interfaces).
2. Greedily include complete symbols whose `endLine <= maxLines`.
3. If no complete symbol fits, include up to the line before the first symbol
   starts (preamble only).
4. Append a footer listing all truncated symbols with their line ranges.

The footer guides the LLM toward efficient follow-up reads:

```
// [Truncated at L450 of 3200 — remaining: processRequest (L451–520), handleError (L521–580), ...]
// Use getFileContent(project, path, {startLine, endLine}) to fetch any of the above.
```

### Function Body Expansion

**`expandToFunctionBoundary(content, matchLine, language, maxLines)`** — for
bounded-range reads.

The router fetches the full file (cache-hot), then finds the enclosing
function containing `matchLine`. If the function fits within the budget, its
complete body is returned with `functionName`/`functionStartLine`/
`functionEndLine`. If not, a condensed version (signature + context window
around `matchLine` + closing brace) is returned.

This eliminates the common pattern of requesting N lines of context only to
realize the function extends beyond them. A shared `getDefinitionName()`
resolver handles grammars whose definition nodes carry no `name` field.

### Import Extractor

**`import-extractor.ts`** — extracts `#include` / `import` statements from
source files for the `uses` direction of dependency analysis. Runs
tree-sitter queries per language family (C/C++ `preproc_include` capturing
both `"header.h"` and `<system.h>`; ES module imports; Kotlin import
headers; and more). Angle-bracket includes ending in `.h` are treated as
project headers (modern standard-library headers have no extension).
Unresolvable includes (system headers, third-party packages) are dropped to
eliminate noise.

### Callee Extractor

**`callee-extractor.ts`** — extracts function call expressions from inside a
function body via `extractCallees()`.

Used by `traceCallChain(symbol, {direction: 'callees'})`. The extractor:

1. Finds the function definition containing the requested symbol using
   `extractSignatures()`
2. Queries for call-expression nodes within that function's body (per-grammar
   query shapes; some grammars expose the callee as the first named child)
3. Deduplicates callee names and returns them
4. For each callee name, runs a `defs` search to find where it is defined

Proximity ranking eliminates cross-module false positives when callee names
are common (e.g., `init`, `delete`, `get`).

---

## 15. Long-Running Calls (Synchronous Execution)

There is no fire-and-forget/polling layer: every sandbox method executes
synchronously over the SharedArrayBuffer bridge and returns its full result
directly (or a timeout error past the 62-second budget). `traceCallChain()`
runs on a background client (rate-limit-free, 8s best-effort timeout) for the
same reason — fail fast instead of polling. If a future method's worst case
reliably exceeds the 62-second budget, add explicit paging (offset cursors, as
in §4) rather than a background cache.
