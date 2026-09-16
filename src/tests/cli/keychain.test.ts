import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock state for @napi-rs/keyring
// ─────────────────────────────────────────────────────────────────────────────

const keyringMocks = vi.hoisted(() => ({
  shouldThrow: false,
  storedPasswords: new Map<string, string>(),
}));

vi.mock('@napi-rs/keyring', () => {
  class Entry {
    private username: string;
    constructor(_service: string, username: string) {
      this.username = username;
    }
    setPassword(password: string): void {
      if (keyringMocks.shouldThrow) throw new Error('no keyring');
      keyringMocks.storedPasswords.set(this.username, password);
    }
    getPassword(): string | null {
      if (keyringMocks.shouldThrow) throw new Error('no keyring');
      return keyringMocks.storedPasswords.get(this.username) ?? null;
    }
    deletePassword(): boolean {
      if (keyringMocks.shouldThrow) throw new Error('no keyring');
      return keyringMocks.storedPasswords.delete(this.username);
    }
  }
  return { Entry };
});

vi.mock('../../server/config.js', () => ({
  getConfigDirectory: () => os.tmpdir(),
  updateCredentialRotationTimestamp: () => { /* no-op in tests */ },
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('keychain store/retrieve via keyring', () => {
  beforeEach(() => {
    keyringMocks.shouldThrow = false;
    keyringMocks.storedPasswords.clear();
  });

  it('stores and retrieves via keyring Entry', async () => {
    const { storeCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    await storeCredentials('https://og.example.com', 'admin', 'my-secret');
    const result = await retrievePassword('admin');
    expect(result).toBe('my-secret');
  });

  it('falls back to encrypted file when keyring Entry throws on setPassword', async () => {
    keyringMocks.shouldThrow = true;
    const { storeCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    const uniqueUser = 'testuser-fallback-' + Date.now();
    await storeCredentials('https://og.example.com', uniqueUser, 'fallback-pass');
    const result = await retrievePassword(uniqueUser);
    expect(result).toBe('fallback-pass');
  });

  it('returns null when neither keyring nor file has credentials', async () => {
    keyringMocks.shouldThrow = true;
    const { retrievePassword } = await import('../../server/cli/keychain.js');
    // Use a unique username that has no stored file
    const result = await retrievePassword('nonexistent-user-xyz-' + Date.now());
    expect(result).toBeNull();
  });

  it('deleteCredentials removes keyring entry', async () => {
    keyringMocks.shouldThrow = false;
    const { storeCredentials, deleteCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    await storeCredentials('https://og.example.com', 'admin2', 'pass123');
    await deleteCredentials('admin2');
    // After deletion, keyring no longer has it
    expect(keyringMocks.storedPasswords.has('admin2')).toBe(false);
    // retrievePassword returns null (keyring miss + no file)
    const result = await retrievePassword('admin2');
    expect(result).toBeNull();
  });
});

describe('keychain half-written shadow + write gate', () => {
  // Production keychain access uses require() (optional native module), which
  // vi.mock cannot intercept — inject a deterministic fake backend instead.
  interface FakeOpts { writeThenThrow?: boolean; stickyDelete?: boolean; throwAll?: boolean }
  function makeFakeKeyring(opts: FakeOpts = {}) {
    const store = new Map<string, string>();
    let setCalls = 0;
    return {
      setCalls: () => setCalls,
      entry: (username: string) => ({
        setPassword: (pw: string) => {
          if (opts.throwAll) throw new Error('no keyring');
          setCalls++;
          store.set(username, pw);
          if (opts.writeThenThrow) throw new Error('keyring write half-failed');
        },
        getPassword: (): string | null => {
          if (opts.throwAll) throw new Error('no keyring');
          return store.get(username) ?? null;
        },
        deletePassword: (): void => {
          if (opts.throwAll) throw new Error('no keyring');
          if (!opts.stickyDelete) store.delete(username);
        },
      }),
    };
  }

  const gateFiles = (): string[] => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    return fs.readdirSync(os.tmpdir())
      .filter((n: string) => n.startsWith('.keyring-writes-disabled-'))
      .map((n: string) => path.join(os.tmpdir(), n));
  };

  beforeEach(() => {
    for (const f of gateFiles()) {
      try {
        (require('fs') as typeof import('fs')).unlinkSync(f);
      } catch { /* ignore */ }
    }
  });

  afterEach(async () => {
    const { _setKeyringEntryForTests } = await import('../../server/cli/keychain.js');
    _setKeyringEntryForTests(null);
  });

  it('verified write returns keychain source with no warning', async () => {
    const fake = makeFakeKeyring();
    const { storeCredentials, retrievePassword, _setKeyringEntryForTests } = await import('../../server/cli/keychain.js');
    _setKeyringEntryForTests((u) => fake.entry(u));
    const uniqueUser = 'verifytest-' + Date.now();
    const stored = await storeCredentials('https://og.example.com', uniqueUser, 'pw');
    expect(stored).toEqual({ source: 'keychain' });
    expect(await retrievePassword(uniqueUser)).toBe('pw');
    expect(fake.setCalls()).toBe(1);
  });

  it('half-written shadow: file fallback + mismatch warning, reads serve the keychain copy', async () => {
    // Backend persists the value but reports failure, and deletes are wedged.
    const fake = makeFakeKeyring({ writeThenThrow: true, stickyDelete: true });
    const { storeCredentials, retrievePassword, deleteCredentials, _setKeyringEntryForTests } = await import('../../server/cli/keychain.js');
    _setKeyringEntryForTests((u) => fake.entry(u));
    const uniqueUser = 'shadowtest-' + Date.now();
    try {
      const stored = await storeCredentials('https://og.example.com', uniqueUser, 'new-secret');
      expect(stored.source).toBe('encrypted-file');
      expect(stored.warning).toMatch(/keychain/);
      // Reads are never gated — the lingering shadow copy keeps serving.
      expect(await retrievePassword(uniqueUser)).toBe('new-secret');
      // A 7-day write gate now suppresses further keyring attempts.
      expect(gateFiles().length).toBeGreaterThan(0);
      const gated = await storeCredentials('https://og.example.com', uniqueUser, 'new-secret-2');
      expect(gated.source).toBe('encrypted-file');
      expect(gated.warning).toBeUndefined();
      expect(fake.setCalls()).toBe(1); // gate suppressed the second attempt
    } finally {
      await deleteCredentials(uniqueUser);
    }
  });

  it('verified keyring write clears a stale gate', async () => {    const fs = await import('fs');
    const path = await import('path');
    const crypto = await import('crypto');
    const fake = makeFakeKeyring();
    const { storeCredentials, _setKeyringEntryForTests } = await import('../../server/cli/keychain.js');
    _setKeyringEntryForTests((u) => fake.entry(u));
    const uniqueUser = 'gatetest-' + Date.now();
    const gateName = `.keyring-writes-disabled-${crypto.createHash('sha256').update(uniqueUser).digest('hex').slice(0, 32)}`;
    fs.writeFileSync(path.join(os.tmpdir(), gateName), JSON.stringify({ disabledAt: new Date().toISOString() }), 'utf8');
    try {
      // Gate is fresh → keyring untouched, file fallback without warning.
      const gated = await storeCredentials('https://og.example.com', uniqueUser, 'pw1');
      expect(gated.source).toBe('encrypted-file');
      expect(fake.setCalls()).toBe(0);
      // Expire the gate → next store verifies against the keyring and clears it.
      fs.writeFileSync(
        path.join(os.tmpdir(), gateName),
        JSON.stringify({ disabledAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }),
        'utf8'
      );
      const stored = await storeCredentials('https://og.example.com', uniqueUser, 'pw1');
      expect(stored.source).toBe('keychain');
      expect(fs.existsSync(path.join(os.tmpdir(), gateName))).toBe(false);
    } finally {
      const { deleteCredentials } = await import('../../server/cli/keychain.js');
      await deleteCredentials(uniqueUser);
      try { fs.unlinkSync(path.join(os.tmpdir(), gateName)); } catch { /* ignore */ }
    }
  });

  it('credential file writes are atomic and deletions remove all copies', async () => {
    const fake = makeFakeKeyring({ throwAll: true });
    const { storeCredentials, retrievePassword, deleteCredentials, _setKeyringEntryForTests } = await import('../../server/cli/keychain.js');
    _setKeyringEntryForTests((u) => fake.entry(u));
    const uniqueUser = 'atomictest-' + Date.now();
    const fs = await import('fs');
    const tmpLeftovers = (): string[] =>
      fs.readdirSync(os.tmpdir()).filter((n: string) => n.includes('cred-') && n.endsWith('.tmp'));
    await storeCredentials('https://og.example.com', uniqueUser, 'pw');
    expect(await retrievePassword(uniqueUser)).toBe('pw');
    // Atomic temp+rename must not leave temp files behind.
    expect(tmpLeftovers()).toEqual([]);
    await deleteCredentials(uniqueUser);
    expect(await retrievePassword(uniqueUser)).toBeNull();
    expect(tmpLeftovers()).toEqual([]);
  });
});

describe('keychain encryption roundtrip via file fallback', () => {
  beforeEach(() => {
    keyringMocks.shouldThrow = true;
    keyringMocks.storedPasswords.clear();
  });

  it('encrypts and decrypts a password correctly via AES-GCM file fallback', async () => {
    const { storeCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    const uniqueUser = 'enctest-' + Date.now();
    const secretPassword = 'super-secret-password-123!@#';

    await storeCredentials('https://og.example.com', uniqueUser, secretPassword);
    const retrieved = await retrievePassword(uniqueUser);
    expect(retrieved).toBe(secretPassword);
  });

  it('returns null for corrupted encrypted file', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dir = os.tmpdir();
    const uniqueUser = 'corrupttest-' + Date.now();
    // Write corrupted data directly
    fs.writeFileSync(path.join(dir, `cred-${uniqueUser}.enc`), 'gcm:notbase64!!!', 'utf8');
    fs.writeFileSync(path.join(dir, `cred-${uniqueUser}.key`), 'a'.repeat(64), 'utf8');

    const { retrievePassword } = await import('../../server/cli/keychain.js');
    const result = await retrievePassword(uniqueUser);
    expect(result).toBeNull();
  });
});
