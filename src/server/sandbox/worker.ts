/**
 * Sandbox worker — runs inside a worker_threads.Worker.
 * Loads QuickJS WASM VM and executes LLM-written JavaScript in isolation.
 *
 * Communication with the main thread uses two channels:
 *   - SharedArrayBuffer + Atomics: synchronous bridge for mid-execution API calls
 *   - parentPort.postMessage: final result (or error) after code completes
 *
 * Buffer layout (must exactly match sandbox.ts):
 *   Bytes 0–15:  Int32Array  statusArray  — [0]: 0=idle (result written to buffer, worker free to read), 1=pending_call (worker is blocked on Atomics.wait)
 *                                              Note: status is never set to 2; main thread signals completion by resetting to 0 and calling Atomics.notify.
 *   Bytes 16–19: Uint32Array lengthArray  — [0]: byte count of JSON payload in dataArray
 *   Bytes 20+:   Uint8Array  dataArray    — JSON payload (max 8 MB, see sandbox-protocol.ts DATA_REGION_BYTES)
 *   TOTAL: SHARED_BUFFER_SIZE = 20 + DATA_REGION_BYTES
 *
 * Design decisions:
 *   - Wrapped in IIFE (no top-level await — CJS compatibility, issue #2)
 *   - callHostSync() uses Atomics.wait() to block the worker thread while the
 *     main thread processes the async API call (issue #3, #7)
 *   - LLM code uses `return value`; IIFE wrapper captures it (issue #4)
 *   - Atomics.store(statusArray, 0, 1) is followed by Atomics.notify to wake
 *     the main thread's Atomics.waitAsync loop (nobody polls anymore)
 *   - executionTimeout is NOT passed to runSandboxed: the QuickJS wall-clock interrupt
 *     fires while Atomics.wait() is blocking (wall time ≠ CPU time), killing ctx mid-bridge
 *     and corrupting the WASM heap in pooled workers. Safety is provided by callHostSync()'s
 *     62s per-call Atomics.wait() timeout + executeInSandbox()'s 62s hard worker kill.
 */

import { workerData, parentPort } from "worker_threads";
import { loadQuickJs, type SandboxOptions } from "@sebastianwessel/quickjs";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { STATUS_OFFSET, LENGTH_OFFSET, DATA_OFFSET } from "./protocol.js";

// ---------------------------------------------------------------------------
// Buffer layout imported from sandbox-protocol.ts (shared with sandbox.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runJob — execute one unit of LLM code inside QuickJS with the given buffer
// ---------------------------------------------------------------------------

type RunSandboxed = Awaited<ReturnType<typeof loadQuickJs>>["runSandboxed"];

