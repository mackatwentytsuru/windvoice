^D`src/main/linux/portalSidecar.ts` のスーパーバイザ設計に関するコードレビュー結果です。

---

[重大度: 中] src/main/linux/portalSidecar.ts:161-169, 514 / restart連打の抑制不足と `MAX_RESPAWNS` の無効化
- **問題**: `setSelection`（および `pasteText`, `keyPaste`）で Python 側から `r.tainted === true` が返る度に `this.restart()` を同期的に呼ぶ設計のため、`MAX_RESPAWNS` による上限保護および `RESPAWN_DELAY_MS` (3000ms) の再起動遅延が回避され、連続再起動（スローリング）を引き起こすリスクがあります。
- **根拠**: [`requestRespawn()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L289-L298) は `this.respawns` をカウントして `MAX_RESPAWNS` (5回) を超えた場合に give-up し、[`scheduleRestart()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L305-L313) で 3 秒の遅延を入れるスーパーバイザ制御になっています。しかし [`restart()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L161-L169) は `this.respawns = 0` に無条件リセットし、遅延なしで [`this.start()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L190-L242) を即時実行します。`setSelection` ([L514](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L514)), `pasteText` ([L473](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L473)), `keyPaste` ([L528](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L528)) では `tainted: true` 受信時に直接 `this.restart()` を叩いているため、D-Bus や Compositor 側のハング等で `tainted` が短時間で連続発生した場合、再起動カウンターが毎回クリアされて無制限の即時プロセス破棄・再生成が発生します。
- **修正案**: `tainted` 検出によるセッション再生成時は `restart()` を直接叩くのではなく `requestRespawn()` を通すか、`restart()` 内部で前回の起動時刻から最小インターバル（例: 3秒）をチェックするクールダウン／レート制限を導入してください。

---

[重大度: 中] src/main/linux/portalSidecar.ts:509-519 / setSelection での restart 呼び出しと進行中・後続操作の衝突
- **問題**: `setSelection` 内で `r.tainted === true` を検出して即時 `this.restart()` を呼び出すと、並行して走っている他の非同期リクエストが破棄されるほか、後続の操作が sidecar の `ready` 復帰を待てずに `sidecar not ready` エラーになります。
- **根拠**: `setSelection` ([L514](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L514)) が呼ぶ [`restart()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L161-L169) は内部で [`teardownChild()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L255-L271) を実行し、[`rejectAllPending()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L315-L321) を呼び出します。これにより、仮に他タスク（例: 並行する `snapshot()` 等）が `pending` に存在していた場合、それらは即座に `error: 'sidecar restarting'` で強制キャンセルされます。また `restart()` は新しいプロセスの起動処理（`start()`）を開始しますが、D-Bus 接続と RemoteDesktop セッションが確立して `ready` になるのを待たずに戻ります。呼び出し元が `setSelection` の失敗 (`ok: false`) を受けて即座にリトライや別操作を行うと、`isReady()` が `false` ([L397](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L397)) であるため即座に全滅します。
- **修正案**: `r.tainted === true` 発生時は直接プロセスをその場で壊すのではなく、再起動処理を `ready` 完了まで await できる構造（または再起動完了まで後続リクエストをキューイングする仕組み）に改修してください。

---

[確認済み] src/main/linux/portalSidecar.ts:176-188, 161-169 / give-up後の復帰手段
- **確認内容**: [`requestRespawn()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L289-L298) により `MAX_RESPAWNS` (5回) に達して give-up 状態（`child = null`, `ready = false`）に陥った場合でも、次の音声入力（dictation）開始時に呼ばれる [`retryForDictation()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L176-L188) が `respawns = 0` にクリアした上で [`this.start()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L190-L242) を呼び出し、ユーザーの次のアクションをトリガーにして安全にセッション復帰を試みる設計になっていることを確認しました。また、画面ロック解除などの環境変化時も [`restart()`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L161-L169) によって `respawns = 0` かつ `denied = false` にリセットして復帰可能です。

REVIEW_DONE
