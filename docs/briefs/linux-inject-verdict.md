# 雪風 Linux / Wayland 注入バグ 判定・修正報告

作成日: 2026-08-02  
対象: Ubuntu 24.04 / GNOME 46 / Wayland  
一次資料: `docs/reviews/agy-linux-inject-2026-08-02.md`、`docs/reviews/yukikaze-debug-excerpt.log`

## 結論

真因は単独ではなく、次の3層である。

1. **端末だけ失敗する直接原因（確定）**: Wayland Sidecar は全アプリへ `Ctrl+V` を固定送信していた。GNOME Terminal系は `Ctrl+Shift+V` が貼り付けで、`Ctrl+V` は quoted-insert (`^V`) になる。
2. **全件が成功に見える直接原因（確定）**: `injected=true` は対象アプリの受領ではなく、仮想キーの `V-down` 送信までしか表していなかった。`SelectionTransfer` の発生を見ず、`typer.ts` も `injected===true` だけで成功終了していた。
3. **一度の失敗が以後を壊せる状態汚染（コード上確定、当該実機での発生は旧ログ不足のため高確度推定）**: 旧 `inject_ctrl_v()` は `V-down` 後、`V-up` / `Ctrl-up` が失敗しても `injected=true` を保持した。解放を `finally` で再試行せず、汚染した RemoteDesktop セッションも破棄しないため、仮想Ctrlが残って全アプリの後続入力を壊せた。旧TSログは `stage` / `error` を出していないため、当該D-Bus解放エラーそのものは抜粋から復元不能である。

副因として、`suppressFor(40)` が Wayland の `settleMs >= 60` より短く、Sidecar注入中に `ignored start` が出る余地もあった。これはログとタイミングが整合するが、永続汚染の主因とまでは断定しない。

## コード・ログによる裏取り

- 2026-08-02 13:57:02 に `portal sidecar ready (clipboard=true)`。同日の対象試行は全て約1.59秒で応答しており、Sidecarハング説とパス不明説には合わない。
- 13:58:19以降、毎回 `ok=true injected=true restored=true`。旧 `portal-remote.py` は `V-down` 直後に `injected=True` とし、`emit_paste_result()` は `ok=bool(injected)` としていた。
- 旧 `portal-remote.py` には既に `SelectionTransfer` ハンドラがあったが、paste結果の成功判定には結び付いていなかった。
- 旧 `typer.ts` は `result.injected === true` で即returnし、未受領テキストの保持・通知を行わなかった。
- `getActiveWindow()` は Waylandでは常に `null` を返す。多数レビューの「プロセス名で端末判定」は現行Waylandコードにはそのまま実装できない。
- Sidecarのstdin workerは `handle(msg)` を同期・直列実行する。1件の `paste` がsleep中に次のpaste/restoreが割り込むというレビュー上のキュー競合は成立しない。
- `serve_selection_transfer()` は既に別thread + bounded non-blocking writeであり、対象ログでも応答が継続した。イベントループ永久ハング説とは一致しない。
- 7月31日の `code=2` / respawn上限到達は、8月2日のreadyより前の別時間帯であり、今回の直接根拠にはしない。

## 19レビュー・全仮説の判定

判定語は、**採用**=コードまたは当該ログで成立、**却下**=現行コード/時系列と矛盾、**保留**=Linux実機情報がなく成立も反証もできない、である。複合仮説は成立部分を明記した。

### 1. agy-lx-1

- H1 **採用** — 端末の `Ctrl+V` / `Ctrl+Shift+V` 不一致はコードと症状が一致する。
- H2 **採用（未受領テキスト消失のみ）** — 未読でも1500ms後に復元していた点は成立。読み出しが1500ms超だった、またはそれだけで永続破損した部分は保留。
- H3 **保留** — Alt/Superの物理keyup欠落を示すmodifier timeoutログがない。
- H4 **採用** — D-Busキー送信を実受領と誤認し、フォールバックが起動しない。

### 2. agy-lx-10

