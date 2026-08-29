import type { en } from './en';

/**
 * Every string the interface can show, in Bulgarian.
 *
 * **The annotation is the point of this file.** `Record<keyof typeof en, string>`
 * is not decoration and must not be relaxed:
 *
 *  - Leave a key out and the object literal is missing a required property, so
 *    `bg.ts` fails to compile. That is the whole guarantee — without it a
 *    forgotten string ships, and the only way anyone finds out is a Bulgarian
 *    user staring at an English sentence, or at nothing.
 *  - Misspell a key and excess-property checking rejects it, instead of quietly
 *    adding `jobs.emtpy.title` beside a `jobs.empty.title` that is now missing.
 *    Both halves of a typo are caught, which a `Partial<>` or an index signature
 *    would let through.
 *
 * `typeof en` itself would be the wrong type: its properties are the literal
 * English strings (`en.ts` ends in `as const`), so it would demand that the
 * Bulgarian translation *be* the English text. `Record<keyof …, string>` keeps
 * the key union and widens only the values, which is exactly the constraint a
 * translation needs.
 *
 * Translation rules, so this file stays one voice:
 *  - Imperative, second person singular, no «моля». This is a tool the user
 *    drives; a tool that says please is a tool that is apologising for existing.
 *    It follows Bulgarian macOS, which does the same.
 *  - A real Bulgarian word wherever one exists — «опашка», «изтегли»,
 *    «доставчик», «двигател». Product names (DropScribe, Whisper, Parakeet,
 *    ffmpeg, Finder, Markdown, JSON) and file-format names stay as they are;
 *    transliterating them would break the connection to the thing on disk.
 *  - `{placeholders}` keep their English names — they are code, not text.
 *  - Bulgarian quotation marks are „ “, not " ".
 *  - Counted masculine nouns take the count form: «2 файла», «5 файла»,
 *    «{count} субтитъра». That is why `.many` is one string and not three.
 */
