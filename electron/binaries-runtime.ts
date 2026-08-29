/**
 * Where the vendored executables actually live, in dev and in a shipped app.
 *
 * DropScribe ships its own ffmpeg, ffprobe and the two whisper.cpp CLIs instead
 * of looking for them on `PATH`. That is not paranoia about the user's machine:
 * a homebrew ffmpeg is a *different build* with a different codec set, and the
 * extraction step has to produce a byte-identical 16 kHz mono WAV everywhere or
 * the engines quietly drift between machines. Shipping the binaries also means
 * a Windows user who has never heard of ffmpeg never has to.
 *
 * Two layouts, one lookup:
 *   - dev:      `<repoRoot>/vendor/bin/<platform>-<arch>/`  — what `scripts/fetch-binaries.mjs` fills
 *   - packaged: `<process.resourcesPath>/bin/`              — what electron-builder's `extraResources` copies
 *
 * The dev layout is keyed by `<platform>-<arch>` because one checkout is shared
 * between an Apple-silicon Mac and a Windows box far more often than you would
 * think — on a network volume, or through a VM sharing the same folder. The
 * packaged layout is not keyed, because an installer only ever carries the one
 * platform it was built for, and a second level of nesting would only be a
 * second thing for the builder config to get wrong.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export type BinaryName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'parakeet-cli';

/** Every binary the app cannot run without. The order is the order the UI lists them in. */
const REQUIRED_BINARIES: readonly BinaryName[] = ['ffmpeg', 'ffprobe', 'whisper-cli', 'parakeet-cli'];

const NOTICE_FILE = 'THIRD-PARTY-NOTICES.md';

/**
 * True only inside a packaged app.
 *
 * Guarded because a plain `vitest` process imports this module without an
 * Electron runtime around it, and `app` is then `undefined`. Throwing there
 * would make every unit test of anything downstream depend on Electron.
 */
function packaged(): boolean {
  return typeof app === 'object' && app !== null && app.isPackaged === true;
}

/**
 * The repository root in development.
 *
 * `app.getAppPath()` and not `__dirname`: the compiled main bundle lives in
 * `out/main/`, so `__dirname` would need a `..` count that silently becomes
 * wrong the day electron-vite's output layout changes. electron-vite launches
 * `electron .` from the repo root, so the app path *is* the repo root, and the
 * `process.cwd()` fallback covers a bare node process running the same code.
 */
function repoRoot(): string {
  if (typeof app === 'object' && app !== null && typeof app.getAppPath === 'function') {
    return app.getAppPath();
  }
  return process.cwd();
}

/** The directory holding the binaries for *this* machine. */
export function binDir(): string {
  if (packaged()) return join(process.resourcesPath, 'bin');
  return join(repoRoot(), 'vendor', 'bin', `${process.platform}-${process.arch}`);
}

/**
 * The absolute path of one vendored executable.
 *
 * Always inside `binDir()`, never copied out of it, and this is load-bearing on
 * Windows: `whisper-cli.exe` and `parakeet-cli.exe` are dynamically linked
 * against `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll` and `whisper.dll`, and
 * Windows resolves those from the *executable's own directory* first. Copy the
 * .exe to a temp folder to work around a path quirk and it dies at load time
 * with a dialog no user can act on. Spawn it where it sits; pass odd paths as
 * arguments instead.
 */
export function binaryPath(name: BinaryName): string {
  return join(binDir(), process.platform === 'win32' ? `${name}.exe` : name);
}

/**
 * Present *and* runnable.
 *
 * `existsSync` alone is not enough on macOS and Linux: a binary that was
 * downloaded but never `chmod +x`-ed exists and still fails with EACCES the
 * moment a job starts. Better to report it missing now, on a settings screen
 * that tells the user to re-run the fetch script, than mid-transcription.
 * Windows has no execute bit, so existence is the whole question there.
 */
function runnable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * One row per binary, for the settings screen.
 *
 * Deliberately not cached. A developer who has just run `npm run binaries:fetch`
 * with the app open should see the answer change on the next render instead of
 * being told to restart — and four `access()` calls cost nothing next to how
 * rarely this is asked.
 */
export function engineReport(): { name: string; path: string; present: boolean }[] {
  return REQUIRED_BINARIES.map((name) => {
    const file = binaryPath(name);
    return { name, path: file, present: runnable(file) };
  });
}

export function enginesReady(): boolean {
  return REQUIRED_BINARIES.every((name) => runnable(binaryPath(name)));
}

/**
 * The third-party licence notice covering the vendored binaries and the models.
 *
 * ffmpeg is LGPL/GPL and whisper.cpp is MIT; shipping their binaries obliges us
 * to ship their notices, and `app:licenses` reads this file to show them.
 *
 * The candidate list exists because two different tools decide where the file
 * lands — the fetch script writes it next to the binaries it downloaded, the
 * builder copies it into `resources/` — and a licence notice that fails to open
 * because one of them moved is a compliance problem, not a cosmetic one. When
 * none of the candidates exists we still return the canonical path, so the IPC
 * handler can show a single clear "not found, expected here" message rather
 * than an empty string.
 */
export function licenseNoticePath(): string {
  const candidates = packaged()
    ? [join(process.resourcesPath, NOTICE_FILE), join(process.resourcesPath, 'bin', NOTICE_FILE)]
    : [join(repoRoot(), 'vendor', NOTICE_FILE), join(binDir(), NOTICE_FILE), join(repoRoot(), NOTICE_FILE)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? join(repoRoot(), NOTICE_FILE);
}
