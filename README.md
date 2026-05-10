# WindVoice

> WindVoice — voice dictation for Windows and macOS, powered by the OpenAI Realtime API.
> **Right Ctrl** を押しっぱなし → 喋る → 離す → カーソル位置に転写が貼り付く。

OpenAI が 2026/05 に発表した GA Realtime API (`gpt-realtime-whisper`) を使った Electron アプリ。Notepad / Chrome / VS Code / Slack / Word / ChatGPT 等、任意の入力欄で動く。Windows と macOS の両方で動作する。

**Status (v0.1.0, ローカルビルドのみ)**:
- Phase 1-3 すべて実装済み — push-to-talk / 履歴 / 設定UI / GPT-5-mini フォーマッター / ライブオーバーレイ / ホットキー再バインド / Replacements / ストリーミング挿入 / ファイルタグ / アクティブウィンドウ認識 / electron-updater / macOS 対応 / 音声フィードバック
- GitHub Releases は **空**(自動更新無効状態)。`npm run release` で必要なときに publish。
- リポジトリは PUBLIC、MIT License。

詳細メモ: Obsidian `1_Projects/WindVoice/WindVoice.md`

---

## スタック

- Electron 42 + TypeScript (electron-vite 5 + electron-builder 26)
- Vite 6 + React 18 (renderer)
- OpenAI Realtime WebSocket: `wss://api.openai.com/v1/realtime?intent=transcription`, model `gpt-realtime-whisper`
- `uiohook-napi` — グローバルホットキー + `Ctrl+V` / `Cmd+V` 送信を兼用
- `keytar` — API キーを Windows 資格情報マネージャー / macOS Keychain に保存
- `electron-store` + Zod — 一般設定の永続化
- `get-windows` — アクティブウィンドウ検知(履歴・フォーマッタ文脈)
- `electron-updater` — GitHub Releases 経由の自動更新
- `loudness` — 録音中のシステム音量ダック
- WebAudio + AudioWorklet (隠しレンダラー) — 24 kHz mono PCM16 ダウンサンプル

## 使い方 (開発)

```bash
# Windows
cd C:\Users\macka\Projects\windvoice
# macOS
cd ~/Projects/windvoice

npm install            # uiohook-napi + keytar を Electron 用に rebuild
npm run dev            # electron-vite dev mode
```

初回起動:
1. トレイ (Win) / メニューバー (mac) に WindVoice アイコン
2. Settings → General → API Key 欄に `sk-...` を貼って Save
3. キーは `WindVoice/openai-api-key` として **Windows 資格情報マネージャー**（汎用資格情報） または **macOS Keychain** に保存される

### デフォルトホットキー

- **Windows / macOS**: **Right Ctrl** (push-to-talk) — Settings → Hotkeys タブから打鍵で再バインド可能。

#### ホットキー選択のガイド

| キー | Win 推奨度 | 備考 |
|---|---|---|
| **Right Ctrl** | ⭐ 最推奨 | 修飾キーだが menu mode に引っかからない・streaming も実用的 |
| F13 / Caps Lock | ⭐ 推奨 | 非修飾キーなのでレース皆無。AHK でリマップ済みの人向け |
| **Right Alt** | ⚠️ 非推奨 | Windows の Alt menu mode に引っかかり、Notepad 等で paste がメニュー操作に化ける場合あり。modifier release を待つ実装で軽減はしているが、Alt 解放後のメニューモード残留は OS 仕様で完全には逃げきれない |
| Right Shift | ⚠️ 非推奨 | 多くの IME が日本語入力切替に使う |
| Space / Enter | ❌ NG | 通常入力と衝突 |

> **実環境テスト結果**: Right Ctrl だと Notepad / Windows Terminal / ChatGPT すべてで paste が完全に動作。streaming insertion も実用的。Right Alt は Notepad で menu activation キーが overlay 表示されて paste が崩れる場合がある。

### macOS 初回起動

1. **Gatekeeper（未署名 DMG）の回避**:
   - Finder で `WindVoice.app` を右クリック → "Open" を選択 → "Open" を確認
   - もしくはターミナルで `xattr -cr /Applications/WindVoice.app`
2. **アクセシビリティ権限**: System Settings → Privacy & Security → Accessibility で WindVoice を有効化（グローバルホットキー検知 + `Cmd+V` 送出に必須）
3. **マイクアクセス権限**: 初回録音時にダイアログが出る → 許可
4. **音量ダッキング**: macOS ではデフォルトで無効（システム全体の出力音量を変えてしまうため）。明示的に有効化したい場合は環境変数 `WINDVOICE_DUCK_MAC=1` を付けて起動
5. **自動アップデート**: 未署名ビルドではデフォルトで無効。`WINDVOICE_AUTOUPDATE_DARWIN=1` を付けると有効化

### デバッグログ

```bash
WINDVOICE_DEBUG_HOTKEY=1 \
WINDVOICE_DEBUG_AUDIO=1 \
WINDVOICE_DEBUG_REALTIME=1 \
WINDVOICE_DEBUG_DICTATION=1 \
npm run dev
```

stderr に `[hotkey]` `[audio]` `[realtime]` `[dictation]` のログが流れる。

### テスト

```bash
npm test               # vitest run
npm run typecheck      # node + web の strict TS チェック
```

