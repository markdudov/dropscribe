/**
 * Every string the interface can show, in English.
 *
 * **Flat, dotted keys — not a nested object.** A nested tree reads nicely in
 * the source and then fails you everywhere else: `dict.jobs.empty.title` cannot
 * be collapsed into one key union, a missing branch shows up as `undefined` at
 * runtime instead of red in the editor, and the string you see in the JSX is no
 * longer the string you grep for when someone asks "where does this appear?".
 * One flat object makes `keyof typeof en` the complete, closed list of
 * everything this app can say, and it is that union which lets the compiler —
 * rather than a script nobody runs — check `bg.ts` for holes.
 *
 * `as const` is what makes the keys literal rather than `string`. Drop it and
 * the union widens to `string`, and the whole guarantee quietly evaporates.
 *
 * Rules for adding a string:
 *  - The key names the PLACE, not the text: `jobs.empty.title`, never
 *    `jobs.nothingHereYet`. Rewording the English must not force a key rename,
 *    because a key rename is a silent Bulgarian regression.
 *  - Interpolate with `{name}`. Never build a sentence by concatenating two
 *    keys — Bulgarian word order is not English word order and the seam always
 *    shows.
 *  - Counted nouns get `.one` and `.many`. Bulgarian happens to split in the
 *    same place English does for these particular phrases (one / everything
 *    else), so two keys are honest; a full CLDR plural-rule engine would be
 *    machinery for a language pair that does not need it.
 */

