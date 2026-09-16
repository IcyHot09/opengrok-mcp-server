import { useState } from 'react';
import { Text, useInput } from 'ink';

interface TextFieldProps {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onCancel: () => void;
}

export function TextField({ value, placeholder, onChange, onCancel }: TextFieldProps) {
  const [text, setText] = useState(value);
  const [cursorPos, setCursorPos] = useState(value.length);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onChange(text); return; }
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setText(prev => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos(prev => prev - 1);
      }
      return;
    }
    if (key.leftArrow) {
      setCursorPos(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorPos(prev => Math.min(text.length, prev + 1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText(prev => prev.slice(0, cursorPos) + input + prev.slice(cursorPos));
      setCursorPos(prev => prev + input.length);
    }
  });

  const display = text || '';
  const before = display.slice(0, cursorPos);
  const cursor = display[cursorPos] ?? ' ';
  const after = display.slice(cursorPos + 1);

  return (
    <Text>
      <Text color="gray">{'> '}</Text>
      <Text color="white">{before}</Text>
      <Text color="black" backgroundColor="white">{cursor}</Text>
      <Text color="white">{after}</Text>
      {!text && placeholder && <Text color="gray" dimColor>{` (${placeholder})`}</Text>}
      <Text color="gray">{' Enter ✓ · Esc ✗'}</Text>
    </Text>
  );
}
