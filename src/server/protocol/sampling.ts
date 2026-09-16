/**
 * MCP Sampling helper — wraps server.server.createMessage with graceful fallback.
 *
 * Sampling allows the server to request an LLM completion from the connected
 * client (the AI model). Not all MCP clients support sampling; this wrapper
 * returns null instead of throwing when sampling is unavailable.
 *
 * Production features (Task 5.5):
 *   - Exponential backoff retry (default 2 retries)
 *   - Per-call timeout with Promise.race (default 10 s)
 *   - Model preference via OPENGROK_SAMPLING_MODEL
 *   - Token budget configurable via OPENGROK_SAMPLING_MAX_TOKENS
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface SamplingMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface SamplingOptions {
  /** Maximum tokens the model may generate. Default: 256 */
  maxTokens?: number;
  /** Hard wall-clock timeout in ms. Default: 10 000 */
  timeoutMs?: number;
  /** System prompt prepended to the conversation. */
  systemPrompt?: string;
  /** Number of additional retry attempts on transient failure. Default: 2 */
  retries?: number;
  /** Hint at which model to use (passed as a name hint). */
  model?: string;
}

async function callSampling(
  server: McpServer,
  messages: SamplingMessage[],
  opts: Required<Pick<SamplingOptions, "maxTokens" | "systemPrompt" | "model">>
): Promise<string | null> {
  const params: Parameters<typeof server.server.createMessage>[0] = {
    messages,
    maxTokens: opts.maxTokens,
  };
  if (opts.systemPrompt) params.systemPrompt = opts.systemPrompt;
  if (opts.model) {
    params.modelPreferences = { hints: [{ name: opts.model }] };
  }
  const result = await server.server.createMessage(params);
  const content = result?.content;
  if (content && content.type === "text") {
    return content.text ?? null;
  }
  return null;
}

/**
 * Request an LLM completion via MCP Sampling.
 * Returns the generated text, or null if the client doesn't support sampling,
 * all retries are exhausted, or the timeout is exceeded.
 */
export async function sampleOrNull(
  server: McpServer,
  messages: SamplingMessage[],
  opts: SamplingOptions = {}
): Promise<string | null> {
  const {
    maxTokens = 256,
    timeoutMs = 10_000,
    systemPrompt = "",
    retries = 2,
    model = "",
  } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const sampling = Promise.race([
        callSampling(server, messages, { maxTokens, systemPrompt, model }),
        new Promise<never>((_, reject) => {
          timerId = setTimeout(() => reject(new Error("sampling timeout")), timeoutMs);
        }),
      ]);
      try {
        return await sampling;
      } finally {
        clearTimeout(timerId);
      }
    } catch {
      if (attempt === retries) return null;
      // Exponential backoff: 500 ms, 1 000 ms, 2 000 ms ...
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
    }
  }
  return null;
}
