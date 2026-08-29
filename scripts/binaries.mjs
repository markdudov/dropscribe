/**
 * Everything about the vendored engine binaries that is a pure function of its
 * inputs. The fetcher, the pack gate and anything else that wants to know where
 * a binary lives — or what machine it is for — all call this, so they cannot
 * disagree. A second opinion about either of those questions is how a project
 * ships an arm64 ffmpeg inside an Intel installer and finds out from a user.
 *
 * Plain `.mjs` with JSDoc types rather than TypeScript: these run from
 * `postinstall`, before anything has been compiled, and on a fresh clone where
 * `node_modules` is half-written. Node built-ins and the system `tar` only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every executable the app cannot run without, in the order the settings screen
 * lists them. Kept in the same order as `REQUIRED_BINARIES` in
 * `electron/binaries-runtime.ts`, which is the runtime's copy of this list —
 * the two are checked against each other by nothing, so if you add a fifth
 * tool, grep for that constant in the same commit.
 */
export const TOOLS = /** @type {const} */ (['ffmpeg', 'ffprobe', 'whisper-cli', 'parakeet-cli']);

export const targetKey = (platform, arch) => `${platform}-${arch}`;

export const exeName = (tool, platform) => (platform === 'win32' ? `${tool}.exe` : tool);

/** `darwin-arm64` → `darwin`. The arch is the last segment, never the first. */
export const platformOf = (key) => key.slice(0, key.lastIndexOf('-'));

/** The directory one target's binaries live in during development. */
export const vendoredDir = (root, key) => join(root, 'vendor', 'bin', key);

