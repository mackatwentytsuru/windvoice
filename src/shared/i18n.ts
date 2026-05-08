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
  'tray.listening': 'WindVoice — 録音中…',
  'tray.processing': 'WindVoice — 処理中…',
  'tray.error': 'WindVoice — エラー',
  'tray.settings': '設定…',
  'tray.quit': '終了',

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
  'general.apiKeyHelper': 'Windows 資格情報マネージャーに保存され、ディスクには書かれません。',
  'general.language': '転写言語',
  'general.languageAuto': '自動検出',
  'general.languageJa': '日本語 (ja)',
  'general.languageEn': 'English (en)',
  'general.languageZh': '中文 (zh)',
  'general.languageKo': '한국어 (ko)',
  'general.uiLanguage': '表示言語',
  'general.insertion': '挿入方式',
  'general.insertionPaste': 'クリップボード貼り付け (Ctrl+V)',
  'general.insertionType': '1文字ずつ入力 (Phase 3)',
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
  'hotkeys.helper': 'キー再バインド UI は Phase 2 で実装予定です。デフォルトの Right Alt はコード内で固定されています。',

  // dictionary page
  'dictionary.title': '辞書',
  'dictionary.helper': 'モデルが聞き取った単語を正しい綴りに置換します。整形ステップで適用されます (Phase 2)。',
  'dictionary.from': '聞き取り',
  'dictionary.to': '正しい表記',
  'dictionary.add': '追加',
  'dictionary.empty': '登録がありません。',

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
  'dialog.firstRun.button': '設定を開く'
};

const en: Dict = {
  'tab.general': 'General',
  'tab.hotkeys': 'Hotkeys',
  'tab.dictionary': 'Dictionary',
  'tab.history': 'History',

  'status.idle': 'Idle',
  'status.listening': 'Listening...',
  'status.processing': 'Processing...',
  'status.error': 'Error',

  'tray.ready': 'WindVoice — Ready',
  'tray.listening': 'WindVoice — Listening...',
  'tray.processing': 'WindVoice — Processing...',
  'tray.error': 'WindVoice — Error',
  'tray.settings': 'Settings...',
  'tray.quit': 'Quit',

  'overlay.listening': 'Listening',
  'overlay.processing': 'Processing...',

  'general.title': 'General',
  'general.apiKey': 'OpenAI API Key',
  'general.apiKeyPlaceholderHas': '•••••• (saved in Credential Manager)',
  'general.apiKeyPlaceholderEmpty': 'sk-...',
  'general.save': 'Save',
  'general.saving': 'Saving...',
  'general.saved': 'Saved.',
  'general.apiKeyHelper': 'Stored via Windows Credential Manager. Not written to disk.',
  'general.language': 'Transcription Language',
  'general.languageAuto': 'Auto-detect',
  'general.languageJa': 'Japanese (ja)',
  'general.languageEn': 'English (en)',
  'general.languageZh': 'Chinese (zh)',
  'general.languageKo': 'Korean (ko)',
  'general.uiLanguage': 'UI Language',
  'general.insertion': 'Insertion method',
  'general.insertionPaste': 'Clipboard paste (Ctrl+V)',
  'general.insertionType': 'Type per character (Phase 3)',
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
  'general.microphone': 'Microphone',
  'general.microphoneDefault': 'System default',
  'general.microphoneRefresh': 'Refresh',
  'general.diagnostics': 'Diagnostics',
  'general.testDictation': 'Test dictation (3 s)',
  'general.testDictationRecording': 'Recording 3 s...',
  'general.testDictationHelper':
    'Record 3 seconds without using a hotkey, then paste the transcript at your cursor.',
  'general.lastTranscript': 'Last transcript:',

  'hotkeys.title': 'Hotkeys',
  'hotkeys.binding': 'Binding',
  'hotkeys.modePush': 'Push to talk',
  'hotkeys.modeToggle': 'Toggle',
  'hotkeys.helper':
    'Editable key remapping UI is Phase 2. The default RightAlt is wired in code.',

  'dictionary.title': 'Dictionary',
  'dictionary.helper':
    'Replace what the model heard with the canonical spelling. Applied during the formatter step (Phase 2).',
  'dictionary.from': 'heard',
  'dictionary.to': 'corrected',
  'dictionary.add': 'Add',
  'dictionary.empty': 'No entries yet.',

  'history.title': 'History',
  'history.clearAll': 'Clear all',
  'history.empty':
    'No transcriptions yet. Use the hotkey or the Test button on General to record one.',
  'history.copy': 'Copy',
  'history.copied': 'Copied',
  'history.confirmClearAll': 'Delete all history entries?',

  'dialog.firstRun.title': 'WindVoice — first run',
  'dialog.firstRun.message': 'No OpenAI API key configured.',
  'dialog.firstRun.detail':
    'Open the settings window, paste your OpenAI API key in the API Key field, and save.\n\nThe key is stored in the Windows Credential Manager (via keytar).',
  'dialog.firstRun.button': 'Open Settings'
};

const TABLES: Record<UiLang, Dict> = { ja, en };

export type I18nKey = keyof typeof ja;

export function t(key: I18nKey, lang: UiLang): string {
  const table = TABLES[lang];
  return table[key] ?? ja[key] ?? String(key);
}
