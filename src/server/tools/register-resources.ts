/**
 * MCP Resource registration (split from server.ts, pure move).
 */
import * as fs from "fs";
import * as path from "path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryBank, ALLOWED_FILES } from "../memory/memory-bank.js";
import { TOOL_DOCS } from "./tool-docs.js";
import { API_SPEC, filterApiSpec } from "../sandbox/sandbox.js";
import { logger } from "../utils/logger.js";
import type { Config } from "../config.js";

export function registerToolDocResources(server: McpServer, config?: Config): void {
  // Static resource: full Code Mode API spec — clients can pre-fetch to avoid calling opengrok_api
  try {
    server.registerResource(
      "opengrok-api-spec",
      "opengrok-docs://api",
      { description: "Full Code Mode API specification (TypeScript declarations). Pre-fetch to avoid calling opengrok_api.", mimeType: "text/typescript" },
      () => {
        const text = config
          ? filterApiSpec(API_SPEC, { memoryTools: Boolean(config.OPENGROK_ENABLE_MEMORY_TOOLS) })
          : API_SPEC;
        return { contents: [{ uri: "opengrok-docs://api", mimeType: "text/typescript", text }] };
      }
    );
  } catch (err) {
    logger.warn("Failed to register opengrok-api-spec resource:", err);
  }

  // NOTE: `server.resource()` (low-level API) is used here instead of `server.registerResource()`
  // because the high-level API only supports static URIs. Parameterized URIs (opengrok-docs://tools/{name})
  // require ResourceTemplate, which is only available on the low-level API. The static API is used
  // above for the fixed URI; this is the intentional split.
  try {
    server.registerResource(
      'opengrok-tool-docs',
      new ResourceTemplate('opengrok-docs://tools/{name}', { list: undefined }),
      { description: "Per-tool documentation page. URI pattern: opengrok-docs://tools/{name}", mimeType: "text/markdown" },
      (uri, variables) => {
        const name = String(variables['name'] ?? '');
        const doc = TOOL_DOCS[name];
        if (!doc) {
          throw new Error(`No documentation found for tool: ${name}`);
        }
        return {
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc }],
        };
      }
    );
  } catch (err) {
    logger.warn("Failed to register parameterized tool-docs resource (SDK version may not support ResourceTemplate):", err);
  }
}

export function registerMemoryResources(server: McpServer, memoryBank: MemoryBank): void {
  for (const filename of ALLOWED_FILES) {
    const uri = `opengrok-memory://${filename}`;
    const filePath = path.join(memoryBank.bankDir, filename);
    let size: number | undefined;
    try {
      // Snapshot size at registration time; advisory only — memory bank writes
      // update the file on disk but do not re-register the resource.
      size = fs.statSync(filePath).size;
    } catch {
      // file doesn't exist yet — omit size
    }
    server.registerResource(
      filename,
      uri,
      {
        description: `OpenGrok memory bank file: ${filename}`,
        mimeType: "text/markdown",
        ...(size !== undefined && { size }),
      },
      async () => {
        const content = await memoryBank.read(filename) ?? "";
        return {
          contents: [{ uri, mimeType: "text/markdown", text: content }],
        };
      }
    );
  }
}