export function vendoredPath(root, key, tool) {
  return join(vendoredDir(root, key), exeName(tool, platformOf(key)));
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function loadManifest(root) {
  return JSON.parse(readFileSync(join(root, 'vendor', 'binaries.json'), 'utf8'));
}

/**
 * The generated notice that ships beside the binaries.
 *
 * The name is not free to choose: `licenseNoticePath()` in
 * `electron/binaries-runtime.ts` opens this exact filename to answer the
 * `app:licenses` IPC call, and it is the only consumer that matters — a notice
 * the About panel cannot open is a compliance document nobody ever reads. The
 * design spec calls the file `THIRD-PARTY-NOTICES.txt` and an earlier draft of
 * this script called it `THIRD-PARTY-LICENSES.md`; both lost to the code that
 * actually has to find it. If you rename it, rename it there in the same
 * commit.
 */
export const NOTICE_NAME = 'THIRD-PARTY-NOTICES.md';

/**
 * The machine an executable is actually for, read from its own header.
 *
 * Not from the path it was written to, and not from the name of the asset that
 * carried it. Those are labels a human typed; this is the file saying what it
 * is. The failure this exists to catch — an arm64 binary packaged into an Intel
 * app — is invisible to every other check in the project, because a
 * wrong-architecture file exists, is executable, and reports `present: true`
 * right up until `posix_spawn` returns `EBADARCH` on a user's machine.
 *
 * @param {Buffer} head the file's bytes, from the start. It must reach past the
 *   PE header, and the only way to know where that is, is to read the file's
 *   own `e_lfanew` — so callers pass the whole thing rather than a prefix they
 *   guessed. A prefix that stops short answers `null`, which the gate turns
 *   into a refusal; that is the safe direction, and it is also how a valid file
 *   was refused for a whole release cycle. See test/node/binary-arch.test.ts.
 * @returns {'x64'|'arm64'|null}
 */
export function binaryArch(head) {
  // Mach-O 64-bit, little-endian: MH_MAGIC_64 followed by the cputype.
  if (head.length >= 8 && head.readUInt32LE(0) === 0xfeedfacf) {
    const cputype = head.readUInt32LE(4);
    if (cputype === 0x0100000c) return 'arm64'; // CPU_TYPE_ARM64
    if (cputype === 0x01000007) return 'x64'; // CPU_TYPE_X86_64
    return null;
  }
  // PE: 'MZ', then a pointer at 0x3c to the 'PE\0\0' header, whose machine
  // word is two bytes in. Covers both the .exe files and the DLLs beside them.
  if (head.length >= 0x40 && head.readUInt16LE(0) === 0x5a4d) {
    const pe = head.readUInt32LE(0x3c);
    if (pe + 6 > head.length || head.readUInt32LE(pe) !== 0x00004550) return null;
    const machine = head.readUInt16LE(pe + 4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0xaa64) return 'arm64';
  }
  return null;
}

/**
 * What one file ON DISK is, or null when there is nothing there.
 *
 * Takes a path rather than a (root, key, tool) triple so the same measurement
 * can be taken of a copy that has already been packaged: `Resources/bin/ffmpeg`
 * inside a built .app is the file a user actually runs, and it is the only one
 * whose absence electron-builder reports as a warning rather than an error.
 */
export function readBinaryAt(file) {
  if (!existsSync(file)) return null;
  // One read, and the whole file, because the hash below needs all of it
  // anyway. The 256-byte prefix this used to take first was not a saving — it
  // was read in ADDITION to this — and it silently blinded the check to every
  // PE whose DOS stub is longer than that: the whisper.cpp executables and DLLs
  // put their header at 0x100 to 0x118, so fifteen of the seventeen Windows
  // binaries measured as `null` and the release could not package at all.
  const bytes = readFileSync(file);
  return { sha256: sha256(bytes), arch: binaryArch(bytes) };
}

/** What is on disk for one tool in a development checkout, or null. */
export function readVendored(root, key, tool) {
  return readBinaryAt(vendoredPath(root, key, tool));
}

/**
 * One target's four entries, with a real error instead of `undefined` when the
 * manifest has been edited into a shape nothing else in here would survive.
 */
export function targetEntries(manifest, key) {
  const target = manifest.targets?.[key];
  if (!target) {
    const known = Object.keys(manifest.targets ?? {}).join(', ');
    throw new Error(`vendor/binaries.json has no target ${key}. It knows: ${known}.`);
  }
  return TOOLS.map((tool) => {
    const entry = target[tool];
    if (!entry) throw new Error(`vendor/binaries.json has no ${tool} for ${key}`);
    return { tool, entry };
  });
}

/**
 * Every file one target puts beside its executables that is not itself one of
 * `TOOLS` — on Windows, the DLLs the two engine CLIs load at startup.
 *
 * This is not an optimisation or a nicety. `whisper-cli.exe` and
 * `parakeet-cli.exe` in upstream's `whisper-bin-x64.zip` are dynamically
 * linked: without `whisper.dll` / `parakeet.dll` / `ggml.dll` / `ggml-base.dll`
 * and the whole `ggml-cpu-*.dll` family beside them, the process dies at load
 * time with a Windows dialog the user can do nothing about. `ggml-cpu-*` in
 * particular is not a menu — ggml probes the running CPU at startup and loads
 * whichever variant fits, so shipping only the one this developer's machine
 * wanted breaks on hardware nobody here owns. See docs/releasing.md.
 *
 * Deduplicated by destination filename, because two entries naming the same
 * file is a legal way to write "both CLIs need this one" — and two entries
 * naming the same file with DIFFERENT members or hashes is a manifest bug that
 * would otherwise resolve to whichever tool happened to be written last.
 *
 * @returns {{ file: string, member: string, sha256: string|null, url: string, archive: string, owner: string }[]}
 */
export function extraMembersFor(manifest, key) {
  /** @type {Map<string, { file: string, member: string, sha256: string|null, url: string, archive: string, owner: string }>} */
  const byFile = new Map();
  for (const { tool, entry } of targetEntries(manifest, key)) {
    for (const extra of entry.extraMembers ?? []) {
      if (!extra.file || !extra.member) {
        throw new Error(`vendor/binaries.json: ${key}/${tool} has an extraMembers entry without "file" and "member"`);
      }
      const seen = byFile.get(extra.file);
      if (seen) {
        if (seen.member !== extra.member || seen.url !== entry.url || seen.sha256 !== (extra.sha256 ?? null)) {
          throw new Error(
            `vendor/binaries.json: ${key} names ${extra.file} twice (${seen.owner} and ${tool}) with different ` +
              'sources or hashes. One file cannot be two things; fix the duplicate rather than letting the ' +
              'later entry win.'
          );
        }
        continue;
      }
      byFile.set(extra.file, {
        file: extra.file,
        member: extra.member,
        sha256: extra.sha256 ?? null,
        url: entry.url,
        archive: entry.archive,
        owner: tool
      });
    }
  }
  return [...byFile.values()];
}

/**
 * Every reason a directory of binaries is not fit to use, in words a human can
 * act on. An empty array is the only thing that means "ship it".
 *
 * One function for two callers on purpose: the fetcher checks
 * `vendor/bin/<key>/` and the `afterPack` gate checks the `Resources/bin` that
 * ended up inside the .app. Those directories have the same contract, and the
 * moment they are checked by two different pieces of code, one of them starts
 * being the lenient one.
 *
 * `read` is injectable so a test can hand it canned measurements instead of
 * touching disk. It is annotated with the shape this function needs rather than
 * left to infer the default's type, because inferring from a default silently
 * produces `any` and takes the guard with it.
 *
 * @param {{
 *   manifest: object,
 *   key: string,
 *   dir: string,
 *   hint?: string,
 *   read?: (file: string) => { sha256: string, arch: string|null }|null
 * }} options
 * @returns {string[]}
 */
export function binariesProblems({ manifest, key, dir, hint, read = readBinaryAt }) {
  const platform = platformOf(key);
  const remedy = hint ?? `npm run binaries:fetch -- --target ${key}`;
  const problems = [];

  /** @type {{ name: string, want: { sha256: string|null, arch: string }, note: string }[]} */
  const wanted = [];
  for (const { tool, entry } of targetEntries(manifest, key)) {
    wanted.push({ name: exeName(tool, platform), want: { sha256: entry.sha256 ?? null, arch: entry.arch }, note: '' });
  }
  for (const extra of extraMembersFor(manifest, key)) {
    // A DLL's architecture is not recorded per entry: it comes out of the same
    // archive as the executable that loads it, and Windows will not load a
    // 32-bit DLL into a 64-bit process anyway. The target's own arch is the
    // only answer that can be right.
    wanted.push({
      name: extra.file,
      want: { sha256: extra.sha256, arch: key.slice(key.lastIndexOf('-') + 1) },
      note: ` — ${extra.owner} cannot start without it`
    });
  }

  for (const { name, want, note } of wanted) {
    const got = read(join(dir, name));
    if (!got) {
      problems.push(`${key}: ${name} is missing${note} — run: ${remedy}`);
      continue;
    }
    if (got.arch !== want.arch) {
      // "an arm64", "a x64". The article is worth the expression: this line is
      // read by someone who has just had a build refused, and a sentence that
      // stumbles reads like the check itself is careless.
      const article = /^[aeiou]/i.test(got.arch ?? 'unrecognised') ? 'an' : 'a';
      problems.push(`${key}: ${name} is ${article} ${got.arch ?? 'unrecognised'} binary, but ${key} needs ${want.arch}`);
      continue;
    }
    if (!want.sha256) {
      problems.push(
        `${key}: ${name} is not pinned — vendor/binaries.json records no sha256 for it, so the file on disk ` +
          'cannot be checked against anything. Run: npm run binaries:hashes -- --target ' + key
      );
      continue;
    }
    if (got.sha256 !== want.sha256) {
      problems.push(
        `${key}: ${name} hashes ${got.sha256.slice(0, 12)}…, manifest pins ${want.sha256.slice(0, 12)}…`
      );
    }
  }
  return problems;
}

/** The development-checkout case of `binariesProblems`. */
export function verifyTarget({ root, manifest, key, read = readBinaryAt }) {
  return binariesProblems({ manifest, key, dir: vendoredDir(root, key), read });
}

/**
 * The licence documents one target has to carry, deduplicated.
 *
 * `licenseFile` names a key in the manifest's top-level `licenses` map rather
 * than a file checked into the repository. That is a deliberate departure from
 * the obvious design (`vendor/licenses/GPL-3.0.txt`, committed): the GPLv3 text
 * is 35 KB of somebody else's document, and a hand-placed copy of it is a
 * fourth thing that can silently disagree with the binary it is supposed to
 * cover. Pinning it by URL and SHA-256 the same way the executables are pinned
 * means the licence that ships is the licence the build publisher shipped, and
 * a swapped upstream text fails the same way a swapped upstream binary does.
 */
export function licenseFilesFor(manifest, key) {
  return [...new Set(targetEntries(manifest, key).map(({ tool, entry }) => {
    if (!entry.licenseFile) throw new Error(`vendor/binaries.json: ${key}/${tool} has no "licenseFile"`);
    return entry.licenseFile;
  }))];
}

/** One entry from the manifest's `licenses` map, with a real error when absent. */
export function licenseEntry(manifest, name) {
  const entry = manifest.licenses?.[name];
  if (!entry) {
    throw new Error(
      `vendor/binaries.json names "${name}" as a licence text, but its top-level "licenses" map has no such ` +
        'key. These are other people\'s licence terms; the reference cannot be dropped to make this pass.'
    );
  }
  if (!entry.url) throw new Error(`vendor/binaries.json: licenses/${name} has no "url"`);
  return entry;
}

/**
 * Every reason a directory's licence paperwork is not fit to ship.
 *
 * Separate from `binariesProblems` because the two answer different questions
 * and only one of them is about bytes executing correctly. This one is about
 * whether we are allowed to hand someone the thing we just built. The notice is
 * compared against a freshly generated copy, not merely checked for existence:
 * a notice generated before the manifest was repinned names the wrong version
 * and the wrong source, which is worse than no notice at all, and it is exactly
 * what happens when someone edits `vendor/binaries.json` and packages without
 * re-running the fetch.
 */
export function licenseProblems({ manifest, key, dir }) {
  const problems = [];
  for (const name of licenseFilesFor(manifest, key)) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      problems.push(`${key}: ${name} is missing — the binaries beside it may not be distributed without it`);
      continue;
    }
    const want = licenseEntry(manifest, name).sha256;
    if (!want) {
      problems.push(`${key}: ${name} is not pinned in vendor/binaries.json — run: npm run binaries:hashes -- --target ${key}`);
      continue;
    }
    if (sha256(readFileSync(file)) !== want) {
      problems.push(`${key}: ${name} does not match the text pinned in vendor/binaries.json`);
    }
  }

  const notice = join(dir, NOTICE_NAME);
  if (!existsSync(notice)) {
    problems.push(`${key}: ${NOTICE_NAME} is missing — run: npm run binaries:fetch -- --target ${key}`);
  } else if (readFileSync(notice, 'utf8') !== licenseNotice(manifest, key)) {
    problems.push(
      `${key}: ${NOTICE_NAME} is stale — it does not match what vendor/binaries.json describes today. ` +
        `Re-run: npm run binaries:fetch -- --target ${key}`
    );
  }
  return problems;
}

