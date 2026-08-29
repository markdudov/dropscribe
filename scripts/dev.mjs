/**
 * `npm run dev` — start electron-vite's dev server.
 *
 * ## Why this file exists at all
 *
 * The obvious `"dev": "electron-vite dev"` works on macOS and fails on Windows
 * the moment anything tries to `spawn` it without a shell. npm installs
 * `node_modules/.bin/electron-vite` as a **batch file** there (`.cmd`/`.ps1`
 * shims around the real script), and `child_process.spawn` on Windows will not
 * launch a batch file: it needs `shell: true`, which then hands the whole
 * command line to `cmd.exe` for re-parsing — where a repository checked out
 * under `C:\Users\Someone\My Projects\` becomes several arguments, and where
 * any argument a developer passes through is suddenly subject to cmd's
 * quoting rules rather than to none.
 *
 * So we skip the shim entirely: find the CLI's real entry point, and run it
 * with the Node that is already running this file. One process launch, no
 * shell, no quoting rules, and the same code path on both platforms — which
 * matters more than the Windows fix itself, because a dev script that only
 * runs one way on the maintainer's machine is a script whose other path is
 * never exercised.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The path of electron-vite's actual CLI script.
 *
 * Resolved through its `package.json` rather than by asking for
 * `electron-vite/bin/electron-vite.js` directly, because that package declares
 * an `exports` map and a deep path outside it throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED — a package is entitled to keep its internal
 * layout private, and `./package.json` is the one subpath it is required to
 * expose. Reading `bin` out of that also means a version which renames or moves
 * its entry point keeps working here instead of failing with a path this file
 * invented.
 */
function electronViteCli() {
  const manifestPath = require.resolve('electron-vite/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['electron-vite'];
  if (!entry) {
    throw new Error(
      'electron-vite is installed but declares no "electron-vite" bin entry, so there is nothing to run. ' +
        'Reinstall dependencies (npm ci) before assuming this script is wrong.'
    );
  }
  return resolve(dirname(manifestPath), entry);
}

let cli;
try {
  cli = electronViteCli();
} catch (error) {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
}

// Anything after `npm run dev --` is forwarded verbatim: `--watch`, `--outDir`,
// a `--` of its own. Nothing here interprets it, which is the point — the flags
// belong to electron-vite and this script has no business having opinions about
// them.
const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], { stdio: 'inherit' });

child.on('error', (error) => {
  console.error(`\n✗ could not start electron-vite: ${error.message}\n`);
  process.exit(1);
});

/**
 * Exit the way the child did, signal included.
 *
 * With `stdio: 'inherit'` a Ctrl-C reaches the child through the terminal's
 * process group anyway, so this is not about delivering the signal — it is
 * about not reporting success afterwards. A wrapper that exits 0 because
 * *it* was fine, while the thing it wrapped was killed, turns an interrupted
 * dev server into a green CI step.
 */
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
