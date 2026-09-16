import { storeCredentials, retrievePassword } from '../server/cli/keychain.js';

type CredentialLog = (message: string) => void;

export interface CredentialSyncOptions {
  /**
   * When false, an existing stored value that differs from the incoming one
   * is preserved (with a warning) instead of overwritten. Used by background
   * syncs so a fresher CLI-saved credential is never clobbered by a stale
   * copy. Explicit user saves default to true and always win.
   */
  overwriteExisting?: boolean;
}

function shouldSkipOverwrite(current: string | null, incoming: string, log: CredentialLog): boolean {
  if (current === null) return false;
  if (current === incoming) return true;
  log('Warning: OS keychain holds different credentials (e.g. saved via CLI setup); keeping them. Re-save on either side to converge.');
  return true;
}

export function syncServerCredentials(
  baseUrl: string,
  username: string,
  password: string,
  log: CredentialLog = () => { /* optional */ },
  opts: CredentialSyncOptions = {}
): boolean {
  if (!username) { log('Username is required for authentication.'); return false; }
  if (!password) { log('Password is required for authentication.'); return false; }

  try {
    if (opts.overwriteExisting === false) {
      let current: string | null = null;
      try {
        current = retrievePassword(username);
      } catch {
        // Retrieval threw (not merely absent): do not risk overwriting a
        // value we could not read — preserve and report instead.
        log('Warning: could not read the stored credential to compare; keeping existing values unchanged. Re-save explicitly to overwrite.');
        return true;
      }
      if (shouldSkipOverwrite(current, password, log)) return true;
    }
    const result = storeCredentials(baseUrl, username, password);
    if (result?.warning) log(`Warning: ${result.warning}`);
    log(result?.source === 'encrypted-file'
      ? 'Credentials stored in encrypted file fallback for server startup.'
      : 'Credentials stored for server startup.');
    return true;
  } catch (err) {
    log(`Warning: Failed to store credentials for server startup: ${err}. Server may fail to start.`);
    return false;
  }
}
