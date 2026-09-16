import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { syncServerCredentials } from './extension/credentials.js';
import { buildOpenGrokEnv } from './shared/settings-catalog.js';

// Global state keys
const SETUP_PROMPTED_KEY = 'opengrok.setupPrompted.v2';
const SETTINGS_NONCE_KEY = 'opengrok-mcp.settingsNonce';

// Auto-update check
const GITHUB_REPO_OWNER = 'IcyHot09';
const GITHUB_REPO_NAME = 'opengrok-mcp-server';
const GITHUB_API_BASE = 'https://api.github.com';
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let secretStorage: vscode.SecretStorage;
let mcpProvider: OpenGrokMcpProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
// Guards the configure-panel prompt when the MCP client requests a server
// definition without credentials — prompt at most once per session.
let promptedForConfiguration = false;

/**
 * Open the configuration panel (once per session) when the MCP server cannot
 * start for lack of credentials. The panel is a singleton — repeat calls
 * reveal the existing panel instead of opening duplicates.
 */
function promptForConfiguration(): void {
    if (promptedForConfiguration || !extensionContext) return;
    promptedForConfiguration = true;
    openConfigurationPanel(extensionContext);
}
let _credentialsSynced = false;

/**
 * Get the current extension version from package.json
 */
function getExtensionVersion(): string {
    const ext = vscode.extensions.getExtension('IcyHot09.opengrok-mcp-server');
    return String(ext?.packageJSON.version ?? '0.0.0');
}

/**
 * Signal VS Code to re-query our MCP provider for updated server definitions.
 * This uses the official onDidChangeMcpServerDefinitions event API.
 */
function notifyMcpServerChanged(): void {
    if (mcpProvider) {
        mcpProvider.fireChanged();
        log('Notified VS Code of MCP server definition change.');
    }
}

/**
 * Check for version updates and notify user
 */
