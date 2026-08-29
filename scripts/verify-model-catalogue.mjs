#!/usr/bin/env node
/**
 * Re-read every entry of `electron/shared/models.ts` from Hugging Face and fail
 * if the pinned `bytes` or `sha256` no longer describes the file upstream.
 *
 *     node scripts/verify-model-catalogue.mjs
 *     node scripts/verify-model-catalogue.mjs --json
 *
 * WHAT THIS CATCHES: a model that was re-uploaded under the same path. Hugging
 * Face repositories are mutable — `main` moves, and a "fixed quantization" or a
 * "re-converted with the new script" commit replaces the bytes at a URL the app
 * has already shipped. `model-store.ts` verifies each download against the
 * pinned SHA-256, so after such a re-upload every download fails integrity on
 * the user's machine, correctly and uselessly. This script moves that discovery
 * into CI, where the answer is "update the catalogue" rather than "reinstall".
 *
 * WHY IT PARSES THE TYPESCRIPT WITH A REGEX INSTEAD OF IMPORTING IT:
 * because it has to run on a bare checkout with nothing built and no TypeScript
 * toolchain — a scheduled CI job whose entire body is `node scripts/…`, with no
 * `npm ci` in front of it and no `out/` directory to import from. The three
 * alternatives were all worse:
 *   - `import('../electron/shared/models.ts')` — Node's type stripping is
 *     recent and flag-gated across the versions contributors actually run, and
 *     an ERR_UNKNOWN_FILE_EXTENSION at 3 a.m. is not a useful CI failure.
 *   - depend on `typescript` and transpile — makes the check need `npm ci`,
 *     which for this repo also triggers `postinstall` and downloads ~40 MB of
 *     engine binaries this script has no use for.
 *   - build first — same, plus a build.
 * The cost is that the parser below knows the *shape* of the catalogue: object
 * literals with `url`, `bytes` and `sha256`, and `${CONST}` placeholders
 * defined as top-level string constants above them. If someone restructures
 * that file, this script fails loudly with "no entries found" rather than
 * silently verifying nothing — which is the one failure mode a regex parser
 * must not have.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = join(REPO_ROOT, 'electron', 'shared', 'models.ts');
const HF_API = 'https://huggingface.co/api/models';

/** Long enough for a slow runner, short enough that a hung CI job still fails. */
const TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const asJson = args.includes('--json');

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'Usage: node scripts/verify-model-catalogue.mjs [--json]\n\n' +
      "Checks every entry in electron/shared/models.ts against Hugging Face's LFS\n" +
      'metadata. Exits 1 if any pinned size or SHA-256 has drifted.\n',
  );
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`verify-model-catalogue: ${message}\n`);
  process.exit(2);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Split `[ {...}, {...} ]` into its top-level object literals.
 *
 * Brace counting rather than a regex because entries contain nested arrays
 * (`languages: [...]`) and a non-greedy `\{.*?\}` stops at the first inner
 * brace it meets. String literals are skipped so a `}` inside a blurb — or
 * inside the `${HF}` of a template literal — cannot close an entry.
 */
function splitObjects(source) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let quote = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Resolve `${NAME}` against the top-level `const NAME = '…'` declarations.
 *
 * The catalogue builds its URLs from `HF`, `WHISPER_REPO` and `PARAKEET_REPO`,
 * and those nest one inside another, so this substitutes repeatedly until the
 * value is literal. The iteration cap is there so a hypothetical `const A =
 * `${A}`` is a clear error rather than a hang.
 */
function makeExpander(source) {
  const constants = new Map();
  const declaration = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([\s\S]*?)\2\s*;/gm;
  for (const match of source.matchAll(declaration)) {
    constants.set(match[1], match[3]);
  }

  return (value) => {
    let out = value;
    for (let round = 0; round < 8 && out.includes('${'); round++) {
      out = out.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name) =>
        constants.has(name) ? constants.get(name) : whole,
      );
    }
    if (out.includes('${')) fail(`could not resolve a template placeholder in: ${value}`);
    return out;
  };
}

