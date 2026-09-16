/**
 * MCP Prompt registration (split from server.ts, pure move).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function sanitizePromptArg(value: string): string {
  return value
    .replace(/`([^`]*)`/g, (_, inner: string) => inner.replace(/[<>]/g, ""))  // strip backtick delimiters and angle brackets inside
    .replace(/[\r\n]+/g, " ")                                          // collapse newlines → space
    .replace(/[*_#[\]()]/g, "")                                        // strip markdown emphasis/heading/link chars
    .trim()
    .slice(0, 256);                                        // hard cap to prevent oversized inputs
}

export function registerInvestigationPrompts(server: McpServer): void {
  server.registerPrompt(
    "investigate-symbol",
    {
      description:
        "Investigate a symbol across definition, usages, callers, and recent changes. " +
        "Guides the LLM through a structured symbol-level investigation.",
      argsSchema: {
        symbol: z.string().describe("The symbol name to investigate (function, class, variable, etc.)"),
        project: z.string().optional().describe("OpenGrok project to scope the search to"),
      },
    },
    ({ symbol, project }) => {
      const sym = sanitizePromptArg(symbol);
      const proj = project ? sanitizePromptArg(project) : undefined;
      const scope = proj ? ` in project \`${proj}\`` : "";
      return {
        description: `Investigate symbol \`${sym}\`${scope}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Investigate the symbol \`${sym}\`${scope} using the OpenGrok MCP server.`,
                "",
                "Follow these steps in order:",
                `1. **Definition** — use \`opengrok_search_code\` with type \`defs\` to find where \`${sym}\` is defined.`,
                `2. **Usages** — use \`opengrok_search_code\` with type \`refs\` to find all references.`,
                `3. **Symbol context** — use \`opengrok_get_symbol_context\` to see the full declaration with surrounding code.`,
                `4. **Recent changes** — use \`opengrok_what_changed\` or \`opengrok_get_file_history\` on the definition file.`,
                "",
                "Summarise: what the symbol does, where it is defined, how widely it is used, and any recent modifications.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "find-feature",
    {
      description:
        "Find where a feature is implemented in the codebase. " +
        "Guides the LLM through searching, reading key files, and mapping entry points.",
      argsSchema: {
        feature: z.string().describe("Description of the feature to locate (e.g. 'rate limiting', 'authentication')"),
        project: z.string().optional().describe("OpenGrok project to scope the search to"),
      },
    },
    ({ feature, project }) => {
      const feat = sanitizePromptArg(feature);
      const proj = project ? sanitizePromptArg(project) : undefined;
      const scope = proj ? ` in project \`${proj}\`` : "";
      return {
        description: `Find feature: ${feat}${scope}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Find where the feature "${feat}" is implemented${scope}.`,
                "",
                "Approach:",
                `1. **Full-text search** — use \`opengrok_search_code\` with type \`full\` for keywords related to "${feat}".`,
                "2. **Path search** — use \`opengrok_search_code\` with type \`path\` to find files named after the feature.",
                "3. **Read candidates** — use \`opengrok_get_file_content\` to read the most relevant files.",
                "4. **Browse structure** — use \`opengrok_browse_directory\` on relevant directories to map the module layout.",
                "",
                "Summarise: the entry point(s), key files, and a brief explanation of how the feature works.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "review-file",
    {
      description:
        "Perform a code review of a specific file. " +
        "Guides the LLM through reading, history, callers, and producing a structured review.",
      argsSchema: {
        path: z.string().describe("Repository-relative path to the file to review"),
        project: z.string().describe("OpenGrok project the file belongs to"),
      },
    },
    ({ path: filePath, project }) => {
      const fp = sanitizePromptArg(filePath);
      const proj = sanitizePromptArg(project);
      return {
        description: `Review file: ${fp}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Perform a code review of \`${fp}\` in project \`${proj}\`.`,
                "",
                "Steps:",
                `1. **Read file** — use \`opengrok_get_file_content\` for project \`${proj}\`, path \`${fp}\`.`,
                `2. **File history** — use \`opengrok_get_file_history\` to understand recent changes.`,
                `3. **Symbols** — use \`opengrok_get_file_symbols\` to list the public API surface.`,
                `4. **Callers** — for each exported symbol, check \`opengrok_search_code\` with type \`refs\` to understand how it is used.`,
                `5. **Annotations** — use \`opengrok_get_file_annotate\` to see which commits touched which lines.`,
                "",
                "Produce a structured review covering:",
                "- **Purpose**: what the file does",
                "- **Design observations**: naming, structure, separation of concerns",
                "- **Potential issues**: bugs, edge cases, error handling",
                "- **Test coverage signals**: anything that looks under-tested",
                "- **Recommendations**: concrete, prioritised action items",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "debug-issue",
    {
      description:
        "Trace an error message or exception back to its origin, understand recent changes that may have caused it, and suggest a fix.",
      argsSchema: {
        error: z.string().describe("Error message, exception text, or symptom to investigate"),
        project: z.string().optional().describe("OpenGrok project to scope the search to"),
      },
    },
    ({ error, project }) => {
      const err = sanitizePromptArg(error);
      const proj = project ? sanitizePromptArg(project) : undefined;
      const scope = proj ? ` in project \`${proj}\`` : "";
      return {
        description: `Debug: ${err.slice(0, 60)}${err.length > 60 ? "…" : ""}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Investigate the following error${scope}:`,
                `\`\`\``,
                err,
                `\`\`\``,
                "",
                "Steps:",
                `1. **Locate the error** — use \`opengrok_search_code\` with type \`full\` for the exact error string or a distinctive fragment.`,
                `2. **Find the throw/log site** — use \`opengrok_get_file_content\` to read the file and understand the surrounding logic.`,
                `3. **Trace callers** — use \`opengrok_search_code\` with type \`refs\` on the function or method that emits the error to find call sites.`,
                `4. **Check recent changes** — use \`opengrok_get_file_history\` on affected files; diff the last few revisions with \`opengrok_get_file_diff\` to identify what changed.`,
                `5. **Blame the line** — use \`opengrok_get_file_annotate\` to confirm which commit introduced the problematic line.`,
                "",
                "Summarise: root cause, which commit introduced it, affected call paths, and a concrete fix recommendation.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}

