#!/usr/bin/env node
/**
 * Run the vendored binaries and assert they still speak the interface the
 * adapters parse.
 *
 *     node scripts/check-engine-binaries.mjs
 *
 * WHAT THIS IS FOR. `electron/engines/whisper-cpp.ts` and
 * `electron/engines/parakeet-cpp.ts` are built around a handful of measured
 * facts about two CLIs — which flags exist, and therefore what comes out of
 * them. `docs/engines/verification.md` records those measurements; this script
 * is the part of that document that executes. The day `scripts/fetch-binaries.mjs`
 * is repointed at a newer whisper.cpp tag, this is what notices that the
 * ground moved, in CI, instead of a user noticing that every transcript is
 * empty.
 *
 * WHY IT ONLY READS `--help` AND NEVER TRANSCRIBES ANYTHING. A real end-to-end
 * run would need a model — 0.6 to 3 GB, downloaded per CI job — and a sample
 * file, to check a property (the output format) that the option set already
 * determines. `--help` costs milliseconds and catches the thing that actually
 * changes upstream: a renamed or removed flag. What it cannot catch is a flag
 * that keeps its name and changes its output; only re-measuring catches that,
 * which is what verification.md's "How to re-measure" section is for.
 *
 * WHY A MISSING `vendor/bin` IS A SKIP AND NOT A FAILURE. That directory is
 * filled by `postinstall`, is gitignored, and is absent on a fresh clone, in a
 * lint-only CI lane, and on any machine where someone ran `npm ci
 * --ignore-scripts`. Failing there would train everyone to ignore this script.
 * It skips loudly, with the command to fix it, and returns 0.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, targetKey, vendoredDir, vendoredPath } from './binaries.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the binaries live, asked of the module that owns the answer.
 *
 * `electron/binaries-runtime.ts` knows this too, but it imports `electron`,
 * which would drag an Electron install and a build step into a script whose
 * whole point is to run on a bare checkout with `node` and nothing else.
 * `scripts/binaries.mjs` is the copy written for exactly that situation, and
 * the fetcher already uses it — so a target directory this script cannot find
 * is a target the fetcher never filled, rather than the two disagreeing.
 */
const TARGET = targetKey(process.platform, process.arch);
const BIN_DIR = vendoredDir(REPO_ROOT, TARGET);

/** Nine seconds: `--help` and `-version` return instantly or something is wrong. */
const TIMEOUT_MS = 9_000;

function binary(name) {
  return vendoredPath(REPO_ROOT, TARGET, name);
}

/**
 * Present and executable.
 *
 * The execute bit matters here for the same reason it does in
 * `binaries-runtime.ts`: a binary unpacked without `chmod +x` exists, and
 * every spawn of it fails with EACCES. Windows has no execute bit, so
 * existence is the whole question there.
 */
function runnable(file) {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a binary and return its combined output.
 *
 * stdout and stderr are merged because whisper.cpp prints its usage to
 * *stderr* and its transcript to stdout, and a checker that watched only
 * stdout would conclude that `whisper-cli --help` says nothing at all. The
 * exit code is returned but is not, on its own, the verdict — see `helpText`.
 */
function run(file, args) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

const failures = [];
const notes = [];

function failure(message) {
  failures.push(message);
}

/**
 * Does the help text advertise this flag?
 *
 * Anchored on whitespace and terminated by a comma, whitespace, `=` or the end
 * of the line, so looking for `-oj` does not match the `-ojf` on the next row —
 * which is the whole reason this is not `text.includes(flag)`.
 */
function advertises(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(,|\\s|=|$)`, 'm').test(text);
}

/** Get `--help` out of a CLI, or record why we could not. */
function helpText(name) {
  const file = binary(name);
  const result = run(file, ['--help']);

  if (result.error !== null) {
    failure(`${name}: could not be run — ${result.error.message}. Path: ${file}`);
    return null;
  }
  if (result.signal !== null) {
    // On macOS this is usually Gatekeeper killing an unsigned, quarantined
    // download; the fix is re-fetching, not re-signing by hand.
    failure(`${name}: killed by signal ${result.signal} before it printed anything. Path: ${file}`);
    return null;
  }
  // The exit code is not the test. whisper.cpp's usage printer exits 0, other
  // CLIs exit 1 on --help, and both are fine as long as the text appeared.
  if (result.output.trim() === '') {
    failure(`${name}: --help produced no output at all (exit ${String(result.status)}). Path: ${file}`);
    return null;
  }
  return result.output;
}

function requireFlags(name, text, flags, why) {
  const missing = flags.filter((flag) => !advertises(text, flag));
  if (missing.length === 0) {
    notes.push(`${name}: ${flags.join(' ')} — all present`);
    return;
  }
  failure(
    `${name}: no longer advertises ${missing.join(', ')}.\n` +
      `      ${why}\n` +
      `      Re-measure with \`${binary(name)} --help\` and update docs/engines/verification.md before touching the adapter.`,
  );
}

// ── Skip, or don't ──────────────────────────────────────────────────────────

const REQUIRED = TOOLS;
const present = REQUIRED.filter((name) => existsSync(binary(name)));

