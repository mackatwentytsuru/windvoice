// i18n: shared between main and renderer.
// Default language is Japanese; English is the only alternative for now.

export type UiLang = 'ja' | 'en';

export const UI_LANGS: { value: UiLang; label: string }[] = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' }
];

type Dict = Record<string, string>;

const ja: Dict = {
  // tabs
  'tab.general': '一般',
  'tab.hotkeys': 'ホットキー',
  'tab.dictionary': '辞書',
  'tab.history': '履歴',

  // status pill
  'status.idle': '待機中',
  'status.listening': '録音中…',
  'status.processing': '処理中…',
  'status.error': 'エラー',

  // tray
  'tray.ready': 'WindVoice — 待機中',
  'tray.connecting': 'WindVoice — 接続中…',
  'tray.listening': 'WindVoice — 録音中…',
  'tray.processing': 'WindVoice — 処理中…',
  'tray.error': 'WindVoice — エラー',
  'tray.unavailable': 'WindVoice — 利用不可（設定を確認）',
  'tray.settings': '設定…',
  'tray.quit': '終了',
  'tray.accessibilityWarning': '⚠ アクセシビリティ権限が未許可 — クリックして開く',

  // overlay
  'overlay.listening': '録音中',
  'overlay.processing': '処理中…',

  // general page
  'general.title': '一般',
  'general.apiKey': 'OpenAI API キー',
  'general.apiKeyPlaceholderHas': '•••••• (資格情報マネージャーに保存済み)',
  'general.apiKeyPlaceholderEmpty': 'sk-...',
  'general.save': '保存',
  'general.saving': '保存中…',
  'general.saved': '保存しました',
  'general.apiKeyHelper': 'API キーは資格情報ストアに保存され、ディスクには書かれません。',
  'general.apiKeyHelper.darwin': 'API キーは macOS Keychain に保存されます。',
  'general.apiKeyHelper.win32': 'API キーは Windows 資格情報マネージャに保存されます。',
  'general.apiKeyHelper.linux': 'API キーはシステムのキーリングに保存されます。',
  'general.language': '転写言語',
  'general.languageAuto': '自動検出',
  'general.languageJa': '日本語 (ja)',
  'general.languageEn': 'English (en)',
  'general.languageZh': '中文 (zh)',
  'general.languageKo': '한국어 (ko)',
  'general.uiLanguage': '表示言語',
  'general.insertion': '挿入方式',
  'general.insertionPaste': 'クリップボード貼り付け',
  'general.insertionPaste.darwin': 'Cmd+V (貼り付け)',
  'general.insertionPaste.win32': 'Ctrl+V (貼り付け)',
  'general.insertionType': '1文字ずつ入力',
  'general.insertionTypeHelper':
    '貼り付けを受け付けない/加工してしまうアプリ向けに、転写を1文字ずつキー入力します(Windows のみ。macOS / Linux では貼り付けに自動フォールバック)。',
  'general.formatter': '整形',
  'general.formatterEnable': 'GPT 後処理を有効化 (Phase 2)',
  'general.formatterHelper': '句読点補正・辞書適用・自然言語フォーマット指示を解釈します。',
  'general.feedback': 'フィードバック',
  'general.showOverlay': 'オーバーレイを表示',
  'general.showOverlayHelper': '録音中、画面下部に小さなインジケーターを表示します。',
  'general.soundCues': '効果音',
  'general.soundCuesHelper': '録音の開始・終了時に短いトーンを鳴らします。',
  'general.duckAudio': '録音中は他の音を小さく',
  'general.duckAudioHelper': '録音開始時にシステム音量を一時的に下げ、停止時に元に戻します。',
  'general.streaming': 'ストリーミング挿入(実験)',
  'general.streamingHelper':
    '発話中にリアルタイムで文字が現れます。GPT 整形は無効です。ユーザー辞書の置換候補がある場合は、正確な挿入前置換のため発話終了後の一括挿入に切り替わります。',
  'general.pasteCompat': '貼り付けの確実性',
  'general.pasteCompatHelper':
    '貼り付け後に元のクリップボードへ戻すまでの待ち時間を調整します。「速い」だとターミナルやリモートデスクトップなど反応の遅い環境で直前にコピーした内容が貼り付いてしまう場合があります。',
  'general.pasteCompatFast': '速い(低遅延)',
  'general.pasteCompatBalanced': '標準(推奨)',
  'general.pasteCompatSafe': '確実(ターミナル/リモート向け)',
  'general.excludeClipboardHistory': 'クリップボード履歴に残さない (Windows)',
  'general.excludeClipboardHistoryHelper':
    '音声入力したテキストを Windows のクリップボード履歴 (Win+V) に記録しません。macOS / Linux では無効。',
  'general.system': 'システム',
  'general.autoLaunch': 'OS起動時に自動起動',
  'general.autoLaunchHelper': 'Windows / macOS のログイン時に WindVoice を自動で起動します。',
  'general.autoUpdate': '自動アップデート',
  'general.autoUpdateHelper': '起動時と4時間ごとに GitHub Releases を確認し、更新があれば通知します。ダウンロードと再起動はクリックで実行します。',
  'general.errorReporting': 'エラーレポートの自動送信',
  'general.errorReportingHelper':
    'エラー発生時に GitHub リポジトリへ診断 issue を自動作成します（重複はまとめられます）。文字起こし本文や API キーは送信されません。',
  'general.transcriptLogging': '辞書学習用の転写ログを保存',
  'general.transcriptLoggingHelper':
    'オプトインです。API キー等をマスクした認識前後のテキストだけをローカルの transcript-learning.jsonl に保存します。発話内容自体は含まれるため、秘密を話す場面では無効にしてください。',
  'general.checkForUpdate': '更新を確認',
  'general.updateAvailable': '新しいバージョンが利用可能',
  'general.updateDownload': 'ダウンロード',
  'general.updateDownloading': 'ダウンロード中',
  'general.updateDownloaded': 'ダウンロード完了。再起動で適用。',
  'general.updateRestart': '今すぐ再起動',
  'general.updateError': 'アップデートエラー',
  'general.updateUpToDate': '最新版です',
  'general.updateChecking': '確認中…',
  'general.microphone': 'マイクデバイス',
  'general.microphoneDefault': '既定のデバイス',
  'general.microphoneRefresh': '再読込',
  'general.diagnostics': '診断',
  'general.testDictation': '3秒テスト録音',
  'general.testDictationRecording': '3秒録音中…',
  'general.testDictationHelper': 'ホットキーを使わずに3秒間録音し、カーソル位置に転写を貼り付けます。',
  'general.lastTranscript': '直近の転写:',

  // hotkeys page
  'hotkeys.title': 'ホットキー',
  'hotkeys.binding': 'バインド',
  'hotkeys.modePush': '押しっぱなし',
  'hotkeys.modeToggle': 'トグル',
  'hotkeys.record': '新しいショートカットを記録',
  'hotkeys.recordingPrompt': 'キーを押してください… Esc でキャンセル',
  'hotkeys.invalidCombo': 'このキーの組み合わせは使用できません',
  'hotkeys.addBinding': 'バインドを追加',
  'hotkeys.cannotRemoveLast': '最後のバインドは削除できません',
  'hotkeys.helper': 'バインドを記録するには「新しいショートカットを記録」を押してから希望のキーを押してください。',
  'hotkeys.duplicate': '別の binding と同じキーが指定されています。',
  'hotkeys.recordHint': '実行したいキー組み合わせを押してください (修飾キーだけでは確定しません)',
  'hotkeys.useFn': 'Fn (地球儀) キーを使う',
  'hotkeys.useFnHint': 'macOS の Fn / 地球儀キーをホットキーに設定します (キャプチャ不要)',

  // dictionary page
  'dictionary.title': '辞書',
  'dictionary.helper': '誤変換を正しい表記へ追加します。ローカル辞書へマージされ、音声認識ヒントと挿入前置換に使われます。',
  'dictionary.from': '聞き取り',
  'dictionary.to': '正しい表記',
  'dictionary.add': '追加',
  'dictionary.empty': '登録がありません。',

  // replacements page
  'tab.replacements': '置換',
  'replacements.title': 'テキストマクロ',
  'replacements.helper': '転写の中で完全一致したフレーズを定型文に展開します。例: 「メアド」→「macka@example.com」。',
  'replacements.trigger': 'トリガー',
  'replacements.expansion': '展開後',
  'replacements.add': '追加',
  'replacements.empty': '登録がありません。',
  'replacements.wordBoundary': '単語境界で一致',
  'tab.appModes': 'アプリ別',
  'appModes.title': 'アプリ別モード',
  'appModes.helper':
    'アプリごとに整形の指示を切り替えます。前面アプリ名に一致したプロファイルの指示が整形プロンプトに追加されます。例: ターミナルには「簡潔に、記号や Markdown を使わない」。整形(GPT 後処理)が有効なときのみ働きます。',
  'appModes.matchPlaceholder': 'アプリ名(部分一致)',
  'appModes.instructionsPlaceholder': '整形指示(例: 簡潔に、Markdown 不可)',
  'appModes.add': '追加',
  'appModes.empty': '登録がありません。',
  'appModes.noInstructions': '(指示なし)',

  // history page
  'history.title': '履歴',
  'history.clearAll': 'すべて削除',
  'history.empty': '転写の履歴がありません。ホットキーまたは「一般」タブのテスト録音ボタンを使って録音してください。',
  'history.copy': 'コピー',
  'history.copied': 'コピー済み',
  'history.confirmClearAll': 'すべての履歴を削除しますか?',

  // first-run dialog
  'dialog.firstRun.title': 'WindVoice — 初回起動',
  'dialog.firstRun.message': 'OpenAI API キーが未設定です。',
  'dialog.firstRun.detail':
    '設定画面を開き、API キー欄に OpenAI API キーを貼り付けて保存してください。\n\nキーは Windows 資格情報マネージャー (keytar) に保存されます。',
  'dialog.firstRun.button': '設定を開く',
  'firstRun.apiKey.darwin': 'macOS Keychain に保存',
  'firstRun.apiKey.win32': 'Windows 資格情報マネージャに保存',

  // errors
  'error.apiKeyInvalid': 'API キーの形式が正しくありません。',
  'error.secureStoreUnavailable': '資格情報ストアが利用できません。',
  'error.noAudioDetected': '音声が検出されませんでした。マイクに向かって話してから離してください。',
  'error.micUnavailable':
    'マイクから音声を取得できません。他のアプリ（Teams や Zoom など）がマイクを使用していないか確認し、Windows の入力デバイス設定を見直してください。',
  'error.audioNotSent': '音声をサーバーに送信できませんでした。ネットワーク接続を確認して、もう一度お試しください。',

  // aria / accessibility
  'aria.delete': '削除',
  'aria.copy': 'コピー',
  'aria.copied': 'コピーしました',
  'aria.activeTab': '選択中のタブ'
};