export const bg: Record<keyof typeof en, string> = {
  // ── Common vocabulary ───────────────────────────────────────────────────
  'common.cancel': 'Отказ',
  'common.close': 'Затвори',
  'common.save': 'Запиши',
  'common.delete': 'Изтрий',
  'common.retry': 'Опитай отново',
  'common.copy': 'Копирай',
  'common.copied': 'Копирано',
  'common.revealMac': 'Покажи във Finder',
  'common.revealWin': 'Покажи във File Explorer',
  'common.chooseFolder': 'Избери папка…',
  'common.settings': 'Настройки',

  // ── Shell ───────────────────────────────────────────────────────────────
  'app.name': 'DropScribe',
  'app.tagline': 'Пускаш файл, получаваш текст.',
  'nav.queue': 'Опашка',
  'nav.settings': 'Настройки',
  'nav.about': 'За приложението',

  // ── Drop zone ───────────────────────────────────────────────────────────
  'dropzone.empty.title': 'Пусни аудио или видео тук',
  'dropzone.empty.subtitle': 'Всичко, което ffmpeg може да отвори, включително цели видеофайлове.',
  'dropzone.empty.browse': 'Избери файлове…',
  'dropzone.hover.title': 'Пусни, за да започне транскрипцията',
  'dropzone.hover.one': '1 готов файл',
  'dropzone.hover.many': '{count} готови файла',
  'dropzone.rejected.title': 'Това не е медиен файл',
  'dropzone.rejected.body': '{name} не е нито аудио, нито видео, така че няма какво да се транскрибира.',
  'dropzone.rejected.some': 'Приети са {accepted} от {total}. Останалите не бяха аудио или видео.',
  'dropzone.rejected.blocked': 'Приложението няма право да чете {name}. Отвори го през „Избери файлове…“.',
  'dropzone.target.current': 'Минава през {target}',
  'dropzone.target.change': 'Смени',
  'dropzone.noTarget.title': 'Още няма с какво да се транскрибира',
  'dropzone.noTarget.body': 'Изтегли локален модел или добави ключ за доставчик и пуснатите файлове тръгват сами.',
  'dropzone.noTarget.action': 'Отвори настройките',

  // ── Target picker ───────────────────────────────────────────────────────
  'target.picker.label': 'Транскрибирай с',
  'target.picker.placeholder': 'Избери модел',
  'target.search.placeholder': 'Търсене на модел',
  'target.group.local': 'На този компютър',
  'target.group.cloud': 'Доставчици в облака',
  'target.group.notInstalled': 'Неизтеглени',
  'target.local.missing': 'Първо го изтегли',
  'target.cloud.noKey': 'Нужен е ключ',
  'target.empty': 'Още няма нищо налично',
  'target.setDefault': 'Използвай за нови файлове',
  'target.default.badge': 'По подразбиране',

  // ── Queue ───────────────────────────────────────────────────────────────
  'jobs.title': 'Опашка',
  'jobs.empty.title': 'Опашката е празна',
  'jobs.empty.body': 'Файловете, които пуснеш, идват тук и тръгват сами.',
  'jobs.count.one': '1 файл',
  'jobs.count.many': '{count} файла',
  'jobs.clearFinished': 'Изчисти готовите',
  'jobs.cancelAll': 'Отмени всичко',
  'jobs.selected': '{count} избрани',
  'jobs.selectAll': 'Избери всички',
  'jobs.exportSelected': 'Експортирай избраните',

  'job.action.cancel': 'Отмени',
  'job.action.retry': 'Опитай отново',
  'job.action.remove': 'Махни от опашката',
  'job.action.reveal': 'Покажи изходния файл',
  'job.action.export': 'Експортирай…',
  'job.action.copy': 'Копирай транскрипцията',

  'job.status.queued': 'Чака',
  'job.status.preparing': 'Подготовка',
  'job.status.running': 'Транскрибиране',
  'job.status.done': 'Готово',
  'job.status.failed': 'Неуспешно',
  'job.status.cancelled': 'Отменено',

  'job.stage.queued': 'Чака реда си',
  'job.stage.probing': 'Чете файла',
  'job.stage.extracting': 'Извлича аудиото',
  'job.stage.compressing': 'Компресира за качване',
  'job.stage.uploading': 'Качва',
  'job.stage.waiting': 'Чака доставчика',
  'job.stage.transcribing': 'Транскрибира',
  'job.stage.fetching': 'Взема резултата',
  'job.stage.writing': 'Записва файловете',
  'job.progress.unknown': 'Работи…',

  'job.meta.duration': 'Дължина: {duration}',
  'job.meta.language': 'Език: {language}',
  'job.meta.words': '{count} думи',
  'job.meta.speakers': '{count} говорители',
  'job.done.in': 'Готово за {duration}',
  'job.done.wrote': 'Записани са {count} файла',

  'job.error.title': 'Този се провали',
  'job.error.detail.show': 'Покажи подробностите',
  'job.error.detail.hide': 'Скрий подробностите',
  'job.error.notRetryable': 'Нов опит няма да помогне, докато нещо не се промени.',

  // ── Transcript preview ──────────────────────────────────────────────────
  'preview.title': 'Транскрипция',
  'preview.empty': 'Още няма какво да се покаже',
  'preview.format': 'Формат',
  'preview.copied': 'Копирано в клипборда',
  'preview.speakerPrefix': 'Говорител {name}',
  'preview.cues': '{count} субтитъра',

  // ── Settings shell ──────────────────────────────────────────────────────
  'settings.title': 'Настройки',
  'settings.tab.general': 'Общи',
  'settings.tab.models': 'Модели',
  'settings.tab.providers': 'Доставчици',
  'settings.tab.output': 'Файлове',
  'settings.tab.subtitles': 'Субтитри',
  'settings.tab.appearance': 'Външен вид',
  'settings.tab.about': 'За приложението',

  // ── Settings · General ──────────────────────────────────────────────────
  'settings.general.title': 'Транскрибиране',
  'settings.defaultTarget.label': 'По подразбиране за нови файлове',
  'settings.defaultTarget.helper': 'Пуснатият файл тръгва през това, без да пита.',
  'settings.defaultTarget.none': 'Питай всеки път',
  'settings.language.label': 'Говорим език',
  'settings.language.helper': 'Остави на автоматично, освен ако моделът постоянно не уцелва.',
  'settings.language.auto': 'Разпознавай автоматично',
  'settings.translate.label': 'Превеждай на английски',
  'settings.translate.helper': 'Whisper може да превежда, докато транскрибира. Parakeet не може.',
  'settings.diarize.label': 'Разделяй по говорители',
  'settings.diarize.helper': 'Само при доставчиците в облака — локалните модели не разделят говорителите.',
  'settings.concurrency.label': 'Файлове наведнъж',
  'settings.concurrency.helper': 'Локалната обработка опира в паметта, не в ядрата. Повече от един наведнъж рядко свършва по-рано.',
  'settings.threads.label': 'Нишки на процесора',
  'settings.threads.helper': 'Нула оставя приложението да избере според броя ядра.',
  'settings.threads.auto': 'Автоматично',

  // ── Settings · Appearance ───────────────────────────────────────────────
  'settings.theme.label': 'Тема',
  'settings.theme.system': 'Като системата',
  'settings.theme.light': 'Светла',
  'settings.theme.dark': 'Тъмна',
  'settings.uiLanguage.label': 'Език на интерфейса',
  'settings.uiLanguage.helper': 'Това сменя приложението, не транскрипцията.',
  // Language names stay in their own language — a Bulgarian speaker looking for
  // English scans for «English», not for «Английски».
  'settings.uiLanguage.en': 'English',
  'settings.uiLanguage.bg': 'Български',

  // ── Settings · Models ───────────────────────────────────────────────────
  'settings.models.title': 'Локални модели',
  'settings.models.helper': 'Изтеглят се веднъж. След това всичко върви на този компютър и никакво аудио не го напуска.',
  'settings.models.folder': 'Папка с моделите',
  'settings.models.installedCount': '{count} изтеглени',
  'settings.models.empty': 'Още няма модели. Изтегли един, за да работиш офлайн.',
  'models.state.notInstalled': 'Неизтеглен',
  'models.state.installed': 'Готов за работа',
  'models.state.downloading': 'Изтегляне… {percent}%',
  'models.state.verifying': 'Проверява файла',
  'models.state.failed': 'Изтеглянето се провали',
  'models.action.download': 'Изтегли',
  'models.action.stop': 'Спри',
  'models.action.retry': 'Изтегли отново',
  'models.action.delete': 'Изтрий',
  'models.download.progress': '{done} от {total}',
  'models.delete.title': 'Да се изтрие ли {name}?',
  'models.delete.body': 'Файлът излиза от диска. Може да се изтегли отново по всяко време.',
  'models.delete.confirm': 'Изтрий модела',
  'models.ram': 'Иска около {size} памет',
  'models.ram.warning': 'Тази машина може да няма достатъчно памет за {name}.',
  'models.languages.any': 'Всеки език',
  'models.languages.count': '{count} езика',
  'models.license': 'Лиценз на теглата: {license}',
  'models.source': 'От {source}',
  'models.checksum.failed': 'Изтегленият файл не съвпадна с контролната си сума и беше изтрит.',

  // ── Settings · Providers ────────────────────────────────────────────────
  'settings.providers.title': 'Доставчици в облака',
  'settings.providers.helper': 'Твоят ключ, твоят акаунт, твоята сметка. Аудиото се качва при доставчика, когото избереш.',
  'provider.deepinfra': 'DeepInfra',
  'provider.deepgram': 'Deepgram',
  'provider.elevenlabs': 'ElevenLabs',
  'provider.openrouter': 'OpenRouter',
  'provider.key.label': 'API ключ',
  'provider.key.helper': 'Пази се в системното хранилище за ключове, никога във файл с настройки.',
  'provider.key.saved': 'Запазен ключ, завършващ на {preview}',
  'provider.key.none': 'Още няма ключ',
  'provider.key.save': 'Запиши ключа',
  'provider.key.clear': 'Премахни ключа',
  'provider.key.clear.title': 'Да се премахне ли ключът за {provider}?',
  'provider.key.clear.body': 'Всичко, насочено към {provider}, спира да работи, докато не се запише нов ключ.',
  'provider.key.get': 'Вземи ключ',
  'provider.docs': 'Прочети документацията',
  'provider.test.button': 'Провери връзката',
  'provider.test.testing': 'Проверява се…',
  'provider.test.valid': 'Ключът работи',
  'provider.test.validAs': 'Свързан като {account}',
  'provider.test.invalid': 'Ключът не работи',
  'provider.test.reason': 'Причина: {reason}',
  'provider.test.never': 'Още не е проверяван',
  'provider.models.label': 'Модел',
  'provider.models.refresh': 'Опресни списъка',
  'provider.models.refreshing': 'Зарежда моделите…',
  'provider.models.empty': 'Провери ключа и моделите се появяват тук.',
  'provider.model.pricePerMinute': '{price} $ за минута аудио',
  'provider.model.pricePerHour': '{price} $ за час аудио',
  'provider.cap.diarization': 'Говорители',
  'provider.cap.wordTimestamps': 'Времена на думите',
  'provider.cap.translate': 'Превод',
  'provider.cloud.wordTimestamps.label': 'Времена на ниво дума',
  'provider.cloud.wordTimestamps.helper': 'Нужни са за субтитри, които се разделят на правилните места. Никой от тези доставчици не взима допълнително за тях.',
  'provider.upload.notice': '{name} ще бъде качен при {provider}.',

  // ── Settings · Files ────────────────────────────────────────────────────
  'settings.output.title': 'Какво се записва, когато задачата приключи',
  'settings.output.helper': 'Остави всичко изключено и експортирай на ръка от опашката.',
  'format.txt': 'Обикновен текст',
  'format.md': 'Markdown',
  'format.srt': 'Субтитри SubRip',
  'format.vtt': 'Субтитри WebVTT',
  'format.json': 'JSON',
  'format.csv': 'CSV',
  'output.location.label': 'Къде отиват',
  'output.location.beside': 'До изходния файл',
  'output.location.folder': 'Всичко в една папка',
  'output.location.unset': 'Още не е избрана папка',
  'output.includeSpeakers.label': 'Слагай говорителя пред всеки ред',
  'output.includeSpeakers.helper': 'Върши работа само когато в транскрипцията има говорители.',
  'output.overwrite.notice': 'Съществуващ файл със същото име се замества.',

  // ── Export ──────────────────────────────────────────────────────────────
  'export.button': 'Експортирай',
  'export.choose': 'Избери формат',
  'export.saving': 'Записва се…',
  'export.saved': 'Записано в {path}',
  'export.failed': 'Файлът не можа да се запише',
  'export.copy': 'Копирай в клипборда',
  'export.nothingSelected': 'Избери поне един готов файл.',

  // ── Settings · Subtitles ────────────────────────────────────────────────
  'settings.subtitles.title': 'Форма на субтитрите',
  'settings.subtitles.helper': 'Тези правила превръщат транскрипцията в субтитри. Стойностите по подразбиране са там, където указанията на BBC и Netflix съвпадат.',
  'subtitles.maxCharsPerLine.label': 'Знаци на ред',
  'subtitles.maxCharsPerLine.helper': '42 е ширината, която остава спокойно в кадър 16:9.',
  'subtitles.maxLines.label': 'Редове на субтитър',
  'subtitles.maxLines.helper': 'Два реда са професионалният таван. Три закриват картината.',
  'subtitles.maxDuration.label': 'Най-дълго на екрана',
  'subtitles.maxDuration.helper': 'Над това окото се връща и прочита реда втори път.',
  'subtitles.minDuration.label': 'Най-кратко на екрана',
  'subtitles.minDuration.helper': 'Проблясък под секунда не се чете, дори за една-единствена дума.',
  'subtitles.maxCps.label': 'Скорост на четене',
  'subtitles.maxCps.helper': 'Знаци в секунда. Над 17 повечето зрители изостават.',
  'subtitles.gapSplit.label': 'Разделяй при пауза',
  'subtitles.gapSplit.helper': 'Тишина поне толкова дълга приключва субтитъра, така че никой не минава през пауза, която се чува.',
  'subtitles.minGap.label': 'Разстояние между субтитрите',
  'subtitles.minGap.helper': 'Празни кадри, за да не се четат два субтитъра като един.',
  'subtitles.reset': 'Върни стандартните стойности',
  'units.characters': '{value} знака',
  'units.lines': '{value} реда',
  'units.seconds': '{value} с',
  'units.milliseconds': '{value} мс',
  'units.charsPerSecond': '{value} знака/с',

  // ── About ───────────────────────────────────────────────────────────────
  'about.title': 'За DropScribe',
  'about.version': 'Версия {version}',
  'about.platform': '{platform} · {arch}',
  'about.modelsDir': 'Моделите стоят в {path}',
  'about.repo': 'Изходният код в GitHub',
  'about.issues': 'Съобщи за проблем',
  'about.license': 'DropScribe е свободен софтуер под лиценза MIT.',
  'about.licenses': 'Известия за софтуер на трети страни',
  'about.privacy': 'Локалният модел не изпраща аудиото ти никъде. Доставчикът в облака го изпраща — в това е цялата сделка.',
  'about.credits': 'Стъпва на whisper.cpp и ffmpeg, които вършат трудната част.',
  'about.engines.title': 'Вградени двигатели',
  'about.engines.ready': 'Всички двигатели са на място.',
  'about.engines.missing': 'В тази версия липсва двигател. Транскрибирането ще се проваля, докато това не се оправи.',
  'about.engines.detail': 'Покажи какво е намерено',
  'about.engine.present': 'намерен',
  'about.engine.absent': 'липсва',

  // ── Errors ──────────────────────────────────────────────────────────────
  'error.title': 'Нещо се обърка',
  'error.noAudio': 'Този файл няма аудиопътека.',
  'error.unreadable': 'Файлът не можа да се прочете. Може да е преместен или преименуван.',
  'error.notAuthorized': 'Приложението няма право да чете този път. Отвори файла през „Избери файлове…“.',
  'error.ffmpeg': 'Аудиото не можа да се извлече от този файл.',
  'error.engineMissing': 'В тази версия липсва двигателят за транскрибиране.',
  'error.modelMissing': 'Файлът на модела вече го няма на диска. Изтегли го отново.',
  'error.outOfMemory': 'Нямаше достатъчно памет за този модел. Опитай с квантуван.',
  'error.diskFull': 'На диска няма достатъчно свободно място.',
  'error.writeFailed': 'Не можа да се запише в {path}.',
  'error.network': 'Доставчикът е недостъпен. Провери връзката.',
  'error.timeout': 'Доставчикът се забави твърде дълго с отговора.',
  'error.unauthorized': '{provider} отхвърли ключа.',
  'error.rateLimited': '{provider} ограничава този ключ. Изчакай малко и опитай отново.',
  'error.quota': 'Акаунтът в {provider} е без кредит.',
  'error.providerFailed': '{provider} върна грешка.',
  'error.keyMissing': 'Няма настроен ключ за {provider}.',
  'error.unknown': 'Нещо се обърка и приложението не може да каже какво.',
};