async function checkVersionUpdate(context: vscode.ExtensionContext): Promise<void> {
    const currentVersion = getExtensionVersion();
    const previousVersion = context.globalState.get<string>('extensionVersion');

    // Save current version first — must happen before any await that might
    // trigger a reload, otherwise the notification reappears on every reload.
    await context.globalState.update('extensionVersion', currentVersion);

    if (previousVersion && previousVersion !== currentVersion) {
        // Version has been updated
        log(`Extension updated: ${previousVersion} → ${currentVersion}`);

        const action = await vscode.window.showInformationMessage(
            `OpenGrok MCP updated to v${currentVersion}! To use the latest features in Copilot Chat, please reload the window, then enable OpenGrok in the 🔧 Tools menu.`,
            'Reload Window',
            'View Changelog',
            'Later'
        );

        if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (action === 'View Changelog') {
            vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/blob/main/CHANGELOG.md`));
        }

        // New version may have new/changed tools — notify VS Code to re-query our provider
        notifyMcpServerChanged();
    }
}

/**
 * Check GitHub Releases for a newer stable version and offer to install it.
 * No authentication needed — the repository is public.
 * In automatic mode (default) the check is throttled to once per 24 hours.
 * In manual mode (options.manual = true) the throttle is skipped and the user
 * is always told whether they are up to date.
 */
async function checkForRemoteUpdate(
    context: vscode.ExtensionContext,
    options?: { manual?: boolean }
): Promise<void> {
    const manual = options?.manual ?? false;

    // Throttle automatic checks to once per UPDATE_CHECK_INTERVAL_MS
    if (!manual) {
        const lastCheck = context.globalState.get<number>('lastUpdateCheck', 0);
        if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
            log('Update check skipped — checked recently.');
            return;
        }
    }

    try {
        log('Checking for extension updates...');

        const releasesUrl = new URL(
            `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases?per_page=5`
        );
        const headers: Record<string, string> = {
            'User-Agent': 'OpenGrok-MCP-UpdateCheck/1.0',
            'Accept': 'application/vnd.github+json',
        };

        interface GitHubRelease {
            prerelease?: boolean;
            draft?: boolean;
            tag_name?: string;
            assets?: Array<{ name?: string; browser_download_url?: string }>;
        }
        const releases = await httpGetJson(releasesUrl, headers, true) as GitHubRelease[];
        await context.globalState.update('lastUpdateCheck', Date.now());

        // Find the latest stable release (skip beta/alpha/rc/prerelease)
        let latestRelease: GitHubRelease | null = null;
        let latestVersion = '';
        for (const rel of releases) {
            if (rel.prerelease || rel.draft) { continue; }
            const tag = (rel.tag_name ?? '').replace(/^v/, '');
            if (!tag || /beta|alpha|rc/i.test(tag)) { continue; }
            if (!latestVersion || semverCompare(tag, latestVersion) > 0) {
                latestVersion = tag;
                latestRelease = rel;
            }
        }

        if (!latestVersion) {
            log('No stable version found in releases.');
            if (manual) {
                vscode.window.showInformationMessage('OpenGrok MCP: No stable release found.');
            }
            return;
        }

        const currentVersion = getExtensionVersion();
        log(`Update check: installed=${currentVersion}, latest=${latestVersion}`);

        if (semverCompare(latestVersion, currentVersion) <= 0) {
            log('Already on the latest version.');
            if (manual) {
                vscode.window.showInformationMessage(
                    `OpenGrok MCP: You are on the latest version (v${currentVersion}).`
                );
            }
            return;
        }

        if (!latestRelease) {
            log('No stable version found in releases.');
            if (manual) {
                vscode.window.showInformationMessage('OpenGrok MCP: No stable release found.');
            }
            return;
        }

        // Find .vsix asset in release assets
        const vsixAsset = latestRelease.assets?.find(
            (a) => /\.vsix$/i.test(a.name ?? '')
        );
        const vsixUrl: string | undefined = vsixAsset?.browser_download_url;
        const releaseUrl = `${RELEASES_PAGE_URL}/tag/v${latestVersion}`;

        const actions: string[] = ['View Release Notes', 'Dismiss'];
        if (vsixUrl) { actions.unshift('Install Update'); }

        const action = await vscode.window.showInformationMessage(
            `OpenGrok MCP v${latestVersion} is available (you have v${currentVersion}).`,
            ...actions
        );

        if (action === 'Install Update' && vsixUrl) {
            const tmpPath = path.join(os.tmpdir(), `opengrok-mcp-${latestVersion}.vsix`);

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Downloading OpenGrok MCP v${latestVersion}...`, cancellable: false },
                async () => {
                    await downloadToFile(new URL(vsixUrl), tmpPath, true);
                }
            );

            await vscode.commands.executeCommand(
                'workbench.extensions.installExtension',
                vscode.Uri.file(tmpPath)
            );

            try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }

            const reload = await vscode.window.showInformationMessage(
                `OpenGrok MCP updated to v${latestVersion}! Reload to activate the new version.`,
                'Reload Window'
            );
            if (reload === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } else if (action === 'View Release Notes') {
            vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Update check failed (non-fatal): ${errMsg}`);
        if (manual) {
            vscode.window.showWarningMessage(
                `OpenGrok MCP: Could not check for updates. ${errMsg}`
            );
        }
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    secretStorage = context.secrets;
    extensionContext = context;

    outputChannel = vscode.window.createOutputChannel('OpenGrok MCP');
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'opengrok-mcp.showLogs';
    context.subscriptions.push(statusBarItem);

    const currentVersion = getExtensionVersion();
    log(`OpenGrok MCP v${currentVersion} activating...`);

    // Check for version updates
    await checkVersionUpdate(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('opengrok-mcp.configureUI', () => {
            openConfigurationPanel(context);
        }),
        vscode.commands.registerCommand('opengrok-mcp.test', testConnection),
        vscode.commands.registerCommand('opengrok-mcp.showLogs', () => outputChannel.show()),
        vscode.commands.registerCommand('opengrok-mcp.statusMenu', showStatusMenu),
        vscode.commands.registerCommand('opengrok-mcp.checkUpdate', () => checkForRemoteUpdate(context, { manual: true })),
    );

    // Re-query MCP server definition when any opengrok-mcp setting changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('opengrok-mcp')) {
                notifyMcpServerChanged();
            }
        })
    );

    // Fire-and-forget: check for remote updates (throttled to once per 24 h)
    setTimeout(() => { void checkForRemoteUpdate(context); }, 30_000);

    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const username = config.get<string>('username');

    // Register native MCP Provider for Copilot Chat
    if (vscode.lm && vscode.lm.registerMcpServerDefinitionProvider) {
        mcpProvider = new OpenGrokMcpProvider();
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('opengrok-mcp-server', mcpProvider)
        );
        log('Registered native MCP Server Definition Provider.');
    } else {
        log('Warning: This version of VS Code does not support native MCP Server Definition Providers. Copilot features may not work.');
    }

    if (username) {
        updateStatusBar('ready');
    } else {
        updateStatusBar('unconfigured');
        const action = await vscode.window.showInformationMessage(
            'OpenGrok MCP: To enable Copilot codebase search, please configure your OpenGrok credentials.',
            'Configure Now',
            'Later'
        );
        if (action === 'Configure Now') {
            openConfigurationPanel(context);
        } else if (!context.globalState.get<boolean>(SETUP_PROMPTED_KEY)) {
            // First time setup: open configuration automatically
            openConfigurationPanel(context);
            await context.globalState.update(SETUP_PROMPTED_KEY, true);
        }
    }

    log(`OpenGrok MCP v${currentVersion} activated`);
}

function log(message: string): void {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function updateStatusBar(state: 'ready' | 'error' | 'unconfigured'): void {
    switch (state) {
        case 'ready':
            statusBarItem.text = '$(search) OpenGrok';
            statusBarItem.tooltip = 'OpenGrok MCP: Ready - Click for options';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = 'opengrok-mcp.statusMenu';
            break;
        case 'error':
            statusBarItem.text = '$(warning) OpenGrok';
            statusBarItem.tooltip = 'OpenGrok MCP: Error - Click for options';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.command = 'opengrok-mcp.statusMenu';
            break;
        case 'unconfigured':
            statusBarItem.text = '$(gear) OpenGrok';
            statusBarItem.tooltip = 'OpenGrok MCP: Not configured - Click to setup';
            statusBarItem.command = 'opengrok-mcp.configureUI';
            break;
    }
    statusBarItem.show();
}

async function showStatusMenu(): Promise<void> {
    const action = await vscode.window.showQuickPick([
        { label: '$(zap) Test Connection', detail: 'Verify connection to the OpenGrok server', command: 'opengrok-mcp.test' },
        { label: '$(settings-gear) Configuration Manager', detail: 'Open visual configuration panel', command: 'opengrok-mcp.configureUI' },
        { label: '$(output) Show Server Logs', detail: 'View diagnostic logs for learning and debugging', command: 'opengrok-mcp.showLogs' },
        { label: '$(cloud-download) Check for Updates', detail: 'Check for new extension versions on GitHub', command: 'opengrok-mcp.checkUpdate' }
    ], {
        placeHolder: 'OpenGrok MCP Options'
    });

    if (action) {
        vscode.commands.executeCommand(action.command);
    }
}

/**
 * Test connection using Node's https module — properly supports rejectUnauthorized
 * for internal/self-signed certificates on corporate networks.
 */
async function testConnection(silent = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const username = config.get<string>('username');
    const baseUrl = config.get<string>('baseUrl');
    const verifySsl = config.get<boolean>('verifySsl') ?? true;

    if (!username) {
        if (!silent) {
            vscode.window.showErrorMessage('OpenGrok: No username configured.', 'Configure Now')
                .then(a => { if (a === 'Configure Now') vscode.commands.executeCommand('opengrok-mcp.configureUI'); });
        }
        return;
    }

    const password = await secretStorage.get(`opengrok-password-${username}`);
    if (!password) {
        if (!silent) {
            vscode.window.showErrorMessage('OpenGrok: No password found. Please configure credentials.', 'Configure Now')
                .then(a => { if (a === 'Configure Now') vscode.commands.executeCommand('opengrok-mcp.configureUI'); });
        }
        return;
    }

    const runTest = async () => {
        try {
            const targetUrl = baseUrl || '';
            const parsed = new URL(targetUrl);
            const b64 = Buffer.from(`${username}:${password}`).toString('base64');

            const statusCode = await httpGet(parsed, {
                'Authorization': `Basic ${b64}`,
                'User-Agent': 'OpenGrok-MCP/2.0.0'
            }, verifySsl);

            if (statusCode >= 200 && statusCode < 400) {
                log(`Connection test successful (HTTP ${statusCode})`);
                if (!silent) vscode.window.showInformationMessage('✓ OpenGrok connection successful!');
                updateStatusBar('ready');
            } else if (statusCode === 401) {
                log('Authentication failed (401)');
                if (!silent) vscode.window.showErrorMessage('✗ Authentication failed. Check your username and password.');
                updateStatusBar('error');
            } else {
                log(`Unexpected status: ${statusCode}`);
                if (!silent) vscode.window.showWarningMessage(`OpenGrok returned HTTP ${statusCode}`);
            }
        } catch (err: unknown) {
            const msg: string = err instanceof Error ? err.message : String(err);
            log(`Connection test failed: ${msg}`);
            if (!silent) {
                if (msg.includes('certificate') || msg.includes('self-signed') || msg.includes('CERT') || msg.includes('SSL')) {
                    vscode.window.showErrorMessage(
                        '✗ SSL certificate error. If using a self-signed/internal CA, disable SSL verification in Settings.',
                        'Open Settings'
                    ).then(a => {
                        if (a === 'Open Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'opengrok-mcp.verifySsl');
                        }
                    });
                } else {
                    vscode.window.showErrorMessage(`✗ Connection failed: ${msg}`);
                }
            }
            updateStatusBar('error');
        }
    };

    if (silent) {
        await runTest();
    } else {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Testing OpenGrok connection...',
            cancellable: false
        }, runTest);
    }
}

/**
 * Perform a GET request using Node's built-in https/http module.
 * This properly supports rejectUnauthorized for internal CA certs,
 * unlike the global fetch() in VS Code's Node.js context.
 */
function httpGet(url: URL, headers: Record<string, string>, verifySsl: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 15000,
            },
            (res: http.IncomingMessage) => {
                res.resume(); // Consume the response data to avoid memory leaks
                resolve(res.statusCode ?? 0);
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Perform a GET request and return the response body as text (for HTML fetching).
 */
function httpGetText(url: URL, headers: Record<string, string>, verifySsl: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 15000,
            },
            (res: http.IncomingMessage) => {
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 400) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Extract project names from the OpenGrok root page HTML.
 * Looks for <select id="project"> options first, falls back to /xref/ links.
 */
function parseProjectsFromHtml(html: string): string[] {
    const projects: string[] = [];
    const seen = new Set<string>();
    const selectMatch = /<select[^>]*(?:id=["']project["']|name=["']project["'])[^>]*>([\s\S]*?)<\/select>/i.exec(html);
    if (selectMatch) {
        const optionRe = /<option[^>]*value=["']([^"']+)["'][^>]*>/gi;
        let m: RegExpExecArray | null;
        while ((m = optionRe.exec(selectMatch[1])) !== null) {
            const name = m[1];
            if (name && !seen.has(name)) {
                seen.add(name);
                projects.push(name);
            }
        }
        if (projects.length > 0) return projects;
    }
    const linkRe = /href=["'][^"']*\/xref\/([^/"'?#]+)\/?["']/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html)) !== null) {
        const name = lm[1];
        if (name && !seen.has(name)) {
            seen.add(name);
            projects.push(name);
        }
    }
    return projects;
}

/**
 * Perform a GET request and return the parsed JSON body.
 * Rejects if the response status is non-2xx or the body is not valid JSON.
 */
function httpGetJson(url: URL, headers: Record<string, string>, verifySsl: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 15000,
            },
            (res: http.IncomingMessage) => {
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(new Error('Failed to parse JSON response'));
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Download a URL to a local file path, following up to 5 redirects.
 */
function downloadToFile(url: URL, destPath: string, verifySsl: boolean, redirectsLeft = 5, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirectsLeft === 0) {
            reject(new Error('Too many redirects'));
            return;
        }
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 60000,
            },
            (res: http.IncomingMessage) => {
                const statusCode = res.statusCode ?? 0;
                const location = res.headers.location;
                if (statusCode >= 300 && statusCode < 400 && location) {
                    res.resume();
                    const redirectUrl = new URL(location);
                    // Block protocol downgrades (HTTPS → HTTP); cross-origin HTTPS redirects
                    // are allowed so GitHub CDN (objects.githubusercontent.com) redirects work.
                    if (url.protocol === 'https:' && redirectUrl.protocol !== 'https:') {
                        reject(new Error(`Redirect blocked — protocol downgrade to ${redirectUrl.protocol}`));
                        return;
                    }
                    downloadToFile(redirectUrl, destPath, verifySsl, redirectsLeft - 1, headers)
                        .then(resolve).catch(reject);
                    return;
                }
                if (statusCode < 200 || statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode}`));
                    return;
                }
                const out = fs.createWriteStream(destPath);
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve()));
                out.on('error', reject);
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Compare two semver strings (major.minor.patch).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function semverCompare(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) { return diff < 0 ? -1 : 1; }
    }
    return 0;
}


