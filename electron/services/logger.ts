/**
 * The application log, and the redaction that makes it safe to hand over.
 *
 * A log file exists to be read by someone else. The whole point of writing one
 * is the moment a user zips it into a GitHub issue, or pastes the last forty
 * lines into a bug report, and that moment is *by far* the most likely way an
 * API key escapes this app. Not a leaked request, not a stray `console.log` in
 * the renderer — a helpful user attaching the file we told them to attach.
 *
 * Which is why `redact` lives here and every field of every call goes through
 * it, rather than being a discipline imposed on call sites. Call-site
 * discipline works right up until the day someone logs an error object whose
 * `config.headers.authorization` they never thought about, and by then the key
 * is in a public issue tracker. One chokepoint that over-redacts is worth more
 * than twenty call sites that each remember.
 *
 * The second rule of this file is that it cannot throw. It is called from
 * `catch` blocks, from `finally` blocks, from process-exit handlers, and from
 * code that runs before `app.whenReady()` — all places where an exception is
 * either swallowed into confusion or replaces the real error with a disk error.
 * A logger that can crash the app is strictly worse than no logger, so every
 * public function here degrades to a no-op instead of failing.
 */

import * as electronModule from 'electron';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** What replaces anything that might be a secret. Deliberately unmistakable. */
const MASK = '[redacted]';

/**
 * Rotate at 2 MB, keep one previous file.
 *
 * Two megabytes of text is around fifteen thousand lines — comfortably more
 * than a single session produces, and small enough that a user can actually
 * attach it to an issue. Keeping exactly one previous file covers the common
 * shape of a bug report ("it broke, then I restarted and it broke again"),
 * without turning `<userData>/logs` into an archive nobody prunes.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** A single line is capped so one enormous field cannot consume the whole budget. */
const MAX_LINE_CHARS = 8 * 1024;

/** How deep `fields` is walked before we stop and print a placeholder. */
const MAX_DEPTH = 4;

/** How many array elements are kept. A transcript's word array is not a log field. */
const MAX_ARRAY_ITEMS = 32;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * `debug` is off by default.
 *
 * Progress ticks and per-chunk decode lines are exactly what `debug` is for,
 * and a two-hour transcription emits thousands of them — enough to rotate the
 * whole 2 MB budget away in a single job and destroy the file's usefulness as
 * a bug report. `DROPSCRIBE_LOG_LEVEL=debug` turns them back on when someone
 * is actually chasing something.
 */
function readThreshold(): number {
  const raw = process.env['DROPSCRIBE_LOG_LEVEL'];
  if (raw === undefined) return LEVEL_RANK.info;
  const key = raw.trim().toLowerCase();
  if (key === 'debug' || key === 'info' || key === 'warn' || key === 'error') return LEVEL_RANK[key];
  return LEVEL_RANK.info;
}

const THRESHOLD = readThreshold();

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Provider keys that announce themselves: `sk-…`, `sk_…`, `sk-or-v1-…`,
 * `sk-ant-api03-…`, `sk-proj-…`. The prefix is the whole tell, so the pattern
 * only has to be sure about the first three characters and greedy after that.
 */
const PREFIXED_KEY = /\bsk[-_][A-Za-z0-9_-]{8,}/g;

