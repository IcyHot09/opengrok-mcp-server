/**
 * Shared state for the Ink TUI setup flow.
 *
 * The settings catalog itself lives in the shared registry
 * (`src/shared/settings-catalog.ts`) — this module only defines TUI state.
 */

import type { SettingsCategoryId } from '../../../shared/settings-catalog.js';

export interface SetupState {
  baseUrl: string;
  username: string;
  password: string;
  hasStoredPassword: boolean;
  storedPassword: string | null;
  defaultProject: string;
  codeMode: boolean;
  enableMemoryTools: boolean;
  enableElicitation: boolean;
  contextBudget: string;
  defaultMaxResults: string;
  responseFormatOverride: string;
  enableFilesApi: boolean;
  enableSampling: boolean;
  samplingModel: string;
  samplingMaxTokens: string;
  enableObservationMasker: boolean;
  observationMaskerTurns: string;
  verifySsl: boolean;
  proxy: string;
  apiVersion: string;
  rateLimitRpm: string;
  timeout: string;
  memoryBankDir: string;
  compileDbPaths: string;
  auditLogFile: string;
  passwordFile: string;
  maxResponseBytes: string;
  strictSsrf: boolean;
  jwtIssuer: string;
  grammarDir: string;
}

export type FocusArea = 'sidebar' | 'content' | 'editing' | 'confirm-exit';
export type ActionId = 'test' | 'apply' | 'cancel';

export interface AppState {
  focus: FocusArea;
  activeCategory: SettingsCategoryId;
  activeCategoryIndex: number;
  activeFieldIndex: number;
  sidebarIndex: number;
  config: SetupState;
  testResult: string;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  dirty: boolean;
  /** Scroll offset for the content pane (first visible field index) */
  scrollOffset: number;
  /** Brief animation state during category transitions */
  transitioning: boolean;
}