### インストーラ生成

```bash
npm run package:win    # Windows: → release/<ver>/WindVoice-Setup-<ver>-x64.exe (NSIS)
npm run package:mac    # macOS:   → release/<ver>/WindVoice-<ver>-{arm64,x64}.dmg
                       #          ※ Mac 上でしかビルドできない (codesign + dmg-license)
npm run release        # GitHub Releases に publish (auto-updater が拾う)
```

`package:win` は署名なし(`signtoolOptions: null` + `forceCodeSigning: false`)。
`package:mac` も署名なし（`identity: null`）。配布された DMG はユーザー側で右クリック→Open する必要があるか、`xattr -cr` で quarantine を外す必要がある。署名/公証する場合は `CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` を設定して `electron-builder.yml` の `identity: null` を外す。

---

## アーキテクチャ

```
[Right Alt / Right Ctrl] ──→ HotkeyManager (uiohook-napi)
                       │
                       ▼
              DictationOrchestrator
              ┌────────┴────────┐
              ▼                 ▼
       AudioBridge        RealtimeClient
       (隠しレンダラー)    (永続 WebSocket)
              │                 │
       getUserMedia +     wss://api.openai.com
       AudioWorklet       /v1/realtime
              │           ?intent=transcription
       24kHz PCM16               │
       50ms chunk                ▼
              └──────→ input_audio_buffer.append
                                 ▼
                  conversation.item.input_audio_transcription.delta/completed
                                 ▼
                          PostProcessor pipeline
                          (formatter → replacements → fileTags)
                                 ▼
                          TextInjector
                          (clipboard退避→Ctrl+V/Cmd+V→復元)
                                 ▼
                          [カーソル位置に挿入]
                                 ▼
                          HistoryStore に追記
```

## ディレクトリ

```
src/
├── main/
│   ├── index.ts                    # アプリ起動・トレイ・ライフサイクル
│   ├── audio/bridge.ts             # 隠しレンダラー管理 + prewarm
│   ├── audio/duck.ts               # 音量ダッキング (mac はデフォルト無効)
│   ├── autoLaunch.ts               # OS 起動時の自動起動
│   ├── context/activeWindow.ts     # アクティブウィンドウ取得 (get-windows)
│   ├── dictation/orchestrator.ts   # 永続WS + start/stop ライフサイクル
│   ├── hotkey/manager.ts           # uIOhook + 修飾キー判定
│   ├── inject/typer.ts             # clipboard退避→paste→復元
│   ├── ipc/handlers.ts
│   ├── overlay/window.ts           # 半透明オーバーレイ (multi-monitor / Dock-aware)
│   ├── postprocess/{pipeline,formatter,replacements,fileTags}.ts
│   ├── realtime/{client,events}.ts # OpenAI WS + Zodイベント
│   ├── store/{secure,settings,history}.ts
│   ├── tray/index.ts               # 4状態アイコン
│   └── updater/index.ts            # electron-updater (mac はデフォルト無効)
├── preload/index.ts                # contextBridge
├── renderer/
│   ├── index.html + main.tsx       # 設定ウィンドウ
│   ├── audio.html + audio.ts       # 隠しオーディオワーカー
│   ├── audio-worklet.js            # PCM ダウンサンプラー (Blob URL)
│   ├── overlay.html + overlay.tsx  # オーバーレイレンダラー
│   ├── App.tsx + pages/*.tsx       # General / Hotkeys / Dictionary / History
│   └── env.d.ts
└── shared/{types,ipc,i18n}.ts      # IPC + Zod + 翻訳
```

## 機能一覧

### Phase 1 (DONE)
- Right Alt (Win) / Right Ctrl (mac) push-to-talk / toggle
- 24 kHz mono PCM ストリーミング → OpenAI Realtime
- クリップボード貼り付け (元クリップボード復元)
- トレイ / メニューバー (4状態アイコン)
- Settings: API キー, 言語, 挿入方式
- 辞書 (raw → corrected ペア)
- ホットキー設定 (push-to-talk vs toggle)
- 履歴 (最大200件、コピー・削除・全削除、自動更新)
- Test dictation 3秒ボタン (動作確認用)

### Phase 2 (DONE)
- GPT-5-mini フォーマッター (ハルシ削除・句読点・辞書適用)
- ライブオーバーレイ (発話中の半透明プレビュー + 音量メーター)
- ホットキー再バインド UI (打鍵で登録)

### Phase 3 (DONE)
- アクティブウィンドウ認識 (`get-windows`) → アプリ別整形
- Replacements (テキストマクロ展開)
- ストリーミング挿入 (Settings から有効化)
- ファイルタグ (`@main.ts` で Cursor/Windsurf 用)
- 音声フィードバック (start/stop beep)
- Windows/mac スタートアップ自動起動
- electron-updater で自動更新 (Win 既定 / mac は opt-in)
- macOS 対応

---

## コスト目安

| 項目 | 単価 |
|---|---|
| `gpt-realtime-whisper` | $0.017 / 分 |
| `gpt-5-mini` 整形 | < $0.001 / 回 |

30分/日 使用想定で **月 $15-20**。

---

## License

Copyright (c) 2026 mackatwentytsuru. MIT License (see [LICENSE](./LICENSE)).
