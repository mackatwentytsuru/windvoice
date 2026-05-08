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
  'general.streaming': 'ストリーミング挿入(実験)',
  'general.streamingHelper': '発話中にリアルタイムで文字が現れます。GPT 整形は無効になります。',
  'general.system': 'システム',
  'general.autoLaunch': 'OS起動時に自動起動',
  'general.autoLaunchHelper': 'Windows / macOS のログイン時に WindVoice を自動で起動します。',
  'general.autoUpdate': '自動アップデート',
  'general.autoUpdateHelper': 'GitHub Releases から最新版を自動チェック+ダウンロード(再起動で適用)。',
  'general.checkForUpdate': '更新を確認',
  'general.updateAvailable': '新しいバージョンが利用可能',
  'general.updateDownloaded': 'ダウンロード完了。再起動で適用。',
  'general.updateRestart': '今すぐ再起動',
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

  // dictionary page
  'dictionary.title': '辞書',
  'dictionary.helper': 'モデルが聞き取った単語を正しい綴りに置換します。整形ステップで適用されます。',
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
  'general.streaming': 'Streaming paste (experimental)',
  'general.streamingHelper': 'Type characters as you speak. GPT formatting is disabled in this mode.',
  'general.system': 'System',
  'general.autoLaunch': 'Launch on login',
  'general.autoLaunchHelper': 'Start WindVoice automatically when Windows / macOS signs in.',
  'general.autoUpdate': 'Auto-update',
  'general.autoUpdateHelper': 'Check GitHub Releases on startup and download new versions (apply on restart).',
  'general.checkForUpdate': 'Check for update',
  'general.updateAvailable': 'A new version is available',
  'general.updateDownloaded': 'Downloaded. Restart to apply.',
  'general.updateRestart': 'Restart now',
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
  'hotkeys.record': 'Record new shortcut',
  'hotkeys.recordingPrompt': 'Press a combo... Esc to cancel',
  'hotkeys.invalidCombo': 'Invalid combo',
  'hotkeys.addBinding': 'Add binding',
  'hotkeys.cannotRemoveLast': 'Cannot remove the last binding',
  'hotkeys.helper':
    'Click "Record new shortcut" then press the desired key combination.',

  'dictionary.title': 'Dictionary',
  'dictionary.helper':
    'Replace what the model heard with the canonical spelling. Applied during the formatter step.',
  'dictionary.from': 'heard',
  'dictionary.to': 'corrected',
  'dictionary.add': 'Add',
  'dictionary.empty': 'No entries yet.',

  'tab.replacements': 'Replacements',
  'replacements.title': 'Text macros',
  'replacements.helper':
    'Expand exact-match phrases in the transcript into longer text. E.g. "my email" → "macka@example.com".',
  'replacements.trigger': 'Trigger',
  'replacements.expansion': 'Expansion',
  'replacements.add': 'Add',
  'replacements.empty': 'No entries yet.',
  'replacements.wordBoundary': 'Match on word boundaries',

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
