import * as fsp from "fs/promises";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpenGrokClient } from "../client/index.js";
import type { Config } from "../config.js";
import {
  formatBlame,
  formatFileDiff,
  formatFileHistory,
  formatFileSymbols,
  formatMoreResults,
  formatRssHistory,
  formatSymbolContextYAML,
  formatWhatChanged,
  formatDependencyMap,
  selectFormat,
} from "../formatters/index.js";
import type {
  SymbolContextResult,
} from "../formatters/index.js";
import type { CompileInfo } from "../local/compile-info.js";
import {
  BatchSearchArgs,
  BlameArgs,
  BrowseDirectoryArgs,
  GetAllMatchesArgs,
  GetCompileInfoArgs,
  GetDownloadUrlArgs,
  GetFileAnnotateArgs,
  GetFileContentArgs,
  GetFileDiffArgs,
  GetFileHistoryArgs,
  GetFileHistoryWithFilesArgs,
  GetProjectRepositoriesArgs,
  GetSuggestPopularityArgs,
  GetFileSymbolsArgs,
  CallGraphArgs,
  GetSymbolContextArgs,
  IndexHealthArgs,
  ListGroupsArgs,
  ListProjectsArgs,
  SearchAndReadArgs,
  SearchCodeArgs,
  SearchPatternArgs,
  SearchSuggestArgs,
  FindFileArgs,
  WhatChangedArgs,
  DependencyMapArgs,
} from "../models.js";
import type {
  SearchResult,
  SearchMatch,
} from "../models.js";
import { getMaxResponseBytes } from "../config.js";
import { decodeCursor, isOffsetCursorFor } from "../pagination/cursor-codec.js";
import type { ResponseFormat } from "../formatters/index.js";
import { MemoryBank, ALLOWED_FILES } from "../memory/memory-bank.js";
import { ObservationMasker } from "../memory/observation-masker.js";
import { createSandboxAPI, executeInSandbox, API_SPEC, filterApiSpec } from "../sandbox/sandbox.js";
import { SandboxWorkerPool } from "../sandbox/worker-pool.js";
import { auditLog } from "../transport/audit.js";
import { elicitOrFallback } from "../protocol/elicitation.js";
import { sampleOrNull } from "../protocol/sampling.js";
import { ToolRateLimiter } from "./tool-rate-limiter.js";
import { READ_ONLY_OPEN, READ_ONLY_LOCAL, CODE_MODE_API_ANNOTATIONS, CODE_MODE_EXECUTE_ANNOTATIONS } from "./tool-annotations.js";
import {
  buildXrefUri,
  buildDependencyGraph,
  makeToolError,
  capResponse,
  capCodeModeResult,
  formatResponse,
  pickSearchFormatter,
  applyDefaultProject,
  checkCursorExpired,
  nextCursor,
  getMimeType,
  executeSearchCode,
  executeGetFileContent,
  executeListProjects,
  executeBatchSearch,
  handleSearchAndRead,
  handleGetSymbolContextStructured,
  handleGetCompileInfo,
  executeBrowseDirectory,
  executeGetFileAnnotate,
  executeSearchSuggest,
} from "./executors.js";
import type { LocalLayer } from "./executors.js";
/**
 * Tool registration (split from server.ts, pure move).
 */