/** `Authorization: Bearer …` survives into logs inside serialized HTTP errors. */
const BEARER = /\b(bearer)\s+[^\s"',;]+/gi;

/**
 * `?api_key=…` / `&access_token=…` in a URL.
 *
 * Contract rule 6 says a key never reaches a logged URL in the first place.
 * This is the belt to that suspenders: query strings are assembled far from
 * here, and a URL is the one place a secret can hide inside a value that
 * otherwise looks exactly like something we *want* logged.
 */
const SENSITIVE_QUERY = /([?&][A-Za-z0-9_.-]*(?:key|token|secret|sig|password|auth)[A-Za-z0-9_.-]*=)[^&\s"']*/gi;

/**
 * A bare 32-or-more character run of hex or base64url — the shape of every key
 * that does *not* carry a prefix (ElevenLabs and AssemblyAI ship 32 hex chars,
 * Deepgram 40, Groq and OpenRouter longer base64url).
 *
 * `\b` is useless here because `-` and `_` are not word characters, so the
 * boundaries are spelled out as lookarounds over the same character class.
 */
const LONG_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;

/**
 * The one exemption to `LONG_RUN`.
 *
 * A UUID is 36 characters of the right alphabet and would be masked by the rule
 * above — and job ids are UUIDs. Redacting the job id would gut the log for the
 * exact purpose it exists: following one file through enqueue, extract, decode
 * and export. The exemption is safe because the shape is rigid (8-4-4-4-12, hex
 * only) and no provider issues a key that looks like that; anything that *is* a
 * secret and happens to be UUID-shaped is still caught by the field-name rule
 * below, which fires before any pattern is consulted.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Field names whose value is masked outright, whatever it looks like.
 *
 * This is the only rule that can catch a *short* secret — a twelve-character
 * legacy key that no entropy heuristic would ever flag. It matches as a
 * substring on purpose (`apiKey`, `x-api-key`, `refreshToken`, `clientSecret`),
 * and it is checked at every level of a nested object, because the place a key
 * actually hides is `{ request: { headers: { authorization: '…' } } }` rather
 * than the top level anyone would have thought to guard.
 */
const SENSITIVE_FIELD = /key|token|secret|authorization/i;

/**
 * Mask anything in `value` that could be an API key.
 *
 * The trade this makes is deliberate and one-directional: a false positive
 * costs a mangled filename in a log line, a false negative costs a user their
 * key. So a 34-character media filename with no separators *will* come out as
 * `[redacted]`, and that is the correct outcome. The same rule redacts long
 * content hashes, which are genuinely useful and genuinely indistinguishable
 * from a key — losing them is the price.
 */
export function redact(value: string): string {
  // Order matters only in that the prefixed and structural rules run first, so
  // their matches are already replaced by the time the broad `LONG_RUN` sweep
  // looks at what is left. `MASK` is nine characters and contains brackets, so
  // nothing re-matches a mask.
  return value
    .replace(PREFIXED_KEY, MASK)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(SENSITIVE_QUERY, `$1${MASK}`)
    .replace(LONG_RUN, (run) => (UUID.test(run) ? run : MASK));
}

/**
 * Walk one `fields` value into something that is safe to log and safe to
 * `JSON.stringify` — no cycles, no functions, no unbounded depth, no strings
 * that have not been through `redact`.
 */
function sanitize(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  // `undefined` becomes null rather than vanishing: that the caller passed the
  // field at all is information, and a silently absent key reads as a bug.
  if (typeof value === 'undefined') return null;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  if (typeof value !== 'object') return '[unserializable]';

  // An Error is the single most common thing anyone logs, and it is the one
  // thing `JSON.stringify` renders as `{}` — `message` and `stack` are
  // non-enumerable. Unpacking it by hand is the difference between a log that
  // explains a failure and a log that records that one happened.
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      ...(typeof value.stack === 'string' ? { stack: redact(value.stack) } : {}),
      ...(value.cause !== undefined ? { cause: sanitize(value.cause, depth + 1, seen) } : {}),
    };
  }

  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) kept.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
      return kept;
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // The field-name rule, applied at every level. Note that it masks the
      // value whatever its type: `{ hasApiKey: true }` comes out redacted too,
      // which loses a little and risks nothing.
      out[key] = SENSITIVE_FIELD.test(key) ? MASK : sanitize(nested, depth + 1, seen);
    }
    return out;
  } finally {
    // Removed on the way back up so a value referenced twice in a tree — the
    // same job object under two keys — prints twice instead of the second one
    // being reported as a cycle it is not.
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Where the file lives
// ---------------------------------------------------------------------------

/**
 * The slice of Electron's `app` this file needs, described loosely on purpose.
 *
 * `getPath` returns `unknown` rather than `string` so the check below is a real
 * runtime check and not one TypeScript optimises out of existence.
 */
interface AppLike {
  getPath(name: string): unknown;
}

/**
 * Electron's `app`, if there is one.
 *
 * Its neighbours in this directory write `import { app } from 'electron'` and
 * are right to: they only ever run in main, after ready. This file does not
 * have that luxury. It is imported by code that runs before `whenReady`, and it
 * may be imported into a worker where `electron` resolves to something that is
 * not the main-process module at all — in a plain Node process the same
 * specifier resolves to the npm package, whose export is a *string* path to the
 * Electron binary. Hence the walk through `unknown`: every step of it is a case
 * that actually occurs somewhere.
 */
function electronApp(): AppLike | null {
  const mod: unknown = electronModule;
  if (typeof mod !== 'object' || mod === null) return null;
  const candidate = (mod as Record<string, unknown>)['app'];
  if (typeof candidate !== 'object' || candidate === null) return null;
  if (typeof (candidate as Record<string, unknown>)['getPath'] !== 'function') return null;
  return candidate as AppLike;
}

/**
 * The resolved log path, cached once we have one.
 *
 * Only successes are cached. The first log line of a launch can easily arrive
 * before Electron knows its userData directory, and caching that failure would
 * mean the app logged nothing for the rest of the session because of one early
 * call — the opposite of what a logger is for.
 */
let cachedFile: string | null = null;

function resolveFile(): string | null {
  if (cachedFile !== null) return cachedFile;
  const app = electronApp();
  if (app === null) return null;
  try {
    const userData = app.getPath('userData');
    if (typeof userData !== 'string' || userData.length === 0) return null;
    cachedFile = join(userData, 'logs', 'dropscribe.log');
    return cachedFile;
  } catch {
    // `getPath` throws when the path is not configured yet. Not fatal, not
    // permanent — the next call tries again.
    return null;
  }
}

/**
 * Where the log is written.
 *
 * Returns the empty string when there is no writable location — the same
 * condition under which `log()` is a no-op. A UI offering a "Reveal log file"
 * affordance should treat an empty string as "there is no file", not as a path
 * to pass to the shell.
 */
export function logPath(): string {
  return resolveFile() ?? '';
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Bytes currently in the live log file, tracked rather than stat-ed per line.
 *
 * `null` means "unknown, stat before the next write" — which happens once per
 * launch. The count can drift if a second instance writes to the same file, and
 * that is fine: rotation is housekeeping, not correctness, and the worst
 * outcome of drift is a file that rotates a little late.
 */
let bytesInFile: number | null = null;
let dirEnsured = false;

function rotateIfNeeded(file: string, incomingBytes: number): void {
  if (bytesInFile === null) {
    try {
      bytesInFile = statSync(file).size;
    } catch {
      bytesInFile = 0;
    }
  }
  if (bytesInFile + incomingBytes <= MAX_BYTES) return;

  const previous = `${file}.1`;
  try {
    // The delete is not redundant. POSIX `rename` replaces an existing
    // destination silently; Windows `MoveFile` refuses one. Removing first
    // makes both platforms do the same thing.
    rmSync(previous, { force: true });
    renameSync(file, previous);
  } catch {
    // Rotation can fail when something else holds the file open — a text editor
    // on Windows, most often. We reset the counter anyway and let the log grow
    // by another 2 MB before trying again, because retrying a failing syscall on
    // every single line, or refusing to log at all, are both worse than a log
    // file that is occasionally larger than intended.
  }
  bytesInFile = 0;
}

function write(file: string, line: string): void {
  if (!dirEnsured) {
    mkdirSync(dirname(file), { recursive: true });
    dirEnsured = true;
  }
  const bytes = Buffer.byteLength(line, 'utf8');
  rotateIfNeeded(file, bytes);
  // Synchronous on purpose. Half of what gets logged is logged *because*
  // something is about to go wrong, and an async write queued microseconds
  // before a crash or a `process.exit` is a write that never lands. At this
  // app's line rate the syscall cost is unmeasurable.
  appendFileSync(file, line, 'utf8');
  bytesInFile = (bytesInFile ?? 0) + bytes;
}

function mirrorToConsole(level: LogLevel, line: string): void {
  const text = line.trimEnd();
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

/**
 * Write one line.
 *
 * The format is a readable prefix followed by the fields as JSON —
 * `2026-08-29T09:11:02.145Z warn  ffmpeg exited non-zero {"code":1}`. Pure
 * JSONL would be tidier to machine-parse and considerably worse at the job this
 * file actually has, which is being read by a human in a GitHub issue. The JSON
 * tail keeps the structure without costing the first read.
 *
 * Every string that goes into that line — message, field values, nested field
 * values, error messages, stack traces — has been through `redact` first.
 */
export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  try {
    if (LEVEL_RANK[level] < THRESHOLD) return;

    const safeMessage = redact(message);
    let tail = '';
    if (fields !== undefined) {
      const sanitized = sanitize(fields, 0, new Set<object>());
      if (sanitized !== null && typeof sanitized === 'object' && Object.keys(sanitized).length > 0) {
        // `sanitize` has already removed every cycle and every unserializable
        // value, so this cannot throw — but it is inside the outer try anyway,
        // because "cannot throw" is a claim this file is not willing to bet the
        // process on.
        tail = ` ${JSON.stringify(sanitized)}`;
      }
    }

    let line = `${new Date().toISOString()} ${level.padEnd(5)} ${safeMessage}${tail}`;
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…[truncated]`;
    line += '\n';

    // The console mirror comes first, and unconditionally. It is where a
    // developer reads these lines in `electron-vite dev`, and — more to the
    // point — it is the only output that still works when there is no userData
    // path to write to, so a no-op file logger does not leave us blind.
    mirrorToConsole(level, line);

    const file = resolveFile();
    if (file === null) return;
    write(file, line);
  } catch {
    // The one rule of this file. A full disk, a read-only volume, a userData
    // directory the user deleted while the app was running — none of them are
    // worth taking the app down for, and none of them are things the caller
    // could have done anything about.
  }
}
