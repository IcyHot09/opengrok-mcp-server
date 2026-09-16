import { Box, Text } from 'ink';

interface SidebarProps {
  categories: Array<{ id: string; title: string }>;
  activeIndex: number;
  selectedCategory: string;
  focused: boolean;
}

const ACTIONS = [
  { id: 'test', label: 'Test', icon: '⚡' },
  { id: 'apply', label: 'Apply', icon: '✓' },
  { id: 'cancel', label: 'Cancel', icon: '✗' },
];

export function Sidebar({ categories, activeIndex, selectedCategory, focused }: SidebarProps) {
  return (
    <Box
      flexDirection="column"
      width={18}
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {categories.map((cat, idx) => {
        const isCursor = activeIndex === idx && focused;
        const isSelected = cat.id === selectedCategory;
        const prefix = isCursor ? ' ▸ ' : isSelected ? ' ● ' : '   ';
        return (
          <Text
            key={cat.id}
            bold={isCursor || isSelected}
            color={isCursor ? 'cyan' : isSelected ? 'cyan' : 'white'}
            inverse={isCursor}
          >
            {prefix}
            <Text dimColor={!isCursor && !isSelected} color={isCursor || isSelected ? 'cyan' : 'gray'}>{idx + 1}</Text> {cat.title}
          </Text>
        );
      })}

      <Text color="gray" dimColor>{'─'.repeat(14)}</Text>

      {ACTIONS.map((action, idx) => {
        const sidebarIdx = categories.length + idx;
        const isCursor = activeIndex === sidebarIdx && focused;
        const restColor = action.id === 'cancel' ? 'red' : action.id === 'apply' ? 'green' : 'yellow';
        return (
          <Text
            key={action.id}
            color={isCursor ? restColor : 'white'}
            bold={isCursor}
            inverse={isCursor}
          >
            {isCursor ? ' ▸ ' : '   '}
            <Text color={isCursor ? restColor : 'gray'}>{action.icon}</Text> {action.label}
          </Text>
        );
      })}
    </Box>
  );
}
