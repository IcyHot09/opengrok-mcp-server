/**
 * OpenGrok HTTP client (OpenGrokClient class) - split from client.ts (pure move).
 */

import pRetry, { AbortError } from "p-retry";
import { minimatch } from "minimatch";
import { URL } from "url";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from "undici";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getUndiciConnectTls } from "../../shared/tls-ca.js";
import { decodeCursor, isOffsetCursorFor, CURSOR_EXPIRED } from "../pagination/cursor-codec.js";
export { CURSOR_EXPIRED };
import type {
  AnnotatedFile,
  DirectoryEntry,
  FileContent,
  FileDiff,
  FileHistory,
  FileSymbol,
  FileSymbols,
  Project,
  SearchResults,
  SearchTypeValue,
} from "../models.js";
import {
  parseAnnotate,
  parseDirectoryListing,
  parseFileHistory,
  parseFileSymbols,
  parseFileDiff,
  parseProjectsPage,
  parseWebSearchResults,
  parseSingleResultRedirect,
  parseMoreResults,
  parseHistoryRss,
} from "../parsers/index.js";
import { TTLCache, estimateBytes } from "./cache.js";
import { TIMEOUTS, sleep, extractLineRange, safeResponseText } from "./text-utils.js";
import {
  assertSafePath,
  buildSafeUrl,
  isPrivateIp,
  isSafeRedirect,
  validateFileType,
  matchesFileType,
} from "./security.js";
import { parseSearchResponse } from "./response-parser.js";

// Version injected at build time by esbuild, fallback for dev/test
declare const __VERSION__: string;
/* v8 ignore start -- compile-time constant injected by esbuild */
const CLIENT_VERSION =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : (process.env.npm_package_version ?? "0.0.0");
/* v8 ignore stop */
/* v8 ignore stop */

const MAX_REDIRECTS = 10;
const MAX_FILTER_LENGTH = 100;

// ---------------------------------------------------------------------------
// Rate Limiter (token bucket — lock released before sleeping)
// ---------------------------------------------------------------------------

class RateLimiter {
  private readonly intervalMs: number;   // ms per token (integer)
  private readonly maxTokensMs: number;  // max accumulated token-ms
  private readonly maxQueueSize: number;
  private tokensMs: number;              // current accumulated token-ms (integer)
  private lastUpdate: number;
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(requestsPerMinute: number, maxQueueSize = 100) {
    this.intervalMs = Math.round((60 / requestsPerMinute) * 1000);
    this.maxTokensMs = requestsPerMinute * this.intervalMs;
    this.maxQueueSize = maxQueueSize;
    this.tokensMs = this.maxTokensMs; // start full
    this.lastUpdate = Date.now();
  }

  async acquire(): Promise<void> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error("Rate limit queue full");
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
      /* v8 ignore start */
      if (!this.processing) void this.processQueue();
      /* v8 ignore stop */
    });
  }

  /**
   * Try to consume one token without waiting.
   * Returns `true` if a token was consumed, `false` otherwise.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokensMs >= this.intervalMs) {
      this.tokensMs -= this.intervalMs;
      return true;
    }
    return false;
  }

  /**
   * Returns ms until the next token becomes available (0 if one is available now).
   * Performs a refill before checking.
   */
  msUntilAvailable(): number {
    this.refill();
    if (this.tokensMs >= this.intervalMs) return 0;
    return Math.ceil(this.intervalMs - this.tokensMs);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastUpdate);
    this.tokensMs = Math.min(this.maxTokensMs, this.tokensMs + elapsed);
    this.lastUpdate = now;
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      this.refill();

      if (this.tokensMs >= this.intervalMs) {
        this.tokensMs -= this.intervalMs;
        const next = this.queue.shift();
        if (next) next();
      } else {
        const waitMs = this.intervalMs - this.tokensMs;
        await sleep(Math.ceil(waitMs));
      }
    }
    this.processing = false;
  }
}

/** A single suggestion returned by the OpenGrok suggest endpoint. */
export interface SuggestItem {
  phrase: string;
  projects: string[];
  score: number;
}

export interface SuggestConfig {
  enabled: boolean;
  maxResults: number;
  allowedFields: string[];
  allowMostPopular: boolean;
  rebuildCronConfig?: string;
}

export interface RssHistoryEntry {
  revision: string;
  summary: string;
  fullMessage: string;
  author: string;
  date: string;
  files: string[];
  branches: string[];
  updateForm?: string;
  mergeRequest?: string;
  autoCheckin: boolean;
}

// ---------------------------------------------------------------------------
// OpenGrok HTTP Client
// ---------------------------------------------------------------------------


export class OpenGrokClient {
  private readonly baseUrl: URL;
  private readonly apiPath: string;
  private readonly authHeader: string | undefined;
  private readonly verifySsl: boolean;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly agent: Dispatcher | undefined;
  private annotateEndpoint: 'annotate' | 'xref' | null = null;

  // Track final URL after redirects (used to detect single-result xref redirects)
  private readonly responseFinalUrls = new WeakMap<UndiciResponse, string>();

  // Caches
  private readonly searchCache: TTLCache<string, SearchResults> | undefined;
  private readonly matchCache: TTLCache<string, Array<{ lineNumber: number; lineContent: string }>> | undefined;
  private readonly fileCache: TTLCache<string, string> | undefined;
  private readonly historyCache: TTLCache<string, FileHistory> | undefined;
  private readonly projectsCache: TTLCache<string, Project[]> | undefined;

