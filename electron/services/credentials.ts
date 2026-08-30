/**
 * Provider API keys, encrypted at rest by the operating system.
 *
 * The obvious library for this is `keytar`, and it is the wrong choice here.
 * keytar is a native addon, so every Electron upgrade means rebuilding it
 * against a new ABI, shipping a prebuilt `.node` per platform *and* per arch,
 * and signing that binary on macOS. Electron's own `safeStorage` needs none of
 * that: it is already inside the runtime, and it wraps the same two OS
 * facilities keytar would have reached for — the login Keychain on macOS and
 * DPAPI on Windows. A dependency that adds a build step and a code-signing
 * surface to reach the identical syscalls is not a dependency worth having.
 *
 * `safeStorage` encrypts and decrypts blobs; it does not store them. So the
 * ciphertext lives in `<userData>/credentials.json`, base64-encoded, keyed by
 * provider id. That file is worthless on any other machine or user account,
 * which is the entire point.
 *
 * Nothing in here may log, stringify or embed a key. Errors name the provider,
 * never the secret.
 */

import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROVIDER_IDS, type ProviderId } from '../shared/providers';

const FILE_VERSION = 1;

/**
 * The on-disk shape. `keys` maps a provider id to base64 ciphertext — never to
 * a key. `version` exists so a future format change can be migrated instead of
 * silently misread as the current one.
 */
interface CredentialsFile {
  version: number;
  keys: Partial<Record<ProviderId, string>>;
}

/**
 * The ciphertext, read once. The file is only ever written by this process, so
 * re-reading it on every `hasKey()` call — and the settings UI calls it for all
 * four providers on every render — would be pure syscall noise.
 */
let cipherCache: CredentialsFile | null = null;

/**
 * Decrypted keys, cached for the lifetime of the process.
 *
 * Each `decryptString` is a round trip into the Keychain / DPAPI, and on macOS
 * a locked keychain turns that into a modal prompt. A job queue that decrypts
 * per request would ask the user to unlock their keychain once per file. Once
 * per launch is the honest cost.
 *
 * A miss is not cached: an absent key is cheap to re-check, and caching absence
 * would mean `setKey` had to invalidate two structures instead of one.
 */
const plaintextCache = new Map<ProviderId, string>();

function credentialsPath(): string {
  return join(app.getPath('userData'), 'credentials.json');
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and sanitize the file.
 *
 * A corrupt or hand-edited file degrades to "no keys stored" rather than
 * throwing. The alternative — propagating a parse error — would make the whole
 * settings screen fail to load because of one bad byte, and the user's only
 * recovery would be to find and delete a file they have never heard of. Losing
 * the stored keys is recoverable in thirty seconds; a settings screen that
 * cannot open is not.
 */
function readCipherFile(): CredentialsFile {
  if (cipherCache) return cipherCache;

  const file: CredentialsFile = { version: FILE_VERSION, keys: {} };
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), 'utf8');
  } catch {
    cipherCache = file;
    return file;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    cipherCache = file;
    return file;
  }

  if (isRecord(parsed)) {
    if (typeof parsed.version === 'number') file.version = parsed.version;
    if (isRecord(parsed.keys)) {
      for (const [id, value] of Object.entries(parsed.keys)) {
        // Only ids this build knows about. A key left behind by a newer version
        // that supports a fifth provider is kept on disk but ignored here.
        if (isProviderId(id) && typeof value === 'string' && value.length > 0) {
          file.keys[id] = value;
        }
      }
    }
  }

  cipherCache = file;
  return file;
}

function writeCipherFile(file: CredentialsFile): void {
  const target = credentialsPath();
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  // Same temp-then-rename dance as settings.ts, for the same reason: a crash
  // between truncate and write must not leave a half-written file where the
  // credentials used to be.
  writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
  cipherCache = file;
}

/**
 * Refuse to store anything when the OS cannot encrypt it.
 *
 * The tempting fallback is to write the key in plaintext "just this once" and
 * carry on. That is exactly the failure mode this whole file exists to prevent:
 * a key in a world-readable JSON file inside the user's profile, put there by
 * an app the user trusted precisely because it said it used the Keychain. A
 * loud, actionable error costs the user one unlock; a silent plaintext fallback
 * costs them a credential they will never know was exposed.
 *
 * In practice this fires on Linux without a Secret Service provider, and on
 * macOS or Windows only in genuinely broken profiles.
 */
