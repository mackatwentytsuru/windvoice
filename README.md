# WindVoice

> Personal Windows voice-dictation app — AquaVoice風。
> Right Alt 押しっぱなし → 喋る → 離す → カーソル位置に転写が貼り付く。

OpenAI が 2026/05 に発表した GA Realtime API (`gpt-realtime-whisper`) を使った Electron アプリ。Notepad / Chrome / VS Code / Slack / Word / ChatGPT 等、任意の入力欄で動く。

**Status**: Phase 1 完了 (push-to-talk + 履歴 + 設定UI)。Phase 2 計画中 (フォーマッター・オーバーレイ・ホットキー再バインド)。
詳細メモ: Obsidian `1_Projects/WindVoice/WindVoice.md`

---

## スタック

- Electron 32 + TypeScript (electron-vite + electron-builder)
- React 18 (renderer)
- OpenAI Realtime WebSocket: `wss://api.openai.com/v1/realtime?intent=transcription`, model `gpt-realtime-whisper`
- `uiohook-napi` — グローバルホットキー + `Ctrl+V` 送信を兼用 (nut-js は不要)
- `keytar` — API キーを Windows 資格情報マネージャに保存
- `electron-store` + Zod — 一般設定の永続化
- WebAudio + AudioWorklet (隠しレンダラー) — 24 kHz mono PCM16 ダウンサンプル

## 使い方 (開発)

```powershell
cd C:\Users\macka\Projects\windvoice
npm install            # uiohook-napi + keytar を Electron 32 用に rebuild
npm run dev            # electron-vite dev mode
```

初回起動:
1. トレイに緑の丸アイコン
2. Settings → General → API Key 欄に `sk-...` を貼って Save
3. キーは `WindVoice/openai-api-key` として Windows 資格情報マネージャ (汎用資格情報) に保存される

### デフォルト

- **Right Alt** (push-to-talk): 押しっぱなしで録音、離すと commit & paste

ホットキー変更は Settings UI から (再バインド UI は Phase 2)。または `%APPDATA%\windvoice\windvoice-settings.json` を直接編集。

### デバッグログ

```powershell
$env:WINDVOICE_DEBUG_HOTKEY="1"
$env:WINDVOICE_DEBUG_AUDIO="1"
$env:WINDVOICE_DEBUG_REALTIME="1"
$env:WINDVOICE_DEBUG_DICTATION="1"
npm run dev
```

stderr に `[hotkey]` `[audio]` `[realtime]` `[dictation]` のログが流れる。

### テスト

```powershell
npm test               # vitest run (73 tests)
npm run typecheck      # node + web の strict TS チェック
```

### インストーラ生成

```powershell
npm run package:win    # → release/<ver>/WindVoice-Setup-<ver>-x64.exe (NSIS, 98 MB)
npm run package:mac    # → release/<ver>/WindVoice-<ver>-{arm64,x64}.dmg (Macで実行)
npm run release        # GitHub Releases に publish (auto-updater が拾う)
```

`package:win` は署名なし(`signtoolOptions: null` + `forceCodeSigning: false`)。
出力されたNSIS .exe をそのまま配布できます。

---

## アーキテクチャ

```
[Right Alt] ──→ HotkeyManager (uiohook-napi)
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
                          TextInjector
                          (clipboard退避→Ctrl+V→復元)
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
│   ├── dictation/orchestrator.ts   # 永続WS + start/stop ライフサイクル
│   ├── hotkey/manager.ts           # uIOhook + 修飾キー判定
│   ├── inject/typer.ts             # clipboard退避→Ctrl+V→復元
│   ├── ipc/handlers.ts
│   ├── realtime/{client,events}.ts # OpenAI WS + Zodイベント
│   ├── store/{secure,settings,history}.ts
│   └── tray/index.ts               # 4状態アイコン
├── preload/index.ts                # contextBridge
├── renderer/
│   ├── index.html + main.tsx       # 設定ウィンドウ
│   ├── audio.html + audio.ts       # 隠しオーディオワーカー
│   ├── audio-worklet.js            # PCM ダウンサンプラー (Blob URL)
│   ├── App.tsx + pages/*.tsx       # General / Hotkeys / Dictionary / History
│   └── env.d.ts
└── shared/types.ts                 # IPC + Zod
```

## 機能一覧

### Phase 1 完了
- Right Alt push-to-talk / toggle
- 24 kHz mono PCM ストリーミング → OpenAI Realtime
- クリップボード貼り付け (元クリップボード復元)
- トレイ (4状態アイコン)
- Settings: API キー, 言語, 挿入方式
- 辞書 (raw → corrected ペア)
- ホットキー設定 (push-to-talk vs toggle)
- 履歴 (最大200件、コピー・削除・全削除、自動更新)
- Test dictation 3秒ボタン (動作確認用)
- 16 unit + integration tests

### Phase 2 (計画)
- GPT-5-mini フォーマッター (ハルシ削除・句読点・辞書適用)
- ライブオーバーレイ (発話中の半透明プレビュー + 音量メーター)
- ホットキー再バインド UI (打鍵で登録)

### Phase 3 (将来)
- アクティブアプリ認識 (active-win) → アプリ別整形
- Replacements (テキストマクロ展開)
- ストリーミング挿入
- ファイルタグ (`@main.ts` で Cursor/Windsurf 用)
- 音声フィードバック / Windows スタートアップ
- electron-updater で自動更新
- macOS 対応

---

## コスト目安

| 項目 | 単価 |
|---|---|
| `gpt-realtime-whisper` | $0.017 / 分 |
| `gpt-5-mini` 整形 (Phase 2) | < $0.001 / 回 |

30分/日 使用想定で **月 $15-20**。

---

## License

Copyright (c) 2026 mackatwentytsuru. MIT License (see [LICENSE](./LICENSE)).
