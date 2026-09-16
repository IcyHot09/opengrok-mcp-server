import * as fs from 'fs';
import * as tls from 'tls';

/**
 * System CA trust helpers — shared by the MCP server (undici) and the
 * VS Code extension host (node:https).
 *
 * Node.js trusts only Mozilla's bundled CAs by default and ignores the OS
 * certificate store, so enterprise CAs (internal PKI, TLS-inspecting proxies)
 * fail verification. The fix keeps verification ON and adds the OS store to
 * the trust anchors instead of disabling verification.
 *
 * Two mechanisms, belt and suspenders:
 * 1. `NODE_USE_SYSTEM_CA=1` in spawned-server env (covers stock Node child
 *    processes on Windows/macOS/Linux; additive trust only, never disables
 *    verification). Set via applySystemCaToEnv().
 * 2. Explicit `ca` bundle (bundled defaults + system store + extras, see
 *    below) passed to undici Agent connect options and node:https request
 *    options. Required for the extension host (Electron, already running
 *    without the env var) and for HTTP clients that don't honor the
 *    process-wide flag.
 * 3. `NODE_EXTRA_CA_CERTS` file contents are folded into the bundle, mirroring
 *    Node semantics, so operators can add a private CA without code changes.
 *    No certificates are embedded in this repo.
 *
 * NOTE: passing `ca` REPLACES the default trust store, so always pass the
 * combined bundle from getTrustedCaBundle(), never a subset alone.
 */

export const SYSTEM_CA_ENV_VAR = 'NODE_USE_SYSTEM_CA';
export const EXTRA_CA_CERTS_ENV_VAR = 'NODE_EXTRA_CA_CERTS';

type GetCaCerts = (kind?: string) => string[];

function getCaCertsFn(): GetCaCerts | undefined {
    try {
        const fn = (tls as unknown as { getCACertificates?: unknown }).getCACertificates;
        return typeof fn === 'function' ? (fn as GetCaCerts) : undefined;
    } catch {
        return undefined;
    }
}

/** Split PEM text into individual CERTIFICATE blocks. */
export function splitPemCerts(pemText: string): string[] {
    const blocks = pemText.match(/-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g);
    return (blocks ?? []).map((b) => b.trim()).filter(Boolean);
}

/**
 * Read extra CA certificates from a PEM file (the NODE_EXTRA_CA_CERTS
 * contract). Never throws — unreadable/missing/garbage files yield [] and
 * the resulting TLS error surfaces at connection time instead.
 */
export function readExtraCaCertsFile(filePath: string): string[] {
    try {
        if (!filePath) return [];
        return splitPemCerts(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return [];
    }
}

let cachedBundle: string[] | undefined | null = null;

/** Reset the memoized bundle. Exported for tests only. */
export function resetTlsCaCache(): void {
    cachedBundle = null;
}

/**
 * Combined (bundled defaults + OS store + NODE_EXTRA_CA_CERTS) CA bundle,
 * or undefined when even the defaults are unavailable so callers fall back
 * to plain Node defaults unchanged. Result is memoized — the inputs do not
 * change during process lifetime and OS store reads are expensive.
 */
export function getTrustedCaBundle(): string[] | undefined {
    if (cachedBundle !== null) return cachedBundle;

    const getCaCerts = getCaCertsFn();

    let defaults: string[] = [];
    try {
        const certs = getCaCerts?.('default');
        if (Array.isArray(certs) && certs.length > 0) defaults = certs;
    } catch {
        defaults = [];
    }
    if (defaults.length === 0) {
        try {
            defaults = [...tls.rootCertificates];
        } catch {
            defaults = [];
        }
    }
    if (defaults.length === 0) {
        cachedBundle = undefined;
        return cachedBundle;
    }

    let system: string[] = [];
    try {
        const certs = getCaCerts?.('system');
        if (Array.isArray(certs)) system = certs;
    } catch {
        system = [];
    }

    const extraPath = process.env[EXTRA_CA_CERTS_ENV_VAR]?.trim() ?? '';
    const extra = readExtraCaCertsFile(extraPath);

    const seen = new Set<string>();
    const combined: string[] = [];
    for (const cert of [...defaults, ...system, ...extra]) {
        if (typeof cert === 'string' && cert && !seen.has(cert)) {
            seen.add(cert);
            combined.push(cert);
        }
    }

    cachedBundle = combined.length > 0 ? combined : undefined;
    return cachedBundle;
}

/**
 * TLS overrides for an undici Agent. Spread as `connect` (Agent) or
 * `requestTls` (ProxyAgent). Returns undefined when verification is on but
 * no bundle is available — caller then omits the key, preserving
 * plain-Node-default behavior.
 */
export function getUndiciConnectTls(verifySsl: boolean): Record<string, unknown> | undefined {
    if (!verifySsl) return { rejectUnauthorized: false };
    const ca = getTrustedCaBundle();
    return ca ? { ca } : undefined;
}

/** Full TLS options for node:https request options (`...spread` over defaults). */
export function getHttpsTlsOptions(verifySsl: boolean): { rejectUnauthorized: boolean; ca?: string[] } {
    if (!verifySsl) return { rejectUnauthorized: false };
    const ca = getTrustedCaBundle();
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/**
 * Opt spawned servers into OS-store trust. Additive only — verification
 * itself is still controlled by OPENGROK_VERIFY_SSL / rejectUnauthorized.
 * Honors an explicit `NODE_USE_SYSTEM_CA=0` opt-out in the parent env.
 */
export function applySystemCaToEnv(env: Record<string, string>): void {
    if (process.env[SYSTEM_CA_ENV_VAR] === '0') return;
    env[SYSTEM_CA_ENV_VAR] ??= '1';
}
