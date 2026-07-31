# agy 10隊レビュー(2026-08-01深夜・Gemini 3.6 Flash並列)

## 隊1
^Dご提示いただいたソースコードのレビューを行いました。重要な問題点および改善提案をファイル名と根拠付きで5件列挙します。

---

### 1. `src/main/audio/duck.ts`
* **問題 / 改善提案**: `AudioDuck.duck()` の非同期処理における競合状態（Race Condition）および復元漏れ
* **根拠**: 
  `duck()` メソッド内の `this.active = true` フラグ更新が、非同期処理である `await loudness.getVolume()` および `await loudness.setVolume(target)` の**実行完了後**に行われています。
  そのため、`duck()` が非同期処理実行中に短時間で複数回呼び出された場合（連続打鍵や急速な録音再開時など）、2回目の呼び出しで `if (this.active) return;` のガードを抜け、ダック後の低い音量を `this.originalVolume` に上書き保存してしまいます。
  また、`duck()` の非同期処理中に `restore()` が呼ばれた場合、`restore()` 側は `this.active` がまだ `false` であるため処理をスキップし、直後に `duck()` の完了によって `this.active = true` に設定されるため、システム音量が低下したまま復元されない状態に陥ります。

---

### 2. `src/main/hotkey/manager.ts`
* **問題 / 改善提案**: ショートカットキー正規化 (`normalize` / `lookupKey`) における修飾キー名の表記ゆれ（`Control`, `Option` 等）によるキー設定の無効化
* **根拠**: 
  `HotkeyManager.normalize()` 内での修飾キー判定において `/^ctrl$/i`, `/^alt$/i`, `/^shift$/i` などの厳密な正規表現が使用されています。
  OS標準やWebの `KeyboardEvent.key`、Electron Acceleratorの一般的な記述形式である `"Control"`（`"ctrl"` ではなく）や `"Option"` (macOS)、`"Command"` 等が設定に含まれていた場合、`/^ctrl$/i.test("Control")` が `false` と評価されます。
  さらに `lookupKey("Control")` も対応マップに存在しないため `null` を返し、結果として `normalize()` 全体が `null` を返却することで、設定されたキーバインディングが**警告なしにサイレント無効化**されます。

---

### 3. `src/main/debug.ts`
* **問題 / 改善提案**: メインスレッドでの同期ファイル書き込み (`appendFileSync`) による I/O ブロッキングと音声・UI遅延
* **根拠**: 
  `fileLog()` 関数は `WINDVOICE_DEBUG` 等の環境変数フラグの有効無効にかかわらず、すべての `debug()` 呼び出し時に毎回実行され、`appendFileSync(p, line)` による同期ディスク書き込みを行っています。
  音声ディクテーション実行中には、WebSocket のデルタ受信・レベルメーター更新・IPC 通信などにより、1秒間に十数〜数十回の `debug()` がメインスレッド上で発火します。特に Windows 環境（アンチウイルスソフト等のファイル監視が挟まる場合を含む）において、`appendFileSync` が Node.js イベントループをミリ秒単位でブロックし、音声 PCM チャンのドロップやキー入力・UIの応答遅延を引き起こします。

---

### 4. `src/main/dictation/orchestrator.ts`
* **問題 / 改善提案**: `refreshDeltaTargets()` でのウィンドウ破棄時（`win.isDestroyed()` / `win.webContents` 参照）における例外リスク
* **根拠**: 
  `refreshDeltaTargets()` 内で `for (const win of BrowserWindow.getAllWindows())` をループ処理する際、`const wc = win.webContents` を直接参照しています。
  Electron ではウィンドウが閉じられている途中や破棄直後の状態において、`win.webContents` プロパティアクセス自体が `"Object has been destroyed"` 例外を発生させることがあります（`src/main/index.ts` 内のコメントでも指摘されている挙動です）。
  また、ディクテーション開始時にスナップショットした `deltaTargets` に保持された `WebContents` に対して `broadcastDelta()` 内でメッセージ送信を行う際、ストリーミング中にウィンドウが閉じられると未捕獲の例外が発生してアプリ処理に影響を及ぼす可能性があります。

---

### 5. `src/main/inject/clipboardWrite.ts`
* **問題 / 改善提案**: `writeExcludedWin32` 内のコード切断（構文エラー）および Windows クリップボード API ロック解除の安全性
* **根拠**: 
  提示されたソースコードの `writeExcludedWin32()` 内終盤が `hText = allocGlobal(w, Buffer.from(text + '` で途切れており、構文エラー（SyntaxError）が発生しています。
  また、Win32 API (`OpenClipboard`, `EmptyClipboard`, `SetClipboardData`) の FFI 呼び出しにおいて、`OpenClipboard` 成功後にメモリ確保やデータの書き込み処理で例外が発生した場合に `CloseClipboard()` が確実に呼ばれる構造（`try...finally` ガード）が不十分であると、クリップボードがロックされたままになり、OS全体のクリップボード操作がフリーズする重大な障害に繋がります。

---

REVIEW-DONE-1

## 隊2
^DWindows用音声ディクテーションアプリ `windvoice` のソースコードについて、【音声キャプチャの堅牢性（デバイス喪失・排他・無音・keep-warm設計の穴）】の観点からコードレビューを行いました。

重要度の高い問題点および改善提案を以下の5件にまとめて報告します。

---

