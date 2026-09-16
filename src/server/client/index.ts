/**
 * Barrel re-exports for client subsystem (exact previous client.ts surface + extensions).
 */
export { TTLCache, estimateBytes } from "./cache.js";
export { TIMEOUTS, sleep, extractLineRange, MAX_RESPONSE_BODY_BYTES, safeResponseText } from "./text-utils.js";
export {
  assertSafePath,
  unmapIPv6,
  isPrivateIp,
  buildSafeUrl,
  isSafeRedirect,
  normalizeFileType,
  VALID_FILE_TYPES,
  validateFileType,
  matchesFileType,
} from "./security.js";
export type { SuggestItem, SuggestConfig, RssHistoryEntry } from "./opengrok-client.js";
export { OpenGrokClient } from "./opengrok-client.js";
export { parseSearchResponse } from "./response-parser.js";
export { CURSOR_EXPIRED } from "./opengrok-client.js";
export { _RateLimiter, _TTLCache, _estimateBytes, _sleep, _TIMEOUTS } from "./opengrok-client.js";
