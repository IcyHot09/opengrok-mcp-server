import { Text, useInput } from 'ink';

interface BooleanFieldProps {
  value: boolean;
  onChange: (value: boolean) => void;
  onCancel: () => void;
}

export function BooleanField({ value, onChange, onCancel }: BooleanFieldProps) {
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return || input === ' ') {
      onChange(!value);
    } else if (input === 'y' || input === 'Y') {
      onChange(true);
    } else if (input === 'n' || input === 'N') {
      onChange(false);
    }
  });

  return (
    <Text>
      <Text color="gray">{'['}</Text>
      <Text color={value ? 'green' : 'red'}>{value ? '●' : '○'}</Text>
      <Text color="gray">{'] '}</Text>
      <Text color={value ? 'green' : 'red'}>{value ? 'enabled' : 'disabled'}</Text>
      <Text color="gray">{' (Enter to toggle, Esc to cancel)'}</Text>
    </Text>
  );
}
