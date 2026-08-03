# 雪風 UI / プロセス消失 / 注入伝達 判定書

作成日: 2026-08-03  
対象: `fix/linux-inject` / Ubuntu 24.04 / GNOME 46 / Wayland / AppImage展開実行  
一次資料: `docs/reviews/yukikaze-evidence-2026-08-03.md`、`docs/reviews/agy-ui-crash-2026-08-03.md`、`docs/reviews/yukikaze-after-fix.md`、`docs/briefs/linux-inject-verdict.md`

## 結論

4症状を一つのElectronクラッシュ原因で説明する証拠はない。コードとログから確定・高確度判定できるのは次の4点である。

1. **症状4の実機直接原因は混在成果物である。** 修正版実機ログのJS側出力は `sidecar result ok=true injected=true restored=false` であり、これは `44ae07e` より前の `typer.ts` の文字列と完全一致する。`44ae07e` 以後の現行バンドルは必ず `shortcut=... selectionRead=... stage=...` を出す。Python Sidecarだけが新しく、Electron main bundleが旧版だったため、Sidecarは未受領を検出しても旧TSが `injected===true` だけで成功扱いした。
2. **現行ソースにも上位契約の穴が残っていた。** `PortalSidecar.pasteText()` は `ok=false` を返せるが、上位 `pasteText()` は `Promise<void>` で正常resolveし、Orchestratorは結果を受け取れなかった。通知も設定ウィンドウIPCだけで、ウィンドウなしの常駐状態では見えず、直後の `finishCycle()` がトレイを `idle` に戻していた。
3. **症状1はSidecar自己終了を主因とするコード根拠がない。** Sidecar単独終了は `onExit()` から3秒後の有界respawnへ進み、`app.quit()` を呼ばない。実機は起動ログから最終行まで117.103秒で、終了コードが `null`（signal終了）である。遠隔実行側の120秒process-group timeoutと強く一致するため、外部ランチャー終了を高確度原因と判定する。ただし実際の起動コマンド/親PID/signalが資料にないため、雪風での最終確認が必要である。
4. **症状1のコード上クラッシュ穴、症状2/3の失敗増幅器は存在した。** `tray.setStatus()` は破棄競合を保護せず全BrowserWindowへ直接sendしていた。設定Windowは `ready-to-show` だけに表示を依存し、Rendererは `getSettings()` reject時に永続空白になった。これらは当該117秒終了の直接証拠ではないが、症状を発生・不可視化できる実装穴として修正対象に採用した。

## 症状別判定

| 症状 | 判定 | 根拠 |
|---|---|---|
| 1. 約2分でプロセス消失 | 外部signal終了を高確度採用。アプリ内部真因は未確定 | 02:28:00.866→02:29:57.969は117.103秒。Sidecar `exit(null)` はsignal終了で、現行 `onExit()` はrespawnしmainを終了しない (`portalSidecar.ts:238-240,280-297`)。全Window閉鎖handlerも以前からno-opだった。 |
| 2. GNOME一覧にWindowなし | 独立バグの証拠なし。表示契約は補強 | 証拠取得時はプロセス一覧も空 (`yukikaze-evidence:2-4`)。SNI watcherがある正常起動はtray-onlyでSettings Windowを作らない。明示open時の `ready-to-show` 単独依存は修正した。 |
| 3. 設定UIほぼ空白 | 失敗モードをコード上採用、実機トリガーは保留 | `settings===null` 中はページを描かず、旧コードは `getSettings()` rejectを処理しなかった。IPC登録順は既に正しいため、実機のreject理由/renderer consoleは未取得。 |
| 4. 未受領なのに成功・無通知 | 採用・確定 | 実機ログ26-27行、39-40行。旧JSログ形式との一致、`Promise<void>` 上位契約、Window IPCだけの通知経路が揃う。 |

## ログと成果物の裏取り

