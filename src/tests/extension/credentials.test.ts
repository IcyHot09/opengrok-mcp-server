import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';

vi.mock('../../server/config.js', () => ({
  getConfigDirectory: () => os.tmpdir(),
  updateCredentialRotationTimestamp: () => { /* no-op in tests */ },
}));

import { syncServerCredentials } from '../../extension/credentials.js';
import { _setKeyringEntryForTests } from '../../server/cli/keychain.js';

interface FakeOpts {
  writeThenThrow?: boolean;
  stickyDelete?: boolean;
  throwOnRead?: boolean;
  throwAll?: boolean;
}

function makeFakeKeyring(opts: FakeOpts = {}) {
  const store = new Map<string, string>();
  let setCalls = 0;
  return {
    setCalls: () => setCalls,
    seed: (username: string, password: string) => { store.set(username, password); },
    read: (username: string) => store.get(username) ?? null,
    entry: (username: string) => ({
      setPassword: (pw: string) => {
        if (opts.throwAll) throw new Error('no keyring');
        setCalls++;
        store.set(username, pw);
        if (opts.writeThenThrow) throw new Error('keyring write half-failed');
      },
      getPassword: (): string | null => {
        if (opts.throwAll) throw new Error('no keyring');
        if (opts.throwOnRead) throw new Error('keyring unreadable');
        return store.get(username) ?? null;
      },
      deletePassword: (): void => {
        if (opts.throwAll) throw new Error('no keyring');
        if (!opts.stickyDelete) store.delete(username);
      },
    }),
  };
}

function gateFiles(): string[] {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return fs.readdirSync(os.tmpdir())
    .filter((n: string) => n.startsWith('.keyring-writes-disabled-'))
    .map((n: string) => path.join(os.tmpdir(), n));
}

describe('extension credential sync', () => {
  beforeEach(() => {
    for (const f of gateFiles()) {
      try { (require('fs') as typeof import('fs')).unlinkSync(f); } catch { /* ignore */ }
    }
  });

  afterEach(() => {
    _setKeyringEntryForTests(null);
    for (const f of gateFiles()) {
      try { (require('fs') as typeof import('fs')).unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it('returns false when username or password is missing', () => {
    const log = vi.fn();
    expect(syncServerCredentials('https://example.com/source/', '', 'secret', log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Username is required'));
    log.mockClear();
    expect(syncServerCredentials('https://example.com/source/', 'alice', '', log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Password is required'));
  });

  it('stores credentials through the shared keychain path', async () => {
    const fake = makeFakeKeyring();
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `store-ok-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const synced = syncServerCredentials('https://example.com/source/', user, 'secret', log);

    expect(synced).toBe(true);
    expect(fake.read(user)).toBe('secret');
    expect(log).toHaveBeenCalledWith('Credentials stored for server startup.');
    const { deleteCredentials } = await import('../../server/cli/keychain.js');
    deleteCredentials(user);
  });

  it('background sync preserves a differing stored copy instead of clobbering it', () => {
    const fake = makeFakeKeyring();
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `preserve-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    fake.seed(user, 'cli-saved-password');

    const synced = syncServerCredentials(
      'https://example.com/source/', user, 'stale-password', log, { overwriteExisting: false }
    );

    expect(synced).toBe(true);
    expect(fake.setCalls()).toBe(0);
    expect(fake.read(user)).toBe('cli-saved-password');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('holds different credentials'));
  });

  it('background sync skips the write when already in sync', () => {
    const fake = makeFakeKeyring();
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `insync-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    fake.seed(user, 'same-password');

    const synced = syncServerCredentials(
      'https://example.com/source/', user, 'same-password', log, { overwriteExisting: false }
    );

    expect(synced).toBe(true);
    expect(fake.setCalls()).toBe(0);
  });

  it('background sync preserves instead of overwriting when the read fails', () => {
    // Retrieval threw (not merely absent): the override itself throws so
    // retrievePassword propagates instead of falling back to the file.
    _setKeyringEntryForTests(() => { throw new Error('keyring unreadable'); });
    const log = vi.fn();

    const synced = syncServerCredentials(
      'https://example.com/source/', 'alice', 'incoming', log, { overwriteExisting: false }
    );

    expect(synced).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('keeping existing values unchanged'));
  });

  it('explicit saves overwrite by default', async () => {
    const fake = makeFakeKeyring();
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `overwrite-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    fake.seed(user, 'old-password');

    const synced = syncServerCredentials('https://example.com/source/', user, 'new-password', log);

    expect(synced).toBe(true);
    expect(fake.read(user)).toBe('new-password');
    const { deleteCredentials } = await import('../../server/cli/keychain.js');
    deleteCredentials(user);
  });

  it('explicit overwrite wins over a differing stored copy', async () => {
    const fake = makeFakeKeyring();
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `explicit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    fake.seed(user, 'old-password');

    const synced = syncServerCredentials(
      'https://example.com/source/', user, 'new-password', log, { overwriteExisting: true }
    );

    expect(synced).toBe(true);
    expect(fake.setCalls()).toBe(1);
    expect(fake.read(user)).toBe('new-password');
    const { deleteCredentials } = await import('../../server/cli/keychain.js');
    deleteCredentials(user);
  });

  it('surfaces store warnings from the shared fallback path', async () => {
    const fake = makeFakeKeyring({ writeThenThrow: true, stickyDelete: true });
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `warn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    try {
      const synced = syncServerCredentials('https://example.com/source/', user, 'new-secret', log);

      expect(synced).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('keychain'));
      expect(log).toHaveBeenCalledWith('Credentials stored in encrypted file fallback for server startup.');
    } finally {
      const { deleteCredentials } = await import('../../server/cli/keychain.js');
      deleteCredentials(user);
    }
  });

  it('reports encrypted-file fallback source', () => {
    const fake = makeFakeKeyring({ throwAll: true });
    _setKeyringEntryForTests((u) => fake.entry(u));
    const log = vi.fn();
    const user = `fallback-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const synced = syncServerCredentials('https://example.com/source/', user, 'secret', log);

    expect(synced).toBe(true);
    expect(log).toHaveBeenCalledWith('Credentials stored in encrypted file fallback for server startup.');
  });
});