class OpenGrokMcpProvider implements vscode.McpServerDefinitionProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

    fireChanged(): void {
        this._onDidChange.fire();
    }

    async provideMcpServerDefinitions(_token: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
        const config = vscode.workspace.getConfiguration('opengrok-mcp');
        const username = config.get<string>('username');
        if (!username) {
            log('MCP server start blocked: no username configured');
            promptForConfiguration();
            return [];
        }

        const password = await secretStorage.get(`opengrok-password-${username}`);
        if (!password) {
            log('MCP server start blocked: no password found');
            promptForConfiguration();
            return [];
        }
        const baseUrl = config.get<string>('baseUrl') || '';
        const verifySsl = config.get<boolean>('verifySsl') ?? true;
        const proxy = config.get<string>('proxy') ?? '';
        const apiVersion = config.get<string>('apiVersion') || 'v1';
        const enableElicitation = config.get<boolean>('enableElicitation') ?? true;
        const codeMode = config.get<boolean>('codeMode') ?? true;
        const contextBudget = config.get<string>('contextBudget') ?? 'standard';
        const compileDbPaths = (config.get<string>('compileDbPaths') ?? '').trim();

        // Single source of truth for env construction (shared/settings-catalog):
        // emits only non-default values; server-side loadConfig fills defaults.
        const env = buildOpenGrokEnv({
            opengrokBaseUrl: baseUrl,
            username,
            verifySsl,
            proxy,
            apiVersion,
            enableElicitation,
            codeMode,
            contextBudget,
            defaultProject: config.get<string>('defaultProject') ?? '',
            responseFormatOverride: config.get<string>('responseFormatOverride') ?? '',
            enableMemoryTools: config.get<boolean>('enableMemoryTools') ?? false,
            enableFilesApi: config.get<boolean>('enableFilesApi') ?? false,
            enableSampling: config.get<boolean>('enableSampling') ?? false,
            samplingModel: config.get<string>('samplingModel') ?? '',
            samplingMaxTokens: config.get<number>('samplingMaxTokens') ?? 256,
            auditLogFile: config.get<string>('auditLogFile') ?? '',
            rateLimitRpm: config.get<number>('rateLimitRpm') ?? 60,
            enableObservationMasker: config.get<boolean>('enableObservationMasker') ?? false,
            observationMaskerTurns: config.get<number>('observationMaskerTurns') ?? 10,
            timeout: config.get<number>('timeout') ?? 30,
            defaultMaxResults: config.get<number>('defaultMaxResults') ?? 25,
            maxResponseBytes: config.get<number>('maxResponseBytes') ?? 0,
        });

        const memoryBankDir = config.get<string>('memoryBankDir') ?? '';
        if (memoryBankDir) {
            env.OPENGROK_MEMORY_BANK_DIR = memoryBankDir;
        } else if (vscode.workspace.workspaceFolders?.length) {
            // Default: workspace-specific memory bank
            const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            env.OPENGROK_MEMORY_BANK_DIR = path.join(wsRoot, '.opengrok', 'memory-bank');
        }

        if (!_credentialsSynced && password) {
            // Background sync must not clobber a fresher CLI-saved value:
            // preserve a differing stored password (with a warning) instead
            // of overwriting it. Explicit saves below always win.
            const ok = syncServerCredentials(baseUrl, username, password, log, { overwriteExisting: false });
            // Server reads from keychain via resolveConfig() in main.ts — no env vars needed.
            _credentialsSynced = ok;
        }

        // Local layer — user config takes precedence over auto-discovery
        if (compileDbPaths) {
            env.OPENGROK_LOCAL_COMPILE_DB_PATHS = compileDbPaths;
        } else {
            // Auto-discover compile_commands.json files in all workspace folders
            const compileDbUris = await vscode.workspace.findFiles('**/compile_commands.json');
            if (compileDbUris.length > 0) {
                env.OPENGROK_LOCAL_COMPILE_DB_PATHS = compileDbUris.map(u => u.fsPath).join(',');
            }
        }

        // Return the definition object
        // Use process.execPath to get VS Code's bundled Node.js runtime path
        // This ensures it works even when Node.js is not installed system-wide
        const settingsNonce = extensionContext?.globalState.get<number>(SETTINGS_NONCE_KEY) ?? 0;
        const def = new vscode.McpStdioServerDefinition(
            'OpenGrok',
            process.execPath,
            [getServerScriptPath()],
            env,
            `${getExtensionVersion()}-${codeMode ? 'code' : 'legacy'}-${contextBudget}-${settingsNonce}`
        );
        if (vscode.workspace.workspaceFolders?.[0]) {
            def.cwd = vscode.workspace.workspaceFolders[0].uri;
        }
        return [def];
    }
}

