/**
 * Materialise vendor/bin/<platform>-<arch>/ from vendor/binaries.json.
 *
 * Idempotent by hash: a slot whose bytes already match the pin is not
 * re-downloaded. That is what makes this safe to run from `postinstall`, safe
 * to run twice in a release job that needs two Mac architectures out of one
 * checkout, and safe to run by hand on a Windows box where `npm install` must
 * not be.
 *
 * Archives are extracted with the system `tar` rather than a library: bsdtar
 * reads .zip as well as .tar.*, and it is `tar` on macOS and on Windows 10
 * 1803+, so one code path covers every source in the manifest and the project
 * gains no dependency for it. Node built-ins do the rest.
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  NOTICE_NAME,
  exeName,
  extraMembersFor,
  licenseEntry,
  licenseFilesFor,
  licenseNotice,
  loadManifest,
  platformOf,
  readBinaryAt,
  sha256,
  targetEntries,
  targetKey,
  vendoredDir
} from './binaries.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Ten minutes, covering connect, headers and the whole body.
 *
 * The largest thing fetched here is BtbN's 168 MB win64-gpl zip, so the number
 * is generous on purpose — it is not a latency budget. It is the difference
 * between a job that fails and a `postinstall` that hangs forever on a
 * connection which was accepted and then went quiet; Node's fetch applies no
 * overall deadline of its own, and a stalled socket is the one network failure
 * that never resolves itself.
 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const say = (line) => process.stdout.write(`${line}\n`);

/**
 * Turn whatever fetch threw into a sentence that names the actual problem.
 *
 * The raw abort surfaces as a bare "This operation was aborted", which reads
 * like a bug in this script rather than a network that went quiet — and the two
 * call for completely different responses from whoever is looking at the log.
 */
function describeDownloadFailure(url, error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new Error(
      `${url} → the connection was accepted but nothing arrived for ${DOWNLOAD_TIMEOUT_MS / 1000}s, so it was ` +
        'given up on. This is a stalled transfer, not a failed one: the host is reachable and nothing has ' +
        'refused us. Retrying usually works; a proxy that buffers large release assets is the usual cause.'
    );
  }
  return new Error(`${url} → ${error?.message ?? String(error)}`);
}

/** A small file — a licence text — straight into memory. */
async function downloadBuffer(url) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw describeDownloadFailure(url, error);
  }
}

/**
 * A release asset onto disk, streamed.
 *
 * Buffering the whole response first would be four lines shorter and is what
 * this used to do. It also means holding 168 MB of zip in the heap at the
 * moment `tar` is about to read it out of a file anyway — on a CI runner with
 * everything else Electron needs already resident. Streaming costs nothing here
 * because no caller wants the archive as bytes; they want a path to hand to
 * tar.
 */
async function downloadToFile(url, file) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('the response carried no body');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  } catch (error) {
    throw describeDownloadFailure(url, error);
  }
}

/**
 * The bytes of the one file we want, out of whatever container it arrived in.
 *
 * `archive: "tar"` names the EXTRACTOR, not the container. The entries using it
 * today point at .zip assets, which bsdtar reads happily — that shorthand is
 * fine on the two platforms this project builds on and it is a trap anywhere
 * else, because GNU tar cannot read a zip at all. A Linux host running
 * `--write-hashes` (the one command that fetches targets the machine cannot
 * use) fails here, on the zip, with tar's own error. Fix that by extracting
 * with `bsdtar`/`libarchive` on that host, not by renaming the field: a `"zip"`
 * kind that ran the same command would be no truer.
 */
export function extract({ archive, member }, archiveFile) {
  if (archive === 'gz') return gunzipSync(readFileSync(archiveFile));
  if (archive !== 'tar') throw new Error(`unknown archive kind: ${archive}`);
  if (!member) throw new Error('a "tar" entry needs a "member"');
  // -O writes the member to stdout; maxBuffer because ffmpeg.exe alone is
  // 144 MB and the default would truncate it into a corrupt binary rather
  // than fail.
  return execFileSync('tar', ['-xOf', archiveFile, member], { maxBuffer: 512 * 1024 * 1024 });
}

/**
 * The actionable refusal for a slot the manifest does not pin.
 *
 * An entry with no hash is NOT "unpinned, take it on trust". It is an entry
 * that would install unverified bytes on every machine that runs
 * `postinstall`, which is the one thing this script exists to prevent, so a
 * missing pin fails exactly as hard as a wrong one. It happens when a target is
 * added by hand and `--write-hashes` is never run afterwards.
 */
function unpinned(label, key) {
  return new Error(
    `${label}: vendor/binaries.json pins no sha256, so these bytes cannot be verified and nothing was ` +
      'written. Fill it in by measuring, then commit the diff:\n' +
      `    npm run binaries:hashes -- --target ${key}\n` +
      '  (that is `node scripts/fetch-binaries.mjs --write-hashes --target ' + key + '`.)'
  );
}

