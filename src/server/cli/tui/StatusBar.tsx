import { Box, Text } from 'ink';
import type { FocusArea } from './types.js';

interface StatusBarProps {
  focus: FocusArea;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testResult: string;
  narrow?: boolean;
}

const HINTS: Record<FocusArea, string> = {
  sidebar: '↑↓ Navigate · Enter Select · → Content · 1-3 Jump · Tab Switch · Esc Exit',
  content: '↑↓ Navigate · Enter Edit · Space Toggle · ← Back · PgUp/PgDn Scroll · 1-3 Jump',
  editing: 'Enter Confirm · Esc Cancel',
  'confirm-exit': 'Y Discard & Exit · Any key Go Back',
};

const HINTS_NARROW: Record<FocusArea, string> = {
  sidebar: '↑↓ Nav · Enter Sel · 1-3 Jump · Esc Exit',
  content: '↑↓ Nav · Enter Edit · ← Back · PgUp/Dn · 1-3 Jump',
  editing: 'Enter ✓ · Esc ✗',
  'confirm-exit': 'Y Exit · Any key Back',
};

export function StatusBar({ focus, testStatus, testResult, narrow }: StatusBarProps) {
  const statusColor = testStatus === 'success' ? 'green'
    : testStatus === 'error' ? 'red'
    : testStatus === 'testing' ? 'yellow'
    : 'gray';

  const hints = narrow ? HINTS_NARROW : HINTS;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text color="gray" dimColor>{hints[focus]}</Text>
      {testResult && <Text color={statusColor}>{testResult}</Text>}
    </Box>
  );
}
