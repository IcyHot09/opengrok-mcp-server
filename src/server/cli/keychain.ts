import * as crypto from 'crypto';
import * as os from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, writeSync, closeSync, renameSync } from 'fs';
import { join, resolve, sep } from 'path';
import { getConfigDirectory, updateCredentialRotationTimestamp } from '../config.js';
import { getKeyringEntry as loadKeyringEntry } from './keyring-loader.js';

const SERVICE = 'opengrok-mcp';

interface KeyringEntryLike {
  setPassword(p: string): void;
  getPassword(): string | null;
  deletePassword(): void;
}

let keyringEntryOverride: ((username: string) => KeyringEntryLike | null) | null = null;

/**
 * Test hook — override keyring entry construction. The production path uses
 * require() for optional native-module loading, which vi.mock cannot
 * intercept, so tests inject a fake backend through this setter instead.
 */
export function _setKeyringEntryForTests(fn: ((username: string) => KeyringEntryLike | null) | null): void {
  keyringEntryOverride = fn;
}

function getKeyringEntry(username: string, service: string = SERVICE): KeyringEntryLike | null {
  if (keyringEntryOverride) return keyringEntryOverride(username);
  return loadKeyringEntry(username, service);
}

export interface CredentialStoreResult {
  source: 'keychain' | 'encrypted-file';
  /**
   * Set when the keyring holds a value this call did not successfully write
   * and could not remove. Reads may serve that stale copy instead of the
   * encrypted-file copy until it is cleared or expires.
   */
  warning?: string;
}

/** Marker file prefix: keyring writes are disabled per account while fresh. */
const WRITE_GATE_PREFIX = '.keyring-writes-disabled-';
/** Re-attempt keyring writes after this long (the backend may have healed). */
const WRITE_GATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UNVERIFIED_WRITE_WARNING =
  'Credential saved to the encrypted file, but the OS keychain holds a different ' +
  'value that could not be reconciled — reads may serve the keychain copy instead ' +
  'of the file copy.';

function writeGateFile(account: string): string {
  return `${WRITE_GATE_PREFIX}${safeFilename(account)}`;
}

function readWriteGate(dir: string, account: string): boolean {
  try {
    const raw = readFileSync(join(dir, writeGateFile(account)), 'utf8');
    const gate = JSON.parse(raw) as { disabledAt?: unknown };
    if (typeof gate.disabledAt !== 'string') return false;
    const at = Date.parse(gate.disabledAt);
    if (Number.isNaN(at) || Date.now() - at > WRITE_GATE_TTL_MS) return false;
    return true;
  } catch { return false; }
}

function writeWriteGate(dir: string, account: string): void {
  try {
    writeFileAtomic(
      join(dir, writeGateFile(account)),
      JSON.stringify({ disabledAt: new Date().toISOString(), reason: 'keyring write could not be verified' })
    );
  } catch { /* gate is advisory only */ }
}

function clearWriteGate(dir: string, account: string): void {
  try { unlinkSync(join(dir, writeGateFile(account))); } catch { /* absent or locked */ }
}

/**
 * Shared store path: try the OS keyring first, fall back to the encrypted file.
 * Detects half-successful writes (value lands despite a thrown error, or a
 * read-back mismatch) that leave an entry this process can neither verify nor
 * remove: the file copy is still written, a warning is returned, and further
 * keyring write attempts are gated until the backend proves healthy again.
 * Reads are never gated — live keyring entries must keep serving.
 */
function storeSecret(username: string, secret: string): CredentialStoreResult {
  const dir = getConfigDirectory();
  const finishFileFallback = (): CredentialStoreResult => {
    storeInEncryptedFile(username, secret);
    updateCredentialRotationTimestamp(dir);
    return { source: 'encrypted-file' };
  };
  if (!readWriteGate(dir, username)) {
    const entry = getKeyringEntry(username);
    if (entry) {
      try {
        entry.setPassword(secret);
        if (entry.getPassword() === secret) {
          // Single-write invariant: the verified keychain copy is the only
          // copy written on success. The encrypted file is a failure fallback
          // only — uniformly on every platform, no per-OS exceptions.
          updateCredentialRotationTimestamp(dir);
          clearWriteGate(dir, username);
          return { source: 'keychain' };
        }
      } catch { /* write or read-back failed — inspect below */ }
      // Never delete a value we did not write: it may belong to a concurrent
      // saver. Only our own half-written value is safe to clean up.
      let lingering: string | null = null;
      try { lingering = entry.getPassword(); } catch { /* unreadable */ }
      let ownGhost = false;
      if (lingering === null || lingering === secret) {
        try { entry.deletePassword(); } catch { /* best effort */ }
        try { lingering = entry.getPassword(); } catch { lingering = null; }
        ownGhost = lingering !== null;
      }
      if (lingering !== null) {
        if (ownGhost) writeWriteGate(dir, username);
        storeInEncryptedFile(username, secret);
        updateCredentialRotationTimestamp(dir);
        return { source: 'encrypted-file', warning: UNVERIFIED_WRITE_WARNING };
      }
    }
  }
  return finishFileFallback();
}

export function storeCredentials(
  _url: string,
  username: string,
  password: string
): CredentialStoreResult {
  purgeLegacyFiles(username);
  return storeSecret(username, password);
}