/**
 * Put one file where it belongs, or refuse and write nothing.
 *
 * One function for the executables and for the DLLs beside them, because they
 * have the same contract: pinned bytes out of a pinned archive, or an error. On
 * Windows the DLLs are every bit as load-bearing as the .exe — a missing
 * `ggml-base.dll` is a process that dies before `main` — so treating them as a
 * softer class of file would be a fiction.
 */
async function place({ dir, name, spec, label, key, archiveFor, writeHashes, setHash, executable }) {
  const destination = join(dir, name);

  // Per file, not per target: a directory that lost one binary must fill the
  // hole rather than re-download everything, or — worse — decide the target is
  // "done" because most of it is there.
  const present = readBinaryAt(destination);
  if (!writeHashes && spec.sha256 && present && present.sha256 === spec.sha256) {
    say(`  · ${label} (already here)`);
    return;
  }
  // Checked BEFORE the download, unlike the obvious ordering. Nothing about
  // the bytes can make an unpinned slot acceptable, and finding that out after
  // pulling 168 MB is a worse version of the same refusal.
  if (!writeHashes && !spec.sha256) throw unpinned(label, key);

  say(`  ↓ ${label}`);
  const bytes = extract(spec, await archiveFor(spec.url));
  const digest = sha256(bytes);

  if (writeHashes) setHash(digest);
  else if (spec.sha256 !== digest) {
    throw new Error(
      `${label}: the downloaded bytes hash ${digest}, and vendor/binaries.json pins ${spec.sha256}. Nothing ` +
        'was written. Either the upstream asset was replaced in place, or this is not the file we pinned — ' +
        'and both of those are the reason this check exists.'
    );
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(destination, bytes);
  // Windows has no execute bit, and `chmodSync` there only toggles the
  // read-only flag, so the guard is about the HOST rather than the target: a
  // Mac fetching win32-x64 for a cross-packaged installer has nothing useful
  // to say about a .dll's mode either.
  if (executable && process.platform !== 'win32') chmodSync(destination, 0o755);
}

/**
 * The licence texts and the notice that have to travel with the executables.
 *
 * Written on every run rather than only after a download: the
 * skip-because-it-already-matches path is the common one, and a checkout
 * populated before this existed would otherwise keep a directory with no
 * notice in it forever. They land inside `vendor/bin/<key>/`, which
 * electron-builder copies wholesale into `Resources/bin`, so shipping them
 * needs no packaging change and no second list of files for someone to forget.
 *
 * The notice is regenerated unconditionally because it is derived — it costs a
 * string concatenation, and the alternative is a notice that names last
 * month's version after a repin.
 */
async function writeLicenses(dir, manifest, key, writeHashes) {
  mkdirSync(dir, { recursive: true });
  for (const name of licenseFilesFor(manifest, key)) {
    const entry = licenseEntry(manifest, name);
    const destination = join(dir, name);
    if (!writeHashes && entry.sha256 && existsSync(destination) && sha256(readFileSync(destination)) === entry.sha256) {
      continue;
    }
    if (!writeHashes && !entry.sha256) throw unpinned(`${key}: ${name}`, key);

    say(`  ↓ ${key}/${name}`);
    const bytes = await downloadBuffer(entry.url);
    const digest = sha256(bytes);
    if (writeHashes) entry.sha256 = digest;
    else if (digest !== entry.sha256) {
      throw new Error(
        `${key}: ${name} hashes ${digest}, and vendor/binaries.json pins ${entry.sha256}. Nothing was ` +
          'written. Somebody else\'s licence terms changed under a pinned URL, which is worth reading before ' +
          'repinning.'
      );
    }
    writeFileSync(destination, bytes);
  }
  writeFileSync(join(dir, NOTICE_NAME), licenseNotice(manifest, key));
}

export async function fetchTargets(root, keys, { writeHashes = false } = {}) {
  const manifest = loadManifest(root);
  const scratch = mkdtempSync(join(tmpdir(), 'dropscribe-binaries-'));

  // Two entries can name the SAME archive: win32-x64's ffmpeg and ffprobe are
  // two members of one 168 MB zip, and its whisper-cli and parakeet-cli are
  // fourteen members of another. Without this, fetching that target would pull
  // each archive once per file inside it. Keyed by url and scoped to a single
  // call — there is no on-disk cache and nothing survives the run, so a repin
  // can never be served stale bytes.
  const archives = new Map();
  const archiveFor = async (url) => {
    let file = archives.get(url);
    if (!file) {
      file = join(scratch, `archive-${archives.size}`);
      await downloadToFile(url, file);
      archives.set(url, file);
    }
    return file;
  };

  try {
    for (const key of keys) {
      const platform = platformOf(key);
      const dir = vendoredDir(root, key);
      const entries = targetEntries(manifest, key);
      // Called for its validation, not its return value: it is the one place
      // that catches two entries claiming the same destination filename with
      // different sources, which would otherwise resolve to whichever tool
      // happened to be written last.
      extraMembersFor(manifest, key);

      for (const { tool, entry } of entries) {
        await place({
          dir,
          name: exeName(tool, platform),
          spec: { url: entry.url, archive: entry.archive, member: entry.member, sha256: entry.sha256 ?? null },
          label: `${key}/${tool}  ${entry.version}`,
          key,
          archiveFor,
          writeHashes,
          setHash: (digest) => {
            entry.sha256 = digest;
          },
          executable: true
        });
      }

      // Iterated off the raw entries rather than `extraMembersFor`'s
      // deduplicated copies, because `--write-hashes` has to write the measured
      // digest back into the object that gets serialised. The `seen` set gives
      // the same deduplication without losing the reference.
      const seen = new Set();
      for (const { entry } of entries) {
        for (const extra of entry.extraMembers ?? []) {
          if (seen.has(extra.file)) continue;
          seen.add(extra.file);
          await place({
            dir,
            name: extra.file,
            spec: { url: entry.url, archive: entry.archive, member: extra.member, sha256: extra.sha256 ?? null },
            label: `${key}/${extra.file}`,
            key,
            archiveFor,
            writeHashes,
            setHash: (digest) => {
              extra.sha256 = digest;
            },
            executable: false
          });
        }
      }

      await writeLicenses(dir, manifest, key, writeHashes);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (writeHashes) {
    writeFileSync(join(root, 'vendor', 'binaries.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    say('  ✓ measured hashes written to vendor/binaries.json — review the diff before committing');
  }
}

export function parse(argv) {
  const targets = [];
  let writeHashes = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--target needs a value, e.g. --target darwin-arm64');
      targets.push(value);
      i += 1;
    } else if (argv[i] === '--write-hashes') writeHashes = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return {
    writeHashes,
    // Whether a human named the target or it was inferred from the machine.
    // planCliFetch treats those two very differently.
    explicit: targets.length > 0,
    targets: targets.length ? targets : [targetKey(process.platform, process.arch)]
  };
}

/**
 * What the command line should do — and, on an unsupported host, what it should
 * decline to do.
 *
 * `postinstall` runs with no `--target`, so the key is inferred from the
 * machine. On a platform the manifest has no row for — Linux, today — throwing
 * would take `npm ci` down with it and nobody could clone the repository to run
 * the (almost entirely platform-independent) test suite. A postinstall script
 * with no binary to offer for the host should say so and get out of the way; it
 * is not the installer's place to refuse the install.
 *
 * An explicit `--target` is the opposite case and stays a hard error. Somebody
 * typed that key. Answering a typo, or a target nobody ever added, with a shrug
 * and an exit 0 is how a release gets cut believing it fetched something.
 *
 * `--write-hashes` covers every known target by default, because repinning is
 * normally a whole-manifest operation — but an explicit `--target` narrows it,
 * which the version this was modelled on did not allow. That matters when only
 * one target can be measured where you are standing: pinning what you can
 * measure and leaving the rest null is honest, and being forced to fetch all
 * three to record one is how placeholder hashes get invented.
 */
export function planCliFetch(manifest, { targets, writeHashes, explicit }) {
  const known = Object.keys(manifest.targets ?? {});
  const unknown = targets.filter((key) => !manifest.targets?.[key]);

  if (writeHashes) {
    if (!explicit) return { targets: known, writeHashes: true };
    if (unknown.length) {
      throw new Error(`vendor/binaries.json has no target ${unknown.join(', ')}. It knows: ${known.join(', ')}.`);
    }
    return { targets, writeHashes: true };
  }

  if (!unknown.length) return { targets, writeHashes: false };
  if (explicit) {
    throw new Error(`vendor/binaries.json has no target ${unknown.join(', ')}. It knows: ${known.join(', ')}.`);
  }
  return {
    targets: [],
    writeHashes: false,
    skip:
      `no engine binaries are pinned for ${unknown.join(', ')} — skipping. That platform is not a build ` +
      'target: the app cannot run here, but the test suite can.'
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const plan = planCliFetch(loadManifest(ROOT), parse(process.argv.slice(2)));
    if (plan.skip) say(`  · ${plan.skip}`);
    else await fetchTargets(ROOT, plan.targets, { writeHashes: plan.writeHashes });
  } catch (error) {
    console.error(`\n✗ ${error.message}\n`);
    process.exit(1);
  }
}