- 起動自体は `audio renderer ready`、evdev 3台、Portal ready、Realtime session.createdまで完了している (`yukikaze-evidence:17-28`)。よってPyGObject import、Sidecar script解決、D-Bus初期化、audio renderer/preloadの全面的パス破損は成立しない。
- 現行 `PortalSidecar.pasteText()` は `ok = injected === true && selectionRead` である (`portalSidecar.ts:466-491`)。
- 現行 `typer.ts` のログは `shortcut`、`selectionRead`、`stage` を必ず含む (`typer.ts:274-280`)。実機ログには一つもない。
- 再現比較コマンドは `git show 44ae07e^:src/main/inject/typer.ts` と `git show 44ae07e:src/main/inject/typer.ts`。前者だけが実機の3フィールド形式を持つ。
- Electron公式のsandbox process APIには `process.env` と `process.platform` が明記されているため、「sandbox preloadではenv自体がundefined」は成立しない。

## agy 8隊・全32仮説の判定

判定語: **採用**=コードまたは当該ログで成立、**却下**=現行コード/時系列/一次仕様と矛盾、**保留**=発生証拠がなく反証もできない。複合仮説は部分判定した。

### agy-ui-1

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 sandbox preloadの`process.env`でクラッシュ | 却下 | Electron sandbox process APIは`env`/`platform`を提供する。audio rendererも同じpreloadでreadyまで到達した。 |
| H2 Sidecar終了時のuncaughtExceptionがmainを落とす | 却下 | stdin `error`、child `error`/`exit`を捕捉済み。pendingは結果へ解決し、`onExit()`はrespawnする。大域catch追加は真因修正にならない。 |
| H3 Watcher timeout→Window生成ループ | 却下 | `ensureStatusNotifierWatcher()`は起動時1回、失敗時openも1回。実機ではubuntu-appindicatorsが有効。ループコードはない。 |
| H4 selectionReadを上位が無視 | 採用 | 混在成果物の旧TSと`Promise<void>`契約の両方で成立。 |

### agy-ui-2

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 `setStatus`が破棄済みWindowへsend | 採用（コード上） | 旧実装は無保護。時刻直前のstatus変更ログはなく当該発生は未証明だが、mainを落とせる競合なので安全broadcastへ統一した。 |
| H2 `show:false`+`ready-to-show`で非表示 | 採用（表示穴） | イベント単独依存はコード上成立。load完了後にも明示show/focusする。GNOME固有既知不具合との断定は保留。 |
| H3 `getSettings`失敗で空白固定 | 採用（失敗モード） | 旧Appはcatch/loading/error/retryなし。実機の具体的IPCエラーは未取得。 |
| H4 selectionRead失敗の成功偽装 | 採用 | H4共通。 |

### agy-ui-3

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 `ready-to-show`依存 | 採用（表示穴） | agy-ui-2 H2と同じ。起動時Windowなし自体はtray-only仕様。 |
| H2 `getAllWindows()`でhidden/UI混同 | 採用（コード上） | status送信がhidden audioを含み、破棄競合もあった。共通UI broadcasterへ変更。 |
| H3 `getSettings`未処理 | 採用（失敗モード） | agy-ui-2 H3と同じ。 |
| H4 未受領偽装 + EPIPE再起動上限でmain消失 | 部分採用/部分却下 | 偽装は採用。stdin EPIPEはlistenerで処理され、respawn上限でもSidecar unavailableになるだけでmainは終了しない。 |

### agy-ui-4

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 `getSettings` catch欠落 | 採用（失敗モード） | loading/error/retryを追加。 |
| H2 IPC登録前にWatcherがWindow生成 | 却下 | 現行mainは`registerIpc()`後に`ensureStatusNotifierWatcher()`をawaitする。 |
| H3 preload module解決失敗 | 却下（当該事象） | preloadはsandbox対応の`electron`とpure type moduleのみ。audio renderer readyがpreloadロード成功を示す。 |
| H4 i18n未初期化例外 | 却下 | 辞書は静的同梱で、`t()`は英語→日本語→key文字列のfallbackを返し例外を投げない。 |