### 1. 無音ウォッチドッグ（`armSilenceWatchdog`）によるマイク再構築の連打と誤発動
- **ファイル名**: [src/main/audio/bridge.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/audio/bridge.ts#L216-L242)
- **根拠**: `AudioBridge.armSilenceWatchdog` メソッド（L216-L242）
- **問題点**: 
  600msの無音判定ウォッチドッグが `recapture()` を呼び出した直後、マイクの非同期再構築（`getUserMedia` や `AudioWorklet` の再接続など）にかかる時間を考慮せずに `armSilenceWatchdog` を即座に再アームしています。非同期の再構築処理中に次の 600ms が経過すると再度無音と判定され、`recapture()` が連続して発行されるループが発生します。また、ユーザーがキーを押してから声を出すまでに 600ms 以上の間（溜め）がある正常な発話でも誤って `recapture()` がトリガーされ、音声冒頭が欠損する原因になります。
- **改善提案**: 
  `recapture()` の完了を待ってからウォッチドッグを再起動する仕組み（Promise または完了イベントの導入）を設けるか、無音判定時間（`SILENCE_WATCHDOG_MS`）を調整し、マイク再構築中の重複実行を防ぐフラグ管理を行ってください。

---

### 2. Windows keep-warm モードにおける OS 音声デバイス切替・抜き差しへの追従欠如
- **ファイル名**: [src/main/audio/bridge.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/audio/bridge.ts#L178-L180), [src/main/index.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/index.ts#L217-L219)
- **根拠**: `AudioBridge.changeDevice`（L178-L180）、`src/main/index.ts` の `onSettingsChanged`（L217-L219）
- **問題点**: 
  Windows の keep-warm 設計では Capture Graph を常時保持しますが、OSのデフォルト音声入力デバイスが切り替わった場合（Bluetoothヘッドセットの接続/切断、USBマイクの抜き差しなど）、アプリ設定 (`settings.audio.device`) が `"default"` のままだと `onSettingsChanged` が発火しません。レンダラープロセス等で OS レベルのデバイス変更（`navigator.mediaDevices.ondevicechange`）を検知して自動的に `recapture()` を呼ぶ仕組みが存在しないため、抜かれた旧デバイスの無音ストリームを掴み続け、音声ディクテーションが不通になります。
- **改善提案**: 
  レンダラー側で `navigator.mediaDevices.ondevicechange` を監視し、メインプロセスへ通知して自動的に `recapture()` を発行してマイクストリームを自動再取得するリカバリパスを実装してください。

---

### 3. `AudioBridge` の音声エラーが `DictationOrchestrator` の進行中セッションへ波及しない
- **ファイル名**: [src/main/audio/bridge.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/audio/bridge.ts#L150-L152), [src/main/dictation/orchestrator.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/dictation/orchestrator.ts#L193-L200)
- **根拠**: `AudioBridge.setErrorListener`（L150-L152）、`DictationOrchestrator.start`（L193-L200）
- **問題点**: 
  レンダラー側で WASAPI 排他モードの競合やマイク切断による `AUDIO_ERROR` が発生した場合、`AudioBridge` は `lastAudioError` を更新し UI に通知しますが、実行中の `DictationOrchestrator` のセッションを即座に中断・キャンセルする仕組みが接続されていません。`orchestrator.start()` の開始直前チェックしか存在しないため、録音中にマイクエラーが発生した場合に `DictationOrchestrator` が `listening` 状態のままフリーズ・スタックします。
- **改善提案**: 
  `AudioBridge.setErrorListener` を `DictationOrchestrator` にも連携し、録音中にマイクキャプチャエラーが報告された場合は即座に `abortInFlightCycle` 相当のリカバリ・エラー停止処理を実行するように変更してください。

---

### 4. `AudioBridge.init()` 失敗・タイムアウト時の復旧不能（ゾンビウィンドウ）
- **ファイル名**: [src/main/audio/bridge.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/audio/bridge.ts#L73-L135)
- **根拠**: `AudioBridge.init`（L73-L135）、`waitReady`（L258-L270）
- **問題点**: 
  `init()` 内で非表示のキャプチャ用 `BrowserWindow` を生成し、`waitReady()` で最大8秒間レンダラーの準備完了を待ちます。しかし、タイムアウトや読み込みエラーが発生した場合、`this.win` オブジェクトが破棄されずに残り、`this.ready` は `false` のままになります。以降に `init()` や `prewarm()` が呼ばれても L74 の `if (this.win) return;` で処理が弾かれるため、壊れたウィンドウから自律復旧できず、アプリを再起動するまで音声キャプチャが完全に不通になります。
- **改善提案**: 
  `waitReady()` のタイムアウト時や初期化エラー時には `destroy()` を呼び出して `this.win` を明示的に破棄・クリーンアップし、次回の呼び出し時に再生成を試みることができるように修正してください。

---

### 5. `recapture()` の Fire-and-Forget 化による録音完了処理との同期崩れ
- **ファイル名**: [src/main/audio/bridge.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/audio/bridge.ts#L187-L193), [src/main/dictation/orchestrator.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/dictation/orchestrator.ts#L274-L387)
- **根拠**: `AudioBridge.recapture`（L187-L193）、`DictationOrchestrator.stop`（L274-L387）
- **問題点**: 
  `recapture()` は IPC メッセージ `AUDIO_RECOVER_CMD` を送信するだけの戻り値 `void` (Fire-and-Forget) であり、マイクの再構築完了を追跡する仕組みがありません。マイク再構築処理の最中にユーザーがキーを離して `DictationOrchestrator.stop()` が実行されると、キャプチャが途絶・再構築中の不完全な状態で `endForwarding()` や commit 判定が行われ、チャンク数の不正や無音コミットを引き起こします。
- **改善提案**: 
  `recapture()` でレンダラーからの完了応答（またはエラー通知）を待機できる非同期形式（Promise）に変更し、再構築中に `stop()` が呼ばれた場合の同期制御を `DictationOrchestrator` に組み込んでください。

---

REVIEW-DONE-2

## 隊3
^DWindows用音声ディクテーションアプリ **windvoice** のコードレビューを実施いたしました。
【OpenAI Realtime WebSocketの安定性(切断・再接続・半開・タイムアウト)】の観点から抽出した重要な問題点および改善提案は以下の5件です。

---

### 1. `onReconnecting`（自動再接続発生時）に WebSocket クライアントが破棄されず、次回録音時に壊れたセッションが再利用される問題
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L598-L606, L632-L640)
* **根拠**: 
  `_doConnect()` 内の `onReconnecting` ハンドラーにおいて、録音中に接続が切断されて自動再接続が始まった際に `abortInFlightCycle()` を呼び出して現在の録音サイクルを中断していますが、`this.client` の参照解除や `dispose()` が行われていません。
  OpenAI Realtime API の仕様上、WebSocket 接続が再接続されるとサーバー側の音声入力バッファ (`input_audio_buffer`) はリセットされるため、既存のセッション状態は無効化されます。しかし `this.client` の参照が維持されたままになるため、次回録音時に `ensureConnected()` を呼ぶと `this.client.isOpen()` が `true` （自動再接続成功後）と判定され、サーバー側バッファと不整合を起こした壊れた WebSocket セッションが再利用されてディクテーションが失敗します。
* **改善提案**: 
  `onReconnecting` が発生した場合は、`abortInFlightCycle()` に加えて `resetClientForReconnect()` を実行し、既存のクライアントを明示的に `dispose()` して参照をクリアしてください。

---

### 2. OSスリープ復帰時（`powerMonitor`）に `inFlight` 状態だと WebSocket の再構築がスキップされ、半開（Half-Open）ソケットでアプリがハングする問題
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L139-L149), `src/main/index.ts` (L307-L315)
* **根拠**: 
  `recycleConnection()` 内で `if (this.disposed || this.inFlight) return;` とガードされているため、ホットキー押しっぱなしやタイマー等の影響で録音中（`inFlight === true`）に PC がスリープや画面ロックに入った場合、スリープ復帰イベント（`powerMonitor.on('resume')`）で WebSocket の再作成が行われません。
  OS スリープによって TCP 接続は半開（Half-Open）状態（FIN/RST パケットが送られず、ソケット上は open に見えるが送信不能な状態）になります。スリープ復帰後にユーザーが録音停止（`stop()`）を試みても、`client.commit()` の応答が永久に返ってこず、`pendingFinalTimer`（`FINAL_TIMEOUT_MS` タイムアウト）までアプリが応答不能（フリーズ）になります。
* **改善提案**: 
  `recycleConnection` 実行時に `inFlight` であっても、スリープ復帰時は既存のインフライトサイクルを強制中絶 (`abortInFlightCycle`) してソケットを破棄・再構築するように変更してください。

---

### 3. 録音中（`listening`）における WebSocket 半開（Half-Open）および送信バッファ溢れのリアルタイム検知・エラー保護の欠如
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L651-L656)
* **根拠**: 
  `_doConnect()` 内で登録される `chunkListener` は、マイクから届く PCM 音声データ（毎秒 15〜20 チャンク）を `client.appendAudio()` で送信していますが、呼び出し部分に try-catch 等の例外保護がありません。
  また、WebSocket の未送信バッファ滞留（stale socket）の判定 (`pendingBufferedBytes() > 0`) は `start()` 実行時の `ensureConnected()` でしか行われていません。録音途中でネットワークが瞬断・低速化してパケットが送信キューに溜まり続けても、録音中にリアルタイムで半開状態を検知して安全に切断・通知する仕組みが不足しています。
* **改善提案**: 
  `chunkListener` 内で `appendAudio` 呼び出しを try-catch で保護するとともに、録音中（`inFlight`）も送信バッファサイズやエラー率を監視し、ソケット詰まりを検知した場合は速やかにエラーとして処理を中断するメカニズムを追加してください。

---

### 4. `stop()` 実行中の `commit` レスポンス待ちにおける WebSocket 切断（`onClose`）時のステータス不整合
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L304-L325, L608-L627)
* **根拠**: 
  `stop()` メソッド内で `client.commit()` を呼び出した後、`pendingFinal` の Promise を作成してサーバーからの最終文字起こし結果を待機します。この待機中に WebSocket が切断された場合、`onClose` ハンドラーが `pendingFinal(this.partial)` を呼ぶため Promise 自体は resolve されます。
  しかし、`onError` とは異なり `onClose` では `cycleErrored` フラグが更新されません。そのため、WebSocket が正常に応答を返さず異常切断されたにもかかわらず、`stop()` の後半処理がそのまま実行され、トレイ等のステータスが `idle` に上書きされて誤った状態遷移を引き起こす可能性があります。
* **改善提案**: 
  `onClose` 内で `this.inFlight` かつコミット待ちのタイミングで切断された場合は、`cycleErrored = true` をセットするか、`abortInFlightCycle` と同等のクリーンアップを行ってエラー状態を正しく管理するように修整してください。

---

### 5. `maintenanceTick` による Proactive Session Refresh 時のネットワーク不通によるステータス誤遷移
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L116-L131, L151-L177)
* **根拠**: 
  OpenAI Realtime API の 60 分セッション上限による強制切断を防ぐため、`maintenanceTick()` で 50 分経過したアイドル接続を定期的にリフレッシュ（`dispose` ＆ `prewarmConnection`）しています。
  しかし、ユーザーが操作しておらず PC がオフライン（Wi-Fi切断等）の状態で `maintenanceTick` が発火すると、`prewarmConnection()` が失敗して `prewarm failed` Catch ブロックに入り、トレイアイコンやアプリのステータスが `error` に変更されてしまいます。