/**
 * Every corresponding-source pointer for one entry, as a list.
 *
 * `source` is an array for every real entry and the string form exists only so
 * a fixture does not have to wrap itself in brackets. A STATIC ffmpeg is not
 * "FFmpeg": it is FFmpeg plus every library compiled into it, and GPLv3 §1
 * counts the scripts that configure and build the whole thing as corresponding
 * source too. One URL cannot say that.
 *
 * An EMPTY array is rejected here rather than by the blank-field loop in
 * `licenseNotice`, because `[]` is truthy and would sail straight through it,
 * producing a notice with a "Source" heading and nothing under it — the exact
 * shape of non-compliance that loop exists to prevent.
 */
function sourcesOf(entry, key, tool) {
  const raw = entry.source;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.some((s) => typeof s !== 'string' || !s.trim())) {
    throw new Error(`vendor/binaries.json: ${key}/${tool} has no "source"`);
  }
  return list;
}

/**
 * The BtbN autobuild tag embedded in a release-asset URL — e.g.
 * `…/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-29-13-12/ffmpeg-….zip`
 * yields `autobuild-2026-08-29-13-12`.
 *
 * Read out of the URL that is already pinned rather than duplicated into a
 * second manifest field, which could be hand-edited on its own and drift from
 * the archive the fetcher actually downloaded. BtbN tags that repository once
 * per autobuild and never moves a tag, so the tag is what pins `scripts.d/` —
 * the per-library build definitions — to the exact revisions this build used.
 */