function field(objectSource, name) {
  // Accepts a single-quoted, double-quoted or backticked value; the catalogue
  // uses all three depending on whether the string interpolates.
  const match = new RegExp(`\\b${name}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(objectSource);
  return match === null ? null : match[2];
}

function parseCatalogue() {
  let source;
  try {
    source = readFileSync(CATALOGUE, 'utf8');
  } catch (error) {
    fail(`cannot read ${CATALOGUE}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const arrayStart = source.indexOf('LOCAL_MODELS');
  if (arrayStart < 0) fail(`no LOCAL_MODELS in ${CATALOGUE}`);
  const bracket = source.indexOf('[', arrayStart);
  if (bracket < 0) fail(`LOCAL_MODELS is not an array literal in ${CATALOGUE}`);

  const expand = makeExpander(source);
  const entries = [];

  for (const object of splitObjects(source.slice(bracket))) {
    const id = field(object, 'id');
    const rawUrl = field(object, 'url');
    const sha256 = field(object, 'sha256');
    // `bytes: 1_624_555_275` — numeric separators are legal TypeScript and are
    // used throughout the catalogue, so they have to come out before Number().
    const bytesMatch = /\bbytes\s*:\s*([\d_]+)/.exec(object);

    if (id === null || rawUrl === null || sha256 === null || bytesMatch === null) continue;

    entries.push({
      id,
      fileName: field(object, 'fileName') ?? '',
      url: expand(rawUrl),
      bytes: Number(bytesMatch[1].replace(/_/g, '')),
      sha256: sha256.toLowerCase(),
    });
  }

  // A parser that finds nothing must be an error. Reporting "0 entries, all
  // fine" is how a refactor of models.ts silently disables this whole check.
  if (entries.length === 0) fail(`parsed 0 entries out of ${CATALOGUE} — has the catalogue's shape changed?`);
  return entries;
}

/**
 * Split a Hugging Face `resolve` URL into the pieces the API wants.
 *
 * `https://huggingface.co/<owner>/<name>/resolve/<revision>/<path>` is the only
 * form the catalogue uses, and being strict about it means a URL pointing
 * somewhere else — a mirror, a release asset — is reported rather than turned
 * into a nonsense API call.
 */
function locate(url) {
  const match = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url);
  if (match === null) return null;
  return { repo: match[1], revision: match[2], path: match[3] };
}

// ── Hugging Face ────────────────────────────────────────────────────────────

/**
 * Ask one repository about several paths at once.
 *
 * `paths-info` takes an array, so the whole catalogue costs one request per
 * repository instead of one per model — which matters because unauthenticated
 * calls are rate limited and a scheduled job that trips the limit reports
 * drift that is not there.
 */
async function pathsInfo(repo, revision, paths) {
  const endpoint = `${HF_API}/${repo}/paths-info/${encodeURIComponent(revision)}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    fail(`${repo}: request failed — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    fail(`${repo}: paths-info returned HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  if (!Array.isArray(body)) fail(`${repo}: paths-info did not return an array`);

  const byPath = new Map();
  for (const item of body) {
    if (item !== null && typeof item === 'object' && typeof item.path === 'string') {
      byPath.set(item.path, item);
    }
  }
  return byPath;
}

// ── Comparison ──────────────────────────────────────────────────────────────

async function main() {
  const entries = parseCatalogue();

  // Grouped by repo *and* revision: two entries pinned to different revisions
  // of the same repository are two different questions.
  const groups = new Map();
  for (const entry of entries) {
    const where = locate(entry.url);
    if (where === null) fail(`${entry.id}: url is not a huggingface.co resolve URL — ${entry.url}`);
    entry.where = where;
    const key = `${where.repo}@${where.revision}`;
    const group = groups.get(key) ?? { repo: where.repo, revision: where.revision, paths: [] };
    group.paths.push(where.path);
    groups.set(key, group);
  }

  const lookups = new Map();
  for (const [key, group] of groups) {
    lookups.set(key, await pathsInfo(group.repo, group.revision, group.paths));
  }

  const results = entries.map((entry) => {
    const key = `${entry.where.repo}@${entry.where.revision}`;
    const info = lookups.get(key).get(entry.where.path);

    if (info === undefined) {
      return {
        id: entry.id,
        file: entry.where.path,
        repo: entry.where.repo,
        ok: false,
        problem: 'not found upstream',
        bytes: { pinned: entry.bytes, upstream: null, ok: false },
        sha256: { pinned: entry.sha256, upstream: null, ok: false },
      };
    }

    // The size and the hash both come from the LFS pointer when there is one.
    // `info.size` on a non-LFS file is the real size but there is no oid to
    // compare, and every model in this catalogue is an LFS object — a plain
    // file here means the upstream repo was restructured, which is exactly the
    // sort of change that should stop the build.
    const lfs = info.lfs ?? null;
    const upstreamBytes = typeof lfs?.size === 'number' ? lfs.size : typeof info.size === 'number' ? info.size : null;
    const upstreamSha = typeof lfs?.oid === 'string' ? lfs.oid.toLowerCase() : null;

    const bytesOk = upstreamBytes === entry.bytes;
    const shaOk = upstreamSha !== null && upstreamSha === entry.sha256;

    return {
      id: entry.id,
      file: entry.where.path,
      repo: entry.where.repo,
      ok: bytesOk && shaOk,
      ...(upstreamSha === null ? { problem: 'no LFS metadata upstream — is this still an LFS file?' } : {}),
      bytes: { pinned: entry.bytes, upstream: upstreamBytes, ok: bytesOk },
      sha256: { pinned: entry.sha256, upstream: upstreamSha, ok: shaOk },
    };
  });

  const drifted = results.filter((r) => !r.ok);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: drifted.length === 0, checked: results.length, entries: results }, null, 2)}\n`);
    process.exit(drifted.length === 0 ? 0 : 1);
  }

  report(results, drifted);
  process.exit(drifted.length === 0 ? 0 : 1);
}

