/**
 * Tool documentation constants (split from server.ts, pure move).
 */
import { z } from "zod";
import {
  BatchSearchArgs,
  BlameArgs,
  BrowseDirectoryArgs,
  GetCompileInfoArgs,
  GetFileAnnotateArgs,
  GetFileContentArgs,
  GetFileDiffArgs,
  GetFileHistoryArgs,
  GetFileSymbolsArgs,
  CallGraphArgs,
  GetSymbolContextArgs,
  IndexHealthArgs,
  ListProjectsArgs,
  SearchAndReadArgs,
  SearchCodeArgs,
  SearchPatternArgs,
  SearchSuggestArgs,
  FindFileArgs,
  WhatChangedArgs,
  DependencyMapArgs,
} from "../models.js";

export const TOOL_DOCS: Record<string, string> = {
  opengrok_search_code: `## opengrok_search_code
Search by symbol, text, or path across projects.

**Parameters:**
- \`query\` — search term (required)
- \`projects\` — scope to one or more projects (optional)
- \`search_type\` — symbol|full|path|hist|type (default: full)
- \`max_results\` — 1-25 (default: 10)

**Example:** \`opengrok_search_code({ query: "AuthService", search_type: "symbol", projects: ["myrepo"] })\``,

  opengrok_get_file_content: `## opengrok_get_file_content
Fetch file content with optional line range.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)
- \`start_line\` — first line (optional)
- \`end_line\` — last line (optional)`,

  opengrok_get_symbol_context: `## opengrok_get_symbol_context
One-call symbol investigation: definition + header + callers.

**Parameters:**
- \`symbol\` — symbol name (required)
- \`project\` — project name (optional)`,

  opengrok_index_health: `## opengrok_index_health
Check server health and list all indexed projects. Run this first each session.`,

  opengrok_read_memory: `## opengrok_read_memory
Read active-task.md or investigation-log.md.

**Parameters:**
- \`filename\` — "active-task.md" or "investigation-log.md"`,

  opengrok_update_memory: `## opengrok_update_memory
Write or append to active-task.md or investigation-log.md. Rate-limited to 20 rpm.

**Parameters:**
- \`filename\` — file to update
- \`content\` — new content or append text
- \`mode\` — "write" or "append"`,

  opengrok_memory_status: `## opengrok_memory_status
Show current memory bank file sizes and modification times. No parameters required.`,

  opengrok_batch_search: `## opengrok_batch_search
Run 2-5 searches in parallel in a single call. Rate-limited to 5 rpm (expensive operation).

**Parameters:**
- \`queries\` — array of search query objects (required)`,

  opengrok_search_and_read: `## opengrok_search_and_read
Combined search + file read in one call. Prefer over separate search + get_file_content.

**Parameters:**
- \`query\` — search term (required)
- \`project\` — project scope (optional)`,

  opengrok_find_file: `## opengrok_find_file
Find files by name pattern across projects.

**Parameters:**
- \`path_pattern\` — glob or substring to match against file paths (required)
- \`projects\` — scope to specific projects (optional)`,

  opengrok_browse_directory: `## opengrok_browse_directory
List directory contents.

**Parameters:**
- \`path\` — directory path (required)
- \`project\` — project name (required)`,

  opengrok_list_projects: `## opengrok_list_projects
List all indexed projects. No parameters required.`,

  opengrok_get_file_history: `## opengrok_get_file_history
Get commit history for a file.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_get_file_annotate: `## opengrok_get_file_annotate
Get line-by-line blame/annotation for a file.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_get_file_symbols: `## opengrok_get_file_symbols
List all symbols defined in a file. Call before get_file_content to find line ranges.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_search_suggest: `## opengrok_search_suggest
Get search suggestions/autocomplete for a partial query.

**Parameters:**
- \`query\` — partial query (required)
- \`project\` — project scope (optional)`,

  opengrok_what_changed: `## opengrok_what_changed
Show recently changed files in a project.

**Parameters:**
- \`project\` — project name (required)
- \`days\` — look-back window in days (optional)`,

  opengrok_blame: `## opengrok_blame
Get blame information for a file with commit metadata.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_dependency_map: `## opengrok_dependency_map
Build a dependency map showing what a file uses and what uses it. Rate-limited to 10 rpm (BFS traversal = multiple requests).

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_call_graph: `## opengrok_call_graph
Compute a call graph for a symbol showing callers and callees.

**Parameters:**
- \`symbol\` — symbol name (required)
- \`project\` — project name (required)`,

  opengrok_search_pattern: `## opengrok_search_pattern
Search using a regular expression pattern.

**Parameters:**
- \`pattern\` — regex pattern (required)
- \`project\` — project scope (optional)`,

  opengrok_get_file_diff: `## opengrok_get_file_diff
Get a diff for a file between two revisions.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)
- \`rev1\` — first revision (required)
- \`rev2\` — second revision (required)`,

  opengrok_get_compile_info: `## opengrok_get_compile_info
Get compiler flags and include paths for a C/C++ file from compile_commands.json.

**Parameters:**
- \`path\` — file path (required)`,

  opengrok_get_all_matches: `## opengrok_get_all_matches
Get all matching lines in a specific file (use when search shows truncated results).

**Parameters:**
- \`project\` — project name (required)
- \`path\` — file path (required)
- \`query\` — search query that produced truncated results (required)`,

  opengrok_get_file_history_with_files: `## opengrok_get_file_history_with_files
Get commit history including co-changed files via RSS feed.

**Parameters:**
- \`project\` — project name (required)
- \`path\` — file path (required)`,

  opengrok_get_download_url: `## opengrok_get_download_url
Get the direct download URL for a file.

**Parameters:**
- \`project\` — project name (required)
- \`path\` — file path (required)`,

  opengrok_list_groups: `## opengrok_list_groups
List project groups. Returns empty on servers where groups require admin auth.`,

  opengrok_get_suggest_popularity: `## opengrok_get_suggest_popularity
Get popular search suggestions for a project field. Returns empty when admin auth required.

**Parameters:**
- \`project\` — project name (required)`,

  opengrok_get_project_repositories: `## opengrok_get_project_repositories
List repositories for a project. Returns empty when admin auth required.

**Parameters:**
- \`project\` — project name (required)`,

  opengrok_api: `## opengrok_api
[Code Mode] Return the full Code Mode API specification. Call once per session.`,

  opengrok_execute: `## opengrok_execute
[Code Mode] Execute JavaScript in the QuickJS sandbox with OpenGrok API access. Rate-limited to 15 rpm.

**Parameters:**
- \`code\` — JS function body using flat API globals or env.opengrok.* for API calls (required)

**Note on large results:** When the return value exceeds the context budget, it is truncated at a JSON array/object boundary and stays valid JSON — the last array element or extra object keys are \`{"_truncated":true,...}\` with \`_droppedCount\` / \`_droppedKeyNames\`.`,
};