- H1 **採用** — 対象アプリ記録の欠如と端末キー不一致は正しい。ただしWaylandでは既存 `getActiveWindow()` が使えないため、修正は端末兼用キーを採った。
- H2 **採用** — `SelectionTransfer` 未検証が成功誤報告の核心。
- H3 **採用** — 未読テキストを旧Selectionで上書きしていた。永続Selection破損までは保留。
- H4 **採用（原因を限定）** — stuck modifierは成立し得る。裏取りできた具体箇所はSidecarの解放失敗誤報告で、evdev由来かは未確定。

### 3. agy-lx-2

- H1 **採用（前半）** — 端末キー不一致とquoted-insertは確定。端末のquoted-insert状態自体がClaudeへ跨る、という説明は却下。
- H2 **採用** — 実受領検証なし。
- H3 **保留** — evdevがPortal仮想デバイスを実際にopenした証拠・デバイス名がログにない。
- H4 **却下** — stdin workerは直列で、後続pasteは先行restore完了前に実行されない。

### 4. agy-lx-3

- H1 **採用** — 端末キー不一致。
- H2 **採用（原因を限定）** — modifier latchの危険は旧Sidecarの解放処理で確認。Mutter/evdevのどちらが実際に落としたかは保留。
- H3 **保留** — XWayland bridge / SelectionClearの永続破損を示すログがない。
- H4 **保留** — silent focus dropは実受領未確認を説明できるが、Terminalだけ特権扱い・セッションInhibited化の根拠はない。

### 5. agy-lx-4

- H1 **採用（副因）** — 40msは60ms settleより短く、13:58:42の `ignored start` と整合。ただし注入イベントだったかは旧ログから確定不能。
- H2 **採用** — 端末キー不一致。
- H3 **採用（未読復元のみ）** — 未読でも復元した点を採用。タイマーバッティングによる永続所有権破損は保留。
- H4 **保留** — stuck状態は可能だが、当該ログに `untilAllModifiersUp timed out` はない。

### 6. agy-lx-5

- H1 **保留** — silent stale sessionは理論上あり得るが、対象時間帯はreadyかつ応答継続。偽陽性部分だけ採用。
- H2 **却下（当該原因として）** — `transfer_error` / `protocol_error` は対象ログにない。個別consumer転送失敗だけで即セッション破棄するのも過剰。
- H3 **却下** — transfer writeはbounded workerで、対象ログも毎回返答しておりハングしていない。
- H4 **採用** — 端末キー不一致 + 偽陽性 + フォールバック欠如。

### 7. agy-lx-6

- H1 **保留** — 1500ms超の実読取遅延は計測されていない。固定時間ではなく転送完了を待つ設計提案は採用。
- H2 **採用** — 端末が読まず、その後に転写Selectionを消していた。
- H3 **却下** — Orchestratorはin-flight中の次startを拒否し、Sidecarも直列。snapshotのネスト連鎖は成立しない。
- H4 **却下** — Python stdin workerの同期 `handle()` 中に次commandは割り込めない。

### 8. agy-lx-7

- H1 **保留** — Portal仮想keyboardが監視対象だった証拠がない。
- H2 **却下** — `HotkeyManager.onKey()` はsuppression中もmodifier snapshotを更新し、物理keyup safety checkも常時実行する。
- H3 **却下（永続化部分）** — busy中startは拒否されるが、それだけでtoggleが永久反転するコード根拠はない。長いbusy期間は今回短縮した。
- H4 **却下** — `removeDevice()` は保持キーの合成releaseを既に行う。

`agy-lx-8` はpermission auto-deniedで仮説出力がなく、判定対象なし。これを除いた実質レビューが19件である。

### 9. agy-lx-9

- H1 **採用** — 端末キー不一致。
- H2 **採用（未読復元のみ）** — 未読Selectionの破棄は成立。bridge永続破損は保留。
- H3 **採用** — `injected` の偽陽性。
- H4 **保留** — modifier固着は成立し得るが、evdev由来は未確認。Sidecar解放穴を修正対象とした。

