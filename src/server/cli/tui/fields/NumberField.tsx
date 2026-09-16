import { useState } from 'react';
import { Text, useInput } from 'ink';

interface NumberFieldProps {
  value: string;
  minimum?: number;
  maximum?: number;
  onChange: (value: string) => void;
  onCancel: () => void;
}

export function NumberField({ value, minimum, maximum, onChange, onCancel }: NumberFieldProps) {
  const [text, setText] = useState(value);
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      const num = parseInt(text, 10);
      if (isNaN(num)) { setError('Enter a number'); return; }
      if (minimum !== undefined && num < minimum) { setError(`Min: ${minimum}`); return; }
      if (maximum !== undefined && num > maximum) { setError(`Max: ${maximum}`); return; }
      onChange(text);
      return;
    }
    if (key.backspace || key.delete) {
      setText(prev => prev.slice(0, -1));
      setError('');
      return;
    }
    if (input && /[\d-]/.test(input)) {
      setText(prev => prev + input);
      setError('');
    }
  });

  return (
    <Text>
      <Text color="gray">{'> '}</Text>
      <Text color="white">{text}</Text>
      <Text color="black" backgroundColor="white">{' '}</Text>
      {error && <Text color="red">{` ${error}`}</Text>}
      {!error && <Text color="gray">{` Enter ✓ · Esc ✗${minimum !== undefined ? ` (min ${minimum})` : ''}${maximum !== undefined ? ` (max ${maximum})` : ''}`}</Text>}
    </Text>
  );
}
