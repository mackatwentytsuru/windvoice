# agy 19隊レビュー(Linux注入バグ)
## agy-lx-1.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) 環境で動作する Electron 製音声入力アプリ **WindVoice** のバグ調査報告書です。

報告された症状（①Claudeアプリで成功 → ②ターミナルで不発 → ③Claudeアプリに戻っても不発、ログは `ok=true injected=true`）に基づき、コードベースから特定された原因仮説と修正案を以下にまとめます。

---

### 原因仮説と修正案（全4件）

#### 1. ターミナルアプリにおけるペーストショートカットの不一致 (`Ctrl+V` vs `Ctrl+Shift+V`)
- **原因仮説**:
  Claudeデスクトップアプリ等の一般的なGUIアプリは `Ctrl+V` でクリップボードからの貼り付けを行いますが、Linux (Ubuntu/GNOME) のターミナルエミュレータ（GNOME Terminal, Ptyxis, Alacritty, Konsole 等）では標準のペーストキーが **`Ctrl+Shift+V`**（または `Shift+Insert`）です。
  ターミナルに対して `Ctrl+V` が送信されると、Terminal 側はペーストとして処理せず、`^V` (readline の `quoted-insert` / 次の文字をリテラル入力する状態) として受け取ります。そのためターミナルにテキストが一切挿入されず、かつターミナルのシェルが `^V` 待機モードに入るため入力状態が壊れます。