  constructor(private readonly config: Config, private readonly clientOpts: { skipRateLimit?: boolean; backgroundTimeoutMs?: number } = {}) {
    if (!config.OPENGROK_BASE_URL) {
      throw new Error(
        "OPENGROK_BASE_URL is not configured. Run `npx opengrok-mcp-server setup` or set the OPENGROK_BASE_URL environment variable."
      );
    }
    const raw = config.OPENGROK_BASE_URL.endsWith("/")
      ? config.OPENGROK_BASE_URL
      : config.OPENGROK_BASE_URL + "/";
    this.baseUrl = new URL(raw);

    // SSRF protection: fail fast or warn if base URL points at a private IP.
    // Per-request buildSafeUrl() still blocks private/loopback hosts regardless.
    if (isPrivateIp(this.baseUrl.hostname)) {
      if (config.OPENGROK_STRICT_SSRF) {
        throw new Error(
          `SSRF protection: OPENGROK_BASE_URL resolves to private IP "${this.baseUrl.hostname}". ` +
          "Disable OPENGROK_STRICT_SSRF=false if this is intentional."
        );
      }
      logger.warn(
        `OPENGROK_BASE_URL points to private IP "${this.baseUrl.hostname}". ` +
        "Set OPENGROK_STRICT_SSRF=true to enforce strict SSRF checks."
      );
    }

    this.apiPath = config.OPENGROK_API_VERSION === "v2" ? "api/v2" : "api/v1";
    this.verifySsl = config.OPENGROK_VERIFY_SSL;
    // Background clients use short Agent-level timeouts so slow/hanging queries fail fast.
    const bgMs = clientOpts.backgroundTimeoutMs;
    const agentOptions = {
      connections: bgMs !== undefined ? 5 : 20,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 300_000,
      ...(bgMs !== undefined ? {
        connectTimeout: bgMs,
        headersTimeout: bgMs,
        bodyTimeout: bgMs * 2,
      } : {}),
    };

    // Apply HTTP/HTTPS proxy if configured. undici does NOT auto-read standard
    // proxy env vars (unlike node-fetch), so we must wire ProxyAgent explicitly.
    // HTTPS_PROXY takes precedence over HTTP_PROXY when both are set.
    // TLS: verification ON trusts bundled + OS-store CAs (enterprise PKI);
    // verification OFF disables it. System bundle is injected explicitly so
    // the fix does not depend on process-wide flags (NODE_USE_SYSTEM_CA),
    // which the VS Code/Electron host may not honor.
    const connectTls = getUndiciConnectTls(this.verifySsl);
    const tlsOverride = connectTls ? { connect: connectTls } : {};
    const requestTlsOverride = connectTls ? { requestTls: connectTls } : {};
    const proxyUrl = config.HTTPS_PROXY || config.HTTP_PROXY;
    if (proxyUrl) {
      /* v8 ignore start -- proxy path; tested in client-extended with proxy config */
      this.agent = new ProxyAgent({
        uri: proxyUrl,
        ...agentOptions,
        ...requestTlsOverride,
      });
      /* v8 ignore stop */
    } else if (this.verifySsl) {
      this.agent = new Agent({ ...agentOptions, ...tlsOverride });
    } else {
      this.agent = new Agent({ ...agentOptions, connect: { rejectUnauthorized: false } });
    }

    if (config.OPENGROK_USERNAME && config.OPENGROK_PASSWORD) {
      const b64 = Buffer.from(
        `${config.OPENGROK_USERNAME}:${config.OPENGROK_PASSWORD}`
      ).toString("base64");
      this.authHeader = `Basic ${b64}`;
    }

    const maxBytes = Math.floor(config.OPENGROK_CACHE_MAX_BYTES / 5); // split budget across 5 caches

    if (config.OPENGROK_CACHE_ENABLED) {
      this.searchCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_SEARCH_TTL * 1000
      );
      this.matchCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_SEARCH_TTL * 1000
      );
      this.fileCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_FILE_TTL * 1000
      );
      this.historyCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_HISTORY_TTL * 1000
      );
      this.projectsCache = new TTLCache(
        1,
        maxBytes,
        config.OPENGROK_CACHE_PROJECTS_TTL * 1000
      );
    }

    if (config.OPENGROK_RATELIMIT_ENABLED && !clientOpts.skipRateLimit) {
      this.rateLimiter = new RateLimiter(config.OPENGROK_RATELIMIT_RPM);
    }
  }

  /** Create a sibling client with rate limiting disabled, for background/fire-and-forget tasks. */
  createBackgroundClient(): OpenGrokClient {
    // Background tasks (buildCallChain, dependency graph) are best-effort.
    // Use a short timeout and no retries so a slow query fails fast.
    return new OpenGrokClient(this.config, { skipRateLimit: true, backgroundTimeoutMs: 8_000 });
  }

  // -------------------------------------------------------------------------
  // Core request method
  // -------------------------------------------------------------------------

  private async request(
    urlOrPath: URL | string,
    timeoutMs: number = TIMEOUTS.default,
    accept: string = "application/json, text/html, */*",
    retries: number = 3
  ): Promise<UndiciResponse> {
    if (this.rateLimiter) await this.rateLimiter.acquire();
    // Background clients use a shorter timeout and no retries (best-effort)
    if (this.clientOpts.backgroundTimeoutMs !== undefined) {
      timeoutMs = this.clientOpts.backgroundTimeoutMs;
      retries = 0;
    }

    const url =
      urlOrPath instanceof URL
        ? urlOrPath
        : /* v8 ignore next -- internal callers always pass URL */ buildSafeUrl(this.baseUrl, urlOrPath);

    const headers: Record<string, string> = {
      "User-Agent": `OpenGrok-MCP/${CLIENT_VERSION}`,
      Accept: accept,
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const fetchOptions: UndiciRequestInit = {
      headers,
      redirect: "manual",
    };

    /* v8 ignore start -- agent is set when VERIFY_SSL=false; tested in client-extended with ssl config */
    if (this.agent) {
      fetchOptions.dispatcher = this.agent;
    }
    /* v8 ignore stop */

    const run = async (): Promise<UndiciResponse> => {
      let currentUrl = url;
      let redirectCount = 0;

      // Fresh deadline per attempt: a shared AbortSignal.timeout() would stay
      // fired after the first timeout and fail all retries instantly.
      const attemptOptions: UndiciRequestInit = {
        ...fetchOptions,
        signal: AbortSignal.timeout(timeoutMs),
      };

      while (true) {
        // NOTE: must use undici's fetch (same package as the Agent below).
        // The Node.js global fetch is backed by an older bundled undici whose
        // dispatcher protocol rejects v8 Agent/ProxyAgent instances with a
        // bare "TypeError: fetch failed".
        const response = await undiciFetch(currentUrl.toString(), attemptOptions);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          /* v8 ignore start -- defensive redirect guards */
          if (redirectCount >= MAX_REDIRECTS) throw new Error("Too many redirects");
          const location = response.headers.get("location");
          if (!location) throw new Error("Redirect with no location header");
          /* v8 ignore stop */

          const parsedLocation = new URL(location, currentUrl);
          // Strip credentials on cross-origin redirect — auth must never leak
          // to another origin (checked before the SSRF guard below).
          if (parsedLocation.origin !== this.baseUrl.origin) {
            const h = { ...(attemptOptions.headers as Record<string, string>) };
            delete h["Authorization"];
            attemptOptions.headers = h;
          }
          if (!isSafeRedirect(parsedLocation, this.baseUrl)) {
            throw new Error(`SSRF guard: redirected URL "${parsedLocation}" escapes allowed host "${this.baseUrl.hostname}"`);
          }

          // Consume the unneeded redirect body to prevent fetch/undici memory leaks
          try { await response.body?.cancel(); } catch { }

          currentUrl = parsedLocation;
          redirectCount++;
          continue;
        }

        /* v8 ignore start -- pRetry handles 429/5xx and 4xx; tested via fetch spy but V8 can't track */
        if (response.status === 429 || response.status >= 500) {
          // Retryable — drain body to free connection
          void response.text().catch(() => {});
          throw new Error(`HTTP ${response.status} – ${response.statusText}`);
        }
        if (!response.ok) {
          // 4xx — drain body to free connection
          void response.text().catch(() => {});
          let msg = `HTTP ${response.status} – ${response.statusText}`;
          if (response.status === 404) {
            msg += `. Path not found: ${currentUrl.pathname}.`;
          }
          // 401: allow one retry — may succeed after transient auth hiccup.
          // onFailedAttempt aborts on the second attempt to prevent credential-loop.
          if (response.status === 401) throw new Error(msg);
          throw new AbortError(msg);
        }
        /* v8 ignore stop */
        this.responseFinalUrls.set(response, currentUrl.toString());
        return response;
      }
    };

    return pRetry(run, {
      retries,
      minTimeout: 1000,
      maxTimeout: 10_000,
      factor: 2,
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
        logger.warn(
          `Request to ${url.pathname} failed (attempt ${attemptNumber}/${retriesLeft + attemptNumber}): ${error.message}`
        );
        // 401 gets one retry. Abort if already retried or no retries left.
        if (error.message.startsWith("HTTP 401") && (attemptNumber >= 2 || retriesLeft === 0)) {
          throw new AbortError(error.message);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  /**
   * Apply maxHitsPerFile as post-processing filter.
   * The REST API may ignore maxhitsperfile, so we enforce it client-side.
   */
  private applyMaxHitsPerFile(results: SearchResults, maxHitsPerFile?: number): void {
    if (!maxHitsPerFile || maxHitsPerFile <= 0) return;
    for (const r of results.results) {
      if (r.matches.length > maxHitsPerFile) {
        r.matches = r.matches.slice(0, maxHitsPerFile);
      }
    }
  }

  async search(
    query: string,
    searchType: SearchTypeValue = "full",
    projects?: string[],
    maxResults: number = this.config.OPENGROK_DEFAULT_MAX_RESULTS,
    start: number = 0,
    fileType?: string,
    sort?: "relevancy" | "lastmodtime" | "fullpath",
    maxHitsPerFile?: number,
    pathFilter?: string,
    cursor?: string
  ): Promise<SearchResults> {
    // Optional opaque cursor (offset codec) overrides start when valid.
    // Strict: only "search"-tagged cursors are honored here — callers return
    // CURSOR_EXPIRED first, and findFile resolves its own cursor to start.
    if (cursor) {
      const state = decodeCursor(cursor);
      if (state && isOffsetCursorFor(state, "search")) {
        start = state.v;
      }
    }
    fileType = validateFileType(fileType);
    // Strip balanced group contents from defs/refs/symbol queries.
    // Removes type qualifiers like "(int)", "[0]", "{n}" but preserves
    // standalone operators (!, ^, NOT) for Lucene interpretation.
    if ((searchType === "defs" || searchType === "refs" || (searchType as string) === "symbol") && /[()[\]{}]/.test(query)) {
      query = query
        .replace(/\([^)]*\)/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/[()[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    const sortedProjects = projects ? [...projects].sort() : undefined;
    // Use deterministic join instead of JSON.stringify to avoid object-key ordering differences
    const cacheKey = `${searchType}:${query}:${sortedProjects ? sortedProjects.join(",") : ""}:${maxResults}:${start}:${fileType ?? ""}:${sort ?? ""}:${maxHitsPerFile ?? ""}:${pathFilter ?? ""}`;
    const cached = this.searchCache?.get(cacheKey);
    if (cached) return cached;

    // For defs/refs/symbol, OpenGrok 1.7.x REST API returns 400 — fall back to web
    // search HTML parsing which supports all search fields.
    if (searchType === "defs" || searchType === "refs" || (searchType as string) === "symbol") {
      // Try REST API first (supported on newer OpenGrok deployments)
      try {
        const restUrl = buildSafeUrl(this.baseUrl, `${this.apiPath}/search`);
        restUrl.searchParams.set(searchType, query);
        restUrl.searchParams.set("maxresults", String(maxResults));
        if (sortedProjects?.length) restUrl.searchParams.set("projects", sortedProjects.join(","));
        if (start > 0) restUrl.searchParams.set("start", String(start));
        if (fileType) restUrl.searchParams.set("type", fileType);
        if (sort && sort !== "relevancy") restUrl.searchParams.set("sort", sort);
        if (maxHitsPerFile) restUrl.searchParams.set("maxhitsperfile", String(maxHitsPerFile));
        if (pathFilter) restUrl.searchParams.set("path", pathFilter);
        const response = await this.request(restUrl, TIMEOUTS.search, "application/json");
        const data = (await response.json()) as Record<string, unknown>;
        const results = parseSearchResponse(data, searchType, query);
        // REST API for defs/refs/symbol is unreliable on some versions —
        // it returns 200 with empty results while the web UI finds matches.
        // Also detect garbage results: high totalCount but all matches
        // have lineNumber=0 and lineContent "...".
        if (results.totalCount > 0) {
          const hasRealMatches = results.results.some((r) =>
            r.matches.some((m) => m.lineNumber > 0 || (m.lineContent !== "..." && m.lineContent !== ""))
          );
          if (hasRealMatches) {
            // Extension post-filter for refs: web/REST may ignore type server-side.
            if (searchType === "refs" && fileType) {
              results.results = results.results.filter((r) => matchesFileType(r.path, fileType as string));
            }
            this.applyMaxHitsPerFile(results, maxHitsPerFile);
            this.searchCache?.set(cacheKey, results, estimateBytes(results));
            return results;
          }
        }
        throw new AbortError("REST API returned empty for defs/refs/symbol — trying web UI");
      } catch (err) {
        // Re-throw transient errors (network failures, 5xx) so the caller can act on them.
        // Only fall through to the web UI for 4xx responses, which signal that the REST
        // API endpoint doesn't exist on this instance (e.g. 400/404/405).
        // Exception: 429 means throttled, not unsupported — falling through would
        // fire a second request at an already-throttled server.
        if (err instanceof Error) {
          const msg = err.message;
          const isNotSupported = !msg.includes("HTTP 429") && (err.name === "AbortError" ||
            err instanceof SyntaxError ||
            (msg.includes("HTTP 4") && !msg.includes("HTTP 5")));
          if (!isNotSupported) {
            throw err;
          }
        }
        // Not supported or unknown error shape — fall through to web UI
      }
      // Web UI fallback — errors propagate to the caller so the LLM can act on them
      // (e.g. "You must select a project" → LLM adds projects: ['name'] to the call)
      const results = await this.searchWeb(query, searchType, projects, maxResults, start, fileType, sort, pathFilter);
      // Enrich placeholder matches with real line content.
      await this.enrichPlaceholderMatches(results);
      if (searchType === "refs" && fileType) {
        results.results = results.results.filter((r) => matchesFileType(r.path, fileType as string));
      }
      this.applyMaxHitsPerFile(results, maxHitsPerFile);
      this.searchCache?.set(cacheKey, results, estimateBytes(results));
      return results;
    }

    // REST API ignores sort parameter; use web UI when sort is specified.
    if (sort && sort !== "relevancy") {
      const results = await this.searchWeb(query, searchType, projects, maxResults, start, fileType, sort, pathFilter);
      this.applyMaxHitsPerFile(results, maxHitsPerFile);
      this.searchCache?.set(cacheKey, results, estimateBytes(results));
      return results;
    }

    const buildFullTextUrl = (searchQuery: string): URL => {
      const u = buildSafeUrl(this.baseUrl, `${this.apiPath}/search`);
      // When searchType is 'path', both query and pathFilter target the same REST 'path' field.
      if (searchType === "path" && pathFilter) {
        u.searchParams.set("path", `${pathFilter} ${searchQuery}`);
      } else {
        u.searchParams.set(searchType, searchQuery);
        if (pathFilter) u.searchParams.set("path", pathFilter);
      }
      u.searchParams.set("maxresults", String(maxResults));
      if (sortedProjects?.length) u.searchParams.set("projects", sortedProjects.join(","));
      if (start > 0) u.searchParams.set("start", String(start));
      if (fileType) u.searchParams.set("type", fileType);
      if (sort && sort !== "relevancy") u.searchParams.set("sort", sort);
      if (maxHitsPerFile) u.searchParams.set("maxhitsperfile", String(maxHitsPerFile));
      return u;
    };

    try {
      const response = await this.request(buildFullTextUrl(query), TIMEOUTS.search, "application/json");
      const data = (await response.json()) as Record<string, unknown>;
      const results = parseSearchResponse(data, searchType, query);
      this.applyMaxHitsPerFile(results, maxHitsPerFile);
      this.searchCache?.set(cacheKey, results, estimateBytes(results));
      return results;
    } catch (err) {
      const is400 = err instanceof Error && err.message.includes("HTTP 400");
      if (!is400) throw err;

      // If full-text query has Lucene metacharacters and server returns 400
      // (parse error), retry with those characters escaped. If the escaped
      // retry also 400s, fall through to the phrase-quote retry below before
      // giving up (a query can carry both metacharacters and a -- prefix).
      const hasMetachars = /[()[\]{}!^~]/.test(query);
      if (hasMetachars) {
        try {
          const escaped = query.replace(/([()[\]{}!^~])/g, "\\$1");
          const response = await this.request(buildFullTextUrl(escaped), TIMEOUTS.search, "application/json");
          const data = (await response.json()) as Record<string, unknown>;
          const results = parseSearchResponse(data, searchType, query);
          this.applyMaxHitsPerFile(results, maxHitsPerFile);
          this.searchCache?.set(cacheKey, results, estimateBytes(results));
          return results;
        } catch (retryErr) {
          const retryIs400 = retryErr instanceof Error && retryErr.message.includes("HTTP 400");
          if (!retryIs400) throw retryErr;
          // Fall through to the phrase-quote retry below.
        }
      }

      // Queries with leading dashes (e.g. "--partial") trigger HTTP 400
      // because Lucene treats -- as a boolean operator construct.
      // Retry by quoting the query as a phrase.
      const hasDashPrefix = /(?:^|\s)--/.test(query);
      if (hasDashPrefix && !query.startsWith('"')) {
        const quoted = `"${query}"`;
        const response = await this.request(buildFullTextUrl(quoted), TIMEOUTS.search, "application/json");
        const data = (await response.json()) as Record<string, unknown>;
        const results = parseSearchResponse(data, searchType, query);
        this.applyMaxHitsPerFile(results, maxHitsPerFile);
        this.searchCache?.set(cacheKey, results, estimateBytes(results));
        return results;
      }

      throw err;
    }
  }

  /**
   * Replace placeholder match content ("[defs match at line N]") with
   * actual source line content by fetching from the file.
   */
  private async enrichPlaceholderMatches(results: SearchResults): Promise<void> {
    const PLACEHOLDER_RE = /^\[(defs|refs|symbol|full) match(?: at line \d+)?]$/;
    const toEnrich: Array<{ result: SearchResults["results"][number]; matches: Array<{ idx: number; lineNumber: number }> }> = [];
    for (const result of results.results) {
      const placeholders: Array<{ idx: number; lineNumber: number }> = [];
      for (let i = 0; i < result.matches.length; i++) {
        const m = result.matches[i];
        if (PLACEHOLDER_RE.test(m.lineContent) && m.lineNumber > 0) {
          placeholders.push({ idx: i, lineNumber: m.lineNumber });
        }
      }
      if (placeholders.length > 0) {
        toEnrich.push({ result, matches: placeholders });
      }
    }
    if (toEnrich.length === 0) return;

    // Fetch line content for each file (capped to avoid excessive requests)
    const MAX_ENRICHMENT_FILES = 5;
    for (const { result, matches } of toEnrich.slice(0, MAX_ENRICHMENT_FILES)) {
      try {
        const minLine = Math.min(...matches.map((m) => m.lineNumber));
        const maxLine = Math.max(...matches.map((m) => m.lineNumber));
        const fileContent = await this.getFileContent(result.project, result.path, minLine, maxLine);
        const lines = fileContent.content.split("\n");
        const baseOffset = minLine;
        for (const { idx, lineNumber } of matches) {
          const lineIdx = lineNumber - baseOffset;
          if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].trim()) {
            result.matches[idx].lineContent = lines[lineIdx];
          }
        }
      } catch {
        // Best effort — leave placeholder if fetch fails
      }
    }
  }

  /**
   * Fall back to the web search UI endpoint (/search?defs=X) when the REST
   * API does not support a particular search field (e.g., defs/refs on
   * OpenGrok 1.7.x). Parses the HTML response to extract results.
   */
  private async searchWeb(
    query: string,
    searchType: SearchTypeValue,
    projects?: string[],
    maxResults: number = 25,
    start = 0,
    fileType?: string,
    sort?: "relevancy" | "lastmodtime" | "fullpath",
    pathFilter?: string
  ): Promise<SearchResults> {
    // Web UI requires at least one project — use explicit list, or fall back to
    // OPENGROK_DEFAULT_PROJECT, or throw so the LLM knows to add projects:[].
    const effectiveProjects = projects?.length
      ? projects
      : this.config.OPENGROK_DEFAULT_PROJECT
        ? [this.config.OPENGROK_DEFAULT_PROJECT]
        : [];
    if (!effectiveProjects.length) {
      throw new Error(
        `${searchType} search requires a project — the web search UI will not accept a query without one. ` +
        `Pass projects: ['<projectname>'] in your search call, or configure OPENGROK_DEFAULT_PROJECT.`
      );
    }

    const url = buildSafeUrl(this.baseUrl, "search");
    // The web UI has no "symbol" parameter — symbol maps to "refs".
    const webField = (searchType as string) === "symbol" ? "refs" : searchType;
    // When searchType is 'path', both query and pathFilter target the same 'path' field.
    if (webField === "path" && pathFilter) {
      url.searchParams.set("path", `${pathFilter} ${query}`);
    } else {
      url.searchParams.set(webField, query);
      if (pathFilter) {
        url.searchParams.set("path", pathFilter);
      }
    }
    url.searchParams.set("n", String(maxResults));
    for (const p of effectiveProjects) {
      url.searchParams.append("project", p);
    }
    if (start > 0) {
      url.searchParams.set("start", String(start));
    }
    if (fileType) {
      url.searchParams.set("type", fileType);
    }
    if (sort && sort !== "relevancy") {
      url.searchParams.set("sort", sort);
    }

    // retries=0: web UI 500s are permanent on broken deployments — fail fast
    const response = await this.request(url, TIMEOUTS.search, "text/html, */*", 0);
    const finalUrl = this.responseFinalUrls.get(response);
    const html = await safeResponseText(response);

    // Single-result searches redirect to the xref page instead of showing results.
    const singleResult = parseSingleResultRedirect(html, searchType, query, finalUrl);
    if (singleResult) return singleResult;

    return parseWebSearchResults(html, searchType, query);
  }

  async searchPattern(opts: {
    pattern: string;
    projects?: string[];
    fileType?: string;
    maxResults?: number;
    cursor?: string;
  }): Promise<SearchResults> {
    const { pattern, projects, maxResults = 20, cursor } = opts;
    // Cursor is accepted for API consistency; an offset cursor sets the start index.
    let start = 0;
    if (cursor) {
      const state = decodeCursor(cursor);
      if (state && isOffsetCursorFor(state, "search")) start = state.v;
    }
    const fileType = validateFileType(opts.fileType);
    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/search`);
    url.searchParams.set("full", pattern);
    url.searchParams.set("regexp", "true");
    url.searchParams.set("maxresults", String(maxResults));
    if (start > 0) url.searchParams.set("start", String(start));
    if (projects?.length) {
      url.searchParams.set("projects", [...projects].sort().join(","));
    }
    if (fileType) {
      url.searchParams.set("type", fileType);
    }

    const response = await this.request(url, TIMEOUTS.search, "application/json");
    const data = (await response.json()) as Record<string, unknown>;
    return parseSearchResponse(data, "full", pattern);
  }

  async suggest(
    queryOrOpts: string | {
      query: string;
      field?: "full" | "defs" | "refs" | "path" | "hist";
      projects?: string[];
      context?: { full?: string; defs?: string; refs?: string; path?: string; hist?: string };
    },
    project?: string,
    field: string = "full"
  ): Promise<{ suggestions: SuggestItem[] | string[]; time: number; partialResult: boolean; queryText?: string; identifier?: string }> {
    // Backward-compat: suggest(query, project?, field?) plus new suggest({query, field, projects, context})
    let query: string;
    let resolvedField = field;
    let projects: string[] = [];
    let context: Record<string, string> = {};
    if (typeof queryOrOpts === "string") {
      query = queryOrOpts;
      if (project) projects = [project];
    } else {
      query = queryOrOpts.query;
      resolvedField = queryOrOpts.field ?? "full";
      projects = queryOrOpts.projects ?? (project ? [project] : []);
      context = (queryOrOpts.context ?? {}) as Record<string, string>;
    }
    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/suggest`);

    // Send all form fields simultaneously — the server uses all field values
    // for context-aware ranking. The active field gets the typed query.
    const formFields = ["full", "defs", "refs", "path", "hist"] as const;
    for (const f of formFields) {
      url.searchParams.set(f, f === resolvedField ? query : (context[f] ?? ""));
    }
    url.searchParams.set("field", resolvedField);
    url.searchParams.set("caret", String(query.length));

    // jQuery serializes JS arrays as `projects[]=value` (bracket notation).
    for (const p of projects) {
      url.searchParams.append("projects[]", p);
    }
    // Backward-compat single-project form for older servers/tests.
    if (projects.length === 1 && !url.searchParams.has("projects")) {
      url.searchParams.set("projects", projects[0]);
    }

    const response = await this.request(url, TIMEOUTS.suggest, "application/json");
    const data = (await response.json()) as Record<string, unknown>;

    // Response shape may be string[] (older) or {phrase, projects, score}[] (newer).
    const rawSuggestions = (data["suggestions"] as Array<unknown>) ?? [];
    let suggestions: SuggestItem[] | string[];
    if (rawSuggestions.length > 0 && typeof rawSuggestions[0] === "object" && rawSuggestions[0] !== null && "phrase" in (rawSuggestions[0] as object)) {
      suggestions = (rawSuggestions as Array<{ phrase: string; projects: string[]; score: number }>)
        .filter((s) => typeof s === "object" && s !== null && "phrase" in s)
        .map((s) => ({
          phrase: String(s.phrase),
          projects: Array.isArray(s.projects) ? (s.projects as string[]) : [],
          score: typeof s.score === "number" ? s.score : 0,
        }));
    } else {
      suggestions = (rawSuggestions as string[]).map(String);
    }

    return {
      suggestions,
      time: (data["time"] as number) ?? 0,
      partialResult: (data["partialResult"] as boolean) ?? false,
      queryText: data["queryText"] as string | undefined,
      identifier: data["identifier"] as string | undefined,
    };
  }

  async getFileContent(
    project: string,
    path: string,
    startLine?: number,
    endLine?: number
  ): Promise<FileContent> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const cacheKey = `${project}:${normalizedPath}`;

    let fullContent: string;
    const cachedContent = this.fileCache?.get(cacheKey);
    if (cachedContent !== undefined) {
      fullContent = cachedContent;
    } else {
      const url = buildSafeUrl(
        this.baseUrl,
        `raw/${encodeURIComponent(project)}/${normalizedPath}`
      );
      const response = await this.request(url, TIMEOUTS.file, "text/plain, */*");
      fullContent = await safeResponseText(response);
      this.fileCache?.set(cacheKey, fullContent, Buffer.byteLength(fullContent, "utf8"));
    }

    const { text: content, totalLines } = extractLineRange(fullContent, startLine, endLine);

    return {
      project,
      path: normalizedPath,
      content,
      lineCount: totalLines,
      sizeBytes: Buffer.byteLength(fullContent, "utf8"),
      startLine,
    };
  }

  async getFileHistory(
    project: string,
    path: string,
    maxEntries: number = 10,
    start: number = 0,
    cursor?: string
  ): Promise<FileHistory> {
    // Optional opaque cursor (offset codec) overrides start when valid.
    if (cursor) {
      const state = decodeCursor(cursor);
      if (state && isOffsetCursorFor(state, "history")) start = state.v;
    }
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    // Cache key includes start (pagination offset). maxEntries is applied
    // client-side (sliced below), so the same cached page can serve different
    // maxEntries values without separate cache entries.
    const cacheKey = `history:${project}:${normalizedPath}:${start}`;

    let history = this.historyCache?.get(cacheKey);
    if (!history) {
      const url = buildSafeUrl(
        this.baseUrl,
        `history/${encodeURIComponent(project)}/${normalizedPath}`
      );
      if (start > 0) url.searchParams.set("start", String(start));
      const response = await this.request(url, TIMEOUTS.default, "text/html, */*");
      const html = await safeResponseText(response);
      history = parseFileHistory(html, project, normalizedPath);
      this.historyCache?.set(cacheKey, history, estimateBytes(history));
    }

    if (history.entries.length > maxEntries) {
      return {
        ...history,
        entries: history.entries.slice(0, maxEntries),
      };
    }
    return history;
  }

  async getAnnotate(project: string, path: string, opts?: { revision?: string }): Promise<AnnotatedFile> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const cacheKey = `annotate:${project}:${normalizedPath}${opts?.revision ? `:${opts.revision}` : ""}`;

    /* v8 ignore next -- cache hit path */
    const cachedJson = this.fileCache?.get(cacheKey);
    if (cachedJson !== undefined) {
      return JSON.parse(cachedJson) as AnnotatedFile;
    }

    // If revision is requested, skip directly to xref path which supports r=
    // Use cached endpoint style if known, otherwise probe
    /* v8 ignore start */
    if (!opts?.revision && this.annotateEndpoint !== 'xref') {
    /* v8 ignore stop */
      try {
        const annotateUrl = buildSafeUrl(
          this.baseUrl,
          `annotate/${encodeURIComponent(project)}/${normalizedPath}`
        );
        const response = await this.request(annotateUrl, TIMEOUTS.file, "text/html, */*");
        const html = await safeResponseText(response);
        this.annotateEndpoint = 'annotate';
        const result = parseAnnotate(html, project, normalizedPath);
        /* v8 ignore next -- cache set */
        this.fileCache?.set(cacheKey, JSON.stringify(result), estimateBytes(result));
        return result;
      } catch {
        /* v8 ignore start -- tested via fetch spy in client-internals; V8 coverage merge issue */
        if (this.annotateEndpoint === 'annotate') {
          // Cached style failed — reset and try fallback
          this.annotateEndpoint = null;
        }
        /* v8 ignore stop */
      }
    }

    /* v8 ignore start -- xref annotate fallback; tested in client-extended but V8 can't track through spy */
    const xrefUrl = buildSafeUrl(
      this.baseUrl,
      `xref/${encodeURIComponent(project)}/${normalizedPath}`
    );
    xrefUrl.searchParams.set("a", "true");
    if (opts?.revision) xrefUrl.searchParams.set("r", opts.revision);
    const response = await this.request(xrefUrl, TIMEOUTS.file, "text/html, */*");
    const html = await safeResponseText(response);
    this.annotateEndpoint = 'xref';
    const result = parseAnnotate(html, project, normalizedPath);
    this.fileCache?.set(cacheKey, JSON.stringify(result), estimateBytes(result));
    return result;
    /* v8 ignore stop */
  }

  async getFileSymbols(project: string, path: string, opts?: { cursor?: string; limit?: number }): Promise<FileSymbols> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    // Optional opaque cursor (offset codec) paginates the symbol list client-side.
    let symbolOffset = 0;
    if (opts?.cursor) {
      const state = decodeCursor(opts.cursor);
      if (state && isOffsetCursorFor(state, "symbols")) symbolOffset = state.v;
    }
    const symbolLimit = opts?.limit;
    const applySlice = (r: FileSymbols): FileSymbols => {
      if (!symbolOffset && symbolLimit === undefined) return r;
      const end = symbolLimit === undefined ? undefined : symbolOffset + symbolLimit;
      return { ...r, symbols: r.symbols.slice(symbolOffset, end) };
    };
    const cacheKey = `defs:${project}:${normalizedPath}`;
    const cached = this.fileCache?.get(cacheKey);
    /* v8 ignore start -- cache hit path; tested but V8 doesn't track due to mock layer */
    if (cached !== undefined) {
      return applySlice(JSON.parse(cached) as FileSymbols);
    }
    /* v8 ignore stop */
    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/file/defs`);
    url.searchParams.set("path", "/" + normalizedPath);
    try {
      const response = await this.request(url, TIMEOUTS.file, "application/json");
      const data = (await response.json()) as FileSymbol[];
      const result: FileSymbols = {
        project,
        path: normalizedPath,
        symbols: /* v8 ignore next -- defense-in-depth: API always returns array */ Array.isArray(data) ? data : [],
      };
      const json = JSON.stringify(result);
      /* v8 ignore next -- cache set; tested but V8 doesn't track */
      this.fileCache?.set(cacheKey, json, Buffer.byteLength(json, "utf8"));
      return applySlice(result);
    } catch {
      // /api/v1/file/defs may not exist or may return 401 — fall back to
      // parsing intelliWindow-symbol links from the xref HTML page.
      /* v8 ignore start -- tested in client-extended (xref fallback + double failure); V8 can't track through pRetry spy */
      try {
        const xrefUrl = buildSafeUrl(
          this.baseUrl,
          `xref/${encodeURIComponent(project)}/${normalizedPath}`
        );
        const response = await this.request(xrefUrl, TIMEOUTS.file, "text/html, */*");
        const html = await safeResponseText(response);
        const symbols = parseFileSymbols(html);
        const result: FileSymbols = { project, path: normalizedPath, symbols };
        const json = JSON.stringify(result);
        this.fileCache?.set(cacheKey, json, Buffer.byteLength(json, "utf8"));
        return applySlice(result);
      } catch {
        return { project, path: normalizedPath, symbols: [] };
      }
      /* v8 ignore stop */
    }
  }

  async browseDirectory(
    project: string,
    path: string = "",
    opts?: { cursor?: string; limit?: number }
  ): Promise<DirectoryEntry[]> {
    if (path) assertSafePath(path);
    const cleanPath = path.replace(/^\/+|\/+$/g, "");
    const pathSegment = cleanPath ? `${cleanPath}/` : "";
    const url = buildSafeUrl(
      this.baseUrl,
      `xref/${encodeURIComponent(project)}/${pathSegment}`
    );
    const response = await this.request(url, TIMEOUTS.default, "text/html, */*");
    const html = await safeResponseText(response);
    const entries = parseDirectoryListing(html, project, cleanPath);
    // Optional opaque cursor (offset codec) paginates entries client-side.
    if (opts?.cursor || opts?.limit !== undefined) {
      let offset = 0;
      if (opts?.cursor) {
        const state = decodeCursor(opts.cursor);
        if (state && isOffsetCursorFor(state, "browse")) offset = state.v;
      }
      const end = opts?.limit === undefined ? undefined : offset + opts.limit;
      return entries.slice(offset, end);
    }
    return entries;
  }

  async listProjects(filterPattern?: string): Promise<Project[]> {
    const cacheKey = "projects";
    let projects = this.projectsCache?.get(cacheKey);

    if (!projects) {
      const url = buildSafeUrl(this.baseUrl, "");
      const response = await this.request(url, TIMEOUTS.default, "text/html, */*");
      const html = await safeResponseText(response);
      projects = parseProjectsPage(html);
      this.projectsCache?.set(cacheKey, projects, estimateBytes(projects));
    }

    if (filterPattern) {
      if (filterPattern.length > MAX_FILTER_LENGTH) {
        throw new Error(`Filter pattern too long (max ${MAX_FILTER_LENGTH} characters)`);
      }
      // Auto-append * for substring matching if no glob wildcards present
      const glob = /[*?]/.test(filterPattern) ? filterPattern : `*${filterPattern}*`;
      return projects.filter((p) => minimatch(p.name, glob, { nocase: true }));
    }
    return projects;
  }

  async testConnection(): Promise<boolean> {
    // Use a single direct fetch (no pRetry) so 429/5xx don't trigger retry backoff.
    // Any HTTP response means the server is reachable; only network/SSL/timeout
    // errors mean we can't connect. 5xx responses indicate the service is unhealthy.
    try {
      const url = buildSafeUrl(this.baseUrl, "");
      const fetchOptions: UndiciRequestInit = {
        headers: { "User-Agent": `OpenGrok-MCP/${CLIENT_VERSION}` },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUTS.default),
      };
      /* v8 ignore next -- agent set when VERIFY_SSL=false; tested in client-extended */
      if (this.agent) fetchOptions.dispatcher = this.agent;
      // NOTE: undici fetch — see request() for why the global fetch can't be used.
      const response = await undiciFetch(url.toString(), fetchOptions);
      void response.text().catch(() => {}); // consume body to avoid undici leaks
      // 5xx means the service is down — not healthy
      if (response.status >= 500) return false;
      // 2xx / 3xx / 4xx (including 401, 403, 429) — server IS reachable
      return true;
    } catch {
      // Network errors, SSL failures, DNS failures, timeouts
      return false;
    }
  }

  /**
   * Get call graph for a symbol (API v2 only, with v1 fallback).
   * v2 endpoint: GET /api/v2/symbol/{symbol}/callgraph?project={project}
   * v1 fallback: search for refs to construct a basic dependency view
   */
  async getCallGraph(
    project: string,
    symbol: string
  ): Promise<SearchResults> {
    if (!project.trim()) throw new Error("project must not be empty");
    if (!symbol.trim()) throw new Error("symbol must not be empty");

    // If v2 API is configured, try the dedicated endpoint
    if (this.config.OPENGROK_API_VERSION === "v2") {
      try {
        const url = buildSafeUrl(
          this.baseUrl,
          this.apiPath,
          "symbol",
          encodeURIComponent(symbol),
          "callgraph"
        );
        url.searchParams.set("project", project);
        const response = await this.request(url, TIMEOUTS.search, "application/json");
        const data = (await response.json()) as Record<string, unknown>;
        // Only use the v2 response if it matches the expected search-results shape.
        // A call-graph response has a different structure and would parse as empty results
        // without throwing, blocking the v1 fallback.
        if (data && typeof data === "object" && "results" in data) {
          return parseSearchResponse(data, "refs", symbol);
        }
        // Response format doesn't match — fall through to v1
      } catch {
        // Fall through to v1 fallback on any error
      }
    }

    // Fallback: search for symbol refs (v1 compatible)
    return this.search(symbol, "refs", [project]);
  }

  /**
   * Fire-and-forget cache pre-warming. Called after successful health check.
   * Warms up the TTL cache with project list + one minimal defs search.
   * Best-effort only; errors are silently ignored.
   */
  warmCache(): void {
    void this.listProjects().catch(() => undefined);
    void this.search("main", "defs", undefined, 1).catch(() => undefined);
  }

  async getFileDiff(
    project: string,
    path: string,
    rev1: string,
    rev2: string,
    opts?: { cursor?: string; limit?: number }
  ): Promise<FileDiff> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const url = buildSafeUrl(this.baseUrl, `diff/${encodeURIComponent(project)}/${normalizedPath}`);
    // r1/r2 use the OpenGrok convention: /{project}/{path}@{revision}
    url.searchParams.set("r1", `/${project}/${normalizedPath}@${rev1}`);
    url.searchParams.set("r2", `/${project}/${normalizedPath}@${rev2}`);
    // format=u returns unified diff as HTML with context lines
    url.searchParams.set("format", "u");
    const response = await this.request(url, TIMEOUTS.file, "text/html, */*");
    const html = await safeResponseText(response);
    const result = parseFileDiff(html, project, normalizedPath, rev1, rev2);
    // Optional opaque cursor (offset codec) paginates hunks client-side.
    if (opts?.cursor || opts?.limit !== undefined) {
      let offset = 0;
      if (opts?.cursor) {
        const state = decodeCursor(opts.cursor);
        if (state && isOffsetCursorFor(state, "diff")) offset = state.v;
      }
      const end = opts?.limit === undefined ? undefined : offset + opts.limit;
      return { ...result, hunks: result.hunks.slice(offset, end) };
    }
    return result;
  }

  getBaseUrl(): string {
    const safe = new URL(this.baseUrl.toString());
    safe.username = "";
    safe.password = "";
    return safe.toString();
  }

  // Get server version from generator meta tag
  async getServerVersion(): Promise<string | null> {
    try {
      const url = buildSafeUrl(this.baseUrl, "");
      const resp = await this.request(url, TIMEOUTS.default, "text/html, */*", 0);
      const html = await safeResponseText(resp);
      return html.match(/<meta\s+name="generator"\s+content="\{?([^"}\n]+?)(?:\})?"/i)?.[1]?.trim() ?? null;
    } catch { return null; }
  }

  // Get suggest configuration from server
  async getSuggestConfig(): Promise<SuggestConfig | null> {
    try {
      const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/suggest/config`);
      const resp = await this.request(url, TIMEOUTS.default, "application/json", 0);
      return (await resp.json()) as SuggestConfig;
    } catch { return null; }
  }

  // Get all matches for a query in a specific file
  async getAllMatchesInFile(
    project: string,
    path: string,
    query: string,
    searchType: SearchTypeValue = "full",
    maxResults?: number
  ): Promise<Array<{ lineNumber: number; lineContent: string }>> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const cacheKey = `more:${project}:${normalizedPath}:${searchType}:${query}`;
    const cached = this.matchCache?.get(cacheKey);
    if (cached) {
      return maxResults ? cached.slice(0, maxResults) : cached;
    }
    const url = buildSafeUrl(this.baseUrl, `more/${project}/${normalizedPath}`);
    url.searchParams.set(searchType, query);
    const resp = await this.request(url, TIMEOUTS.search, "text/html, */*", 0);
    const result = parseMoreResults(await safeResponseText(resp));
    this.matchCache?.set(cacheKey, result, estimateBytes(result));
    return maxResults ? result.slice(0, maxResults) : result;
  }

  // Get file history with changed file lists via RSS feed
  async getFileHistoryWithFiles(
    project: string,
    path: string,
    opts?: { maxEntries?: number }
  ): Promise<{ entries: RssHistoryEntry[] }> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const url = buildSafeUrl(this.baseUrl, `rss/${project}/${normalizedPath}`);
    const resp = await this.request(url, TIMEOUTS.search, "application/rss+xml, text/xml, */*", 0);
    const all = parseHistoryRss(await safeResponseText(resp));
    return { entries: opts?.maxEntries ? all.slice(0, opts.maxEntries) : all };
  }

  // Get download URL (synchronous, no HTTP)
  getDownloadUrl(project: string, path: string): string {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    return buildSafeUrl(this.baseUrl, `download/${project}/${normalizedPath}`).toString();
  }

  // Get project groups
  async getProjectGroups(): Promise<Array<{ name: string; projects: string[] }>> {
    try {
      const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/groups`);
      const resp = await this.request(url, TIMEOUTS.default, "application/json", 0);
      return (await resp.json()) as Array<{ name: string; projects: string[] }>;
    } catch { return []; }
  }

  // Get popular suggestions for a project/field
  async getSuggestPopularity(opts: { project: string; field?: string; pageSize?: number }): Promise<string[]> {
    try {
      const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/suggest/popularity/paged`);
      url.searchParams.set("project", opts.project);
      url.searchParams.set("field", opts.field ?? "full");
      url.searchParams.set("pageSize", String(opts.pageSize ?? 20));
      url.searchParams.set("page", "0");
      const resp = await this.request(url, TIMEOUTS.default, "application/json", 0);
      const data = (await resp.json()) as { suggestions?: Array<{ phrase: string }> };
      return data.suggestions?.map(s => s.phrase) ?? [];
    } catch { return []; }
  }

  // Get repositories for a project
  async getProjectRepositories(project: string): Promise<Array<{ url: string; type: string }>> {
    try {
      const url = buildSafeUrl(
        this.baseUrl,
        `${this.apiPath}/projects/${project}/repositories`
      );
      const resp = await this.request(url, TIMEOUTS.default, "application/json", 0);
      return (await resp.json()) as Array<{ url: string; type: string }>;
    } catch { return []; }
  }

  async close(): Promise<void> {
    // Close shared agent and clear caches on shutdown
    try {
      await this.agent?.close();
    } finally {
      this.searchCache?.clear();
      this.matchCache?.clear();
      this.fileCache?.clear();
      this.historyCache?.clear();
      this.projectsCache?.clear();
    }
  }
}

// Exported for testing only (preserves previous client.ts surface)
export { RateLimiter as _RateLimiter };
export { TTLCache as _TTLCache } from "./cache.js";
export { estimateBytes as _estimateBytes } from "./cache.js";
export { sleep as _sleep, TIMEOUTS as _TIMEOUTS } from "./text-utils.js";