function getServerScriptPath(): string {
    // The bundled server is at out/server/main.js relative to the extension root
    const ext = vscode.extensions.getExtension('IcyHot09.opengrok-mcp-server');
    if (ext) {
        return ext.extensionUri.fsPath.replace(/\\/g, '/') + '/out/server/main.js';
    }
    return 'out/server/main.js';
}

// ============================================================================
// Editor Configuration Panel (Sidebar/Beside)
// ============================================================================

let configPanel: vscode.WebviewPanel | undefined;

function openConfigurationPanel(context: vscode.ExtensionContext): void {
    if (configPanel) {
        configPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const column = vscode.window.activeTextEditor
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.One;

    configPanel = vscode.window.createWebviewPanel(
        'opengrok-mcp.configView',
        'OpenGrok Configuration',
        column,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    configPanel.webview.html = getConfigManagerHtml(context);

    // Initial load
    void _sendCurrentConfig(configPanel.webview);

    configPanel.webview.onDidReceiveMessage(
        async (message) => {
            if (!configPanel) return;
            log(`Config webview message: ${message.type}`);
            try {
                switch (message.type) {
                    case 'getConfig':
                        await _sendCurrentConfig(configPanel.webview);
                        break;
                    case 'testConnection':
                        await _handleTestConnection(configPanel.webview, message.data as { baseUrl: string; username: string; password: string; verifySsl: boolean; proxy?: string; apiVersion?: string });
                        break;
                    case 'silentTestConnection':
                        await testConnection(true);
                        break;
                    case 'fetchProjects':
                        await _handleFetchProjects(configPanel.webview, message.data as { baseUrl: string; username: string; password: string; verifySsl: boolean });
                        break;
                    case 'saveConfiguration':
                        await _handleSaveConfiguration(configPanel.webview, message.data as { baseUrl: string; username: string; password?: string; proxy?: string; verifySsl: boolean; defaultProject?: string; contextBudget?: string; responseFormatOverride?: string; codeMode?: boolean; memoryBankDir?: string; compileDbPaths?: string; codeModeChanged?: boolean; apiVersion?: string; enableElicitation?: boolean; enableFilesApi?: boolean; samplingModel?: string; samplingMaxTokens?: number; auditLogFile?: string; rateLimitRpm?: number; maxResponseBytes?: number });
                        break;
                }
            } catch (error: unknown) {
                const errMsg = error instanceof Error ? error.message : String(error);
                log(`Error handling webview message: ${errMsg}`);
                configPanel?.webview.postMessage({ type: 'error', message: errMsg });
            }
        },
        undefined,
        context.subscriptions
    );

    configPanel.onDidDispose(
        () => {
            configPanel = undefined;
        },
        null,
        context.subscriptions
    );
}

async function _sendCurrentConfig(webview: vscode.Webview): Promise<void> {
    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const username = config.get<string>('username') || '';
    const baseUrl = config.get<string>('baseUrl') || '';
    const verifySsl = config.get<boolean>('verifySsl') ?? true;
    const proxy = config.get<string>('proxy') || '';
    const defaultProject = config.get<string>('defaultProject') || '';
    const contextBudget = config.get<string>('contextBudget') || 'standard';
    const responseFormatOverride = config.get<string>('responseFormatOverride') || '';
    const codeMode = config.get<boolean>('codeMode') ?? true;
    const enableMemoryTools = config.get<boolean>('enableMemoryTools') ?? false;
    const memoryBankDir = config.get<string>('memoryBankDir') || '';
    const compileDbPaths = config.get<string>('compileDbPaths') || '';
    const apiVersion = config.get<string>('apiVersion') || 'v1';
    const enableElicitation = config.get<boolean>('enableElicitation') ?? true;
    const enableFilesApi = config.get<boolean>('enableFilesApi') ?? false;
    const enableSampling = config.get<boolean>('enableSampling') ?? false;
    const samplingModel = config.get<string>('samplingModel') ?? '';
    const samplingMaxTokens = config.get<number>('samplingMaxTokens') ?? 256;
    const auditLogFile = config.get<string>('auditLogFile') ?? '';
    const rateLimitRpm = config.get<number>('rateLimitRpm') ?? 60;
    const enableObservationMasker = config.get<boolean>('enableObservationMasker') ?? false;
    const observationMaskerTurns = config.get<number>('observationMaskerTurns') ?? 10;
    const timeout = config.get<number>('timeout') ?? 30;
    const defaultMaxResults = config.get<number>('defaultMaxResults') ?? 25;
    const maxResponseBytes = config.get<number>('maxResponseBytes') ?? 0;

    let hasPassword = false;
    if (username) {
        const password = await secretStorage.get(`opengrok-password-${username}`);
        hasPassword = !!password;
    }

    webview.postMessage({
        type: 'loadConfig',
        config: { baseUrl, username, verifySsl, proxy, hasPassword, defaultProject, contextBudget, responseFormatOverride, codeMode, enableMemoryTools, memoryBankDir, compileDbPaths, apiVersion, enableElicitation, enableFilesApi, enableSampling, samplingModel, samplingMaxTokens, auditLogFile, rateLimitRpm, timeout, defaultMaxResults, enableObservationMasker, observationMaskerTurns, maxResponseBytes }
    });
}

async function _handleTestConnection(webview: vscode.Webview, data: { baseUrl: string; username: string; password: string; verifySsl: boolean; proxy?: string; apiVersion?: string }): Promise<void> {
    let passwordToUse = data.password;

    // When the webview password field is empty, retrieve the saved password from secretStorage
    if (!passwordToUse && data.username) {
        const saved = await secretStorage.get(`opengrok-password-${data.username}`);
        if (saved) {
            passwordToUse = saved;
        } else {
            void webview.postMessage({ type: 'error', message: 'No saved password found. Please enter your password.' });
            return;
        }
    }

    // Use apiVersion from webview if provided, otherwise fall back to saved setting
    const apiVersion = data.apiVersion || vscode.workspace.getConfiguration('opengrok-mcp').get<string>('apiVersion') || 'v1';
    await handleWebviewTestConnection(
        (msg: Record<string, unknown>) => { void webview.postMessage(msg); },
        { ...data, password: passwordToUse, apiVersion }
    );
}

async function _handleFetchProjects(webview: vscode.Webview, data: { baseUrl: string; username: string; password: string; verifySsl: boolean }): Promise<void> {
    let passwordToUse = data.password;
    if (!passwordToUse && data.username) {
        const saved = await secretStorage.get(`opengrok-password-${data.username}`);
        if (saved) passwordToUse = saved;
    }
    if (!data.baseUrl) {
        void webview.postMessage({ type: 'error', message: 'URL is required to fetch projects.' });
        return;
    }
    try {
        const parsed = new URL(data.baseUrl);
        const headers: Record<string, string> = {};
        if (data.username) {
            headers['Authorization'] = `Basic ${Buffer.from(`${data.username}:${passwordToUse}`).toString('base64')}`;
        }
        const html = await httpGetText(parsed, headers, data.verifySsl);
        const projects = parseProjectsFromHtml(html).sort((a, b) => a.localeCompare(b));
        void webview.postMessage({ type: 'projectsList', projects });
        log(`Fetched ${projects.length} projects from OpenGrok.`);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to fetch projects: ${msg}`);
        void webview.postMessage({ type: 'error', message: `Could not fetch projects: ${msg}` });
    }
}

async function _handleSaveConfiguration(webview: vscode.Webview, data: {
    baseUrl: string;
    username: string;
    password?: string;
    proxy?: string;
    verifySsl: boolean;
    defaultProject?: string;
    contextBudget?: string;
    responseFormatOverride?: string;
    codeMode?: boolean;
    enableMemoryTools?: boolean;
    memoryBankDir?: string;
    compileDbPaths?: string;
    codeModeChanged?: boolean;
    apiVersion?: string;
    enableElicitation?: boolean;
    enableFilesApi?: boolean;
    enableSampling?: boolean;
    samplingModel?: string;
    samplingMaxTokens?: number;
    auditLogFile?: string;
    rateLimitRpm?: number;
    timeout?: number;
    defaultMaxResults?: number;
        enableObservationMasker?: boolean;
        observationMaskerTurns?: number;
        maxResponseBytes?: number;
}): Promise<void> {
    await handleSaveConfiguration(
        (msg: Record<string, unknown>) => { void webview.postMessage(msg); },
        data
    );
}

async function handleWebviewTestConnection(
    postMessage: (msg: Record<string, unknown>) => void,
    data: { baseUrl: string; username: string; password: string; verifySsl: boolean; proxy?: string; apiVersion?: string }
): Promise<void> {
    const { baseUrl, username, password, verifySsl } = data;

    postMessage({ type: 'testing', message: 'Testing connection...' });

    try {
        const parsed = new URL(baseUrl);
        const headers: Record<string, string> = {};
        if (username) {
            headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        }

        const statusCode = await httpGet(parsed, headers, verifySsl);

        if (statusCode >= 200 && statusCode < 400) {
            log('✓ Webview test connection successful');
            postMessage({ type: 'testSuccess', message: '✓ Connection successful!' });
        } else if (statusCode === 401) {
            postMessage({ type: 'error', message: '✗ Authentication failed (401). Check username/password.' });
        } else if (statusCode === 403) {
            postMessage({ type: 'error', message: '✗ Access denied (403). Check credentials or server permissions.' });
        } else {
            postMessage({ type: 'error', message: `✗ Server returned HTTP ${statusCode} — is this an OpenGrok server?` });
        }
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`✗ Webview test connection failed: ${errMsg}`);
        if (errMsg.includes('certificate') || errMsg.includes('self-signed') || errMsg.includes('CERT') || errMsg.includes('SSL')) {
            postMessage({ type: 'error', message: '✗ SSL certificate error. Disable SSL verification in advanced settings if using a self-signed cert.' });
        } else {
            postMessage({ type: 'error', message: `✗ Connection failed: ${errMsg}` });
        }
    }
}

async function handleSaveConfiguration(
    postMessage: (msg: Record<string, unknown>) => void,
    data: {
        baseUrl: string;
        username: string;
        password?: string;
        proxy?: string;
        verifySsl: boolean;
        defaultProject?: string;
        contextBudget?: string;
        responseFormatOverride?: string;
        codeMode?: boolean;
        enableMemoryTools?: boolean;
        memoryBankDir?: string;
        compileDbPaths?: string;
        codeModeChanged?: boolean;
        apiVersion?: string;
        enableElicitation?: boolean;
        enableFilesApi?: boolean;
        enableSampling?: boolean;
        samplingModel?: string;
        samplingMaxTokens?: number;
        auditLogFile?: string;
        rateLimitRpm?: number;
        timeout?: number;
        defaultMaxResults?: number;
        enableObservationMasker?: boolean;
        observationMaskerTurns?: number;
        maxResponseBytes?: number;
    }
): Promise<void> {
    const { baseUrl, username, password, proxy, verifySsl, defaultProject, contextBudget, responseFormatOverride, codeMode, enableMemoryTools, memoryBankDir, compileDbPaths, codeModeChanged, apiVersion, enableElicitation,
            enableFilesApi, enableSampling, samplingModel, samplingMaxTokens, auditLogFile, rateLimitRpm,
            timeout, defaultMaxResults, enableObservationMasker, observationMaskerTurns,
            maxResponseBytes } = data;

    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const oldUsername = config.get<string>('username');

    let finalPassword = password;
    if (!finalPassword && username && oldUsername) {
        finalPassword = await secretStorage.get(`opengrok-password-${oldUsername}`);
    }

    // Password is only required when a username is set (anonymous access allowed)
    if (username && !finalPassword) {
        postMessage({ type: 'error', message: 'Password is required' });
        return;
    }

    // Write to OS keychain so server can auto-read on startup.
    // Explicit saves always win over the background no-clobber guard.
    if (username && finalPassword) {
        if (syncServerCredentials(baseUrl, username, finalPassword, log, { overwriteExisting: true })) {
            _credentialsSynced = true;
        }
    }

    // Store password BEFORE config updates so credentials are never lost if a
    // config.update() call throws (e.g. unregistered key).
    if (username && finalPassword) {
        await secretStorage.store(`opengrok-password-${username}`, finalPassword);
    }

    if (oldUsername && oldUsername !== username) {
        await secretStorage.delete(`opengrok-password-${oldUsername}`);
    }

    const G = vscode.ConfigurationTarget.Global;
    const updates: Thenable<void>[] = [
        config.update('baseUrl', baseUrl, G),
        config.update('username', username, G),
        config.update('verifySsl', verifySsl, G),
        config.update('proxy', proxy || undefined, G),
    ];
    if (defaultProject !== undefined)       updates.push(config.update('defaultProject', defaultProject || undefined, G));
    if (contextBudget)                      updates.push(config.update('contextBudget', contextBudget, G));
    if (responseFormatOverride !== undefined) updates.push(config.update('responseFormatOverride', responseFormatOverride || undefined, G));
    if (codeMode !== undefined)             updates.push(config.update('codeMode', codeMode, G));
    if (enableMemoryTools !== undefined)      updates.push(config.update('enableMemoryTools', enableMemoryTools, G));
    if (memoryBankDir !== undefined)        updates.push(config.update('memoryBankDir', memoryBankDir || undefined, G));
    if (compileDbPaths !== undefined)       updates.push(config.update('compileDbPaths', compileDbPaths || undefined, G));
    if (apiVersion !== undefined)           updates.push(config.update('apiVersion', apiVersion || 'v1', G));
    if (enableElicitation !== undefined)    updates.push(config.update('enableElicitation', enableElicitation, G));
    if (enableFilesApi !== undefined)       updates.push(config.update('enableFilesApi', enableFilesApi, G));
    if (enableSampling !== undefined)       updates.push(config.update('enableSampling', enableSampling, G));
    if (samplingModel !== undefined)        updates.push(config.update('samplingModel', samplingModel || undefined, G));
    if (samplingMaxTokens !== undefined)    updates.push(config.update('samplingMaxTokens', samplingMaxTokens, G));
    if (auditLogFile !== undefined)              updates.push(config.update('auditLogFile', auditLogFile || undefined, G));
    if (rateLimitRpm !== undefined)              updates.push(config.update('rateLimitRpm', rateLimitRpm, G));
    if (timeout !== undefined)                   updates.push(config.update('timeout', timeout, G));
    if (defaultMaxResults !== undefined)         updates.push(config.update('defaultMaxResults', defaultMaxResults, G));
    if (enableObservationMasker !== undefined)   updates.push(config.update('enableObservationMasker', enableObservationMasker, G));
    if (observationMaskerTurns !== undefined)    updates.push(config.update('observationMaskerTurns', observationMaskerTurns, G));
    if (maxResponseBytes !== undefined)         updates.push(config.update('maxResponseBytes', maxResponseBytes, G));
    await Promise.all(updates);

    // Bump the settings nonce so provideMcpServerDefinitions returns a new
    // version, causing VS Code to restart the server with fresh config.
    const prevNonce = extensionContext?.globalState.get<number>(SETTINGS_NONCE_KEY) ?? 0;
    await extensionContext?.globalState.update(SETTINGS_NONCE_KEY, prevNonce + 1);

    log(`Configuration saved for user: ${username}`);
    updateStatusBar('ready');
    notifyMcpServerChanged();

    const saveMsg = codeModeChanged
        ? 'Configuration saved! Code Mode is toggling — tools will refresh in 5–10 sec.'
        : 'Configuration saved! Tools are refreshing.';
    postMessage({ type: 'success', message: saveMsg });
}

function getConfigManagerHtml(context: vscode.ExtensionContext): string {
    try {
        const htmlPath = path.join(context.extensionPath, 'out', 'webview', 'configManager.html');
        if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, 'utf8');
            // Generate a cryptographically random nonce per webview load.
            // The nonce replaces 'unsafe-inline' in CSP and is injected into
            // every <script> and <style> tag via the NONCE placeholder.
            const nonce = crypto.randomBytes(16).toString('base64');
            return html
                .replace(/WEBVIEW_NONCE/g, nonce)
                .replace(
                    /script-src 'unsafe-inline'/g,
                    `script-src 'nonce-${nonce}'`
                )
                .replace(
                    /style-src 'unsafe-inline'/g,
                    `style-src 'unsafe-inline' 'nonce-${nonce}'`
                );
        }
    } catch (err) {
        log(`Warning: Could not load external HTML: ${err}`);
    }
    return '<html><body><p>Configuration panel unavailable. Please reinstall the extension.</p></body></html>';
}

export function deactivate(): void {
    log('OpenGrok MCP extension deactivated');
}