// ---------------------------------------------------------------------------
// Tool registration order — for prompt caching hints (3C)
// ---------------------------------------------------------------------------

/**
 * Canonical tool registration order for prompt-caching hints (3C).
 * Pre-populated at module init with the complete list; individual register*
 * functions also push to this array at call time as a cross-check.
 *
 * Memory tools first (always registered), then Code Mode tools (when enabled),
 * then legacy tools (when Code Mode is disabled).
 */

export const TOOL_REGISTRATION_ORDER: string[] = [
  // Code Mode tools (registered first when OPENGROK_CODE_MODE=true)
  "opengrok_api",
  "opengrok_execute",
  // Memory tools (always registered in Code Mode, after the two core tools)
  "opengrok_memory_status",
  "opengrok_read_memory",
  "opengrok_update_memory",
  // Legacy tools (registered in standard mode)
  "opengrok_search_code",
  "opengrok_find_file",
  "opengrok_search_pattern",
  "opengrok_get_file_content",
  "opengrok_get_file_history",
  "opengrok_get_file_diff",
  "opengrok_browse_directory",
  "opengrok_list_projects",
  "opengrok_get_file_annotate",
  "opengrok_search_suggest",
  "opengrok_batch_search",
  "opengrok_search_and_read",
  "opengrok_get_symbol_context",
  "opengrok_index_health",
  "opengrok_get_compile_info",
  "opengrok_get_file_symbols",
  "opengrok_call_graph",
  "opengrok_what_changed",
  "opengrok_blame",
  "opengrok_dependency_map",
  "opengrok_get_all_matches",
  "opengrok_get_file_history_with_files",
  "opengrok_get_download_url",
  "opengrok_list_groups",
  "opengrok_get_suggest_popularity",
  "opengrok_get_project_repositories",
];


function extractZodParamDescs(
  shape: Record<string, z.ZodTypeAny>
): Record<string, { description?: string }> {
  const out: Record<string, { description?: string }> = {};
  for (const [key, field] of Object.entries(shape)) {
    // Zod stores description in _def.description on the field's _def chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = field;
    let description: string | undefined;
    // Walk unwrap chain: ZodOptional/ZodDefault wrap the inner type
    while (node) {
      if (typeof node._def?.description === "string") {
        description = node._def.description;
        break;
      }
      // Unwrap optional/default wrappers
      node = node._def?.innerType ?? node._def?.schema ?? null;
    }
    out[key] = { description };
  }
  return out;
}

