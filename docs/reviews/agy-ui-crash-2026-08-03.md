# agy 8隊レビュー(雪風UI/クラッシュ 2026-08-03)
## agy-ui-1.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) 上で発生している 4 つの症状（①プロセス消失、②設定ウィンドウ不在、③UI空白、④注入成功の偽装）について、ご提示いただいた実機ログおよびソースコードに基づく原因仮説と具体的修正案（最大4件）を報告いたします。

---

### 原因仮説と具体的修正案

#### 1. 【仮説1】Sandboxed Preload での `process.env` 参照によるレンダラークラッシュ（症状③ UI空白 ＆ 症状② ウィンドウ不在の主因）
- **根拠（該当箇所）**: 
  - [`src/preload/index.ts`](file:///src/preload/index.ts#L189-L197) の `sessionType` プロパティ定義
  - [`src/main/index.ts`](file:///src/main/index.ts#L112-L121) の `createSettingsWindow` 内 `BrowserWindow` 設定 (`sandbox: true`)
- **原因分析**: 
  `createSettingsWindow` にて `sandbox: true` が設定されているため、Preload スクリプト内では Node.js の `process` オブジェクトがサンドボックス化され `process.env` は `undefined` になります。
  しかし [`src/preload/index.ts`](file:///src/preload/index.ts#L190) では `process.env['WINDVOICE_FORCE_X11']` や `process.env['WAYLAND_DISPLAY']` を直接参照しているため、Preload スクリプトの評価時に未捕獲の `TypeError: Cannot read properties of undefined` が発生します。
  これにより `contextBridge.exposeInMainWorld('windvoice', api)` の実行前に処理が中断し、[`src/renderer/App.tsx`](file:///src/renderer/App.tsx#L35) の `window.windvoice.getSettings()` 呼び出し時に `window.windvoice` が `undefined` となって React レンダラー全体がクラッシュ（UI空白：症状③）します。また、レンダラー初期化失敗によって `ready-to-show` イベントが正常に完了せず、ウィンドウが表示されないまま不整合状態に陥ります（症状②）。
- **具体的修正案**: 
  `src/preload/index.ts` 内での `process.env` の直接参照を止め、`typeof process !== 'undefined' && process.env` による安全チェックを入れるか、`sessionType` の判定処理をメインプロセス側 (`src/main/index.ts`) で実施して IPC 経由で取得・提供する構成に変更します。

---

#### 2. 【仮説2】`uncaughtException` ハンドラ欠落および Sidecar 終了時の未捕獲例外（症状① 起動後数分でプロセス消失の主因）
- **根拠（該当箇所）**: 
  - [`src/main/index.ts`](file:///src/main/index.ts#L488-L490) (プロセスレベルのエラーハンドラ)
  - [`src/main/linux/portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L140-L180) (`onExit`, `teardownChild`, `requestRespawn`)
  - 実機ログ: `2026-08-03T02:29:57.969Z [dictation] portal sidecar exited (null)`
- **原因分析**: 
  実機ログが示す通り、起動約2分後に Portal Sidecar プロセスが突然終了しています。
  `src/main/index.ts` には `unhandledRejection` のログハンドラしか用意されておらず、`process.on('uncaughtException')` が存在しません。Sidecar 終了時 (`portalSidecar.ts` L172 `teardownChild`) に発生する `rejectAllPending` や、D-Bus / イベントリスナー (`onUnavailable`) 呼び出しに伴う例外が捕捉されず、Node メインプロセス全体がログを残さずにサイレントクラッシュ・終了しています。
- **具体的修正案**: 
  `src/main/index.ts` に `process.on('uncaughtException', ...)` を追加して未捕獲例外のキャッチとログ記録を行い、`portalSidecar` の `onExit` および非同期コールバック実行部を `try...catch` で保護してメインプロセスの安全なリカバリを保証します。

---

#### 3. 【仮説3】StatusNotifierWatcher 通信タイムアウトと不要な設定ウィンドウ自動生成のループ（症状① ＆ 症状② の複合要因）
- **根拠（該当箇所）**: 
  - [`src/main/linux/statusNotifier.ts`](file:///src/main/linux/statusNotifier.ts#L20-L36) (`ensureStatusNotifierWatcher`)
  - [`src/main/linux/sessionBus.ts`](file:///src/main/linux/sessionBus.ts#L142-L205) (`sessionBusNameHasOwner`)
- **原因分析**: 
  Ubuntu 24.04 GNOME 46 では `ubuntu-appindicators@ubuntu.com` 拡張機能が有効ですが、起動直後の `sessionBusNameHasOwner` による D-Bus 問い合わせがタイムアウト (1500ms) や認証失敗を起こすと、`ensureStatusNotifierWatcher` は `false` を返して `openSettings()` (`createSettingsWindow`) を自動実行します。
  仮説1の通り `createSettingsWindow` は表示前にレンダラーがクラッシュするため、画面上に現れず内部で破棄・未表示状態が蓄積し、アプリのライフサイクル制御を崩壊させています。
- **具体的修正案**: 
  `ensureStatusNotifierWatcher` において `org.kde.StatusNotifierWatcher` の判定に失敗した場合でも、即座にエラー扱いにして設定ウィンドウを自動生成せず、Ubuntu AppIndicator の検出待ちや再試行リトライを設ける設計に変更します。

---

#### 4. 【仮説4】`PortalSidecar` の `selectionRead` 検証結果を上位層が無視して `ok: true` を返却（症状④ 注入成功偽装の主因）
- **根拠（該当箇所）**: 
  - [`src/main/linux/portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L349-L390) (`pasteText` メソッド)
  - [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts) などの呼び出し元ロジック
- **原因分析**: 
  `portalSidecar.ts` L383 では `ok: injected === true && selectionRead` と定義されており、キー送信が成功しても対象アプリによる選択範囲の読み取りが行われなかった場合（"no post-injection selection read was observed"）、`portalSidecar.pasteText` は `ok: false` の結果を返しています。
  しかし、呼び出し側である上位層 (`typer.ts` やオーケストレータ) が `result.injected` や `result.claimed` のフラグのみを判定基準にしているため、`selectionRead === false` であるにもかかわらず上位へ `ok: true` を報告し、注入成功を偽る状態が発生しています。
- **具体的修正案**: 
  `typer.ts` およびオーケストレータ側の成功判定ロジックにおいて、`result.injected` 単体ではなく `result.ok`（`injected && selectionRead`）を必須判定条件に改修し、`selectionRead` が得られなかった場合は明確に失敗 (`ok: false`) として処理・エラー通知を行います。

---

UIRV1

## agy-ui-2.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) における WindVoice の実機ログおよびソースコード解析結果に基づく、原因仮説と具体的な修正案です。

---

### 1. `setStatus` における破棄済み `BrowserWindow` への `webContents.send` 呼び出しと未捕捉例外クラッシュ（プロセス消失）

* **原因仮説**:
  `src/main/tray/index.ts` の `setStatus` 内で、`BrowserWindow.getAllWindows()` で取得した全ウィンドウに対し `win.webContents.send(IPC.STATUS_CHANGED, status)` を無条件で呼んでいます。ポータルサイドカーが約2分後に終了した際（ログ `2026-08-03T02:29:57.969Z [dictation] portal sidecar exited (null)`）などにステータス変更通知が発生すると、既に閉じられた／破棄処理中の `BrowserWindow` の `webContents` へアクセスし、`"Object has been destroyed"` 例外が発火します。`src/main/index.ts` には `uncaughtException` ハンドラが定義されていないため、メインプロセスごと即座にクラッシュ終了（プロセス消失）します。
* **根拠**:
  * [src/main/tray/index.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/tray/index.ts#L97-L99): `setStatus` 内で `win.isDestroyed()` や `win.webContents.isDestroyed()` の確認なしに `send` を実行。
  * [src/main/index.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/index.ts#L547-L549): `unhandledRejection` のみ監視されており、`uncaughtException` ハンドラが欠落。
* **具体的修正案**:
  `setStatus` 内で `win.isDestroyed()` および `win.webContents.isDestroyed()` をチェックしてから `send` を実行するように修正します。また `src/main/index.ts` に `process.on('uncaughtException', ...)` を追加してログ出力と安全なリカバリ・終了処理を行います。

---

### 2. GNOME Wayland 環境での `StatusNotifierWatcher` 不在検知時の非同期ウィンドウ生成と `show: false` によるウィンドウ不在

* **原因仮説**:
  `src/main/linux/statusNotifier.ts` の `ensureStatusNotifierWatcher` は、D-Bus 上の `org.kde.StatusNotifierWatcher` を確認し、不在時に `options.openSettings()` を呼び出します。GNOME 46 Wayland の初期化タイミングや環境によってWatcherが見つからない場合、`createSettingsWindow()` が非同期実行されます。`BrowserWindow` は `show: false` で生成され、`ready-to-show` イベントで `win.show()` される設計ですが、レンダラー初期化中や通信遅延により `ready-to-show` が発火しない、またはレンダラーロードが失敗した場合、ウィンドウは `show: false` のまま表示されず、GNOME のウィンドウ一覧 (`bs false ""`) にも現れません。
* **根拠**:
  * [src/main/linux/statusNotifier.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/linux/statusNotifier.ts#L27-L32): `ensureStatusNotifierWatcher` 内で `openSettings()` を非同期実行。
  * [src/main/index.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/index.ts#L134-L164): `createSettingsWindow` の `show: false` 初期化と `win.on('ready-to-show', () => win.show())`。
* **具体的修正案**:
  `createSettingsWindow` で `loadFile`/`loadURL` 完了後に明示的に `show()` を呼び出すか、一定時間 `ready-to-show` が来ない場合のフォールバック `show()` 処理を追加して、表示不全を防ぎます。

---

### 3. レンダラー側 `settings` 取得 Promise 未完了時の設定UI空白（白画面）表示

* **原因仮説**:
  `src/renderer/App.tsx` では `useState<Settings | null>(null)` で状態を保持し、`useEffect` 内で `window.windvoice.getSettings()` のレスポンスを受け取って `setSettings` を更新します。メインプロセスとの IPC ハンドラ未登録・通信失敗・パーミッション拒否などにより `getSettings()` が Promise 承認されないか失敗した場合、`settings` は `null` のまま保持されます。`App.tsx` の描画条件は `{settings && tab === 'general' && <GeneralPage ... />}` のようになっており、`settings` が `null` の場合はメインコンテンツ領域に一切のページがレンダリングされず、UIの中身が完全な空白（空の枠のみ）となります。
* **根拠**:
  * [src/renderer/App.tsx](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/renderer/App.tsx#L32-L38): `const [settings, setSettings] = useState<Settings | null>(null);`
  * [src/renderer/App.tsx](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/renderer/App.tsx#L196-L211): `settings` が `null` の場合、全タブのページコンポーネントが評価されず未描画となる。
* **具体的修正案**:
  `settings` のロード状態（`loading`, `error`）を明示的に管理し、取得失敗時にはエラーメッセージと再試行ボタンを表示するUIガード（ロケールおよびエラー表示）を追加します。

---

### 4. Portal Sidecar の注入検証 (`selectionRead`) 失敗時の上位判定による「成功 (ok=true)」偽装

* **原因仮説**:
  `src/main/linux/portalSidecar.ts` の `pasteText` メソッドでは、注入結果 `injected` とクリップボード読み取り検証 `selectionRead` の両方が true の場合のみ `ok: true` を返す仕様 (`ok: injected === true && selectionRead`) になっています。しかし、実機で `no post-injection selection read was observed`（`selectionRead === false`）と判定されているにもかかわらず上位で `ok=true` が返る症状は、オーケストレータやタイパー側（`src/main/inject/typer.ts` 等）で `PortalPasteResult` の `ok` フラグではなく `injected` 単体や成功フォールバック条件を参照してしまい、失敗状態を上位に隠蔽して成功として扱ってしまうことに起因します。
* **根拠**:
  * [src/main/linux/portalSidecar.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/linux/portalSidecar.ts#L365-L377): `pasteText` での `selectionRead` 評価と `sessionRecyclePending` フラグ設定。
* **具体的修正案**:
  注入処理の呼び出し元（`typer.ts` / `orchestrator.ts`）において `selectionRead` が false の場合は厳密に `ok: false` と判定し、上位 UI・ログへの通知および手動貼り付け用クリップボード維持等の正しい失敗時フォールバックへ分岐するように修正します。

---

UIRV2

## agy-ui-3.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) のデバッグ専門家として、ご提示いただいた実機証拠（ログ・環境）およびソースコードの解析結果に基づき、原因仮説と具体的修正案（計4件）を報告いたします。

---

### 原因仮説と具体的修正案（最大4件）

#### 1. 設定ウィンドウの `show: false` ＋ `ready-to-show` 依存による Wayland/GNOME 下でのウィンドウ一覧不表示・非表示化
* **根拠（関数名・行）**:
  * `src/main/index.ts` の `createSettingsWindow()`（127〜166行目）
  * `src/main/index.ts` の `app.whenReady()` 内処理（253〜513行目）
* **原因詳細**:
  `createSettingsWindow()` では `new BrowserWindow` に `show: false`（135行目）を指定し、`win.on('ready-to-show', () => win.show())`（154行目）で表示制御を行っています。しかし、Ubuntu 24.04 GNOME 46 (Wayland) 環境では、非表示で創出された BrowserWindow の `ready-to-show` イベントが正常に発火しない、または Mutter の Window List（Wayland surface）に適切にマップされない既知の不具合・遅延が発生します。
  さらに、起動時の `ensureApiKey()`（220〜237行目）は API キー保持時に `createSettingsWindow()` を実行しないため、アプリ起動直後は設定ウィンドウ自体が生成されておらず、GNOME のウィンドウ一覧に表示されないのは仕様通りの動作です。
* **具体的修正案**:
  `createSettingsWindow()` において `ready-to-show` イベントだけに頼らず、`win.loadFile()` 完了後または明示的な表示要求時に確実な `win.show()` および `win.focus()` を呼び出すよう変更し、Wayland 下でのレンダリングとウィンドウ一覧への登録を保証します。

---

#### 2. `BrowserWindow.getAllWindows()` による非表示ウィンドウ（Audio/Overlay）と UI ウィンドウの混同
* **根拠（関数名・行）**:
  * `src/main/tray/index.ts` の `setStatus()`（112〜114行目）
* **原因詳細**:
  `setStatus()` 内で `for (const win of BrowserWindow.getAllWindows()) { win.webContents.send(IPC.STATUS_CHANGED, status); }` と記述されています。
  `BrowserWindow.getAllWindows()` は、バックグラウンド処理用の `AudioBridge`（hidden audio window）や `OverlayWindow` などの非表示ウィンドウを含めて全て取得してしまいます。`@main/broadcast` の `broadcastToUiWindows` を使用せず全ウィンドウに直接 IPC を送出しているため、非表示の Audio レンダラー等に無用な UI イベントが通知され、内部状態の不整合やレンダラー側の異常動作を引き起こす原因となります。
* **具体的修正案**:
  `src/main/tray/index.ts` の `setStatus()` を修正し、`BrowserWindow.getAllWindows()` の直接ループを廃止して `@main/broadcast` の `broadcastToUiWindows(IPC.STATUS_CHANGED, status)` を呼び出すように変更します。

---

#### 3. 設定UI描画時における `getSettings()` レスポンス未処理による画面空白
* **根拠（関数名・行）**:
  * `src/renderer/App.tsx` の `App()`（44〜47行目、181〜198行目）
* **原因詳細**:
  `App.tsx` の mount 時に `window.windvoice.getSettings()` を実行して `settings` ステート（初期値 `null`）を更新します。しかし `settings` が `null` の間は、`<main>` 要素内の各ページ（`GeneralPage` 等）が `{settings && tab === 'general' && ...}` の判定によりレンダリングされず、画面の中身が空白になります。
  `getSettings()` の Promise に対して `.catch()` 等のエラーハンドリングが記述されていないため、IPC 通信の遅延や失敗時に `settings` が `null` のまま固まり、結果として設定UIが空白化します。
* **具体的修正案**:
  `App.tsx` の `useEffect` 内で `getSettings()` 呼び出しに `.catch()` ハンドラーを追加し、設定取得失敗時のフォールバック値の設定やエラー表示を行い、UI が空白のまま放置されるのを防ぎます。

---

#### 4. Wayland portal sidecar の注入検証失敗時における擬似成功およびプロセス消失
* **根拠（関数名・行）**:
  * `src/main/linux/portalSidecar.ts` の `pasteText()`（427〜472行目）
  * `src/main/linux/portalSidecar.ts` の `send()`（376〜412行目）
  * 直近ログ: `[dictation] portal sidecar exited (null)`
* **原因詳細**:
  Wayland 環境で注入後の選択読み取り失敗（`no post-injection selection read was observed`）が発生した際、`pasteText()` 内の条件判定や上位連携の不備により、呼び出し元が成功（`ok: true`）と誤認して処理を継続する構造が存在します。
  また、RemoteDesktop セッション切断時などに `send()` 内の `stdin.write` で EPIPE エラーが発生し、`teardownChild` による再起動ループが上限（`MAX_RESPAWNS = 5`）に達した結果、ポータルサイドカーが不意に停止し、メインプロセスが数分後にハング・消失します。
* **具体的修正案**:
  `portalSidecar.ts` の `pasteText()` で `selectionRead` が検証できなかった場合のステータス判定を厳格化して正しく失敗を返し、`send()` でのパイプエラー捕捉とサイドカーの再起動管理を安全に行うよう実装を修正します。

---

UIRV3

## agy-ui-4.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) 環境における WindVoice アプリの設定 UI が空白になる問題について、ソースコードおよび実機ログに基づき【設定UIの中身が空白になる原因】に絞った 4 件の原因仮説と具体的な修正案を提示します。

---

### 【原因仮説 1】 `App.tsx` での `getSettings()` エラーハンドリング欠落による `settings === null` 判定での描画スキップ

- **根拠 (ファイル・関数名・行)**: 
  - [`src/renderer/App.tsx`](file:///src/renderer/App.tsx#L38-L41) (`App` 関数 L38–41, L214–L230)
- **詳細・メカニズム**:
  `App.tsx` の `useEffect` 内で `window.windvoice.getSettings()` を呼び出していますが、`.catch()` による拒否ハンドリングが存在しません。D-Bus未検出時の通知や IPC 接続遅延等によりメインプロセス側の `settings:get` ハンドラーがエラーを返すかリジェクトされた場合、`settings` 状態が初期値 `null` のまま更新されません。
  レンダラーのメイン描画部が `{settings && tab === 'general' && (...)}` のように `settings` の存在を前提としているため、条件が全て `false` となり、サイドバー以外のメインコンテンツの中身が一切表示されず空白状態になります。
- **具体修正案**:
  `getSettings()` 呼び出しに `.catch()` を追加し、取得失敗時でもデフォルト設定 (`DEFAULT_SETTINGS`) にフォールバックするか、エラー画面をレンダリングするように修正します。

---

### 【原因仮説 2】 `ensureStatusNotifierWatcher` による IPC ハンドラー初期化前・準備未完了段階での Window 生成

- **根拠 (ファイル・関数名・行)**: 
  - [`src/main/index.ts`](file:///src/main/index.ts#L300-L308) (`app.whenReady` コールバック L300–308)
  - [`src/main/linux/statusNotifier.ts`](file:///src/main/linux/statusNotifier.ts#L21-L41) (`ensureStatusNotifierWatcher` 関数 L33–37)
- **詳細・メカニズム**:
  実機ログ `bs false ""` が示す通り、GNOME Wayland 上で `org.kde.StatusNotifierWatcher` が存在しないため、`ensureStatusNotifierWatcher` は起動直後に `options.openSettings()` (`createSettingsWindow()`) を実行します。
  この呼び出しタイミングにおいて、レンダラーがロードされて即座に IPC (`settings:get`) を呼び出した際、メインプロセス側のデータ準備や `trustedSettingsSender` のバインドとのタイミングギャップが生じ、IPC レスポンスが拒否または失敗します。結果として設定ロードが完了せず、画面の中身が空白になります。
- **具体修正案**:
  `createSettingsWindow()` 内で `settingsStore` が確実に初期化済みであることを保証する非同期バリアを導入し、レンダラーからの `getSettings` 呼び出しに対して安全に応答できるように修正します。

---

### 【原因仮説 3】 Preload スクリプトの実行失敗による `contextBridge` の露出スキップと React のコンポーネント例外クラッシュ

- **根拠 (ファイル・関数名・行)**: 
  - [`src/preload/index.ts`](file:///src/preload/index.ts#L1-L15) (冒頭インポート文 L1–15, `contextBridge.exposeInMainWorld` L280–281)
  - [`src/renderer/App.tsx`](file:///src/renderer/App.tsx#L38-L41) (`App` 関数 L38)
  - [`src/renderer/UpdaterBanner.tsx`](file:///src/renderer/UpdaterBanner.tsx#L35-L39) (`UpdaterBanner` 関数 L35)
- **詳細・メカニズム**:
  Electron の `sandbox: true` 環境下において、Preload スクリプト内で非サンドボックス環境用の依存関係やモジュール解決エラーが発生すると、"Unable to load preload script" エラーにより Preload の実行全体が途中でクラッシュします。
  これにより `contextBridge.exposeInMainWorld('windvoice', api)` が実行されず、レンダラー側で `window.windvoice` が `undefined` となります。`App.tsx` や `UpdaterBanner.tsx` で `window.windvoice.getSettings()` や `getUpdaterState()` を呼び出す際に `TypeError: Cannot read properties of undefined` が発生し、React のレンダリングツリー全体がアンハウンド例外で壊滅して設定 UI 全体が白紙・空白化します。
- **具体修正案**:
  `preload/index.ts` の依存モジュールを完全な型定義のみに制限し、レンダラー側の `App.tsx` および `UpdaterBanner.tsx` にて `window.windvoice?.getSettings?.()` のようにオプショナルチェイニングと Error Boundary による安全保護を実装します。

---

### 【原因仮説 4】 `useI18n` 辞書データ読み込み失敗・未初期化に伴う UI レンダリング時の例外発生

- **根拠 (ファイル・関数名・行)**: 
  - [`src/renderer/App.tsx`](file:///src/renderer/App.tsx#L30) (`App` 関数 L30, `tabLabels` 辞書参照 L195–202)
  - [`src/shared/i18n/index.ts`](file:///src/shared/i18n/index.ts) (`t` 関数)
- **詳細・メカニズム**:
  `App.tsx` 内で `const { t } = useI18n();` を使用して `tabLabels` (`general: t('tab.general')` 等) を構築しています。設定言語 (`uiLanguage`) に対応する i18n JSON 辞書ファイルのロードに失敗しているか、初期化完了前に `t()` が呼び出された場合、`t` 関数の内部で `TypeError` や例外が投げられます。
  React の描画サイクル（`render`）中に例外が発生するため、設定ウィンドウのコンポーネントツリー全体がアンマウントされ、結果として中身が空白のウィンドウが残ります。
- **具体修正案**:
  `useI18n` フックおよび `t()` 関数において、辞書キーが存在しない場合や未読み込み時にフォールバック文字列（英語やキー名そのまま）を返し、絶対に出外例外を投げない安全設計に修正します。

---

UIRV4

## agy-ui-5.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) 環境における WindVoice の各症状について、ソースコードおよび実機証拠の解析に基づく原因仮説と具体的な修正案（最大4件）を報告いたします。

---

### 1. 【症状①】起動後数分でのプロセス消失
* **原因仮説**:
  AppImageを展開してバイナリを直起動（`APPDIR` 未設定）した際、`portalSidecar`（`resources/native/portal-remote.py`）実行時のパス解決（`resolveSidecarScript`）や環境変数（`PYTHONPATH`, `GI_TYPELIB_PATH` 等）が不完全になります。これにより Python 子プロセス側で `PyGObject` / D-Bus 接続エラーやクラッシュが頻発し、`MAX_RESPAWNS`（5回）の再起動制限を超過して `portal sidecar exited (null)`（ログ: 02:29:57）となり、最終的に未ハンドルのエラー伝播または GTK/AppIndicator C層のリソース解放失敗に伴いメインプロセスが異常終了（消失）しています。
* **根拠**:
  * `src/main/linux/portalSidecar.ts`: L197–L203 (`start` 関数における `python3` スポーン処理), L236–L239 (`requestRespawn` の上限チェック), L399–L422 (`resolveSidecarScript` のパス検索)
  * `src/main/index.ts`: L408–L419 (`portalSidecar.setUnavailableListener`)
  * 実機ログ: `2026-08-03T02:29:57.969Z [dictation] portal sidecar exited (null)`
* **具体的な修正案**:
  `resolveSidecarScript()` にて `process.env.APPDIR` や `process.execPath`（展開先バイナリの絶対パス）を基準とした検索パスを追加します。さらに `portalSidecar.start()` の `spawn` 呼出時に、`APPDIR` が未設定の場合は展開先ディレクトリを自動検知して `PYTHONPATH` や `GI_TYPELIB_PATH` を環境変数として補正・注入する処理を実装します。

---

### 2. 【症状②】設定ウィンドウがウィンドウ一覧に不在（非表示のまま孤立）
* **原因仮説**:
  `ensureStatusNotifierWatcher` において D-Bus 名 `org.kde.StatusNotifierWatcher` の応答検証失敗時に `createSettingsWindow()` が自動実行されます。`createSettingsWindow()` は `show: false` で `BrowserWindow` を作成し、`ready-to-show` イベントで `win.show()` を呼ぶ実装になっています。
  しかし `APPDIR` 未設定の影響で `PRELOAD_PATH` (`path.join(__dirname, '../preload/index.js')`) や `win.loadFile(path.join(__dirname, '../renderer/index.html'))` の相対パス解決が失敗し、DOM / Renderer のロードが完了しないため `ready-to-show` イベントが永久に発火せず、ウィンドウが非表示（GNOMEウィンドウ一覧で `bs false ""` 状態）のままバックグラウンドに孤立します。
* **根拠**:
  * `src/main/index.ts`: L39 (`PRELOAD_PATH` 定義), L160–L175 (`createSettingsWindow` の `show: false`), L185 (`win.on('ready-to-show', () => win.show())`), L193–L197 (`win.loadFile` 呼び出し)
  * `src/main/linux/statusNotifier.ts`: L35 (`ensureStatusNotifierWatcher` からの `openSettings` 呼び出し)
  * 実機証拠: ウィンドウ一覧 `bs false ""`
* **具体的な修正案**:
  `PRELOAD_PATH` および `win.loadFile()` のパス指定を `app.getAppPath()` を基準とした絶対パス解決に変更します。また `win.loadFile()` の Promise 拒否（失敗）をキャッチするハンドラを追加し、ロード失敗時にはフォールバック表示や明確なエラーダイアログを出力するように修正します。

---

### 3. 【症状③】設定UIの中身が空白
* **原因仮説**:
  AppImageの直接実行によって `__dirname` 基準のバンドルファイル参照（`../renderer/index.html` および `../preload/index.js`）やトレイアイコンのリソース解決（`src/main/tray/index.ts` L16–L26 `iconCandidates`）が破綻しています。この結果、Renderer プロセス起動時に JavaScript モジュールの読み込みエラー（404 Not Found やモジュール解釈例外）が発生し、React エントリポイント（`src/renderer/main.tsx` / `App.tsx`）のレンダリングが空白画面のまま中断されています。
* **根拠**:
  * `src/main/index.ts`: L39 (`PRELOAD_PATH`), L195 (`win.loadFile`)
  * `src/main/tray/index.ts`: L16–L26 (`iconCandidates` 関数における `app.getAppPath()` および `process.resourcesPath` 参照)
  * `src/renderer/App.tsx`: L42–L50 (`window.windvoice.getSettings()` の初期呼び出し部)
* **具体的な修正案**:
  `app.getAppPath()` や `process.execPath` から AppImage の展開ディレクトリ構造を判定する標準パス解決モジュールを導入し、Main・Preload・Renderer・Tray の各層におけるアセット読み込みパスを一貫して補正・保護します。

---

### 4. 【症状④】注入成功と偽る（`no post-injection selection read was observed` なのに上位が `ok=true`）
* **原因仮説**:
  `src/main/linux/portalSidecar.ts` の `pasteText()` (L368–L375) では、Wayland の RemoteDesktop ポータル経由でキー入力注入後、選択領域の読み取り検証が行われなかった場合（`selectionRead: false`）、内部的に `ok: injected === true && selectionRead` (＝ `false`) を計算して戻り値を生成しています。
  しかし上位のタイパー/呼出元（`@main/inject/typer` 等）側で、戻り値の `result.ok` のフラグではなく `result.injected` や `result.claimed` の値（または処理が例外を投げずに完了したこと）のみを見て成功と判定しているため、「`no post-injection selection read was observed`」が発生しているにもかかわらず上位へ `ok=true` を伝播してしまいます。
* **根拠**:
  * `src/main/linux/portalSidecar.ts`: L330–L377 (`pasteText` 関数の実装、特に L368–L375 の `ok: injected === true && selectionRead` オブジェクト生成)
  * `src/main/linux/portalSidecar.ts`: L360–L364 (`sessionRecyclePending` の処理条件)
* **具体的な修正案**:
  `portalSidecar.pasteText()` の呼出元ロジック（`@main/inject/typer` 等）において、戻り値の `result.ok` を厳格に判定するガード条件を追加します。`selectionRead` が `false` の場合は成功（`ok: true`）とみなさず、上位へ適切にエラー（`ok: false`）および失敗要因を伝えるように修正します。

---

UIRV5

## agy-ui-6.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) 環境における WindVoice の各症状について、ソースコード解読および `ubuntu-appindicators` 有効環境下の検証に基づく原因仮説と具体的修正案（最大4件）を報告します。

---

### 1. 【設定ウィンドウ不在】StatusNotifierWatcher判定通過による初期ウィンドウ未生成
* **原因仮説**: 
  [src/main/linux/statusNotifier.ts](file:///src/main/linux/statusNotifier.ts#L21-L37) の `ensureStatusNotifierWatcher()` は、`sessionBusNameHasOwner` を用いて D-Bus 上の `org.kde.StatusNotifierWatcher` の存在を確認しています。Ubuntu 24.04 GNOME 46 で `ubuntu-appindicators@ubuntu.com` 拡張機能が有効な場合、この D-Bus 名が存在するため `available = true` と判定され L27 で即座に `return true` します。その結果、トレイ非対応時用のフォールバックである `options.openSettings()`（`createSettingsWindow()`）が呼び出されず、トレイアイコン側も正常表示・操作できない環境では設定ウィンドウが画面に一度も現れません。
* **根拠**: 
  * `ensureStatusNotifierWatcher()`：[src/main/linux/statusNotifier.ts#L21-L37](file:///src/main/linux/statusNotifier.ts#L21-L37)
  * `app.whenReady()` 内の呼び出し：[src/main/index.ts#L326-L333](file:///src/main/index.ts#L326-L333)
* **具体的な修正案**: 
  `ensureStatusNotifierWatcher` の判定結果のみに依存して設定ウィンドウの非表示を決定するのをやめ、Linux環境での初回起動時や明示的なフラグ指定時に [src/main/index.ts](file:///src/main/index.ts#L130) の `createSettingsWindow()` を必ず1度実行してウィンドウを表示・確保するロジックに変更します。

---

### 2. 【プロセス消失】`ubuntu-appindicators` 環境でのインメモリ NativeImage トレイ更新による C ライブラリ層クラッシュ
* **原因仮説**: 
  [src/main/tray/index.ts](file:///src/main/tray/index.ts#L188-L195) の `loadIcon()` は、ディスク上のアイコン画像読み込み失敗時に `buildSolidPng()` ([L197-L221](file:///src/main/tray/index.ts#L197-L221)) でメモリ上に動的生成した Raw PNG Buffer から `NativeImage` を作成します。Ubuntu 24.04 Wayland + `ubuntu-appindicators` 環境下では、実ファイルパスを持たない `NativeImage` を [L115](file:///src/main/tray/index.ts#L115) の `tray.setImage()` や [L161](file:///src/main/tray/index.ts#L161) の `tray.setContextMenu()` で頻繁に更新すると、Electron 内部の `libappindicator` / `libdbusmenu` (C/C++ ネイティブ層) で D-Bus パス参照エラーや SIGSEGV / SIGPIPE が発生し、メインプロセスがログを残さず突然消失（クラッシュ）します。
* **根拠**: 
  * `setStatus()`：[src/main/tray/index.ts#L111-L126](file:///src/main/tray/index.ts#L111-L126)
  * `refreshMenu()`：[src/main/tray/index.ts#L136-L162](file:///src/main/tray/index.ts#L136-L162)
  * `loadIcon()` / `buildSolidPng()`：[src/main/tray/index.ts#L188-L221](file:///src/main/tray/index.ts#L188-L221)
* **具体的な修正案**: 
  `buildSolidPng()` によるインメモリ Buffer の使用を止め、一時ディレクトリに実ファイルとして吐き出した絶対パスから `nativeImage.createFromPath()` で生成するか、Linux 環境下ではトレイの `setImage()` および `setContextMenu()` の無駄な連続呼び出しをデバウンス・ガードします。

---

### 3. 【設定UI中身空白】Renderer 側 `getSettings()` の Promise エラーハンドリング不足と型不整合
* **原因仮説**: 
  [src/renderer/App.tsx](file:///src/renderer/App.tsx#L49-L52) の `useEffect` 内で `window.windvoice.getSettings()` を呼び出していますが、Promise に `.catch()` が存在しません。IPC 通信例外や処理遅延が発生した場合に `settings` State が `null` のまま更新されず、[L174-L190](file:///src/renderer/App.tsx#L174-L190) の `{settings && tab === 'general' && ...}` という条件判定により画面の中身（メインパネル）が一切描画されず空白になります。また [src/preload/index.ts#L128](file:///src/preload/index.ts#L128) の `getSettings` に `unwrap()` が適用されていないため、Main 側がエラーオブジェクト `{ ok: false, error: ... }` を返した際に例外として正しく拒否されず不正な型が State に代入されます。
* **根拠**: 
  * `App()` コンポーネント内の取得ロジック：[src/renderer/App.tsx#L49-L52](file:///src/renderer/App.tsx#L49-L52)
  * メイン表示領域の条件付きレンダリング：[src/renderer/App.tsx#L174-L190](file:///src/renderer/App.tsx#L174-L190)
  * Preload 側の API 定義：[src/preload/index.ts#L128](file:///src/preload/index.ts#L128)
* **具体的な修正案**: 
  1. `src/preload/index.ts` の `getSettings` に `unwrap()` を適用し、メインプロセスの拒否応答を適切な Promise Rejection に変換します。
  2. `App.tsx` で `getSettings()` に `.catch()` を接続し、取得失敗時のデフォルト設定フォールバックまたはエラー画面の描画処理を追加します。

---

### 4. 【注入成功の偽装】`portalSidecar.ts` における Sidecar 失敗レスポンスの流下・脱落
* **原因仮説**: 
  [src/main/linux/portalSidecar.ts](file:///src/main/linux/portalSidecar.ts#L448-L487) の `pasteText()` 関数において、L457 の `if (!r.ok)` ブロックで `debug(...)` ログを出力した後に `return` して処理を中断していません。Python Sidecar 側から `no post-injection selection read was observed` などのエラーレスポンス（`r.ok = false`, `r.uncertain = false`）が返された際、処理がそのまま L469 以降に流下し、`injected` や `selectionRead` のフラグ算出を経て上位呼び出し元へ成功状態、あるいは不整合なオブジェクトを返却してしまいます。
* **根拠**: 
  * `pasteText()`：[src/main/linux/portalSidecar.ts#L448-L487](file:///src/main/linux/portalSidecar.ts#L448-L487) （特に L457-L468）
* **具体的な修正案**: 
  `pasteText()` 内の [L457](file:///src/main/linux/portalSidecar.ts#L457) において、`if (!r.ok)` の時点で即座に `{ ok: false, claimed: r.claimed === true, injected: r.injected === true, selectionRead: false, restored: false, error: r.error }` を `return` して戻り値を確定させるよう修正します。

---

UIRV6

## agy-ui-7.md
^DElectron / Linux (Ubuntu 24.04 GNOME 46 Wayland) 環境における **WindVoice** の不具合解析報告です。

ご提示いただいたログおよびソースコード（`src/main/index.ts`, `src/main/linux/portalSidecar.ts`, `src/main/linux/statusNotifier.ts`, `src/renderer/App.tsx` 等）を分析した結果、発生している4症状の原因仮説と具体的な修正案をまとめました。

---

### 【最重要観点】症状④：「no post-injection selection read was observed」を検知しながら上位がok=trueにする伝達経路の欠陥（戻り値設計の不備）

#### 原因仮説
1. **エラーメッセージの脱落（`portalSidecar.ts` の戻り値構造）**  
   Python sidecar は貼り付け後の選択領域読み取り失敗時に `{ "ok": true, "injected": true, "selectionRead": false, "message": "no post-injection selection read was observed" }` を返します。しかし、`PortalSidecar.pasteText()`（`portalSidecar.ts` L380）では `r.error` のみを伝達処理しており（`...(r.error ? { error: r.error } : {})`）、Python側がセットした `r.message` が無視され、`PortalPasteResult.error` が `undefined` になります。
2. **上位レイヤー（`typer.ts` 等）での判定欠陥**  
   `PortalSidecar.pasteText()` 内で `ok` は `injected === true && selectionRead` (＝`false`) と計算されますが、`error` プロパティが存在しない（`undefined`）ため、上位の貼り付け処理（`typer.ts` / `orchestrator.ts`）が `result.injected` または `!result.error` のみを参照して「注入自体は成功した」と判定し、最終的な上位戻り値を `ok = true` として扱ってしまっています。

#### 根拠（対象箇所）
- **`src/main/linux/portalSidecar.ts`**
  - `SidecarReply` / `PortalPasteResult` インターフェース定義（L20–L72）
  - `PortalSidecar.pasteText()` 関数（L338–L382）

#### 具体的修正案
`portalSidecar.ts` の `pasteText()` において、`selectionRead` が `false` の場合や `r.message` が存在する場合に確実に `error` フィールドへ理由を格納するように修正し、上位レイヤーでも `result.ok === true`（`selectionRead` 含む）を必須条件とします。

```typescript
// src/main/linux/portalSidecar.ts (L370-L381 付近)
const errorMsg = r.error ?? r.message ?? (!selectionRead ? 'no post-injection selection read was observed' : undefined);

return {
  ok: injected === true && selectionRead,
  claimed: r.claimed === true,
  injected,
  selectionRead,
  restored: r.restored === true,
  ...(sessionReset ? { sessionReset: true } : {}),
  ...(sessionRecyclePending ? { sessionRecyclePending: true } : {}),
  ...(r.stage ? { stage: r.stage } : {}),
  ...(errorMsg ? { error: errorMsg } : {})
};
```

---

### 原因仮説と具体的修正案（最大4件）

#### 1. 症状④：貼り付け成功の偽認（前述の伝達経路欠陥）
- **根拠**: `src/main/linux/portalSidecar.ts` 内 `PortalSidecar.pasteText()`（L338–L382）
- **原因仮説**: `portal-remote.py` から `message: "no post-injection selection read was observed"` が返却された際、`pasteText()` が `r.message` を `PortalPasteResult.error` にマッピングせず落とすため、上位レイヤーが `error: undefined` かつ `injected: true` を受けて `ok = true` と誤認・報告する。
- **具体的修正案**: `pasteText()` の戻り値オブジェクト生成時に `r.message` および `selectionRead === false` の際のエラー文字列を `error` プロパティへ強制セットする。

#### 2. 症状③：設定UIの中身が空白になる
- **根拠**: `src/main/index.ts`（L348 `ensureStatusNotifierWatcher`, L398 `registerIpc`）および `src/renderer/App.tsx`（L37–L45）
- **原因仮説**: 
  - Ubuntu 24.04 Wayland (GNOME 46) では D-Bus 上に `org.kde.StatusNotifierWatcher` が存在しないため、`ensureStatusNotifierWatcher`（L348）が `openSettings()` を即座に呼び出します。
  - しかし、この時点では `registerIpc()`（L398）がまだ実行されていません。
  - レンダラー（`App.tsx` L37）が起動時に `ipcRenderer.invoke('settings:get')` を呼ぶと、Main 側で `"No handler registered for 'settings:get'"` エラーが発生して Promise が reject されます。
  - `App.tsx` 側に `.catch()` がないため `settings` ステートが `null` のままとなり、`General` や `Hotkeys` 等のページ描画条件 `{settings && ...}` が満たされずUI中身が空白になります。
- **具体的修正案**: `src/main/index.ts` の `app.whenReady()` 内で、`ensureStatusNotifierWatcher` や `createTray` を呼び出す**前**（L345付近）に `registerIpc(...)` を実行するよう順序を変更します。また、`App.tsx` の `getSettings()` 呼び出しに `.catch()` ハンドラを追加します。

#### 3. 症状②：設定ウィンドウが GNOME ウィンドウ一覧に表示されない
- **根拠**: `src/main/index.ts` 内 `createSettingsWindow()`（L111–L149）
- **原因仮説**: 
  - `createSettingsWindow()` は `show: false` で BrowserWindow を生成し、`ready-to-show` イベントで `win.show()` します。
  - IPC 未登録の状態で初期化が行われた際、レンダラー側のスクリプトエラーや IPC 拒否により描画完了イベント（`ready-to-show`）が正常に発火しないか遅延し、GNOME Wayland のコンポジタにウィンドウがマッピングされないまま非表示状態で維持されます（ログの `bs false ""`）。
- **具体的修正案**: 順序変更（IPC初期化の先行）によりレンダラーのロード失敗を防ぐとともに、`win.loadFile()` 完了後またはタイムアウト付きのフォールバックで明示的に `win.show()` / `win.focus()` を呼び出す安全策を実装します。

#### 4. 症状①：起動後数分でプロセスが消失する
- **根拠**: `src/main/index.ts`（L469–L501 `evdevMonitor` 設定箇所）、`src/main/linux/portalSidecar.ts`（L161, L227）
- **原因仮説**: 
  - ログによると起動約2分後に `[dictation] portal sidecar exited (null)` が発生しています。
  - Wayland / GNOME の RemoteDesktop セッションがタイムアウト等で切断された際、`evdevMonitor` や sidecar のストリームから Node.js の `EventEmitter` に `error` イベントが伝播します。
  - `src/main/index.ts` L469 付近で `evdevMonitor` に対し `'key'`, `'permission-denied'`, `'ready'`, `'unavailable'` のリスナーは登録されていますが、**`'error'` イベントリスナーが登録されていません**。Node.js の仕様上、Unhandled `'error'` イベントが発生すると Electron メインプロセス全体がサイレントにクラッシュ・終了します。
- **具体的修正案**: `src/main/index.ts` にて `evdevMonitor` に `'error'` リスナーを追加し、プロセス落下の原因となる未ハンドルのエラー例外を防止します。

```typescript
// src/main/index.ts (L469 付近)
evdevMonitor = new EvdevKeyboardMonitor();
evdevMonitor.on('error', (err) => {
  debug('HOTKEY', `evdev monitor error: ${err instanceof Error ? err.message : String(err)}`);
});
```

---

UIRV7

## agy-ui-8.md
^DElectron/Linux(Ubuntu 24.04 GNOME 46 Wayland)環境における WindVoice の動作ログおよびソースコードの解析結果をご報告いたします。

---

### 原因仮説と具体的修正案（最大4件）

#### 1. 【プロセス消失と portal sidecar exited(null) の因果関係】
* **分析・原因仮説**:
  * **主因（Portalセッションのタイムアウト/切断）**: Log上、起動直後 (02:28:01) に ready となってから約1分56秒後 (02:29:57) に `portal sidecar exited (null)` が発生しています。GNOME 46 Wayland (mutter) は無通信状態の `org.freedesktop.portal.RemoteDesktop` D-Bus セッションを一定時間で自動閉鎖するため、`portal-remote.py` がシグナル（SIGTERM/SIGSEGV）で終了させられています。
  * **プロセス消失のメカニズム**: `portalSidecar.ts` の `onExit()` (L235) から `teardownChild()` (L208) が呼ばれ、`rejectAllPending()` (L254) により保留中の Promise が拒否されます。Main プロセス側（`src/main/index.ts`）に `process.on('uncaughtException')` ハンドラが存在しないため、非同期エラーや連鎖的なストリーム破壊（`evdevMonitor` の切断等）が発生した際に Electron Main プロセス全体がクラッシュ・消失します。また、Main プロセスのクラッシュ時にも `app.on('before-quit')` (L480) 内で `portalSidecar.stop()` -> `child.kill()` が走るため、`portal sidecar exited (null)` がプロセス消滅直前の最後のログとして記録されます。
* **根拠**:
  * `src/main/linux/portalSidecar.ts`: `onExit()` (L235), `teardownChild()` (L208), `rejectAllPending()` (L254), `scheduleRestart()` (L249)
  * `src/main/index.ts`: `app.on('before-quit')` (L480-L519), `uncaughtException` ハンドラの欠落
* **具体的修正案**:
  1. `portal-remote.py` / `portalSidecar.ts` に Keep-Alive ping メカニズムを実装し、GNOME RemoteDesktop セッションの無通信タイムアウトを防止する。
  2. `src/main/index.ts` に `process.on('uncaughtException', ...)` を追加し、Sidecar 終了時や入力デバイス切断時の大域エラーによるメインプロセス無告死を抑止する。

---

#### 2. 【設定ウィンドウがウィンドウ一覧に不在 (bs false "")】
* **分析・原因仮説**:
  * WindVoice はトレイ常駐型の設計となっています。`src/main/index.ts` 内の `createSettingsWindow()` (L125) は、起動時の `ensureApiKey()` (L200) で API キーが未設定の場合、またはトレイメニュー等の明確なユーザー操作・エラー発生時のみ呼び出されます。
  * すでに `secureStore.hasApiKey()` が `true` を返し、かつトレイウォッチャーが機能している場合、起動時に BrowserWindow が生成されず `settingsWindow = null` のまま動作するため、GNOME のウィンドウ一覧 (`bs false ""`) に表示されないのは設計通りの正常な挙動です。
* **根拠**:
  * `src/main/index.ts`: `createSettingsWindow()` (L125-L165), `ensureApiKey()` (L200-L215), `app.whenReady()` (L234-L473)
* **具体的修正案**:
  * 設計上正常ですが、トレイ非表示環境（SNI 非対応環境）や CLI 起動時に自動で設定ウィンドウを可視化したい場合は、`app.whenReady()` 内で明示的に `createSettingsWindow()` を呼び出す条件分岐を追加する。

---

#### 3. 【設定UIを開いた際の中身が空白】
* **分析・原因仮説**:
  * `src/renderer/App.tsx` において、`settings` の初期状態は `null` です (L26)。`useEffect` (L31) 内で `window.windvoice.getSettings()` を呼び出していますが、`.catch()` による失敗時のリカバリ処理が記述されていません。
  * Preload (`src/preload/index.ts` L28 `unwrap()`) や Main プロセス側の IPC ハンドラ検証で拒否・タイムアウトが発生した場合、`setSettings` が実行されず `settings` が `null` のまま保持されます。`App.tsx` のレンダリングロジックが `{settings && tab === 'general' && ...}` (L176) となっているため、画面中央が完全に空白（描画コンポーネントなし）になります。
* **根拠**:
  * `src/renderer/App.tsx`: `useState<Settings | null>(null)` (L26), `useEffect` (L31-L68), 条件付きレンダリング (L176-L191)
  * `src/preload/index.ts`: `unwrap()` (L28-L34), `getSettings` (L78)
* **具体的修正案**:
  * `App.tsx` の `getSettings()` 呼び出しに `.catch()` を追加し、`settings === null` または取得エラー発生時にローディング表示およびエラーリトライ用 UI を表示するフォールバック処理を実装する。

---

#### 4. 【注入成功と偽る現象 (no post-injection selection read was observed -> 上位 ok=true)】
* **分析・原因仮説**:
  * `src/main/linux/portalSidecar.ts` の `pasteText()` は、最終的な戻り値として `ok: injected === true && selectionRead` (L379) を返しています。
  * `selectionRead` が `false` の場合、Sidecar 自体は `ok: false` および `sessionRecyclePending: true` (L370) を返しますが、呼び出し元である `src/main/inject/typer.ts`（または Orchestrator 側）が `result.injected === true` のみを確認して `PortalPasteResult.ok` を無視しているか、戻り値を上書きして上位層へ `ok: true` を報告しているため、選択読み出し未確認時でも全体処理が「成功」と誤判定されます。
* **根拠**:
  * `src/main/linux/portalSidecar.ts`: `pasteText()` (L341-L390, 特に L370, L379)
  * `src/main/inject/typer.ts`: `pasteText` 内の Sidecar 戻り値評価ロジック
* **具体的修正案**:
  * `typer.ts` 側の判定ロジックを修正し、`PortalPasteResult.ok` (即ち `injected && selectionRead`) が `true` でない場合は厳格に貼り付け失敗（または未検証警告）として処理し、上位へ `ok: false` を伝播させる。

---

UIRV8