### agy-ui-5

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 APPDIR不足でSidecar/PyGObjectが反復クラッシュ | 却下 | Portal ready + clipboard=true + Realtime readyまで到達。Sidecar path/gi/D-Bus失敗と矛盾。 |
| H2 APPDIR不足でpreload/renderer path破損 | 却下（全面原因として） | audio rendererは同じ`__dirname/../renderer`とpreloadからロード成功。現行buildにも`out/renderer/index.html`が存在する。 |
| H3 全アセットpath破損でUI空白 | 却下（全面原因として） | H2と同じ。Settings固有consoleはないため個別ロード失敗は保留。 |
| H4 selectionReadの上位脱落 | 採用 | H4共通。 |

### agy-ui-6

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 Watcherありで初期Window未生成 | 却下（バグとして） | tray常駐設計どおり。明示open時に見えない問題とは別。 |
| H2 memory NativeImage更新でlibappindicator SIGSEGV | 保留 | core dump、kernel log、fallback icon使用、native stackの証拠なし。今回の修正対象にしない。 |
| H3 `getSettings` catch欠落 + unwrap欠落 | 部分採用/部分却下 | catch欠落は採用。GET handlerは生の`Settings`を返すread-only契約なので`unwrap()`適用案は型を壊す。 |
| H4 `if (!r.ok)`後の流下で成功 | 却下 | 現行は最終的に`injected && selectionRead`でfalseを返す。問題はその上位の旧JS/void契約。 |

### agy-ui-7

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 Sidecar message脱落 + 上位判定 | 部分採用 | 上位判定欠陥は採用。実機理由は`r.error`としてTSログに出ており、`r.message`脱落が主因ではない。 |
| H2 IPC登録順逆転 | 却下 | agy-ui-4 H2と同じ。 |
| H3 `ready-to-show`依存 | 採用（表示穴） | load完了後show/focusを追加。 |
| H4 evdev未処理`error` event | 却下 | 各ReadStreamに`error` listenerがあり、device除去・rescanへ進む (`evdev.ts:219-229`)。monitor自身は公開`error`をemitしない。 |

### agy-ui-8

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 GNOMEが約2分でPortalを閉じ、mainも落ちる | 却下 | GNOMEの120秒idle close根拠なし。Sidecar close/exitはrespawnしmain quit経路へ接続しない。117秒は外部command timeoutと整合。 |
| H2 Window一覧なしはtray-only仕様 | 採用（説明として） | SNI hostあり・API keyありなら初期Settings Windowなしは正常。ただし明示openの表示穴は別途修正。 |
| H3 `getSettings`失敗で空白 | 採用（失敗モード） | agy-ui-2 H3と同じ。 |
| H4 selectionRead上位無視 | 採用 | H4共通。 |

## 実装した修正

1. `pasteText()`を`Promise<PasteTextResult>`へ変更し、Wayland失敗を`ok=false / injected / selectionRead / stage / error`のまま返す。
2. Orchestratorが`ok=false`を受けてcycleを失敗終了し、`finishCycle()`の`idle`上書きを防ぐ。ログへ上位結果を残す。
3. paste failureをtray error、Settings `SYSTEM_ERROR`、GNOME desktop Notificationの3経路へ送る。通知クリックでSettingsを開く。
4. `tray.setStatus()`を破棄競合を捕捉する`broadcastToUiWindows()`へ統一。
5. 全Window閉鎖を常駐契約モジュールへ分離し、`app.quit()`を呼ばないことをテスト固定。
6. Settings navigation完了後に明示`show()`/`focus()`し、`ready-to-show`取りこぼしでもWayland surfaceをmapする。
7. Settings loadへloading/error/retry UIを追加し、`useI18n`の未処理rejectionも止める。
8. 既存全体テストを止めていたmacOS `fs.watch`初期化raceに、有界probe ready境界と決定的watch factoryテストを追加した。定常ポーリングにはしていない。