function requireEncryption(): void {
  if (safeStorage.isEncryptionAvailable()) return;

  const detail =
    process.platform === 'darwin'
      ? 'Your login keychain appears to be locked or unavailable. Open Keychain Access, unlock the “login” keychain, and try again.'
      : process.platform === 'win32'
        ? 'Windows data protection (DPAPI) is unavailable for this user account. This usually means the app is running under a profile without a loaded user registry hive.'
        : 'No system keyring is available. Install and run gnome-keyring or kwallet, then try again.';

  throw new Error(`DropScribe cannot store your API key securely. ${detail} The key was not saved.`);
}

export function getKey(id: ProviderId): string | null {
  const cached = plaintextCache.get(id);
  if (cached !== undefined) return cached;

  const stored = readCipherFile().keys[id];
  if (stored === undefined) return null;

  // No plaintext fallback on the read side either. If the OS cannot decrypt,
  // there is nothing usable on disk to fall back *to* — we never wrote any.
  if (!safeStorage.isEncryptionAvailable()) return null;

  let plaintext: string;
  try {
    plaintext = safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // Ciphertext from a different machine, a different user account, or a
    // restored backup. The entry is left on disk rather than deleted: the user
    // may be about to log into the account that can read it, and a failed
    // decrypt is not a reason to destroy data. Re-entering the key overwrites
    // it cleanly.
    return null;
  }

  plaintextCache.set(id, plaintext);
  return plaintext;
}

export function setKey(id: ProviderId, key: string): void {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error('The API key is empty.');
  }

  requireEncryption();

  // A COPY, not the object `readCipherFile` returns.
  //
  // That function ends `cipherCache = file; return file` — it hands back the
  // cache itself. Mutating it in place therefore updated the cache before the
  // write was attempted, and `writeCipherFile`'s own `cipherCache = file` after
  // the rename was re-assigning the same reference and could protect nothing.
  // A write that failed — a full disk, a read-only directory — left the app
  // reporting the key as stored, and every job using it, until a restart read
  // the truth back off disk.
  //
  // Building the next state separately makes the rename in `writeCipherFile`
  // the only commit point, which is what it was always supposed to be.
  const current = readCipherFile();
  const next: CredentialsFile = { version: FILE_VERSION, keys: { ...current.keys } };
  next.keys[id] = safeStorage.encryptString(trimmed).toString('base64');
  writeCipherFile(next);
  plaintextCache.set(id, trimmed);
}

export function clearKey(id: ProviderId): void {
  // Same copy-then-commit as `setKey`, and the plaintext eviction waits with
  // it. Removing the key from memory first meant a failed write left the app
  // showing no key while the ciphertext was still on disk — "I removed it" that
  // comes back on the next launch.
  const current = readCipherFile();
  if (current.keys[id] === undefined) {
    plaintextCache.delete(id);
    return;
  }

  const next: CredentialsFile = { version: current.version, keys: { ...current.keys } };
  delete next.keys[id];

  // An empty keys map means the file has nothing left to protect. Removing it
  // is tidier than leaving a `{"version":1,"keys":{}}` husk behind, and it
  // makes "I cleared my keys" true on disk as well as in the UI.
  if (Object.keys(next.keys).length === 0) {
    rmSync(credentialsPath(), { force: true });
    cipherCache = next;
    plaintextCache.delete(id);
    return;
  }

  writeCipherFile(next);
  plaintextCache.delete(id);
}

export function hasKey(id: ProviderId): boolean {
  return getKey(id) !== null;
}

/**
 * The tail of the key, for the settings row.
 *
 * Four characters is enough for a user with two accounts to tell which key is
 * configured, and far too few to be worth anything to anyone else. Returns
 * `undefined` — not an empty string — when there is no key, so the caller's
 * conditional spread omits the field entirely.
 */
export function keyPreview(id: ProviderId): string | undefined {
  const key = getKey(id);
  if (key === null) return undefined;
  return `…${key.slice(-4)}`;
}