const en: Dict = {
  // tabs
  'tab.general': 'General',
  'tab.hotkeys': 'Hotkeys',
  'tab.dictionary': 'Dictionary',
  'tab.history': 'History',
  'tab.replacements': 'Replacements',

  // status pill
  'status.idle': 'Idle',
  'status.listening': 'Listening...',
  'status.processing': 'Processing...',
  'status.error': 'Error',

  // tray
  'tray.ready': 'WindVoice — Ready',
  'tray.connecting': 'WindVoice — Connecting...',
  'tray.listening': 'WindVoice — Listening...',
  'tray.processing': 'WindVoice — Processing...',
  'tray.error': 'WindVoice — Error',
  'tray.unavailable': 'WindVoice — Unavailable (check settings)',
  'tray.settings': 'Settings...',
  'tray.quit': 'Quit',
  'tray.accessibilityWarning': '⚠ Accessibility not granted — click to open',

  // overlay
  'overlay.listening': 'Listening',
  'overlay.processing': 'Processing...',

  // general page
  'general.title': 'General',
  'general.apiKey': 'OpenAI API Key',
  'general.apiKeyPlaceholderHas': '•••••• (saved in Credential Manager)',
  'general.apiKeyPlaceholderEmpty': 'sk-...',
  'general.save': 'Save',
  'general.saving': 'Saving...',
  'general.saved': 'Saved.',
  'general.apiKeyHelper': 'Your API key is stored in the system credential store. Not written to disk.',
  'general.apiKeyHelper.darwin': 'Your API key is stored in macOS Keychain.',
  'general.apiKeyHelper.win32': 'Your API key is stored in Windows Credential Manager.',
  'general.apiKeyHelper.linux': 'Your API key is stored in the system keyring.',
  'general.language': 'Transcription Language',
  'general.languageAuto': 'Auto-detect',
  'general.languageJa': 'Japanese (ja)',
  'general.languageEn': 'English (en)',
  'general.languageZh': 'Chinese (zh)',
  'general.languageKo': 'Korean (ko)',
  'general.uiLanguage': 'UI Language',
  'general.insertion': 'Insertion method',
  'general.insertionPaste': 'Clipboard paste',
  'general.insertionPaste.darwin': 'Cmd+V (paste)',
  'general.insertionPaste.win32': 'Ctrl+V (paste)',
  'general.insertionType': 'Type per character',
  'general.insertionTypeHelper':
    'For apps that mangle or block a paste — sends the transcript as individual keystrokes (Windows only; falls back to paste on macOS / Linux).',
  'general.formatter': 'Formatter',
  'general.formatterEnable': 'Enable GPT post-processing (Phase 2)',
  'general.formatterHelper':
    'Adds punctuation, applies dictionary, and interprets natural-language formatting commands.',
  'general.feedback': 'Feedback',
  'general.showOverlay': 'Show overlay',
  'general.showOverlayHelper': 'Display a small floating indicator while recording.',
  'general.soundCues': 'Sound cues',
  'general.soundCuesHelper': 'Play a short tone when recording starts and stops.',
  'general.duckAudio': 'Duck other audio while recording',
  'general.duckAudioHelper': 'Temporarily lower the system volume when recording starts; restore when it stops.',
  'general.streaming': 'Streaming paste (experimental)',
  'general.streamingHelper':
    'Type characters as you speak. GPT formatting is disabled. When the user dictionary has replacement candidates, WindVoice switches to final insertion so corrections happen before any text is inserted.',
  'general.pasteCompat': 'Paste reliability',
  'general.pasteCompatHelper':
    'Adjusts how long WindVoice waits before restoring your original clipboard after a paste. "Fast" can paste your previously-copied content instead in slow environments such as terminals or remote desktops.',
  'general.pasteCompatFast': 'Fast (low latency)',
  'general.pasteCompatBalanced': 'Balanced (recommended)',
  'general.pasteCompatSafe': 'Safe (terminals / remote)',
  'general.excludeClipboardHistory': 'Keep out of clipboard history (Windows)',
  'general.excludeClipboardHistoryHelper':
    "Don't record dictated text in the Windows clipboard history (Win+V). No effect on macOS / Linux.",
  'general.system': 'System',
  'general.autoLaunch': 'Launch on login',
  'general.autoLaunchHelper': 'Start WindVoice automatically when Windows / macOS signs in.',
  'general.autoUpdate': 'Auto-update',
  'general.autoUpdateHelper': 'Check GitHub Releases on startup and every 4 hours, and notify you when an update is available. Download and restart happen on click.',
  'general.errorReporting': 'Automatic error reporting',
  'general.errorReportingHelper':
    'When an error occurs, automatically file a diagnostic issue on the GitHub repo (duplicates are merged). Transcripts and API keys are never sent.',
  'general.transcriptLogging': 'Save transcript log for dictionary learning',
  'general.transcriptLoggingHelper':
    'Opt-in. Saves only secret-scrubbed raw/corrected text to local transcript-learning.jsonl. Spoken content is included, so keep this off when dictating secrets.',
  'general.checkForUpdate': 'Check for update',
  'general.updateAvailable': 'A new version is available',
  'general.updateDownload': 'Download',
  'general.updateDownloading': 'Downloading',
  'general.updateDownloaded': 'Downloaded. Restart to apply.',
  'general.updateRestart': 'Restart now',
  'general.updateError': 'Update error',
  'general.updateUpToDate': 'Up to date',
  'general.updateChecking': 'Checking…',
  'general.microphone': 'Microphone',
  'general.microphoneDefault': 'System default',
  'general.microphoneRefresh': 'Refresh',
  'general.diagnostics': 'Diagnostics',
  'general.testDictation': 'Test dictation (3 s)',
  'general.testDictationRecording': 'Recording 3 s...',
  'general.testDictationHelper':
    'Record 3 seconds without using a hotkey, then paste the transcript at your cursor.',
  'general.lastTranscript': 'Last transcript:',

  // hotkeys page
  'hotkeys.title': 'Hotkeys',
  'hotkeys.binding': 'Binding',
  'hotkeys.modePush': 'Push to talk',
  'hotkeys.modeToggle': 'Toggle',
  'hotkeys.record': 'Record new shortcut',
  'hotkeys.recordingPrompt': 'Press a combo... Esc to cancel',
  'hotkeys.invalidCombo': 'Invalid combo',
  'hotkeys.addBinding': 'Add binding',
  'hotkeys.cannotRemoveLast': 'Cannot remove the last binding',
  'hotkeys.helper':
    'Click "Record new shortcut" then press the desired key combination.',
  'hotkeys.duplicate': 'This key combo is already assigned to another binding.',
  'hotkeys.recordHint': "Press the desired key combo (modifiers alone won't commit)",
  'hotkeys.useFn': 'Use Fn (Globe) key',
  'hotkeys.useFnHint': 'Bind the macOS Fn / Globe key as the hotkey (no key capture required)',

  // dictionary page
  'dictionary.title': 'Dictionary',
  'dictionary.helper':
    'Add common mishearings. They are merged into the local dictionary for Realtime hints and pre-insertion replacement.',
  'dictionary.from': 'heard',
  'dictionary.to': 'corrected',
  'dictionary.add': 'Add',
  'dictionary.empty': 'No entries yet.',

  // replacements page
  'replacements.title': 'Text macros',
  'replacements.helper':
    'Expand exact-match phrases in the transcript into longer text. E.g. "my email" → "macka@example.com".',
  'replacements.trigger': 'Trigger',
  'replacements.expansion': 'Expansion',
  'replacements.add': 'Add',
  'replacements.empty': 'No entries yet.',
  'replacements.wordBoundary': 'Match on word boundaries',
  'tab.appModes': 'App modes',
  'appModes.title': 'Per-app modes',
  'appModes.helper':
    'Switch formatting per application. When the foreground app name matches a profile, its instructions are added to the formatter prompt — e.g. "terse, no markdown" for a terminal. Only takes effect while GPT formatting is enabled.',
  'appModes.matchPlaceholder': 'App name (substring)',
  'appModes.instructionsPlaceholder': 'Formatter instructions (e.g. terse, no markdown)',
  'appModes.add': 'Add',
  'appModes.empty': 'No entries yet.',
  'appModes.noInstructions': '(no instructions)',

  // history page
  'history.title': 'History',
  'history.clearAll': 'Clear all',
  'history.empty':
    'No transcriptions yet. Use the hotkey or the Test button on General to record one.',
  'history.copy': 'Copy',
  'history.copied': 'Copied',
  'history.confirmClearAll': 'Delete all history entries?',

  // first-run dialog
  'dialog.firstRun.title': 'WindVoice — first run',
  'dialog.firstRun.message': 'No OpenAI API key configured.',
  'dialog.firstRun.detail':
    'Open the settings window, paste your OpenAI API key in the API Key field, and save.\n\nThe key is stored in the Windows Credential Manager (via keytar).',
  'dialog.firstRun.button': 'Open Settings',
  'firstRun.apiKey.darwin': 'Saved to macOS Keychain',
  'firstRun.apiKey.win32': 'Saved to Windows Credential Manager',

  // errors
  'error.apiKeyInvalid': 'API key format is invalid.',
  'error.secureStoreUnavailable': 'Credential store unavailable.',
  'error.noAudioDetected': 'No audio was detected. Speak into the microphone, then release the key.',
  'error.micUnavailable':
    "Can't capture audio from the microphone. Check that no other app (e.g. Teams or Zoom) is using it, and review your input device in Windows sound settings.",
  'error.audioNotSent': "Couldn't send audio to the server. Check your network connection and try again.",

  // aria / accessibility
  'aria.delete': 'Delete',
  'aria.copy': 'Copy',
  'aria.copied': 'Copied',
  'aria.activeTab': 'Currently selected tab'
};

const TABLES: Record<UiLang, Dict> = { ja, en };

export type I18nKey = keyof typeof ja;

export function t(key: I18nKey | string, lang: UiLang): string {
  const table = TABLES[lang];
  return table[key as string] ?? ja[key as string] ?? String(key);
}

/**
 * Returns true when the given key exists in the Japanese (canonical) table.
 * Useful for callers that need to fall back when a platform-suffixed variant
 * is not defined.
 */
export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ja, key);
}