* **改善提案**: 
  `maintenanceTick` からの `prewarmConnection` 呼び出し時は、失敗してもトレイのステータスを `error` に遷移させず、サイレントに次回録音開始時の遅延接続（`start()` 内での `ensureConnected`）に委ねるフラグ処理を追加してください。

---

REVIEW-DONE-3

## 隊4
^Dご提示いただいたコードを**【ホットキーとテキスト注入(クリップボード復元・取りこぼし・競合)】**の観点からレビューいたしました。検出された重要な問題点および改善提案を以下の通り列挙します。

---

### 1. [ホットキーの取りこぼし] テキスト注入中の抑制期間（`suppressUntil`）においてトグルモード（Toggle）の録音停止キーが完全に無効化・取りこぼされる

* **対象ファイル**: [`src/main/hotkey/manager.ts`](file:///src/main/hotkey/manager.ts#L279-L347)
* **根拠・原因**:
  テキスト注入時（ストリーミングパースト等）に合成キーによる誤発火を防ぐため、`suppressFor()` により `suppressUntil` タイムスタンプが更新されます。この抑制期間中、`onKey()` 内の `suppressed` が `true` となり、通常のバインディング判定（`for (const nb of this.bindings)`）がすべてスキップされます。
  後半のセーフティネット処理（L318-L347）は Push-to-Talk 専用の `this.heldDown` のみを監視・復帰対象としており、Toggle モード用の `toggleActive` や `toggleHeld` は一切チェックされません。そのため、ストリーミングパースト等のテキスト注入中にユーザーが録音停止目的でトグルキーを押してもイベントが完全に無視（取りこぼし）され、録音が停止しなくなります。
* **改善提案**:
  セーフティネット処理内に Toggle モードのキーリリース・キーダウン時の状態解除ロジックを追加するか、ユーザーによる物理キー入力とシステム合成イベント（`suppressUntil`）を識別してトグル操作を受理できるように修正してください。

---

### 2. [状態競合・二重注入] `DictationOrchestrator.stop()` における非同期テキスト注入・LLMポスト処理完了前のステータス解除（`inFlight = false`）

* **対象ファイル**: [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L341-L383)
* **根拠・原因**:
  `stop()` メソッド内で、`postProcessorPipeline.run()`（GPTフォーマッター等の非同期処理）や `pasteText()` / `typeTextDirect()` の実行前に `this.inFlight = false` および `this.updateStatus('idle')` を行っています。
  これにより、前サイクルのテキスト注入や GPT 整形が非同期で実行中であるにもかかわらず、オーケストレーターは `idle` 状態と判定され、次のホットキー入力（`start()`）を許可してしまいます。結果として、新しいサイクルの録音中（Cycle B）に前サイクル（Cycle A）のテキスト貼り付けやクリップボード復元、ホットキー抑制が割り込み、クリップボードの破損や文字の重複・乱入注入が発生します。
* **改善提案**:
  `this.inFlight = false` および `updateStatus('idle')` は、`postProcessorPipeline` および `pasteText` が完全に完了した後に遷移させるか、テキスト注入処理専用のロック/キュー（`injecting` フラグ）を設けて `start()` をガードしてください。

---

### 3. [ホットキー解除漏れ] 複合キー・修飾キーを用いた Push-to-Talk で修飾キーを先に離した際に録音状態が解除されない

* **対象ファイル**: [`src/main/hotkey/manager.ts`](file:///src/main/hotkey/manager.ts#L318-L347)
* **根拠・原因**:
  `onKey()` のセーフティネット判定において、`nb.triggerProvidesModifier !== null` の場合（例: `Right Alt`）、`this.modifierState[nb.triggerProvidesModifier]` のみがチェックされます。
  そのため、`Ctrl + Right Alt` や `Ctrl + Space` のように必要な他の修飾キー（`modifiers.ctrl: true`）をユーザーが先に離して `modifierState.ctrl` が `false` になった場合でも、Path A では判定されず `heldDown` から削除されません。また非修飾キーがトリガーの場合（`Ctrl + Space` で `triggerProvidesModifier = null`）も Ctrl 離し時には `Space` キーコードと一致しないため解除されません。ユーザーが修飾キーを先に離す操作を行った際、Push-to-Talk の `stop` イベントが発行されず録音が固まる原因となります。
* **改善提案**:
  セーフティネット処理において、`heldDown` に存在するバインディングに必要なすべての修飾キー状態（`nb.modifiers`）を検証し、必須修飾キーのいずれかが離された場合は即座に `heldDown.delete(id)` および `emit('stop', id)` を実行するよう改修してください。

---

### 4. [クリップボード競合・上書き] ストリーミング注入時の非同期終了処理およびディクテーション中ユーザー操作との競合

* **対象ファイル**: [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L205-L212, file:///src/main/dictation/orchestrator.ts#L400-L408)
* **根拠・原因**:
  ストリーミングパースト有効時、`abortInFlightCycle` などでエラーや中断が発生した際に `void streamingTyper.end()` が `await` されずに非同期で呼び出されます。これにより、新しいディクテーションサイクルが開始された後に旧サイクルのクリップボード復元処理が遅れて実行され、新サイクルのクリップボード操作と衝突します。
  また、ディクテーション中にユーザーが手動でコピー（`Ctrl+C`）を行った場合、セッション開始時に退避した旧クリップボード内容で復元されるため、ユーザーの最新コピー内容が消失する問題が生じます。
* **改善提案**:
  `streamingTyper.end()` は必ず `await` して完了を保証してから次の状態へ遷移させてください。また、クリップボード復元前に現在のクリップボード内容が WindVoice の注入テキストと一致しているか検証し、ユーザーによる変更があった場合は復元をスキップするガードを実装してください。

---

### 5. [Win32 API競合] `clipboardWrite.ts` における `OpenClipboard` の排他失敗時のリトライ不足とクリーンアップ処理の欠落

* **対象ファイル**: [`src/main/inject/clipboardWrite.ts`](file:///src/main/inject/clipboardWrite.ts#L185-L200)
* **根拠・原因**:
  `writeExcludedWin32()` 内で `OpenClipboard(null)` を呼び出す際、他のアプリケーション（クリップボードマネージャーや他プロセス）が一時的にクリップボードをロックしていると即座に `false` を返して失敗します。標準的な Win32 クリップボード処理に必要なループ/バックオフリトライ処理がないため、クリップボード競合時に履歴除外パーストが失敗します。
  また、`OpenClipboard` 成功後に例外が発生した場合の `CloseClipboard()` 呼び出し漏れや、`GlobalAlloc` で確保したハンドルの解放漏れ（または二重解放）のリスクが存在します。
* **改善提案**:
  `OpenClipboard(null)` の呼び出し部を短時間のスリープを挟んだリトライループ（例: 5ms 間隔で最大 5 回）に修正し、`try...finally` ブロック内で `OpenClipboard` が成功していた場合は確実に `CloseClipboard()` が呼ばれる安全なリソース管理構造にしてください。

---

REVIEW-DONE-4

## 隊5
^Dご提示いただいた `windvoice` のソースコードについて、【エラーハンドリングとログ（握りつぶし・ユーザーへの通知の適切さ）】の観点からコードレビューを行いました。重要な問題点および改善提案を以下の通り5件列挙します。

---

### 1. GUIプロセスでのログ出力バイパスとログ消失
* **対象ファイル**: `src/main/dictation/orchestrator.ts`（`stop` メソッド内）
* **根拠コード**:
  ```typescript
  } catch (err) {
    process.stderr.write(`[dictation] duck restore failed: ${errMsg(err)}\n`);
  }
  ```
* **問題点と影響**:
  `src/main/debug.ts` のコメントにも記載がある通り、Windowsのパッケージ化アプリ（GUIサブシステムプロセス）では `stderr` は出力先が存在せず消失します。他の箇所では `debug()` 関数経由でファイル（`windvoice-debug.log`）に出力されていますが、ここでは `process.stderr.write` が直接呼び出されているため、ダッキング復元失敗時のエラーログがファイルに記録されず、事後診断が不能になります。
* **改善提案**:
  `process.stderr.write` ではなく、`debug('DUCK', ...)` または `debug('DICTATION', ...)` を使用してログを永続化ファイルに記録してください。

---

### 2. 非macOS環境におけるグローバルホットキー起動失敗のユーザー通知欠如
* **対象ファイル**: `src/main/index.ts`（`startHotkeysWithAccessibilityRecovery` 内）
* **根拠コード**:
  ```typescript
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug('HOTKEY', `start failed (likely missing Accessibility permission): ${message}`);
    if (process.platform !== 'darwin') return;
    setAccessibilityWarning(true);
    ...
  }
  ```
* **問題点と影響**:
  WindowsやLinux環境で `hotkeys.start()`（uIOhookのフック処理など）が例外を発生させた場合、ログ出力（`debug`）した後に `if (process.platform !== 'darwin') return;` で処理を抜けてしまいます。Windows環境等でグローバルホットキーの初期化に失敗してもユーザーへの画面通知（エラーバナーやステータス変更）が一切行われず、なぜ音声入力が起動しないのかユーザーが把握できなくなります。
* **改善提案**:
  Windows/Linux環境でもホットキー起動失敗時には UI へエラー状態を通知（`broadcastToUiWindows(IPC.SYSTEM_ERROR, ...)` やトレイのステータス更新など）を行ってください。

---

### 3. コールバック例外およびキーフック停止エラーの無ログ握りつぶし
* **対象ファイル**: `src/main/hotkey/manager.ts`（`onKey` および `stop` 内）
* **根拠コード**:
  ```typescript
  queueMicrotask(() => {
    try {
      w();
    } catch {
      /* ignore — waiter throw must not break onKey */
    }
  });
  ```
  および
  ```typescript
  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
  }
  ```
* **問題点と影響**:
  `onKey` 内で修飾キー解除待ちの非同期コールバック `w()` を実行する際、発生した例外をログ出力なしで完全に握りつぶしています。また `stop()` 時の `uIOhook.stop()` の失敗も無言でキャッチされています。後続処理を止めない配慮自体は妥当ですが、ログすら残らないため、タイピング/ペースト処理等の不具合が発生した際のデバッグが非常に困難になります。
* **改善提案**:
  例外をキャッチした際、少なくとも `debug('HOTKEY', ...)` でエラー内容をログ記録した上で継続するように変更してください。

---

### 4. `start()` 時の SecureStore エラー発生時におけるユーザー通知の不整合
* **対象ファイル**: `src/main/dictation/orchestrator.ts`（`start` メソッド内）
* **根拠コード**:
  ```typescript
  try {
    apiKey = await secureStore.getApiKey();
  } catch (err) {
    this.updateStatus('error');
    this.inFlight = false;
    this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] secure storage unavailable: ${errMsg(err)}`);
    return;
  }
  ```
* **問題点と影響**:
  ディクテーション開始時（`start()`）に SecureStore からの API キー取得に失敗した場合、`TRANSCRIPT_FINAL` へのエラー送信とステータスの `error` 変更を行っていますが、`reportTranscriptionError(...)`（`IPC.SYSTEM_ERROR` によるUIエラーバナー表示）が呼ばれていません。`ensureConnected` の失敗時（同ファイル 235行目付近）では `reportTranscriptionError` が呼ばれており、通知の挙動に不整合があります。
* **改善提案**:
  SecureStore エラー時にも `this.reportTranscriptionError(errMsg(err))` を呼び出し、UIのシステムエラーバナーに統一して通知されるようにしてください。

---

### 5. 自動起動設定取得失敗時のエラー握りつぶしと誤状態の返却
* **対象ファイル**: `src/main/autoLaunch.ts`（`isAutoLaunchEnabled` 関数）
* **根拠コード**:
  ```typescript
  export function isAutoLaunchEnabled(): boolean {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  }
  ```
* **問題点と影響**:
  Electron の `app.getLoginItemSettings()` 呼び出しで OS やレジストリアクセスエラー等の例外が発生した場合、`catch` ブロックで無ログのまま `false` を返しています。これにより、OS 側の問題で設定読み込みに失敗した場合でも、設定画面上では単に「自動起動が無効になっている」ように見え、ログにも残らないため原因の特定が困難になります。
* **改善提案**:
  `catch` ブロックで `debug('MAIN', ...)` 等によるエラーログ出力を行い、呼び出し元でも取得失敗の事実を追跡できるようにしてください。

---

REVIEW-DONE-5

## 隊6
^Dご提示いただいた全ソースコードに基づき、【セキュリティ（APIキーの保存と露出・ログへの秘密混入・IPC面）】の観点から重要な問題点および改善提案を5件選出し、日本語で列挙いたします。

---

### 1. エラーメッセージ経由でのAPIキー・秘密情報のIPC露出および自動エラーレポート送信
- **対象ファイル**: `src/main/dictation/orchestrator.ts`, `src/main/broadcast.ts`
- **根拠と問題点**:
  `DictationOrchestrator` の `reportTranscriptionError` や `_doConnect()`、`start()` などでエラーが発生した際、OpenAI Realtime APIやネットワークエラーのメッセージ（`err.message`）がそのまま `broadcastToUiWindows(IPC.SYSTEM_ERROR, ...)` や `broadcast(IPC.TRANSCRIPT_FINAL, ...)` に渡されます。
  OpenAI等のAPIエラーや通信エラーの文字列には、リクエストヘッダーやURLパラメータ等に含まれるAPIキー・認証トークンが混入する可能性があります。
  さらに `broadcast.ts` の `broadcastToUiWindows` 内では、`SYSTEM_ERROR` または `FORMATTER_ERROR` を受信した際に無条件で `reportError(source, p.message)` が呼び出され、GitHub Error Reporter（自動エラー報告機能）へ送信されます。`debug.ts` の `scrubSecrets()` によるマスク処理は `debug()` ログ専用となっており、IPC放送前やエラーレポート送信前には適用されていません。
- **改善提案**:
  IPCでUIへエラーを送信する前、および `reportError` を呼び出す前に必ず `scrubSecrets()`（またはAPIキー等の秘匿化関数）を適用し、秘密情報がIPCメッセージや外部レポートに平文で露出しないように保護してください。

---

### 2. `DictationOrchestrator` 内の独自 `broadcast` による非サンドボックス `AudioBridge` レンダラーへのテキスト・履歴流出
- **対象ファイル**: `src/main/dictation/orchestrator.ts`
- **根拠と問題点**:
  `broadcast.ts` では、隠し音声キャプチャ用ウィンドウ（`AudioBridge`）へ不要なUI状態や機密イベントを送らないよう `broadcastToUiWindows` を用いて受信用 `BrowserWindow` のフィルタリングを行っています。
  しかし、`orchestrator.ts` 内で定義されているプライベートメソッド `broadcast(channel: string, payload: unknown)` は `BrowserWindow.getAllWindows()` を直接ループしており、`IPC.TRANSCRIPT_FINAL` や `IPC.HISTORY_CHANGED`（音声認識テキストや文字起こし履歴）を `AudioBridge` を含むすべてのウィンドウへ送信しています。
  `AudioBridge` は後述の通り `sandbox: false` で動作する特権的なウィンドウであるため、不要な文字起こしデータや履歴を送信することはIPC面でのアタックサーフェス（攻撃対象領域）を不要に拡大させる原因となります。
- **改善提案**:
  `orchestrator.ts` 内の `broadcast` メソッドを廃止し、`@main/broadcast` の `broadcastToUiWindows` に統一して、非サンドボックスな音声キャプチャ用ウィンドウに認識テキストや履歴データが届かないよう制限してください。

---

### 3. `debug.ts` の秘匿化パターン（`SECRET_PATTERNS`）の限定性とディスクログへの機密混入
- **対象ファイル**: `src/main/debug.ts`
- **根拠と問題点**:
  `debug.ts` の `scrubSecrets()` で定義されている正規表現 `SECRET_PATTERNS` は以下の2種類のみです。
  - `/sk-[A-Za-z0-9_-]{4,}/g`
  - `/Bearer\s+[A-Za-z0-9._-]+/g`
  
  これにより、Azure OpenAI等の32桁16進数キー（`api-key: [a-f0-9]{32}`）や、URLクエリ形式（`?api_key=...` / `key=...`）、カスタムな認証ヘッダー形式のトークンがマスクされずにスルーされます。
  また、`debug()` は画面表示だけでなく `<userData>/windvoice-debug.log` ファイルへ永続書き込み（`appendFileSync`）を行うため、マスクを回避したAPIキーや、アクティブウィンドウタイトル（`activeWindow.ts` で取得されるファイル名やメール件名などのPII）がローカルディスク上に平文で蓄積されるリスクがあります。
- **改善提案**:
  `SECRET_PATTERNS` に `api_key=`, `key=`, `api-key:` などのクエリ・ヘッダーパターンや16進数トークン形式を追加して秘匿化ルールを強化してください。また、アクティブウィンドウタイトル等の個人情報（PII）をログ出力する際は適切に抽象化・非表示化することを推奨します。

---

### 4. 音声キャプチャ用隠しウィンドウにおける `sandbox: false` 設定のリスク
- **対象ファイル**: `src/main/audio/bridge.ts`
- **根拠と問題点**:
  `AudioBridge.init()` 内で作成される隠し `BrowserWindow` の `webPreferences` において、`sandbox: false` が明示的に設定されています。
  コメントによると Electron 42 の `AudioWorklet.addModule()` における `blob:` URL 制約の回避のためとされていますが、Chromium のレンダラープロセスサンドボックスが無効化されるため、メインプロセス並みの権限分離レベルが低下します。
  万が一レンダラープロセス側でプロトタイプ汚染や脆弱性が生じた場合、OSやNode.js機能へのアクセスを許す危険性があります。
- **改善提案**:
  `sandbox: true` を維持したまま `AudioWorklet` を動作させられる構造（例: Web Custom Protocol や `file://` / ディスク上のファイルパス経由でのモジュール読み込み）へ変更し、キャプチャ用ウィンドウも完全にサンドボックス化してください。

---

### 5. `session.defaultSession.setPermissionRequestHandler` におけるマイク権限許可対象の共通化
- **対象ファイル**: `src/main/index.ts`
- **根拠と問題点**:
  `session.defaultSession.setPermissionRequestHandler` でマイク権限（`permission === 'media'`）のハンドリングを行っていますが、`trustedMicIds` には本来マイク音声を取り込む `AudioBridge` の `webContents.id` だけでなく、設定画面ウィンドウ `createSettingsWindow()` の `winWebContentsId` も含まれています。
  グローバルな `defaultSession` に対して設定画面ウィンドウの `id` を登録して全マイク権限を無条件許可しているため、設定画面内で将来的に外部コンテンツやレンダラー上の脆弱性が存在した場合、マイクアクセス権限が意図せず悪用されるリスクがあります。
- **改善提案**:
  設定画面用の `BrowserWindow` には専用のセッション（`partition`）を割り当てるか、`AudioBridge` のみにマイク権限を限定し、設定画面でのマイクデバイス列挙にはパーミッション要求を伴わない代替APIまたは明示的な個別検証を適用することを検討してください。

---

REVIEW-DONE-6

## 隊7
^DWindows用音声ディクテーションアプリ **windvoice** のソースコードについて、【レイテンシーとパフォーマンス（録音開始までの遅さ・不要な処理）】の観点からコードレビューを実施いたしました。

重要な問題点および改善提案（5件）は以下の通りです。

---

### 1. 録音開始（Forwarding開始）の遅延：`start()` 内での処理順序と OS セキュアストレージの重複読み込み
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L203-L248 付近)
* **根拠**:
  `DictationOrchestrator.start()` において、ホットキー押下時にマイク音声のフォワーディングを開始する `audio.beginForwarding()` が関数の最最後に配置されています。その手前で `await secureStore.getApiKey()` や `await this.ensureConnected()`（その内部でも再度 `secureStore.getApiKey()` を呼び出し）が実行されています。Windows Credential Manager / DPAPI へのアクセスは OS の IPC を伴うため、キー押下のたびに呼び出すと数10ms〜100ms程度の遅延が発生します。接続確立済みであっても録音開始処理が後回しになるため、ホットキーを押してから実際に音声が取り込まれるまでにタイムラグが生じ、ユーザーの発話冒頭が欠ける原因となります。
* **改善提案**:
  - APIキーはメモリ上に一度キャッシュし、毎回のキー押下時に OS セキュアストレージを再参照しない構成にします。
  - `audio.beginForwarding()` を `start()` の冒頭付近（または接続確認と並行）で呼び出し、ホットキーが押された瞬間にマイク音声バッファリングが始まるように変更します。

---

### 2. メインスレッドをブロックする同期ファイル I/O（`fs.appendFileSync`）
* **対象ファイル**: `src/main/debug.ts` (L59-L80 付近)
* **根拠**:
  `debug.ts` 内の `fileLog()` 関数において、デバッグログ出力のために `fs.appendFileSync(p, line)` が同期 I/O で呼び出されています。この `debug()` 関数は環境変数のON/OFFにかかわらず無条件で `fileLog()` を実行する実装となっており、WebSocketのデータ受信や音声レベル更新、ホットキーイベントといった高頻度（10〜20Hz以上）のパスから呼び出されます。Node.js のメインイベントループ上で同期ディスク書込みが頻発することでスレッドがブロックされ、キー入力検知や音声データ伝送の遅延（スタッター）を引き起こします。
* **改善提案**:
  - ログファイルへの書き込みを非同期（`fs.appendFile` または Stream バッファリング）に変更し、メインスレッドのブロックを回避します。
  - 高頻度な呼び出しパスでは無条件書き込みを停止し、ログレベルに応じたフィルタリングを適用します。

---

### 3. Windows環境での音量ダッキング処理（PowerShellプロセス起動）による高負荷・遅延
* **対象ファイル**: `src/main/audio/duck.ts` (L43-L60 付近)
* **根拠**:
  `AudioDuck.duck()` および `restore()` では外部ライブラリ `loudness` を使用しています。Windows 環境において `loudness` パッケージは内部で `powershell.exe` コマンドを子プロセスとして生成・実行してシステム音量を取得・変更します。ディクテーションの開始・終了のたびに PowerShell プロセスが立ち上がるため、200ms〜500ms以上の大きなプロセス生成オーバーヘッドと CPU 負荷が発生し、アプリ全体のレスポンス性能を低下させます。
* **改善提案**:
  - Windows環境においては PowerShell に依存する `loudness` の使用をやめ、ネイティブ Win32 / WASAPI（`IAudioEndpointVolume`）を FFI（`koffi` 等）経由で直接呼び出してシステム音量を変更する構成に刷新します。

---

### 4. テキスト注入（ペースト）直前での `getActiveWindow()` 同期呼び出しによる入力遅延
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L361-L368 付近)
* **根拠**:
  `DictationOrchestrator.stop()` の処理終盤において、音声認識結果をアクティブウィンドウへペーストする直前に `await getActiveWindow()` を呼び出しています。 `getActiveWindow()` は `get-windows` ライブラリを介して外部ヘルパープロセスや OS API を呼び出す処理であり、最大 1500ms のタイムアウト枠を持つ重い非同期処理です。認識完了からテキスト画面注入までのクリティカルパス上でこの完了を同期待ちするため、録音終了キーを離してから実際に文字が貼り付けられるまでの体感レイテンシーが直接増大します。