### 10. agy-lx2-1

- H1 **採用** — 端末キー不一致。
- H2 **採用（副因）** — 40ms抑制不足は成立。永続state破壊の直接証拠ではない。
- H3 **保留** — 仮想event nodeの存在・名称を取得していない。
- H4 **採用（quoted-insertと未読復元）** — Selection所有権が永久破損する部分は保留。

### 11. agy-lx2-10

- H1 **採用** — キー送信と受領の乖離、release漏れの危険を採用。
- H2 **却下（当該原因として）** — transfer errorの記録がなく、現行transferはbounded worker。未受領検証の提案だけ採用。
- H3 **却下** — stderr 300文字切断は診断性の問題だが、症状の原因ではない。
- H4 **採用（安全な構造化ログのみ）** — `stage` / `selectionRead` / recovery状態を記録する。生stdout全出力はsnapshot text等の秘密を漏らし得るため却下。

### 12. agy-lx2-2

- H1 **採用** — Sidecar方式のまま端末兼用ショートカットへ修正。root/uinput権限を要するydotool等への切替は不要。
- H2 **採用（端末部分）** — quoted-insertは確定。TTY状態がWindVoice内部stateを直接壊す説明は却下し、Sidecar modifier cleanupを真因とした。
- H3 **却下** — non-blocking bounded writeが既にあり、対象ログも応答継続。
- H4 **却下（当該事象）** — code=2は前日。8月2日はready。`retryForDictation()` とunlock recoveryも既にある。

### 13. agy-lx2-3

- H1 **却下（当該事象）** — `failed` event時はreadyを落としてchildをteardownするため「failed後もisReady=true」はコードと矛盾。前日ログも今回の開始前。
- H2 **採用** — 端末キー不一致。
- H3 **採用（未読復元のみ）** — 頻回SetSelectionでMutter tokenが永久破損する部分は保留。
- H4 **保留** — ClaudeのXWayland/Wayland実態とbridge状態が未記録。

### 14. agy-lx2-4

- H1 **却下（当該事象）** — PyGObject import、portal session、最初のClaude注入が成功しており、ABI不整合ではTerminal切替を境にした再現を説明しにくい。
- H2 **採用** — 端末キー不一致 + Sidecarのmodifier解放穴。
- H3 **却下** — `portal sidecar ready` がscript解決・spawn・D-Bus到達を証明する。
- H4 **保留** — focus silent dropは受領検証で検出可能にしたが、セッション永久破損の実証はない。

### 15. agy-lx2-5

- H1 **却下** — single-instance lockは `app.whenReady()` のSidecar起動より前に取得し、敗者はready handler冒頭でreturnする。
- H2 **却下** — 同理由で第2インスタンスはevdevをstartしない。
- H3 **採用** — 端末キー不一致と未読復元。
- H4 **却下（当該事象）** — 第2起動の証拠がなく、child teardownはpendingを解決する実装。

### 16. agy-lx2-6

- H1 **採用** — 旧Sidecarがmodifier release失敗後も成功扱いできた。今回最も「以後全アプリ不発」を説明する実装穴。
- H2 **保留** — GPaste/CopyQ等の稼働記録がない。SelectionReadはrequesterを識別できないため、雪風検証時にclipboard manager有無を記録する。
- H3 **保留** — XWayland bridge破損の証拠なし。MIME互換形式は既に5種提供。
- H4 **却下** — writeはnon-blocking + 2秒deadline、GLib signal thread外。ログもSidecar応答継続。

### 17. agy-lx2-7

- H1 **採用（端末部分）/却下（IME跨ぎ部分）** — `Ctrl+V` 不一致は確定。TerminalのpreeditがClaudeへ引き継がれる根拠はない。
- H2 **採用（受領前復元）** — IME/Data Source全体のデッドロックは保留。
- H3 **保留** — stale sessionを直接示すevent/timeoutなし。
- H4 **保留** — IMEがkeyupを落とした証拠なし。実装上確認できたSidecar cleanup不備は修正。

