import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface EnumOption {
  value: string;
  label: string;
  description?: string;
}

interface EnumFieldProps {
  options: EnumOption[];
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
}

export function EnumField({ options, value, onChange, onCancel }: EnumFieldProps) {
  const currentIdx = options.findIndex(o => o.value === value);
  const [selectedIdx, setSelectedIdx] = useState(Math.max(0, currentIdx));

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) {
      setSelectedIdx(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIdx(prev => Math.min(options.length - 1, prev + 1));
    } else if (key.return) {
      onChange(options[selectedIdx].value);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((opt, idx) => (
        <Text key={opt.value} color={idx === selectedIdx ? 'cyan' : 'gray'}>
          {idx === selectedIdx ? ' ▸ ' : '   '}
          {opt.label}
          {opt.description ? ` — ${opt.description}` : ''}
          {opt.value === value ? ' (current)' : ''}
        </Text>
      ))}
      <Text color="gray" dimColor>{'  ↑↓ select · Enter confirm · Esc cancel'}</Text>
    </Box>
  );
}
