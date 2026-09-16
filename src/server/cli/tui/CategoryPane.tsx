import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { SettingField, SettingsCategoryId } from '../../../shared/settings-catalog.js';
import { settingCategories } from '../../../shared/settings-catalog.js';
import { BooleanField } from './fields/BooleanField.js';
import { EnumField } from './fields/EnumField.js';
import { TextField } from './fields/TextField.js';
import { NumberField } from './fields/NumberField.js';
import { PasswordField } from './fields/PasswordField.js';
import type { SetupState } from './types.js';

interface CategoryPaneProps {
  category: SettingsCategoryId;
  fields: SettingField[];
  activeFieldIndex: number;
  focused: boolean;
  editing: boolean;
  config: SetupState;
  onFieldChange: (fieldId: string, value: unknown) => void;
  onEditDone: () => void;
  scrollOffset?: number;
  visibleCount?: number;
  transitioning?: boolean;
}

function getDisplayValue(field: SettingField, config: SetupState): string {
  const value = config[field.id as keyof SetupState];
  if (field.secret) {
    if (field.id === 'password') {
      return config.hasStoredPassword || config.password ? '••••••' : 'not set';
    }
    return value ? '••••••' : 'not set';
  }
  if (field.type === 'boolean') return value ? 'enabled' : 'disabled';
  if (field.type === 'enum' && field.options) {
    const match = field.options.find(o => o.value === String(value));
    if (match) return match.label;
    const defMatch = field.options.find(o => o.value === String(field.default));
    return defMatch?.label ?? String(field.default ?? '');
  }
  const strVal = String(value || '');
  if (strVal) return strVal;
  if (field.placeholder) return field.placeholder;
  return field.default ? String(field.default) : 'not set';
}

export function CategoryPane({
  category,
  fields,
  activeFieldIndex,
  focused,
  editing,
  config,
  onFieldChange,
  onEditDone,
  scrollOffset = 0,
  visibleCount = fields.length,
  transitioning = false,
}: CategoryPaneProps) {
  const categoryMeta = settingCategories.find(c => c.id === category);

  // Transition animation: dim the pane briefly
  if (transitioning) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold color="gray" dimColor>{categoryMeta?.title ?? category}</Text>
        </Box>
        <Text color="gray" dimColor>Loading...</Text>
      </Box>
    );
  }

  // Calculate visible window
  const visibleFields = fields.slice(scrollOffset, scrollOffset + visibleCount);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + visibleCount < fields.length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold color="white">{categoryMeta?.title ?? category}</Text>
          <Text color="gray"> ({fields.length} settings)</Text>
        </Box>
        {categoryMeta?.description && (
          <Text color="gray" dimColor>  {categoryMeta.description}</Text>
        )}
      </Box>

      {hasScrollUp && (
        <Text color="cyan" dimColor>{'   ▲ more above (PgUp)'}</Text>
      )}

      {visibleFields.map((field, visIdx) => {
        const idx = scrollOffset + visIdx;
        const isActive = idx === activeFieldIndex && focused;
        const isEditing = isActive && editing;
        const displayValue = getDisplayValue(field, config);
        const valueColor = field.type === 'boolean'
          ? (config[field.id as keyof SetupState] ? 'green' : 'red')
          : field.secret ? 'gray' : 'cyan';

        return (
          <Box key={field.id} flexDirection="column">
            <Box>
              <Text color={isActive ? 'cyan' : 'white'}>
                {isActive ? ' ▸ ' : '   '}
                {field.label}
              </Text>
              <Text color="gray" dimColor>{' · '}</Text>
              {!isEditing && (
                <Text color={valueColor}>
                  {displayValue}
                </Text>
              )}
            </Box>

            {isEditing && (
              <Box marginLeft={4} marginTop={0}>
                {renderFieldEditor(field, config, onFieldChange, onEditDone)}
              </Box>
            )}

            {!isEditing && (
              <Box marginLeft={4}>
                <Text color="gray">{field.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {hasScrollDown && (
        <Text color="cyan" dimColor>{'   ▼ more below (PgDn)'}</Text>
      )}
    </Box>
  );
}

function renderFieldEditor(
  field: SettingField,
  config: SetupState,
  onChange: (fieldId: string, value: unknown) => void,
  onDone: () => void,
): ReactNode {
  const value = config[field.id as keyof SetupState];

  switch (field.type) {
    case 'boolean':
      return (
        <BooleanField
          value={Boolean(value)}
          onChange={(v) => { onChange(field.id, v); onDone(); }}
          onCancel={onDone}
        />
      );
    case 'enum':
      return (
        <EnumField
          options={field.options ?? []}
          value={String(value ?? field.default)}
          onChange={(v) => { onChange(field.id, v); onDone(); }}
          onCancel={onDone}
        />
      );
    case 'password':
      return (
        <PasswordField
          value={String(value ?? '')}
          onChange={(v) => { onChange(field.id, v); onDone(); }}
          onCancel={onDone}
        />
      );
    case 'integer':
      return (
        <NumberField
          value={String(value ?? field.default)}
          minimum={field.minimum}
          maximum={field.maximum}
          onChange={(v) => { onChange(field.id, v); onDone(); }}
          onCancel={onDone}
        />
      );
    default:
      return (
        <TextField
          value={String(value ?? '')}
          placeholder={String(field.default || '')}
          onChange={(v) => { onChange(field.id, v); onDone(); }}
          onCancel={onDone}
        />
      );
  }
}