export const en = {
  // ── Common vocabulary ───────────────────────────────────────────────────
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.retry': 'Try again',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.revealMac': 'Show in Finder',
  'common.revealWin': 'Show in File Explorer',
  'common.chooseFolder': 'Choose a folder…',
  'common.settings': 'Settings',

  // ── Shell ───────────────────────────────────────────────────────────────
  'app.name': 'DropScribe',
  'app.tagline': 'Drop a file in, get a transcript out.',
  'nav.queue': 'Queue',
  'nav.settings': 'Settings',
  'nav.about': 'About',

  // ── Drop zone ───────────────────────────────────────────────────────────
  'dropzone.empty.title': 'Drop audio or video here',
  'dropzone.empty.subtitle': 'Anything ffmpeg can open, whole video files included.',
  'dropzone.empty.browse': 'Choose files…',
  'dropzone.hover.title': 'Release to transcribe',
  'dropzone.hover.one': '1 file ready',
  'dropzone.hover.many': '{count} files ready',
  'dropzone.rejected.title': 'That is not a media file',
  'dropzone.rejected.body': '{name} is neither audio nor video, so there is nothing to transcribe.',
  'dropzone.rejected.some': 'Took {accepted} of {total}. The rest were not audio or video.',
  'dropzone.rejected.blocked': 'The app was not allowed to read {name}. Open it with Choose files… instead.',
  'dropzone.target.current': 'Runs through {target}',
  'dropzone.target.change': 'Change',
  'dropzone.noTarget.title': 'Nothing to transcribe with yet',
  'dropzone.noTarget.body': 'Download a local model or add a provider key, and dropped files start on their own.',
  'dropzone.noTarget.action': 'Open settings',

  // ── Target picker ───────────────────────────────────────────────────────
  'target.picker.label': 'Transcribe with',
  'target.picker.placeholder': 'Pick a model',
  'target.search.placeholder': 'Search models',
  'target.group.local': 'On this computer',
  'target.group.cloud': 'Cloud providers',
  'target.group.notInstalled': 'Not downloaded',
  'target.local.missing': 'Download it first',
  'target.cloud.noKey': 'Key needed',
  'target.empty': 'Nothing is available yet',
  'target.setDefault': 'Use for new files',
  'target.default.badge': 'Default',

  // ── Queue ───────────────────────────────────────────────────────────────
  'jobs.title': 'Queue',
  'jobs.empty.title': 'The queue is empty',
  'jobs.empty.body': 'Files you drop land here and start transcribing on their own.',
  'jobs.count.one': '1 file',
  'jobs.count.many': '{count} files',
  'jobs.clearFinished': 'Clear finished',
  'jobs.cancelAll': 'Cancel everything',
  'jobs.selected': '{count} selected',
  'jobs.selectAll': 'Select all',
  'jobs.exportSelected': 'Export selected',

  'job.action.cancel': 'Cancel',
  'job.action.retry': 'Try again',
  'job.action.remove': 'Remove from the queue',
  'job.action.reveal': 'Show the source file',
  'job.action.export': 'Export…',
  'job.action.copy': 'Copy the transcript',

  'job.status.queued': 'Waiting',
  'job.status.preparing': 'Preparing',
  'job.status.running': 'Transcribing',
  'job.status.done': 'Done',
  'job.status.failed': 'Failed',
  'job.status.cancelled': 'Cancelled',

  'job.stage.queued': 'Waiting its turn',
  'job.stage.probing': 'Reading the file',
  'job.stage.extracting': 'Extracting the audio',
  'job.stage.compressing': 'Compressing for upload',
  'job.stage.uploading': 'Uploading',
  'job.stage.waiting': 'Waiting for the provider',
  'job.stage.transcribing': 'Transcribing',
  'job.stage.fetching': 'Fetching the result',
  'job.stage.writing': 'Writing the files',
  'job.progress.unknown': 'Working…',

  'job.meta.duration': '{duration} long',
  'job.meta.language': 'Language: {language}',
  'job.meta.words': '{count} words',
  'job.meta.speakers': '{count} speakers',
  'job.done.in': 'Finished in {duration}',
  'job.done.wrote': 'Wrote {count} files',

  'job.error.title': 'This one failed',
  'job.error.detail.show': 'Show the detail',
  'job.error.detail.hide': 'Hide the detail',
  'job.error.notRetryable': 'Trying again will not help until something changes.',

  // ── Transcript preview ──────────────────────────────────────────────────
  'preview.title': 'Transcript',
  'preview.empty': 'Nothing to show yet',
  'preview.format': 'Format',
  'preview.copied': 'Copied to the clipboard',
  'preview.speakerPrefix': 'Speaker {name}',
  'preview.cues': '{count} subtitles',

  // ── Settings shell ──────────────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.tab.general': 'General',
  'settings.tab.models': 'Models',
  'settings.tab.providers': 'Providers',
  'settings.tab.output': 'Files',
  'settings.tab.subtitles': 'Subtitles',
  'settings.tab.appearance': 'Appearance',
  'settings.tab.about': 'About',

  // ── Settings · General ──────────────────────────────────────────────────
  'settings.general.title': 'Transcription',
  'settings.defaultTarget.label': 'Default for new files',
  'settings.defaultTarget.helper': 'A dropped file starts on this without asking.',
  'settings.defaultTarget.none': 'Ask every time',
  'settings.language.label': 'Spoken language',
  'settings.language.helper': 'Leave this on automatic unless the model keeps guessing wrong.',
  'settings.language.auto': 'Detect automatically',
  'settings.translate.label': 'Translate to English',
  'settings.translate.helper': 'Whisper can translate while it transcribes. Parakeet cannot.',
  'settings.diarize.label': 'Identify the speakers',
  'settings.diarize.helper': 'Cloud providers only — the local models do not separate speakers.',
  'settings.concurrency.label': 'Files at once',
  'settings.concurrency.helper': 'Local inference is bound by memory, not by cores. More than one at a time rarely finishes sooner.',
  'settings.threads.label': 'CPU threads',
  'settings.threads.helper': 'Zero lets the app choose from the core count.',
  'settings.threads.auto': 'Automatic',

  // ── Settings · Appearance ───────────────────────────────────────────────
  'settings.theme.label': 'Theme',
  'settings.theme.system': 'Match the system',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.uiLanguage.label': 'Interface language',
  'settings.uiLanguage.helper': 'This changes the app, not the transcription.',
  'settings.uiLanguage.en': 'English',
  'settings.uiLanguage.bg': 'Български',

  // ── Settings · Models ───────────────────────────────────────────────────
  'settings.models.title': 'Local models',
  'settings.models.helper': 'Downloaded once. After that everything runs on this computer and no audio leaves it.',
  'settings.models.folder': 'Models folder',
  'settings.models.installedCount': '{count} installed',
  'settings.models.empty': 'No models yet. Download one to work offline.',
  'models.state.notInstalled': 'Not downloaded',
  'models.state.installed': 'Ready to use',
  'models.state.downloading': 'Downloading… {percent}%',
  'models.state.verifying': 'Checking the file',
  'models.state.failed': 'The download failed',
  'models.action.download': 'Download',
  'models.action.stop': 'Stop',
  'models.action.retry': 'Download again',
  'models.action.delete': 'Delete',
  'models.download.progress': '{done} of {total}',
  'models.delete.title': 'Delete {name}?',
  'models.delete.body': 'The file leaves the disk. It can be downloaded again at any time.',
  'models.delete.confirm': 'Delete the model',
  'models.ram': 'Wants about {size} of RAM',
  'models.ram.warning': 'This machine may not have enough memory for {name}.',
  'models.languages.any': 'Any language',
  'models.languages.count': '{count} languages',
  'models.license': 'Weights licensed {license}',
  'models.source': 'From {source}',
  'models.checksum.failed': 'The downloaded file did not match its checksum, so it was deleted.',

  // ── Settings · Providers ────────────────────────────────────────────────
  'settings.providers.title': 'Cloud providers',
  'settings.providers.helper': 'Your key, your account, your bill. The audio is uploaded to whichever provider you pick.',
  'provider.deepinfra': 'DeepInfra',
  'provider.deepgram': 'Deepgram',
  'provider.elevenlabs': 'ElevenLabs',
  'provider.openrouter': 'OpenRouter',
  'provider.key.label': 'API key',
  'provider.key.helper': 'Kept in the system credential store, never in a settings file.',
  'provider.key.saved': 'Saved key, ending {preview}',
  'provider.key.none': 'No key yet',
  'provider.key.save': 'Save the key',
  'provider.key.clear': 'Remove the key',
  'provider.key.clear.title': 'Remove the key for {provider}?',
  'provider.key.clear.body': 'Anything pointed at {provider} stops working until a new key is saved.',
  'provider.key.get': 'Get a key',
  'provider.docs': 'Read the documentation',
  'provider.test.button': 'Test connection',
  'provider.test.testing': 'Testing…',
  'provider.test.valid': 'The key works',
  'provider.test.validAs': 'Connected as {account}',
  'provider.test.invalid': 'The key did not work',
  'provider.test.reason': 'Reason: {reason}',
  'provider.test.never': 'Not tested yet',
  'provider.models.label': 'Model',
  'provider.models.refresh': 'Refresh the list',
  'provider.models.refreshing': 'Loading the models…',
  'provider.models.empty': 'Test the key and the models appear here.',
  'provider.model.pricePerMinute': '${price} per minute of audio',
  'provider.model.pricePerHour': '${price} per hour of audio',
  'provider.cap.diarization': 'Speakers',
  'provider.cap.wordTimestamps': 'Word timings',
  'provider.cap.translate': 'Translation',
  'provider.cloud.wordTimestamps.label': 'Word-level timings',
  'provider.cloud.wordTimestamps.helper': 'Needed for subtitles that break in the right places. None of these providers charge extra for them.',
  'provider.upload.notice': '{name} will be uploaded to {provider}.',

  // ── Settings · Files ────────────────────────────────────────────────────
  'settings.output.title': 'Written when a job finishes',
  'settings.output.helper': 'Leave everything off to export by hand from the queue instead.',
  'format.txt': 'Plain text',
  'format.md': 'Markdown',
  'format.srt': 'SubRip subtitles',
  'format.vtt': 'WebVTT subtitles',
  'format.json': 'JSON',
  'format.csv': 'CSV',
  'output.location.label': 'Where they go',
  'output.location.beside': 'Beside the source file',
  'output.location.folder': 'All into one folder',
  'output.location.unset': 'No folder chosen yet',
  'output.includeSpeakers.label': 'Put the speaker in front of each line',
  'output.includeSpeakers.helper': 'Does something only when the transcript has speakers in it.',
  'output.overwrite.notice': 'An existing file with the same name is replaced.',

  // ── Export ──────────────────────────────────────────────────────────────
  'export.button': 'Export',
  'export.choose': 'Choose a format',
  'export.saving': 'Saving…',
  'export.saved': 'Saved to {path}',
  'export.failed': 'The file could not be written',
  'export.copy': 'Copy to the clipboard',
  'export.nothingSelected': 'Pick at least one finished file.',

  // ── Settings · Subtitles ────────────────────────────────────────────────
  'settings.subtitles.title': 'Subtitle shape',
  'settings.subtitles.helper': 'These rules turn a transcript into cues. The defaults are where the BBC and Netflix guidelines agree.',
  'subtitles.maxCharsPerLine.label': 'Characters per line',
  'subtitles.maxCharsPerLine.helper': '42 is the width that stays safe inside a 16:9 frame.',
  'subtitles.maxLines.label': 'Lines per subtitle',
  'subtitles.maxLines.helper': 'Two is the professional ceiling. Three cover the picture.',
  'subtitles.maxDuration.label': 'Longest on screen',
  'subtitles.maxDuration.helper': 'Past this the eye goes back and reads the line a second time.',
  'subtitles.minDuration.label': 'Shortest on screen',
  'subtitles.minDuration.helper': 'A flash under a second is unreadable, even for a single word.',
  'subtitles.maxCps.label': 'Reading speed',
  'subtitles.maxCps.helper': 'Characters per second. Above 17 most viewers fall behind.',
  'subtitles.gapSplit.label': 'Split on a pause',
  'subtitles.gapSplit.helper': 'A silence at least this long ends the subtitle, so no cue spans a pause you can hear.',
  'subtitles.minGap.label': 'Gap between subtitles',
  'subtitles.minGap.helper': 'Blank frames, so two subtitles do not read as one.',
  'subtitles.reset': 'Restore the standard values',
  'units.characters': '{value} characters',
  'units.lines': '{value} lines',
  'units.seconds': '{value} s',
  'units.milliseconds': '{value} ms',
  'units.charsPerSecond': '{value} chars/s',

  // ── About ───────────────────────────────────────────────────────────────
  'about.title': 'About DropScribe',
  'about.version': 'Version {version}',
  'about.platform': '{platform} · {arch}',
  'about.modelsDir': 'Models are kept in {path}',
  'about.repo': 'Source code on GitHub',
  'about.issues': 'Report a problem',
  'about.license': 'DropScribe is free software under the MIT licence.',
  'about.licenses': 'Third-party notices',
  'about.privacy': 'A local model never sends your audio anywhere. A cloud provider does — that is the whole trade.',
  'about.credits': 'Built on whisper.cpp and ffmpeg, which do the hard part.',
  'about.engines.title': 'Bundled engines',
  'about.engines.ready': 'Every engine is in place.',
  'about.engines.missing': 'An engine is missing from this build. Transcription will fail until that is fixed.',
  'about.engines.detail': 'Show what was found',
  'about.engine.present': 'found',
  'about.engine.absent': 'missing',

  // ── Errors ──────────────────────────────────────────────────────────────
  'error.title': 'Something went wrong',
  'error.noAudio': 'This file has no audio track.',
  'error.unreadable': 'The file could not be read. It may have been moved or renamed.',
  'error.notAuthorized': 'The app is not allowed to read that path. Open the file through Choose files… instead.',
  'error.ffmpeg': 'The audio could not be extracted from this file.',
  'error.engineMissing': 'The transcription engine is missing from this build.',
  'error.modelMissing': 'The model file is no longer on disk. Download it again.',
  'error.outOfMemory': 'There was not enough memory for this model. Try a quantized one.',
  'error.diskFull': 'There is not enough free space on the disk.',
  'error.writeFailed': 'Could not write to {path}.',
  'error.network': 'The provider could not be reached. Check the connection.',
  'error.timeout': 'The provider took too long to answer.',
  'error.unauthorized': '{provider} rejected the key.',
  'error.rateLimited': '{provider} is throttling this key. Wait a moment and try again.',
  'error.quota': 'The account at {provider} is out of credit.',
  'error.providerFailed': '{provider} returned an error.',
  'error.keyMissing': 'No key is configured for {provider}.',
  'error.unknown': 'Something went wrong and the app cannot say what.',
} as const;
