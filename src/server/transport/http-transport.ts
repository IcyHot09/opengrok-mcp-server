/**
 * HTTP Streamable Transport for OpenGrok MCP Server
 *
 * Starts a Node.js HTTP server that serves the MCP protocol over Streamable HTTP transport.
 * Supports multiple simultaneous clients via per-session transport instances.
 * Each connecting client gets an isolated McpServer instance with full tool access.
 *
 * OAuth 2.1 resource-server endpoints (RFC 9728 protected resource metadata) are served here.
 * This server does NOT issue tokens — obtain tokens from your authorization server.
 *
 * stdio transport is unaffected — this is purely additive.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { logger } from "../utils/logger.js";
import { parseRbacConfig, hasPermission, type Role } from "./rbac.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** If set, all /mcp requests must carry `Authorization: Bearer <authToken>`. */
  authToken?: string;
  /** Maximum concurrent sessions before new connections are rejected with 503. Default: 100 */
  maxSessions?: number;
  /** RBAC config: 'token1:admin,token2:readonly' format (Task 5.10) */
  rbacTokens?: string;
}

/** Per-session metadata for monitoring and cleanup. */
export interface SessionMetadata {
  createdAt: Date;
  lastActivity: Date;
  requestCount: number;
  role: Role; // RBAC role (admin, developer, readonly)
}

type TransportHandle = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  meta: SessionMetadata;
};

/** Factory function that produces a fresh McpServer for each new session. */
export type McpServerFactory = () => McpServer;

/** Sessions idle longer than this are automatically closed. */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** How often to scan for idle sessions. */
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Returns true when the request carries a valid Bearer token (timing-safe). */
export function validateBearerToken(req: IncomingMessage, secret: string): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const provided = auth.slice(7);
  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Send a 401 Unauthorized response with a WWW-Authenticate challenge. */
function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="opengrok-mcp"',
  });
  res.end(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }));
}

// ---------------------------------------------------------------------------
// OAuth 2.1 JWT validation (resource server)
// ---------------------------------------------------------------------------

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Map OAuth 2.1 scopes to an RBAC Role.
 *
 * Default scope→role mapping:
 *   opengrok:admin  → admin
 *   opengrok:write  → developer
 *   opengrok:read   → readonly
 *
 * Override via OPENGROK_SCOPE_MAP env var (comma-separated "scope:role" pairs,
 * e.g. "my:admin:admin,my:write:developer").
 */
export function scopeToRole(scopes: string | string[]): Role {
  const scopeList = Array.isArray(scopes) ? scopes : String(scopes).split(' ');
  // Allow custom scope mapping via env var: "my:admin:admin,my:write:developer"
  const customMap: Record<string, Role> = {};
  const validRoles = new Set<string>(['admin', 'developer', 'readonly']);
  const scopeMapEnv = process.env.OPENGROK_SCOPE_MAP ?? '';
  for (const pair of scopeMapEnv.split(',')) {
    const parts = pair.trim().split(':');
    if (parts.length >= 2) {
      const role = parts[parts.length - 1] ?? "";
      if (!validRoles.has(role)) continue; // skip invalid roles
      const scope = parts.slice(0, -1).join(':');
      customMap[scope] = role as Role;
    }
  }
  const defaultMap: Record<string, Role> = {
    'opengrok:admin': 'admin',
    'opengrok:write': 'developer',
    'opengrok:read': 'readonly',
    ...customMap,
  };
  for (const [scope, role] of Object.entries(defaultMap)) {
    if (scopeList.includes(scope)) return role;
  }
  return 'readonly';
}

async function validateJwt(token: string): Promise<Role | null> {
  const jwksUri = process.env.OPENGROK_JWKS_URI;
  if (!jwksUri) return null;
  try {
    if (!_jwks) _jwks = createRemoteJWKSet(new URL(jwksUri));
    const issuer = process.env.OPENGROK_JWT_ISSUER;
    const { payload } = await jwtVerify(token, _jwks, {
      audience: process.env.OPENGROK_RESOURCE_URI,
      ...(issuer ? { issuer } : {}),
    });
    const scopes = String((payload as JWTPayload & { scope?: string; scp?: string }).scope ??
                           (payload as JWTPayload & { scp?: string }).scp ?? '');
    return scopeToRole(scopes);
  } catch {
    return null;
  }
}

/** Reset the cached JWKS (for testing). */
export function resetJwksCache(): void {
  _jwks = null;
}

/**
 * Start an HTTP server that serves the MCP protocol over Streamable HTTP transport.
 *
 * @param serverFactory - called once per new client session to create a McpServer
 * @param opts - port, optional host, and optional auth options
 * @returns promise that resolves once the server is listening, with a `close()` helper
 */
