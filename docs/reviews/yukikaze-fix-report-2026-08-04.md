# 雪風 Linux貼り付け不具合 修正報告（2026-08-04）

## 結論と検証境界

`SetSelection` のD-Bus応答を「GNOME compositorが新しいclipboard ownerを反映済み」と誤認していた競合を修正した。各claimとrestoreは、呼び出し後に発生した新しい `SelectionOwnerChanged(session_is_owner=true)` を待ってから成功扱いする。貼り付け成功条件は従来どおり、キー注入後の同一generationの `SelectionTransfer` 完了であり、`NotifyKeyboardKeycode` 成功だけでは成功にしない。

ローカルでは既存386件を含む389件、Python構文検査、`npm run build` まで成功した。Ubuntu 24.04 GNOME Wayland実機「雪風」での連続貼り付けはこのMacから実行していないため、実機合格とはしていない。

## 根本原因

### 実機ログとの対応

- 1回目と2回目は `ok=true injected=true selectionRead=true restored=true`（ログ 03:06:12、03:06:19）。
- 3回目はpaste開始 03:06:32.608 から約844ms後に `stage=verify` で失敗した。60msのWayland settle、キー送出、750msのverification deadlineと一致する。
- recycle後はsidecarが `clipboard=true` でreadyになっても、03:06:42、03:06:58に同じ約850msの失敗を繰り返した。readyはsession作成完了を示すだけで、個々の `SetSelection` 反映完了を示さない。

### コード上の原因

