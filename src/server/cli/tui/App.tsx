import { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Sidebar } from './Sidebar.js';
import { CategoryPane } from './CategoryPane.js';
import { StatusBar } from './StatusBar.js';
import { settingCategories, getSettingsForCategory, getVisibleSettings } from '../../../shared/settings-catalog.js';
import type { AppState, SetupState, FocusArea } from './types.js';

interface AppProps {
  initialState: SetupState;
  onApply: (state: SetupState) => void;
  onTest: (state: SetupState) => Promise<string>;
}

/** Max visible fields in the content pane before scrolling kicks in */
const VISIBLE_FIELDS = 4;

export function App({ initialState, onApply, onTest }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;
  const isNarrow = termWidth < 60;

  const [state, setState] = useState<AppState>({
    focus: 'sidebar',
    activeCategory: 'features',
    activeCategoryIndex: settingCategories.findIndex(c => c.id === 'features'),
    activeFieldIndex: 0,
    sidebarIndex: 0,
    config: initialState,
    testResult: '',
    testStatus: 'idle',
    dirty: false,
    scrollOffset: 0,
    transitioning: false,
  });

  const categories = settingCategories.filter(c => c.id !== 'general');
  const totalSidebarItems = categories.length + 3; // test, apply, cancel

  const currentFields = getVisibleSettings(
    getSettingsForCategory(state.activeCategory, 'cli'),
    state.config as unknown as Record<string, unknown>,
  );

  // Clamp activeFieldIndex when fields disappear due to visibleWhen
  useEffect(() => {
    setState(prev => {
      if (prev.activeFieldIndex >= currentFields.length && currentFields.length > 0) {
        return { ...prev, activeFieldIndex: currentFields.length - 1 };
      }
      return prev;
    });
  }, [currentFields.length]);

  // Auto-scroll to keep active field visible
  useEffect(() => {
    setState(prev => {
      const maxOffset = Math.max(0, currentFields.length - VISIBLE_FIELDS);
      let newOffset = prev.scrollOffset;
      if (prev.activeFieldIndex < newOffset) {
        newOffset = prev.activeFieldIndex;
      } else if (prev.activeFieldIndex >= newOffset + VISIBLE_FIELDS) {
        newOffset = prev.activeFieldIndex - VISIBLE_FIELDS + 1;
      }
      newOffset = Math.min(newOffset, maxOffset);
      if (newOffset !== prev.scrollOffset) return { ...prev, scrollOffset: newOffset };
      return prev;
    });
  }, [state.activeFieldIndex, currentFields.length]);

  // Clear transition flag after brief delay
  useEffect(() => {
    if (!state.transitioning) return;
    const timer = setTimeout(() => {
      setState(prev => ({ ...prev, transitioning: false }));
    }, 80);
    return () => clearTimeout(timer);
  }, [state.transitioning]);

  const updateConfig = useCallback((fieldId: string, value: unknown) => {
    setState(prev => {
      const newConfig = { ...prev.config, [fieldId]: value };
      return { ...prev, config: newConfig, dirty: true };
    });
  }, []);

  const setFocus = useCallback((focus: FocusArea) => {
    setState(prev => ({ ...prev, focus }));
  }, []);

  const switchCategory = useCallback((catIdx: number) => {
    setState(prev => ({
      ...prev,
      activeCategory: categories[catIdx].id,
      activeCategoryIndex: catIdx,
      sidebarIndex: catIdx,
      activeFieldIndex: 0,
      scrollOffset: 0,
      focus: 'content',
      transitioning: true,
    }));
  }, [categories]);

  const handleAction = useCallback(async (action: string) => {
    if (action === 'cancel') {
      if (state.dirty) {
        setFocus('confirm-exit');
        return;
      }
      exit();
      return;
    }
    if (action === 'test') {
      setState(prev => ({ ...prev, testStatus: 'testing', testResult: 'Testing connection...' }));
      try {
        const result = await onTest(state.config);
        setState(prev => ({ ...prev, testStatus: 'success', testResult: result }));
      } catch (e) {
        setState(prev => ({ ...prev, testStatus: 'error', testResult: (e as Error).message }));
      }
      return;
    }
    if (action === 'apply') {
      onApply(state.config);
      exit();
    }
  }, [state.config, state.dirty, onApply, onTest, exit, setFocus]);

  useInput((input, key) => {
    // Confirm exit dialog
    if (state.focus === 'confirm-exit') {
      if (input === 'y' || input === 'Y' || key.return) {
        exit();
      } else {
        setFocus('sidebar');
      }
      return;
    }

    if (state.focus === 'editing') return;

    // Number shortcuts to jump directly to categories
    const num = parseInt(input, 10);
    if (num >= 1 && num <= categories.length) {
      switchCategory(num - 1);
      return;
    }

    // Tab cycles between sidebar ↔ content
    if (key.tab) {
      setState(prev => ({
        ...prev,
        focus: prev.focus === 'sidebar' ? 'content' : 'sidebar',
        activeFieldIndex: prev.focus === 'sidebar' ? 0 : prev.activeFieldIndex,
      }));
      return;
    }

    if (state.focus === 'sidebar') {
      if (key.upArrow) {
        setState(prev => ({
          ...prev,
          sidebarIndex: Math.max(0, prev.sidebarIndex - 1),
        }));
      } else if (key.downArrow) {
        setState(prev => ({
          ...prev,
          sidebarIndex: Math.min(totalSidebarItems - 1, prev.sidebarIndex + 1),
        }));
      } else if (key.return) {
        const idx = state.sidebarIndex;
        if (idx < categories.length) {
          switchCategory(idx);
        } else {
          const actionIdx = idx - categories.length;
          const actions = ['test', 'apply', 'cancel'];
          void handleAction(actions[actionIdx]);
        }
      } else if (key.rightArrow) {
        setState(prev => ({ ...prev, focus: 'content', activeFieldIndex: 0, scrollOffset: 0 }));
      } else if (key.escape) {
        if (state.dirty) {
          setFocus('confirm-exit');
        } else {
          exit();
        }
      }
    } else if (state.focus === 'content') {
      if (key.upArrow) {
        setState(prev => ({
          ...prev,
          activeFieldIndex: Math.max(0, prev.activeFieldIndex - 1),
        }));
      } else if (key.downArrow) {
        setState(prev => ({
          ...prev,
          activeFieldIndex: Math.min(currentFields.length - 1, prev.activeFieldIndex + 1),
        }));
      } else if (key.pageUp || (key.ctrl && input === 'u')) {
        // Page up — scroll up by VISIBLE_FIELDS
        setState(prev => ({
          ...prev,
          activeFieldIndex: Math.max(0, prev.activeFieldIndex - VISIBLE_FIELDS),
        }));
      } else if (key.pageDown || (key.ctrl && input === 'd')) {
        // Page down — scroll down by VISIBLE_FIELDS
        setState(prev => ({
          ...prev,
          activeFieldIndex: Math.min(currentFields.length - 1, prev.activeFieldIndex + VISIBLE_FIELDS),
        }));
      } else if (key.return) {
        const field = currentFields[state.activeFieldIndex];
        if (field) {
          if (field.type === 'boolean') {
            const currentVal = state.config[field.id as keyof SetupState];
            updateConfig(field.id, !currentVal);
          } else {
            setFocus('editing');
          }
        }
      } else if (input === ' ') {
        const field = currentFields[state.activeFieldIndex];
        if (field?.type === 'boolean') {
          const currentVal = state.config[field.id as keyof SetupState];
          updateConfig(field.id, !currentVal);
        }
      } else if (key.leftArrow || key.escape) {
        setFocus('sidebar');
      }
    }
  });

  const maxHeight = Math.min(termHeight - 1, 24);

  // Confirm exit overlay
  if (state.focus === 'confirm-exit') {
    return (
      <Box flexDirection="column" height={maxHeight} alignItems="center" justifyContent="center">
        <Box borderStyle="double" borderColor="yellow" paddingX={2} paddingY={1} flexDirection="column">
          <Text bold color="yellow">⚠ Unsaved Changes</Text>
          <Text color="white">You have modified settings that haven&apos;t been applied.</Text>
          <Box marginTop={1}>
            <Text color="gray">Press </Text>
            <Text bold color="cyan">Y</Text>
            <Text color="gray"> to discard and exit, any other key to go back.</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Narrow terminals: stack layout (sidebar on top, content below)
  if (isNarrow) {
    return (
      <Box flexDirection="column" height={maxHeight} overflow="hidden">
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan"> opengrok-mcp Setup </Text>
          {state.dirty && <Text color="yellow"> [modified]</Text>}
        </Box>

        {state.focus === 'sidebar' ? (
          <Box flexGrow={1} overflow="hidden">
            <Sidebar
              categories={categories as unknown as Array<{ id: string; title: string }>}
              activeIndex={state.sidebarIndex}
              selectedCategory={state.activeCategory}
              focused={true}
            />
          </Box>
        ) : (
          <Box flexGrow={1} flexDirection="column" paddingX={1}>
            <CategoryPane
              category={state.activeCategory}
              fields={currentFields}
              activeFieldIndex={state.activeFieldIndex}
              focused={state.focus === 'content' || state.focus === 'editing'}
              editing={state.focus === 'editing'}
              config={state.config}
              onFieldChange={updateConfig}
              onEditDone={() => setFocus('content')}
              scrollOffset={state.scrollOffset}
              visibleCount={VISIBLE_FIELDS}
              transitioning={state.transitioning}
            />
          </Box>
        )}

        <StatusBar
          focus={state.focus}
          testStatus={state.testStatus}
          testResult={state.testResult}
          narrow={true}
        />
      </Box>
    );
  }

  // Standard wide layout: sidebar + content side by side
  return (
    <Box flexDirection="column" height={maxHeight} overflow="hidden">
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold color="cyan"> opengrok-mcp Setup </Text>
        {state.dirty && <Text color="yellow"> [modified]</Text>}
      </Box>

      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        <Sidebar
          categories={categories as unknown as Array<{ id: string; title: string }>}
          activeIndex={state.sidebarIndex}
          selectedCategory={state.activeCategory}
          focused={state.focus === 'sidebar'}
        />

        <Box borderStyle="single" borderColor="gray" borderLeft={false} flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
          <CategoryPane
            category={state.activeCategory}
            fields={currentFields}
            activeFieldIndex={state.activeFieldIndex}
            focused={state.focus === 'content' || state.focus === 'editing'}
            editing={state.focus === 'editing'}
            config={state.config}
            onFieldChange={updateConfig}
            onEditDone={() => setFocus('content')}
            scrollOffset={state.scrollOffset}
            visibleCount={VISIBLE_FIELDS}
            transitioning={state.transitioning}
          />
        </Box>
      </Box>

      <StatusBar
        focus={state.focus}
        testStatus={state.testStatus}
        testResult={state.testResult}
      />
    </Box>
  );
}
