/**
 * The allowlist standing between a renderer-supplied string and the disk.
 *
 * The renderer is never trusted with a path. Not because *our* renderer is
 * hostile, but because it is the process that loads and renders untrusted
 * content, and it is the only one an attacker can plausibly reach. If a
 * compromised renderer could name any path, `jobs:enqueue` would become a
 * read-anything primitive: ffmpeg would happily "transcribe"
 * `~/.ssh/id_ed25519` and the resulting "transcript" would be exportable to
 * disk or shipped to a cloud provider. So a path becomes usable only by
 * arriving from a source main itself controls — a native open dialog, or a
 * drop event whose path main has just checked — and every later stage asks
 * this module before touching it.
 *
 * The allowlist stores the **real** path, and every check re-resolves. That is
 * the whole point of `realpathSync` here: authorizing `~/Movies/clip.mp4`
 * while it is a symlink to a real film, then swapping the symlink to point at
 * a private key before the job starts, is a trivially winnable race otherwise.
 * Resolving at authorization time *and* at use time means the string that gets
 * spawned is a path that was, at both moments, the same real file.
 *
 * Note where this is *not* enforced: `electron/ffmpeg.ts` does not call
 * `assertAuthorized`. It is also asked to read files the app created itself —
 * the extracted WAV, the compressed upload — which are never user-authorized.
 * The check belongs at the boundary where a renderer-supplied string enters
 * main (the IPC handlers and the queue), not at the boundary where main talks
 * to a process it spawned.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { isMediaFile } from './shared/media-extensions';

/**
 * Real paths the user has pointed at, this run.
 *
 * Never pruned. An entry has to outlive the job that uses it — including a
 * retry hours later — and there is no moment at which "the user is definitely
 * done with this file" is knowable. A path string is a hundred-odd bytes; a
 * user who drops ten thousand files in one session spends a megabyte, which is
 * cheaper than any eviction policy that could break a running job. The Set
 * dies with the process, so nothing survives a restart — a relaunch means the
 * user has to drop the file again, which is correct.
 */
const authorized = new Set<string>();

/**
 * The canonical path, or `null` when it cannot be resolved.
 *
 * A missing file, a broken symlink and a permission error on a parent
 * directory all land here, and all mean the same thing to the caller: this is
 * not a path we will act on.
 */
function realOrNull(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/**
 * Everything a path must satisfy, in the order that fails cheapest first.
 *
 * Returns the real path on success so the caller records exactly what it
 * checked, rather than the alias it was handed.
 */
function vet(candidate: string): string | null {
  // A relative path is either a bug or an attack: `realpathSync` would resolve
  // it against main's cwd, which in a packaged app is somewhere the user has
  // never heard of and in dev is the repo root.
  if (typeof candidate !== 'string' || candidate.length === 0 || !isAbsolute(candidate)) return null;

  // Extension first, before any syscall. It is the check that rejects the PDF
  // the user dropped by mistake, and it is the one that costs nothing.
  if (!isMediaFile(basename(candidate))) return null;

  const real = realOrNull(candidate);
  if (real === null) return null;

  // Re-checked on the *resolved* path: `foo.mp4` may be a symlink to
  // `secrets.pem`, and the extension of the link tells us nothing about the
  // extension of the target.
  if (!isMediaFile(basename(real))) return null;

  let stats;
  try {
    stats = statSync(real);
  } catch {
    return null;
  }
  // Directories, FIFOs, sockets and device nodes are all rejected here. A FIFO
  // matters more than it looks: ffmpeg would block forever on one, and the job
  // would sit at "Preparing" until the user quit the app.
  if (!stats.isFile()) return null;

  try {
    accessSync(real, constants.R_OK);
  } catch {
    return null;
  }

  return real;
}

/**
 * Accept a path for later use. `false` means the app will not touch it.
 *
 * Called from `files:authorize`, which is deliberately synchronous IPC: a drop
 * handler has to decide inside the event, before the DataTransfer is gone.
 */
export function authorize(absolutePath: string): boolean {
  const real = vet(absolutePath);
  if (real === null) return false;
  authorized.add(real);
  return true;
}

/**
 * Whether this path may be read right now.
 *
 * Re-resolves rather than comparing the raw string, so a symlink that has been
 * re-pointed since it was authorized now resolves somewhere that was never in
 * the set and is refused. A path that *is* already the real path resolves to
 * itself and matches, so callers holding canonical paths pay only one
 * `realpath` syscall.
 */
export function isAuthorized(absolutePath: string): boolean {
  const real = realOrNull(absolutePath);
  return real !== null && authorized.has(real);
}

/**
 * The same question, as a guard.
 *
 * The message is user-facing and shown verbatim, so it names the file the user
 * recognizes rather than the path they do not, and says what to do next. It
 * never says "denied": the overwhelmingly likely cause is not an attack but a
 * file that moved, a volume that was ejected, or an app that was relaunched
 * while a job list was restored from disk.
 */
export function assertAuthorized(absolutePath: string): void {
  if (isAuthorized(absolutePath)) return;
  const name = absolutePath.length > 0 ? basename(absolutePath) : 'that file';
  throw new Error(
    `DropScribe can no longer read “${name}”. The file may have been moved, renamed, or on a drive that is no longer connected. Drag it onto the window again, or open it with the file picker.`,
  );
}

/**
 * Authorize a batch, keeping what passed.
 *
 * Returns the **real** paths, not the strings that came in. The caller — the
 * open dialog handler — hands these straight to the renderer, so this is the
 * one place that can make the renderer's copy canonical. Everything downstream
 * then works with a path that resolves to itself, and `Job.filePath` names the
 * file the user will actually find in Finder or Explorer.
 */
export function authorizeAll(paths: string[]): string[] {
  const accepted: string[] = [];
  for (const candidate of paths) {
    const real = vet(candidate);
    if (real === null) continue;
    authorized.add(real);
    // A dialog can return the same file twice via two different aliases; the
    // renderer should not then see two jobs for one file.
    if (!accepted.includes(real)) accepted.push(real);
  }
  return accepted;
}
