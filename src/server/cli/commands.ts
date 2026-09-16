export type CliCommand = 'server' | 'setup' | 'status' | 'export-audit' | 'help' | 'version' | 'unknown';

export const COMMAND_ALIASES: Record<string, Exclude<CliCommand, 'unknown'>> = {
  server: 'server',
  '--server': 'server',
  setup: 'setup',
  '--setup': 'setup',
  status: 'status',
  '--status': 'status',
  'export-audit': 'export-audit',
  '--export-audit': 'export-audit',
  help: 'help',
  '--help': 'help',
  '-h': 'help',
  version: 'version',
};

const SUGGESTIBLE_COMMANDS: Array<Exclude<CliCommand, 'unknown'>> = [
  'server',
  'setup',
  'status',
  'version',
  'export-audit',
  'help',
];

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) {
    const row = dp[i];
    if (row) row[0] = i;
  }
  const firstRow = dp[0];
  if (firstRow) {
    for (let j = 0; j < cols; j++) firstRow[j] = j;
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (dp[i - 1]?.[j] ?? 0) + 1;
      const ins = (dp[i]?.[j - 1] ?? 0) + 1;
      const sub = (dp[i - 1]?.[j - 1] ?? 0) + substitutionCost;
      const row = dp[i];
      if (row) row[j] = Math.min(del, ins, sub);
    }
  }

  return dp[a.length]?.[b.length] ?? 0;
}

export function resolveCliCommand(cmd: string | undefined): CliCommand {
  if (!cmd) return 'server';
  return COMMAND_ALIASES[cmd] ?? 'unknown';
}

export function suggestCliCommand(cmd: string): Exclude<CliCommand, 'unknown'> | null {
  const normalizedArg = cmd.replace(/^-+/, '');
  let bestMatch: Exclude<CliCommand, 'unknown'> | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const command of SUGGESTIBLE_COMMANDS) {
    if (command.startsWith(normalizedArg) || normalizedArg.startsWith(command)) {
      return command;
    }

    const distance = levenshteinDistance(normalizedArg, command);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = command;
    }
  }

  return bestDistance <= 2 ? bestMatch : null;
}

export function getCliUsage(binName = 'opengrok-mcp'): string {
  return [
    'Usage:',
    `  ${binName} [server|--server]`,
    `  ${binName} setup`,
    `  ${binName} status`,
    `  ${binName} export-audit [--format json|csv] [--output <path>]`,
    `  ${binName} help`,
    `  ${binName} version`,
  ].join('\n');
}

export function formatUnknownCommandMessage(cmd: string, binName = 'opengrok-mcp'): string {
  const suggestion = suggestCliCommand(cmd);
  const lines = [`Unknown command "${cmd}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`];
  lines.push('', getCliUsage(binName));
  return lines.join('\n');
}