- **根拠 (ファイル・行の引用)**:
  - [`src/main/inject/pasteWin32.ts:L65-L72`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/inject/pasteWin32.ts#L65-L72)
    ```typescript
    if (process.platform !== 'win32') {
      // Linux: no menu-mode quirk, use Ctrl+V.
      uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
      return;
    }
    ```
  - [`src/main/linux/portalSidecar.ts:L368-L380`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/linux/portalSidecar.ts#L368-L380) (`pasteText` 経由で Python サイドカー `portal-remote.py` が `Ctrl+V` 仮想キーを送信)
- **修正案**:
  アクティブウィンドウのクラス名やプロセス名（`activeWindowApp`）を取得し、ターミナル系アプリ（`gnome-terminal`, `ptyxis`, `alacritty`, `konsole`, `xterm` 等）の場合は `Ctrl+Shift+V` を合成して送信するように処理を分岐する。

---

#### 2. Wayland クリップボード復元 (`restoreDelayMs`) とターゲットアプリの読み込みタイミングの競合
- **原因仮説**:
  `portalSidecar.pasteText` は、①Waylandセレクションの所有権取得 → ②`Ctrl+V` 送信 → ③`restoreDelayMs` (1500ms) 待機 → ④元のクリップボードの復元、という手順を辿ります。
  Wayland (GNOME 46) ではコンポジタ・D-Bus・XWayland セレクション同期ブリッジを経由するためクリップボード要求に遅延が生じやすく、ターミナル操作後やウィンドウ切り替え直後にターゲットアプリが `Ctrl+V` を受信して実際にクリップボードのデータを要求するまでに 1.5 秒以上かかった場合、アプリがデータにアクセスする前に `portal-remote.py` が元のクリップボード（または空状態）に復元してしまいます。
  ターゲットアプリは復元後のクリップボードを読み込むため何も貼り付けられず、一方サイドカー側はD-Bus処理が正常完了しているため `ok=true injected=true restored=true` と成功ログを出力します。
- **根拠 (ファイル・行の引用)**:
  - [`src/main/inject/pasteTiming.ts:L58-L72`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/inject/pasteTiming.ts#L58-L72)
    ```typescript
    const WAYLAND_MIN: PasteTiming = {
      settleMs: 60,
      restoreDelayMs: 1500,
      ...
    };
    ```
  - [`src/main/inject/typer.ts:L224-L235`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/inject/typer.ts#L224-L235)
- **修正案**:
  Wayland 環境における `restoreDelayMs` の数値を延長できるように調整するか、またはクリップボード復元処理のタイミングをアプリからの読取検知後に遅延させるオプションを設ける。

---

#### 3. ウィンドウ切り替え (`Alt+Tab` 等) に伴う HotkeyManager / evdev の修飾キー (Alt / Super) 押下状態の固着
- **原因仮説**:
  Claudeアプリからターミナルへ移動する際（`Alt+Tab` や `Super` キー等の操作）、`evdev` で `Alt` や `Super` の `keydown` が記録された後、GNOMEコンポジタのフォーカス遷移やグラブの影響で `keyup`（キーを離す）イベントの捕捉が漏れる場合があります。
  これにより `HotkeyManager` 内で `modifierState.alt` または `meta` が `true` のまま固着します。
  次に音声入力を実行した際、`untilAllModifiersUp(600)` が 600ms タイムアウトした後にペーストが強行されますが、OS/コンポジタ側で `Alt` や `Super` が押されたまま判定されるため、送信された `Ctrl+V` は **`Alt+Ctrl+V`** や **`Super+Ctrl+V`** に化けてアプリに届きます。
  アプリはこの修飾キー付きショートカットをペーストとして処理しないため無視され、Claudeアプリに戻った後も同様にペーストが不発し続けます。
- **根拠 (ファイル・行の引用)**:
  - [`src/main/hotkey/manager.ts:L242-L260`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/hotkey/manager.ts#L242-L260) (`untilAllModifiersUp` のタイムアウト処理)
    ```typescript
    untilAllModifiersUp(timeoutMs = 600): Promise<void> {
      if (!this.isAnyModifierHeld()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        ...
        const timer = setTimeout(() => {
          debug('HOTKEY', `untilAllModifiersUp: timed out after ${timeoutMs}ms`);
          this.recordModifierTimeout();
          finish();
        }, timeoutMs);
    ```
  - [`src/main/hotkey/evdev.ts:L276-L296`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/hotkey/evdev.ts#L276-L296) (`onKeyEvent` でのキー状態更新)
- **修正案**:
  ペースト実行前（`portal-remote.py` 側）に全修飾キー (Alt, Super, Shift, Ctrl) の KeyUp イベントを明示的に挟んでクリアするか、ペースト直前またはフォーカス移動時に `HotkeyManager.resetState()` を呼び出して修飾キーの固着状態を解除する。

---

#### 4. D-Busポータル層の成功判定 (`injected=true`) と実アプリ到達の判定離解・フォールバック不全
- **原因仮説**:
  `typer.ts` や `portalSidecar.ts` は、ポータルサイドカーとの D-Bus 通信（`op: 'paste'`）が正常完了すると `injected=true` を返します。
  しかし、この `injected=true` は「ポータルに対して仮想キーイベントを正常に発行できた」ことのみを示しており、「対象ウインドウがキーを受信し、実際に貼り付けに成功した」ことの保証ではありません。
  ターミナルでのショートカットミスマッチや修飾キーの固着によってペーストが失敗しても、システム上は成功扱い（`injected=true`）とされるため、失敗時の手動ペースト用フォールバック（`copyTextForManualPaste`）やユーザー通知（`notifyPasteFailed`）が起動せず、サイレントに文字消失が発生します。
- **根拠 (ファイル・行の引用)**:
  - [`src/main/inject/typer.ts:L236-L248`](file:///Users/yukitsuruoka/.gemini/antigravity-cli/brain/2ee05b08-a589-4b4c-9992-a03c90e709ce/src/main/inject/typer.ts#L236-L248)
    ```typescript
    if (result.injected === true) {
      // Injection is the delivery boundary. A later restore failure must
      // never cause a second paste of the same transcript.
      if (restoreClipboard && !result.restored && result.stage === 'restore') {
        notifyPasteFailed(`Wayland clipboard restore failed: ${result.error ?? 'unknown error'}`);
      }
      return;
    }
    ```
- **修正案**:
  `untilAllModifiersUp` がタイムアウトした場合やターミナル系アプリへの注入時など、自動ペーストの不発が予想される条件では、文字をクリップボードに残して手動ペースト用の案内を出すフォールバック処理を強化する。

---

RVDONE1

## agy-lx-10.md
^Dご提示いただいたログおよびソースコードを分析し、**【ログ改善提案: 注入の実受領を検証する方法（クリップボード残留確認・フォーカスアプリ記録）】**の観点に沿って、原因仮説および修正案を以下4件にまとめました。

---

### ① フォーカスアプリ（アクティブウィンドウ）記録の欠如とターミナル固有ショートカット不一致

* **原因仮説:**
  入力対象が Claude デスクトップアプリからターミナルへ切り替わった際、ターミナル側は `Ctrl+V` を標準の貼り付けとして受け付けず（`Ctrl+Shift+V` を要求する等の理由により）入力を無視した可能性が高いです。しかし現在のログにはどのアプリに対してペーストを実行したかの記録（フォーカスアプリ記録）が存在しないため、全件一律の `Ctrl+V` 送信で失敗していることが隠蔽されています。
* **根拠:**
  * [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L345): `const active = await getActiveWindow();` でアクティブウィンドウ情報を取得していますが、この情報が `pasteText` やペースト実行ログに伝搬されていません。
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L189-L197): `debug('DICTATION', 'wayland paste: sidecar path (len=... restore=...)')` のログ出力項目にターゲットアプリ名 (`active.app` / `active.title`) が含まれていません。
* **修正案 (ログ改善含む):**
  * `typer.ts` の `pasteText` 引数に `activeApp` 情報を追加し、ペーストログに `targetApp=${activeApp}` を出力してフォーカスアプリを記録・可視化します。
  * ターゲットアプリがターミナルの場合は `Ctrl+Shift+V` を選択送信するか、あるいは端末向け設定に分岐するロジックを追加します。

---

### ② 仮想キー送信 (`injected=true`) とアプリ側の実受領 (`selectionRead`) の乖離

* **原因仮説:**
  アプリログの `injected=true` は Wayland ポータル（`org.freedesktop.portal.RemoteDesktop`）の仮想キーボードへ `Ctrl+V` イベントを投入できたことのみを示しており、受領側のアプリ（ターミナル等）が実際にフォーカスを持ってキーを受け取り、クリップボード（Selection）を取得したことまでは検証できていません。
* **根拠:**
  * [`src/main/linux/portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L350-L379): `pasteText()` 内で DBus / Portal からの応答 `r.injected === true` をもって `injected = true` および `ok = true` と判定して返却しています。
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L196-L200): `result.injected === true` でペースト成功と判定して `wayland paste: sidecar result ok=true injected=true` と出力しています。
* **修正案 (ログ改善含む):**
  * Sidecar（`portal-remote.py` / `portalSidecar.ts`）側で、Selection 所有権要求のあとにターゲットアプリからのクリップボードデータ読み取りリクエスト（Selection Transfer / Read）が発生したかを追跡するイベントフラグを追加します。
  * `typer.ts` のログ出力を `ok=true injected=true selectionRead=true/false` に改善し、アプリによる実際の受け渡し（実受領）が行われたかを判定できるようにします。

---

### ③ 1.5秒後のクリップボード復元によるテキスト消去と Selection 状態の残留確認不足

* **原因仮説:**
  Wayland 環境ではペースト後 `restoreDelayMs` (1500ms) 経過すると自動的に元のクリップボードへ復元されます。ターミナル等でペーストが実行されなかった場合、1.5秒後に音声入力テキストがクリップボードから消去され元の値に上書きされます。これにより「未消費の音声テキストが消滅」し、その後の Claude アプリへの入力復帰時にも古いクリップボード値が残留・復元され続けてペースト不能状態に陥った可能性があります。
* **根拠:**
  * [`src/main/inject/pasteTiming.ts`](file:///src/main/inject/pasteTiming.ts#L71-L85): `WAYLAND_MIN` 設定で `restoreDelayMs: 1500` が強制適用されます。
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L183-L208): 1.5秒待機後に `portalSidecar.setSelection(old.text)` で復元を行いますが、復元直前に「現在の Selection に Dictation テキストが未読のまま残っているか」の判定（クリップボード残留確認）を行っていません。
* **修正案 (ログ改善含む):**
  * クリップボード復元（`restore`）の直前に、現在の Selection 状態をスナップショットチェックし、未受領のまま残っているかを確認・ログ出力します（例: `retainedUnread=true`）。
  * 未受領のまま残っていた場合は復元処理を中断し、クリップボードにテキストを残留させるか手動ペースト通知を発行する安全装置を追加します。

---

### ④ ターミナル操作時のモディファイアキー（Ctrl/Alt等）状態の不整合残留

* **原因仮説:**
  ターミナル操作時やフォーカス切替時に物理 hotkey（例: Right Alt や Ctrl）の解放イベント（`keyup`）を取りこぼすか、あるいは合成キー送信のタイミングと重なることで `HotkeyManager` 内の `modifierState` が stuck 状態になった可能性があります。その結果、`untilAllModifiersUp` がタイムアウトし、以降の Dictation（Claude アプリに戻った後含む）でも不要な修飾キーが混入してペーストが一切機能しなくなりました。
* **根拠:**
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L185-L187): ペースト実行直前に `hkmW.untilAllModifiersUp(600)` および `hkmW?.suppressFor(40)` を実行しています。
  * [`src/main/hotkey/manager.ts`](file:///src/main/hotkey/manager.ts#L220-L240): 修飾キーが解除されない場合 `untilAllModifiersUp` がタイムアウトしますが、このタイムアウト状態や現在の修飾キー状態が `pasteText` 成功/失敗ログに記録されていません。
* **修正案 (ログ改善含む):**
  * `pasteText` 開始時のログに現在の修飾キー保持状態（`modifiers={ctrl, alt, shift, meta}`）と `untilAllModifiersUp` のタイムアウト有無を出力します。
  * タイムアウト検知時またはインジェクション失敗時には `hkmW.resetState()` を呼び出して内部の修飾キー状態を自動リカバリ（リセット）します。

---

RVDONE10

## agy-lx-2.md
^Dご提示いただいたログおよびソースコードを精査し、指定された観点（**Waylandペースト注入の対象アプリ依存性**、および **`ok=true injected=true` の成功誤報告の検出可能性**）に沿ってバグの原因仮説と修正案をまとめました。

---

### バグ調査報告書

#### 1. ターゲットアプリのショートカット依存性（端末アプリへの `Ctrl+V` 送信によるペースト失敗と TTY 状態汚染）
* **原因詳細**:
  Ubuntu 24.04 (GNOME/Wayland) 上の多くのターミナルエミュレータ（`gnome-terminal`, `ptyxis`, `alacritty`, `kitty`, `konsole` 等）は、貼り付けキーとして `Ctrl+Shift+V` または `Shift+Insert` を要求します。`Ctrl+V` は TTY の LNEXT (Literal Next / `^V`) 制御文字として解釈され、クリップボードの貼り付け処理が起動しません。
  そのため、②のターミナル入力時に `Ctrl+V` が送信されても文字は入力されず、ターミナル TTY が「次の1文字を特殊文字として直入力する待機状態（LNEXTモード）」に移行します。この状態でユーザーが操作したりフォーカスを移動したりすると、後続のキー入力やフォーカス切り替え時のモディファイア状態が正常に処理されなくなり、③の Claude アプリ復帰後も入力不能に陥ります。
* **根拠**:
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L196-L209): `pasteText()` で Wayland セッション時、アクティブアプリの種類に関わらず一律で `portalSidecar.pasteText()` を呼び出しています。
  * [`src/main/inject/paste.ts`](file:///src/main/inject/paste.ts#L18-L28): `sendPasteKeystroke` / `sendCtrlVAtomic` も `Ctrl+V` 固定となっています。
  * [`src/main/dictation/orchestrator.ts`](file:///src/main/dictation/orchestrator.ts#L389): `getActiveWindow()` で `active?.app` を取得しているものの、`pasteText()` へアプリ種別（端末か GUI アプリか）が渡されていません。
* **修正案**:
  `orchestrator.ts` から `activeWindowApp` （例: `gnome-terminal`, `ptyxis`, `konsole`, `alacritty`, `kitty` 等）を `pasteText()` / `portalSidecar` へ伝播させ、アクティブウィンドウが端末アプリであると判定された場合は `Ctrl+Shift+V` (または `Shift+Insert`) を合成・送信する分岐を追加します。

---

#### 2. ポータル側仮想キー送信の成功誤報告（`ok=true injected=true` の検証欠如）
* **原因詳細**:
  `portalSidecar.pasteText()` が返す `injected=true` / `ok=true` は、「XDG RemoteDesktop Portal D-Bus API (`NotifyKeyboardKeycode`) 経由で Wayland コンポジタへ `Ctrl+V` キーイベントを発行できたこと」のみを意味します。
  対象アプリが `Ctrl+V` キーイベントを受けて実際に Wayland セレクト（`wl_data_offer::receive`）のデータ読み出しを行ったか（実際のペースト消費）を検証するフィードバック機構が存在しないため、ターミナル等で `Ctrl+V` が無視・無効化されてもログ上は「成功」と誤報告されます。
* **根拠**:
  * [`src/main/linux/portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L270-L295): `pasteText` メソッド内で `const injected = r.injected === true;` により、D-Bus インジェクション要求が通った時点で `ok: true` として扱っています。
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L205-L212): `result.injected === true` をもって成功とみなしています。
* **修正案**:
  `portal-remote.py` (Python サイドカー) 側で `set_selection` により Wayland セレクトデータソース（`wl_data_source`）を提供した後、`settleMs` 期間内にターゲットアプリからデータ送信リクエスト（`selection_send` イベント / fd 読み出し）が発生したかを監視します。リクエストが発生しなかった場合はペースト未消費（`injected=false` または `consumed=false`）と判定し、クリップボード復元を抑制した上でユーザーに手動ペースト案内のエラー通知を出せるようにします。

---

#### 3. `evdev` 監視による仮想キー捕捉と `untilAllModifiersUp` のタイムアウト・キー状態スタック
* **原因詳細**:
  Wayland 環境ではグローバルキー監視のために `EvdevKeyboardMonitor` (`/dev/input/event*`) を使用しています。ポータルサイドカーが Virtual Keyboard 経由で合成 `Ctrl+V` を注入した際、カーネルの `/dev/input/` に作成された仮想キーボードデバイスの `Ctrl-down` / `Ctrl-up` を `evdev` も検知します。
  ターミナル等でペースト失敗が起きた際のフォーカス切替やキーリリースのタイミングによって仮想 `Ctrl` の keyup イベントを取りこぼすと、`HotkeyManager` 内の `modifierState.ctrl` が `true` のままスタックします。
  `modifierState.ctrl` がスタックすると、`typer.ts` 内の `await hkmW.untilAllModifiersUp(600)` が毎回 600ms タイムアウトし、さらに OS 側で Ctrl が押され続けていると誤判定されるため、③で Claude アプリに戻った後もキー入力やショートカット判定が狂い、ペーストが入らなくなります。
* **根拠**:
  * [`src/main/hotkey/evdev.ts`](file:///src/main/hotkey/evdev.ts#L240-L260): `/dev/input/event*` から `EV_KEY` を読み取り `heldByDevice`・`currentModifiers` を更新しています。
  * [`src/main/hotkey/manager.ts`](file:///src/main/hotkey/manager.ts#L1270-L1300): `untilAllModifiersUp` で `isAnyModifierHeld()` が `true` の場合、タイムアウトまで待機します。
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L198): `if (hkmW) await hkmW.untilAllModifiersUp(600);` で待機を実施しています。
* **修正案**:
  ポータルサイドカーによるペースト注入時、`evdev` 監視側でポータル由来の仮想デバイスからのモディファイアイベントを除外するか、`pasteText` 処理の完了後に `hkmW.resetState()` を呼び出してモディファイアのスタック状態をクリアします。

---

#### 4. Wayland クリップボード復元（`restoreDelayMs=1500ms`）とセレクト所有権の非同期競合
* **原因詳細**:
  Wayland 環境の `WAYLAND_MIN.restoreDelayMs` は 1500ms に設定されています。
  ②のターミナル入力時、`Ctrl+V` でペーストされなかったテキストが Wayland セレクト上に 1.5 秒間保持された後、サイドカーが以前のクリップボード内容（`old_text`）への自動復元を行います。
  ターミナルがセレクトを消費していない状態で 1.5 秒後に復元が動くと、コンポジタ側のセレクト所有権ハンドシェイクが不安定になるか、あるいは `old_text` の復元要求が拒否される場合があります。その直後（1.5 秒以内）に③の Claude アプリへフォーカスを移して連続入力を行おうとすると、前回の 1500ms 復元処理（D-Bus 非同期トランザクション）が完了していないため、次の `pasteText` リクエストがサイドカー側でタイムアウトまたは拒否され、文字が入らなくなります。
* **根拠**:
  * [`src/main/inject/pasteTiming.ts`](file:///src/main/inject/pasteTiming.ts#L67-L73): `WAYLAND_MIN.restoreDelayMs` が `1500` ms と長めに設定されています。
  * [`src/main/inject/typer.ts`](file:///src/main/inject/typer.ts#L200): `timing.restoreDelayMs` をそのまま `portalSidecar.pasteText()` に渡しています。
  * [`src/main/linux/portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L390-L415): `pasteText` のタイムアウト計算 `budget = settleMs + restoreMs + 15_000` および D-Bus リクエストのキューイング管理。
* **修正案**:
  ペースト処理が連続で発生した場合や未消費の場合、先行する 1500ms のセレクト復元タイマーをキャンセル可能にし、新しいペースト要求が即座に Wayland セレクト所有権を上書き更新できるようにサイドカーのキューおよびキャンセル処理を改善します。

---

RVDONE2

## agy-lx-3.md
^Dご提示いただいたログおよびソースコードを分析した結果、Linux (Ubuntu 24.04 / GNOME / Wayland) 上で動作する Electron 製音声入力アプリ WindVoice において、①Claude アプリでは入力成功 → ②GNOME 端末に入力不可 → ③その後 Claude アプリでも入力不可 となる不具合の原因仮説と修正案をまとめました。

---

### 【原因仮説と修正案（最大4件）】

#### 原因仮説 1: 端末アプリ固有のショートカットキー不一致（`Ctrl+V` vs `Ctrl+Shift+V`）と `quoted-insert` 状態の発生
* **メカニズム**: 
  GNOME Terminal や Ptyxis などの VTE（Virtual Terminal Emulator）系端末アプリでは、標準の貼り付けショートカットは `Ctrl + Shift + V`（または `Shift + Insert`）であり、`Ctrl + V` は端末シェル（bash/zsh/readline）で `quoted-insert`（次に押すキーのエスケープ入力モード）または制御文字 `^V` (`0x16`) として処理されます。
  1. Claude アプリ（①）では `Ctrl + V` で正しく貼り付けられます。
  2. 端末アプリ（②）へフォーカスがある状態で `portal-remote.py` が `RemoteDesktop` ポータル経由で `Ctrl + V` を注入すると、端末は貼り付け（クリップボード要求 `wl_data_offer.receive`）を行わず、`quoted-insert` モードへ遷移して入力を無視します。
  3. ポータルサイドカーは `settleMs` (60ms) 待機後にキーを注入し、`restoreDelayMs` (1500ms) 経過後にクリップボードを元に戻すため、サイドカーログ上は `ok=true injected=true restored=true` と成功記録されますが、端末側には一切入力されません。
  4. さらに端末が `quoted-insert` 状態のまま残ることで、その後のキー入力受付が不正な状態になります。
* **根拠（ファイル・行）**:
  * [pasteWin32.ts](file:///src/main/inject/pasteWin32.ts#L115-L127) (`src/main/inject/pasteWin32.ts` L115-L127): Linux 環境において `uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl])`（`Ctrl+V`）が固定で呼び出されており、端末アプリ向けの `Ctrl+Shift+V` 切り替えロジックが存在しない。
  * [pasteTiming.ts](file:///src/main/inject/pasteTiming.ts#L63-L80) (`src/main/inject/pasteTiming.ts` L63-L80): `WAYLAND_MIN.restoreDelayMs` が `1500` ms に設定されており、端末が `Ctrl+V` に反応してクリップボードを読み取る前にタイムアウトして元に戻るため、ログ上は `injected=true restored=true` となる。
* **修正案**:
  アクティブウィンドウ情報 (`getActiveWindow()`) を取得し、対象が端末系アプリ（`gnome-terminal`, `ptyxis`, `konsole`, `alacritty` 等）の場合は `Ctrl + Shift + V` を合成・送信するように `portal-remote.py` および `paste.ts` のキー注入処理を変更する。

---

#### 原因仮説 2: RemoteDesktop ポータル仮想キーボードにおける修飾キー（`Ctrl`）のラッチ・ラッチ解除失敗（Stuck Modifier）
* **メカニズム**:
  `org.freedesktop.portal.RemoteDesktop` の Virtual Keyboard API (`NotifyKeyboardKeycode`) を介して `Ctrl + V` を注入する際、GNOME コンポジタ (Mutter) 側で `Ctrl` キーの KeyUp（解放）イベントが取りこぼされるか、または `evdev.ts` が `/dev/input/event*` 経由でポータルが生成した仮想キーボードデバイスの `Ctrl` Down イベントを拾い、アプリ内部の修飾キー状態 (`modifierState.ctrl`) が `true` のまま固定される現象が発生します。
  1. 端末アプリ（②）への入力時、`Ctrl` が押しっぱなし状態（Stuck Modifier）になります。
  2. 端末へのその後の入力がすべて `Ctrl + <key>` ショートカットとして解釈され、テキストが入らなくなります。
  3. Claude アプリ（③）に戻った際も、アプリ内部の `untilAllModifiersUp()` が `modifierState.ctrl == true` のためタイムアウト（600ms）を繰り返し、後続のキー注入が正常に実行できなくなります。
* **根拠（ファイル・行）**:
  * [evdev.ts](file:///src/main/hotkey/evdev.ts#L181-L245) (`src/main/hotkey/evdev.ts` L181-L245): `/proc/bus/input/devices` をスキャンしてポータルが作成した仮想キーボードを含むすべての `kbd` イベントデバイスを監視対象として開くため、ポータルからの仮想 `Ctrl` キーイベントで `heldByDevice` および `modifierState` が固定されるリスクがある。
  * [manager.ts](file:///src/main/hotkey/manager.ts#L214-L240) (`src/main/hotkey/manager.ts` L214-L240): `untilAllModifiersUp` で修飾キー解放を待機するが、仮想キーボードの `Ctrl` キーが解放されないとタイムアウト（600ms）を引き起こす（`issue #34` に類似の記述あり）。
* **修正案**:
  `portal-remote.py` でキー注入を行う際、`Ctrl` Down と KeyUp の間に適切なディレイ（例: 20ms）を挟むとともに、キー注入の直後およびセッション終了時に明示的に全修飾キーの Up イベントを全送信して入力状態をリセットする。

---

#### 原因仮説 3: Wayland <-> XWayland 間 クリップボード Selection 所有権の同期競合と早すぎる復元 (`SetSelection`)
* **メカニズム**:
  Wayland 環境ではクリップボードデータは `wl_data_source`（Selection Ownership）を介して転送されます。Wayland ネイティブの GNOME Terminal と、XWayland 上で動作する Electron アプリ（Claude アプリ等）の間では、GNOME の XWayland selection bridge がクリップボード所有権を媒介します。
  1. `portalSidecar.pasteText()` は、1500ms 後に `setSelection(old_text)` を呼び出してクリップボードを自動復元します。
  2. 端末アプリ（②）で `Ctrl+V` に反応しなかった場合や非同期の Selection 受渡が遅延している間に、1500ms タイマーによって旧クリップボードへの復元 `SetSelection` が発行されます。
  3. この時、`portal-remote.py` の `wl_data_source` と GNOME ポータルのクリップボードブリッジ間で選択所有権の競合・失効（`SelectionClear`）が発生し、サイドカーの Selection 保持機能が壊れます。
  4. その結果、Claude アプリ（③）に戻った後もサイドカーからの Selection 供給ができなくなり、テキストが貼り付けられなくなります。
* **根拠（ファイル・行）**:
  * [portalSidecar.ts](file:///src/main/linux/portalSidecar.ts#L315-L343) (`src/main/linux/portalSidecar.ts` L315-L343): `pasteText()` は Python サイドカー側で Selection 設定 → キー注入 → Selection 復元 を一括で行うが、アプリによるクリップボード読取完了のイベントを待たずに固定時間で復元している。
  * [typer.ts](file:///src/main/inject/typer.ts#L186-L224) (`src/main/inject/typer.ts` L186-L224): Wayland 環境においてサイドカーからのレスポンス `injected=true` のみをチェックしており、Selection 所有権が途中で破棄された場合のリカバリが行われない。
* **修正案**:
  Wayland セッションにおいてはクリップボード自動復元 (`restore=true`) の競合リスクを避けるため、設定で復元を無効化できるようにするか、復元処理失敗時にポータルサイドカーのセッションを `restart()` して Selection 所有権を再初期化する。

---

#### 原因仮説 4: GNOME Wayland の RemoteDesktop ポータルにおけるフォーカスウィンドウ境界と無通知キー棄却
* **メカニズム**:
  GNOME Wayland のセキュリティ仕様により、`org.freedesktop.portal.RemoteDesktop` を通じた仮想入力はコンポジタが「入力可能フォーカスがある」と認定したアクティブウィンドウに対してのみ配信されます。
  1. ウィンドウ切替（Claude → Terminal）直後に音声入力を実行した際、フォーカス遷移タイミングのズレや WindVoice のトレイ/オーバーレイの介入により、ポータル側で「フォーカスなし」と認識され、仮想キーがコンポジタレベルでサイレントドロップ（破棄）されます。
  2. また、Ubuntu 24.04 (GNOME 46) のセキュリティ制限により、端末エミュレータなどの特権アプリへの RemoteDesktop 仮想キー入力が無通知でブロックされる場合があります。
  3. ポータル D-Bus 通信自体は成功を返すためサイドカーログは `ok=true injected=true` となりますが、キーは届きません。
  4. コンポジタ側でキー棄却やフォーカス不整合が起きるとポータルセッション内部状態が Inhibited（抑制）状態へ遷移し、セッションを再構築するまで Claude アプリ（③）への入力も拒否され続けます。
* **根拠（ファイル・行）**:
  * [portalSidecar.ts](file:///src/main/linux/portalSidecar.ts#L260-L280) (`src/main/linux/portalSidecar.ts` L260-L280): ポータルサイドカーのイベントハンドラ `onEvent` は `failed` や `closed` のみを検知しており、コンポジタによる仮想キーのサイレントドロップやフォーカス無効化状態を検知できない。
  * [orchestrator.ts](file:///src/main/dictation/orchestrator.ts#L520-L555) (`src/main/dictation/orchestrator.ts` L520-L555): ポータルサイドカーから `injected=true` が返ると成功として終了するため、コンポジタで棄却された場合の検出や再接続処理が行われない。
* **修正案**:
  キー注入失敗が疑われる場合や端末アプリへの入力時には、ポータルサイドカーの `retryForDictation()` や `restart()` を呼び出して RemoteDesktop ポータルセッションをクリア・再生成するか、クリップボードコピー完了通知を出してユーザーの手動貼り付け（`Ctrl+Shift+V`）へ安全にフォールバックする。

---

RVDONE3

## agy-lx-4.md
^Dご提示いただいたバグ報告およびコードベース・ログの分析結果に基づき、**【一度失敗した後にElectronアプリにも入らなくなる状態遷移バグ（suppress / クリップボード復元 / レースの追跡）】** の観点から原因仮説と修正案を4件まとめました。

---

### 原因仮説と修正案（最大4件）

#### 1. Waylandペースト処理における `suppressFor(40)` の時間不足によるホットキー誤検知・状態混濁
- **根拠（ファイル・行）**:
  - [`src/main/inject/typer.ts`: L212-L214](file:///src/main/inject/typer.ts#L212-L214) (`hkmW?.suppressFor(40);`)
  - [`src/main/inject/pasteTiming.ts`: L65-L71](file:///src/main/inject/pasteTiming.ts#L65-L71) (`WAYLAND_MIN` の `settleMs: 60`, `restoreDelayMs: 1500`)
  - [`src/main/hotkey/manager.ts`: L136-L140](file:///src/main/hotkey/manager.ts#L136-L140) (`suppressFor` の実装)
  - ログ: `2026-08-02T13:58:42.249Z [hotkey] ignored start for primary: dictation still active`
- **原因仮説**:
  [`typer.ts`](file:///src/main/inject/typer.ts#L213) ではペースト前に `suppressFor(40)` で40ms間だけホットキー処理を無効化しています。しかし Wayland 環境の `portalSidecar.pasteText` は `settleMs` (60ms) の遅延後に D-Bus 経由で仮想キーボードから `Ctrl+V` を注入するため、仮想キーが発行される時点（呼び出しから約 60ms 以降）では `suppressFor` (40ms) が既に期限切れとなっています。
  そのため evdev が読み取った仮想 `Ctrl` キーイベントが新たなホットキー入力として `HotkeyManager` に判定され、ログにある `ignored start for primary: dictation still active` が発生します。これにより `HotkeyManager` 内の修飾キー状態（`modifierState`）や保持状態（`heldDown`）が不正に更新され、ホットキーの状態遷移が狂ってしまいます。
- **修正案**:
  Wayland ペースト時の `suppressFor` の時間を `settleMs + 200ms` などペースト完了まで動的にカバーできる長さに拡張するか、`portalSidecar` によるキー注入中はホットキー無効化状態を保持するように修正します。

---

#### 2. ターミナルアプリにおける `Ctrl+V` ショートカット不適合による入力不発
- **根拠（ファイル・行）**:
  - [`src/main/inject/typer.ts`: L204-L218](file:///src/main/inject/typer.ts#L204-L218) (`portalSidecar.pasteText` 呼び出し)
  - [`src/main/linux/portalSidecar.ts`: L348-L368](file:///src/main/linux/portalSidecar.ts#L348-L368) (`pasteText` の実装)
  - [`src/main/inject/paste.ts`: L20-L31](file:///src/main/inject/paste.ts#L20-L31) (`sendPasteKeystroke`)
- **原因仮説**:
  Ubuntu (GNOME/Wayland) 上の多くのターミナル（GNOME Terminal, Alacritty 等）では、貼り付けショートカットが `Ctrl+Shift+V` であり、単体の `Ctrl+V` は `quoted-insert` (`^V`) として扱われるか無視されます。`portalSidecar` は一律で `Ctrl+V` を合成するため、ターミナルにフォーカスがある手順②ではターミナルが Wayland クリップボードの読み出し要求を発行せず、テキストが入力されません。sidecar 側は D-Bus 命令の送信成功のみをもって `ok=true injected=true restored=true` を返却するため、ログ上は成功と誤認されます。
- **修正案**:
  フォーカス先のアプリがターミナル系（`gnome-terminal`, `alacritty` 等）の場合、`Ctrl+Shift+V` を注入できるようにペースト処理および `portalSidecar` のキー合成ロジックを拡張します。

---

#### 3. クリップボード復元処理（`restore`）のタイマーバッティングと Wayland セレクション所有権の喪失
- **根拠（ファイル・行）**:
  - [`src/main/inject/typer.ts`: L204-L225](file:///src/main/inject/typer.ts#L204-L225) (`restoreClipboard = true` での実行)
  - [`src/main/linux/portalSidecar.ts`: L348-L370](file:///src/main/linux/portalSidecar.ts#L348-L370) (`paste` タイムライン)
  - [`src/main/inject/pasteTiming.ts`: L66](file:///src/main/inject/pasteTiming.ts#L66) (`restoreDelayMs: 1500`)
- **原因仮説**:
  `restoreClipboard = true` の時、sidecar は transcript をセレクションに設定して `Ctrl+V` を送信後、1.5秒（`restoreDelayMs`）待機してから元のクリップボード（`old_text`）へ自動復元（`set_selection`）します。
  手順②でターミナルが `Ctrl+V` を無視してセレクションを読み出さなかった場合、1.5秒後に以前の古い／空のセレクションへ上書き復元されます。さらに、ターミナルから Claude Desktop へのフォーカス切り替え時に sidecar 側の復元タイマー（`restore`）と Wayland コンポジタ間のセレクション所有権（Data Device / Serial）の更新がバッティングし、sidecar 側の Wayland クリップボード保持状態が破損・不整合を起こします。その結果、手順③で Claude Desktop に戻って再度実行しても、セレクションのデータ提供に失敗し Electron アプリにも入力が入らなくなります。
- **修正案**:
  Wayland 環境におけるクリップボード復元処理において、未消費時の復元ロジックを見直すか、復元処理が完了・失敗した際の状態クリアを徹底し、不必要なセレクション上書きによる状態破壊を防止します。

---

#### 4. `untilAllModifiersUp` のタイムアウト固着と修飾キー状態の不全
- **根拠（ファイル・行）**:
  - [`src/main/hotkey/manager.ts`: L173-L177](file:///src/main/hotkey/manager.ts#L173-L177) (`untilAllModifiersUp(timeoutMs = 600)`)
  - [`src/main/hotkey/manager.ts`: L190-L205](file:///src/main/hotkey/manager.ts#L190-L205) (`recordModifierTimeout`)
  - [`src/main/inject/typer.ts`: L211-L212](file:///src/main/inject/typer.ts#L211-L212) (`await hkmW.untilAllModifiersUp(600)`)
  - [`src/main/dictation/orchestrator.ts`: L224-L227](file:///src/main/dictation/orchestrator.ts#L224-L227) (`if (this.inFlight) return;`)
- **原因仮説**:
  手順②のペースト失敗およびキーボードイベントのズレにより、`HotkeyManager` 内部の `modifierState.ctrl` が `true` のまま固着する現象が発生します。
  これにより、次回以降のペースト実行時に [`typer.ts`](file:///src/main/inject/typer.ts#L212) 内の `await hkmW.untilAllModifiersUp(600)` が毎回 600ms のフルタイムアウトまでブロックされます。さらに `HotkeyManager` 内の `heldDown` や `toggleActive` も解除されないため、手順③で Claude アプリに戻ってホットキーを押しても `orchestrator.ts` 側で新規ディクテーションが開始されない、あるいは開始されてもペースト処理のタイマー競合によりペーストが不発となります。
- **修正案**:
  ディクテーション完了時やエラー発生時、あるいはペースト失敗時に `HotkeyManager.resetState()` を呼び出して `modifierState` および `heldDown` を明示的にリセットし、修飾キーの固着によるブロックを解除します。

---

RVDONE4

## agy-lx-5.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) における Electron 製音声入力アプリ **WindVoice** のバグ調査報告です。

観点である**【portal sidecarの寿命・再接続・エラー伝播 (sidecar result ok=trueの信頼性)】**に沿って、原因仮説と修正案をまとめました。

---

### 原因仮説および修正案（最大4件）

#### 仮説 1: RemoteDesktop セッション失効・拒否時のサイレント失敗と Sidecar の偽陽性（`injected=true`）応答
* **原因仮説**: 
  GNOME Wayland (Mutter) の XDG RemoteDesktop Portal (`org.freedesktop.portal.RemoteDesktop`) では、フォーカスが Claude アプリから Terminal 等の別アプリ（または特定権限のウィンドウ）に移動した際、Compositor 側の判定やセキュリティポリシーにより RemoteDesktop セッションによるキー入力注入 (`NotifyKeyboardKeycode`) がサイレントに拒否・ドロップされることがあります。
  しかし、D-Bus 呼び出し自体はエラーを返さないため、Python Sidecar (`portal-remote.py`) は「注入成功」と誤誤認して `injected=true` / `ok=true` を Node.js 側に返します。また Sidecar は起動時に確立したセッションを永久に使い回すため、Compositor 側でセッションが不全状態に陥っても再起動・再接続 (`restart()`) が一度もトリガーされず、Claude アプリに戻った後も二度と入力できなくなります。
* **根拠**:
  * [`src/main/linux/portalSidecar.ts:L391-L420`](file:///src/main/linux/portalSidecar.ts#L391-L420) : Sidecar から返ってきた `r.injected === true` をそのまま成功として鵜呑みにし、Compositor 側の実際の受信状態やセッション有効性を検証していません。
  * [`src/main/linux/portalSidecar.ts:L110-L128`](file:///src/main/linux/portalSidecar.ts#L110-L128) : `start()` で生成した Sidecar プロセスおよび D-Bus セッションを永遠に再利用しており、定期的なヘルスチェックやセッションの再検証ロジックが存在しません。
* **修正案**:
  * Python Sidecar 側で D-Bus メソッド呼び出し後のセッション状態確認を厳密化し、キー注入の拒否や異常を検知した場合は `injected=false` や `closed` イベントを明示的にレスポンスします。
  * `portalSidecar.ts` に定期的なヘルスチェック、またはペースト失敗検出時に Sidecar を解体・再起動 (`restart()`) して RemoteDesktop セッションを自動再構築する仕組みを導入します。

---

#### 仮説 2: Sidecar 内部で発生した転送・プロトコルエラー (`transfer_error` / `protocol_error`) の無視と状態破損の放置
* **原因仮説**: 
  ターミナルへの切り替え時などに、Wayland の Selection（クリップボード）データ転送や D-Bus 通信でエラーが発生すると、Sidecar は `transfer_error` や `protocol_error` イベントを発行します。
  しかし、`portalSidecar.ts` の `onEvent` ハンドラでは、これらのエラーイベントを単に `debug()` ログに出力して無視しています。このため、Sidecar 内部の D-Bus 通信パイプや Selection ステートマシンが破損・ハング状態になっても、Child プロセスの破棄 (`teardownChild`) や再起動 (`requestRespawn`) が行われず、破損した状態のまま後続のリクエストを処理してダミーの `ok=true` を返し続けることになります。
* **根拠**:
  * [`src/main/linux/portalSidecar.ts:L377-L380`](file:///src/main/linux/portalSidecar.ts#L377-L380) : `case 'transfer_error': case 'protocol_error': debug(...); break;` となっており、Sidecar から異常通知イベントを受けてもログ出力のみでリセット処理を行っていません。
* **修正案**:
  * `transfer_error` や `protocol_error` を受信した場合は、Sidecar の通信状態が破壊されたと判断し、`teardownChild` を実行して `requestRespawn()` によるプロセスとセッションのリセットを行わせるように変更します。

---

#### 仮説 3: クリップボード復元（Restore）時の D-Bus FD 転送ブロックと Sidecar ステートマシンのハング
* **原因仮説**: 
  `typer.ts` は `portalSidecar.pasteText` 呼出時に `restore: true` を渡します。Sidecar 内部では「Selection 所有権の獲得 → Ctrl+V 注入 → `restoreMs` 待機 → 元の Selection へ復元」をアトミックに処理しますが、ターミナル等の特定アプリにフォーカスがある場合、ターミナルと Sidecar 間のクリップボードデータ転送（UNIX FD パイプ経由の非同期読み書き）が完了しないかブロックすることがあります。
  Sidecar 内で restore 処理が正常に完了しなかった場合でも、キー送信自体が完了していれば `injected: true` を返してしまうため、アプリ側は「成功」と誤認します。しかし Sidecar 内部は restore のハングや所有権競合により不整合状態が固定化され、その後の全ペースト要求が正常に機能しなくなります。
* **根拠**:
  * [`src/main/inject/typer.ts:L245-L251`](file:///src/main/inject/typer.ts#L245-L251) : `portalSidecar.pasteText(text, restoreClipboard, timing.settleMs, timing.restoreDelayMs)` で注入と復元を一括して Sidecar に依存しています。
  * [`src/main/linux/portalSidecar.ts:L405-L419`](file:///src/main/linux/portalSidecar.ts#L405-L419) : `result.injected === true` であれば `restored` の成否に関わらず `ok: true` を返しており、Sidecar のリカバリやエラーハンドリングを行っていません。
* **修正案**:
  * `result.restored === false` または restore タイムアウトが発生した場合は、Sidecar の状態が不全であるとみなして強制的にプロセスを再起動 (`restart()`) します。
  * ペースト注入と Selection 復元処理を段階的に監視し、失敗時には手動ペースト案内（`copyTextForManualPaste`）へ安全にフォールバックできるようにします。

---

#### 仮説 4: ターミナルの `Ctrl+V` ショートカット非対応に伴う偽陽性とフォールバック欠如
* **原因仮説**: 
  Linux の多くのターミナルエミュレータ（gnome-terminal や ptyxis 等）では、貼り付けの標準キーバインドは `Ctrl+Shift+V` であり、`Ctrl+V` はエスケープ文字入力（コントロールシーケンス入力待ち）として扱われるか無視されます。
  Sidecar は D-Bus 経由で `Ctrl+V` を送信したこと（送信処理の完了）をもって `injected=true` を返却するため、ターミナル側で貼り付けが実際に実行されたかどうかを検知できません。また `typer.ts` は `injected === true` を受け取ると即座に処理を正常終了するため、手動ペースト通知や代替ペーストへのフォールバックが起動せず、「ログ上は成功しているがターミナルにもその後のアプリにも文字が入らない」という状態に陥ります。
* **根拠**:
  * [`src/main/inject/typer.ts:L252-L260`](file:///src/main/inject/typer.ts#L252-L260) : `result.injected === true` の場合、手動ペースト（クリップボード保持＋ユーザー通知）等のフォールバックを実行せずに正常終了 (`return`) しています。
  * [`src/main/inject/paste.ts:L22-L33`](file:///src/main/inject/paste.ts#L22-L33) : Wayland 上でのキー送信は `portalSidecar.keyPaste()` または `pasteText()` 一本に依存しており、ターミナル等の特殊な入力先に対するキーコード切り替えや失敗検知が存在しません。
* **修正案**:
  * ターゲットウィンドウがターミナルの場合に `Ctrl+Shift+V` を送信するオプションの検討、または Sidecar 側でのレスポンス信頼性の見直しを行います。
  * 入力が実際に行われなかった疑いがある場合やエラー伝播時には `injected = false` または `uncertain = true` として扱い、確実に手動ペースト（`copyTextForManualPaste` + `notifyPasteFailed`）にフォールバックさせます。

---

RVDONE5

## agy-lx-6.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) 環境で動作する Electron 製音声入力アプリ **WindVoice** のバグ調査報告です。

観点である **「クリップボード復元 (`restore=true`) がターゲットアプリによるテキスト消費（注入）より先に走って中身を上書き・消去してしまう競合の可能性」** に基づき、原因仮説および修正案を以下に4件まとめました。

---

### 原因仮説と修正案（最大4件）

---

#### 仮説 1: ターゲットアプリ（ターミナル等）の非同期セレクション取得遅延と `restoreDelayMs` (1500ms) 経過によるフライング復元競合

- **原因詳細**:
  Wayland 環境では、サイドカーが Wayland セレクションを認識させてから `Ctrl+V` キーイベントを送信し、`restoreDelayMs` (1500ms) 待機した後に元のクリップボード内容 (`old_text`) へ復元 (`set_selection`) します。
  しかし、GTK/Electron アプリやターミナルアプリ、あるいは高負荷時の描画スレッドでは、`Ctrl+V` キーイベントを受信してから実際に Wayland データオファー (`wl_data_offer.receive` / D-Bus IPC) 経由でクリップボード本文を読み出す処理が非同期で行われます。
  アプリ側の本文取得リクエストが 1500ms のタイマー経過後に到達した場合、サイドカーはすでに復元済みの `old_text`（直前が空なら空文字）を返却するため、アプリ側には一切テキストが入らなくなります。ログ上は `Ctrl+V` 送信とリストア完了をもって `ok=true injected=true restored=true` と成功報告されるため、見た目上「成功ログなのにテキストが入らない」現象が発生します。

- **根拠（ファイル・行の引用）**:
  - [`src/main/inject/pasteTiming.ts`: L73-95](file:///src/main/inject/pasteTiming.ts#L73-L95) (`WAYLAND_MIN` の `restoreDelayMs: 1500`)
  - [`src/main/inject/typer.ts`: L223-241](file:///src/main/inject/typer.ts#L223-L241) (`pasteText` 内で `portalSidecar.pasteText(text, restoreClipboard, timing.settleMs, timing.restoreDelayMs)` を呼び出し)
  - [`src/main/linux/portalSidecar.ts`: L358-384](file:///src/main/linux/portalSidecar.ts#L358-L384) (`pasteText` がサイドカーへ `restore: true` 付きの `paste` オペレーションを発行)

- **修正案**:
  1. **動的セレクション読込完了検知**: サイドカー (Python) 側でターゲットアプリからのデータ読み出し完了イベント (SelectionRead / EOF) を検知するまでリストア処理をブロック・同期させる。
  2. **Wayland リストア遅延の拡張または設定追加**: Wayland 環境における `restoreDelayMs` のデフォルト値を延長するか、ターミナル等の特定アプリフォーカス時には `restoreClipboard=false` にする設定を設ける。

---

#### 仮説 2: Linux ターミナルのショートカット不一致 (`Ctrl+V` vs `Ctrl+Shift+V`) による未消費と、その後の `restore=true` によるクリップボード空化

- **原因詳細**:
  Linux ターミナル（GNOME Terminal, Ptyxis, Alacritty 等）の標準貼り付けショートカットは `Ctrl+Shift+V` であり、`Ctrl+V` はエスケープシーケンス (`lnext`) として無視または別処理されます。
  WindVoice 側は Wayland 注入時に一律 `Ctrl+V` を送信しているため、ターミナル側で貼り付けイベントが発動せずセレクションが消費されません。
  その状態で 1500ms が経過すると `restore=true` が走り、Wayland セレクションが元の `old_text`（事前に何もコピーしていなければ空文字 `""`）へ上書き復元されます。
  さらに、この操作によってサイドカー内のセレクション状態が空文字で固定され、直後に Claude アプリへ切り替えて再度音声入力を試みた際にも、古い/空のセレクション状態が干渉して正常にペーストできなくなります。

- **根拠（ファイル・行の引用）**:
  - [`src/main/inject/pasteWin32.ts`: L63-68](file:///src/main/inject/pasteWin32.ts#L63-L68) (`sendCtrlVAtomic` が Linux 上で `uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl])` を発行)
  - [`src/main/inject/typer.ts`: L223-248](file:///src/main/inject/typer.ts#L223-L248) (`isWaylandSession()` 時に `portalSidecar.pasteText` へ一任)
  - [`src/main/linux/portalSidecar.ts`: L358-384](file:///src/main/linux/portalSidecar.ts#L358-L384) (サイドカーが `paste` コマンドで `Ctrl+V` 注入を実行)

- **修正案**:
  1. **アクティブウィンドウに応じたショートカット切り替え**: アクティブウィンドウがターミナル系プロセス（`gnome-terminal`, `ptyxis`, `alacritty`, `kitty` 等）の場合は `Ctrl+Shift+V` を送信するよう分岐する。
  2. **注入失敗時のフォールバック**: キー注入でテキストが読まれなかった場合の復元スキップロジックを追加する。

---

#### 仮説 3: 連続音声入力・アプリ切り替え時における `old_text` スナップショット汚染と上書き連鎖

- **原因詳細**:
  ①の Claude アプリへの入力成功時、`restore=true` が走ったものの、1500ms のリストア処理中または完了直後に②のターミナル入力が開始されると、ターミナル入力時のスナップショット (`portalSidecar.snapshot()`) が「1回目の音声入力テキスト」または「リストア中の空状態」を `old_text` として取得してしまいます。
  その状態で②（ターミナル）のリストアが走り、さらに③（Claude アプリに戻った時）の入力が始まると、スナップショットとリストアのタイミングが完全にズレて `old_text` に「空文字」が保持されます。
  結果として、`pasteText` が新しい認識結果をセットした直後に `restore=true` が走ってセレクションを即座に「空文字」へ上書きしてしまい、③の Claude アプリでも一切入力できなくなります。

- **根拠（ファイル・行の引用）**:
  - [`src/main/dictation/orchestrator.ts`: L393-410](file:///src/main/dictation/orchestrator.ts#L393-L410) (`stopCycle` 内で `pasteText` を連続して実行)
  - [`src/main/inject/typer.ts`: L223-255](file:///src/main/inject/typer.ts#L223-L255) (`pasteText` が `restoreClipboard` を毎回有効にしてサイドカーへ渡す)
  - [`src/main/inject/streamingTyper.ts`: L108-124`, `L206-235](file:///src/main/inject/streamingTyper.ts#L108-L124) (`begin()` でスナップショットを取得し `end()` でリストア)

- **修正案**:
  1. **WindVoice 自身が書き込んだセレクションの復元除外**: スナップショットした `old_text` が WindVoice 自身の過去の認識結果と一致する場合は、元のクリップボード復元を行わずスキップする。
  2. **スナップショットの一位性管理**: 連続セッション間でスナップショットがネスト・汚染されないよう、セッション開始時のクリップボード状態チェックを厳密化する。

---

#### 仮説 4: `portalSidecar.pasteText` 1500ms 待機中の非同期コマンドパイプライン割り込みとリストア先行実行

- **原因詳細**:
  ログの `13:58:42.249Z [hotkey] ignored start for primary: dictation still active` から分かるように、`portalSidecar.pasteText()` は 1500ms 以上の非同期 Promise 待機を伴います。
  ユーザーが連続してホットキーを押したり、サイドカーへ次のコマンド (`set_selection` や新しい `paste`) が送信された場合、Python サイドカー側のイベントループで前回の `restore` タイマー（1500ms 後の復元処理）と新しい `paste` の処理順序が競合します。
  前回の `restore` 処理が新しい `paste` の `Ctrl+V` 注入直前または直後に非同期で割り込んで実行されると、新しいテキストがターゲットアプリに読まれる前に `old_text`（空文字）に書き換えられます。
  これにより、2回目以降の注入がすべて失敗（空上書き）し、ログ上は `injected=true restored=true` が残り続けます。

- **根拠（ファイル・行の引用）**:
  - [`src/main/dictation/orchestrator.ts`: L197-202](file:///src/main/dictation/orchestrator.ts#L197-L202) (前回のペースト処理完了前にホットキー入力が発生しているログ)
  - [`src/main/linux/portalSidecar.ts`: L284-315](file:///src/main/linux/portalSidecar.ts#L284-L315) (`send` メソッドが標準入力経由で非同期にコマンドをキューイング)
  - [`src/main/inject/pasteTiming.ts`: L88-94](file:///src/main/inject/pasteTiming.ts#L88-L94) (Wayland の `restoreDelayMs` が 1500ms に設定されている点)

- **修正案**:
  1. **サイドカーコマンドの直列化・キャンセル処理**: 新しいペースト要求が来た場合、進行中の未完了リストアタイマーを即座にキャンセル（破棄）し、旧テキストでの上書きを防止する。
  2. **サイドカー内のキュー排他制御**: Python サイドカー側で `paste` オペレーションが完了（リストア完了）するまで次のペースト要求を受け付けないか、アトミックに処理する。

---

RVDONE6

## agy-lx-7.md
^DLinux(Ubuntu24.04 / GNOME / Wayland)環境における Electron 製音声入力アプリ **WindVoice** のバグ調査報告です。

観点である**【ホットキー(evdev/uiohook)が使用中に死ぬ・イベントを落とす条件】**に基づき、ログ抜粋および該当ソースコードから解析した原因仮説と修正案を以下にまとめます。

---

### 原因仮説 1: Wayland Portal の仮想キーボード (uinput) を evdev が誤検知・受信し、モディファイアおよび HotkeyManager の状態が汚染・スタックする

- **根拠**: 
  - [src/main/hotkey/evdev.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/hotkey/evdev.ts#L125-L135) (`parseKeyboardEventNodes`)
  - [src/main/linux/portalSidecar.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/linux/portalSidecar.ts)
- **原因詳細**:
  `EvdevKeyboardMonitor` は `/proc/bus/input/devices` 内の `Handlers` に `kbd` が含まれるすべての入力デバイスを自動検出・監視します。Wayland 環境で dictation 完了時に `portalSidecar.pasteText` が呼ばれると、GNOME RemoteDesktop Portal / EI 経由でペースト用の仮想キーボード（uinput）が作られて Ctrl+V が注入されますが、この仮想デバイスも `kbd` ハンドラを持つため evdev に動的にオープン・監視されてしまいます。
  結果として、**アプリ自身が注入した Ctrl+V の合成キーイベントを evdev が拾ってしまい**、`HotkeyManager` 内の `modifierState.ctrl` が `true` のまま解除されなくなったり、キー押下状態が汚染されます。これにより、モディファイアが常に押された状態と誤認され、ターミナル等のアプリで入力がショートカットキー扱いになって一切入らなくなるほか、以後のホットキーイベントもドロップされて機能しなくなります。
- **修正案**:
  `parseKeyboardEventNodes` にて `/proc/bus/input/devices` のデバイス名（`N: Name="..."`）をパースし、`EI Virtual Keyboard` や `RemoteDesktop`、`uinput` などのポータル / 仮想キーボードデバイスを監視対象から除外（ブラックリストフィルタリング）するように変更します。

---

### 原因仮説 2: ペースト処理時の `suppressFor(40)` が物理キーの `keyup`（キー離し）イベントを破棄し、ホットキー押下状態が永久スタックする

- **根拠**:
  - [src/main/hotkey/manager.ts](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/hotkey/manager.ts) (`suppressFor`, `onKey`)
  - [src/main/inject/typer.ts:L312](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/inject/typer.ts#L312) (`hkm?.suppressFor(40)`)
  - [src/main/inject/streamingTyper.ts:L260](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/inject/streamingTyper.ts#L260), [L290](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/inject/streamingTyper.ts#L290)
- **原因詳細**:
  ペーストキー合成時のセルフイベント誤発火を防ぐため、`hkm?.suppressFor(40)` で 40ms 間キーイベントを抑止する処理が入っています。しかし、ユーザーが録音終了（Push-to-Talk離し）を行ったタイミングとペースト処理の実行タイミングが重なると、物理キーの `keyup` イベントが `suppressUntil` の期間中に到着して破棄（ドロップ）されてしまいます。
  `keyup` が落とされた結果、`HotkeyManager` 内部の `heldDown` や `modifierState` にホットキーが物理的に押しっぱなしであると記録され続け、次回以降にユーザーがホットキーを押しても（`keydown`）、重複押下（オートリピート扱い）と判定されて無視され、ホットキーが一切反応しなくなります（ホットキーが死ぬ条件）。
- **修正案**:
  `HotkeyManager.onKey` 内の `suppressUntil` 抑止処理において、`keydown` イベントのみを抑止対象とし、`keyup`（およびモディファイア解除）イベントは抑止期間中であっても常に通過させて内部状態（`heldDown`, `modifierState`）を正常に更新・解放させるように改修します。

---

### 原因仮説 3: Wayland の長いクリップボード復元遅延 (`restoreDelayMs: 1500ms`) 中のホットキー押下による `ignored start` とトグル状態の不整合

- **根拠**:
  - [src/main/dictation/orchestrator.ts:L224](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/dictation/orchestrator.ts#L224) (`start`), [L290](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/dictation/orchestrator.ts#L290) (`stopCycle`)
  - [src/main/inject/pasteTiming.ts:L73](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/inject/pasteTiming.ts#L73) (`WAYLAND_MIN.restoreDelayMs = 1500`)
- **原因詳細**:
  Wayland 環境ではクリップボード復元待ち時間 `restoreDelayMs` の安全値として 1500ms が確保されており、文字注入が完了した後も 1.5 秒間 `DictationOrchestrator.isActive()` (`inFlight`) が `true` のまま維持されます。
  ログの 17 行目（`2026-08-02T13:58:42.249Z [hotkey] ignored start for primary: dictation still active`）にある通り、この 1.5 秒間にユーザーが次の録音を開始しようとしてホットキーを押すと `start()` が拒否されます。このとき、`HotkeyManager` 側のトグル状態 (`toggleActive`) や押下判定が拒否された `start()` と非同期に食い違い、トグル状態がオン／オフ逆転して固まるか、以後のホットキーイベントを受け付けなくなります。
- **修正案**:
  `DictationOrchestrator.start()` が `inFlight` によって拒否された場合、`HotkeyManager.rejectToggleStart(bindingId)` または `resetState()` を呼び出してトグル・押下状態を正確にロールバックし、Dictation サイクル完了後に改めてホットキーを正しく受け付けられるようにします。

---

### 原因仮説 4: evdev デバイス動的切断・エラー時の状態クリア不足および全デバイス一時喪失後の復帰不能

- **根拠**:
  - [src/main/hotkey/evdev.ts:L209-L224](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/hotkey/evdev.ts#L209-L224) (`removeDevice`)
  - [src/main/hotkey/evdev.ts:L190-L200](file:///Users/yukitsuruoka/.gemini/antigravity-cli/scratch/src/main/hotkey/evdev.ts#L190-L200) (`scan`)
- **原因詳細**:
  ターミナルへのフォーカス切り替えや仮想端末の作成・削除に伴い `/proc/bus/input/devices` の変更やデバイスノードのエラーが発生して `removeDevice` が呼ばれた際、削除されたデバイスで保持されていたキーの解放イベントが `HotkeyManager` へ漏れなく伝達されない場合があります。
  また、一時的に全キーボードデバイスのストリームが閉じて `unavailable` イベントが発行された後、`scan()` の再試行によってデバイスが再オープン（`ready`）されても、`HotkeyManager` 側の内部キー押下状態（`heldDown` / `modifierState`）が初期化されないため、古いキー状態が残留してホットキーイベントを落とし続ける原因となります。
- **修正案**:
  `removeDevice` 実行時には該当デバイスに記録されていたすべてのキーコードに対して強制的に `keyup` イベントを合成・発行して `HotkeyManager` に通知するとともに、`ready` イベント受信時に `HotkeyManager.resetState()` を実行してキー状態を完全にクリーンにします。

---

RVDONE7

## agy-lx-8.md
^Djetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.

## agy-lx-9.md
^DLinux（Ubuntu 24.04 / GNOME / Wayland）環境における WindVoice の調査結果、既知の設計妥協と今回の不具合症状（①Claudeアプリで成功 → ②ターミナルで失敗 → ③Claudeアプリでも失敗）の対応関係、および原因仮説と修正案（計4件）を報告します。

---

### 【既知の設計妥協と今回の症状の対応関係】
Wayland環境では、バックグラウンドのElectronアプリが直接クリップボード所有権を持てないため、XDG RemoteDesktop / Clipboard Portal 経由でクリップボード選択（`SetSelection`）と仮想キー（`Ctrl+V`）の注入を行う設計妥協（`portalSidecar`）を採用しています。また、Waylandには「ターゲットアプリが貼り付けを完了した」ことを検知するOSシグナルが存在しないため、1500msの固定遅延（`restoreDelayMs`）を置いて元のクリップボードに復元する仕様となっています。

今回の症状は、**ターミナル固有のショートカット不一致によりデータ読み出しが発生せず、Portalの選択復元およびモディファイア状態の不整合が引き起こされたこと**が原因です。

---

### 【原因仮説と修正案（最大4件）】

#### 仮説 1: ターミナル固有の貼り付けショートカット不一致（`Ctrl+V` vs `Ctrl+Shift+V`）
- **原因と現象**: 
  Claudeデスクトップ（GUIアプリ）は standard な `Ctrl+V` で貼り付けが成功しますが、Linuxのターミナルエミュレータ（`gnome-terminal`, `ptyxis` 等）は標準で `Ctrl+Shift+V`（または `Shift+Insert`）を貼り付けショートカットとします。WindVoice は一律 `Ctrl+V` を送信するため、ターミナル側では文字リテラル入力（`^V`）または無視され、クリップボードの要求（Selection Fetch）が一切発生しません。
- **根拠**:
  - [`src/main/inject/paste.ts`: L5-L27](file:///src/main/inject/paste.ts#L5-L27): Wayland環境では `portalSidecar.keyPaste()` / `pasteText()` 経由で `Ctrl+V` を固定送信している。
  - [`src/main/linux/portalSidecar.ts`: L310-L337](file:///src/main/linux/portalSidecar.ts#L310-L337): `pasteText` メソッドはアプリ種別を区別せず `Ctrl+V` のみをPortalへ注入する。
- **修正案**: 
  アクティブウィンドウのプロセス・クラス名（`WM_CLASS` や `activeWindowApp`）を取得し、ターミナル系アプリ（`gnome-terminal`, `ptyxis`, `konsole`, `alacritty` 等）の場合は `Ctrl+Shift+V` を送信する分岐ロジックを追加する。

---

#### 仮説 2: 未消費のクリップボード復元による XWayland / Wayland 間選択同期の破綻
- **原因と現象**: 
  ターミナルへの注入時、`Ctrl+V` が無視されてクリップボードデータの読み出しが起きないまま `restoreDelayMs`（1500ms）が経過し、Sidecarが元の旧クリップボードへ選択復元を実行します。その後 Claudeアプリ（XWaylandで動作するElectronアプリ）に戻った際、GNOME Mutterの `xwayland-clipboard` ブリッジが未消費の旧選択オファーと復元状態の間で非同期不整合を起こす（または旧データに上書きされている）ため、Claudeアプリに戻っても貼り付けが行われなくなります。
- **根拠**:
  - [`src/main/inject/pasteTiming.ts`: L53-L73](file:///src/main/inject/pasteTiming.ts#L53-L73): Waylandでは貼り付け完了のOSシグナルがないため 1500ms の床値待ちを行って復元する設計妥協が記述されている。
  - [`src/main/inject/typer.ts`: L228-L264](file:///src/main/inject/typer.ts#L228-L264): `portalSidecar.pasteText(...)` を呼び出し、一定時間後に選択復元を行っている。
  - [`src/main/linux/portalSidecar.ts`: L1-L21](file:///src/main/linux/portalSidecar.ts#L1-L21): Waylandバックグラウンドアプリのクリップボード制約とPortal側設計について記述。
- **修正案**: 
  ターゲットアプリからのデータ取得が確認されない場合は復元処理をキャンセルするか、XWaylandアプリへの切り替え時にクリップボード選択を再同期・再発行する処理を挟む。

---

#### 仮説 3: `portalSidecar` の送信ログ `ok=true injected=true` の判定偽陽性
- **原因と現象**: 
  アプリのログには全注入で `ok=true injected=true` と成功が報告されていますが、これは「D-Bus経由でPortalへ `NotifyKeyboardKeycode`（キー送信）が成功した」ことのみを示しており、「ターゲットアプリが実際にクリップボードデータを取得・貼り付けしたか」は検証していません。そのため、ターミナルで `Ctrl+V` が無視された場合や同期失敗時でも「成功」と誤報告され、フォールバック（手動貼り付け通知等）が起動しません。
- **根拠**:
  - [`src/main/linux/portalSidecar.ts`: L310-L337](file:///src/main/linux/portalSidecar.ts#L310-L337): `pasteText` の `injected` 判定は D-Bus レスポンス `r.injected === true` のみを見ており、データ読み出し（`claimed`/`read`）の完了を保証していない。
  - [`src/main/inject/typer.ts`: L244-L264](file:///src/main/inject/typer.ts#L244-L264): `result.injected === true` であれば成功としてリターンしている。
- **修正案**: 
  `portal-remote.py` 側でクリップボード選択（`SelectionRead`）のパイプ読み出しが発生したかを監視し、データが要求されなかった場合は `injected: false` と判定してユーザーへ手動貼り付け案内を出力する。

---

#### 仮説 4: 仮想キー注入による `evdev` モニターのモディファイア状態（Ctrl/Shift/Alt）固着
- **原因と現象**: 
  `portalSidecar` がPortal経由で `Ctrl+V` を注入した際、`evdev.ts` が `/dev/input/event*`（仮想インプットデバイス）から `KEY_LEFTCTRL` の押下を検知します。キー離脱（Key-Up）イベントの取りこぼしや非同期ズレが発生すると `HotkeyManager` 内の `modifierState.ctrl` や `alt` が `true` のまま固着します。その結果、Claudeアプリに戻った際も `untilAllModifiersUp(600)` がタイムアウトし、実際のキー送信が `Alt+Ctrl+V` や `Ctrl+Shift+V` と誤認識され、Claudeアプリ側で貼り付けが拒否されます。
- **根拠**:
  - [`src/main/hotkey/evdev.ts`: L142-L176, L219-L235](file:///src/main/hotkey/evdev.ts#L142-L176): 全ての `/dev/input/event*` からキーイベントを読み取り `HotkeyManager` へ通知している。
  - [`src/main/inject/pasteWin32.ts`: L80-L86](file:///src/main/inject/pasteWin32.ts#L80-L86): Linux環境におけるキー離脱取りこぼし（Issue #34）と `modifierState` 固着リスクに関する記述。
  - [`src/main/hotkey/manager.ts`: L154-L178](file:///src/main/hotkey/manager.ts#L154-L178): `untilAllModifiersUp` がタイムアウトした場合の警告・リカバリ挙動。
- **修正案**: 
  Sidecarによる仮想キー注入中は `evdev` のモディファイア更新を一時抑制するか、注入完了時に `HotkeyManager.resetState()` を呼び出してモディファイアの固着状態をリセットする。

---

RVDONE9

## agy-lx2-1.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) における Electron 音声入力アプリ **WindVoice** のバグ調査報告です。

ご提示いただいたログおよびソースコード（`typer.ts`, `portalSidecar.ts`, `manager.ts`, `evdev.ts`, `pasteTiming.ts` 等）を分析した結果、**「なぜターミナルに入力されず（ログは injected=true 成功報告）、その後 Claude デスクトップにも入らなくなったのか」** に関する原因仮説と修正案を以下に 4 件まとめました。

---

### 【原因仮説と修正案 1】ターミナル固有の貼り付けショートカット（`Ctrl+Shift+V`）未対応による入力不全
- **原因仮説**:
  Ubuntu GNOME/Wayland 上の Claude デスクトップ等の GUI アプリは `Ctrl+V` で貼り付けを行いますが、Linux の一般的なターミナルエミュレータ（GNOME Terminal, Ptyxis, Alacritty 等）のデフォルト貼り付けショートカットは **`Ctrl+Shift+V`** または **`Shift+Insert`** です（`Ctrl+V` は readline/TTY では quoted-insert / 次文字リテラル入力の制御文字 `^V` として扱われます）。  
  `portalSidecar.pasteText()` および `portal-remote.py` はアプリの種類を問わず一律で `Ctrl+V` の仮想キーを注入しています。Wayland ポータル（XDG RemoteDesktop）への `Ctrl+V` イベント送信自体は正常に完了するため、サイドカーログには `ok=true injected=true` と記録されますが、ターミナル側は貼り付けとして認識せず文字が一切入力されません。
- **根拠**:
  - [typer.ts](file:///src/main/inject/typer.ts) および [portalSidecar.ts](file:///src/main/linux/portalSidecar.ts) において、Wayland 環境ではターゲットウィンドウの種類に関わらず `portalSidecar.pasteText()` が一律で `Ctrl+V` キーコードを注入する設計になっている点。
  - ターミナル側がクリップボード読み出し（`wl_data_offer.receive`）を行わなくても、ポータルの `NotifyKeyboardKeycode` 呼び出し自体は成功するため、`injected=true` が報告される点。
- **修正案**:
  [orchestrator.ts](file:///src/main/dictation/orchestrator.ts) 内で `getActiveWindow()` によりフォーカス中ウィンドウのクラス名/プロセスタイトルを取得し、ターミナル系アプリ（`gnome-terminal`, `ptyxis`, `alacritty`, `konsole` 等）である場合は `Ctrl+Shift+V`（または `Shift+Insert`）を合成注入するロジック分岐を追加する。

---

### 【原因仮説と修正案 2】短すぎる `suppressFor(40)` による注入キーの誤検知と `HotkeyManager` 内部状態の破壊
- **原因仮説**:
  [typer.ts](file:///src/main/inject/typer.ts) では貼り付け直前に `hkmW?.suppressFor(40)` を呼び出し、40ms 間だけホットキー検知を抑制しています。  
  しかし Wayland 環境の `portalSidecar.pasteText()` は D-Bus IPC 経由で Python サイドカーに処理を依頼し、さらに `settleMs` (60ms) の待機後に仮想キーを注入するため、実際に `Ctrl+V` が注入されるタイミング（約+60ms〜+400ms後）には 40ms の抑制ウィンドウが既に切れています。  
  このため、サイドカーが注入した `Ctrl+V` を [manager.ts](file:///src/main/hotkey/manager.ts) の `HotkeyManager` が「ユーザーによる物理的なホットキー押し下げ（`primary` バインディング）」として誤検知し、内部の `heldDown` や `toggleActive` / `modifierState` にキー押下状態が不整合のまま残ります。その結果、以降 Claude デスクトップに戻ってホットキーを押しても入力開始・完了イベントが正しく発火しなくなります。
- **根拠**:
  - ログに `13:58:41.832Z [dictation] wayland paste: sidecar path` の約 417ms 後に `13:58:42.249Z [hotkey] ignored start for primary: dictation still active` が記録されており、サイドカーが注入した `Ctrl+V` を HotkeyManager が誤検知している明確な証拠がある点。
  - `typer.ts` L293 の `suppressFor(40)` が固定 40ms であり、Wayland サイドカーの非同期 IPC + `settleMs` (60ms) に耐えられない点。
- **修正案**:
  `portalSidecar.pasteText()` の実行中は、サイドカーの注入処理が完了するまで `suppressFor` の期限を動的に延長（またはサイドカーの応答受信時に抑制解除）する実装に変更する。

---

### 【原因仮説と修正案 3】`evdev.ts` によるポータル仮想キーボード（`/dev/input/eventX`）の誤オープンとキー固着
- **原因仮説**:
  [evdev.ts](file:///src/main/hotkey/evdev.ts) は `/proc/bus/input/devices` を監視し、`kbd` ハンドラを持つすべての入力デバイスを自動的にオープンしてキーイベントを読み取ります。  
  `portal-remote.py` が GNOME RemoteDesktop ポータル経由で仮想キーボードを有効化すると、 Linux カーネル/systemd により `/dev/input/eventX`（uinput 仮想キーボード）が作成されます。 `evdev.ts` の `fs.watch('/dev/input')` はこの新デバイスを検出してオープンしてしまうため、`portal-remote.py` が注入した `Ctrl` や `V` のイベントを自ら再読み込みして `HotkeyManager` へ二重フィードバックしてしまいます。  
  これにより `modifierState.ctrl` や `heldByDevice` の状態が `true` のまま解除されずに固着し、`typer.ts` の `untilAllModifiersUp()` が毎回タイムアウト（600ms）を起こすなど、システム全体のホットキー・貼り付け処理が麻痺します。
- **根拠**:
  - [evdev.ts](file:///src/main/hotkey/evdev.ts) の `parseKeyboardEventNodes()` が `/dev/input/event*` の全 `kbd` デバイスを無条件に開く実装になっている点。
  - `manager.ts` にも「issue #34: stuck-modifier from uIOhook/evdev」に関する記述があり、キー固着が起きると後続の全貼り付け・ホットキー判定に影響を与える構造になっている点。
- **修正案**:
  `evdev.ts` でデバイスをスキャン・オープンする際、`/proc/bus/input/devices` の `N: Name="..."` やベンダーIDを確認し、RemoteDesktop ポータルや uinput 起源の仮想キーボードデバイス（`PyGObject`, `gnome-remote-desktop`, `Virtual keyboard` 等）を無視するフィルタを追加する。

---

### 【原因仮説と修正案 4】ターミナル quoted-insert 遷移と クリップボード復元（`restore`）のレースによる選択所有権不全
- **原因仮説**:
  [pasteTiming.ts](file:///src/main/inject/pasteTiming.ts) では Wayland の `restoreDelayMs` が 1500ms に設定されています。  
  ターミナルに `Ctrl+V` が送られた際、ターミナルは貼り付けを行わずに quoted-insert (`^V`) モードに遷移するため、クリップボードのデータ読み出し（`wl_data_offer.receive`）を行いません。  
  データ読み出しが行われないまま 1500ms が経過すると、`portal-remote.py` は前回のクリップボード状態への復元処理（`restore`）を実行します。この結果、ターミナルには `^V` の入力待ち状態が残されたままになり、さらに Wayland クリップボードの選択所有権（`set_selection`）の復元とタイミングの不整合が発生します。この状態で Claude デスクトップにフォーカスを戻して次回音声入力を実行しても、サイドカー側の選択所有権状態が破損し、テキストが注入できなくなります。
- **根拠**:
  - `pasteTiming.ts` の `WAYLAND_MIN.restoreDelayMs = 1500` により、ターゲットがデータを受信しなくても 1500ms 後に強制的にクリップボード復元が走る点。
  - ログ上は `injected=true restored=true` が並ぶが、ターミナルがクリップボードを読み出さなかったため実際にはデータ伝達と Wayland 選択所有権の管理が破綻している点。
- **修正案**:
  原因仮説 1 の通りターミナル向けには `Ctrl+Shift+V` を送信して quoted-insert 状態への遷移を防ぎ、`portalSidecar` におけるクリップボード復元（`restore`）成功の検証と選択所有権のハンドシェイクを強化する。

---

RV2DONE1

## agy-lx2-10.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) における Electron 音声入力アプリ **WindVoice** のバグ調査報告書を作成しました。

ご指定の観点である**【sidecarプロセスのstdout/stderrの実内容を記録していない盲点と、ログ強化パッチ案】**に沿って、原因仮説・根拠・修正案およびログ強化パッチを提示します。

---

### 1. ログ記録における構造的盲点

現在の [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts) の実装には、以下のログ記録上の盲点が存在します。

1. **`stdout` 成功レスポンスの詳細未記録**:
   [`onStdout`](file:///src/main/linux/portalSidecar.ts#L225-L253) で JSON をパースして `msg.id` に一致した際、レスポンスの生の JSON 文字列や `msg` に含まれるプロパティ (`stage`, `claimed`, `injected`, `restored`, `message` 等) を一切ログ出力せず、Silent に Promise を resolve しています。そのため、sidecar 内部で異変が起きていても `typer.ts` 側のハイレベルな summary ログ (`ok=true injected=true`) しか見えません。
2. **`stderr` のスライス切捨てと行境界無視**:
   `child.stderr.on('data')` で `chunk.trim().slice(0, 300)` としており、300文字を超える Python のスタックトレースや D-Bus/PyGObject エラー、複数行ログが切断・隠蔽されます。

---

### 2. 原因仮説と修正案（最大4件）

#### 仮説1: Sidecarのキー送信成功判定 (`injected=true`) とターミナル固有のキー受け取り不全（Ctrl+V vs Ctrl+Shift+V / 修飾キー固着）
* **根拠**: [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L330-L345) の `pasteText` は Python sidecar (`portal-remote.py`) が `NotifyKeyboardKeycode` D-Bus 呼び出しに成功すると `injected=true` を返します。しかし、これは Wayland Portal への仮想キー発行完了を意味するだけで、フォーカス先のアプリが受託した保証ではありません。
* **現象メカニズム**: Claude Desktop (GUI) は `Ctrl+V` を受信できますが、ターミナル (GNOME Terminal 等) は標準で `Ctrl+Shift+V` を要求するか、`Ctrl+V` を制御文字 (`^V`) として処理・無視します。さらに、発行された `Ctrl` キーの Release イベントが漏れて修飾キーが Portal 内部で固着した場合、以降 Claude Desktop への入力時も `Ctrl+Ctrl+V` や `Shift+Ctrl+V` に化け、全アプリで貼り付け不能になります。
* **修正案**: Python sidecar 側でキー入力シーケンス前後に修飾キー状態のリセット (`release_all_modifiers`) を明示実行させるとともに、発行したキーイベントの詳細を stdout JSON レスポンスに含めて Node.js 側で全記録します。

#### 仮説2: Wayland Clipboard データ転送 (`SelectionTransfer` / UNIX fd 読み出し) の非同期破綻と非同期イベント無視
* **根拠**: Wayland の クリップボード仕様では、`pasteText` でキー送信した直後にターゲットアプリが D-Bus の UNIX fd を通じて選択テキストを取得します。
* **現象メカニズム**: `portal-remote.py` はキー送信時点で `{ injected: true }` を返しますが、その後ターミナルが fd 経由の読み出しに失敗（MIMEタイプ不一致や `transfer_error`）した場合、エラーは [`onEvent`](file:///src/main/linux/portalSidecar.ts#L255-L287) や `stderr` へ非同期に出力されます。しかし、`pasteText` の Promise は既に `ok=true` で解決済みのため失敗が検知されず、Python 側の GLib メインループや クリップボード所有権が破綻して以降の Claude Desktop への `set_selection` も機能しなくなります。
* **修正案**: 非同期イベント `transfer_error` / `protocol_error` の発生時に sidecar セッションの健全性を疑い、自動リカバリ (`restart()`) を起動するフックを追加します。

#### 仮説3: stderr ログの 300 文字制限と行境界破棄による D-Bus/Portal 例外の隠蔽
* **根拠**: [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L174-L178) において、`stderr` は `chunk.trim().slice(0, 300)` で処理されています。
* **現象メカニズム**: Python 側の PyGObject や D-Bus 通信（`org.freedesktop.portal.RemoteDesktop`）で例外が発生した場合、エラーメッセージや Python トレースバックは容易に 300 文字を超過します。先頭の標準出力ログのみが残り、根本原因となる Python 側のスタックトレースがログから消滅するため、外から見ると「成功しているのに動かない」状態に見えます。
* **修正案**: `stderr` にも `stderrBuf` による行バッファリングを導入し、改行区切りで切捨てずに全行出力します。

#### 仮説4: レスポンス JSON の生データ出力欠落によるトラブルシューティング不能
* **根拠**: `send()` メソッド ([`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L289-L318)) 内のログ出力は `!r.ok` の場合のみ発火します。
* **現象メカニズム**: `r.ok` が `true` の場合、`r.stage` や Python 側から返却された潜在的な警告メッセージ (`message`) がログに一切残りません。
* **修正案**: `send()` のレスポンス受信時および `onStdout` のパース時点で、レスポンスの全フィールドを含む構造化ログを記録します。

---

### 3. ログ強化パッチ案 (`src/main/linux/portalSidecar.ts`)

以下は、sidecar の `stdout` / `stderr` の実内容を完全に記録・追跡できるようにする強化パッチです。

```typescript
// src/main/linux/portalSidecar.ts の変更パッチ案

export class PortalSidecar {
  private stdoutBuf = '';
  private stderrBuf = ''; // 追記: stderr 行バッファ

  start(): void {
    // ... 前略 ...
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk));
    child.stderr.setEncoding('utf8');
    // 修正: 300文字切捨てをやめ、行バッファリングで全行を明示ログ出力
    child.stderr.on('data', (chunk: string) => {
      if (this.child !== child) return;
      this.stderrBuf += chunk;
      let idx: number;
      while ((idx = this.stderrBuf.indexOf('\n')) !== -1) {
        const line = this.stderrBuf.slice(0, idx).trim();
        this.stderrBuf = this.stderrBuf.slice(idx + 1);
        if (line) {
          debug('DICTATION', `[sidecar stderr] ${line}`);
        }
      }
    });
    // ... 後略 ...
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      
      // 追記: sidecar からの生の stdout 行を記録
      debug('DICTATION', `[sidecar stdout] ${line}`);

      let msg: SidecarReply;
      try {
        msg = JSON.parse(line) as SidecarReply;
      } catch {
        debug('DICTATION', `portal sidecar bad line: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.event) {
        this.onEvent(child, msg);
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          // 追記: ペンディング解除時の結果詳細ログ
          debug('DICTATION', `[sidecar reply #${msg.id}] ok=${msg.ok} stage=${msg.stage ?? 'N/A'} injected=${msg.injected} error=${msg.error ?? 'none'}`);
          p.resolve(msg);
        }
      }
    }
  }
}
```

---

RV2DONE10

## agy-lx2-2.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) 環境における Electron 物理音声入力アプリ **WindVoice** のバグ調査報告書です。

---

### 1. 代替注入手段（ydotool / uinput / wtype 等）と現行 Sidecar 方式の技術比較

Wayland 環境におけるキー入力・テキスト注入手段の比較は以下の通りです。

| 方式 | 動作原理 | 長所 | 短所 / Ubuntu 24.04 (GNOME/Wayland) での制約 |
| :--- | :--- | :--- | :--- |
| **現行 Sidecar**<br>(`XDG RemoteDesktop` + `Clipboard Portal`) | PyGObject 経由で XDG Desktop Portal の `RemoteDesktop` (VirtualKeyboard) および `Clipboard` API を操作。 | ・root権限や `input` グループ権限が不要。<br>・サンドボックス/ポータル規格に準拠。 | ・`Ctrl+V` 擬似入力に依存するため、`Ctrl+Shift+V` 必須のターミナルで入力が沈黙する。<br>・クリップボード復元（`restoreDelayMs` 1500ms）のタイムレースが発生。 |
| **`ydotool`**<br>(`ydotoold` デーモン) | 背景で動作する `ydotoold` が `/dev/uinput` に仮想キーボードを作成し、コマンド経由でキー送信。 | ・ディスプレイサーバー (Wayland/X11) に依存せず確実にキーを注入可能。 | ・`ydotoold` デーモンの常駐と `/dev/uinput` へのアクセス権限（`input` グループ所属等）が必要。<br>・キー配列（IME）依存の問題が残る。 |
| **直接 `/dev/uinput`**<br>(アプリ/Sidecarからの直操作) | Linux カーネルの `/dev/uinput` キャラクターデバイスに `struct input_event` を直接書き込み。 | ・D-Bus/ポータル等のオーバーヘッドゼロ。<br>・キー操作の遅延が極小かつ確実。 | ・`/dev/uinput` への書込権限（udevルール + `input` グループ権限）が必要。 |
| **`wtype`**<br>(`zwp_virtual_keyboard_v1`) | Wayland 仮想キーボードプロトコルを直叩きして文字列を出力。 | ・クリップボードを経由せずに直接文字入力が可能。 | **【重要】Ubuntu 24.04 の GNOME (Mutter) は `zwp_virtual_keyboard_v1` 非対応**のため、動作せず完全に失敗する。 |

---

### 2. 現行 Sidecar 方式が端末アプリ（Terminal）で沈黙する技術的根拠

1. **ショートカットの不一致と Wayland Selection 未消費**
   - Claude Desktop 等の GUI アプリは `Ctrl+V` でクリップボード読み出し（`wl_data_offer.receive`）を開始します。
   - 一方、Linux の主要ターミナル（GNOME Terminal, Ptyxis, Alacritty, Kitty 等）では、`Ctrl+V` はペーストではなく readline の **`verbatim-insert`（次に押された文字をリテラル挿入するエスケープ状態）** として処理されます（ターミナルのペーストは `Ctrl+Shift+V` または `Shift+Insert`）。
   - ポータルが `Ctrl+V` を送信してもターミナルはクリップボード読み取り IPC を発行しないため、文字が一切入らず沈黙します。しかし D-Bus ポータルへのキーイベント送信自体は成功しているため、Sidecar は `injected=true` を返します。

2. **クリップボード復元処理（Restore）による転送キャンセル**
   - [pasteTiming.ts](file:///src/main/inject/pasteTiming.ts) で Wayland の `restoreDelayMs` は 1500ms に設定されています。
   - ターミナルが `Ctrl+V` を無視してクリップボードを要求しないまま 1500ms が経過すると、Sidecar はクリップボードを元の値（`old_text`）に復元します。結果としてテキストデータは一度も読まれないまま破棄されます。

---

### 3. 原因仮説と修正案（最大4件・根拠付き）

#### 仮説 1: ターゲットアプリに応じたペーストショートカットの未対応 (`Ctrl+V` vs `Ctrl+Shift+V`)
- **根拠**:
  ログでは `wayland paste: sidecar result ok=true injected=true restored=true` と成功を記録していますが、ターミナルエミュレータは `Ctrl+V` をペーストキーとして受け付けません。
- **修正案**:
  [activeWindow.ts](file:///src/main/context/activeWindow.ts) 等でフォーカス中のウィンドウのクラス名/プロセス名を取得し、ターミナル系アプリ（`gnome-terminal`, `ptyxis`, `alacritty`, `kitty`, `konsole` 等）の場合は `portalSidecar.pasteText` に送るショートカットを `Ctrl+Shift+V` または `Shift+Insert` に切り替える処理を追加します。

#### 仮説 2: ターミナルの `verbatim-insert` 状態突入と `HotkeyManager` / `evdev` 修飾キー状態の固着
- **根拠**:
  「ターミナルに入らない → 以後 Claude Desktop にも入らなくなった」という現象は、`Ctrl+V` 受信によりターミナルが quoted-insert モードに固定された後、ユーザーの PTT（Push-To-Talk）キー離脱や PTT 復帰イベントがターミナルにリテラル文字として吸い込まれ、[manager.ts](file:///src/main/hotkey/manager.ts) や [evdev.ts](file:///src/main/hotkey/evdev.ts) 内の修飾キー状態（`modifierState` / `heldDown`）が不整合を起こしたことを示しています。修飾キー状態が追従できなくなると、Claude Desktop に戻った後も `untilAllModifiersUp` がタイムアウトし続けるか、合成 `Ctrl+V` が `Alt+Ctrl+V` 等に化けてペーストが失敗します。
- **修正案**:
  1. クリップボード注入完了時、[manager.ts](file:///src/main/hotkey/manager.ts) の `resetState()` を呼び出して修飾キーの保持状態を強制クリアする。
  2. `evdev.ts` のデバイス削除時・再スキャン時に物理 `/dev/input/event*` の状態と同期を再検証する処理を入れる。

#### 仮説 3: クリップボード未消費に伴う `portal-remote.py` (Wayland `wl_data_source`) のパイプ閉塞・デッドロック
- **根拠**:
  Wayland のクリップボード提供 (`set_selection`) は非同期 IPC です。ターミナルがデータを読み出さない場合、`portal-remote.py` (PyGObject) 側の `wl_data_source` イベントループに未処理のセレクションオファーが残留します。この状態で 1500ms 後に `set_selection(old_text)` による復元が呼ばれると、D-Bus / GTK の Wayland イベントループがパイプ閉塞または Blocking エラーを起こし、Sidecar の通信スレッドが応答不能になります。結果として、以降の Claude Desktop へのペースト時も Sidecar はレスポンスを返せなくなるか選択領域の所有権確保に失敗します。
- **修正案**:
  `portal-remote.py` 内で `set_selection` や `restore` を実行する際、直前の未消費 `wl_data_source` オファーを明示的にキャンセル・タイムアウト解放する処理を追加し、ソケットの閉塞を防ぎます。

#### 仮説 4: GNOME Portal セッションの離脱・失効と上限到達 (`MAX_RESPAWNS = 5`)
- **根拠**:
  初期ログに `portal sidecar session failed (code=2 denied=false)` および `portal sidecar gave up after repeated exits` が記録されています。画面ロック時や D-Bus 再起動時に Mutter は `RemoteDesktop` ポータルセッションを破棄 (code=2) します。[portalSidecar.ts](file:///src/main/linux/portalSidecar.ts) の `MAX_RESPAWNS = 5` に達すると Sidecar は永久に再起動を諦めます。一度この状態に陥ると `isReady()` が `false` となり、以降の dictation はすべて失敗メッセージまたは手動ペースト要求になります。
- **修正案**:
  ユーザーがホットキーを押下した際、[portalSidecar.ts](file:///src/main/linux/portalSidecar.ts) の `retryForDictation()` を呼び出して `respawns` カウンタをリセットし、セッション失効時でも自動復旧できるように改善します。また、GNOME の ScreenSaver 解除 D-Bus シグナルを検出して `portalSidecar.restart()` を自動実行します。

---

RV2DONE2

## agy-lx2-3.md
^DLinux (Ubuntu 24.04 / GNOME 46 / Wayland) 環境における Electron 音声入力アプリ **WindVoice** のテキスト注入不具合について、【GNOME の `xdg-desktop-portal` (RemoteDesktop / Clipboard) のバージョン差・権限失効が注入に与える影響】の観点から原因仮説と修正案をまとめました。

---

### 【原因仮説 1】GNOME RemoteDesktop ポータルセッションのサイレント失効（`code=2`）と Sidecar の偽成功報告

* **原因メカニズム**:
  Ubuntu 24.04 (GNOME 46) の `xdg-desktop-portal-gnome` では、画面ロックや特定アプリ（ターミナル等）へのフォーカス移動、セッション復元トークンの期限切れが発生した際、`org.freedesktop.portal.RemoteDesktop` の仮想キーボード注入（`NotifyKeyboardKeycode`）権限が Mutter（Wayland コンポジタ）側で無効化される場合があります。
  この時、D-Bus 呼び出し自体はエラーを返さない（または `portal-remote.py` が D-Bus 送信完了のみで `injected=true` を返却する）ため、`portalSidecar.ts` はログの通り `ok=true injected=true` を出力し続けます。過去ログにある `session failed (code=2 denied=false)` の通り、`denied=false`（拒否ではなく過渡的セッション破壊）のまま内部セッションが非正常状態に落ちると、Sidecar は再構築を行わず、ターミナルへの注入不発後に Claude デスクアプも含めて一切の仮想キー注入がサイレントドロップされます。
* **コード・ログ根拠**:
  * ログ: `portal sidecar session failed (code=2 denied=false)`
  * [portalSidecar.ts](file:///src/main/linux/portalSidecar.ts): `onEvent('failed')` 内で `this.denied = msg.denied === true` の判定を行っていますが、`denied=false` でセッションが閉じた後に再接続が不完全な状態でも `isReady()` が `true` を返し続け、Mutter 側でキーが破棄されていても `injected: true` を報告します。
* **修正案**:
  1. `portalSidecar.ts` にセッションのヘルスチェックを導入し、`code=2` 発生時や一定時間経過後に `RemoteDesktop` セッションを強制再接続 (`restart()`) する。
  2. Sidecar の仮想キー送信処理で D-Bus 応答の正常性を厳密に検証し、送信不全を検知した場合は `injected=false` を返してクリップボード手動貼り付け通知にフォールバックさせる。

---

### 【原因仮説 2】ターミナルアプリにおける貼り付けショートカット（Ctrl+V vs Ctrl+Shift+V）の不一致

* **原因メカニズム**:
  GNOME Terminal などの Linux ターミナルエミュレータは、デフォルトで `Ctrl+V` を貼り付けショートカットとして認識せず、`Ctrl+Shift+V`（または `Shift+Insert`）を要求します。
  `sendPasteKeystroke()` および `portalSidecar.keyPaste()` は一律 `Ctrl+V` のキーコードを送信するため、`xdg-desktop-portal` の RemoteDesktop 経由で仮想キー `Ctrl+V` が正常にターミナルに届いていても、ターミナル側で無視（または制御文字入力として処理）されます。ポータル側はキーイベントの送信成功をもって `ok=true injected=true` と報告するため、ログと実際の動作に乖離が生じます。
* **コード・ログ根拠**:
  * [paste.ts](file:///src/main/inject/paste.ts) および [pasteWin32.ts](file:///src/main/inject/pasteWin32.ts): Wayland 環境で `portalSidecar.keyPaste()`（`Ctrl+V` 固定）を呼び出しています。フォーカスされているターゲットウィンドウの種別（ターミナルか否か）に応じた修飾キーの動的切り替えロジックが存在しません。
* **修正案**:
  1. [orchestrator.ts](file:///src/main/dictation/orchestrator.ts) で `getActiveWindow()` によりアクティブアプリのプロセスクラス / Window Class を取得し、ターミナル系アプリ（`gnome-terminal`, `pty`, `alacritty`, `kitty` 等）の場合は `Ctrl+Shift+V` を送信するよう `portalSidecar.pasteText()` / `keyPaste()` を拡張する。

---

### 【原因仮説 3】Clipboard ポータルの選択領域復元（`SetSelection`）とターミナルの処理遅延による競合

* **原因メカニズム**:
  [pasteTiming.ts](file:///src/main/inject/pasteTiming.ts) では Wayland の最低待機時間 `WAYLAND_MIN.restoreDelayMs` が `1500ms` に設定されています。`portalSidecar.pasteText()` は `text` をクリップボード (`SetSelection`) に書き込んだ後 `Ctrl+V` を注入し、1500ms 後に元のクリップボード文字列 (`old.text`) へ自動復元します。
  ターミナル等で `Ctrl+V` が無視されたり処理が遅延したりした場合、アプリがクリップボード (`SelectionRead`) を読み取る前に 1500ms が経過して元のデータに上書き復元されます。さらに、GNOME 46 の `xdg-desktop-portal-gnome` では、選択領域の復元要求（`SetSelection`）が頻繁に行われると Mutter 側の Selection Owner Token が同期不全を起こし、ポータル側は `SetSelection` 成功 (`ok=true`) を返しつつも Mutter 側で新しい選択領域の主張が拒否され、以降 Claude に戻ってもクリップボード貼り付けができなくなります。
* **コード・ログ根拠**:
  * [pasteTiming.ts](file:///src/main/inject/pasteTiming.ts): `restoreDelayMs: 1500`
  * [typer.ts](file:///src/main/inject/typer.ts) & [portalSidecar.ts](file:///src/main/linux/portalSidecar.ts): ターゲットアプリが実際に クリップボードデータを読み取ったか（`SelectionRead`）を検証せずに復元ロジックを実行しています。
* **修正案**:
  1. クリップボード復元前に `snapshot()` による検証を行うか、復元処理で Selection の所有権が維持されているかチェックする。
  2. 貼り付け処理ごとにポータルの Selection Token 状態をクリア・リフレッシュし、Mutter 側の選択所有権が消失した場合は即座にセッションを再登録する。

---

### 【原因仮説 4】Wayland Native と XWayland 間の クリップボード Bridge 同期破綻

* **原因メカニズム**:
  Ubuntu 24.04 GNOME Wayland 環境において、Claude Desktop（XWayland または Wayland native）と Terminal（Wayland native）の間で表示プロトコルが異なる場合、GNOME の `xdg-desktop-portal`（`org.freedesktop.portal.Clipboard`）が行う `SetSelection` は Wayland 側の `CLIPBOARD` にセットされます。
  フォーカスが Wayland Native ウィンドウと XWayland ウィンドウ間を移動した際、Mutter の `xwayland-clipboard-manager` によるクリップボード同期ブリッジが切断またはタイムアウトすると、ターゲット側でクリップボードが空と認識されます。一度この同期破綻が起きると、Sidecar 側の内部選択状態とコンポジタの選択状態が剥離し、以降の `SetSelection` 呼び出しも D-Bus 上で成功ステータス (`ok=true`) を返し続けながらコンポジタ側で棄却され、Claude に戻った後もテキストが入らなくなります。
* **コード・ログ根拠**:
  * [portalSidecar.ts](file:///src/main/linux/portalSidecar.ts): ポータル経由でクリップボード書き込み (`set_selection`) を行った後、ターゲットプロトコル（Wayland vs XWayland）への同期確認や書き戻し検証（Read-back Check）を行っていません。
* **修正案**:
  1. クリップボード書き込み後、`snapshot()` を用いて実際にテキストがコンポジタに保持されたか読み戻しチェックを行う。
  2. 同期不全が検出された場合はポータルサイドカーのクリップボード所有権を再取得し、Mutter のクリップボードブリッジを強制再動調させる。

---

RV2DONE3

## agy-lx2-4.md
^DLinux (Ubuntu 24.04 / GNOME 46 / Wayland) 環境における Electron 音声入力アプリ **WindVoice** の AppImage 展開実行（`AppRun` 直叩き）時特有のバグ調査報告です。

ご提示いただいたログでは、サイドカー側は `wayland paste: sidecar result ok=true injected=true restored=true` と成功を返しているにもかかわらず、ターミナルへの入力失敗を境に以降全アプリ（Claude含む）へのテキスト注入ができなくなっています。

観点である **「AppImage展開実行特有の問題（ライブラリ解決・環境変数・相対パス・sandbox）」** および **「GNOME/Wayland ポータル・ターミナル貼り付けメカニズム」** に基づき、4つの原因仮説と修正案を根拠付きで提示いたします。

---

### 仮説1: AppRun が設定する環境変数（`LD_LIBRARY_PATH` 等）の `python3` サイドカーへの引き継ぎによる ABI / ライブラリ競合 (ライブラリ解決問題)

- **原因仮説**:
  AppImage を展開して `AppRun` を直接実行した場合、`AppRun` スクリプトは `$APPDIR/usr/lib` などの展開ディレクトリ内のライブラリパスを `LD_LIBRARY_PATH` にセットして Electron を起動します。
  WindVoice のメインプロセスが [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts) 内で `spawnChild('python3', ...)` を実行する際、子プロセスであるホストの `python3` に親の `process.env`（`LD_LIBRARY_PATH` 含む）がそのまま引き継がれます。
  これにより、ホスト OS（Ubuntu 24.04）の `python3`（および `PyGObject` / `gi` モジュール）が D-Bus / GIO と通信する際、AppImage 内に同梱された古い・または互換性のない `libgio-2.0.so` や `libdbus-1.so` 等を動的にロードしてしまい、D-Bus 通信やポータル処理で静的な ABI 不整合が発生します。ポータル側はキー送信を受理したフリ (`ok=true`) を返しますが、実際には Wayland セッションへの正しい Keycode 伝達やクリップボード所有権の通知が行われなくなります。
- **根拠**:
  [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L125-L129) の `spawnChild` 呼び出し部:
  ```ts
  child = this.spawnChild('python3', [script, tokenPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  ```
  `env` オプションが指定されていないため、AppImage 由来の `LD_LIBRARY_PATH` や `PYTHONPATH` が全引き継ぎされます。ホストの Python と AppImage 内の共有ライブラリが衝突する AppImage 展開実行典型のトラブルです。
- **修正案**:
  `spawnChild` 実行時に `env` オプションを明示し、`LD_LIBRARY_PATH` や `PYTHONPATH` から AppImage 由来のパスを除外（またはホスト標準の環境変数へサニタイズ）して `python3` を起動するように変更します。

---

### 仮説2: Linux ターミナルの `Ctrl+V` (Quoted-Insert: `^V`) 解釈による入力不全と修飾キー状態ロック (キーバインド・プロトコル問題)

- **原因仮説**:
  Linux の多くのターミナル（GNOME Terminal, xterm, Alacritty 等）では、貼り付けショートカットは `Ctrl+Shift+V` であり、`Ctrl+V` は **Quoted-Insert**（次に押されたキーをエスケープしてリテラル入力する状態）として解釈されます。
  WindVoice は Wayland 環境でも [`pasteWin32.ts`](file:///src/main/inject/pasteWin32.ts) / [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts) 経由で一律 `Ctrl+V` をポータルキー注入しています。
  ターミナルに dictation を実行すると `Ctrl+V` が注入されますが、ターミナル側は貼り付けではなく Quoted-Insert 待機状態 (`^V`) に入るため、クリップボードが参照されずテキストが一切挿入されません。
  さらに、ターミナルが入力待機状態のまま [`pasteTiming.ts`](file:///src/main/inject/pasteTiming.ts#L84) の Wayland リストア遅延（1500ms）が経過してクリップボードが元に戻されると、HotkeyManager や Wayland ポータル仮想キーボード側の Ctrl モディファイアキー解放タイミングが狂います。結果として Ctrl キーが押下されたままロックされた状態になり、フォーカスを Claude デスクトップに戻した後も全入力が不全となります。
- **根拠**:
  1. [`pasteWin32.ts`](file:///src/main/inject/pasteWin32.ts#L107-L113) で Linux 向けに `Ctrl+V` を一律送信している点。
  2. ログにおいて `injected=true` にもかかわらずターミナルへ文字が入らない現象と、その直後の dictation から `ignored start for primary: dictation still active` や入力不能が発生している点。
- **修正案**:
  アクティブウィンドウがターミナル系アプリ（`gnome-terminal`, `pty`, `alacritty` 等）の場合は `Ctrl+Shift+V` を送信するように [`sendPasteKeystroke()`](file:///src/main/inject/paste.ts) およびサイドカー側のキーバインド選択ロジックを修正します。

---

### 仮説3: AppImage 展開実行時の `cwd` 依存と `resolveSidecarScript` のパス解決失敗、および Chromium Sandbox 制限 (相対パス・Sandbox問題)

- **原因仮説**:
  AppImage を展開して `./AppRun` を直接実行、あるいは展開ディレクトリ外の別 Working Directory (`cwd`) から `AppRun` を呼び出した場合、[`resolveSidecarScript()`](file:///src/main/linux/portalSidecar.ts#L430) による `portal-remote.py` の相対パス探索 (`process.resourcesPath` や `app.getAppPath()`) が失敗するか、意図しない旧バージョンのスクリプトが参照されるリスクがあります。
  また、AppImage 展開実行時に Electron が起動する際、GNOME / Wayland 環境下で `--no-sandbox` 適切なパーミッション処理がなされていないと、Electron の Sandbox 制限により spawn された `python3` プロセスから `/run/user/$UID/bus` (D-Bus セッションバス) や D-Bus トークン保存ファイル (`.portal-remotedesktop.json`) への I/O アクセスが制限されます。
  初期起動時のログでも `portal sidecar session failed (code=2 denied=false)` や `portal sidecar gave up after repeated exits` が頻発しており、権限やパス解決の不完全さが伺えます。
- **根拠**:
  [`portalSidecar.ts`](file:///src/main/linux/portalSidecar.ts#L430-L452) の `resolveSidecarScript`:
  ```ts
  candidates.push(
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'native', 'portal-remote.py'),
    path.join(process.resourcesPath, 'native', 'portal-remote.py')
  );
  ```
  `process.resourcesPath` や `app.getAppPath()` は AppImage 展開実行の形態（squashfs 展開 / パス構成）によって指す先が変わるため、厳密な絶対パス解決が必須です。
- **修正案**:
  `resolveSidecarScript()` で環境変数 `APPDIR`（AppImage 展開時に設定される環境変数）を最優先で参照するようにパス解決ロジックを強化し、D-Bus トークン保存先 (`tokenPath`) の書き込み権限とアクセシビリティを保証します。

---

### 仮説4: GNOME Wayland XDG Desktop Portal セッションのフォーカス外ドロップとクリップボード非復元競合 (Wayland Portal フォーカス問題)

- **原因仮説**:
  GNOME Wayland (mutter) の XDG Desktop Portal (RemoteDesktop / Clipboard portal) は、セキュリティ上「現在アクティブなフォーカスウィンドウ」に対してのみキー注入や Selection クリップボード受け渡しを許可します。
  Claude デスクリートから GNOME Terminal（純 Wayland アプリ）へフォーカスを移動した際、mutter 側で WindVoice のポータルセッションと Terminal のフォーカスウィンドウの紐付け（`app_id` / ウィンドウ識別子）が一致せず、ポータル D-Bus 呼び出し自体は成功を返しても (`injected=true`)、mutter 側で Terminal への Keycode 送信がサイレントにドロップされます。
  さらに、`pasteText` 実行時に `restore=true` で 1500ms 後にクリップボードを復元する際、Terminal が Selection を fetch していない状態で復元が割り込むため、ポータルの Selection 所有権（selection ownership）が失われ、ポータルセッション内部状態が破綻します。結果としてサイドカープロセスは生存しているものの、それ以降 Claude デスクリートにフォーカスを戻しても二度とテキストが注入できなくなります。
- **根拠**:
  `portal-remote.py` は D-Bus Portal からの OK レスポンスに基づいて `injected=true` を返しますが、Wayland compositor (mutter) 内部でフォーカス未一致によりキーが破棄されたかどうかは D-Bus レスポンスからは判別できません。
  ログ上では `wayland paste: sidecar result ok=true injected=true restored=true` が並んでいますが、実際には注入がドロップされたままセッション状態が不整合を起こしています。
- **修正案**:
  1. フォーカス切り替え後や注入失敗を検知した際に、サイドカーのポータルセッションを再同期・再接続 (`portalSidecar.restart()`) するヘルスチェックを追加します。
  2. Wayland 環境下ではターゲットアプリの読み込み完了を待たずにクリップボードを復元する挙動を見直すか、ターミナル等のアプリに対しては `restoreClipboard=false` を推奨・適用できるオプションを提供します。

---

RV2DONE4

## agy-lx2-5.md
^Dご提示いただいた宝ログおよび Linux 注入系ソースコード（`portalSidecar.ts`, `streamingTyper.ts`, `typer.ts`, `evdev.ts`, `manager.ts` 等）を分析し、**【Electronのsingle-instanceと2度目の起動が状態を壊す可能性】** を軸とした原因仮説と修正案（最大4件・根拠付き）を報告いたします。

---

### 原因仮説と修正案

#### 1. 2度目のAppImage起動による GNOME Portal RemoteDesktop セッションの奪取と D-Bus サイレント失効
* **原因仮説**: 
  `src/main/linux/portalSidecar.ts` は `~/.config/windvoice/.portal-remotedesktop.json` に Restore Token を保存し、`python3 portal-remote.py` 経由で D-Bus の `org.freedesktop.portal.RemoteDesktop` セッションを維持しています。AppImage を複数回起動した際、`app.requestSingleInstanceLock()` の判定前または重複起動時のメインプロセス初期化段階で第2インスタンスが `portalSidecar.start()` を実行すると、同一の Restore Token を用いて GNOME の Portal セッションを新規構築・上書きします。
  この結果、GNOME (Mutter / `xdg-desktop-portal-gnome`) 側で第1インスタンスの既存 RemoteDesktop セッションが切断・無効化されます。第2インスタンスが Single Instance Lock を検知して即座に終了 (`app.quit()`) すると新セッションも削除され、第1インスタンスの Sidecar (`portal-remote.py`) は無効化された D-Bus ハンドルを保持したまま孤立します。
  D-Bus 経由の `NotifyKeyboardKeycode` や `SetSelection` 呼び出しは無効化されたセッションに対してもエラーを投げずに成功レスポンスを返す場合があるため、Sidecar はログに `ok=true injected=true` と成功報告を出し続けますが、GNOME コンポジタ側では仮想キー入力およびクリップボード所有権の変更が完全に無視・破棄され、全アプリに入力できなくなります。
* **修正案**: 
  `app.requestSingleInstanceLock()` のチェックを `portalSidecar` を含む全モジュールの初期化より最優先で行い、ロック取得失敗時は一切のサイドカーを起動せずに即座に終了 (`process.exit(0)`) させます。また、`second-instance` イベント受信時には第1インスタンス側で `portalSidecar.restart()` を呼び出し、D-Bus リモートデスクトップセッションを安全に再構築します。

---

#### 2. `evdev` デバイスの二重オープンによる修飾キー状態の不整合とペースト待ちタイムアウト
* **原因仮説**: 
  `src/main/hotkey/evdev.ts` (`EvdevKeyboardMonitor`) は Wayland 下で `/dev/input/event*` を同期オープンしてグローバルキーボードフックを実現しています。2度目の AppImage 起動により一時的でも第2インスタンスが立ち上がると、同じ `/dev/input/event*` ファイル記述子が重複オープンされ、入力ストリームの競合が発生します。
  これにより `src/main/hotkey/manager.ts` の `modifierState` や `untilAllModifiersUp` の修飾キー状態管理が狂い、Ctrl や Alt キーが「押しっぱなし」と誤認識されます。ペースト処理時の `untilAllModifiersUp(600)` が毎回タイムアウトを起こすか、`Alt+Ctrl+V` 等の不正な合成キーとしてコンポジタに送られるため、ターミナルや他アプリへの入力が一切受け付けられなくなります。
* **修正案**: 
  `evdev.start()` の実行を Single Instance Lock 取得成功後に厳密に限定し、2重起動検知時やアプリ終了プロセスにおいて `evdev.stop()` を確実に呼び出して FD を解放します。

---

#### 3. ターミナルアプリにおける `Ctrl+V` ショートカット不整合と Wayland クリップボード復元タイマーの競合
* **原因仮説**: 
  `src/main/inject/pasteWin32.ts` および `src/main/inject/paste.ts` / `portalSidecar.ts` では、Wayland 上でのペーストに一律 `Ctrl+V` を RemoteDesktop Portal 経由で注入しています。しかし、GNOME Terminal や Ptyxis などの一般的な Linux ターミナルはデフォルトの貼り付けショートカットが `Ctrl+Shift+V` であり、`Ctrl+V` は無視されるか `lnext` (リテラル文字入力) として処理されるためターミナルに入力が入リません。
  さらに `src/main/inject/pasteTiming.ts` の Wayland 最低復元遅延 `WAYLAND_MIN.restoreDelayMs` (1500ms) 経過後、`portalSidecar.pasteText` は元のクリップボード内容を自動復元 (`set_selection(old.text)`) します。ターミナルがペーストを消費しないままクリップボードが元に戻るため、ターミナルへの注入失敗後もログ上は `ok=true injected=true restored=true` と記録されます。
* **修正案**: 
  `activeWindow` 情報からフォーカス中のウィンドウがターミナル系アプリであるかを判定し、ターミナルに対しては `Ctrl+Shift+V` を送信する条件分岐を追加します。

---

#### 4. `PortalSidecar` / `StreamingTyper` 間の非同期セッション応答遅延と子プロセス再起動時の状態孤立
* **原因仮説**: 
  ログ中 `13:58:42.249Z [hotkey] ignored start for primary: dictation still active` や連続入力時のログが示す通り、短時間での録音完了や貼り付け要求が重なっています。
  `src/main/inject/streamingTyper.ts` や `portalSidecar.ts` で D-Bus / Portal の応答待ち中に第2インスタンスの割り込みや D-Bus 再接続が発生すると、`portalSidecar` 内部の `pending` Map で 15秒のタイムアウトが発生して `teardownChild` -> `requestRespawn` が実行されます。Sidecar 自体は自動復帰して `ready` 状態になりますが、`StreamingTyper` や `DictationOrchestrator` 側に保持されていた古い `inFlight` プロミスや `waylandOld` スナップショットが破綻状態（`manualPasteRequired = true` やハング状態）のまま残り、それ以降の入力要求がすべて無視・キャンセルされる状態に陥ります。
* **修正案**: 
  `portalSidecar.ts` の `teardownChild` / 再起動発生時に、進行中の全 `StreamingTyper` / `pasteText` セッションに対してエラーイベントを発行し、`streamingTyper` および `DictationOrchestrator` の状態を安全にリセット・再初期化できるように改善します。

---

RV2DONE5

## agy-lx2-6.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) 環境における Electron 音声入力アプリ **WindVoice** のテキスト注入・ペースト処理に関するバグ調査報告です。

ご掲記いただいた現象（Claude Desktopでは入力成功 → 端末（Terminal）に切り替えた途端に一切入らなくなる → その後Claude Desktopにも入らなくなる / ログは全件 `ok=true injected=true` と成功報告）およびソースコードの解析に基づき、**クリップボードマネージャ**や**端末のブラケットペースト（Bracketed Paste）**との相互作用に焦点を当てた原因仮説と修正案を最大4件報告いたします。

---

### 仮説1: 端末の `Ctrl+V` (quoted-insert) 解釈および修飾キー（Ctrl）固着によるテキスト飲込と後続入力の全麻痺

- **原因仮説:**
  Linuxの標準的な端末（GNOME Terminal, Ptyxis, Alacritty等）において、`Ctrl+V` はペーストショートカット（`Ctrl+Shift+V` やブラケットペースト `\e[200~` ... `\e[201~`）ではなく、readline/zshの `quoted-insert` (次の制御文字をエスケープ入力するモード) として解釈されます。
  1. WindVoiceのポータルSidecarが仮想キーボード経由で `Ctrl+V` を注入した際、端末はペーストを行わず `quoted-insert` 状態となり、注入テキストを読み込まず飲み込みます。
  2. この時、ポータル仮想キーボードまたはOS側で `Ctrl` 修飾キーの解除（KeyUp）が正常に完了せず固着状態（stuck modifier）に陥ります。
  3. その結果、ユーザーがClaude Desktopへフォーカスを戻した後も、以降のキー注入や操作が `Ctrl` キー押下状態として処理され、すべてのテキスト入力がショートカット誤動作等により飲み込まれる状態となります。
  4. ポータルへの D-Bus 仮想キー送信命令自体は成功しているため、ログには一貫して `ok=true injected=true` が記録されます。

- **根拠:**
  - `src/main/inject/pasteWin32.ts` および `portalSidecar.ts` ではペースト用に一律 `Ctrl+V` を送信しています。
  - `src/main/inject/pasteTiming.ts` のコメントにある通り、Waylandポータルの D-Bus 仮想キーボードと Wayland セレクション要求は非同期であり、修飾キー状態の不一致がアプリ跨ぎで波及しやすい構造になっています。

- **修正案:**
  - 端末アクティブ時（またはLinux全般でのペースト時）に、`Ctrl+Shift+V` を送信するペーストキープロファイル分岐を追加する。
  - `keyPaste` / `pasteText` の実行直前・直後に、ポータル仮想キーボードに対して明示的な修飾キー全解除（`Ctrl` / `Shift` の強制KeyUp）パケットを発行する。

---

### 仮説2: クリップボードマネージャ（GPaste/CopyQ等）によるセレクション即時奪還と復元処理（restoreDelayMs）の競合による転送遮断

- **原因仮説:**
  GNOME環境でクリップボードマネージャ（GPaste, CopyQ, Diodon, GNOME Shell Clipboard等）が常駐している場合、Sidecarが `set_selection` で音声認識テキストを Wayland クリップボードにセットした瞬間、クリップボードマネージャが `wl_data_device` 経由で即座にデータ読み出しと履歴保存を行います。
  1. 端末（特にブラケットペースト処理や入力パースを行う端末）が Wayland パイプからテキストを読み取る前に、Sidecarが `restoreDelayMs` (1500ms) 経過後に元のクリップボード内容（`oldText`）を復元（`set_selection`）します。
  2. あるいは、クリップボードマネージャが履歴更新完了に伴い独自のセレクション所有権を主張して `oldText` を書き戻します。
  3. 端末が `Ctrl+V` を受信してセレクション要求を行った時点では、既にデータソースが `oldText` に差し替わっているか無効化されており、端末はテキストを受け取れず飲み込みます。
  4. クリップボードマネージャによって Wayland セレクション所有権が固着・上書きされると、以降 Sidecar が `set_selection` を呼び出して成功レスポンス（`ok=true`）を得ていても、実際には compositor 上でクリップボードマネージャのセレクションが優先され、Claude Desktop でもテキストが入力できなくなります。

- **根拠:**
  - `src/main/inject/pasteTiming.ts` 内のコメントに「With the stock 180ms 'balanced' restore delay the target routinely reads the clipboard AFTER we have already restored it...」と記載されており、復元タイミングとターゲットの読み取りタイミングの競合が構造的課題として存在しています。
  - Sidecar 内の `pasteText` は `restore=true` の場合、タイマー経過後に自動で `set_selection(old)` を実行しますが、クリップボードマネージャが存在すると Wayland セレクション所有権の奪い合いが発生します。

- **修正案:**
  - Wayland環境ではターゲットアプリによる `wl_data_source.cancelled` やパイプ読込完了を検知するまで復元を保留するか、復元処理（restore）を無効化する設定オプションを提供する。
  - クリップボードマネージャ常駐を考慮し、セレクションセット後に他のアプリによって所有権が即座に奪取されていないかを検証するガードを追加する。

---

### 仮説3: XWayland <-> Wayland セレクションブリッジ（xwayland-clipboard）と Sidecar データソースの不整合・同期破綻

- **原因仮説:**
  Claude Desktop（Electronアプリ）は多くの場合 XWayland 上で動作し、GNOME Terminal や Ptyxis は Wayland ネイティブで動作します。GNOME (Mutter) は両者間のクリップボード共有を `xwayland-clipboard` ブリッジを介して管理しています。
  1. 最初、Claude Desktop (XWayland) へのペーストは正常に行われます。
  2. 次に Wayland ネイティブの端末へ切り替えてペーストを行った際、端末側のブラケットペースト失敗やクリップボードマネージャの割り込みにより、Wayland ポータル Sidecar と `xwayland-clipboard` ブリッジ間のセレクション所有権同期が破綻（データソースの無効化）します。
  3. この同期破綻が発生すると、Python Sidecar (`portal-remote.py`) 側では `set_selection` 自体は成功（`ok=true`）していても、Mutter や XWayland ブリッジ側から「所有権なし / 無効なデータソース」として拒否されます。
  4. そのため、再度 Claude Desktop (XWayland) に戻って音声入力を試みても、XWayland ブリッジが古いクリップボード内容を返し続けるため、テキストが一切入力されなくなります。

- **根拠:**
  - `src/main/inject/typer.ts` に「...bridged through XWayland's selection sync when owner and target live on different display protocols」とあり、XWayland クライアントと Wayland ネイティブクライアント間の表示プロトコルを跨いだペースト切替がトリガーとなっている点と合致しています。

- **修正案:**
  - ペースト試行ごとに `portalSidecar` の Wayland セレクションデータソースが生存しているか確認し、異常検出時には Sidecar の D-Bus セッションを再初期化（`restart()`）する。
  - Sidecar の MIME タイプ提供（Offer）において、X11/Wayland 双方のブリッジ互換フォーマット（`text/plain;charset=utf-8`, `UTF8_STRING`, `STRING` 等）を完全網羅してブリッジの同期失敗を防ぐ。

---

### 仮説4: 端末ペースト時の Wayland Pipe 読出未完了による Python Sidecar イベントループ固着（非同期デッドロック）

- **原因仮説:**
  認識結果テキストを端末へ注入する際、Wayland プロトコルでは UNIX ドメインソケットのパイプ（`wl_data_offer.receive`）を経由してデータが転送されます。
  1. 端末側がブラケットペーストモード処理中や入力バッファリング中でパイプからの読み込みが遅延した場合、またはクリップボードマネージャとの多重アクセスが発生した場合、Python Sidecar (`portal-remote.py`) 側の書き込み処理がブロックされます。
  2. Sidecar 側でペーストタイムアウトまたは `restore` 処理が介入すると、PyGObject の GTK/GDK イベントループ内で `wl_data_source` のパイプ転送ハンドラが非クリーン状態のまま無効化されます。
  3. パイプが中途半端に切断された端末はテキストを読み込めず飲み込みます。
  4. さらに、Sidecar 内部の D-Bus / Wayland イベントループがソケットのブロックまたは不正状態により固着し、以降 Main プロセスからの JSON RPC リクエスト（`paste` / `set_selection`）に対して `ok: true, injected: true` を返しつつも、実際には Wayland クリップボードへのデータ提供を行わなくなります。

- **根拠:**
  - `src/main/linux/portalSidecar.ts` では `MUTATING_OPS` に対するタイムアウト処理や `uncertain` フラグ処理が実装されていますが、Python Sidecar 内部の GTK イベントループおよび Pipe 読込処理の非同期ブロックは Main プロセス側のログ（`ok=true injected=true`）から直接検知できません。
  - ログに `wayland paste: sidecar result ok=true injected=true restored=true` が出力され続けていることは、Main プロセスと Sidecar 間の IPC 自体は応答しているものの、Wayland プロトコル層でのテキスト転送がストップしている状態を裏付けています。

- **修正案:**
  - `portal-remote.py` 内部の Pipe データ転送処理（`SelectionWrite`）にノンブロッキング I/O と厳密なタイムアウトを設定し、読み出し遅延による GTK イベントループの固着を防止する。
  - クリップボード転送エラーやタイムアウト発生時には、Sidecar を安全に自動再起動（`restart()`）してデータソース状態をリフレッシュする。

RV2DONE6

## agy-lx2-7.md
^DLinux(Ubuntu 24.04 / GNOME / Wayland)環境における WindVoice の音声入力バグ調査報告です。

ご提示いただいたログおよびソースコード（`portalSidecar.ts`, `typer.ts`, `paste.ts`, `pasteTiming.ts`, `manager.ts` 等）に基づき、**【IME(日本語入力)経由の合成イベントとWaylandの相性・フォーカスアプリのIME状態の影響】**の観点から原因仮説と修正案を4件まとめました。

---

### 仮説1: ターミナルのショートカットキー不一致（Ctrl+V vs Ctrl+Shift+V）とIME Preedit（未確定状態）による制御キー捕捉・固着

- **原因仮説**:
  - Electronアプリ（Claude Desktop）等では `Ctrl+V` でテキストが貼り付けられますが、Linuxターミナル（`gnome-terminal`, `ptyxis` 等）の標準貼り付けショートカットは **`Ctrl+Shift+V`** です。ターミナルにおいて `Ctrl+V` は `lnext`（次の文字をリテラル入力するエスケープ機能）または `^V` 制御コードとして処理されます。
  - さらに、ターミナル側で日本語IME（IBus / Fcitx5）がON（日本語入力モード）になっている場合、Sidecarが合成した仮想キー `Ctrl+V` はIMEのPreedit（未確定入力）コンテキストやIMEショートカットフィルターに補獲・破棄されます。
  - ターミナルで `Ctrl+V` が入力として反映されず `lnext` 待機やIMEの未確定状態に陥ることで入力が一切入りません。さらにこの異常状態（未確定/エスケープ待機）がIMEコンテキストに残ると、以降Claudeデスクトップへフォーカスを戻してもIME入力状態が引き継がれ、後続の貼り付けイベントも全てブロックされます。
- **根拠**:
  - `src/main/inject/pasteWin32.ts` や `portalSidecar.py`（Sidecar）では一律 `Ctrl+V` のキーコードを合成送信しています。
  - Wayland Portal（`org.freedesktop.portal.RemoteDesktop`）の `NotifyKeyboardKeycode` はD-Bus層でイベント発行が成功すれば `injected=true` を返します。受信側アプリ/IMEがそのキーを解釈拒否・破棄したかどうかは検証できないため、ログ上は `ok=true injected=true` と成功報告されます。
- **修正案**:
  - アクティブウィンドウ（`getActiveWindow()`）がターミナルエミュレータ（`gnome-terminal`, `ptyxis`, `konsole`, `alacritty` 等）の場合は、`Ctrl+V` ではなく `Ctrl+Shift+V` を合成・送信する分岐を追加する。
  - 貼り付けキー送信前に、ターゲットアプリのIME状態を一時的に直接入力（Direct Input / English）モードへエスケープするかPreeditをクリアする。

---

### 仮説2: Waylandクリップボード（wl_data_offer）復元タイミングとIME/アプリ側の非同期読み出しレースによるデータ転送不全・固着

- **原因仮説**:
  - `portalSidecar.pasteText` は、Waylandのクリップボード選択肢を設定（`set_selection`）→ 仮想キー `Ctrl+V` 注入 → 1500ms待機（`WAYLAND_MIN.restoreDelayMs`）→ 元のクリップボードへ復元（`restore`）という手順を踏みます。
  - ターミナルや特定アプリでIMEが有効な場合、IME経由のイベント伝達遅延やターミナル側の処理遅延により、アプリが Wayland の `wl_data_offer.receive`（クリップボードデータ要求）を発行するのが遅れます。
  - アプリが実際にデータを受け取る前に、Sidecarが1500msタイマーで元のクリップボードへ書き戻してしまうと、データ提供 Pipe が切断・失敗します。
  - Waylandの選択肢転送が途中で異常終了すると、GNOME Shell / IBus 側のクリップボード同期スレッドやData Sourceがデッドロック（エラー状態）に陥り、それ以降 Claude Desktop を含む全アプリでクリップボード経由の貼り付けが一切機能しなくなります。
- **根拠**:
  - `src/main/inject/pasteTiming.ts` で Wayland 用に `restoreDelayMs: 1500` が強制設定されています。
  - ログの `wayland paste: sidecar result ok=true injected=true restored=true` は Sidecar が復元要求まで完了したことを示すのみで、ターゲットアプリ側での実際のクリップボードデータ読込完了を保証していません。
- **修正案**:
  - クリップボード復元を単純な固定タイマー（1500ms）ではなく、転送完了イベントを検知して行うか、Wayland環境ではクリップボード復元の遅延マージンを延長・オプション化（復元無効モードの提供）する。

---

### 仮説3: GNOME Wayland環境における Portal RemoteDesktop セッションの仮想キーボードフォーカス消失とStale化

- **原因仮説**:
  - GNOME Wayland環境のセキュリティ仕様により、Wayland Native ターミナルへフォーカスが切り替わった際、`org.freedesktop.portal.RemoteDesktop` の仮想キーボード入力がMutter（コンポジタ）レベルでフィルタリング・ドロップされる場合があります。
  - この時、D-Bus経由の `NotifyKeyboardKeycode` 自体は正常応答を返すため Sidecar は `injected=true` を返しますが、実際にはターミナル画面にキーが届きません。
  - さらに、ターミナルフォーカス時のイベントドロップや Pipe 異常に伴い、`portal-remote.py` と GNOME Portal 間の D-Bus / RemoteDesktop セッションが内部的に応答不能（Stale Session）状態になります。
  - `portalSidecar.ts` は Sidecar プロセスの生存（`child !== null`）と `isReady()` で状態を管理しているため、内部ポータルセッションが破壊されても再起動されず、以降 Claude Desktop にフォーカスを戻しても全てのキー注入が不発になります。
- **根拠**:
  - 過去のログ（`portal sidecar session failed (code=2 denied=false)`）にもある通り、Wayland Portal セッションは環境切替やフォーカス変化で切断されやすい性質があります。
  - `src/main/linux/portalSidecar.ts` の `isReady()` は `this.ready && this.clipboard && this.child !== null` のみで判定しており、コンポジタ側のセッション不全をリアルタイムに検知できていません。
- **修正案**:
  - `portalSidecar` で各貼り付け実行時にポータルセッションのヘルスチェックを行うか、レスポンス異常検知時に明示的に `restart()` を呼び出してポータルセッションを再構築する。

---

### 仮説4: IME経由での KeyUp イベント消失による修飾キー（Ctrl）の固定化（Stuck Modifier）

- **原因仮説**:
  - Linux / Wayland 環境において IME（IBus/Fcitx5）が有効な状態で仮想キーボードや物理キーを操作すると、`keyup` イベントが IME に吸収・ドロップされ、`HotkeyManager` やシステム側で `Ctrl` キーが押されっぱなし（Stuck）と誤判定される現象が発生します。
  - `Ctrl` キーがスタック状態になると、以降の全ての入力が `Ctrl + Key` とみなされます。ターミナルでは意図しないショートカットコードとして無視され、Claude Desktop にフォーカスを戻した後も通常のテキスト入力や貼り付けが全て拒否・無視される状態になります。
- **根拠**:
  - `src/main/hotkey/manager.ts` のコメント（Issue #34: `on Linux/X11, uIOhook can miss a keyup for physical Ctrl...`）および `untilAllModifiersUp` のタイムアウト記録ロジックが存在するように、Linuxでの修飾キーのスタックは既知の課題です。
  - `src/main/inject/typer.ts` や `streamingTyper.ts` でも `untilAllModifiersUp(600)` が使われていますが、`keyup` がドロップされた場合はタイムアウト後に不整合な修飾キー状態のまま処理が続行されます。
- **修正案**:
  - 貼り付け処理の直前・直後に修飾キー状態（`modifierState`）および IME 状態を明示的にクリア・リセットするセーフティネットを追加する。

---

RV2DONE7

## agy-lx2-8.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) 環境における Electron 音声入力アプリ **WindVoice** のバグ調査報告書です。

ご提示いただいた観点**【『成功と報告して実際は失敗』を仕組みで潰す設計（注入後のクリップボード検証・ユーザーへのフォールバック通知）】**に沿って、ログおよびソースコードから分析した**原因仮説と修正案（全4件・根拠付き）**を以下にまとめます。

---

### 原因仮説と修正案（全4件）

#### 1. ターミナル（Terminal）における Ctrl+V 非対応と D-Bus キー送信成功の誤判定（端末キー不一致 ＆ 盲目的成功報告）
- **原因仮説**:
  - Ubuntu/GNOME Terminal などの多くの Linux ターミナルは、貼り付けショートカットとして `Ctrl+Shift+V` を要求するため、`Ctrl+V` 送信はターミナル側で無視される（または制御文字 `^V` が送られて無効化される）。
  - しかし、`src/main/inject/paste.ts` および `portalSidecar.pasteText` は、Wayland Portal（VirtualKeyboard）経由で `Ctrl+V` の D-Bus キーイベント送信が成功した時点で `injected=true` を返す。ターゲットアプリが実際に貼り付け処理を行ったかどうかを検証していないため、ターミナルへの注入失敗時にも `ok=true injected=true` と誤報告される。
- **根拠**:
  - [src/main/inject/pasteWin32.ts](file:///src/main/inject/pasteWin32.ts#L86-L91) では Linux に対して `uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl])` 一律で Ctrl+V を送信している。
  - [src/main/linux/portalSidecar.ts](file:///src/main/linux/portalSidecar.ts#L368-L380) の `pasteText` は VirtualKeyboard のキー送信成功（`injected=true`）のみをチェックしており、アプリ側の受理状態を追跡していない。
- **修正案（設計）**:
  - `getActiveWindow()` によりフォーカスのあるアクティブウィンドウのプロセス名（`gnome-terminal`, `ptyxis`, `alacritty`, `kitty` 等）を判定し、ターミナル系アプリの場合は自動的に `Ctrl+Shift+V` キーシーケンスを送信する適応型キー注入機構を実装する。

---

#### 2. クリップボード復元（restoreClipboard）による音声テキストの即時消滅と検証の欠落
- **原因仮説**:
  - `restoreClipboard=true` が有効な場合、WindVoice は音声テキストを Wayland Selection にセットして `Ctrl+V` を送信した後、一定時間（`timing.restoreDelayMs` = 1500ms）経過すると自動的に「元のクリップボード内容」へ復元する。
  - ターミナル側で `Ctrl+V` が無視されると、ターゲットアプリは Selection の読み出しを行わない。その状態で 1500ms が経過すると、Sidecar は Selection を元の文字列に復元してしまい、音声テキストがクリップボードから消滅する。
  - 注入後に「ターゲットアプリがクリップボードを読み出したか」または「クリップボード上に音声テキストが維持されているか」の検証（Post-injection Clipboard Verification）が存在しないため、失敗を検知できない。
- **根拠**:
  - [src/main/inject/pasteTiming.ts](file:///src/main/inject/pasteTiming.ts#L69-L75) で Wayland の `restoreDelayMs` が 1500ms に設定されている。
  - [src/main/inject/typer.ts](file:///src/main/inject/typer.ts#L225-L230) では `result.injected === true` であれば無条件で処理を正常終了（`return`）させており、注入後のクリップボード状態検証を行っていない。
- **修正案（設計）**:
  - 注入処理後、クリップボード復元前に**クリップボード読み出し検証**を導入する。
  - ターゲットアプリによる Selection 読み出しが確認できない場合（または非標準アプリ向け）、即座に元のクリップボードへ復元するのを保留し、音声テキストをクリップボードに保持したままにする。

---

#### 3. Portal Sidecar の Selection 所有権不全・固着（以降 Claude でも入らなくなる原因）
- **原因仮説**:
  - Wayland（GNOME）のクリップボード機構（Selection）では、フォーカスを持つウィンドウまたは Portal RemoteDesktop セッションが Data Offer の所有権を維持して通信を行う。
  - ターミナルへの注入試行時（Selection 読み出しが行われなかったケース）や、その後のクリップボード復元処理（`set_selection`）がフォーカス移動と干渉した場合、Sidecar 内（Python / PyGObject）の Selection 所有権状態が desync（不整合）やデッドロックを起こし、Selection の提供がストップする。
  - この状態に陥ると、Sidecar プロセス自体は生存しているため D-Bus キー送信（`injected=true`）は成功を返し続けるが、実際には Selection データが提供されないため、以降 Claude Desktop などの正常なアプリへ切り替えてもテキストが入力できなくなる。
- **根拠**:
  - ログにおいて `wayland paste: sidecar result ok=true injected=true restored=true` がターミナル試行後も出力され続けているにもかかわらず、実際には入力不能になっている。
  - [src/main/linux/portalSidecar.ts](file:///src/main/linux/portalSidecar.ts#L309-L320) で `transfer_error` や `protocol_error` イベントを受信してもログ記録（`debug`）のみでセッションのリセットや自動復旧が行われていない。
- **修正案（設計）**:
  - Sidecar に Selection 保持状態のヘルスチェック機能を追加し、`transfer_error` の検知時や Selection 固着疑い時に自動で Selection セッションの再生成（`portalSidecar.restart()`）を実行する自己修復機構を組み込む。

---

#### 4. ユーザーへのフォールバック通知・手動貼り付け案内の欠落（サイレント失敗の放置）
- **原因仮説**:
  - 現在の設計では、`injected=true`（キー送信完了）であればアプリは「完全成功」とみなすため、画面上にテキストが挿入されなかった場合でもユーザーへの警告通知（`notifyPasteFailed`）が一切発火しない。
  - ユーザーは「成功と報告されたのに実際は入力されていない」というサイレント失敗に直面し、手動で `Ctrl+V` を試すためのクリップボード保持保護も受けられない。
- **根拠**:
  - [src/main/inject/typer.ts](file:///src/main/inject/typer.ts#L225-L232) では `injected=true` の場合に `notifyPasteFailed` を呼び出すルートが存在しない。
  - ログでも全注入が `ok=true injected=true` と記録されており、エラー検知イベントが送信されていない。
- **修正案（設計）**:
  - 「成功と報告して実際は失敗」を仕組みで潰すため、キー送信成功（`injected=true`）のみを最終成功基準とせず、注入処理実行時には必ずテキストをクリップボードへ安全保持（`copyTextForManualPaste`）する。
  - ターミナル等の特定アプリへの注入時やクリップボード未読出検知時には、トースト通知等で**「テキストをクリップボードに保持しました。手動で貼り付けてください（Ctrl+Shift+V / Ctrl+V）」**という明示的なフォールバック通知を発行する設計に変更する。

---

RV2DONE8

## agy-lx2-9.md
^DLinux (Ubuntu 24.04 / GNOME / Wayland) 環境における Electron 物理音声入力アプリ **WindVoice** のバグ調査報告です。

観点である **【マルチディスプレイ / ワークスペース切替がフォーカス判定を狂わせる可能性】** および提供されたログ・ソースコードに基づき、原因仮説と修正案を以下 4 件にまとめて報告します。

---

### 原因仮説と修正案（最大4件）

#### 1. UI更新（Overlay/Tray）に伴う GNOME Mutter 上のフォーカス奪取および固定化
* **原因仮説**:
  マルチディスプレイやワークスペース切り替えを行った際、DictationOrchestrator から Overlay ウィンドウ等のUI状態変更（`listening` → `processing` → `idle`）が走ることで、GNOME Wayland コンポジタ（Mutter）上でキーボードフォーカスがターゲットアプリから WindVoice の不可視 Overlay や透明ウィンドウへ一時的または恒久的に遷移してしまう可能性があります。
  XDG RemoteDesktop Portal (`portalSidecar.ts`) の `keyPaste`（`NotifyKeyboardKeycode`）は、コンポジタがその瞬間にアクティブと認識しているウィンドウに対して仮想キーコード（Ctrl+V）を注入するため、コンポジタ自体は正常にキーイベントを受け取ったとして `injected=true` / `ok=true` を返します。しかし、実際の入力先が WindVoice 自身の Overlay になっているため Terminal には何も入力されず、その後 Claude Desktop に戻してもフォーカスが奪われたままとなり入力不能が継続します。
* **修正案**:
  * Electron の `BrowserWindow` オプションで `focusable: false`, `acceptFirstMouse: false`, `skipTaskbar: true` を徹底設定し、Wayland コンポジタに対して一切のフォーカス要求を出さない構造にする。
  * Sidecar 注入直前に、現在フォーカスを持つウィンドウが WindVoice 自身でないか確認し、フォーカスを保持している場合は Overlay の非表示化や Focus 解除処理（`blur`）を割り込ませる。

---

#### 2. ワークスペース / ディスプレイ跨ぎ時における Native Wayland と XWayland 間の クリップボード選択（Selection Sync）フォーカス不整合
* **原因仮説**:
  Claude Desktop（Electron / XWayland 動作）から別ディスプレイまたは別ワークスペース上の Terminal（GNOME Terminal や Ptyxis 等の Native Wayland アプリ）へフォーカスを切り替えた際、Mutter 内の XWayland クリップボードブリッジおよび Portal Clipboard の選択所有権（Selection Ownership）の伝播が遮断される現象が発生します。
  `portalSidecar.ts` は Portal 経由で `set_selection`（クリップボード書き込み）を行った直後に `keyPaste`（Ctrl+V 注入）を実行します。Portal API レベルでのキー送信自体は成功するためログには `injected=true` と記録されますが、Wayland の選択所有権（`wl_data_device`）が別ディスプレイ / 旧ワークスペースのフォーカスに紐付いたまま残存しているため、Terminal 側がペースト要求を行った際に Mutter がデータ受け渡しをドロップします。その結果ペーストが空振りし、以降のワークスペース復帰時にもクリップボード同期の競合状態が解除されず入力不能となります。
* **修正案**:
  * `portalSidecar.pasteText` の実行フローにおいて、選択設定（`set_selection`）と仮想キー注入（`keyPaste`）の間にコンポジタのフォーカス・クリップボード伝播待ち時間（Settle Window）を確保する。
  * ワークスペース切替やディスプレイ移動の検知時、ペースト実行直前に Portal 側でクリップボード所有権の明示的な再確立（Re-claim selection）を行う。

---

#### 3. ワークスペース切替アニメーション / フォーカス遷移中の Portal キー注入タイミング脱落
* **原因仮説**:
  ユーザーがマルチディスプレイ移動やワークスペース切り替えのショートカット（`Super + Alt + Arrow` 等）を操作した直後に音声入力が完了した場合、GNOME Shell のトランジションアニメーション中またはフォーカス変更処理中に `portalSidecar.pasteText()` が呼び出されるケースがあります。
  Wayland コンポジタ（Mutter）はワークスペース遷移中の短いミリ秒間、フォーカス対象 Surface を `NULL` またはデスクトップシェル自体に設定します。このタイミングで Sidecar が `NotifyKeyboardKeycode`（Ctrl+V）を送信すると、Mutter は「仮想キーイベントの受付」としては正常完了（`injected=true`）として応答しますが、受領先のウィンドウが存在しないためキー入力を破棄します。この非同期タイミングの狂いによりコンポジタとアプリ間のフォーカス追従状態が不整合を起こし、以降の注入処理もすべて無効化されます。
* **修正案**:
  * `pasteTiming.ts` の `WAYLAND_MIN` における `settleMs`（注入前設定時間）を、GNOME のワークスペース切替アニメーション時間（約250〜300ms）を考慮して拡大・調整する。
  * ペースト注入前に Wayland D-Bus / Active Window API 等でターゲットウィンドウのフォーカス状態をチェックし、フォーカス遷移中（変更直後で不安定な状態）である場合は数ミリ秒リトライするガード処理を追加する。

---

#### 4. evdev モディファイア状態（Alt/Super等）の非同期残存とマルチディスプレイでのアクティブウィンドウ判定不整合
* **原因仮説**:
  Linux のグローバルホトキー監視は `/dev/input/event*`（evdev）で行われています（`src/main/hotkey/evdev.ts`）。マルチディスプレイやワークスペース切り替え操作（`Alt + Tab` や `Super` キー操作等）と dictation の終了処理が重なると、コンポジタ側でショートカットが消費され、evdev 側でモディファイアキーの `keyup` イベントが取りこぼされるか、物理モディファイアが押下状態として誤認識される可能性があります。
  `typer.ts` / `streamingTyper.ts` 内の `untilAllModifiersUp(600)` が不完全な状態で Portal 経由の Ctrl+V が注入されると、コンポジタ上では `Super + Ctrl + V` や `Alt + Ctrl + V` などの別ショートカットとして解釈されます。Mutter 側ではキー注入自体を `injected=true` として処理しますが、Terminal 側では無効なキーコードとして無視されます。さらに `getActiveWindow()` がマルチディスプレイ間で誤ったウィンドウ情報を参照・キャッシュし続けることで、以降のフォーカス判定とキー注入が全て無効化されます。
* **修正案**:
  * `HotkeyManager.resetState()` またはペースト処理直前に evdev 側のモディファイア状態フラグ（`modifierState`）を強制リセット・再スキャンする処理を導入する。
  * `orchestrator.ts` でアクティブウィンドウ情報を取得・参照する際、マルチディスプレイ環境に対応した Wayland / D-Bus 経由で最新のフォーカスウィンドウを再検証し、フォーカス喪失時や不整合時には安全にリトライまたは注入をスキップする構造にする。

---

RV2DONE9