/** Sanitize username for use in filenames — prevent path traversal. */
function safeFilename(username: string): string {
  // Hash the username to produce a safe, fixed-length filename component
  return crypto.createHash('sha256').update(username).digest('hex').slice(0, 32);
}

/**
 * Best-effort atomic file write: temp file + rename, so a crash mid-write
 * never leaves a torn credential file behind. Falls back to a direct write
 * when atomicity is unavailable.
 */
function writeFileAtomic(filePath: string, content: string): void {
  try {
    mkdirSync(resolve(filePath, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  }
}

/**
 * Best-effort secure removal: overwrite with random bytes before unlinking so
 * secret-bearing bytes do not linger in unallocated blocks. Not a guarantee
 * (journaling filesystems and SSD wear-levelling may preserve copies) and it
 * never throws — callers treat deletion as advisory.
 */
function removeFileSecure(filePath: string): void {
  try {
    const size = statSync(filePath).size;
    if (size > 0 && size <= 1024 * 1024) {
      const fd = openSync(filePath, 'r+');
      try {
        writeSync(fd, crypto.randomBytes(size), 0, size, 0);
      } finally {
        closeSync(fd);
      }
    }
  } catch { /* fall through to unlink */ }
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

/** Remove credential artifacts left by older versions of the setup wizard. */
function purgeLegacyFiles(username: string): void {
  const dir = getConfigDirectory();
  const resolvedDir = resolve(dir);
  const safeName = safeFilename(username);
  for (const name of [`cred-${safeName}.key`, `cred-${username}.key`, 'credentials.enc', '.salt', 'config']) {
    const p = join(dir, name);
    const resolvedPath = resolve(p);
    // Prevent path traversal — resolved path must stay within config dir
    if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + sep)) continue;
    if (existsSync(p)) removeFileSecure(p);
  }
}

export function retrievePassword(username: string): string | null {
  const entry = getKeyringEntry(username);
  if (entry) {
    try {
      const pw = entry.getPassword();
      if (pw !== null) return pw;
      // null means keyring accessible but no entry — fall through to file
    } catch { /* keyring unavailable — fall through to file fallback */ }
  }
  return retrieveFromEncryptedFile(username);
}

export function deleteCredentials(username: string): void {
  const entry = getKeyringEntry(username);
  if (entry) {
    try { entry.deletePassword(); } catch { /* not stored in keyring */ }
  }
  // Clear current and legacy credential files
  const dir = getConfigDirectory();
  const resolvedDir = resolve(dir);
  const safeName = safeFilename(username);
  for (const name of [`cred-${safeName}.enc`, `cred-${safeName}.key`, `cred-${username}.enc`, `cred-${username}.key`, 'credentials.enc', '.salt']) {
    const p = join(dir, name);
    const resolvedPath = resolve(p);
    // Prevent path traversal — resolved path must stay within config dir
    if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + sep)) continue;
    if (existsSync(p)) removeFileSecure(p);
  }
  // Explicit forget resets write suppression for this account.
  clearWriteGate(dir, username);
}

function deriveFileKey(username: string): string {
  // Platform-only key — stable across hostname changes (hostname-based key broke on
  // DHCP reassignment, VPN, container restarts, and renames).
  return crypto.createHash('sha256')
    .update(`opengrok-mcp:${username}:${os.platform()}`)
    .digest('hex');
}

function deriveLegacyFileKey(username: string): string {
  // Old key format that included hostname — kept only for transparent migration.
  return crypto.createHash('sha256')
    .update(`opengrok-mcp:${username}:${os.hostname()}:${os.platform()}`)
    .digest('hex');
}

function storeInEncryptedFile(username: string, password: string): void {
  const dir = getConfigDirectory();
  mkdirSync(dir, { recursive: true });
  const key = deriveFileKey(username);
  const encrypted = encryptWithGcm(password, key);
  writeFileAtomic(join(dir, `cred-${safeFilename(username)}.enc`), encrypted);
}

function retrieveFromEncryptedFile(username: string): string | null {
  const dir = getConfigDirectory();
  const resolvedDir = resolve(dir);
  // Try new hashed filename first, then legacy raw username filename
  const candidates = [
    join(dir, `cred-${safeFilename(username)}.enc`),
    join(dir, `cred-${username}.enc`),
  ];
  for (const encPath of candidates) {
    // Path traversal guard for legacy path
    const resolvedPath = resolve(encPath);
    if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + sep)) continue;
    if (!existsSync(encPath)) continue;
    try {
      const encrypted = readFileSync(encPath, 'utf8').trim();
      const key = deriveFileKey(username);
      try {
        return decryptWithGcm(encrypted, key);
      } catch {
        // Try legacy hostname-based key for transparent one-time migration.
        const legacyKey = deriveLegacyFileKey(username);
        const password = decryptWithGcm(encrypted, legacyKey);
        // Re-encrypt under the new stable key so future reads succeed.
        storeInEncryptedFile(username, password);
        return password;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function encryptWithGcm(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = (cipher as crypto.CipherGCM).getAuthTag();
  return 'gcm:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptWithGcm(data: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const raw = Buffer.from(data.replace(/^gcm:/, ''), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
