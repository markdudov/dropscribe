/**
 * The one place that knows which binary an engine id means.
 *
 * A lookup table rather than a `switch`: `Record<EngineId, LocalEngine>` makes
 * adding a third id to `models.ts` a compile error here, which is the point.
 * A `switch` with a `default` would silently keep building and fail at the
 * moment a user selects the new model.
 */

import type { EngineId } from '../shared/models';
import { parakeetEngine } from './parakeet-cpp';
import type { LocalEngine } from './types';
import { whisperEngine } from './whisper-cpp';

const ENGINES: Record<EngineId, LocalEngine> = {
  'whisper-cpp': whisperEngine,
  'parakeet-cpp': parakeetEngine,
};

export function engineFor(id: EngineId): LocalEngine {
  // Annotated as possibly undefined on purpose: `id` reaches this function from
  // persisted settings, so a model catalogue entry written by an older build
  // can name an engine this one has never heard of. Trusting the type here
  // would turn that into a `Cannot read properties of undefined` inside the
  // queue instead of a sentence the user can act on.
  const engine: LocalEngine | undefined = ENGINES[id];
  if (engine === undefined) {
    throw new Error(`This build has no local engine called "${id}". Pick a different model in Settings.`);
  }
  return engine;
}

export { parakeetEngine } from './parakeet-cpp';
export { whisperEngine } from './whisper-cpp';
export type { LocalEngine, LocalRunContext, LocalRunRequest } from './types';
