# WindVoice

> **Right Ctrl** を押しっぱなし → 喋る → 離す → カーソル位置に転写が貼り付く。
> OpenAI Realtime API を使った Windows / macOS / Linux 向けの音声入力 Electron アプリ。

Notepad / Chrome / VS Code / Slack / Word / ChatGPT など、任意のテキスト入力欄で動作します。Whisper 系列の `gpt-realtime-whisper` でストリーミング転写し、GPT-5-mini で句読点・整形・辞書適用を行ったうえでクリップボード経由でペーストします。

---

## ステータス

| 項目 | 内容 |
|---|---|
| 最新リリース | **v0.1.7** ([releases/tag/v0.1.7](https://github.com/mackatwentytsuru/windvoice/releases/tag/v0.1.7)) |
| 対応プラットフォーム | macOS (Apple Silicon arm64) / Windows x64 / Linux x64 (AppImage・deb, experimental) |
| ビルド署名 | 未署名 (Gatekeeper / SmartScreen 回避手順あり) |
| 自動更新 | macOS は opt-in / Windows は既定で有効 |
| Unit test | 203 passed / 2 skipped (23 files, 205 cases) |
| ライセンス | MIT |

セッションで解決した GitHub Issue 累計: **35件** (Closed: #2–#12, #16–#35, #37, #39, #45, #46)

---

## インストール (エンドユーザー)

### macOS (Apple Silicon)

```bash
# 1. DMG をダウンロード
curl -L -o WindVoice.dmg \
  https://github.com/mackatwentytsuru/windvoice/releases/download/v0.1.7/WindVoice-0.1.7-arm64.dmg

# 2. マウントして /Applications にドラッグ (もしくは Finder から)
hdiutil attach WindVoice.dmg
cp -R "/Volumes/WindVoice 0.1.7-arm64/WindVoice.app" /Applications/
hdiutil detach "/Volumes/WindVoice 0.1.7-arm64"

# 3. 未署名なので quarantine 属性を除去
xattr -cr /Applications/WindVoice.app

# 4. 起動
open /Applications/WindVoice.app
```

または Finder で `WindVoice.app` を右クリック → "Open" → "Open" を確認 で 1 回承認しても可。

### Windows x64

[Releases ページ](https://github.com/mackatwentytsuru/windvoice/releases/latest) から `WindVoice-Setup-<ver>-x64.exe` を落として実行。SmartScreen は「詳細情報」→「実行」で通します。

### Linux x64 (experimental)

[Releases ページ](https://github.com/mackatwentytsuru/windvoice/releases/latest) から `WindVoice-<ver>-x86_64.AppImage` (どのディストロでも可) または `.deb` (Debian/Ubuntu) をダウンロード。

```bash
chmod +x WindVoice-*.AppImage
./WindVoice-*.AppImage
```

Wayland での貼り付けには Python サイドカー用の `python3` と PyGObject が必要です。`.deb` では `python3` / `python3-gi` が依存関係として自動導入されますが、AppImage ではホスト側に別途インストールしてください。

- Debian / Ubuntu: `python3`, `python3-gi`
- Fedora: `python3`, `python3-gobject`
- Arch Linux: `python`, `python-gobject`

初回セットアップ (Linux のみ):

1. **グローバルホットキーの権限** — キーボードイベントは evdev (`/dev/input`) から読むため、`input` グループへの参加が必要:

   ```bash
   sudo usermod -aG input $USER
   ```

   その後 **ログアウト → ログイン** (グループ変更の反映に必須)。

   `input` グループに参加すると、そのユーザー権限で動く任意のプロセスがパスワードを含むすべてのキー入力を読めるようになります。信頼できないプログラムが動く環境では推奨しません。

2. **Wayland の貼り付け許可** — Wayland セッションでは Ctrl+V 合成に XDG RemoteDesktop ポータルを使用します。初回起動時に表示されるリモートデスクトップの許可ダイアログを承認してください (承認は保存され、次回以降は表示されません)。誤って拒否した場合は 設定 → アプリ → リモートデスクトップ から再許可して WindVoice を再起動。

   権限を取り消すには、GNOME の「設定」→「アプリ」→「WindVoice」でリモートデスクトップ権限を無効にし、WindVoice を終了してから `~/.config/windvoice/.portal-remotedesktop.json` を削除してください。次回起動時には再度許可が求められます。

3. API キーはシステムのキーリング (GNOME Keyring / KWallet, libsecret 経由) に保存されます。

X11 セッションでは追加の許可は不要です (uiohook / XTest をそのまま使用)。GNOME でトレイアイコンを表示するには [AppIndicator 拡張](https://extensions.gnome.org/extension/615/appindicator-support/) が必要です。

---

## 初回セットアップ

1. **トレイ / メニューバーのアイコン** をクリック → 「設定…」
2. **General** タブ → OpenAI API キー (`sk-...`) を貼って **Save**
   - キーは OS の資格情報ストア (macOS Keychain / Windows 資格情報マネージャ) に保存され、ディスクには平文で書かれません
3. **macOS のみ**: System Settings → Privacy & Security → **Accessibility** で WindVoice を有効化
   - グローバルホットキー検知 + `Cmd+V` 送出に必須
   - 未許可だとトレイに「⚠アクセシビリティ権限が未許可」が表示されます
4. 初回録音時の **マイクアクセス** ダイアログを許可

---

## 使い方

### Push-to-talk (既定)

1. テキスト入力欄にカーソルを置く
2. **Right Ctrl** を押しっぱなしにして喋る
3. キーを離す → 数秒後にカーソル位置に転写テキストが貼り付く

### Toggle モード

Settings → Hotkeys でモードを `Toggle` に変更すると、1回目のキー押下で録音開始、2回目で停止できます。長文をハンズフリーで入力したい場合に便利。

### ホットキー再バインド

Settings → Hotkeys → 「キーを記録」をクリック → 任意のキー/組み合わせを打鍵。

#### おすすめキー

| キー | 推奨度 | 備考 |
|---|---|---|
| **Right Ctrl** | ⭐ 既定 | menu mode を踏まず streaming も安定 |
| **F13 / Caps Lock** | ⭐ 推奨 | 非修飾キーなのでレース皆無 (AHK / Karabiner でリマップ済みの人向け) |
| **Cmd (Meta)** | ⭐ macOS 向け | 左右どちらの Cmd でも検知される |
| Right Alt | ⚠️ 非推奨 (Win) | Notepad 等で Alt メニューモードに引っかかる場合あり |
| Right Shift | ⚠️ 非推奨 | 多くの IME が日本語入力切替に使う |
| Space / Enter | ❌ NG | 通常入力と衝突 |

---

## 機能

### 転写・整形
- **Streaming 転写**: 発話中に逐次転写 (低レイテンシ)
- **GPT-5-mini フォーマッタ**: 句読点・スペース・大文字化を自動補正、Whisper ハルシネーション(`結結結こんにちは…`等の繰り返し)を除去
- **辞書 (Dictionary)**: `raw → corrected` ペアでよく出る誤認識を一括置換
- **Replacements**: テキストマクロ展開 (`@email` → 自分のメアドなど)
- **自然言語コマンド**: 発話中の「改行」「箇条書き」「コードブロック」を構造化
- **アクティブウィンドウ認識**: フォーマッタの文脈にアプリ名を渡す (Cursor 等向けのファイルタグも)
- **言語自動検出 / 明示指定**: 日本語・英語・中国語・韓国語など

### UI / フィードバック
- **半透明オーバーレイ**: 録音中・処理中の状態 + 音量メーターを画面下部に
- **トレイアイコン 6状態**: idle / connecting / listening / processing / error / unavailable
- **音声フィードバック**: 録音開始・終了で短いトーン
- **エラーバナー**: 設定ウィンドウに paste 失敗 / formatter 401 / clipboard 復元失敗を表示
- **アクセシビリティ自動復旧**: 権限が後から付与されたら自動でホットキーを再有効化

### 挿入方式
- **Paste**: クリップボード退避 → `Cmd+V` (mac) / `Ctrl+V` (Win) 合成 → 元クリップボード復元 (既定)
- **Streaming insertion**: 発話中に随時 paste (短文入力向け)

### システム連携
- **音量ダッキング**: 録音中はシステム出力音量を一時的に下げる (mac は opt-in)
- **OS 自動起動**: ログイン時に WindVoice を自動起動
- **自動アップデート**: GitHub Releases から差分ダウンロード (Win 既定 / mac は opt-in)
- **クラッシュ時 clipboard 復元**: 前回 paste 中に異常終了しても次回起動で元の内容を戻す (safeStorage 暗号化)

### 履歴
- **最大 200 件** の転写履歴 (コピー / 個別削除 / 全削除)
- **タイムスタンプ + 関連アプリ名** を併記
- **safeStorage 暗号化** (OS Keychain 連携)

### セキュリティ
- 特権 IPC は Settings ウィンドウ送信者のみ許可 (`refuseUntrusted` ゲート)
- CSP (`default-src 'self'`, `script-src 'self' blob:`, `worker-src blob:` ...) を全レンダラーに適用
- shell.openExternal はスキーム allowlist 経由 (`x-apple.systempreferences:` / `https:` / `mailto:`)
- 辞書 / customInstructions は GPT system prompt 投入前にエスケープ (prompt injection 対策)
- electron-updater `autoDownload: false` & `autoInstallOnAppQuit: false` (未署名ビルドのサプライチェーン対策)

---

## トラブルシューティング

### ホットキーを押しても録音が始まらない
1. トレイに **⚠アクセシビリティ権限が未許可** が出ていないか確認
2. System Settings → Privacy & Security → Accessibility で WindVoice をオン
3. オンにすると 2 秒以内に自動でホットキー検知が有効化されます (再起動不要)

### ペーストされない / Ctrl+V が間違って入る (Mac)
v0.1.2 で修正済。古いビルドが残っていれば再インストールしてください。

### Cmd を離しても録音中が続く (Mac)
v0.1.3 で修正済 (streaming insertion 時の suppression race)。

### 文字が崩れる / 句読点が変
Settings → General → 「整形」を有効にし、API キーが正しく設定されているか確認。401 が出ている場合はトレイに赤い "Error" 表示+エラーバナーが出ます。

### デバッグログ

```bash
WINDVOICE_DEBUG_HOTKEY=1 \
WINDVOICE_DEBUG_AUDIO=1 \
WINDVOICE_DEBUG_REALTIME=1 \
WINDVOICE_DEBUG_DICTATION=1 \
/Applications/WindVoice.app/Contents/MacOS/WindVoice
```

stderr に `[hotkey]` `[audio]` `[realtime]` `[dictation]` が流れます。

---

## ビルド (コントリビューター向け)

### 前提
- Node.js 22 以上
- macOS Apple Silicon / Windows x64 / Linux x64 (`uiohook-napi`/`keytar` のネイティブビルド用)
- Mac でビルドする場合は Xcode Command Line Tools
- Linux でビルドする場合は X11 ヘッダ:

  ```bash
  sudo apt install build-essential libx11-dev libxtst-dev libxkbcommon-dev libsecret-1-dev
  ```

  ヘッダを入れられない環境では、同梱のプリビルドバイナリ (N-API) で動くため
  `npm install --ignore-scripts && npm rebuild --ignore-scripts` 相当の運用や
  `electron-builder --config.npmRebuild=false` でのパッケージングも可能。

### 開発モード

```bash
git clone https://github.com/mackatwentytsuru/windvoice.git
cd windvoice
npm install        # uiohook-napi + keytar が Electron 用に rebuild される
npm run dev        # electron-vite dev mode
```

### テスト・型チェック

```bash
npm test           # vitest run (205 cases — 203 passed, 2 skipped on Windows)
npm run typecheck  # tsconfig.node + tsconfig.web の strict TS チェック
```

### パッケージング

```bash
npm run package:mac    # release/<ver>/WindVoice-<ver>-{arm64,x64}.dmg (Mac でのみ可)
npm run package:win    # release/<ver>/WindVoice-Setup-<ver>-x64.exe (NSIS)
npm run package:linux  # release/<ver>/WindVoice-<ver>-x86_64.AppImage + .deb
npm run release        # GitHub Releases に publish
```

未署名ビルドのため `electron-builder.yml` の `identity: null` / `signtoolOptions: null` を外し、`CSC_LINK` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` を設定すれば署名 / 公証が可能。

---

## アーキテクチャ

```
[Right Ctrl / Cmd / ...] ──→ HotkeyManager (uiohook-napi)
                       │      (safety net: modifier 物理解放を検知して force-stop)
                       ▼
              DictationOrchestrator
              (idle → connecting → listening → processing → idle)
              ┌────────┴────────┐
              ▼                 ▼
       AudioBridge        RealtimeClient
       (隠しレンダラー)    (永続 WebSocket + auto-reconnect)
              │                 │
       getUserMedia +     wss://api.openai.com
       AudioWorklet       /v1/realtime?intent=transcription
       (idle 時 suspend)         │
              │                  │
       24kHz PCM16        input_audio_buffer.append
       50ms chunk                ▼
              └──────→  conversation.item.input_audio_transcription
                                .delta / .completed / .done
                                 ▼
                    PostProcessor pipeline
                    (formatter → replacements → fileTags)
                    GPT-5-mini, reasoning_effort: 'minimal'
                                 ▼
                          TextInjector
                          clipboard 退避 → safeStorage 暗号化保存
                                       → suppressFor(40ms)
                                       → Cmd+V / Ctrl+V (uIOhook.keyTap)
                                       → 元 clipboard 復元
                                 ▼
                          [カーソル位置に挿入]
                                 ▼
                          HistoryStore (debounced write)
```

### ディレクトリ構成

```
src/
├── main/
│   ├── index.ts                    # 起動 / トレイ / IPC 登録 / CSP / アクセシビリティ回復
│   ├── audio/bridge.ts             # 隠しレンダラー + idle suspend/resume
│   ├── audio/duck.ts               # システム音量ダック (mac はデフォルト無効)
│   ├── autoLaunch.ts               # OS 自動起動
│   ├── context/activeWindow.ts     # get-windows
│   ├── dictation/orchestrator.ts   # 永続WS + dictation cycle + state machine
│   ├── hotkey/manager.ts           # uIOhook + safety net + event-driven modifier wait
│   ├── inject/typer.ts             # paste + safeStorage 暗号 clipboard 退避
│   ├── inject/streamingTyper.ts    # event-driven streaming flush
│   ├── inject/pasteWin32.ts        # 修飾キー認識 atomic SendInput (Win) / keyTap (mac)
│   ├── ipc/handlers.ts             # refuseUntrusted gated handlers
│   ├── overlay/window.ts           # 半透明オーバーレイ
│   ├── postprocess/{pipeline,formatter,replacements,fileTags}.ts
│   ├── realtime/{client,events}.ts # OpenAI WS + Zod schemas (.completed/.done 両対応)
│   ├── store/{secure,settings,history}.ts
│   ├── tray/index.ts               # 6状態アイコン + accessibility 警告メニュー
│   └── updater/index.ts            # electron-updater (gated by refuseUntrusted)
├── preload/index.ts                # contextBridge + IPC payload runtime guard
├── renderer/
│   ├── index.html + main.tsx       # 設定ウィンドウ
│   ├── audio.html + audio.ts       # 隠しオーディオワーカー (idle suspend)
│   ├── audio-worklet.js            # PCM ダウンサンプラー
│   ├── overlay.html + overlay.tsx  # オーバーレイ (6状態対応)
│   ├── App.tsx + pages/*.tsx       # General / Hotkeys / Dictionary / History
│   │                                # + system/formatter error banner
│   └── env.d.ts
├── shared/{types,ipc,i18n,constants}.ts
└── tests/                          # vitest (23 files, 205 cases)
```

---

## 技術スタック

- **Electron 42** + **TypeScript 5.6**
- electron-vite 5 / electron-builder 26
- **React 18** + Vite 6 (renderer)
- **OpenAI Realtime WebSocket**: `wss://api.openai.com/v1/realtime?intent=transcription` (`gpt-realtime-whisper`)
- **`uiohook-napi`**: グローバルホットキー + `Ctrl+V`/`Cmd+V` 送出
- **`keytar`**: OS 資格情報ストアへの API キー保存
- **`electron-store` + Zod**: 設定の永続化 + schema validation
- **`safeStorage`**: clipboard 復元ファイル + 履歴の OS Keychain 暗号化
- **`get-windows`**: アクティブウィンドウ取得
- **`electron-updater`**: GitHub Releases 経由の差分更新
- **`loudness`**: システム音量ダック
- **WebAudio + AudioWorklet**: 24 kHz mono PCM16 ダウンサンプル (idle suspend 対応)

---

## コスト目安

| 項目 | 単価 |
|---|---|
| `gpt-realtime-whisper` | $0.017 / 分 |
| `gpt-5-mini` 整形 (`reasoning_effort: 'minimal'`) | < $0.001 / 回 |

30 分/日 使用想定で **月 $15-20**。

---

## ライセンス

Copyright (c) 2026 mackatwentytsuru. MIT License (see [LICENSE](./LICENSE)).