export function btbnBuildTag(url) {
  const match = /\/BtbN\/FFmpeg-Builds\/releases\/download\/([^/]+)\//.exec(url);
  if (!match) throw new Error(`not a BtbN FFmpeg-Builds release-asset URL, so it has no autobuild tag: ${url}`);
  return match[1];
}

/**
 * The licence notice that ships inside the app, next to the binaries.
 *
 * DropScribe's own source is MIT, and none of what follows is about that. It is
 * about the four executables it spawns: the ffmpeg pair is built
 * `--enable-gpl --enable-version3`, so handing a user those bytes obliges us to
 * hand them the licence, the exact version, and a route to the corresponding
 * source; the whisper.cpp pair is MIT, which obliges us to reproduce its notice.
 * Neither obligation is discharged by the repository being public — the person
 * who downloaded a dmg has the binaries, not the repository.
 *
 * Generated from the manifest rather than written by hand per target, so a new
 * target cannot ship without one: a missing field throws here rather than
 * producing a notice with a blank where the version should be. It is also
 * regenerated and compared at package time (`licenseProblems`), so a notice
 * that has fallen behind a repin is caught before it is signed rather than
 * after it is downloaded.
 *
 * ## Why the source pointers are per entry and never collapsed into one line
 *
 * There is deliberately no shared closing "also available from the FFmpeg
 * project, tag n<version>" paragraph. It would name the wrong revision — the
 * Windows build is a git-describe of a commit some way past its tag — and it
 * would be incomplete for all six, because handing someone FFmpeg's own tree
 * does not let them rebuild a static binary they were given. They also need
 * every library it was linked against, at the revision it was linked at, and
 * the script that pinned and configured them. An offer a recipient cannot
 * follow to the end is not a §6 offer.
 *
 * ## Why the closing written offer names a term
 *
 * The `source` bullets are the real route: public repositories reachable at any
 * time with no request needed, which is GPLv3 §6(d)'s network-server offer and
 * needs no expiry of its own. The closing paragraph is the fallback for if that
 * ever breaks, shaped like §6(b)'s written offer — and §6(b) asks that such an
 * offer name a term. Cheap to state, wrong to leave unstated.
 */
