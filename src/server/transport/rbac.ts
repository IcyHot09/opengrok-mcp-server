/**
 * Role-Based Access Control (RBAC) for HTTP Deployments (Task 5.10)
 *
 * Defines three roles: admin (all tools), developer (all except config/execute),
 * and readonly (read-only tools only).
 *
 * Configuration via OPENGROK_RBAC_TOKENS='token1:admin,token2:developer,token3:readonly'
 * format.
 */

export type Role = "admin" | "developer" | "readonly";

export interface RbacConfig {
  tokens: Map<string, Role>; // token → role
}

/**
 * Permissions for each role.
 *
 * admin: all tools (*) — wildcard includes any future tools automatically
 * developer: every registered tool (search, read, execute, memory)
 * readonly: cheap single-shot reads only — no code execution, no memory
 *   writes, and no expensive fan-out tools (batch search, dependency map,
 *   call graph)
 */
const ALL_TOOLS = [
  "opengrok_api",
  "opengrok_execute",
  "opengrok_memory_status",
  "opengrok_read_memory",
  "opengrok_update_memory",
  "opengrok_search_code",
  "opengrok_search_and_read",
  "opengrok_batch_search",
  "opengrok_find_file",
  "opengrok_browse_directory",
  "opengrok_list_projects",
  "opengrok_get_file_content",
  "opengrok_get_file_history",
  "opengrok_get_file_annotate",
  "opengrok_get_file_symbols",
  "opengrok_get_symbol_context",
  "opengrok_search_suggest",
  "opengrok_what_changed",
  "opengrok_blame",
  "opengrok_dependency_map",
  "opengrok_search_pattern",
  "opengrok_index_health",
  "opengrok_get_file_diff",
  "opengrok_get_compile_info",
  "opengrok_call_graph",
  "opengrok_get_all_matches",
  "opengrok_get_file_history_with_files",
  "opengrok_get_download_url",
  "opengrok_list_groups",
  "opengrok_get_suggest_popularity",
  "opengrok_get_project_repositories",
];

const ROLE_PERMISSIONS: Record<Role, Set<string>> = {
  admin: new Set(["*"]), // all tools
  developer: new Set(ALL_TOOLS),
  readonly: new Set([
    "opengrok_api",
    "opengrok_search_code",
    "opengrok_search_and_read",
    "opengrok_find_file",
    "opengrok_browse_directory",
    "opengrok_list_projects",
    "opengrok_get_file_content",
    "opengrok_get_file_history",
    "opengrok_get_file_annotate",
    "opengrok_get_file_symbols",
    "opengrok_get_symbol_context",
    "opengrok_search_suggest",
    "opengrok_what_changed",
    "opengrok_blame",
    "opengrok_search_pattern",
    "opengrok_index_health",
    "opengrok_get_file_diff",
    "opengrok_get_compile_info",
    "opengrok_memory_status",
    "opengrok_get_all_matches",
    "opengrok_get_file_history_with_files",
    "opengrok_get_download_url",
    "opengrok_list_groups",
    "opengrok_get_suggest_popularity",
    "opengrok_get_project_repositories",
  ]),
};

/**
 * Check if a role has permission to call a tool.
 *
 * @param role - The role to check
 * @param toolName - The tool name (e.g. "opengrok_search_code")
 * @returns true if the role has permission, false otherwise
 */
export function hasPermission(role: Role, toolName: string): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms.has("*") || perms.has(toolName);
}

/**
 * Parse RBAC config from environment variable.
 *
 * Format: "token1:admin,token2:developer,token3:readonly"
 * Invalid entries (malformed or unknown role) are silently ignored.
 *
 * @param envVar - The environment variable value (undefined or empty returns empty config)
 * @returns RbacConfig with parsed tokens
 */
export function parseRbacConfig(envVar: string | undefined): RbacConfig {
  const tokens = new Map<string, Role>();
  if (!envVar || envVar.trim() === "") return { tokens };

  for (const entry of envVar.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [token, role] = trimmed.split(":").map((s) => s.trim());
    if (!token || !role) continue;

    if (role === "admin" || role === "developer" || role === "readonly") {
      tokens.set(token, role as Role);
    }
  }

  return { tokens };
}