* **改善提案**:
  - アクティブウィンドウの情報は録音開始時（`start()`）にあらかじめ取得しておくか、テキストペースト処理とは非同期（非ブロック）で並行取得・履歴保存するように変更します。

---

### 5. ディクテーション開始時における API キーの重複読み込み
* **対象ファイル**: `src/main/dictation/orchestrator.ts` (L203-L222, L541-L547 付近)
* **根拠**:
  `DictationOrchestrator.start()` の冒頭で `await secureStore.getApiKey()` が呼ばれた後、続く `await this.ensureConnected()` から呼び出される `_doConnect()` の内部でも再度 `await secureStore.getApiKey()` が実行されています。同一のディクテーション開始シーケンス内で同じ暗号化ストア読み込みが2度発生しており、無駄な非同期処理ステップと遅延を生み出しています。
* **改善提案**:
  - `_doConnect()` に取得済みの API キーを引数として引き渡すか、`secureStore` モジュール側で一度読み込んだキーをメモリ保持し、重複した OS アクセスを排除します。

---

REVIEW-DONE-7

## 隊8
^D`windvoice` のソースコードを「状態機械の整合性（録音中/変換中/注入中の遷移の穴・レース）」の観点からレビューいたしました。検出された重要な問題点および改善提案を5件挙げます。

