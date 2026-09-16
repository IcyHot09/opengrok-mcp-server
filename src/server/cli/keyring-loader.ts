export type KeyringEntry = {
  setPassword(password: string): void;
  getPassword(): string | null;
  deletePassword(): void;
};

type KeyringEntryConstructor = new (service: string, username: string) => KeyringEntry;

export function getKeyringEntry(username: string, service: string): KeyringEntry | null {
  try {
    // This dependency is optional in the VSIX because native modules are not packaged.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keyring = require('@napi-rs/keyring') as { Entry?: KeyringEntryConstructor };
    if (!keyring.Entry) return null;
    return new keyring.Entry(service, username);
  } catch {
    // The VSIX does not bundle native keyring modules; use encrypted-file storage.
    return null;
  }
}
