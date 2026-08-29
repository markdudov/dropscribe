/**
 * What the app will accept from a drop.
 *
 * Deliberately generous on the video side: the engines never see the container,
 * only the 16 kHz mono WAV ffmpeg produces from it, so anything ffmpeg can demux
 * is fair game. The list exists to give the user an immediate "no" on an image
 * or a PDF rather than a confusing ffmpeg error two seconds later.
 */

export const AUDIO_EXTENSIONS: readonly string[] = [
  'mp3', 'm4a', 'aac', 'wav', 'wave', 'flac', 'ogg', 'oga', 'opus', 'wma',
  'aiff', 'aif', 'aifc', 'caf', 'amr', 'ac3', 'dts', 'mka', 'ape', 'wv', 'mp2',
];

export const VIDEO_EXTENSIONS: readonly string[] = [
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'mpg', 'mpeg',
  'mts', 'm2ts', 'ts', '3gp', '3g2', 'ogv', 'vob', 'asf', 'rm', 'rmvb', 'divx',
];

export const MEDIA_EXTENSIONS: readonly string[] = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

/** Lowercase extension without the dot, or `''` for a name with no extension. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

export function isMediaFile(fileName: string): boolean {
  return MEDIA_EXTENSIONS.includes(extensionOf(fileName));
}

export function isVideoFile(fileName: string): boolean {
  return VIDEO_EXTENSIONS.includes(extensionOf(fileName));
}

/** Filters for the native open dialog. */
export const OPEN_DIALOG_FILTERS = [
  { name: 'Media', extensions: [...MEDIA_EXTENSIONS] },
  { name: 'Audio', extensions: [...AUDIO_EXTENSIONS] },
  { name: 'Video', extensions: [...VIDEO_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] },
];