if (!existsSync(BIN_DIR) || present.length === 0) {
  process.stdout.write(
    `check-engine-binaries: SKIPPED — no vendored binaries in\n` +
      `  ${BIN_DIR}\n` +
      `Run \`npm run binaries:fetch\` to populate it, then run this again.\n`,
  );
  process.exit(0);
}

// A directory that exists with only *some* of the binaries in it is a broken
// fetch, not an un-run one, and silently skipping it would hide exactly the
// half-populated state that makes `enginesReady()` false on a user's machine.
const absent = REQUIRED.filter((name) => !existsSync(binary(name)));
if (absent.length > 0) {
  failure(
    `${BIN_DIR} is half-populated: ${absent.join(', ')} missing while ${present.join(', ')} are present.\n` +
      `      Delete the directory and re-run \`npm run binaries:fetch\`.`,
  );
}

for (const name of present) {
  if (!runnable(binary(name))) {
    failure(`${name}: exists but is not executable. \`chmod +x ${binary(name)}\`, or re-run \`npm run binaries:fetch\`.`);
  }
}

process.stdout.write(`Checking ${BIN_DIR}\n\n`);

// ── whisper-cli ─────────────────────────────────────────────────────────────

// `runnable`, not `existsSync`: a binary that is present but not executable has
// already been reported above, and spawning it would only add an EACCES line
// saying the same thing a second time.
const whisperHelp = runnable(binary('whisper-cli')) ? helpText('whisper-cli') : null;
if (whisperHelp !== null) {
  // These five are the flags whose disappearance would change the *shape* of
  // the output rather than stopping the run: without -oj/-ojf there is no
  // per-token JSON to read `offsets` and `p` out of, without -of the file
  // lands somewhere the adapter does not look, without -pp the progress bar
  // sits at zero for the whole job, and without -l the language hint is
  // silently dropped. `-m`, `-f`, `-t`, `-np` and `-tr` are passed too, but
  // losing one of those makes the process exit with an error the adapter
  // already surfaces.
  requireFlags(
    'whisper-cli',
    whisperHelp,
    ['-oj', '-ojf', '-of', '-pp', '-l'],
    'electron/engines/whisper-cpp.ts passes these and parses the JSON they produce.',
  );
}

// ── parakeet-cli ────────────────────────────────────────────────────────────

const parakeetHelp = runnable(binary('parakeet-cli')) ? helpText('parakeet-cli') : null;
if (parakeetHelp !== null) {
  requireFlags(
    'parakeet-cli',
    parakeetHelp,
    ['-ps', '-m', '-f', '-np'],
    'electron/engines/parakeet-cpp.ts passes these and parses the -ps segment lines.',
  );

  /**
   * The inverse assertion: parakeet-cli must still have NO language flag.
   *
   * `LocalRunRequest.language` is deliberately ignored by the Parakeet adapter
   * because v3 detects its own language and the CLI has nothing to pass a hint
   * to — see verification.md item 5. That is a defensible design only while it
   * remains true. If upstream adds one, this check fails on purpose, and the
   * fix is not to relax the check: it is to wire the hint through and let the
   * UI stop hiding the language picker for this engine.
   */
  const languageFlags = ['--language', '--lang', '-l'].filter((flag) => advertises(parakeetHelp, flag));
  if (languageFlags.length > 0) {
    failure(
      `parakeet-cli: now advertises ${languageFlags.join(', ')} — this is GOOD NEWS, not a regression.\n` +
        `      electron/engines/parakeet-cpp.ts currently ignores LocalRunRequest.language because no such\n` +
        `      flag existed. Pass it through, let the UI offer a language for this engine, update\n` +
        `      docs/engines/verification.md item 5, then remove this assertion.`,
    );
  } else {
    notes.push('parakeet-cli: still has no language flag — LocalRunRequest.language stays ignored');
  }
}

// ── ffmpeg / ffprobe ────────────────────────────────────────────────────────

// `-version` rather than `--help`: it is the smallest thing these two can be
// asked to do that proves the binary loads, links and executes, and its first
// line names the build, which is worth having in the CI log the day an
// extraction starts producing a different WAV.
for (const name of ['ffmpeg', 'ffprobe']) {
  if (!runnable(binary(name))) continue;
  const file = binary(name);
  const result = run(file, ['-version']);

  if (result.error !== null) {
    failure(`${name}: could not be run — ${result.error.message}. Path: ${file}`);
    continue;
  }
  if (result.status !== 0) {
    failure(`${name} -version exited ${String(result.status)}${result.signal !== null ? ` (signal ${result.signal})` : ''}. Path: ${file}`);
    continue;
  }
  const first = result.output.trim().split('\n')[0] ?? '';
  if (!first.startsWith(`${name} version`)) {
    failure(`${name} -version printed ${JSON.stringify(first)}, which does not begin with "${name} version". Is this the right binary?`);
    continue;
  }
  notes.push(`${name}: ${first}`);
}

// ── Verdict ─────────────────────────────────────────────────────────────────

for (const note of notes) process.stdout.write(`  ok  ${note}\n`);

if (failures.length === 0) {
  process.stdout.write('\nAll vendored binaries still speak the interface the adapters expect.\n');
  process.exit(0);
}

process.stderr.write(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:\n\n`);
for (const message of failures) process.stderr.write(`  ✗  ${message}\n\n`);
process.exit(1);
