import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import {
  buildOpenGrokEnv,
  getSettingCategoryIds,
  getSettingsForSurface,
  settingCategories,
  settingFields,
} from '../../shared/settings-catalog.js';

type PackageSetting = {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  enumDescriptions?: string[];
  markdownDescription?: string;
  description?: string;
};

function readPackageSettings(): Record<string, PackageSetting> {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
    contributes: {
      configuration:
        | { properties: Record<string, PackageSetting> }
        | Array<{ properties: Record<string, PackageSetting> }>;
    };
  };
  const configuration = pkg.contributes.configuration;
  const categories = Array.isArray(configuration) ? configuration : [configuration];
  return Object.assign({}, ...categories.map((category) => category.properties));
}

function catalogTypeToPackageType(catalogType: string): string {
  if (catalogType === 'boolean') return 'boolean';
  if (catalogType === 'integer') return 'integer';
  return 'string';
}

describe('settings catalog', () => {
  it('defines the canonical categories in webview order', () => {
    expect(getSettingCategoryIds()).toEqual([
      'general',
      'features',
      'network',
      'advanced',
    ]);
  });

  it('defines complete metadata for every field', () => {
    for (const field of settingFields) {
      expect(settingCategories.some((category) => category.id === field.category)).toBe(true);
      expect(field.label).toBeTruthy();
      expect(field.description).toBeTruthy();
      expect(field).toHaveProperty('default');
      expect(typeof field.order).toBe('number');
      if (!field.secret) {
        expect(field.env).toBeTruthy();
      }
      if (field.surfaces.includes('vscode')) {
        expect(field.vscodeKey).toBeTruthy();
      }
    }
  });

  it('keeps secret fields out of VS Code settings', () => {
    const packageSettings = readPackageSettings();
    const vscodeFields = getSettingsForSurface('vscode');
    const secretFields = settingFields.filter((field) => field.secret);

    expect(secretFields.length).toBeGreaterThan(0);
    expect(vscodeFields.some((field) => field.secret)).toBe(false);
    for (const field of secretFields) {
      expect(field.surfaces).not.toContain('vscode');
      if (field.vscodeKey) {
        expect(packageSettings).not.toHaveProperty(field.vscodeKey);
      }
    }
    // Passwords live in SecretStorage — no VS Code setting key for them.
    expect(packageSettings).not.toHaveProperty('opengrok-mcp.password');
  });

  it('keeps package settings aligned with catalog defaults, types, and enums', () => {
    const packageSettings = readPackageSettings();

    for (const field of getSettingsForSurface('vscode')) {
      expect(field.vscodeKey).toBeTruthy();
      const pkgSetting = packageSettings[field.vscodeKey as string];
      expect(pkgSetting, field.id).toBeDefined();
      expect(pkgSetting.default).toEqual(field.default);
      expect(pkgSetting.type).toEqual(catalogTypeToPackageType(field.type));
      if (field.options) {
        expect(pkgSetting.enum).toEqual(field.options.map((option) => option.value));
      }
    }

    // No package.json setting may exist without a vscode-surface catalog field.
    // This enforces the absence of cli-only settings (passwordFile, strictSsrf,
    // jwtIssuer, grammarDir) from the VS Code UI.
    for (const vscodeKey of Object.keys(packageSettings)) {
      const field = settingFields.find((candidate) => candidate.vscodeKey === vscodeKey);
      expect(field, vscodeKey).toBeDefined();
      expect(field?.surfaces).toContain('vscode');
    }
  });

  it('keeps the configuration panel sections and fields in sync with the catalog', () => {    const html = fs.readFileSync('src/webview/configManager.html', 'utf8');
    const sectionMatches = [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]);
    expect(sectionMatches.slice(0, settingCategories.length)).toEqual(getSettingCategoryIds());

    for (const field of getSettingsForSurface('webview')) {
      expect(
        html.includes(`id="${field.id}"`) || html.includes(`name="${field.id}"`),
        field.id,
      ).toBe(true);
    }

    // No extras: every input/select id in the panel must resolve to a
    // webview-surface catalog field (codeModeOn/Off map to codeMode).
    const webviewIds = new Set(getSettingsForSurface('webview').map((field) => field.id));
    const idMatches = [...html.matchAll(/<(?:input|select)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    const nameMatches = [...html.matchAll(/<(?:input|select)[^>]*\sname="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set<string>();
    for (const raw of [...idMatches, ...nameMatches]) {
      const normalized = raw === 'codeModeOn' || raw === 'codeModeOff' ? 'codeMode' : raw;
      if (webviewIds.has(normalized)) {
        seen.add(normalized);
        continue;
      }
    }
    expect([...seen].sort()).toEqual([...webviewIds].sort());
  });
});

describe('buildOpenGrokEnv (VS Code provider contract)', () => {
  it('always emits base URL and username, omits defaults', () => {
    const env = buildOpenGrokEnv({
      opengrokBaseUrl: 'https://og.example.com/source/',
      username: 'admin',
      verifySsl: true,
      codeMode: true,
      contextBudget: 'standard',
    });
    expect(env['OPENGROK_BASE_URL']).toBe('https://og.example.com/source/');
    expect(env['OPENGROK_USERNAME']).toBe('admin');
    expect(env).not.toHaveProperty('OPENGROK_VERIFY_SSL');
    expect(env).not.toHaveProperty('OPENGROK_CODE_MODE');
    expect(env).not.toHaveProperty('OPENGROK_CONTEXT_BUDGET');
  });

  it('emits non-default values and maps proxy to both vars', () => {
    const env = buildOpenGrokEnv({
      opengrokBaseUrl: 'https://og.example.com/source/',
      verifySsl: false,
      codeMode: false,
      contextBudget: 'generous',
      proxy: 'http://proxy:8080',
      enableSampling: true,
      timeout: 60,
    });
    expect(env['OPENGROK_VERIFY_SSL']).toBe('false');
    expect(env['OPENGROK_CODE_MODE']).toBe('false');
    expect(env['OPENGROK_CONTEXT_BUDGET']).toBe('generous');
    expect(env['HTTP_PROXY']).toBe('http://proxy:8080');
    expect(env['HTTPS_PROXY']).toBe('http://proxy:8080');
    expect(env['OPENGROK_ENABLE_SAMPLING']).toBe('true');
    expect(env['OPENGROK_TIMEOUT']).toBe('60');
  });

  it('accepts legacy baseUrl/url aliases', () => {
    expect(buildOpenGrokEnv({ baseUrl: 'https://a/' })['OPENGROK_BASE_URL']).toBe('https://a/');
    expect(buildOpenGrokEnv({ url: 'https://b/' })['OPENGROK_BASE_URL']).toBe('https://b/');
  });
});
