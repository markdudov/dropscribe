/**
 * Scratch space for a running job, and the cleanup nobody else will do.
 *
 * Every transcription starts by decoding the source into a 16 kHz mono WAV,
 * because neither engine can demux an MKV and no provider wants a 4 GB upload.
 * That intermediate is roughly 115 MB per hour of media, so a two-hour film
 * leaves a quarter of a gigabyte sitting in the OS temp directory for as long
 * as the job runs.
 *
 * The happy path deletes it. The unhappy paths are the reason this file exists:
 * a hard crash, a force-quit, a `kill -9`, a machine that loses power mid-job —
 * none of them run our cleanup, and none of them leave anything the user could
 * plausibly find. macOS only sweeps `/var/folders` on a reboot the user may not
 * perform for weeks, and Windows never sweeps `%TEMP%` on its own at all. So we
 * sweep our own root at startup.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One directory under the OS temp root, shared by every job.
 *
 * The alternative was `app.getPath('temp')`, which on macOS returns the same
 * per-user `/var/folders/...` path anyway. `os.tmpdir()` is preferred because
 * it works before `app.whenReady()` and inside a worker with no Electron `app`
 * object — and the queue may want a scratch path during startup, before ready.
 *
 * On Linux this lands in the shared `/tmp`, where a directory of the same name
 * may already belong to another user. `mkdirSync` then fails with EACCES, which
 * `jobTempDir` deliberately surfaces (see below) rather than silently writing
 * the WAV somewhere the job cannot find it.
 */
function tempRoot(): string {
  return join(tmpdir(), 'dropscribe');
}

/**
 * How long an abandoned job directory is left alone before the sweep takes it.
 *
 * Deleting *everything* at startup would be simpler and wrong: nothing stops a
 * second copy of DropScribe from running — a portable build alongside an
 * installed one, or a second user account on a Mac with fast user switching —
 * and that instance may be forty minutes into a feature film whose WAV lives in
 * the very root we are about to clear. Yanking the file out from under a running
 * ffmpeg or whisper-cli produces a truncated transcript and a bewildering error.
 *
 * An age cutoff sidesteps the whole coordination problem without a lock file:
 * a directory untouched for a day belongs to no live job, because no single
 * transcription on any hardware this app supports runs for twenty-four hours.
 * A lock file would be more precise and would also need stale-lock detection,
 * which is the same age heuristic wearing a hat.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Turn a job id into something safe to use as a single path segment.
 *
 * Job ids are generated inside this app and today contain nothing exotic. This
 * still runs, because the id is concatenated into a path that `cleanupJobTemp`
 * hands to a recursive delete: one `..` would aim that delete at the temp root,
 * and one leading `/` would aim it anywhere at all. The cost of never having to
 * re-audit that is four lines.
 *
 * Everything outside `[A-Za-z0-9_-]` becomes `_`, which also disposes of `.`
 * and therefore of `.` and `..` as names, with no special case for either. The
 * 64-character cap keeps the full path clear of Windows' 260-character limit,
 * since the WAV's own filename still has to fit after it.
 */
function jobDirName(jobId: string): string {
  const cleaned = jobId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  // An id that was entirely punctuation would collapse to nothing, and an empty
  // segment silently resolves to the root itself — the one directory a job must
  // never own.
  return cleaned.length > 0 ? cleaned : 'job';
}

/**
 * The scratch directory for one job, created if it does not exist.
 *
 * This is the one function here that throws. A job with nowhere to write its
 * WAV cannot run, and failing at the point of the `mkdir` — with the real errno
 * and the real path — is far kinder than failing three steps later inside
 * ffmpeg's stderr. The caller turns it into a job error like any other.
 */
export function jobTempDir(jobId: string): string {
  const dir = join(tempRoot(), jobDirName(jobId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Delete a job's scratch directory and everything in it. Never throws.
 *
 * Cleanup runs from `finally` blocks and from cancellation paths — places where
 * an exception would replace the real failure (the one the user needs to see)
 * with a disk error nobody can act on. `force: true` already swallows ENOENT,
 * so a double-cleanup is free; the try/catch is for Windows, where ffmpeg's
 * handle on the WAV can outlive its own process exit by a few milliseconds and
 * turn the delete into EBUSY. Leaving those bytes behind is not a crisis —
 * `sweepOrphanedTemp` collects them on the next launch.
 */
export function cleanupJobTemp(jobId: string): void {
  try {
    rmSync(join(tempRoot(), jobDirName(jobId)), { recursive: true, force: true });
  } catch {
    // Intentionally silent. See above: the caller is usually already handling a
    // more important failure, and this one is self-healing.
  }
}

/**
 * Remove every job directory older than `MAX_AGE_MS`. Called once at startup.
 *
 * This is the function that keeps a crash from costing the user a gigabyte they
 * will never locate, and it never throws: it runs during startup, where a
 * failure to tidy up must not be allowed to stop the app from launching.
 */
export function sweepOrphanedTemp(): void {
  const root = tempRoot();

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // Almost always ENOENT on a fresh install: no root means nothing to sweep,
    // and creating one here just to find it empty would be busywork.
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;

  for (const name of names) {
    const full = join(root, name);
    try {
      if (lastTouchedMs(full) >= cutoff) continue;
      // No `isDirectory()` check: a stray file directly in the root is orphaned
      // garbage by exactly the same argument, and `rmSync` removes both.
      rmSync(full, { recursive: true, force: true });
    } catch {
      // One unreadable entry — a directory another user account owns on Linux,
      // a folder a scanner has open on Windows — skips that entry and no more
      // than that entry. Abandoning the whole sweep because of one of them is
      // how a temp root quietly grows to a gigabyte.
      continue;
    }
  }
}

/**
 * The most recent moment anything under `entryPath` was written.
 *
 * `ctimeMs` is deliberately *not* part of this. It looks like the safest of the
 * three timestamps and is the most dangerous one to use here: ctime is the
 * inode-change time, so it moves for a chmod, a rename, an extended attribute
 * written by a backup tool or a virus scanner — none of which mean a job is
 * alive, and every one of which pushes the deletion further away. Since the
 * only mistake this function can make in that direction is *never freeing the
 * disk space it exists to free*, a timestamp that only ever ratchets forward
 * for unrelated reasons has no place in the decision.
 *
 * The directory's own mtime is not enough either. It moves when an entry is
 * created or removed, not when an existing file grows — so a job that created
 * its WAV and has been decoding into it for the last forty minutes still shows
 * the mtime it had at the start. The children's mtimes are what actually track
 * a live job, so the newest of those wins. One level deep is all that is
 * needed: job directories are flat.
 */
function lastTouchedMs(entryPath: string): number {
  const stat = statSync(entryPath);
  // `birthtimeMs` is reported as 0 by filesystems that do not record a creation
  // time, which `Math.max` absorbs. It is in the mix for the opposite case: an
  // mtime dragged into the past by an archive extraction or a file copied with
  // `-p`, where the creation time is the more honest one.
  let newest = Math.max(stat.mtimeMs, stat.birthtimeMs);
  if (!stat.isDirectory()) return newest;

  for (const child of readdirSync(entryPath)) {
    try {
      const childStat = statSync(join(entryPath, child));
      newest = Math.max(newest, childStat.mtimeMs, childStat.birthtimeMs);
    } catch {
      // A file that vanished between the readdir and the stat belongs to a job
      // that is very much alive. Skipping it is right; the directory's own
      // timestamps still stand behind the decision.
      continue;
    }
  }
  return newest;
}