1. 旧 `set_selection()` は `SetSelection` のメソッド応答だけを待ってgenerationを返していた（`resources/native/portal-remote.py` の現行623-657行が修正箇所）。しかし xdg-desktop-portal 1.18系のfrontendはbackendの `SetSelection` を非同期に呼び出し、backend応答を待たずfrontend呼び出しを完了する（[upstream clipboard.c 161-165行](https://github.com/flatpak/xdg-desktop-portal/blob/1.18.4/src/clipboard.c#L161-L165)）。したがって、このメソッド応答はclipboard owner反映のbarrierではない。
2. `handle_paste()` はその未確認claimの後、固定settleだけでキーを注入していた（`resources/native/portal-remote.py:763-791`）。backend反映がsettleを超えると、前面アプリはWindVoiceの新しいselectionを要求できず、そのgenerationの `SelectionTransfer` は発生しない。結果としてverificationがdeadlineまで待って `selectionRead=false` になった。
3. restoreも同じ未確認 `SetSelection` の直後に `restored=true` としていた（同793-807行）。次のclaimは遅延中のrestoreと重なり得るため、一度遅延が始まると同じ競合を持ち越す。session recycleも個々のclaimにbarrierを追加しないので、同じ競合を新sessionで再実行するだけだった。

`SelectionOwnerChanged` 自体の購読切れではない。購読はStart前に一度設定され、handlerは現在のsession pathでfilterしている（`resources/native/portal-remote.py:298-343, 388-413`）。通常のrecycleはPythonプロセスをspawnし直すため再購読され、同一プロセス内のstale restore-token retryでも全sessionを受ける購読を維持してpathで選別する。欠けていたのは購読ではなく、その通知をclaim/restoreの完了条件に結び付ける処理だった。[XDG Clipboard仕様](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Clipboard.html)でも、`SelectionOwnerChanged` はselection変更とsession owner状態を通知するsignalとして定義されている。

## 修正内容

- `resources/native/portal_clipboard.py:7-65` にowner-change barrierを追加した。単なる `is_owner=true` では前回claimと区別できないため、signal sequenceをcheckpointし、各 `SetSelection` より後の新しいowned通知だけを受理する。
- `resources/native/portal-remote.py:298-323` でowner signalをbarrierへ接続し、session作成・close・stale-token retry時にbarrierをresetする。
- `resources/native/portal-remote.py:623-657` でclaim/restoreとも最大2秒、新しいownership通知を待つ。確認前にはキーを注入しない。timeout時は非同期claimが遅れて届く可能性があるのでselection本文/generationを保持しつつsessionをtainted扱いにし、次のclaimが古い通知を誤認しないよう再生成する。
- `resources/native/portal-remote.py:763-835` でclaim timeoutを `stage=claim`、restore timeoutを `stage=restore` として返す。receipt verification（generation + 注入後request sequence）は `resources/native/portal-remote.py:659-683` のまま維持した。
- `src/main/linux/portalSidecar.ts:468-489, 508-518` でtainted sessionを再生成し、単独 `setSelection` はD-Busとowner確認のdeadlineを内包できる7秒budgetにした。
- Windows経路（`pasteWin32.ts` 等）、依存関係、750msのpost-injection receipt deadlineは変更していない。

## 変更ファイル一覧

- `resources/native/portal_clipboard.py` — owner-change sequence barrier（新規）
- `resources/native/portal-remote.py` — claim/restoreのownership確認とsession reset連携
- `src/main/linux/portalSidecar.ts` — tainted session再生成と単独claim timeout budget
- `tests/portalClipboardPython.test.ts` — 3回連続claim、前回owner誤認、session resetの回帰テスト（新規）
- `tests/portalSidecar.test.ts` — ownership timeout時の再生成回帰テスト
- `docs/reviews/yukikaze-fix-report-2026-08-04.md` — 本報告書

## テスト結果

1. 変更前baseline: `npm test` — 50 files / 386 tests passed。
2. RED: `npm test -- --run tests/portalClipboardPython.test.ts` — `ModuleNotFoundError: portal_clipboard` で意図どおり失敗。owner barrier未実装を確認。
3. 追加RED: `npm test -- --run tests/portalSidecar.test.ts` — ownership timeout replyでchildが再生成されず、追加assertが意図どおり失敗。
4. 対象GREEN: `npm test -- --run tests/portalClipboardPython.test.ts tests/portalInputPython.test.ts tests/portalSidecar.test.ts` — 3 files / 12 tests passed。
5. Python: `python3 -m py_compile resources/native/portal_clipboard.py resources/native/portal_input.py resources/native/portal-remote.py` — pass。
6. 全件: `npm test` — 51 files / 389 tests passed（既存386 + 新規3）。skip/disabledなし。
7. build: `npm run build` — fnwatcher universal binary確認、main/preload/renderer全bundle成功。
8. 型検査: `npm run typecheck` — node/webともpass。
9. 差分健全性: `git diff --check` と新規3ファイルの同等check — pass。

テストはowner通知の世代管理、timeout、session再生成をfixtureで裏付ける。GNOME compositor、portal backend、実アプリによる `SelectionTransfer` のE2Eはローカルテストでは代替していない。

## 雪風での実機検証手順

1. 本差分を含むLinux成果物を雪風へ配置し、既存WindVoiceを完全終了してから起動する。既存restore tokenを使う通常upgrade経路をまず検証し、ログに `portal sidecar ready (clipboard=true)` が1回出ることを確認する。
2. 既存clipboardへ識別可能な短文 `WV-CLIPBOARD-KEEP` をコピーする。
3. Claude Desktop等のWayland-native編集欄へ、一意な短文 `WV-YK-01` から `WV-YK-10` を10回連続dictationする。各回、画面に1回だけ完全一致し、ログが `ok=true injected=true selectionRead=true restored=true stage=none` になることを確認する。3回目だけでなく10回目まで確認する。
4. 各回後に通常の手動pasteで `WV-CLIPBOARD-KEEP` が残っていることを確認し、restoreが表示上も成立していることを確認する。
5. GNOME Terminalの通常shell promptへ `WV-YK-TERM-01` から `03` をdictationする。Ctrl+Shift+Vで文字列が1回だけ入り、`^V` が出ず、Enterは送られず、各回 `selectionRead=true` であることを確認する。
6. GNOME Overviewまたは非編集領域へ `WV-YK-NEG` をdictationし、負系として `ok=false injected=true selectionRead=false stage=verify recyclePending=true`、通知、manual paste用本文保持を確認する。次のdictation前に必要なら手動pasteで本文を回収する。
7. 直後に編集欄へ `WV-YK-RECOVER` をdictationする。`recycling portal session...` → `portal sidecar ready (clipboard=true)` の後、画面完全一致かつ `ok=true ... selectionRead=true` へ復帰することを確認する。
8. 合格条件は、連続10回、Terminal 3回、負系後の復帰1回がすべて期待どおりで、`selection ownership was not confirmed before the deadline`、`transfer_error`、連続する `stage=verify` がないこと。timeoutが出た場合は時刻を含む前後30秒のWindVoiceログとportal/Mutter journalを採取し、実機未合格として扱う。
