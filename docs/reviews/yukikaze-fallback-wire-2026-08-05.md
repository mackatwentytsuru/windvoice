# 雪風フォールバック配線修正レビュー（2026-08-05）

## 結論

実機で 845ms で verify 失敗が確定していた原因は、`71fb09e` のフォールバック連鎖が Python の必須動作ではなく、Node/TypeScript から渡される `attempts` 配列に依存していたことだった。

`portal-remote.py` の `paste` ハンドラは `attempts` がない旧呼び出しに対し、初回 `Ctrl+Shift+V` 1件だけをデフォルト生成していた。そのため、新しい Python ファイルと旧/stale bundle の組み合わせでは、1回の 750ms receipt 待ちだけで `no post-injection selection read` を返した。Python ファイル内に keysym 実装や `focused_app_id` import が存在することは、そのコードへ到達する保証になっていなかった。

修正後は Python が `initial -> slow-retry -> keysym -> manual` の順序を所有する。TS は初回/低速のキー間隔だけを渡し、`attempts` の欠落や古い形式で連鎖を無効化できない。

## 実行経路と修正点

1. `typer.ts` は Wayland かつ `portalSidecar.isReady()` のとき、legacy の `sendPasteKeystroke()` ではなく `portalSidecar.pasteText()` を呼ぶ。
2. `portalSidecar.ts` は `op=paste`、receipt 750ms、初回/低速キー間隔を実 Python プロセスへ送る。試行配列そのものは送らない。
3. `portal-remote.py` は呼び出し元の版に関係なく、次の3試行を必ず構築する。
   - `initial`: keycode `Ctrl+Shift+V`
   - `slow-retry`: keycode `Ctrl+Shift+V`（低速間隔）
   - `keysym`: keysym `Ctrl+V`（低速間隔）
4. 各試行は独立した `transfer_checkpoint()` と 750ms の `wait_for_selection_read()` を持つ。receipt 成功時だけ後続を停止する。
5. 全 receipt が失敗した場合は transcript selection を残し、`manual` を記録して TS の手動貼り付け通知へ返す。

変更箇所:

- `resources/native/portal-remote.py`: 必須試行プラン、各段ログ、実プロセス失敗注入モード
- `resources/native/portal_input.py`: 各試行結果コールバック
- `src/main/linux/portalSidecar.ts`: タイミングだけを送るプロトコル、stderr 行単位のログ転送
- `tests/portalPasteFallbackPython.test.ts`: `attempts` 省略時の旧 TS 互換回帰テスト
- `tests/portalSidecar.test.ts`: TS ペイロードと `[dictation] fallback ...` 転送テスト
- `tests/portalSidecarProcess.integration.test.ts`: TS から実 `portal-remote.py` プロセスを起動する統合テスト

## ログ契約

Python は実行済みの各段を stderr に1行ずつ出す。TS は `fallback ` 行を `debug('DICTATION', line)` へそのまま渡すため、永続ログは次の形になる。

```text
[dictation] fallback stage=initial result=verify-failed app_id=org.example.Target shortcut=ctrl-shift-v method=keycode
[dictation] fallback stage=slow-retry result=verify-failed app_id=org.example.Target shortcut=ctrl-shift-v method=keycode
[dictation] fallback stage=keysym result=verify-failed app_id=org.example.Target shortcut=ctrl-v method=keysym
[dictation] fallback stage=manual result=required app_id=org.example.Target
```

初回または途中で receipt が成立した場合は、その段が `result=verified` となり、実行していない後続段は出ない。注入例外では実行中の段が `result=inject-failed` となり、重複貼り付けを避けて `manual` へ移る。

## TDD 証跡

### RED

本番コード変更前に次を実行した。

```text
npm test -- --run tests/portalPasteFallbackPython.test.ts tests/portalSidecarProcess.integration.test.ts

Test Files 2 failed (2)
Tests 2 failed | 2 passed (4)
旧 TS 互換ケースの実測:
  injections: 1件だけ
  checkpoints: [100]
  attempts: 初回 keycode Ctrl+Shift+V だけ
実 Python 統合ケース:
  real Python sidecar did not become ready
```

1件目は `attempts` 省略時に1段で終了する配線不良そのものを再現した。2件目は PyGObject/実 portal を必要とせず、同じ Python エントリポイントへ verify 失敗を安全に注入する統合入口が未実装であることを示した。

### 対象 GREEN（実プロセス）

```text
npm test -- --run tests/portalPasteFallbackPython.test.ts \
  tests/portalSidecarProcess.integration.test.ts \
  tests/portalSidecar.test.ts tests/portalInputPython.test.ts

Test Files 4 passed (4)
Tests 20 passed (20)
real Python process integration: 2311ms
```

統合テストは `PortalSidecar`（TS）から `python3 resources/native/portal-remote.py` を実際に spawn し、通常と同じ改行 JSON、`handle_paste()`、`run_verified_paste_attempts()`、結果応答、stderr 配線を通す。失敗注入は `verify-fail-v1` に限定し、D-Bus/GNOME の代わりに全 receipt を失敗させる。実測結果は `attemptCount=3`、結果の段順が `initial, slow-retry, keysym`、経過時間 2秒以上、stderr に3段と `manual` の4行だった。

段別ログを表示して再実行した実測:

```text
WINDVOICE_DEBUG_DICTATION=1 npm test -- --run \
  tests/portalSidecarProcess.integration.test.ts --reporter=verbose

[dictation] portal sidecar ready (clipboard=true)
[dictation] fallback stage=initial result=verify-failed app_id=windvoice.integration.test shortcut=ctrl-shift-v method=keycode
[dictation] fallback stage=slow-retry result=verify-failed app_id=windvoice.integration.test shortcut=ctrl-shift-v method=keycode
[dictation] fallback stage=keysym result=verify-failed app_id=windvoice.integration.test shortcut=ctrl-v method=keysym
[dictation] fallback stage=manual result=required app_id=windvoice.integration.test
[dictation] portal paste result targetApp=windvoice.integration.test attempts=3 shortcut=ctrl-v method=keysym injected=true selectionRead=false
Test Files 1 passed (1)
Tests 1 passed (1)
integration test: 2340ms
```

## 全体検証

```text
python3 -m py_compile resources/native/portal_input.py resources/native/portal-remote.py
# exit 0

npm run typecheck
# typecheck:node exit 0
# typecheck:web exit 0

npm test
# Test Files 54 passed (54)
# Tests 405 passed (405)
# 実 Python process integration: 2334ms

npm run build
# fnwatcher: x86_64 arm64
# main: 53 modules transformed
# preload: 2 modules transformed
# renderer: 43 modules transformed
# exit 0
```

全テスト中の既存負系 fixture は `[error] paste keyTap failed: uiohook-napi: keyTap not available` を出したが、そのテストを含め 405 件すべて成功した。build には `secure.ts` の static/dynamic import 併用 warning が1件出たが、全 bundle は生成され exit 0 だった。

## 未確認境界

- 雪風の GNOME Wayland portal、実キーボード注入、実対象アプリでの連続音声入力はこのローカル検証では実行していない。
- 統合テストが保証するのは、TS から実 Python プロセスへ届いた verify 失敗が3段すべてを実行し、結果と stderr/永続ログ経路に痕跡を残すこと。
- 実機再配備後は同一入力先で4〜5回連続入力し、各試行の `fallback stage=... app_id=...` と最終 `selectionRead`、本文の重複有無を照合する必要がある。
- git commit は行わず、修正は作業ツリーに残した。
