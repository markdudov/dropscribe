/**
 * The renderer's entry point. It does four things and then gets out of the way.
 */

import { createRoot } from 'react-dom/client';

import { App } from './ui/App';
import './index.css';

/**
 * Paint the right theme before React's first frame.
 *
 * The stored theme lives in main and arrives over IPC a few milliseconds after
 * the window opens — long enough, on a dark-mode machine, for a white flash.
 * The system preference is available synchronously and is right for the two
 * settings out of three that end up dark, so it goes on now and the store corrects
 * it the moment `store.init()` answers with the stored one.
 */
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', prefersDark);
document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light';

/*
 * The platform, on the root element, before React paints anything.
 *
 * `titlebar-inset` in index.css needs it, and it needs it on the FIRST frame:
 * reading it from `getAppInfo()` would leave the app name sitting under the
 * macOS traffic lights for the duration of an IPC round trip, which is visible
 * as a jump on every launch. `navigator.platform` is deprecated for feature
 * detection on the web and is exactly right here — this renderer only ever runs
 * inside our own Electron build, and the answer is available synchronously.
 */
const platform = navigator.platform.startsWith('Mac')
  ? 'darwin'
  : navigator.platform.startsWith('Win')
    ? 'win32'
    : 'linux';
document.documentElement.dataset['platform'] = platform;

/**
 * Swallow every drop that misses the drop zone.
 *
 * Chromium's default action for a file dropped on a page is to navigate to it.
 * In a browser that is a feature; in an Electron window it replaces the entire
 * application with a video player showing the file the user was trying to
 * transcribe, with no way back short of quitting. The listeners are on `window`,
 * so they run last, after `DropZone`'s own handler has already claimed the drop
 * it wanted — cancelling the default here never cancels the real one.
 */
window.addEventListener('dragover', (event) => {
  event.preventDefault();
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
});

const container = document.getElementById('root');
if (container === null) {
  // Not a recoverable state, and a blank window with a clean console is the
  // worst possible way to report it.
  throw new Error('DropScribe: #root is missing from index.html.');
}

/**
 * No `<StrictMode>`, and that is not laziness.
 *
 * StrictMode mounts every effect twice in development. `App` calls
 * `store.init()` from an effect, and `init` subscribes to `jobs:updated` and
 * `models:updated` on the bridge. Two subscriptions means every job progress
 * event is applied twice, which is invisible for an idempotent state write and
 * very visible for anything that appends. Losing the double-mount check is a
 * smaller cost than a development build whose event flow does not match the
 * shipped one.
 */
createRoot(container).render(<App />);