---

### 1. `start()` と `stop()` の非同期タイミングによる録音永久化レースコンディション
- **対象ファイル**: [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L161-L230) (`start()`), [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L232-L364) (`stop()`)
- **根拠と影響**:
  WebSocket接続が開いている状態（事前接続済みなど）でユーザーが短時間にホットキーを押して離した場合、`start()` 内の `await this.ensureConnected()`（L198）でマイクロタスク待機が発生します。
  この直後に `stop()` が呼び出された場合、`this.inFlight` は `true` かつ `this.client.isOpen()` も `true` であるため、`stop()` は「接続待ち前のキャンセル分岐」を通らずに処理を進め、`endForwarding()` を呼び出します。
  その後 `start()` のマイクロタスクが復帰すると、`stop()` 側で `cancelRequested` が立てられていないため `start()` はそのまま続行され、`audio.beginForwarding()` と `updateStatus('listening')` を実行します。
  結果として、`stop()` の完了処理によって `inFlight` が `false` にリセットされた後も、バックグラウンドの `AudioBridge` は録音・転送状態（`forwarding = true`）のまま残留し、以降の `stop()` 呼び出しも `!inFlight` により無視されるため、アプリを再起動するまで録音が永久に止まらなくなります。
- **改善提案**:
  `start()` 開始時に `inFlight` だけでなく `starting` / `cyclePhase` 状態フラグを明確に管理し、`stop()` 呼び出し時は接続状態に関わらず常に `cancelRequested = true` を設定して `start()` 側の再開時に `beginForwarding()` を呼び出さず安全にリセットさせる制御を追加してください。

