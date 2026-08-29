/// <reference types="vitest/globals" />
/**
 * `electron/shared/media-extensions.ts` — the gate a dropped file passes first.
 *
 * Every case below is one a user produces without trying: a camera writes
 * `.MOV` in capitals, a download has no extension at all, macOS hands a drop of
 * `.DS_Store`, and an export tool leaves `clip.mp4.part` behind. The function is
 * four lines long, which is exactly why nobody re-reads it, and the cost of a
 * wrong answer is a file the app silently refuses to accept.
 */

import {
  AUDIO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  OPEN_DIALOG_FILTERS,
  VIDEO_EXTENSIONS,
  extensionOf,
  isMediaFile,
  isVideoFile,
} from '../electron/shared/media-extensions';

describe('extensionOf', () => {
  it('lowercases whatever case the file system gave it', () => {
    expect(extensionOf('CLIP.MP4')).toBe('mp4');
    expect(extensionOf('Interview.MoV')).toBe('mov');
    expect(extensionOf('song.mp3')).toBe('mp3');
  });

  it('returns an empty string for a name with no extension', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('')).toBe('');
  });

  // A leading dot is the whole name, not an extension — `.mp4` is a hidden file
  // called ".mp4", and treating it as a video would accept an empty-named file.
  it('does not read a dotfile as an extension', () => {
    expect(extensionOf('.mp4')).toBe('');
    expect(extensionOf('.DS_Store')).toBe('');
    expect(extensionOf('.env')).toBe('');
  });

  it('takes only the final component of a double extension', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('movie.mp4.mov')).toBe('mov');
    expect(extensionOf('clip.mp4.part')).toBe('part');
  });

  it('returns an empty string for a trailing dot', () => {
    expect(extensionOf('name.')).toBe('');
  });
});

describe('isMediaFile', () => {
  it('accepts audio and video regardless of case', () => {
    expect(isMediaFile('CLIP.MP4')).toBe(true);
    expect(isMediaFile('song.Mp3')).toBe(true);
    expect(isMediaFile('lecture.m4a')).toBe(true);
  });

  it('rejects a name with no extension', () => {
    expect(isMediaFile('README')).toBe(false);
    expect(isMediaFile('')).toBe(false);
  });

  it('rejects a dotfile that merely looks like media', () => {
    expect(isMediaFile('.mp4')).toBe(false);
    expect(isMediaFile('.DS_Store')).toBe(false);
  });

  it('judges a double extension by its last component only', () => {
    // Real media that was renamed once — still media.
    expect(isMediaFile('movie.mp4.mov')).toBe(true);
    // A half-finished download — not yet media, and the right answer is "no".
    expect(isMediaFile('clip.mp4.part')).toBe(false);
    expect(isMediaFile('archive.tar.gz')).toBe(false);
  });

  it('rejects the things people drop by mistake', () => {
    expect(isMediaFile('poster.png')).toBe(false);
    expect(isMediaFile('notes.pdf')).toBe(false);
    expect(isMediaFile('subtitles.srt')).toBe(false);
  });
});

describe('isVideoFile', () => {
  it('separates video from the audio that is still media', () => {
    expect(isVideoFile('clip.MOV')).toBe(true);
    expect(isVideoFile('song.mp3')).toBe(false);
    expect(isMediaFile('song.mp3')).toBe(true);
  });

  it('agrees with isMediaFile on everything it accepts', () => {
    for (const extension of VIDEO_EXTENSIONS) {
      expect(isVideoFile(`sample.${extension}`)).toBe(true);
      expect(isMediaFile(`sample.${extension}`)).toBe(true);
    }
  });
});

describe('the extension tables', () => {
  it('lists audio and video with no overlap and no duplicates', () => {
    expect(new Set(AUDIO_EXTENSIONS).size).toBe(AUDIO_EXTENSIONS.length);
    expect(new Set(VIDEO_EXTENSIONS).size).toBe(VIDEO_EXTENSIONS.length);
    expect(new Set(MEDIA_EXTENSIONS).size).toBe(MEDIA_EXTENSIONS.length);
    expect(MEDIA_EXTENSIONS.length).toBe(AUDIO_EXTENSIONS.length + VIDEO_EXTENSIONS.length);
  });

  // `extensionOf` lowercases and strips the dot; an entry that did neither
  // would be unreachable and the failure would be a file type silently refused.
  it('stores every entry the way extensionOf produces one', () => {
    for (const extension of MEDIA_EXTENSIONS) {
      expect(extension).toBe(extension.toLowerCase());
      expect(extension.startsWith('.')).toBe(false);
      expect(extension.length).toBeGreaterThan(0);
    }
  });

  it('offers the native dialog a Media filter covering everything', () => {
    const media = OPEN_DIALOG_FILTERS.find((filter) => filter.name === 'Media');
    expect(media?.extensions).toEqual([...MEDIA_EXTENSIONS]);
    expect(OPEN_DIALOG_FILTERS.map((filter) => filter.name)).toEqual(['Media', 'Audio', 'Video', 'All files']);
  });
});