export function registerMemoryTools(
  server: McpServer,
  memoryBank: MemoryBank,
  config: Config,
  toolRateLimiter?: ToolRateLimiter
): void {
  server.registerTool(
    "opengrok_memory_status",
    {
      title: "Memory Bank Status",
      description: "Show current memory bank file sizes and modification times.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_memory_status" });
      try {
        const lines: string[] = ["# OpenGrok Memory Status"];
        for (const filename of ALLOWED_FILES) {
          // Use statFile() — reads only the first 256 bytes for preview instead of
          // loading the entire file (investigation-log.md can be up to 32 KB).
          const stat = await memoryBank.statFile(filename);
          if (!stat) {
            lines.push(`- ${filename}: empty`);
          } else {
            const { bytes, preview } = stat;
            lines.push(`- ${filename}: ${bytes}B — "${preview}"`);
          }
        }
        lines.push("");
        lines.push("Note: For general codebase context (conventions, architecture), use your AI");
        lines.push("client's persistent memory (e.g. .claude.md for Claude Code, VS Code /memory,");
        lines.push(".cursorrules for Cursor) — those auto-load each session.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return makeToolError("opengrok_memory_status", err);
      }
    }
  );

  server.registerTool(
    "opengrok_read_memory",
    {
      title: "Read Memory Bank",
      description: "Read active-task.md or investigation-log.md from the memory bank.",
      inputSchema: {
        filename: z.enum(["active-task.md", "investigation-log.md"]
        ).describe("File to read from the memory bank"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_read_memory" });
      try {
        if (config.OPENGROK_ENABLE_FILES_API && args.filename === "investigation-log.md") {
          const ref = await memoryBank.getFileReference(args.filename);
          if (ref === null) {
            return { content: [{ type: "text", text: "[unchanged]" }] };
          }
          const content = await memoryBank.readCompressed(args.filename);
          if (!content) {
            return { content: [{ type: "text", text: `${args.filename} is not yet populated. Start an investigation to fill it.` }] };
          }
          return { content: [{ type: "text", text: content }] };
        }
        // Delta encoding: returns "[unchanged]" when hash matches last read
        const content = args.filename === "investigation-log.md"
          ? await memoryBank.readCompressed(args.filename)
          : await memoryBank.readWithDelta(args.filename);
        if (!content) {
          return { content: [{ type: "text", text: `${args.filename} is not yet populated. Start an investigation to fill it.` }] };
        }
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return makeToolError("opengrok_read_memory", err);
      }
    }
  );

  server.registerTool(
    "opengrok_update_memory",
    {
      title: "Update Memory Bank",
      description: "Write or append to active-task.md or investigation-log.md.",
      inputSchema: {
        filename: z.enum(["active-task.md", "investigation-log.md"])
          .describe("File to update"),
        content: z.string().min(1).describe("Content to write"),
        mode: z.enum(["overwrite", "append"]).default("overwrite").describe("append adds to end (use for investigation-log)"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: false },
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_update_memory" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_update_memory");
      try {
        await memoryBank.write(args.filename, args.content, args.mode);
        return { content: [{ type: "text", text: `Written to ${args.filename}` }] };
      } catch (err) {
        return makeToolError("opengrok_update_memory", err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Code Mode tools: opengrok_api + opengrok_execute
// ---------------------------------------------------------------------------


export function registerCodeModeTools(
  server: McpServer,
  client: OpenGrokClient,
  config: Config,
  memoryBank: MemoryBank,
  local: LocalLayer,
  toolRateLimiter: ToolRateLimiter
): void {
  // Per-session pool and health-check state — scoped here so each McpServer
  // instance (stdio or HTTP session) gets its own pool and no bleed occurs.
  const workerPool = new SandboxWorkerPool();

  // Per-session counters — scoped to this server instance to prevent HTTP session bleed.
  let executeCallCount = 0;
  // Per-session masker (created once per server, tracks all turns)
  const masker = new ObservationMasker(config.OPENGROK_OBSERVATION_MASKER_TURNS);
  let turn = 0;
  // Effective default project: starts from env, can be updated by elicitation in opengrok_api.
  let sessionDefaultProject: string | undefined = config.OPENGROK_DEFAULT_PROJECT?.trim() || undefined;

  // Build getCompileInfoFn callback when local layer is available
  const getCompileInfoFn = local.enabled && local.index.size > 0
    ? async (filePath: string): Promise<unknown> => {
        let info: CompileInfo | undefined;

        // Absolute path lookup
        if (path.isAbsolute(filePath)) {
          try {
            const resolved = await fsp.realpath(filePath);
            info = local.index.get(resolved);
          } catch { /* path doesn't exist */ }
        }

        // Root-relative lookup
        if (!info) {
          const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
          for (const root of local.roots) {
            try {
              const resolved = await fsp.realpath(path.join(root, normalized));
              info = local.index.get(resolved);
              if (info) break;
            } catch { /* try next root */ }
          }
        }

        // Basename fallback
        if (!info) {
          const basename = path.basename(filePath);
          for (const [k, v] of local.index) {
            if (path.basename(k) === basename) { info = v; break; }
          }
        }

        if (!info) return null;

        return {
          file: info.file,
          compiler: info.compiler,
          standard: info.standard || undefined,
          includes: info.includes,
          defines: info.defines,
          extraFlags: info.extraFlags,
        };
      }
    : undefined;

  // Tool 1: opengrok_api — return the API spec
  server.registerTool(
    "opengrok_api",
    {
      title: "OpenGrok API Reference",
      description: "Return the full Code Mode API specification.",
      inputSchema: {},
      annotations: CODE_MODE_API_ANNOTATIONS,
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_api" });
      try {
        let projectHint = "";
        if (config.OPENGROK_ENABLE_ELICITATION && !config.OPENGROK_DEFAULT_PROJECT?.trim()) {
          const projects = await client.listProjects();
          if (projects.length > 0) {
            const projectNames = projects.map((p) => p.name).slice(0, 20);
            const result = await elicitOrFallback(
              server,
              "Which project should I work in this session?",
              {
                type: "object",
                properties: {
                  project: {
                    type: "string",
                    enum: projectNames,
                    description: "Default project for this session",
                  },
                },
                required: ["project"],
              }
            );
            if (result.action === "accept" && typeof result.content?.project === "string" && result.content.project) {
              sessionDefaultProject = result.content.project;
              projectHint =
                `\n\n**Working project: ${sessionDefaultProject}**` +
                ` — use this project in all calls unless the user specifies otherwise.`;
            }
          }
        }
        // API_SPEC is a declaration string — serve it directly (no YAML dump).
        // Filter memory methods when memory tools are disabled (default off).
        const specText = filterApiSpec(API_SPEC, { memoryTools: Boolean(config.OPENGROK_ENABLE_MEMORY_TOOLS) });
        const fullText = projectHint ? `${projectHint}\n\n${specText}` : specText;
        // Do not cap the API spec — it is static reference data that must be
        // complete for the sandbox to work. Truncating it breaks Code Mode.
        return { content: [{ type: "text", text: fullText }] };
      } catch (err) {
        return makeToolError("opengrok_api", err);
      }
    }
  );

  // Tool 2: opengrok_execute — run LLM-written JavaScript in the sandbox
  server.registerTool(
    "opengrok_execute",
    {
      title: "Execute OpenGrok Code",
      description: "Execute JavaScript against the OpenGrok API (see opengrok_api for available methods)",
      inputSchema: {
        code: z.string().min(1).max(65536).describe("JS function body; use flat globals (or env.opengrok.*) for API calls (all synchronous, no await needed); return a value."),
      },
      annotations: CODE_MODE_EXECUTE_ANNOTATIONS,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_execute" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_execute");
      const currentTurn = ++turn;

      try {
        // Reject code containing null bytes or bidi/zero-width override characters.
        // These can be used to obscure the true content of the submitted code.
        if (/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/.test(args.code)) {
          return makeToolError("opengrok_execute", new Error("Code rejected: contains bidi/zero-width characters"));
        }
        if (args.code.includes('\0')) {
          return makeToolError("opengrok_execute", new Error("Code rejected: contains null bytes"));
        }

        const maxBytes = getMaxResponseBytes();
        // sandboxApi is intentionally created per execution: this gives each invocation a fresh
        // write-call counter (MAX_SANDBOX_WRITES_PER_EXECUTION = 5 per call).
        // If a per-session write limit is needed in the future, create this once alongside `masker`.
        const sandboxApi = createSandboxAPI(client, memoryBank, {
          getCompileInfoFn,
          mcpServer: server,
          elicitEnabled: config.OPENGROK_ENABLE_ELICITATION,
          samplingEnabled: config.OPENGROK_ENABLE_SAMPLING,
          defaultProject: sessionDefaultProject,
          memoryEnabled: config.OPENGROK_ENABLE_MEMORY_TOOLS,
        });
        const workerHandle = workerPool.acquire();
        let result: string;
        try {
          result = await executeInSandbox(
            args.code,
            sandboxApi,
            (r) => capCodeModeResult(r, maxBytes),
            maxBytes,
            workerHandle
          );
        } finally {
          workerPool.release(workerHandle);
        }

        // When execution fails, use MCP Sampling to get an LLM-generated explanation
        if (result.startsWith("Error:") && config.OPENGROK_ENABLE_SAMPLING) {
          const suggestion = await sampleOrNull(server, [
            {
              role: "user",
              content: {
                type: "text",
                text: `The following JavaScript code failed in a sandbox:\n\`\`\`js\n${args.code}\n\`\`\`\n${result}\n\nBriefly explain what went wrong and suggest a fix.`,
              },
            },
          ], { maxTokens: config.OPENGROK_SAMPLING_MAX_TOKENS, systemPrompt: "You are a code debugging assistant for OpenGrok. Be concise.", model: config.OPENGROK_SAMPLING_MODEL, retries: 2 });
          const errorResult = suggestion ? `${result}\n\nSuggestion: ${suggestion}` : result;
          return { content: [{ type: "text", text: errorResult }] };
        }

        // Record in masker for future turns (only when masker is enabled)
        if (config.OPENGROK_ENABLE_OBSERVATION_MASKER) {
          masker.record(
            currentTurn,
            "opengrok_execute",
            args.code.slice(0, 80).replace(/\n/g, " "),
            result
          );
        }

        const historyHeader = config.OPENGROK_ENABLE_OBSERVATION_MASKER
          ? masker.getMaskedHistoryHeader()
          : "";
        let finalResult = historyHeader
          ? `${historyHeader}\n---\n${result}`
          : result;

        executeCallCount++;
        // Memory tools are opt-in (default off; only explicit true opts in).
        if (config.OPENGROK_ENABLE_MEMORY_TOOLS && executeCallCount % 5 === 0 && executeCallCount > 3) {
          finalResult += "\n\n> Memory: Append findings to investigation-log.md and update active-task.md.";
        }
        // Compound cap on final output (history header + result + nudge)
        finalResult = capResponse(finalResult);

        return { content: [{ type: "text", text: finalResult }] };
      } catch (err) {
        return makeToolError("opengrok_execute", err);
      }
    }
  );

  // Memory tools are part of the Code Mode tool set only when enabled —
  // 2 tools by default (api + execute), 5 with OPENGROK_ENABLE_MEMORY_TOOLS=true.
  if (config.OPENGROK_ENABLE_MEMORY_TOOLS) {
    registerMemoryTools(server, memoryBank, config, toolRateLimiter);
  }
}

// ---------------------------------------------------------------------------
// Legacy tools (20 tools, used when Code Mode is disabled)
// ---------------------------------------------------------------------------


export function registerLegacyTools(
  server: McpServer,
  client: OpenGrokClient,
  config: Config,
  local: LocalLayer,
  compactDescriptions: boolean,
  toolRateLimiter?: ToolRateLimiter
): void {
  const desc = (full: string, compact: string): string => compactDescriptions ? compact : full;
  // Per-session health check state — scoped so HTTP sessions don't share latency history.
  // Rolling window of last 3 latency samples — reduces false-positive "increasing" signals
  // caused by normal single-sample variance (e.g. 200ms → 305ms → 190ms).
  const latencyHistory: number[] = [];
  // Only warm the cache once per session — subsequent health checks don't need to re-warm.
  let cacheWarmed = false;
  server.registerTool(
    "opengrok_search_code",
    {
      title: "Search Code",
      description: desc(
        "Full-text or symbol search across one or all OpenGrok projects.",
        "Search code (full-text or symbol)"
      ),
      inputSchema: SearchCodeArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_code" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_search_code");
      try {
        const format = args.response_format ?? "auto";
        const expired = checkCursorExpired(args.cursor, "search");
        if (expired) {
          return { content: [{ type: "text" as const, text: expired }] };
        }
        // Elicit project from user when none specified and elicitation is enabled
        let effectiveArgs = args;
        if (
          config.OPENGROK_ENABLE_ELICITATION &&
          !args.projects?.length &&
          !config.OPENGROK_DEFAULT_PROJECT?.trim()
        ) {
          const projects = await client.listProjects();
          if (projects.length > 0) {
            const projectNames = projects.map((p) => p.name).slice(0, 20);
            const result = await elicitOrFallback(
              server,
              "Which project should I search?",
              {
                type: "object",
                properties: {
                  project: {
                    type: "string",
                    description: "Project name",
                    enum: projectNames,
                  },
                },
                required: ["project"],
              }
            );
            if (result.action === "accept" && typeof result.content?.project === "string" && result.content.project) {
              effectiveArgs = { ...args, projects: [result.content.project] };
            }
          }
        }
        const { text, structured } = await executeSearchCode(effectiveArgs, client, config);
        const hasMore = structured.endIndex < structured.totalCount;
        const nextOffset = hasMore ? structured.endIndex : undefined;
        const pagedText = hasMore
          ? `${text}\nNext page: reissue with cursor "${nextCursor("search", structured.endIndex)}"`
          : text;
        return formatResponse(
          pagedText,
          { ...structured as unknown as Record<string, unknown>, hasMore, ...(nextOffset !== undefined ? { nextOffset } : {}) },
          format,
          "search"
        );
      } catch (err) {
        return makeToolError("opengrok_search_code", err);
      }
    }
  );

  server.registerTool(
    "opengrok_find_file",
    {
      title: "Find File",
      description: desc("Find files by name across all or one project.", "Find file by name"),
      inputSchema: FindFileArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_find_file" });
      try {
        const expired = checkCursorExpired(args.cursor, "findFile");
        if (expired) {
          return { content: [{ type: "text" as const, text: expired }] };
        }
        // client.search() only honors "search"-tagged cursors — resolve the
        // findFile cursor to a start offset here (validated above).
        let start = args.start_index;
        if (args.cursor) {
          const state = decodeCursor(args.cursor);
          if (state && isOffsetCursorFor(state, "findFile")) start = state.v;
        }
        const results = await client.search(
          args.path_pattern,
          "path",
          applyDefaultProject(args.projects, config),
          args.max_results,
          start
        );
        const fmt = selectFormat("search", args.response_format as ResponseFormat | undefined);
        const maxBytes = getMaxResponseBytes();
        let text = pickSearchFormatter(fmt, maxBytes)(results);
        if (results.endIndex < results.totalCount) {
          text += `\nNext page: reissue with cursor "${nextCursor("findFile", results.endIndex)}"`;
        }
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_find_file", err);
      }
    }
  );

  server.registerTool(
    "opengrok_search_pattern",
    {
      title: "Search Pattern",
      description: desc(
        "Search the codebase using a regular expression pattern.",
        "Regex pattern search"
      ),
      inputSchema: SearchPatternArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_pattern" });
      try {
        const expired = checkCursorExpired(args.cursor, "search");
        if (expired) {
          return { content: [{ type: "text" as const, text: expired }] };
        }
        const results = await client.searchPattern({
          pattern: args.pattern,
          projects: applyDefaultProject(args.projects, config),
          fileType: args.file_type,
          maxResults: args.max_results,
          cursor: args.cursor,
        });
        const fmt = selectFormat("search", args.response_format as ResponseFormat | undefined);
        const maxBytes = getMaxResponseBytes();
        let text = pickSearchFormatter(fmt, maxBytes)(results);
        if (results.endIndex < results.totalCount) {
          text += `\nNext page: reissue with cursor "${nextCursor("search", results.endIndex)}"`;
        }
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_search_pattern", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_content",
    {
      title: "Get File Content",
      description: desc(
        "Fetch file content with optional line range.",
        "Read file lines (use start_line+end_line)"
      ),
      inputSchema: GetFileContentArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_content" });
      try {
        const format = args.response_format ?? "auto";
        const { text, structured, warning } = await executeGetFileContent(args, client, local);
        const result = formatResponse(text, structured as unknown as Record<string, unknown>, format, "code");
        if (warning) {
          return { ...result, content: [{ type: "text" as const, text: `[NOTE] ${warning}` }, ...result.content] };
        }
        return result;
      } catch (err) {
        return makeToolError("opengrok_get_file_content", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_history",
    {
      title: "Get File History",
      description: desc("Show git commit history for a file.", "File commit history"),
      inputSchema: GetFileHistoryArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_history" });
      try {
        const expired = checkCursorExpired(args.cursor, "history");
        if (expired) {
          return { content: [{ type: "text" as const, text: expired }] };
        }
        const history = await client.getFileHistory(
          args.project,
          args.path,
          args.max_entries,
          args.start_index ?? 0,
          args.cursor
        );
        const fmt = selectFormat("generic", args.response_format);
        if (fmt === "json") {
          const data = {
            entries: history.entries.map((e) => ({
              revision: e.revision,
              author: e.author,
              date: e.date,
              message: e.message,
            })),
          };
          return { content: [{ type: "text" as const, text: capResponse(JSON.stringify(data, null, 2)) }] };
        }
        return {
          content: [
            { type: "text" as const, text: capResponse(formatFileHistory(history)) },
            { type: "resource_link" as const, uri: buildXrefUri(config.OPENGROK_BASE_URL, args.project, args.path), name: args.path, mimeType: getMimeType(args.path) },
          ],
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_history", err);
      }
    }
  );

  // Tool: opengrok_get_file_diff — diff between two revisions
  server.registerTool(
    "opengrok_get_file_diff",
    {
      title: "Get File Diff",
      description: desc(
        "Diff between two revisions of a file (unified diff format).",
        "Diff two file revisions"
      ),
      inputSchema: GetFileDiffArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_diff" });
      try {
        if (args.rev1 === args.rev2) {
          return {
            content: [{ type: "text" as const, text: `No changes: rev1 and rev2 are identical ("${args.rev1}"). Pass two different revisions from opengrok_get_file_history to see a diff.` }],
          };
        }
        const expired = checkCursorExpired(args.cursor, "diff");
        if (expired) {
          return { content: [{ type: "text" as const, text: expired }] };
        }
        const diff = await client.getFileDiff(args.project, args.path, args.rev1, args.rev2, { cursor: args.cursor });
        const fmt = selectFormat("generic", args.response_format);
        return {
          content: [{ type: "text" as const, text: capResponse(formatFileDiff(diff, fmt)) }],
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_diff", err);
      }
    }
  );

  server.registerTool(
    "opengrok_browse_directory",
    {
      title: "Browse Directory",
      description: desc("List files and subdirectories in a project directory.", "List directory contents"),
      inputSchema: BrowseDirectoryArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_browse_directory" });
      try {
        const expired = checkCursorExpired(args.cursor, "browse");
        if (expired) {
          return { content: [{ type: "text", text: expired }] };
        }
        return { content: [{ type: "text", text: capResponse(await executeBrowseDirectory(args, client)) }] };
      } catch (err) {
        return makeToolError("opengrok_browse_directory", err);
      }
    }
  );

  server.registerTool(
    "opengrok_list_projects",
    {
      title: "List Projects",
      description: desc("List all indexed OpenGrok projects.", "List all indexed projects"),
      inputSchema: ListProjectsArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_list_projects" });
      try {
        const format = args.response_format ?? "auto";
        const { text, structured } = await executeListProjects(args, client);
        return formatResponse(text, structured as unknown as Record<string, unknown>, format, "generic");
      } catch (err) {
        return makeToolError("opengrok_list_projects", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_annotate",
    {
      title: "Get File Annotate",
      description: desc(
        "Annotate each line with its last commit (git blame). " +
        "Note: start_line/end_line filtering is applied after fetching the full annotation " +
        "(OpenGrok API limitation — no partial annotation endpoint exists).",
        "Line-by-line blame"
      ),
      inputSchema: GetFileAnnotateArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_annotate" });
      try {
        return { content: [{ type: "text", text: capResponse(await executeGetFileAnnotate(args, client)) }] };
      } catch (err) {
        return makeToolError("opengrok_get_file_annotate", err);
      }
    }
  );

  server.registerTool(
    "opengrok_search_suggest",
    {
      title: "Search Suggest",
      description: desc("Autocomplete suggestions for a partial search query.", "Search autocomplete suggestions"),
      inputSchema: SearchSuggestArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_suggest" });
      try {
        return { content: [{ type: "text", text: capResponse(await executeSearchSuggest(args, client)) }] };
      } catch (err) {
        return makeToolError("opengrok_search_suggest", err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // Compound tools
  // -----------------------------------------------------------------------

  server.registerTool(
    "opengrok_batch_search",
    {
      title: "Batch Search",
      description: desc(
        "Execute 2-5 parallel OpenGrok searches in one call.",
        "Run 2–5 parallel searches"
      ),
      inputSchema: BatchSearchArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_batch_search" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_batch_search");
      try {
        const format = args.response_format ?? "auto";
        const { text, structured } = await executeBatchSearch(args, client, config);
        return formatResponse(text, structured as unknown as Record<string, unknown>, format, "search");
      } catch (err) {
        return makeToolError("opengrok_batch_search", err);
      }
    }
  );

  server.registerTool(
    "opengrok_search_and_read",
    {
      title: "Search and Read",
      description: desc(
        "Search then read matching files in a single call.",
        "Search and read surrounding code"
      ),
      inputSchema: SearchAndReadArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_and_read" });
      try {
        // args is already validated by the MCP SDK against SearchAndReadArgs.shape
        const text = await handleSearchAndRead(args, client, config);
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_search_and_read", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_symbol_context",
    {
      title: "Get Symbol Context",
      description: desc(
        "Complete symbol investigation: definition + header + references in one call.",
        "Symbol definition, header and refs"
      ),
      inputSchema: GetSymbolContextArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_symbol_context" });
      try {
        const format = (args.response_format ?? "auto") as ResponseFormat;
        const { text, structured } = await handleGetSymbolContextStructured(
          args as unknown as Record<string, unknown>,
          client,
          config
        );
        const effectiveFmt = selectFormat("symbol", format);
        let displayText: string;
        if (effectiveFmt === "json") {
          displayText = capResponse(JSON.stringify(structured, null, 2));
        } else if (effectiveFmt === "yaml") {
          displayText = capResponse(
            formatSymbolContextYAML(structured as unknown as SymbolContextResult)
          );
        } else {
          displayText = capResponse(text);
        }
        return {
          content: [{ type: "text", text: displayText }],
        };
      } catch (err) {
        return makeToolError("opengrok_get_symbol_context", err);
      }
    }
  );

  server.registerTool(
    "opengrok_index_health",
    {
      title: "Index Health",
      description: desc(
        "Check OpenGrok server health and indexed project list.",
        "Server connectivity and index status"
      ),
      inputSchema: IndexHealthArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_index_health" });
      try {
        const format = selectFormat("generic", (args as unknown as { response_format?: string }).response_format as never);

        const start = Date.now();
        const ok = await client.testConnection();
        const latencyMs = Date.now() - start;

        // Collect project count and any warnings
        let indexedProjects = 0;
        const warnings: string[] = [];
        try {
          const projects = await client.listProjects();
          indexedProjects = projects.length;
        } catch {
          warnings.push("Could not retrieve project list");
        }

        // Compute staleness signals using a rolling average of the last 3 samples.
        // A single-sample 1.5× threshold produces too many false positives (e.g.
        // normal variance 200ms → 305ms → 190ms would falsely trigger "increasing").
        // The rolling average smooths out transient spikes.
        let latencyTrend: "stable" | "increasing" | "first_check" = "first_check";
        let stalenessScore: "healthy" | "possibly_stale" | "likely_stale" = "healthy";

        if (latencyHistory.length > 0) {
          const avg = latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length;
          latencyTrend = latencyMs > avg * 1.5 ? "increasing" : "stable";
        }

        // Keep at most the last 3 samples
        latencyHistory.push(latencyMs);
        if (latencyHistory.length > 3) latencyHistory.shift();

        if (latencyMs > 500) {
          stalenessScore = latencyTrend === "increasing" ? "likely_stale" : "possibly_stale";
        }
        if (indexedProjects === 0 && ok) {
          warnings.push("No projects indexed");
          stalenessScore = "possibly_stale";
        }

        if (ok && !cacheWarmed) {
          client.warmCache();
          cacheWarmed = true;
        }

        const serverVersion = ok && typeof client.getServerVersion === "function"
          ? await client.getServerVersion().catch(() => null) ?? undefined
          : undefined;
        const suggestConfig = ok && typeof client.getSuggestConfig === "function"
          ? await client.getSuggestConfig().catch(() => null) ?? undefined
          : undefined;

        const message = ok
          ? `OpenGrok: connected (${latencyMs}ms, ${indexedProjects} projects, staleness: ${stalenessScore})`
          : "OpenGrok: connection failed";

        const health = {
          connected: ok,
          latencyMs,
          indexedProjects,
          latencyTrend,
          stalenessScore,
          warnings,
          message,
          ...(serverVersion != null ? { serverVersion } : {}),
          ...(suggestConfig != null ? { suggestConfig } : {}),
        };

        if (format === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
          };
        }

        const lines = [
          "# OpenGrok Health",
          "",
          `- **Connected:** ${health.connected}`,
          `- **Latency:** ${health.latencyMs}ms`,
          `- **Indexed projects:** ${health.indexedProjects}`,
          `- **Latency trend:** ${health.latencyTrend}`,
          `- **Staleness:** ${health.stalenessScore}`,
          ...(serverVersion != null ? [`- **Server version:** ${serverVersion}`] : []),
          ...(health.suggestConfig != null ? [`- **Suggest config:** enabled=${health.suggestConfig.enabled}, maxResults=${health.suggestConfig.maxResults}`] : []),
          ...(health.warnings.length > 0 ? [`- **Warnings:** ${health.warnings.join(", ")}`] : []),
        ].join("\n");

        return {
          content: [{ type: "text", text: lines }],
        };
      } catch (err) {
        return makeToolError("opengrok_index_health", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_compile_info",
    {
      title: "Get Compile Info",
      description: desc(
        "Get compiler flags and include paths from compile_commands.json.",
        "Compiler flags (requires compile_commands.json)"
      ),
      inputSchema: GetCompileInfoArgs.shape,
      annotations: READ_ONLY_LOCAL,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_compile_info" });
      try {
        const text = await handleGetCompileInfo(
          args as unknown as Record<string, unknown>,
          config,
          local
        );
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_get_compile_info", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_symbols",
    {
      title: "Get File Symbols",
      description: desc(
        "List all symbols (functions, classes, variables) defined in a file.",
        "File symbols list"
      ),
      inputSchema: GetFileSymbolsArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_symbols" });
      try {
        const expired = checkCursorExpired(args.cursor, "symbols");
        if (expired) {
          return { content: [{ type: "text" as const, text: expired }] };
        }
        const result = await client.getFileSymbols(args.project, args.path, { cursor: args.cursor });
        const fmt = selectFormat("generic", args.response_format);
        if (fmt === "json") {
          const data = {
            symbols: result.symbols.map((s) => ({ name: s.symbol, type: s.type, line: s.line })),
          };
          return { content: [{ type: "text" as const, text: capResponse(JSON.stringify(data, null, 2)) }] };
        }
        if (!result.symbols.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No symbols found for ${args.path} in project ${args.project}. The file may not be indexed or the OpenGrok instance does not support the /api/v1/file/defs endpoint.`,
              },
            ],
          };
        }
        return {
          content: [
            { type: "text" as const, text: capResponse(formatFileSymbols(result)) },
            { type: "resource_link" as const, uri: buildXrefUri(config.OPENGROK_BASE_URL, args.project, args.path), name: args.path, mimeType: getMimeType(args.path) },
          ],
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_symbols", err);
      }
    }
  );

  server.registerTool(
    "opengrok_call_graph",
    {
      title: "Get Call Graph",
      description: desc(
        "Find all callers and callees of a function or method symbol.",
        "Callers and callees of a symbol"
      ),
      inputSchema: CallGraphArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_call_graph" });
      try {
        // args is already validated against CallGraphArgs.shape by the MCP SDK
        const results = await client.getCallGraph(args.project, args.symbol);
        const fmt = selectFormat("search", args.response_format as ResponseFormat | undefined);
        const maxBytes = getMaxResponseBytes();
        if (fmt === "json") {
          const data = {
            results: results.results.map((r: SearchResult) => ({
              file: r.path,
              project: r.project,
              lines: r.matches.map((m: SearchMatch) => ({ number: m.lineNumber, content: m.lineContent })),
            })),
          };
          return { content: [{ type: "text", text: capResponse(JSON.stringify(data, null, 2)) }] };
        }
        return {
          content: [{ type: "text", text: pickSearchFormatter(fmt, maxBytes)(results) }],
        };
      } catch (err) {
        return makeToolError("opengrok_call_graph", err);
      }
    }
  );

  server.registerTool(
    "opengrok_what_changed",
    {
      title: "What Changed",
      description: desc(
        "Show which lines changed recently in a file, grouped by commit.",
        "Recent line changes grouped by commit"
      ),
      inputSchema: WhatChangedArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_what_changed" });
      try {
        const [history, annotation] = await Promise.all([
          client.getFileHistory(args.project, args.path),
          client.getAnnotate(args.project, args.path),
        ]);
        const fmt = selectFormat("generic", args.response_format);
        if (fmt === "json") {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - args.since_days);
          const recentRevisions = new Set<string>();
          for (const entry of history.entries) {
            const entryDate = new Date(entry.date);
            if (!isNaN(entryDate.getTime()) && entryDate >= cutoff) {
              recentRevisions.add(entry.revision);
            }
          }
          const byRevision = new Map<string, { author: string; date: string; lines: number[] }>();
          for (const line of annotation.lines) {
            if (!recentRevisions.has(line.revision)) continue;
            let group = byRevision.get(line.revision);
            if (!group) {
              group = { author: line.author, date: line.date, lines: [] };
              byRevision.set(line.revision, group);
            }
            group.lines.push(line.lineNumber);
          }
          const changes = [...byRevision.entries()].map(([commit, { author, date, lines }]) => ({ commit, author, date, lines }));
          return { content: [{ type: "text" as const, text: capResponse(JSON.stringify({ changes }, null, 2)) }] };
        }
        return {
          content: [{ type: "text" as const, text: capResponse(formatWhatChanged(history, annotation, args.since_days)) }],
        };
      } catch (err) {
        return makeToolError("opengrok_what_changed", err);
      }
    }
  );

  server.registerTool(
    "opengrok_blame",
    {
      title: "Git Blame",
      description: desc(
        "Git blame with optional diff for a file path.",
        "Git blame annotation"
      ),
      inputSchema: BlameArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_blame" });
      try {
        const annotations = await client.getAnnotate(args.project, args.path);
        const fmt = selectFormat("generic", args.response_format);
        if (fmt === "json") {
          let displayLines = annotations.lines;
          if (args.line_start !== undefined || args.line_end !== undefined) {
            /* v8 ignore start */
            const s = args.line_start ?? 1;
            const e = args.line_end ?? Infinity;
            /* v8 ignore stop */
            displayLines = annotations.lines.filter((l) => l.lineNumber >= s && l.lineNumber <= e);
          }
          const entries = displayLines.map((l) => ({
            line: l.lineNumber,
            commit: l.revision ?? "",
            author: l.author ?? "",
            date: l.date ?? "",
            content: l.content,
          }));
          return { content: [{ type: "text", text: capResponse(JSON.stringify({ entries }, null, 2)) }] };
        }
        return {
          content: [{ type: "text", text: capResponse(formatBlame(annotations, args.line_start, args.line_end, args.include_diff)) }],
        };
      } catch (err) {
        return makeToolError("opengrok_blame", err);
      }
    }
  );

  server.registerTool(
    "opengrok_dependency_map",
    {
      title: "Dependency Map",
      description: desc(
        "Build #include/import dependency graph (configurable depth).",
        "Include/import dependency graph"
      ),
      inputSchema: DependencyMapArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_dependency_map" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_dependency_map");
      try {
        const bg = typeof client.createBackgroundClient === "function"
          ? client.createBackgroundClient()
          : undefined;
        try {
          const nodes = await buildDependencyGraph(client, args.project, args.path, args.depth, args.direction, bg);
        const fmt = selectFormat("generic", args.response_format);
        if (fmt === "json") {
          const data = { nodes: nodes.map((n) => ({ path: n.path, level: n.level, direction: n.direction })) };
          return { content: [{ type: "text" as const, text: capResponse(JSON.stringify(data, null, 2)) }] };
        }

        const text = formatDependencyMap(args.path, args.depth, nodes);

        // For large graphs, use MCP Sampling to generate an intelligent summary
        let summarySection = "";
        if (nodes.length > 10 && config.OPENGROK_ENABLE_SAMPLING) {
          const nodeList = nodes.slice(0, 30).map((n) => `  ${n.direction} ${n.path} (level ${n.level})`).join("\n");
          const summary = await sampleOrNull(server, [
            {
              role: "user",
              content: {
                type: "text",
                text: `This dependency graph for \`${args.path}\` has ${nodes.length} nodes:\n${nodeList}${nodes.length > 30 ? `\n  ... and ${nodes.length - 30} more` : ""}\n\nIn 2-3 sentences, summarize the key dependency structure and any notable patterns.`,
              },
            },
          ], { maxTokens: 200, systemPrompt: "You are a code architecture analyst. Be concise and precise." });
          if (summary) {
            summarySection = `\n\n**Summary**: ${summary}`;
          }
        }

        return {
          content: [{ type: "text" as const, text: capResponse(text + summarySection) }],
        };
        } finally {
          await bg?.close().catch(() => undefined);
        }
      } catch (err) {
        return makeToolError("opengrok_dependency_map", err);
      }
    }
  );

  // Tool: opengrok_get_all_matches
  server.registerTool(
    "opengrok_get_all_matches",
    {
      title: "Get All Matches",
      description: desc(
        "Get all matching lines in a specific file (use when search shows truncated results). Use when a search result has [all N] — fetches every matching line for that file.",
        "All matching lines in a file"
      ),
      inputSchema: GetAllMatchesArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_all_matches" });
      try {
        const matches = await client.getAllMatchesInFile(args.project, args.path, args.query, args.search_type, args.max_results);
        return formatResponse(formatMoreResults(matches, args.project, args.path), { matches }, args.response_format, "search");
      } catch (err) {
        return makeToolError("opengrok_get_all_matches", err);
      }
    }
  );

  // Tool: opengrok_get_file_history_with_files
  server.registerTool(
    "opengrok_get_file_history_with_files",
    {
      title: "Get File History With Files",
      description: desc(
        "Get commit history including co-changed files via RSS feed (withFiles equivalent). Includes branch markers, update forms, MR links.",
        "Commit history with co-changed files"
      ),
      inputSchema: GetFileHistoryWithFilesArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_history_with_files" });
      try {
        const result = await client.getFileHistoryWithFiles(args.project, args.path, { maxEntries: args.max_entries });
        return formatResponse(formatRssHistory(result.entries, args.project, args.path), { entries: result.entries }, args.response_format, "generic");
      } catch (err) {
        return makeToolError("opengrok_get_file_history_with_files", err);
      }
    }
  );

  // Tool: opengrok_get_download_url
  server.registerTool(
    "opengrok_get_download_url",
    {
      title: "Get Download URL",
      description: desc(
        "Get the direct download URL for a file (Content-Disposition: attachment). No HTTP call — constructs URL from project and path.",
        "Direct download URL for a file"
      ),
      inputSchema: GetDownloadUrlArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_download_url" });
      try {
        const url = client.getDownloadUrl(args.project, args.path);
        return { content: [{ type: "text" as const, text: capResponse(url) }] };
      } catch (err) {
        return makeToolError("opengrok_get_download_url", err);
      }
    }
  );

  // Tool: opengrok_list_groups
  server.registerTool(
    "opengrok_list_groups",
    {
      title: "List Groups",
      description: desc(
        "List project groups. Returns empty on servers where /api/v1/groups requires admin auth.",
        "List project groups"
      ),
      inputSchema: ListGroupsArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_list_groups" });
      try {
        const groups = await client.getProjectGroups();
        if (!groups.length) {
          return { content: [{ type: "text" as const, text: "No groups available (admin auth may be required on this server)." }] };
        }
        const text = groups.map((g) => `${g.name}: [${g.projects.join(", ")}]`).join("\n");
        return formatResponse(text, { groups }, args.response_format, "generic");
      } catch (err) {
        return makeToolError("opengrok_list_groups", err);
      }
    }
  );

  // Tool: opengrok_get_suggest_popularity
  server.registerTool(
    "opengrok_get_suggest_popularity",
    {
      title: "Get Suggest Popularity",
      description: desc(
        "Get popular search suggestions for a project field. Returns empty when admin auth required.",
        "Popular search suggestions"
      ),
      inputSchema: GetSuggestPopularityArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_suggest_popularity" });
      try {
        const items = await client.getSuggestPopularity({ project: args.project, field: args.field, pageSize: args.page_size });
        if (!items.length) {
          return { content: [{ type: "text" as const, text: "No popularity data available (admin auth may be required)." }] };
        }
        return { content: [{ type: "text" as const, text: capResponse(items.join("\n")) }] };
      } catch (err) {
        return makeToolError("opengrok_get_suggest_popularity", err);
      }
    }
  );

  // Tool: opengrok_get_project_repositories
  server.registerTool(
    "opengrok_get_project_repositories",
    {
      title: "Get Project Repositories",
      description: desc(
        "List repositories for a project. Returns empty when admin auth required.",
        "List project repositories"
      ),
      inputSchema: GetProjectRepositoriesArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_project_repositories" });
      try {
        const repos = await client.getProjectRepositories(args.project);
        if (!repos.length) {
          return { content: [{ type: "text" as const, text: "No repositories available (admin auth may be required)." }] };
        }
        const text = repos.map((r) => `url: ${r.url}, type: ${r.type}`).join("\n");
        return { content: [{ type: "text" as const, text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_get_project_repositories", err);
      }
    }
  );

  // registerLegacyTools intentionally returns void — server is mutated in place
}