## 回帰契約

- `tests/typerWayland.test.ts`: `selectionRead=false`が上位でも`ok=false`のまま、manual clipboard保持と通知を伴う。
- `tests/orchestrator.test.ts`: 未受領後は`isActive=false`かつ最終status=`error`。
- `tests/pasteFailure.test.ts`: tray、Settings IPC、desktop Notificationの3経路。
- `tests/appLifecycle.test.ts`: `window-all-closed`で`app.quit()`を呼ばない。
- `tests/trayStatus.test.ts`: 破棄済みWindowが存在してもstatus broadcastでmainを落とさない。

## 検証結果

- RED: 新規契約は `pasteText`が`undefined`、Orchestrator最終statusが`idle`、破棄済みWindowで`Object has been destroyed`、常駐/通知モジュール未実装、の意図した理由で失敗した。
- 関連GREEN: `typerWayland`、`orchestrator`、`appLifecycle`、`pasteFailure`、`trayStatus`を含む対象7 files / 62 tests pass。
- `npx vitest run`: **50 files / 386 tests pass**。
- `npm run typecheck`: node / webともにpass。
- `npx electron-vite build`: main / preload / rendererすべてpass。既存の`secure.ts` dynamic/static import warningのみ。
- 生成した`out/main/index.js`に `sidecar result shortcut=`、`insert result ok=false`、desktop notification titleが存在し、renderer bundleにSettings load error文言が存在することを確認した。
- `git diff --check`: pass。

## 雪風での検証手順

1. **混在成果物を排除する。** 新しいcheckoutで `npm ci && npx vitest run && npm run typecheck && npm run package:linux`。既存展開dirへ上書きせず、新規dirへAppImageを展開する。
2. `resources/app.asar`内のmain bundleに `sidecar result shortcut=` と `insert result ok=false` があり、旧3フィールドだけの文字列でないことを確認する。起動後ログにも同じ新形式が出ることを必須条件にする。
3. 遠隔commandの120秒TTLから切り離す。雪風のローカルGNOME Terminalから起動するか、`systemd-run --user --unit=windvoice-yukikaze-test --collect /absolute/path/to/squashfs-root/windvoice`でtransient user serviceとして起動する。
4. `systemctl --user status windvoice-yukikaze-test`、親PID、開始時刻を記録し、5分以上無操作で生存することを確認する。120秒前後で終了した場合はunitの`Result`/signalとjournalを保存する。
5. Settingsをtrayから10回開閉し、毎回GNOME Overviewに`WindVoice`が現れ、Generalページまたは明示loading/error/retryが見えることを確認する。閉じた後もmain PID、evdev、Realtime connectionが生存すること。
6. 正常pasteは `ok=true injected=true selectionRead=true`、画面完全一致、通知なしを確認する。
7. GNOME Overview/非編集領域へdictationして負系を作る。期待値はSidecarと上位の両方で `ok=false injected=true selectionRead=false stage=verify`、tray error、desktop通知、Settings banner、転写がclipboardに残ること。
8. 通知をクリックしてSettingsが開くこと、手動paste後、次dictationでPortal recycleを経て正常注入へ戻ることを確認する。
9. Claude Desktop↔GNOME Terminalを20周し、`^V`、二重貼り付け、modifier固着、無通知失敗、120秒終了が一度もないことを合格条件とする。

## 未確認境界

- このMacでは雪風/GNOME/Portalの実機E2E、実際の親PID/signal、GNOME通知表示を測っていない。
- `portal sidecar exited(null)`を発生させた実起動コマンドは資料にない。外部120秒timeout判定は時刻・signal・コード経路からの高確度推定で、手順3-4で確定させる。
- `agy-ui-6`のnative tray SIGSEGV仮説はcore/native stackがないため保留のまま。今回のコード修正をその仮説の実証とは扱わない。
