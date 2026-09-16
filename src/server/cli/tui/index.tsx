import { useState } from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { CredentialsScreen } from './CredentialsScreen.js';
import { readStoredEnv } from '../setup/configure.js';
import { createInitialState, applyConfig, testConnection } from '../setup/setup-utils.js';
import type { SetupState } from './types.js';

// Shared reference to capture the final state for post-exit processing
let pendingApply: SetupState | null = null;

function InkSetupRouter() {
  const stored = readStoredEnv();
  const initialState = createInitialState(stored);
  const [mode, setMode] = useState<'credentials' | 'full'>('credentials');
  const [credentials, setCredentials] = useState<{ baseUrl: string; username: string; password: string; project: string }>({
    baseUrl: initialState.baseUrl,
    username: initialState.username,
    password: '',
    project: initialState.defaultProject,
  });

  const credentialTest = (baseUrl: string, username: string, password: string): Promise<string> => {
    const state: SetupState = { ...initialState, baseUrl, username, password };
    return testConnection(state);
  };

  if (mode === 'credentials') {
    return (
      <CredentialsScreen
        initialBaseUrl={initialState.baseUrl}
        initialUsername={initialState.username}
        initialProject={initialState.defaultProject}
        hasStoredPassword={initialState.hasStoredPassword}
        onComplete={(baseUrl, username, password, project) => {
          pendingApply = { ...initialState, baseUrl, username, password, defaultProject: project };
        }}
        onAdvanced={(baseUrl, username, password, project) => {
          setCredentials({ baseUrl, username, password, project });
          setMode('full');
        }}
        testConnection={credentialTest}
      />
    );
  }

  // Full TUI with credentials pre-filled
  const stateWithCreds: SetupState = {
    ...initialState,
    baseUrl: credentials.baseUrl,
    username: credentials.username,
    password: credentials.password,
    defaultProject: credentials.project,
  };

  return (
    <App
      initialState={stateWithCreds}
      onApply={(state) => { pendingApply = state; }}
      onTest={testConnection}
    />
  );
}

export async function runInkSetup(): Promise<void> {
  pendingApply = null;
  const { waitUntilExit } = render(<InkSetupRouter />);
  await waitUntilExit();
  if (pendingApply) {
    applyConfig(pendingApply);
  }
}
