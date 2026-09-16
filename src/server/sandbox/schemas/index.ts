import { assembleSpec } from "./generator.js";
import { ALL_INTERFACES } from "./interfaces.js";
import { SEARCH_METHODS } from "./search.js";
import { READ_NAVIGATE_METHODS } from "./read-navigate.js";
import { HISTORY_BLAME_METHODS } from "./history-blame.js";
import { CODE_INTELLIGENCE_METHODS } from "./code-intelligence.js";
import { SYSTEM_METHODS } from "./system.js";
import { FEATURE_FLAG_METHODS } from "./feature-flag.js";

const HEADER_LINES = [
  "// OpenGrok — Code search sandbox. Call methods as flat globals: search(...), getFileContent(...).",
  "// The env.opengrok.* object form (env.opengrok.search(...)) is equivalent — use either.",
  "// All methods are synchronous in the sandbox (the host bridges async calls).",
  "// 'return' emits the tool result — console.log is a no-op.",
  "// Shadowing a global (e.g., 'const search = search(...)') causes a ReferenceError at runtime.",
  "// _truncated in any response = output cap hit; _droppedCount = items dropped; _droppedKeyNames = object keys dropped.",
  "// Pagination: absent cursor = last page; total (when present) is the full result count. Expired/invalid cursors return {_cursorExpired:true} — reissue without cursor.",
  "// _suggestions (on SearchResult): present when sampling is enabled.",
  "// fileType is the lowercased analyzer class name with 'analyzer' suffix removed (e.g. CxxAnalyzer -> 'cxx').",
];

/** Generate the complete API spec TypeScript declaration string from Zod schemas. */
export function generateApiSpec(): string {
  return assembleSpec({
    headerLines: HEADER_LINES,
    interfaces: ALL_INTERFACES,
    sections: [
      { header: "// --- Search & Discovery ---", methods: SEARCH_METHODS },
      { header: "// --- Read & Navigate ---", methods: READ_NAVIGATE_METHODS },
      { header: "// --- History & Blame ---", methods: HISTORY_BLAME_METHODS },
      { header: "// --- Code Intelligence ---", methods: CODE_INTELLIGENCE_METHODS },
      { header: "// --- System ---", methods: SYSTEM_METHODS },
      { header: "// --- Feature-flag dependent ---", methods: FEATURE_FLAG_METHODS },
    ],
  });
}

export { ALL_INTERFACES } from "./interfaces.js";
export type { MethodSchema, InterfaceSchema } from "./generator.js";
