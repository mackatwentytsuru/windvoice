# WindVoice

[English](#english) | [日本語](#日本語)

---

## English

**Hold Right Ctrl, speak, release: the transcript is pasted at the cursor.** WindVoice is a push-to-talk voice dictation app for Windows, macOS and Linux, built with Electron and the OpenAI Realtime API. It works in any text field (Notepad, Chrome, VS Code, Slack, Word, ChatGPT and so on).

Speech is transcribed while you talk (model `gpt-live-transcribe`). A short clean-up pass with an OpenAI model (default `gpt-6-luna`) then fixes punctuation and spacing, removes recognition glitches, and applies your personal dictionary, before the text is pasted through the clipboard. It was built with [Claude Code](https://claude.com/claude-code).

This is a personal project. Builds are unsigned, and it has been tested mostly on the author's own machines.

### Features

- Streaming transcription with a live preview in a small overlay while you speak
- Push-to-talk (default) or toggle mode; rebind the hotkey in Settings; `Esc` cancels the current dictation
- Clean-up pass: punctuation, spacing, and removal of repeated-word or silence "hallucinations". Short, already clean sentences skip the AI call and are finished locally (can be turned off)
- Personal dictionary (`wrong → right` pairs), text-expansion macros, spoken commands such as new line or bullet list
- Context: the active app name is passed to the formatter (and file tags for editors such as Cursor)
- Paste mode (clipboard is saved and restored) or streaming insertion for apps that do not accept paste
- Tray icon with six states, tone feedback, error banner, auto-launch at login, optional volume ducking while you speak
- History of your last 200 dictations, stored encrypted with the OS keychain (`safeStorage`)
- Auto-update from GitHub Releases (on by default on Windows, opt-in on macOS)
- UI in Japanese and English

### Requirements

- Windows 10/11 x64, macOS (Apple Silicon or Intel), or Linux x64 (experimental)
- An **OpenAI API key** of your own. You pay OpenAI for what you use. Check the OpenAI pricing page for the current prices of the models above
- An internet connection: your audio is sent to OpenAI for transcription, and the text is sent to OpenAI for the clean-up pass

### Install

Download the installer from the [latest release](https://github.com/mackatwentytsuru/windvoice/releases/latest). The builds are not code-signed, so your OS will warn you once.

- **Windows:** run `WindVoice-Setup-<version>-x64.exe`. If SmartScreen blocks it, choose "More info", then "Run anyway".
- **macOS:** open the `.dmg` and drag the app to `/Applications`. Then right-click the app, choose "Open" and confirm once, or run `xattr -cr /Applications/WindVoice.app`.
- **Linux (experimental):** no prebuilt Linux package is published yet. Build the AppImage or deb from source with `npm run package:linux` (see [Build from source](#build-from-source)), then read the notes below.

### First-time setup

1. Click the tray / menu-bar icon, then "Settings".
2. Open the General tab, paste your OpenAI API key (`sk-...`) and press Save. The key is kept in the OS credential store (macOS Keychain, Windows Credential Manager, or libsecret on Linux). It is not written to disk in plain text.
3. macOS: allow WindVoice under System Settings, Privacy & Security, Accessibility (needed for the global hotkey and for sending Cmd+V).
4. Allow microphone access when asked on the first recording.

### Use

1. Put the cursor in a text field.
2. Hold **Right Ctrl** and speak.
3. Release the key. The text is pasted at the cursor.

Right Ctrl, F13, Caps Lock (remapped) and Cmd on macOS work well as hotkeys. Right Alt, Right Shift, Space and Enter are poor choices because they clash with menus, IMEs or normal typing.

### Linux notes (experimental)

- The global hotkey is read from evdev (`/dev/input`), so your user must be in the `input` group (`sudo usermod -aG input $USER`, then log out and in). Anything running as that user can then read all your key presses, including passwords. Do not do this on a machine that runs untrusted programs.
- On Wayland, pasting uses the XDG RemoteDesktop portal through a small Python helper. You need `python3` and PyGObject (`python3-gi` on Debian/Ubuntu, `python3-gobject` on Fedora, `python-gobject` on Arch). A `.deb` you build lists them as dependencies; with the AppImage, install them yourself. Approve the remote-desktop prompt on first use.
- On GNOME you need the AppIndicator extension to see the tray icon.

### Privacy

- Your audio and the transcript go to the OpenAI API with your own key. Nothing is sent to a server run by the author. The app only contacts GitHub to check for updates.
- Error reports are optional. When an error happens, the app shows you what would be sent (home folders and secrets are masked) and sends nothing until you press Send. A report is then posted as a **public** GitHub issue in this repository, using your own GitHub CLI (`gh`) login; if `gh` is not installed, the text is copied to your clipboard and the "new issue" page is opened. You can turn reporting off.
- The API key is stored in the OS credential store. The clipboard-recovery file and the history are encrypted with the OS keychain.

### Build from source

Requirements: Node.js 22 or newer. On Linux, also `build-essential libx11-dev libxtst-dev libxkbcommon-dev libsecret-1-dev`. On macOS, Xcode Command Line Tools.

```bash
git clone https://github.com/mackatwentytsuru/windvoice.git
cd windvoice
npm install        # builds uiohook-napi and keytar for Electron
npm run dev        # development mode
npm test           # vitest
npm run typecheck  # strict TypeScript checks
```

Packaging:

```bash
npm run package:win     # NSIS installer (x64)
npm run package:mac     # DMG (arm64 and x64), macOS only
npm run package:linux   # AppImage and deb
```

Note for forks: `electron-builder.yml` contains the author's macOS signing identity and a `publish` section that points at the author's GitHub repository. To build on your own, set `CSC_IDENTITY_AUTO_DISCOVERY=false` (or set `identity: null`) and change `publish`. Do not run `npm run release` unless you want to publish to that repository.

### Limitations

- Unsigned builds, so the OS warnings above. No notarization.
- Linux support is experimental, and Wayland pasting depends on the portal.
- It needs the internet and an OpenAI API key; there is no offline mode.
- Model names and prices belong to OpenAI and may change.
- The clean-up pass can change wording slightly. Turn it off in Settings, General, if you want the raw transcript.
- Not affiliated with or endorsed by OpenAI.

### Tech stack

Electron 42, TypeScript, electron-vite, React 18 (settings UI), OpenAI Realtime WebSocket, `uiohook-napi` (global hotkey, key synthesis), `keytar` (credential store), `electron-store` and Zod (settings), `safeStorage`, `get-windows` (active window), `electron-updater`, `loudness` (volume ducking), WebAudio and AudioWorklet (24 kHz mono PCM16).

### License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Yuki Tsuruoka.

---

## 日本語

> **Right Ctrl** を押しっぱなし → 喋る → 離す → カーソル位置に転写が貼り付く。
> OpenAI Realtime API を使った Windows / macOS / Linux 向けの音声入力 Electron アプリ。

Notepad / Chrome / VS Code / Slack / Word / ChatGPT など、任意のテキスト入力欄で動作します。`gpt-live-transcribe` でストリーミング転写し、GPT-6 Luna で句読点・整形・辞書適用を行ったうえでクリップボード経由でペーストします。

[Claude Code](https://claude.com/claude-code) で作りました。個人のプロジェクトで、動作を確かめたのは主に作者自身の機械です。ビルドは未署名です。

---

## ステータス

| 項目 | 内容 |
|---|---|
| 最新リリース | **v0.1.17** ([releases/latest](https://github.com/mackatwentytsuru/windvoice/releases/latest)) — Windows x64 / macOS (Apple Silicon・Intel) |
| 対応プラットフォーム | macOS (Apple Silicon arm64) / Windows x64 / Linux x64 (AppImage・deb, experimental) |
| ビルド署名 | 未署名 (Gatekeeper / SmartScreen 回避手順あり) |
| 自動更新 | macOS は opt-in / Windows は既定で有効 |
| ライセンス | MIT |

---

## インストール (エンドユーザー)

### macOS (Apple Silicon)

```bash
# 1. DMG をダウンロード
curl -L -o WindVoice.dmg \
  https://github.com/mackatwentytsuru/windvoice/releases/download/v0.1.17/WindVoice-0.1.17-arm64.dmg

# 2. マウントして /Applications にドラッグ (もしくは Finder から)
hdiutil attach WindVoice.dmg
cp -R "/Volumes/WindVoice 0.1.17-arm64/WindVoice.app" /Applications/
hdiutil detach "/Volumes/WindVoice 0.1.17-arm64"

# 3. 未署名なので quarantine 属性を除去
xattr -cr /Applications/WindVoice.app

# 4. 起動
open /Applications/WindVoice.app
```

または Finder で `WindVoice.app` を右クリック → "Open" → "Open" を確認 で 1 回承認しても可。

### Windows x64

[Releases ページ](https://github.com/mackatwentytsuru/windvoice/releases/latest) から `WindVoice-Setup-<ver>-x64.exe` を落として実行。SmartScreen は「詳細情報」→「実行」で通します。

### Linux x64 (experimental)

リリースにはまだ Linux 用のパッケージがありません。ソースから `npm run package:linux` で AppImage(どのディストロでも可)または `.deb`(Debian/Ubuntu)を作ってください(後の「ビルド」を参照)。

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
3. キーを離す → すぐにカーソル位置に転写テキストが貼り付く

話している間はオーバーレイに認識中の文字がリアルタイムで表示されます。録音中・処理中に **Esc** を押すとその発話を取り消します (何も貼り付けません)。

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
- **GPT-6 Luna フォーマッタ (低遅延)**: 句読点・スペース・大文字化を自動補正、Whisper ハルシネーション(`結結結こんにちは…`等の繰り返し)を除去。口述された質問や指示には答えず、そのまま整形
- **高速パス**: 短い・すでに整った発話は整形 AI を呼ばずにローカルで仕上げて即入力 (設定でオフ可)
- **無音ハルシネーション除去**: 発話全体が「ご視聴ありがとうございました」等の定型句だけのときは貼り付けない
- **辞書 (Dictionary)**: `raw → corrected` ペアでよく出る誤認識を一括置換
- **Replacements**: テキストマクロ展開 (`@email` → 自分のメアドなど)
- **自然言語コマンド**: 発話中の「改行」「箇条書き」「コードブロック」を構造化
- **アクティブウィンドウ認識**: フォーマッタの文脈にアプリ名を渡す (Cursor 等向けのファイルタグも)
- **言語自動検出 / 明示指定**: 日本語・英語・中国語・韓国語など

### UI / フィードバック
- **半透明オーバーレイ**: 録音中・処理中の状態 + 音量メーター + 認識中のライブ文字を画面下部に
- **Esc で取り消し**: 録音中・処理中だけ Esc を横取りして発話を破棄 (それ以外の時間は Esc は通常どおり)
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
npm test           # vitest run
npm run typecheck  # tsconfig.node + tsconfig.web の strict TS チェック
```

### パッケージング

```bash
npm run package:mac    # release/<ver>/WindVoice-<ver>-{arm64,x64}.dmg (Mac でのみ可)
npm run package:win    # release/<ver>/WindVoice-Setup-<ver>-x64.exe (NSIS)
npm run package:linux  # release/<ver>/WindVoice-<ver>-x86_64.AppImage + .deb
npm run release        # 作者の GitHub リポジトリの Releases へ publish する設定です(自分のフォークでは publish を書き換えてから)
```

`electron-builder.yml` には作者自身の macOS 署名 ID と、作者の GitHub リポジトリへの `publish` 設定が入っています。自分でビルドするときは、`CSC_IDENTITY_AUTO_DISCOVERY=false`(または `identity: null`)にして、`publish` を書き換えてください。署名・公証をしたいときは、`CSC_LINK` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` を設定します。

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
       (Win: warm / 他: suspend)     │
              │                  │
       24kHz PCM16        input_audio_buffer.append
       50ms chunk                ▼
              └──────→  conversation.item.input_audio_transcription
                                .delta / .completed / .done
                                 ▼
                    PostProcessor pipeline
                    (formatter → replacements → fileTags)
                    高速パス or GPT-6 Luna, reasoning_effort: 'none'
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
│   ├── audio/bridge.ts             # 隠しレンダラー + platform別 idle capture
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
└── tests/                          # vitest
```

---

## 技術スタック

- **Electron 42** + **TypeScript 5.6**
- electron-vite 5 / electron-builder 26
- **React 18** + Vite 6 (renderer)
- **OpenAI Realtime WebSocket**: `wss://api.openai.com/v1/realtime?intent=transcription` (`gpt-live-transcribe`)
- **`uiohook-napi`**: グローバルホットキー + `Ctrl+V`/`Cmd+V` 送出
- **`keytar`**: OS 資格情報ストアへの API キー保存
- **`electron-store` + Zod**: 設定の永続化 + schema validation
- **`safeStorage`**: clipboard 復元ファイル + 履歴の OS Keychain 暗号化
- **`get-windows`**: アクティブウィンドウ取得
- **`electron-updater`**: GitHub Releases 経由の差分更新
- **`loudness`**: システム音量ダック
- **WebAudio + AudioWorklet**: 24 kHz mono PCM16 (Windows idle warm / 他OS suspend)

---

## プライバシー

- 音声と転写テキストは、自分の API キーで OpenAI に送られます。作者のサーバーには何も送られません(更新の確認のために GitHub に接続するだけです)。
- エラー報告は任意です。エラーが起きると、送る内容(ホームフォルダと秘密の文字列は伏せ字)が画面に出て、「送信」を押すまで何も送られません。送ると、自分の GitHub CLI(`gh`)のログインで、このリポジトリに**公開の** Issue として投稿されます。`gh` が無いときは、本文をクリップボードに写して「新しい Issue」のページを開きます。報告はオフにできます。
- API キーは OS の資格情報ストアに、クリップボード復元ファイルと履歴は OS のキーチェーンで暗号化して保存されます。

---

## コスト

OpenAI の API 利用料がかかります(転写と整形)。モデルの単価は OpenAI の価格ページで確認してください。

---

## ライセンス

Copyright (c) 2026 Yuki Tsuruoka. MIT License (see [LICENSE](./LICENSE)).