### 18. agy-lx2-8

- H1 **採用** — 端末キー不一致と盲目的成功報告。
- H2 **採用** — 未読転写の復元・消失。
- H3 **保留** — Selection固着の実証はない。ただし失敗後の次dictation前にsessionを再生成する防御を採用。
- H4 **採用** — 未読・不明時のclipboard保持 + 明示通知が必須。

### 19. agy-lx2-9

- H1 **却下** — Overlayは既に `focusable:false`、`showInactive()`、mouse ignoreで、フォーカス奪取説とコードが矛盾。
- H2 **保留** — 複数display/workspaceを使った記録がなく、Selection sync状態も未計測。
- H3 **保留** — workspace animation中だった証拠なし。固定settle延長だけでは実受領を保証できない。
- H4 **保留（modifier）/却下（activeWindow cache）** — modifier残留は可能。Waylandでは `getActiveWindow()` 自体が即nullのため、誤キャッシュが今回を壊す説明は成立しない。

## 実装した修正

1. Waylandのpaste chordを **`Ctrl+Shift+V`** に変更した。GNOME Terminalで貼り付けになり、Chromium/Electronではplain-text pasteとして機能する。Waylandでは対象プロセスを安全に取得できないため、アプリ名分岐ではなく共通互換キーとした。
2. `portal_input.py` にキーシーケンスを分離し、`finally` で `V`、`Shift`、`Ctrl` のkeyupを逆順・全件試行する。途中失敗後も残りのmodifier解放を継続する。
3. `V-down` 後に失敗した結果は `injected=null`（結果不明）とし、`ok=true` にしない。tainted sessionは即破棄・再生成する。
4. claim直後のclipboard-manager読取を除外するcheckpointを設け、キー送信後に完了した `SelectionTransfer` だけを `selectionRead=true` とする。`ok` は `injected===true && selectionRead===true` の時だけ。
5. `selectionRead=false` では元clipboardへ復元せず、転写をSelection/clipboardへ残して手動貼り付け通知を出す。次のdictation開始時にPortal sessionを再生成し、失敗状態を次へ持ち越さない。
6. in-processのHotkeyManagerも、taintedまたは未受領時に `resetState()` する。Sidecar注入中のsuppressionを `settle + key-dispatch margin` まで延長した（受領待ち全体までは抑止せず、正常完了後の次dictationを飲み込まない）。
7. ログへ `selectionRead`、`stage`、即時reset/次回recycle状態を追加した。clipboard本文、window title、生stdoutは記録しない。
8. 固定1500msのWayland restore推測を廃止した。受領完了後だけ選択profileの短いmarginを待って復元する。
9. 手動通知へ「端末: Ctrl+Shift+V / その他: Ctrl+V」を明記した。

注意: Portalの `SelectionTransfer` はrequester PIDを公開しない。`selectionRead=true` は「キー送信後にconsumerがデータを最後まで読んだ」ことの証拠であり、特定のfocused appを暗号学的に証明するものではない。雪風実機では画面上の完全一致と組み合わせて合格判定する。

## テスト結果

- 新規RED確認: 端末safe chordなし、未読成功扱い、tainted session未再生成、Hotkey state未回復、streaming未読黙殺の5件が意図した理由で失敗。
- 新規/関連GREEN: `pasteTimingWayland`, `portalInputPython`, `portalSidecar`, `typerWayland`, `streamingTyperWayland` — **22/22 pass**。
- `portalInputPython` は `Ctrl+Shift+V` のdown/up順と、`V-up` failure後もShift/Ctrl releaseを継続して `injected=null` にする挙動を実行検証。
- `npm run typecheck` — node/webともにpass。
- `python3 -m py_compile resources/native/portal_input.py resources/native/portal-remote.py` — pass。
- `npx electron-vite build` — pass（既存の `secure.ts` dynamic/static import warningのみ）。
- `npm ci` 後、既存 `orchestrator.test.ts` — **35/35 pass**。誤archだった `uiohook-napi` はarm64へ再構築済み。
- 問題が再現する既存watcher suiteを除いた全体: `npx vitest run --exclude tests/userDictionary.test.ts` — **46 files / 370 tests pass**。
- 全体の唯一の未合格は本件外の既存 `userDictionary.test.ts` watcher 1件。全体実行と単独実行の両方で3秒timeout、11/12 pass。今回の差分はdictionary本体/テストに触れておらず、同じ失敗を2回確認したため範囲外修正や無限再試行はしていない。したがってこの作業環境では「`npx vitest run` 全通過」は未達である。
- Linux実機、GNOME Portal、Claude Desktop、GNOME TerminalでのE2Eは未実施。

