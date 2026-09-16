/**
 * Shared buffer layout constants for the sandbox main-thread ↔ worker protocol.
 *
 * MUST be kept in sync between sandbox.ts (main thread) and sandbox-worker.ts
 * (worker thread). Importing from this module ensures both sides agree on the
 * layout — a mismatch would silently corrupt all inter-thread communication.
 *
 * Buffer layout (Int32Array / Uint32Array / Uint8Array views):
 *
 *   Bytes 0–15:  Int32Array  statusArray  — [0]: 0=idle, 1=pending_call, 2=result_ready
 *   Bytes 16–19: Uint32Array lengthArray  — [0]: byte count of JSON payload in dataArray
 *   Bytes 20+:   Uint8Array  dataArray    — JSON payload (max DATA_REGION_BYTES)
 */

export const STATUS_OFFSET  = 0;   // byte offset for statusArray (Int32Array, 4 elements × 4 bytes = 16 bytes)
export const LENGTH_OFFSET  = 16;  // byte offset for lengthArray (Uint32Array, 1 element × 4 bytes)
export const DATA_OFFSET    = 20;  // byte offset for dataArray   (Uint8Array, DATA_REGION_BYTES bytes)
export const DATA_REGION_BYTES = 8 * 1024 * 1024; // 8 MB data region
export const SHARED_BUFFER_SIZE = DATA_OFFSET + DATA_REGION_BYTES; // 20 + 8 MiB
