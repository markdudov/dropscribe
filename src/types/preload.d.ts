/**
 * What `window.dropscribe` is, from the renderer's side.
 *
 * The type itself lives in `electron/api-types.ts`, which both TypeScript
 * projects compile. This file does nothing but bolt it onto the global `Window`
 * so the renderer can call the bridge without a cast at every site.
 *
 * Keeping the shape in one place and the global declaration in another is
 * deliberate. `api-types.ts` is the contract main, preload and the renderer all
 * implement or consume; if the `declare global` lived there, main would be
 * declaring a `Window` it does not have. And if the shape lived here, main and
 * preload would have to import a file out of `src/` to know what they are
 * building — which is the wrong direction for a dependency and would put a
 * renderer-only tsconfig in charge of the IPC surface.
 *
 * There is nothing else in this file on purpose. Every capability the renderer
 * has is on `DropScribeApi`; a second global would be a second, undocumented
 * bridge.
 */

import type { DropScribeApi } from '../../electron/api-types';

declare global {
  interface Window {
    dropscribe: DropScribeApi;
  }
}

export {};