---

### 2. `stop()` 実行中（変換中・注入中）における重複呼び出し（Re-entrancy）への排他制御欠如
- **対象ファイル**: [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L232-L364) (`stop()`)
- **根拠と影響**:
  `stop()` 内では、音声終了処理・WebSocketコミット・テキスト最終確定待機（`pendingFinal`）・LLMポストプロセス（`postProcessorPipeline.run()`）・クリップボード注入（`pasteText`）が直列実行されますが、この全期間において `this.inFlight` は `true` のまま維持されます。
  テキスト変換中や注入中にユーザーが再度ホットキーを操作して `stop()` が呼ばれると、`if (!this.inFlight) return;` のガードを突破して `stop()` が二重実行されます。
  これにより、`audio.endForwarding()` や `client.commit()` の二重実行、`pendingFinalTimer` の上書きによるタイマーリーク、および `pasteText` の二重実行によるテキストの重複貼り付けが発生します。
- **改善提案**:
  `inFlight` に加えて `processing` や `stopping` などの過渡状態フラグを導入するか、`stop()` 進入直後に `this.inFlight = false`（または排他ロック）を設定し、一度 `stop()` サイクルに入った後の重複呼び出しを即座にガードしてください。

---

### 3. `HotkeyManager` の Toggle モードにおける Orchestrator 状態との脱調
- **対象ファイル**: [`src/main/hotkey/manager.ts`](file:///src/main/hotkey/manager.ts#L190-L204) (`onKey`), [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L161-L230) (`start()`)
- **根拠と影響**:
  `HotkeyManager` はトグル状態を自身の内部変数 `toggleActive` (Set) で保持し、キー押下ごとにオン/オフを切り替えて `'start'` / `'stop'` イベントを発火します。
  しかし、`orchestrator.start()` がAPIキー未設定・ネットワークエラー・直前エラー存在などの理由で即座に失敗（`inFlight = false` へ復帰）した場合でも、`HotkeyManager` 側の `toggleActive` には該当IDが登録されたまま残ります。
  ユーザーが次にトグルキーを押した際、`HotkeyManager` は「録音中からの停止」と判断して `'stop'` イベントを発火しますが、`orchestrator` 側は `inFlight === false` のため無視されます。結果としてユーザーはキーを2回連続で押さないと次の録音を開始できなくなります。
- **改善提案**:
  `start()` が失敗した際や `orchestrator` が `idle` / `error` に遷移した際に、`HotkeyManager` 側の `toggleActive` 状態を同期・リセットできるコールバックまたは状態非同期解消イベントを追加してください。

---

### 4. キャンセルされた `start()` における接続済クライアントの漂流と不意の `error` 遷移
- **対象ファイル**: [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L205-L209) (`start()`), [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L457-L547) (`_doConnect()`), [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L493-L514) (`onClose`)
- **根拠と影響**:
  初回接続時など `this.client` が `null` の状態の `start()` 実行中に `stop()` が呼ばれると、`stop()` は `!this.client` を検知して `cancelRequested = true` をセットしリターンします。
  その後非同期の `_doConnect()` が完了して `this.client` が確立された後、`start()` は `cancelRequested === true` を受けて `inFlight = false` とし早期リターンしますが、**確立された `this.client` のクローズ（`dispose()`）やイベントリスナーの解除を行いません**。
  この接続は漂流したままバックグラウンドで生存し続け、後からサーバータイムアウト等で切断（`onClose`）が発生した際、`inFlight === false` かつ `isOurClient === true` となるため、`onClose` 内の L509 (`this.updateStatus('error')`) が実行され、ユーザーが完全なアイドル状態であるにもかかわらずトレイアイコンが不意にエラー表示へと変化します。
- **改善提案**:
  `start()` の `cancelRequested` 判定時に、確立された `client` があれば `this.detachClientListeners(client)` および `client.dispose()` を実行して漂流接続を確実に破棄してください。

---

### 5. `onError` 発火タイミングによる確定済み文字起こし結果の棄損と状態クリーンアップ漏れ
- **対象ファイル**: [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L470-L491) (`onError`), [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L347-L352) (`stop()`)
- **根拠と影響**:
  1. **テキスト棄損の穴**: `stop()` 内でサーバーから正常に `final` テキストを受信し `pendingFinal` が解決された後、ポストプロセス（`postProcessorPipeline.run()`）や注入処理の待機中に WebSocket の遅延エラー等で `onError` が発火した場合、`onError` は `cycleErrored = true` および `inFlight = false` を設定します。その後ポストプロセスを抜けた `stop()` は L350 の `if (this.cycleErrored) return;` により即座に終了するため、**既に正常受領されていたテキストの注入（`pasteText`）および履歴保存（`tryAddHistory`）が全て破棄**されます。
  2. **クリーンアップ漏れの穴**: 逆に `stop()` が L351 で `this.inFlight = false` に設定した直後に `onError` が発火した場合、`onError` 内の `if (this.inFlight)` ガードにより `updateStatus('error')` や `audioDuck.restore()`、`streamingTyper.end()` 等のクリーンアップ処理が実行されず、状態やシステム音量が不整合のまま残ります。
- **改善提案**:
  `final` テキスト受信確定後は WebSocket 側の遅延エラーによってテキスト注入処理を中断しないようフェーズ管理を分離し、`onError` 内のクリーンアップ処理も `inFlight` 単一のフラグではなくサイクル全体のクリーンアップ状態に基づいて安全に実行される構造へ修正してください。

---

REVIEW-DONE-8

## 隊9
^DWindows用音声ディクテーションアプリ **windvoice** のソースコードについて、【Windowsスリープ復帰と長時間稼働（リソースリーク・タイマー）】の観点からコードレビューを行いました。検出された重要な問題および改善提案（5件）を以下に列挙します。

---

### 1. ログファイル回転失敗時のファイルサイズ無限増大（ディスクリソースリーク）
* **該当ファイル**: [src/main/debug.ts](file:///src/main/debug.ts) (`fileLog` 関数)
* **根拠**:
  ```typescript
  if (logBytes > LOG_MAX_BYTES) {
    try {
      renameSync(p, `${p}.1`);
    } catch {
      // Held open by a viewer (EPERM on Windows) ...
    }
    logBytes = 0;
  }
  ```
  Windows環境では、外部のログビューア、アンチウイルス、`tail`コマンド等によって `windvoice-debug.log` がロックされている場合、`renameSync` が `EPERM` / `EBUSY` エラーを発行します。`catch` ブロック内で `logBytes = 0` とリセットされていますが、実際のファイルリネームや切り詰めは行われていません。そのため、ファイル自体は2MB以上のサイズを保持したままログが追記され続け、約2MB追記されるたびに「リネーム失敗→`logBytes = 0`リセット」が繰り返されます。長時間稼働によってログファイルが数百MB〜数GBへ無制限に肥大化し、ディスク容量を圧迫します。
* **改善提案**: リネームに失敗した場合は `logBytes` を0にリセットせず、上限超過フラグを立てて追記を一時スキップするか、ストリームを維持したまま切り詰める（`ftruncateSync` 等）処理へ変更してください。

---

### 2. スリープ中録音動作時のステータス固着（インフライト状態の永久スタック）
* **該当ファイル**: [src/main/dictation/orchestrator.ts](file:///src/main/dictation/orchestrator.ts) / [src/main/index.ts](file:///src/main/index.ts)
* **根拠**:
  ```typescript
  recycleConnection(reason: string): void {
    if (this.disposed || this.inFlight) return;
    ...
  }
  ```
  ディクテーション実行中（`inFlight === true`）にWindowsがスリープへ移行した場合、Websocket接続やマイク入力はOSによって強制切断されますが、`suspend` イベントのハンドラが存在しないため `inFlight` は `true` のまま維持されます。スリープ復帰時に `powerMonitor.on('resume')` から `recycleConnection('power resume')` が呼ばれても、冒頭の `if (this.inFlight) return;` ガードによって接続再構築処理がスキップされてしまいます。その結果、アプリは永久に `inFlight === true` のまま固着し、ユーザーが再度ホットキーを押しても `start()` の `if (this.inFlight) return;` に阻まれて一切のディクテーションが不可能になります。
* **改善提案**: `suspend` イベントを補足して進行中のサイクルを強制作消（`abortInFlightCycle`）するか、`recycleConnection` 内で `inFlight` 状態であっても安全にキャンセル・再接続を行うロジックを追加してください。

---

### 3. スリープ移行時のシステム音量ダック状態の未復元（マスター音量低下の残存）
* **該当ファイル**: [src/main/index.ts](file:///src/main/index.ts) / [src/main/audio/duck.ts](file:///src/main/audio/duck.ts)
* **根拠**:
  [src/main/index.ts](file:///src/main/index.ts) では `powerMonitor.on('resume')` および `powerMonitor.on('unlock-screen')` の復帰イベントのみを購読しており、`powerMonitor.on('suspend')`（スリープ開始）が登録されていません。`duckOtherAudio`（他音量の減音）が有効な状態での録音中にPCのカバーを閉じる等のスリープが発生した場合、`audioDuck.restore()` が実行されないままOSが休止状態に入ります。復帰後もオーケストレーターの状態不整合等により `restore()` が正しく呼ばれず、Windowsのマスター音量がダックされた（低下した）まま戻らなくなる問題が発生します。
* **改善提案**: `powerMonitor.on('suspend')` を登録し、スリープ移行時に必ず `audioDuck.restore()` を呼び出してシステム音量を元に戻す安全網を構築してください。

---

### 4. スリープ・画面ロック復帰時の修飾キー・押下状態取りこぼしによる挙動不審
* **該当ファイル**: [src/main/hotkey/manager.ts](file:///src/main/hotkey/manager.ts) / [src/main/index.ts](file:///src/main/index.ts)
* **根拠**:
  Windowsのスリープ移行時や Win+L による画面ロック時、OSレベルのキーフック（`uIOhook`）が `keyup` イベントを取りこぼすことがあります。`HotkeyManager` にはスリープや画面ロックに連動して内部状態を初期化するメソッド（`resetState()` 等）が存在しないため、`heldDown`（押下中キーセット）や `modifierState`（Alt/Ctrl等の修飾キーフラグ）が `true` のまま残存します。これにより、復帰後にPush-to-Talkホットキーを押しても反応しなくなったり、テキスト注入処理における `untilAllModifiersUp()` が毎回600msタイムアウトを起こして入力遅延・エラーの原因となります。
* **改善提案**: `HotkeyManager` に `resetState()` メソッドを用意し、`powerMonitor` の `suspend` / `resume` / `lock-screen` イベント受信時に `heldDown`・`modifierState`・`modifierReleaseWaiters` を一括クリアしてください。

---

### 5. スリープ復帰直後のネットワーク未接続による不要なエラー判定と接続放置
* **該当ファイル**: [src/main/dictation/orchestrator.ts](file:///src/main/dictation/orchestrator.ts) (`prewarmConnection` / `recycleConnection`)
* **根拠**:
  Windowsのスリープ復帰時、`powerMonitor.on('resume')` から即座に `recycleConnection('power resume')` → `prewarmConnection()` → `ensureConnected()` が実行されます。しかしWindows環境ではスリープ復帰からWi-Fi/Ethernetなどのネットワークアダプタ再接続まで数秒間のタイムラグが発生することが一般的です。接続未完了のタイミングで即座に WebSocket ハンドシェイクを試みるため `connect()` が必ず拒否され、`prewarmConnection` 内の catch ブロックで `this.updateStatus('error')` および `this.reportTranscriptionError` が実行されます。結果として、PC画面を開いた直後に不必要なエラー通知が表示され、リアルタイム接続がエラー状態のまま再試行されずに放置されます。
* **改善提案**: スリープ復帰直後のプレウォーム実行時に短い遅延（リトライ機構やネットワーク疎通確認）を設けるか、プレウォーム段階での接続失敗時は即座にエラーポップアップを出さず、実際のホットキー押下（`start()`）時に遅延再接続を行うようハンドリングを改善してください。

---

REVIEW-DONE-9

## 隊10
^Dご提示いただいた `windvoice` のソースコードを「**UX（誤操作しやすさ・フィードバック不足・設定のわかりにくさ）**」の観点からコードレビューいたしました。重要度の高い問題点および改善提案を以下の5件にまとめて列挙します。

---

### 1. 接続確立前のPush-to-Talk離鍵による音声データのサイレント破棄
- **該当ファイル**: [orchestrator.ts](file:///src/main/dictation/orchestrator.ts#L273-L281)
- **根拠**: 
  `stop()` メソッド内にて、WebSocket接続が完了する前（`ensureConnected` 実行中）にユーザーがホットキーを離した場合、`!this.client || !this.client.isOpen()` が真となり `cancelRequested = true` がセットされてそのままステータスが `idle` に復帰します。
- **UX上の問題**: 
  ネットワーク遅延などで接続に少し時間がかかった際、ユーザーが発話してキーを離しても、文字入力もエラー通知も一切行われずに無視されます。ユーザーから見ると「キーを押して話したのに何も起きない・アプリが応答しない」と感じられます。
- **改善提案**: 
  接続待ち中に離鍵された場合でも短時間の接続完了を待ってコミットするか、「接続に失敗したため入力されませんでした」等の明示的なフィードバックを提示するべきです。

---

### 2. APIキー未設定・エラー時の視覚的フィードバック不足
- **該当ファイル**: [orchestrator.ts](file:///src/main/dictation/orchestrator.ts#L217-L221), [index.ts](file:///src/main/index.ts)
- **根拠**: 
  ディクテーション開始時（`start()`）にAPIキーが保存されていない場合、`this.updateStatus('unavailable')` が呼び出されてそのまま処理が終了します。トレイアイコンの状態変更以外に通知トーストの発行や設定ウィンドウの自動オープンが行われません。
- **UX上の問題**: 
  トレイアイコンの変化は気づきにくいため、キー未設定状態でホットキーを押した際、「アプリが壊れた」「反応しない」と誤認しやすくなります。
- **改善提案**: 
  `unavailable` 検出時には設定画面（Settings Window）を自動でフォアグラウンドに表示するか、デスクトップ通知等で「APIキーを設定してください」と直接案内するのが親切です。

---

### 3. 無音検出・マイク不可時の通知がトレイ常駐利用時に届かない
- **該当ファイル**: [orchestrator.ts](file:///src/main/dictation/orchestrator.ts#L432-L466)
- **根拠**: 
  マイクから音声が取得できない場合（`silentTake`）や接続トラブル時、`handleEmptyTake` から `reportNotice` や `reportTranscriptionError` を経由して `broadcastToUiWindows(IPC.SYSTEM_ERROR, ...)` を発行し、設定画面内のバナーにエラーを表示しようとします。
- **UX上の問題**: 
  `windvoice` は基本的にタスクトレイに常駐し、設定画面を閉じた状態で音声入力を行うアプリです。設定画面を開いていない日常利用時にはバナーメッセージが視界に入らず、マイクが他アプリに排他占有されている等の重要なトラブルに気づけません。
- **改善提案**: 
  OS標準のデスクトップ通知（Notification API）やオーバーレイ表示を活用し、設定画面が開いていなくてもエラーやマイクトラブルが直接伝わるフィードバック設計に改めるべきです。

---

### 4. ストリーミング入力有効化時のポスト処理（LLM整形・単語置換）のサイレント無効化
- **該当ファイル**: [orchestrator.ts](file:///src/main/dictation/orchestrator.ts#L380-L397)
- **根拠**: 
  `settings.insertion.streaming` が `true` の場合、`stop()` 内で文字のストリーミング注入を完了した直後に `return;` しており、後続の `postProcessorPipeline.run()`（GPTフォーマッタ、単語置換ルール、ファイルタグ処理）がすべてスキップされます。
- **UX上の問題**: 
  設定画面で「リアルタイム・ストリーミング入力」と「AI整形 / 単語置換」の両方をONに設定できる場合、後者の機能がなぜか反映されないという不整合が発生し、設定のわかりにくさにつながります。
- **改善提案**: 
  ストリーミングモード選択時には設定UI側でAI整形や置換機能が併用不可であることを明示するか、設定項目を相互排他にするガードを設ける必要があります。

---

### 5. OS非対応機能（macOS音量ダック・Fnキー）設定時の警告欠如
- **該当ファイル**: [duck.ts](file:///src/main/audio/duck.ts#L29-L33), [manager.ts](file:///src/main/hotkey/manager.ts#L341-L344)
- **根拠**: 
  `AudioDuck.duck()` は macOS環境において環境変数 `WINDVOICE_DUCK_MAC=1` が指定されていない限り動作をスキップします。また `FnWatcher` は macOS 専用実装ですが、ホットキー解析処理 `lookupKey` では全OS共通で `Fn` / `Globe` キーが定義されています。
- **UX上の問題**: 
  Windows向けアプリとして使用する際、Windows以外のプラットフォーム依存の制約や、設定しても機能しないオプション（例: Windows環境でのFnキー単体割り当てなど）がユーザーに開示されないため、誤操作や設定の混乱を招きます。
- **改善提案**: 
  OS環境ごとに利用できない設定項目はUI上でグレーアウト表示するか、補足説明ツールチップを追加して誤設定を防ぐべきです。

---

REVIEW-DONE-10