export function licenseNotice(manifest, key) {
  const entries = targetEntries(manifest, key);
  const platform = platformOf(key);
  const lines = [
    '# Third-party binaries bundled with DropScribe',
    '',
    'DropScribe itself is MIT-licensed. It does not link any of the programs',
    'below: it runs them as separate processes, and each is covered by its own',
    "licence rather than by DropScribe's. They are listed here because they are",
    'distributed inside the application, which is what creates the obligation.',
    '',
    `Build target: \`${key}\``,
    ''
  ];

  for (const { tool, entry } of entries) {
    for (const field of ['version', 'license', 'licenseFile', 'url']) {
      if (!entry[field]) throw new Error(`vendor/binaries.json: ${key}/${tool} has no "${field}"`);
    }
    lines.push(
      `## ${exeName(tool, platform)} ${entry.version}`,
      '',
      `- Licence: **${entry.license}**. The full text is in \`${entry.licenseFile}\`, beside this file.`,
      `- This exact executable was downloaded from: ${entry.url}`,
      ...(entry.libraries?.length
        ? [`- Statically linked into it: ${entry.libraries.join(', ')}. Their source is part of the source below.`]
        : []),
      '- Source for this exact build, complete:',
      ...sourcesOf(entry, key, tool).map((source) => `  - ${source}`),
      ...(entry.extraMembers?.length
        ? [
            `- Shipped beside it, out of the same archive and under the same licence: ` +
              `${entry.extraMembers.map((extra) => `\`${extra.file}\``).join(', ')}.`
          ]
        : []),
      ''
    );
  }

  // Present on the win32-x64 ffmpeg entry only. The macOS builds link three
  // libraries, each named on its own entry above; BtbN's win64-gpl
  // configuration links dozens more, a mix of GPL, LGPL and permissive. The
  // permissive ones ask for something the GPL does not: that the library's own
  // notice travel with the binary. We are not yet reproducing those texts —
  // see the $note on that entry — so this section says where they are and the
  // written offer below carries the rest.
  const withOthers = entries.find(({ entry }) => entry.linksMoreLibraries);
  if (withOthers) {
    lines.push(
      '## Everything else the Windows ffmpeg build links',
      '',
      'The Windows ffmpeg and ffprobe come from BtbN\'s `win64-gpl` build, which statically links a long list',
      'of further third-party libraries beyond the ones named above — some GPL or LGPL in their own right,',
      'which is one more reason the whole executable is, and must be, distributed under GPL-3.0; most of the',
      'rest permissive, BSD- or MIT-style.',
      '',
      '- The complete list, and the source of every one of them at the exact revision this build pinned it to,',
      '  is one script per library at the immutable tag this archive was built from:',
      `  https://github.com/BtbN/FFmpeg-Builds/tree/${btbnBuildTag(withOthers.entry.url)}/scripts.d`,
      '- If you would rather not follow that yourself, the written offer below covers all of it, including the',
      '  licence text of every permissive library in the list.',
      ''
    );
  }

  const gpl = entries.filter(({ entry }) => String(entry.license).startsWith('GPL'));
  if (gpl.length) {
    lines.push(
      '## Written offer of source',
      '',
      'The programs marked GPL above are statically linked builds: every library named with them is compiled',
      'into the executable, so its source is part of the corresponding source for the whole, along with the',
      'scripts that pin, configure and build it. The pointers above are meant to reach all of it.',
      '',
      'If any of it is unreachable, open an issue at https://github.com/markdudov/dropscribe/issues and we',
      'will send you the complete corresponding source, by download or on a physical medium, at no charge.',
      'This written offer is valid for at least three years from when you received these binaries, and for as',
      'long after that as we continue to offer this version of DropScribe, per GPLv3 §6(b).',
      ''
    );
  }
  return lines.join('\n');
}