## 雪風での検証手順

1. 修正commitを雪風へ配置し、依存・検査・packageを実行する。

   ```bash
   npm ci
   npx vitest run
   npm run typecheck
   npm run package:linux
   ```

2. `echo "$XDG_SESSION_TYPE"` が `wayland`、`python3 -c 'import gi'` が成功することを確認する。既存 `~/.config/WindVoice/windvoice-debug.log`（実際のElectron `userData` 表記に合わせる）を退避し、WindVoiceを再起動する。
3. Claude Desktopの入力欄へ一意な短文Aをdictationする。画面へ1回だけ完全一致し、ログが `ok=true injected=true selectionRead=true` であることを確認する。
4. GNOME Terminalの通常shell promptへ一意な短文Bをdictationする。Bが入力欄へ完全一致し、`^V` が出ないこと、物理キー入力が通常どおりであること、ログが `selectionRead=true` であることを確認する。EnterはWindVoiceで送らない。
5. Claude Desktopへ戻り一意な短文Cをdictationする。Cが1回だけ入り、②の後も自動注入が回復していることを確認する。
6. 手順3〜5を20周交互に行う。`untilAllModifiersUp timed out`、`session failed`、二重貼り付け、Ctrl/Shift押しっぱなし、`^V` が1度もないことを合格条件とする。
7. GNOME Overview、非編集領域、またはpasteを無効化したテスト対象へdictationし、負系を確認する。期待値は `ok=false injected=true selectionRead=false stage=verify recyclePending=true`、手動貼り付け通知、転写がclipboardに残ること。Terminalなら `Ctrl+Shift+V` でその転写を手動貼り付けできることを確認する。
8. 負系の直後に次のdictationを開始する。ログに `recycling portal session before dictation after an unverified paste` と新しい `portal sidecar ready` が出た後、Claude/Terminalの両方で注入が復帰することを確認する。
9. 成功系のclipboard復元を確認する。事前に無害なmarkerをcopyし、dictation成功後にclipboardがmarkerへ戻ること。負系では復元せず転写が残ることを確認する。
10. clipboard manager（GPaste/CopyQ等）の有無、ClaudeがWayland nativeかXWaylandか、使用したTerminal名/版、20周の成功数、該当ログ抜粋を検証記録へ残す。秘密・clipboard本文・window titleは添付しない。

## Git状態

指定の `fix/linux-inject` 作成とローカルcommitを試みたが、実行環境が `.git` を読み取り専用にしており `cannot lock ref ... Operation not permitted` で拒否した。pushは行っていない。差分は作業ツリーにあり、司令塔側で次を実行する必要がある。

```bash
git switch -c fix/linux-inject
git add docs/briefs/linux-inject-verdict.md resources/native/portal-remote.py resources/native/portal_input.py src/main/inject/pasteTiming.ts src/main/inject/streamingTyper.ts src/main/inject/typer.ts src/main/linux/portalSidecar.ts src/shared/i18n.ts tests/pasteTimingWayland.test.ts tests/portalInputPython.test.ts tests/portalSidecar.test.ts tests/streamingTyperWayland.test.ts tests/typerWayland.test.ts
git commit -m "fix(linux): verify Wayland paste receipt and recover injection state"
```
