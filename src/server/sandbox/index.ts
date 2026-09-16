/**
 * Sandbox subsystem barrel (exact previous sandbox.ts surface).
 */
export { sanitizeSandboxError } from "./sandbox.js";
export type { SandboxAPI, SandboxOpts } from "./sandbox.js";
export { createSandboxAPI, executeInSandbox, filterApiSpec } from "./sandbox.js";
export { API_SPEC_TS, API_SPEC, METHOD_SIGNATURES } from "./api-spec.js";
export { fitToBuffer, buildBatchSearchStubs } from "./buffer.js";
export { SHARED_BUFFER_SIZE, STATUS_OFFSET, LENGTH_OFFSET, DATA_OFFSET, DATA_REGION_BYTES } from "./protocol.js";
export { SandboxWorkerPool } from "./worker-pool.js";
export type { WorkerHandle } from "./worker-pool.js";
export { matchErrorToHint } from "./error-hints.js";
export { SANDBOX_ALLOWED_METHODS } from "./sandbox.js";
