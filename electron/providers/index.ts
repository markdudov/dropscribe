/**
 * The one place that knows which adapter a provider id means.
 *
 * A `Record<ProviderId, ProviderAdapter>` rather than a `switch`, for the same
 * reason `engines/index.ts` uses one: adding a fifth id to `shared/providers.ts`
 * becomes a compile error here, at the moment the id is added, instead of a
 * runtime surprise the first time a user selects the new provider. A `switch`
 * with a `default` would keep building happily and fail in front of them.
 *
 * This file imports all four adapters eagerly. Lazy `import()` would defer four
 * small modules that hold nothing but functions and fetch calls, and would turn
 * `adapterFor` into an async function that every caller — the queue, the key
 * test, the model refresh — would then have to await for no measurable gain.
 */

import type { ProviderId } from '../shared/providers';
import { deepgramAdapter } from './deepgram';
import { deepinfraAdapter } from './deepinfra';
import { elevenlabsAdapter } from './elevenlabs';
import { openrouterAdapter } from './openrouter';
import type { ProviderAdapter } from './types';

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  deepinfra: deepinfraAdapter,
  deepgram: deepgramAdapter,
  elevenlabs: elevenlabsAdapter,
  openrouter: openrouterAdapter,
};

export function adapterFor(id: ProviderId): ProviderAdapter {
  // Annotated as possibly undefined on purpose, exactly as `engineFor` is. The
  // id arrives here from persisted settings and from IPC, so a job saved by a
  // build that knew a fifth provider — or a settings file a user edited by hand
  // — can name something this build has never heard of. Trusting the type would
  // turn that into `Cannot read properties of undefined` deep inside the queue
  // instead of a sentence the user can act on.
  const adapter: ProviderAdapter | undefined = ADAPTERS[id];
  if (adapter === undefined) {
    throw new Error(`This build has no provider called "${id}". Pick a different one in Settings.`);
  }
  return adapter;
}

export { deepgramAdapter } from './deepgram';
export { deepinfraAdapter } from './deepinfra';
export { elevenlabsAdapter } from './elevenlabs';
export { openrouterAdapter } from './openrouter';
export type { CloudContext, CloudRequest, ProviderAdapter } from './types';
