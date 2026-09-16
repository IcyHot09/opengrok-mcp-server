import { dim, bold, green, red, cyan, yellow } from './colors.js';

export interface OpengrokStatus {
  url: string;
  username: string;
  authSource: string;
  connected: boolean;
  projects?: number;
  latencyMs?: number;
  error?: string;
  verifySsl?: boolean;
}

export interface ConfigStatus {
  source: string;
  mode: string;
  budget: string;
  project: string;
  passwordFile?: string;
  responseCap?: string;
  strictSsrf?: boolean;
  jwtIssuer?: string;
  grammarDir?: string;
}

export interface ClientsStatus {
  claudeCode: boolean;
  copilotCli: boolean;
  codex: boolean;
}

export interface UpdateStatus {
  available: boolean;
  latestVersion?: string;
  error?: string;
}

export interface StatusData {
  version: string;
  opengrok: OpengrokStatus;
  config: ConfigStatus;
  clients: ClientsStatus;
  update: UpdateStatus | null;
}

function section(title: string): string {
  return `  ${bold(title)}`;
}

function field(label: string, value: string): string {
  const paddedLabel = label.padEnd(10);
  return `    ${dim(paddedLabel)}${value}`;
}

function statusIcon(ok: boolean): string {
  return ok ? green('✓') : red('✗');
}

export function renderStatus(data: StatusData): string {
  const lines: string[] = [];

  // Header
  const title = ` OpenGrok MCP Server v${data.version} `;
  const borderLen = Math.max(50, title.length + 4);
  lines.push(dim('┌─') + bold(title) + dim('─'.repeat(borderLen - 2 - title.length) + '┐'));
  lines.push('');

  // OpenGrok
  lines.push(section('OpenGrok'));
  lines.push(field('URL:', data.opengrok.url));
  const authDisplay = data.opengrok.username
    ? `${data.opengrok.username} (${data.opengrok.authSource === 'none' ? 'not retrieved' : data.opengrok.authSource})`
    : dim('(anonymous)');
  lines.push(field('Auth:', authDisplay));
  if (data.opengrok.verifySsl !== undefined) {
    lines.push(field('SSL:', data.opengrok.verifySsl ? 'verified' : 'disabled'));
  }
  if (data.opengrok.connected) {
    const parts = ['Connected'];
    if (data.opengrok.projects !== undefined) parts.push(`${data.opengrok.projects} indexed`);
    if (data.opengrok.latencyMs !== undefined) parts.push(`${data.opengrok.latencyMs} ms`);
    lines.push(field('Status:', `${green('✓')} ${parts.join(' · ')}`));
  } else {
    lines.push(field('Status:', `${red('✗')} unreachable — ${data.opengrok.error ?? 'Unreachable'}`));
    lines.push(field('', dim('Run `opengrok-mcp setup` to configure')));
  }

  // Configuration
  lines.push('');
  lines.push(section('Configuration'));
  lines.push(field('Source:', data.config.source || dim('not found')));
  lines.push(field('Mode:', data.config.mode));
  lines.push(field('Budget:', data.config.budget));
  if (data.config.project) {
    lines.push(field('Project:', data.config.project));
  } else {
    lines.push(field('Project:', dim('(all projects)')));
  }
  lines.push(field('Password file:', data.config.passwordFile || '(unset)'));
  lines.push(field('Response cap:', data.config.responseCap || 'budget default'));
  lines.push(field('Strict SSRF:', data.config.strictSsrf ? 'enabled' : 'disabled'));
  lines.push(field('JWT issuer:', data.config.jwtIssuer || '(unset)'));
  lines.push(field('Grammar dir:', data.config.grammarDir || '(bundled)'));

  // Clients
  lines.push('');
  lines.push(section('Clients'));
  lines.push(field('', `${statusIcon(data.clients.claudeCode)} Claude Code CLI`));
  lines.push(field('', `${statusIcon(data.clients.copilotCli)} GitHub Copilot CLI`));
  lines.push(field('', `${statusIcon(data.clients.codex)} Codex CLI`));

  // Update
  if (data.update) {
    lines.push('');
    lines.push(section('Update'));
    if (data.update.available && data.update.latestVersion) {
      lines.push(field('', `${cyan('⬆')} v${data.update.latestVersion} available — run ${cyan('`npm update -g opengrok-mcp-server`')}`));
    } else if (data.update.error) {
      lines.push(field('', `${yellow('⚠')} Could not check (${data.update.error})`));
    } else {
      lines.push(field('', `${green('✓')} Up to date`));
    }
  }

  lines.push('');
  lines.push(dim('└' + '─'.repeat(borderLen - 2) + '┘'));

  return lines.join('\n');
}
