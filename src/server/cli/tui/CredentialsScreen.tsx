import { useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { normalizeBaseUrl } from '../setup/setup-utils.js';

type Phase = 'url' | 'username' | 'password' | 'testing' | 'project' | 'result';

interface CredentialsScreenProps {
  initialBaseUrl: string;
  initialUsername: string;
  initialProject: string;
  hasStoredPassword: boolean;
  onComplete: (baseUrl: string, username: string, password: string, project: string) => void;
  onAdvanced: (baseUrl: string, username: string, password: string, project: string) => void;
  testConnection: (baseUrl: string, username: string, password: string) => Promise<string>;
}

export function CredentialsScreen({
  initialBaseUrl,
  initialUsername,
  initialProject,
  hasStoredPassword,
  onComplete,
  onAdvanced,
  testConnection,
}: CredentialsScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const fixedHeight = Math.min(termHeight - 1, 24);
  const [phase, setPhase] = useState<Phase>('url');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [urlCursor, setUrlCursor] = useState(initialBaseUrl.length);
  const [username, setUsername] = useState(initialUsername);
  const [cursor, setCursor] = useState(initialUsername.length);
  const [password, setPassword] = useState('');
  const [passwordCursor, setPasswordCursor] = useState(0);
  const [project, setProject] = useState(initialProject);
  const [projectCursor, setProjectCursor] = useState(initialProject.length);
  const [testResult, setTestResult] = useState('');
  const [testSuccess, setTestSuccess] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState(0);
  const [urlError, setUrlError] = useState('');

  useInput((input, key) => {
    if (phase === 'url') {
      if (key.return) {
        const normalized = normalizeBaseUrl(baseUrl);
        if (!normalized) {
          setUrlError('Enter a valid URL, e.g. https://opengrok.example.com/source/ (scheme optional — https is assumed)');
          return;
        }
        if (normalized !== baseUrl) {
          setBaseUrl(normalized);
          setUrlCursor(normalized.length);
        }
        setUrlError('');
        setPhase('username');
        return;
      }
      if (key.escape) { exit(); return; }
      if (key.backspace || key.delete) {
        if (urlCursor > 0) {
          setBaseUrl(prev => prev.slice(0, urlCursor - 1) + prev.slice(urlCursor));
          setUrlCursor(prev => prev - 1);
        }
        return;
      }
      if (key.leftArrow) { setUrlCursor(prev => Math.max(0, prev - 1)); return; }
      if (key.rightArrow) { setUrlCursor(prev => Math.min(baseUrl.length, prev + 1)); return; }
      if (input && !key.ctrl && !key.meta) {
        if (urlError) setUrlError('');
        setBaseUrl(prev => prev.slice(0, urlCursor) + input + prev.slice(urlCursor));
        setUrlCursor(prev => prev + input.length);
      }
    } else if (phase === 'username') {
      if (key.return) {
        setPhase('password');
        return;
      }
      if (key.escape) { setPhase('url'); return; }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setUsername(prev => prev.slice(0, cursor - 1) + prev.slice(cursor));
          setCursor(prev => prev - 1);
        }
        return;
      }
      if (key.leftArrow) { setCursor(prev => Math.max(0, prev - 1)); return; }
      if (key.rightArrow) { setCursor(prev => Math.min(username.length, prev + 1)); return; }
      if (input && !key.ctrl && !key.meta) {
        setUsername(prev => prev.slice(0, cursor) + input + prev.slice(cursor));
        setCursor(prev => prev + input.length);
      }
    } else if (phase === 'password') {
      if (key.return) {
        if (!password && username.trim() && !hasStoredPassword) return;
        setPhase('testing');
        runTest(baseUrl, username, password);
        return;
      }
      if (key.escape) { setPhase('username'); return; }
      if (key.backspace || key.delete) {
        if (passwordCursor > 0) {
          setPassword(prev => prev.slice(0, passwordCursor - 1) + prev.slice(passwordCursor));
          setPasswordCursor(prev => prev - 1);
        }
        return;
      }
      if (key.leftArrow) { setPasswordCursor(prev => Math.max(0, prev - 1)); return; }
      if (key.rightArrow) { setPasswordCursor(prev => Math.min(password.length, prev + 1)); return; }
      if (input && !key.ctrl && !key.meta) {
        setPassword(prev => prev.slice(0, passwordCursor) + input + prev.slice(passwordCursor));
        setPasswordCursor(prev => prev + input.length);
      }
    } else if (phase === 'project') {
      if (key.return) {
        setPhase('result');
        return;
      }
      if (key.escape) { setPhase('password'); return; }
      if (key.backspace || key.delete) {
        if (projectCursor > 0) {
          setProject(prev => prev.slice(0, projectCursor - 1) + prev.slice(projectCursor));
          setProjectCursor(prev => prev - 1);
        }
        return;
      }
      if (key.leftArrow) { setProjectCursor(prev => Math.max(0, prev - 1)); return; }
      if (key.rightArrow) { setProjectCursor(prev => Math.min(project.length, prev + 1)); return; }
      if (input && !key.ctrl && !key.meta) {
        setProject(prev => prev.slice(0, projectCursor) + input + prev.slice(projectCursor));
        setProjectCursor(prev => prev + input.length);
      }
    } else if (phase === 'result') {
      if (key.upArrow) setSelectedChoice(prev => Math.max(0, prev - 1));
      if (key.downArrow) setSelectedChoice(prev => Math.min(1, prev + 1));
      if (key.return) {
        if (testSuccess) {
          if (selectedChoice === 0) {
            onComplete(baseUrl, username, password, project);
            exit();
          } else {
            onAdvanced(baseUrl, username, password, project);
          }
        } else {
          if (selectedChoice === 0) {
            onAdvanced(baseUrl, username, password, project);
          } else {
            onComplete(baseUrl, username, password, project);
            exit();
          }
        }
      }
      if (key.escape) { exit(); return; }
    }
  });

  function runTest(url: string, user: string, pass: string) {
    testConnection(url, user, pass)
      .then((msg) => {
        setTestResult(msg);
        setTestSuccess(true);
        setPhase('project');
      })
      .catch((err) => { setTestResult((err as Error).message); setTestSuccess(false); setPhase('result'); });
  }

  const renderUrlField = () => {
    const before = baseUrl.slice(0, urlCursor);
    const cursorChar = baseUrl[urlCursor] ?? ' ';
    const after = baseUrl.slice(urlCursor + 1);
    return (
      <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{phase === 'url' ? '▸ ' : '  '}</Text>
        <Text>OpenGrok URL: </Text>
        {phase === 'url' ? (
          <Text>
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
          </Text>
        ) : (
          <Text color="cyan">{baseUrl}</Text>
        )}
      </Box>
      {phase === 'url' && !!urlError && (
        <Box marginLeft={4}>
          <Text color="red">{urlError}</Text>
        </Box>
      )}
      </Box>
    );
  };

  const renderUsernameField = () => {
    if (phase === 'url') return null;
    const before = username.slice(0, cursor);
    const cursorChar = username[cursor] ?? ' ';
    const after = username.slice(cursor + 1);
    return (
      <Box>
        <Text color="cyan" bold>{phase === 'username' ? '▸ ' : '  '}</Text>
        <Text>Username: </Text>
        {phase === 'username' ? (
          <Text>
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
            {!username && <Text color="gray">{' (blank for anonymous)'}</Text>}
          </Text>
        ) : (
          <Text color="cyan">{username || '(anonymous)'}</Text>
        )}
      </Box>
    );
  };

  const renderPasswordField = () => {
    if (phase === 'url' || phase === 'username') return null;
    const masked = '•'.repeat(password.length);
    const before = masked.slice(0, passwordCursor);
    const cursorChar = passwordCursor < masked.length ? masked[passwordCursor] : ' ';
    const after = masked.slice(passwordCursor + 1);
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>{phase === 'password' ? '▸ ' : '  '}</Text>
          <Text>Password: </Text>
          {phase === 'password' ? (
            password.length > 0 ? (
              <Text>
                {before}
                <Text inverse>{cursorChar}</Text>
                {after}
              </Text>
            ) : (
              <Text>
                <Text inverse>{' '}</Text>
                {hasStoredPassword && username.trim() && <Text color="gray">{' (Enter to keep stored)'}</Text>}
                {!username.trim() && <Text color="gray">{' (Enter to skip — anonymous)'}</Text>}
              </Text>
            )
          ) : (
            <Text color="gray">{'•'.repeat(password.length || 8)}</Text>
          )}
        </Box>
        {phase === 'password' && hasStoredPassword && !password && username.trim() && (
          <Box marginLeft={4}>
            <Text color="gray" dimColor>Type to replace · Enter to keep existing</Text>
          </Box>
        )}
      </Box>
    );
  };

  const renderTestStatus = () => {
    if (phase === 'testing') {
      return (
        <Box marginTop={1}>
          <Text color="yellow">⠋ Testing connection...</Text>
        </Box>
      );
    }
    if (testResult && (phase === 'project' || phase === 'result')) {
      return (
        <Box marginTop={1}>
          <Text color={testSuccess ? 'green' : 'red'}>{testResult}</Text>
        </Box>
      );
    }
    return null;
  };

  const renderProjectField = () => {
    if (phase !== 'project' && phase !== 'result') return null;
    const before = project.slice(0, projectCursor);
    const cursorChar = project[projectCursor] ?? ' ';
    const after = project.slice(projectCursor + 1);
    return (
      <Box marginTop={1}>
        <Text color="cyan" bold>{phase === 'project' ? '▸ ' : '  '}</Text>
        <Text>Default project: </Text>
        {phase === 'project' ? (
          <Text>
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
            {!project && <Text color="gray">{' (blank = all projects)'}</Text>}
          </Text>
        ) : (
          <Text color="cyan">{project || '(all projects)'}</Text>
        )}
      </Box>
    );
  };

  const renderChoices = () => {
    if (phase !== 'result') return null;
    const choices = testSuccess
      ? [
          { label: 'Apply & finish', desc: 'save and start using opengrok-mcp' },
          { label: 'Configure advanced settings', desc: 'browse all categories' },
        ]
      : [
          { label: 'Configure advanced settings', desc: 'fix connection or browse settings' },
          { label: 'Apply anyway & finish', desc: 'save credentials, configure later' },
        ];
    return (
      <Box flexDirection="column" marginTop={1}>
        {choices.map((opt, idx) => (
          <Box key={opt.label}>
            <Text color={idx === selectedChoice ? 'cyan' : 'white'}>
              {idx === selectedChoice ? ' ▸ ' : '   '}
              {opt.label}
            </Text>
            <Text color="gray">{` — ${opt.desc}`}</Text>
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} height={fixedHeight}>
      <Box marginBottom={1}>
        <Text bold color="cyan">opengrok-mcp Setup</Text>
      </Box>

      {renderUrlField()}
      {renderUsernameField()}
      {renderPasswordField()}
      {renderTestStatus()}
      {renderProjectField()}
      {renderChoices()}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {phase === 'url' && 'Enter → Next · Esc → Exit'}
          {phase === 'username' && 'Enter → Next (blank for anonymous) · Esc → Back'}
          {phase === 'password' && 'Enter → Test · Esc → Back'}
          {phase === 'testing' && ''}
          {phase === 'project' && 'Enter → Continue (blank = all projects) · Esc → Back'}
          {phase === 'result' && '↑↓ Navigate · Enter → Select · Esc → Exit'}
        </Text>
      </Box>
    </Box>
  );
}