export const TOOL_DEFS: Record<string, {
  description: string;
  parameters?: Record<string, { description?: string }>;
}> = {
  opengrok_search_code: {
    description: "Full-text or symbol search across one or all OpenGrok projects.",
    parameters: extractZodParamDescs(SearchCodeArgs.shape),
  },
  opengrok_find_file: {
    description: "Find files by name across all or one project.",
    parameters: extractZodParamDescs(FindFileArgs.shape),
  },
  opengrok_search_pattern: {
    description: "Search the codebase using a regular expression pattern.",
    parameters: extractZodParamDescs(SearchPatternArgs.shape),
  },
  opengrok_get_file_content: {
    description: "Fetch file content with optional line range.",
    parameters: extractZodParamDescs(GetFileContentArgs.shape),
  },
  opengrok_get_file_history: {
    description: "Show git commit history for a file.",
    parameters: extractZodParamDescs(GetFileHistoryArgs.shape),
  },
  opengrok_get_file_diff: {
    description: "Diff between two revisions of a file (unified diff format).",
    parameters: extractZodParamDescs(GetFileDiffArgs.shape),
  },
  opengrok_browse_directory: {
    description: "List files and subdirectories in a project directory.",
    parameters: extractZodParamDescs(BrowseDirectoryArgs.shape),
  },
  opengrok_list_projects: {
    description: "List all indexed OpenGrok projects.",
    parameters: extractZodParamDescs(ListProjectsArgs.shape),
  },
  opengrok_get_file_annotate: {
    description: "Annotate each line with its last commit (git blame).",
    parameters: extractZodParamDescs(GetFileAnnotateArgs.shape),
  },
  opengrok_search_suggest: {
    description: "Autocomplete suggestions for a partial query.",
    parameters: extractZodParamDescs(SearchSuggestArgs.shape),
  },
  opengrok_batch_search: {
    description: "Execute 2-5 parallel OpenGrok searches in one call.",
    parameters: extractZodParamDescs(BatchSearchArgs.shape),
  },
  opengrok_search_and_read: {
    description: "Search then read matching files in a single call.",
    parameters: extractZodParamDescs(SearchAndReadArgs.shape),
  },
  opengrok_get_symbol_context: {
    description: "Complete symbol investigation: definition + header + references in one call.",
    parameters: extractZodParamDescs(GetSymbolContextArgs.shape),
  },
  opengrok_index_health: {
    description: "Check OpenGrok server health and indexed project list.",
    parameters: extractZodParamDescs(IndexHealthArgs.shape),
  },
  opengrok_get_compile_info: {
    description: "Get compiler flags and include paths from compile_commands.json.",
    parameters: extractZodParamDescs(GetCompileInfoArgs.shape),
  },
  opengrok_get_file_symbols: {
    description: "List all symbols (functions, classes, variables) defined in a file.",
    parameters: extractZodParamDescs(GetFileSymbolsArgs.shape),
  },
  opengrok_call_graph: {
    description: "Find all callers and callees of a function or method symbol.",
    parameters: extractZodParamDescs(CallGraphArgs.shape),
  },
  opengrok_what_changed: {
    description: "Show recent commits across one or all projects.",
    parameters: extractZodParamDescs(WhatChangedArgs.shape),
  },
  opengrok_blame: {
    description: "Git blame with optional diff for a file path.",
    parameters: extractZodParamDescs(BlameArgs.shape),
  },
  opengrok_dependency_map: {
    description: "Build #include/import dependency graph (configurable depth).",
    parameters: extractZodParamDescs(DependencyMapArgs.shape),
  },
  opengrok_memory_status: {
    description: "Show current memory bank file sizes and modification times.",
    parameters: {
      _: { description: "(no input required)" },
    },
  },
  opengrok_read_memory: {
    description: "Read active-task.md or investigation-log.md from the memory bank.",
    parameters: {
      filename: { description: "File to read from the memory bank" },
    },
  },
  opengrok_update_memory: {
    description: "Write or append to active-task.md or investigation-log.md.",
    parameters: {
      filename: { description: "File to update" },
      content: { description: "Content to write" },
      mode: { description: "append adds to end (use for investigation-log)" },
    },
  },
  opengrok_api: {
    description: "Return the full Code Mode API specification.",
    parameters: {
      _: { description: "(no input required)" },
    },
  },
  opengrok_execute: {
    description: "Execute JavaScript in the QuickJS sandbox with OpenGrok API access.",
    parameters: {
      code: { description: "JS function body; use flat API globals (or env.opengrok.*); return a value." },
    },
  },
};

// ---------------------------------------------------------------------------
// Priority tool core executors (return raw data for structured output)
// ---------------------------------------------------------------------------