const group3 = (n) => (n === null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

function report(results, drifted) {
  const idWidth = Math.max(5, ...results.map((r) => r.id.length));
  const bytesWidth = Math.max(11, ...results.map((r) => group3(r.bytes.pinned).length));

  // The drift marker is padded onto every row, present or not, so a failing
  // run's columns line up with a passing one's instead of shifting by two.
  const mark = (ok) => (ok ? '   ' : ' ✗ ');
  const line = (id, bytes, sha, status) =>
    `${id.padEnd(idWidth)}  ${bytes.padStart(bytesWidth + 3)}  ${sha.padEnd(12)}  ${status}`;

  process.stdout.write(`Checked ${results.length} entries against huggingface.co\n\n`);
  process.stdout.write(line('MODEL', 'BYTES', 'SHA-256', 'RESULT') + '\n');
  for (const r of results) {
    // First eight hex characters only: enough to see at a glance which file a
    // row is, and short enough that the table survives an 80-column CI log.
    const sha = `${r.sha256.pinned.slice(0, 8)}…${mark(r.sha256.ok)}`;
    const status = r.ok ? 'ok' : `FAIL${r.problem !== undefined ? ` (${r.problem})` : ''}`;
    process.stdout.write(line(r.id, `${group3(r.bytes.pinned)}${mark(r.bytes.ok)}`, sha, status) + '\n');
  }

  if (drifted.length === 0) {
    process.stdout.write('\nEverything matches upstream.\n');
    return;
  }

  process.stdout.write(`\n${drifted.length} entr${drifted.length === 1 ? 'y has' : 'ies have'} drifted:\n`);
  for (const r of drifted) {
    process.stdout.write(`\n  ${r.id}  (${r.repo}/${r.file})\n`);
    if (r.problem !== undefined) process.stdout.write(`    ${r.problem}\n`);
    if (!r.bytes.ok) {
      process.stdout.write(`    bytes    pinned ${group3(r.bytes.pinned)}   upstream ${group3(r.bytes.upstream)}\n`);
    }
    if (!r.sha256.ok) {
      process.stdout.write(`    sha256   pinned ${r.sha256.pinned}\n`);
      process.stdout.write(`             upstream ${r.sha256.upstream ?? '—'}\n`);
    }
  }

  // The exact lines to paste. A verifier that reports drift and leaves you to
  // retype a 64-character hash is a verifier people work around.
  process.stdout.write('\nTo re-pin, in electron/shared/models.ts:\n');
  for (const r of drifted) {
    process.stdout.write(`\n  // ${r.id}\n`);
    if (!r.bytes.ok && r.bytes.upstream !== null) {
      // Underscore separators to match the surrounding file's style.
      process.stdout.write(`  bytes: ${String(r.bytes.upstream).replace(/\B(?=(\d{3})+(?!\d))/g, '_')},\n`);
    }
    if (!r.sha256.ok && r.sha256.upstream !== null) {
      process.stdout.write(`  sha256: '${r.sha256.upstream}',\n`);
    }
  }
  process.stdout.write(
    '\nBefore pasting: confirm upstream actually re-published the file, rather than\n' +
      'this being a mirror, a redirect or a truncated response. A hash copied from a\n' +
      'compromised answer is a hash that verifies nothing.\n',
  );
}

await main();
