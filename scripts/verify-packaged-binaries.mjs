/**
 * electron-builder `afterPack` gate: refuse to continue when the app that was
 * just laid out does not carry the engine binaries it is supposed to.
 *
 * ## Why this is the only thing standing between a forgotten fetch and a
 * ## shipped app with no ffmpeg in it
 *
 * `extraResources` maps `vendor/bin/<platform>-<arch>` into `Resources/bin`.
 * When that source directory does not exist, electron-builder **warns** and
 * carries on. The result is a complete, installable, signable application whose
 * `Resources/bin` is empty or absent — and nothing else in the pipeline
 * notices, because every other check answers a question this failure passes:
 * the Electron binary is the right architecture, the window opens, the model
 * downloads, and `enginesReady()` in electron/binaries-runtime.ts returns true
 * for files that are present. The first honest signal is `posix_spawn`
 * returning ENOENT or EBADARCH, on a user's machine, at the end of the first
 * extract-audio stage.
 *
 * The architecture case is worse than the missing case, because it only
 * reproduces on hardware nobody on the project is holding. The Mac release job
 * builds an arm64 dmg and an x64 dmg from ONE checkout on an arm64 runner; if
 * the second fetch is ever dropped in a refactor, the Intel dmg either ships no
 * binaries at all or ships the arm64 ones under an x64 label. Both install and
 * launch perfectly. So this reads the Mach-O or PE header of every file it
 * checks, rather than trusting the directory it came out of.
 *
 * ## Why afterPack and not beforeBuild
 *
 * `beforeBuild` could check `vendor/bin/` and would be simpler. It would also
 * be checking the INPUT, and the failure being guarded against is one where the
 * input was fine and the copy did not happen — a filter that excluded too much,
 * a `${arch}` macro that expanded to the build host, an `asar` change that
 * swallowed the directory. The only file worth measuring is the one a user will
 * actually execute, and that file does not exist until the app has been packed.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binariesProblems, licenseProblems, loadManifest } from './binaries.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * electron-builder's `Arch` enum, by value.
 *
 * Copied rather than imported: this file is loaded BY electron-builder, and
 * importing the package back into its own hook is a circular dependency on a
 * CommonJS module whose export shape has changed between majors. The enum has
 * not moved in years, and a value that ever falls off the end of this list
 * fails loudly below rather than silently verifying the wrong target.
 */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

/**
 * Where the packed app keeps the files `extraResources` put there.
 *
 * `packager.getResourcesDir` is asked first because it is electron-builder's
 * own answer and survives a layout change on its side; the manual computation
 * is the fallback for when that method is renamed or absent, since being wrong
 * about this path would make the whole gate pass vacuously — the most dangerous
 * way for a check like this to fail.
 */
function resourcesDir(context) {
  const fromPackager = context.packager?.getResourcesDir?.(context.appOutDir);
  if (typeof fromPackager === 'string' && fromPackager) return fromPackager;
  if (context.electronPlatformName === 'darwin') {
    const product = context.packager?.appInfo?.productFilename ?? 'DropScribe';
    return join(context.appOutDir, `${product}.app`, 'Contents', 'Resources');
  }
  return join(context.appOutDir, 'resources');
}

/**
 * The whole check, as a pure function of the context, so it can be reasoned
 * about (and called by hand against an already-built app) without electron-
 * builder around it.
 *
 * @returns {string[]} every problem found, in the order a human would want to
 *   read them. Empty means the app is fit to sign.
 */
export function packProblems(context, { root = ROOT, manifest = loadManifest(root) } = {}) {
  const platform = context.electronPlatformName;
  const arch = ARCH_NAMES[context.arch];

  if (arch === undefined) {
    return [
      `electron-builder reported architecture ${context.arch}, which this hook has no name for. Add it to ` +
        'ARCH_NAMES rather than removing the check — an unrecognised arch is exactly when a wrong binary ' +
        'gets packed.'
    ];
  }

  // Named refusals, both of them, because the alternative in each case is a
  // build that succeeds and produces something nobody can use.
  if (platform === 'linux') {
    return [
      'linux-' + arch + ' is not a build target for DropScribe. vendor/binaries.json has no Linux row, so ' +
        'this app has just been packed with no engine binaries in it at all — electron-builder only warns ' +
        'about the missing extraResources source. Adding Linux means adding its manifest entries, its ' +
        'measurements and somebody who runs the app there; it does not mean adding a target: key.'
    ];
  }
  if (arch === 'universal') {
    return [
      'a universal macOS build cannot be verified, and should not be produced. The extraResources mapping ' +
        'is `vendor/bin/darwin-${arch}` — one directory of single-architecture executables — so a universal ' +
        'app would carry one arch\'s binaries under both. Build the two dmgs separately, which is what the ' +
        'release workflow does.'
    ];
  }

  const key = `${platform}-${arch}`;
  if (!manifest.targets?.[key]) {
    return [`vendor/binaries.json has no target ${key}, so there is nothing to verify this app against`];
  }

  const dir = join(resourcesDir(context), 'bin');
  if (!existsSync(dir)) {
    return [
      `${dir} does not exist. The extraResources entry for ${key} did not copy anything, and ` +
        'electron-builder only warned about it. Populate the source first: ' +
        `npm run binaries:fetch -- --target ${key}`
    ];
  }

  return [
    ...binariesProblems({ manifest, key, dir }),
    // Kept separate and always run, even when a binary is already wrong: a
    // release blocked on two counts should say so once rather than over two
    // build attempts.
    ...licenseProblems({ manifest, key, dir })
  ];
}

/**
 * The hook electron-builder calls. Throwing is the whole interface — it aborts
 * the build, which is the point, and there is no softer signal worth having
 * here. A warning would be read once and then never again.
 */
export default async function verifyPackagedBinaries(context) {
  const problems = packProblems(context);
  if (problems.length) {
    throw new Error(
      `refusing to package: the engine binaries in this app are not what vendor/binaries.json describes.\n` +
        problems.map((problem) => `  • ${problem}`).join('\n') +
        '\nNothing about this is cosmetic — an app that ships without these, or with the wrong ' +
        'architecture of them, installs and launches and then fails every job.'
    );
  }
  const arch = ARCH_NAMES[context.arch];
  process.stdout.write(`  ✓ ${context.electronPlatformName}-${arch}: Resources/bin matches vendor/binaries.json\n`);
}