export async function startHttpTransport(
  serverFactory: McpServerFactory,
  opts: HttpTransportOptions
): Promise<{ close: () => void }> {
  const { port, host = "127.0.0.1", authToken = "", maxSessions = 100, rbacTokens = "" } = opts;
  const rbacConfig = parseRbacConfig(rbacTokens);

  if (process.env.OPENGROK_STRICT_OAUTH === 'true' && !process.env.OPENGROK_JWKS_URI) {
    throw new Error('OPENGROK_STRICT_OAUTH=true requires OPENGROK_JWKS_URI to be set');
  }

  // Active sessions: Mcp-Session-Id → { transport, server, meta }
  const sessions = new Map<string, TransportHandle>();

  // Sweep idle sessions on a regular interval.
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, handle] of sessions) {
      if (now - handle.meta.lastActivity.getTime() > SESSION_TTL_MS) {
        logger.info(`HTTP session expired (idle TTL): ${sid}`);
        sessions.delete(sid); // remove before closing to prevent new requests on this session ID (B4)
        void handle.transport.close().catch(() => undefined);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepInterval.unref?.(); // don't keep Node alive for the timer alone

  const allowedOrigins = (process.env.OPENGROK_ALLOWED_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const setCorsHeaders = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin ?? '';
    const authConfigured = !!(authToken || rbacConfig.tokens.size > 0);
    // When auth is configured, only allow explicitly listed origins (not all loopback)
    const isLoopback = !authConfigured && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
    const isAllowed = isLoopback || allowedOrigins.includes(origin);

    if (isAllowed && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
  };

  /** Extract bearer token from Authorization header and return role (or null for unknown/denied). */
  const extractRole = async (req: IncomingMessage): Promise<Role | null> => {
    const auth = req.headers.authorization;
    const rbacActive = rbacConfig.tokens.size > 0;

    if (!auth?.startsWith('Bearer ')) {
      // No token — fail-safe:
      // • RBAC configured → deny (null)
      // • static authToken configured → deny (null)
      // • nothing configured → allow as admin (local dev)
      if (rbacActive || authToken) return null;
      return 'admin';
    }
    const token = auth.slice(7);

    // Static auth token (local dev — disabled in strict mode)
    if (authToken && process.env.OPENGROK_STRICT_OAUTH !== 'true') {
      try {
        const a = Buffer.from(token, 'utf8');
        const b = Buffer.from(authToken, 'utf8');
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return rbacConfig.tokens.get(token) ?? 'admin';
        }
      } catch { /* length mismatch handled by !== check */ }
    }

    // RBAC static token map
    const rbacRole = rbacConfig.tokens.get(token);
    if (rbacRole) return rbacRole;
    if (rbacActive && !process.env.OPENGROK_JWKS_URI) return null;

    // JWT validation (falls back to null if JWKS not configured)
    return validateJwt(token);
  };

  /** Check if a request body is an MCP tool call, and validate RBAC if so. Returns null if permission denied. */
  const checkRbacForToolCall = (role: Role, body: unknown): { allowed: boolean; toolName?: string } => {
    if (!body || typeof body !== "object") return { allowed: true }; // not a tool call

    // Handle JSON-RPC batch requests (arrays)
    if (Array.isArray(body)) {
      for (const item of body) {
        const check = checkRbacForToolCall(role, item);
        if (!check.allowed) return check;
      }
      return { allowed: true };
    }

    const b = body as Record<string, unknown>;
    if (b.method !== "tools/call") return { allowed: true }; // not a tool call

    const params = b.params;
    if (!params || typeof params !== "object") return { allowed: true };

    const toolName = (params as Record<string, unknown>).name as string | undefined;
    if (!toolName) return { allowed: false, toolName: "(missing)" };

    const isAllowed = hasPermission(role, toolName);
    return { allowed: isAllowed, toolName };
  };

  /** Read the full request body as a parsed JSON object (or URL-encoded form). Returns null on failure. */
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve(null);
          return;
        }
        // Try JSON first, then URL-encoded form data
        try {
          resolve(JSON.parse(raw));
          return;
        } catch {
          // try form
        }
        const params: Record<string, string> = {};
        for (const pair of raw.split("&")) {
          const [k, v] = pair.split("=");
          if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
        }
        resolve(params);
      });
      req.on("error", () => resolve(null));
    });

  const handlePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = await readBody(req);

    try {
      let handle: TransportHandle | undefined;

      if (sessionId && sessions.has(sessionId)) {
        handle = sessions.get(sessionId);
        if (!handle) throw new Error("Session vanished");
        handle.meta.lastActivity = new Date();
        handle.meta.requestCount += 1;
      } else if (!sessionId && isInitializeRequest(body)) {
        // Enforce session cap before creating a new session.
        if (sessions.size >= maxSessions) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Service Unavailable: maximum sessions reached" },
              id: null,
            })
          );
          return;
        }

        // Extract role from bearer token (RBAC)
        const role = await extractRole(req);
        if (role === null) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden', error_description: 'Unknown or missing token' }));
          return;
        }

        // New client — create a fresh server + transport for this session.
        const now = new Date();
        const meta: SessionMetadata = { createdAt: now, lastActivity: now, requestCount: 1, role };

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server, meta });
            logger.info(`HTTP session initialized: ${sid}`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            logger.info(`HTTP session closed: ${sid}`);
          }
        };

        const server = serverFactory();
        await server.connect(transport);

        handle = { transport, server, meta };
        // Note: session map entry is set by onsessioninitialized above
        await transport.handleRequest(req, res, body);
        return;
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          })
        );
        return;
      }

      // Check RBAC permissions for existing sessions
      const rbacCheck = checkRbacForToolCall(handle.meta.role, body);
      if (!rbacCheck.allowed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: `Role '${handle.meta.role}' does not have permission for tool '${rbacCheck.toolName}'`,
            data: { tool: rbacCheck.toolName, role: handle.meta.role },
          },
          id: null,
        }));
        return;
      }

      await handle.transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error("HTTP POST handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
      }
    }
  };

  const handleGet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400).end("Invalid or missing session ID");
      return;
    }
    const handle = sessions.get(sessionId);
    if (!handle) return;
    handle.meta.lastActivity = new Date();
    handle.meta.requestCount += 1;
    try {
      await handle.transport.handleRequest(req, res);
    } catch (err) {
      logger.error("HTTP GET (SSE) handler error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
  };

  const handleDelete = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400).end("Invalid or missing session ID");
      return;
    }
    try {
      const handle = sessions.get(sessionId);
    if (handle) await handle.transport.handleRequest(req, res);
    else throw new Error("Session vanished");
    } catch (err) {
      logger.error("HTTP DELETE handler error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
  };

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      setCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const url = req.url?.split("?")[0];

      // RFC 9728 — OAuth 2.1 protected resource metadata
      if (url === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        const resourceUri = process.env.OPENGROK_RESOURCE_URI ?? `http://${host}:${port}`;
        const authServers = (process.env.OPENGROK_AUTH_SERVERS ?? '')
          .split(',').map(s => s.trim()).filter(Boolean);
        const metadata = {
          resource: resourceUri,
          authorization_servers: authServers,
          bearer_methods_supported: ['header'],
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' });
        res.end(JSON.stringify(metadata));
        return;
      }

      // /token endpoint removed — this server is an OAuth 2.1 resource server only
      if (url === '/token') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'not_found',
          error_description: 'This server is an OAuth 2.1 resource server. Obtain tokens from your authorization server.',
        }));
        return;
      }

      // Debug/admin endpoint — active session stats.
      if (url === "/mcp/sessions" && req.method === "GET") {
        const sessionList = Array.from(sessions.entries()).map(([sid, h]) => ({
          sessionId: sid,
          createdAt: h.meta.createdAt.toISOString(),
          lastActivity: h.meta.lastActivity.toISOString(),
          requestCount: h.meta.requestCount,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ activeSessionCount: sessions.size, maxSessions, sessions: sessionList }));
        return;
      }

      if (url !== "/mcp") {
        res.writeHead(404).end("Not Found");
        return;
      }

      // Bearer token validation for /mcp
      // Only enforce auth for new sessions (initialize requests without session ID)
      // Existing sessions are identified by session ID header
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const isExistingSession = sessionId && sessions.has(sessionId);

      if (!isExistingSession) {
        // New request: validate bearer token
        const role = await extractRole(req);
        if (role === null) {
          rejectUnauthorized(res);
          return;
        }
      }

      if (req.method === "POST") {
        await handlePost(req, res);
      } else if (req.method === "GET") {
        await handleGet(req, res);
      } else if (req.method === "DELETE") {
        await handleDelete(req, res);
      } else {
        res.writeHead(405).end("Method Not Allowed");
      }
    })();
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      logger.info(`HTTP transport listening on http://${host}:${port}/mcp`);
      resolve({
        close: () => {
          clearInterval(sweepInterval);
          // Close all active sessions before shutting down
          for (const [, handle] of sessions) {
            void handle.transport.close().catch(() => undefined);
          }
          sessions.clear();
          httpServer.close();
        },
      });
    });
    httpServer.once("error", reject);
  });
}
