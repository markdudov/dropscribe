/// <reference types="vitest/globals" />
/**
 * `electron/shared/models.ts` — the catalogue the downloader trusts.
 *
 * Every field here is load bearing at download time and nowhere else, which is
 * exactly why it rots quietly. A duplicated id silently overwrites another
 * model's file on disk; a `sha256` that is 63 characters long or carries an
 * upper-case digit fails integrity *after* a 1.6 GB download; a missing
 * `recommended` leaves the picker with nothing selected on first run. None of
 * these is visible in review, and all of them are one assertion away.
 *
 * What this file deliberately does NOT do is check a hash against the real
 * bytes — that is `scripts/verify-model-catalogue.mjs`, which asks Hugging Face,
 * and it needs a network. These are the shape checks that must hold offline.
 */

import type { EngineId } from '../electron/shared/models';
import { LOCAL_MODELS, findLocalModel, formatBytes } from '../electron/shared/models';

/** Both engines are whisper.cpp binaries; see the header of `models.ts`. */
const ENGINES: readonly EngineId[] = ['whisper-cpp', 'parakeet-cpp'];

describe('LOCAL_MODELS', () => {
  it('is not empty', () => {
    expect(LOCAL_MODELS.length).toBeGreaterThan(0);
  });

  it('gives every entry a unique id', () => {
    const ids = LOCAL_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The file name is the path under `<userData>/models/`, so a collision means
  // downloading one model quietly replaces another's weights.
  it('gives every entry a unique file name', () => {
    const names = LOCAL_MODELS.map((model) => model.fileName);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const model of LOCAL_MODELS) {
    describe(model.id, () => {
      it('has a 64-character lowercase hex sha256', () => {
        expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      });

      it('has a positive whole byte count', () => {
        expect(Number.isInteger(model.bytes)).toBe(true);
        expect(model.bytes).toBeGreaterThan(0);
      });

      it('downloads from huggingface.co over https', () => {
        const url = new URL(model.url);
        expect(url.protocol).toBe('https:');
        expect(url.hostname).toBe('huggingface.co');
      });

      it('names an engine this app can actually run', () => {
        expect(ENGINES).toContain(model.engine);
      });

      it('carries the text the picker and the licence panel print', () => {
        expect(model.label.length).toBeGreaterThan(0);
        expect(model.blurb.length).toBeGreaterThan(0);
        expect(model.license.length).toBeGreaterThan(0);
        expect(model.source.length).toBeGreaterThan(0);
        expect(model.approxRamMb).toBeGreaterThan(0);
      });

      it('either detects its own language or lists the ones it knows', () => {
        if (model.languages === null) return;
        expect(model.languages.length).toBeGreaterThan(0);
        for (const code of model.languages) expect(code).toMatch(/^[a-z]{2,3}$/);
        expect(new Set(model.languages).size).toBe(model.languages.length);
      });
    });
  }

  for (const engine of ENGINES) {
    it(`suggests exactly one model for ${engine}`, () => {
      const forEngine = LOCAL_MODELS.filter((model) => model.engine === engine);
      expect(forEngine.length).toBeGreaterThan(0);
      const recommended = forEngine.filter((model) => model.recommended === true);
      expect(recommended).toHaveLength(1);
    });
  }
});

describe('findLocalModel', () => {
  it('finds every id in the catalogue', () => {
    for (const model of LOCAL_MODELS) {
      expect(findLocalModel(model.id)).toBe(model);
    }
  });

  it('returns undefined for an id that is not in the catalogue', () => {
    expect(findLocalModel('whisper-tiny')).toBeUndefined();
    expect(findLocalModel('')).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('stays in bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('shows one decimal place under 10 units and none above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 20)).toBe('20 MB');
  });

  it('describes the sizes the catalogue actually pins', () => {
    expect(formatBytes(1_624_555_275)).toBe('1.5 GB');
    expect(formatBytes(574_041_195)).toBe('547 MB');
  });
});