async function runJob(
  runSandboxed: RunSandboxed,
  sharedBuffer: SharedArrayBuffer,
  code: string
): Promise<void> {
  // Typed views into the shared buffer (layout pinned — must match sandbox.ts)
  const statusArray = new Int32Array(sharedBuffer, STATUS_OFFSET, 4);
  const lengthArray = new Uint32Array(sharedBuffer, LENGTH_OFFSET, 1);
  const dataArray   = new Uint8Array(sharedBuffer, DATA_OFFSET);

  // ---------------------------------------------------------------------------
  // callHostSync — synchronous bridge to main thread async API
  // ---------------------------------------------------------------------------

  /**
   * Encode a host API call request into the shared buffer, block this worker
   * thread until the main thread writes the result, then return it.
   *
   * The main thread sleeps in Atomics.waitAsync and is woken by the notify
   * below; it processes the call asynchronously while this thread is blocked
   * in Atomics.wait().
   */
  function callHostSync(methodName: string, args: unknown[]): unknown {
    const payload = JSON.stringify({ method: methodName, args });
    const encoded = Buffer.from(payload, "utf8");

    if (encoded.length > dataArray.length) {
      throw new Error(`callHostSync payload too large: ${encoded.length} bytes (max ${dataArray.length})`);
    }

    // Write call payload into the buffer
    lengthArray[0] = encoded.length;
    dataArray.set(encoded, 0);

    // Signal: pending_call — wake main thread's Atomics.waitAsync
    Atomics.store(statusArray, 0, 1);
    Atomics.notify(statusArray, 0, 1);

    // Block until main thread writes result (resets status to 0) and notifies
    const waitResult = Atomics.wait(statusArray, 0, 1, 62_000);
    if (waitResult === "timed-out") {
      throw new Error(`callHostSync: 62s deadline exceeded for method "${methodName}" — main thread unresponsive`);
    }

    // Read response
    const resLen = lengthArray[0];
    if (resLen > dataArray.length) {
      throw new Error(`callHostSync: response length ${resLen} exceeds buffer size ${dataArray.length} — protocol error`);
    }
    const resBytes = dataArray.subarray(0, resLen);
    const resJson = Buffer.from(resBytes).toString("utf8");
    let res: Record<string, unknown>;
    try {
      res = JSON.parse(resJson) as Record<string, unknown>;
    } catch {
      throw new Error(`callHostSync: malformed response from main thread (first 100 chars: ${resJson.slice(0, 100)})`);
    }

    if ("__error" in res) throw new Error(res["__error"] as string);
    if (!("data" in res)) {
      throw new Error(
        `callHostSync: response missing "data" field for "${methodName}" — ` +
        `got keys: [${Object.keys(res).join(", ")}]. This is a protocol error.`
      );
    }
    return res["data"];
  }

  // ---------------------------------------------------------------------------
  // env.opengrok — 21 methods, all wired through callHostSync.
  // Flat globals (search, getFileContent, …) are destructured below so LLM
  // code can call either form: search(...) or env.opengrok.search(...).
  // ---------------------------------------------------------------------------

  const makeMethod = (name: string) =>
    (...args: unknown[]) => callHostSync(name, args);

  const env = {
    opengrok: {
      search:           makeMethod("search"),
      batchSearch:      makeMethod("batchSearch"),
      getFileContent:   makeMethod("getFileContent"),
      getSymbolContext: makeMethod("getSymbolContext"),
      getFileSymbols:   makeMethod("getFileSymbols"),
      getFileHistory:   makeMethod("getFileHistory"),
      getFileAnnotate:  makeMethod("getFileAnnotate"),
      browseDir:        makeMethod("browseDir"),
      findFile:         makeMethod("findFile"),
      getFileOverview:  makeMethod("getFileOverview"),
      traceCallChain:   makeMethod("traceCallChain"),
      searchSuggest:    makeMethod("searchSuggest"),
      getCompileInfo:   makeMethod("getCompileInfo"),
      indexHealth:      makeMethod("indexHealth"),
      listProjects:     makeMethod("listProjects"),
      getGuidanceForPath: makeMethod("getGuidanceForPath"),
      readMemory:       makeMethod("readMemory"),
      writeMemory:      makeMethod("writeMemory"),
      getFileDiff:      makeMethod("getFileDiff"),
      elicit:           makeMethod("elicit"),
      sample:           makeMethod("sample"),
    },
  };

  // ---------------------------------------------------------------------------
  // QuickJS sandbox options
  // ---------------------------------------------------------------------------

  // No-op console prevents sandbox code from writing to parent stdout (MCP transport).
  // All 18 console methods must be silenced — the library's default forwards to host console.
  const noop = () => {};
  const silentConsole = {
    log: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop,
    assert: noop, count: noop, countReset: noop, dir: noop, dirxml: noop,
    group: noop, groupCollapsed: noop, groupEnd: noop, table: noop,
    time: noop, timeEnd: noop, timeLog: noop, clear: noop,
  };

  const options: SandboxOptions = {
    // executionTimeout is intentionally omitted: the QuickJS wall-clock interrupt
    // fires while Atomics.wait() is blocking, killing ctx mid-bridge call and
    // corrupting the WASM heap in pooled workers (see design decisions above).
    memoryLimit:      128 * 1024 * 1024, // 128 MB
    maxStackSize:     4 * 1024 * 1024,   // 4 MB
    allowFetch:       false,
    allowFs:          false,
    env:              env as Record<string, unknown>,
    console:          silentConsole,
  };

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  if (!parentPort) throw new Error("parentPort is null — worker must run inside worker_threads");

  try {
    // Destructure flat globals from env.opengrok so LLM code can call search()
    // directly (not env.opengrok.search()). The IIFE closes over these bindings.
    // env.opengrok.* keeps working — both forms bridge to the same host methods.
    const destructure = `const { search, batchSearch, getFileContent, getSymbolContext, getFileSymbols, getFileHistory, getFileAnnotate, browseDir, findFile, getFileOverview, traceCallChain, searchSuggest, getCompileInfo, indexHealth, listProjects, getGuidanceForPath, readMemory, writeMemory, getFileDiff, elicit, sample } = env.opengrok;`;
    // Wrap LLM code: async IIFE captures `return` (including `return await …`),
    // outer exports via `export default`. Without the async wrapper, code that
    // returns a Promise would export the Promise object rather than its resolved
    // value, causing silent empty results for any LLM-written async code.
    const wrappedCode = `${destructure}\nconst __result = await (async () => { ${code} })();\nexport default __result;`;

    const result = await runSandboxed(
      async ({ evalCode }) => evalCode(wrappedCode),
      options
    );

    parentPort.postMessage(result);
  } catch (err) {
    const error = err as Error;
    parentPort.postMessage({
      ok: false,
      error: {
        name: error.name ?? "Error",
        message: error.message ?? "Unknown sandbox error",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Main IIFE — required for CJS compatibility (no top-level await)
// ---------------------------------------------------------------------------

void (async () => {
  if (!parentPort) throw new Error("parentPort is null — worker must run inside worker_threads");

  const data = workerData as { sharedBuffer?: SharedArrayBuffer; code?: string } | null;

  if (data?.code !== undefined) {
    // Immediate mode (existing behavior): workerData supplies sharedBuffer + code
    const { runSandboxed } = await loadQuickJs(variant);
    if (!data.sharedBuffer) throw new Error("sandbox error: sharedBuffer missing");
    await runJob(runSandboxed, data.sharedBuffer, data.code);
    return;
  }

  // Pool mode: preload QuickJS WASM (warm-up), then wait for jobs via postMessage
  const { runSandboxed } = await loadQuickJs(variant);
  parentPort.postMessage({ type: "ready" });

  parentPort.on("message", (msg: { sharedBuffer: SharedArrayBuffer; code: string }) => {
    void runJob(runSandboxed, msg.sharedBuffer, msg.code).catch((err) => {
      // Safety net: in pool mode no resolver may be waiting for this result.
      // Swallow the rejection to prevent Node 22+ from treating it as fatal.
      process.stderr.write(`[sandbox-worker] unhandled runJob error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });

  parentPort.on("error", (err) => {
    process.stderr.write(`[sandbox-worker] parentPort error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
})();
