import catalogJson from './settings-catalog.json';
import { applySystemCaToEnv } from './tls-ca.js';

export type SettingsSurface = 'cli' | 'vscode' | 'webview';
export type SettingsCategoryId = 'general' | 'features' | 'network' | 'advanced';
export type SettingType = 'boolean' | 'enum' | 'integer' | 'password' | 'string' | 'url';
export type SettingValue = boolean | number | string;

export interface SettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingCategory {
  id: SettingsCategoryId;
  title: string;
  description: string;
}

export interface VisibleWhenCondition {
  field: string;
  value: SettingValue;
}

export interface SettingField {
  id: string;
  category: SettingsCategoryId;
  label: string;
  description: string;
  type: SettingType;
  default: SettingValue;
  env?: string;
  vscodeKey?: string;
  surfaces: SettingsSurface[];
  order: number;
  secret?: boolean;
  required?: boolean;
  options?: SettingOption[];
  minimum?: number;
  maximum?: number;
  visibleWhen?: VisibleWhenCondition;
  placeholder?: string;
}

interface SettingsCatalog {
  version: number;
  categories: SettingCategory[];
  fields: SettingField[];
}

export type OpenGrokSettingsInput = Partial<Record<string, SettingValue | undefined>> & {
  baseUrl?: string;
  opengrokBaseUrl?: string; // alias
  url?: string; // alias
};

const catalog = catalogJson as SettingsCatalog;
const categoryOrder = new Map(catalog.categories.map((category, index) => [category.id, index]));

export const settingCategories: readonly SettingCategory[] = catalog.categories;
export const settingFields: readonly SettingField[] = [...catalog.fields].sort(compareFields);
export const DEFAULT_OPENGROK_BASE_URL = String(getSetting('baseUrl').default);

function compareFields(a: SettingField, b: SettingField): number {
  const categoryDelta = (categoryOrder.get(a.category) ?? 0) - (categoryOrder.get(b.category) ?? 0);
  return categoryDelta || a.order - b.order || a.id.localeCompare(b.id);
}

export function getSettingCategoryIds(): SettingsCategoryId[] {
  return settingCategories.map((category) => category.id);
}

export function getSetting(id: string): SettingField {
  const field = settingFields.find((candidate) => candidate.id === id);
  if (!field) throw new Error(`Unknown OpenGrok setting: ${id}`);
  return field;
}

export function getSettingsForCategory(categoryId: SettingsCategoryId, surface?: SettingsSurface): SettingField[] {
  return settingFields.filter((field) =>
    field.category === categoryId && (!surface || field.surfaces.includes(surface))
  );
}

export function getSettingsForSurface(surface: SettingsSurface): SettingField[] {
  return settingFields.filter((field) => field.surfaces.includes(surface));
}

export function getDefaultSettings(): Record<string, SettingValue> {
  return Object.fromEntries(settingFields.map((field) => [field.id, field.default]));
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function settingValue(input: OpenGrokSettingsInput, field: SettingField): SettingValue | undefined {
  if (field.id === 'baseUrl') {
    return input.baseUrl ?? input.opengrokBaseUrl ?? input.url ?? field.default;
  }
  return input[field.id];
}

function shouldEmitEnv(field: SettingField, value: SettingValue | undefined): boolean {
  if (value === undefined || !field.env) return false;
  if (field.id === 'baseUrl') return true;
  if (field.type === 'string' || field.type === 'password' || field.type === 'url' || field.type === 'enum') {
    return normalizeString(value) !== '' && normalizeString(value) !== String(field.default);
  }
  if (field.type === 'integer') {
    return normalizeString(value) !== '' && Number(value) !== Number(field.default);
  }
  if (field.type === 'boolean') {
    return Boolean(value) !== Boolean(field.default);
  }
  return false;
}

function envStringValue(field: SettingField, value: SettingValue | undefined): string {
  if (field.id === 'baseUrl') {
    return normalizeString(value) || DEFAULT_OPENGROK_BASE_URL;
  }
  if (field.type === 'boolean') return Boolean(value) ? 'true' : 'false';
  return normalizeString(value);
}

export function buildOpenGrokEnv(input: OpenGrokSettingsInput): Record<string, string> {
  const env: Record<string, string> = {
    OPENGROK_BASE_URL: envStringValue(getSetting('baseUrl'), settingValue(input, getSetting('baseUrl'))),
  };

  for (const field of settingFields) {
    if (field.id === 'baseUrl' || field.secret) continue;
    const value = settingValue(input, field);
    if (!shouldEmitEnv(field, value)) continue;

    if (field.id === 'proxy') {
      const proxy = envStringValue(field, value);
      env.HTTP_PROXY = proxy;
      env.HTTPS_PROXY = proxy;
      continue;
    }

    if (field.env) {
      env[field.env] = envStringValue(field, value);
    }
  }

  // Trust OS-store CAs in spawned servers on every connection (additive only —
  // verification itself is still controlled by verifySsl). Covers OpenGrok
  // connections from VS Code and CLI alike.
  applySystemCaToEnv(env);

  return env;
}

export function validateSettingValue(field: SettingField, value: unknown): string | undefined {
  if (field.required && !normalizeString(value)) {
    return `${field.label} is required`;
  }

  if (field.type === 'url') {
    const candidate = normalizeString(value) || String(field.default);
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL must use http:// or https://';
    } catch {
      return 'Enter a valid URL';
    }
  }

  if (field.type === 'integer') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return 'Enter a whole number';
    if (field.minimum !== undefined && parsed < field.minimum) return `Enter a number greater than or equal to ${field.minimum}`;
    if (field.maximum !== undefined && parsed > field.maximum) return `Enter a number less than or equal to ${field.maximum}`;
  }

  if (field.type === 'enum' && field.options) {
    const allowed = new Set(field.options.map((option) => option.value));
    if (!allowed.has(String(value ?? field.default))) return 'Choose one of the supported values';
  }

  return undefined;
}

/**
 * Filter a list of fields to only those whose `visibleWhen` condition is
 * satisfied by the given config values. Fields without a `visibleWhen` are
 * always included.
 */
export function getVisibleSettings(
  fields: readonly SettingField[],
  config: Record<string, unknown>,
): SettingField[] {
  return fields.filter((field) => {
    if (!field.visibleWhen) return true;
    const actual = config[field.visibleWhen.field];
    return actual === field.visibleWhen.value;
  });
}
