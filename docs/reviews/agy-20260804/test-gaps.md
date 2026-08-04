^D対象コミット `88a8946` に対する「テスト欠落の列挙および未カバー分岐・エッジケース」のレビュー結果です。

---

### [重大度: 中] `resources/native/portal-remote.py:801` および `src/main/linux/portalSidecar.ts:104` / `tests/portalSidecar.test.ts:208`
- **問題**: `pasteText` 実行中の restore ステージ（`set_selection(old_text)`）で `SelectionOwnerTimeout` が発生し、Python側から `stage: 'restore'`, `tainted: True` が返却された場合の Sidecar 再生成（`sessionReset` / `restart`）および戻り値の検証テストの欠落。
- **根拠**: [`portal-remote.py:801-823`](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L801-L823) では `selection_read` 後の restore 処理で `SelectionOwnerTimeout` をキャッチすると `restore_tainted = True` を設定し `emit_paste_result(..., 'restore', restore_error, tainted=True)` を返します。[`portalSidecar.ts:104-109`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L104-L109) は `r.tainted === true` を受けて `this.restart()` を呼び出し `sessionReset: true` を返しますが、[`tests/portalSidecar.test.ts:208-227`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalSidecar.test.ts#L208-L227) には `setSelection` 単独オペレーションの timeout テストしか存在せず、`pasteText` の restore ステージ失敗時にセッションが再生成される複合挙動を検証するテストが欠落しています。
- **修正案**: `tests/portalSidecar.test.ts` に、`pasteText` 呼び出し中に `reply` として `{ ok: false, claimed: true, injected: true, selectionRead: true, restored: false, stage: 'restore', tainted: true, error: '...' }` を返した際、`pasteText` の結果が `{ ok: true, restored: false, sessionReset: true }` となり、`first.kill` が呼ばれて Sidecar が再生成されることを検証するテストケースを追加してください。

---

### [重大度: 中] `resources/native/portal_clipboard.py:40` / `tests/portalClipboardPython.test.ts:71`
- **問題**: `OwnerChangeBarrier.wait_until_owned` において、`after_sequence` チェックポイント取得後にオーナー権限が一旦喪失 (`owner_changed(False)`) してタイムアウトを迎えるマルチスレッド待機分岐のテスト欠落。
- **根拠**: [`portal_clipboard.py:43-49`](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal_clipboard.py#L43-L49) のループでは `self._sequence > after_sequence and self._is_owner` の両条件を評価しています。[`tests/portalClipboardPython.test.ts:7-38`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalClipboardPython.test.ts#L7-L38) の `PROBE` は `wait_until_owned(..., 0)` によるタイムアウト0秒での即時チェックしか行っておらず、「checkpoint 取得後に `owner_changed(False)` が発生し、待機中にタイムアウトを迎えて確実・安全に `False` を返すか」というマルチスレッド待機条件分岐のテストが未カバーです。
- **修正案**: `tests/portalClipboardPython.test.ts` の `PROBE` に、別スレッドから `owner_changed(False)` を通知させた状態で `wait_until_owned` にタイムアウト時間を指定し、誤認せず `False` が返ることを検証するスレッド非同期テストケースを追加してください。

---

### [重大度: 軽微] `resources/native/portal-remote.py:646` / `tests/portalClipboardPython.test.ts:1`
- **問題**: `set_selection` で `SelectionOwnerTimeout` が発生した際、遅延 `SelectionTransfer` に備えて `selection_text` および `selection_generation` のロールバックを行わず保持する設計意図に対するテストの欠落。
- **根拠**: [`portal-remote.py:646-654`](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L646-L654) では `except SelectionOwnerTimeout:` で例外をそのまま再送出し、通常例外 (`except Exception:`) のような `state['selection_text'] = previous_text` へのロールバックを行わない実装になっています。しかし [`tests/portalClipboardPython.test.ts`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalClipboardPython.test.ts) は `portal_clipboard.py` の単体モジュールのみをロードしてテストしており、`portal-remote.py` 内の `state['selection_text']` がタイムアウト時に保持されるという状態保護ロジックをテストしていません。
- **修正案**: `portal-remote.py` の `set_selection` 内の状態保持ロジックを直接検証する Python テストを追加し、`SelectionOwnerTimeout` 発生時に `state['selection_text']` が新しいテキストのまま残留し、それ以外の例外ではロールバックされることをアサートしてください。

---

### [重大度: 提案] `src/main/linux/portalSidecar.ts:164` / `tests/portalSidecar.test.ts:208`
- **問題**: `PortalSidecar.keyPaste()` で `r.tainted === true` が返ってきた場合のプロセス再生成 (`this.restart()`) に対するテストの欠落。
- **根拠**: [`portalSidecar.ts:164`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L164) に `if (r.tainted === true) this.restart();` が実装されていますが、[`tests/portalSidecar.test.ts:208-227`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalSidecar.test.ts#L208-L227) には `setSelection` の `tainted: true` テストはあるものの、`keyPaste()` 単体で `tainted: true` が返された場合のテストが存在しません。
- **修正案**: `tests/portalSidecar.test.ts` に `keyPaste()` を呼び出して `{ ok: false, tainted: true }` を返した場合に Sidecar が再生成されることを確認するテストケースを追加することを提案します。

---

### [確認済み]
1. **[確認済み] `resources/native/portal_clipboard.py:11` / `tests/portalClipboardPython.test.ts:72`**
   - **確認内容**: `OwnerChangeBarrier` における同一セッション内での複数回 `SetSelection` に対するシーケンス（世代）管理と、古くなったオーナー情報の拒否 (`stale-owner-rejected`)。
   - **根拠**: [`tests/portalClipboardPython.test.ts:72-101`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalClipboardPython.test.ts#L72-L101) の `PROBE` および `CLAIM_PROBE` テストによって、前回の `is_owner=True` 状態が残っていても新しい `checkpoint` 後の `owner_changed(True)` シグナルがない限り `wait_until_owned` が `False` / `SelectionOwnerTimeout` となることが確実にテストで検証されています。

2. **[確認済み] `src/main/linux/portalSidecar.ts:512` / `tests/portalSidecar.test.ts:208`**
   - **確認内容**: `PortalSidecar.setSelection()` における `tainted: true` 応答時の Sidecar プロセス再起動 (`restart()`) 制御。
   - **根拠**: [`tests/portalSidecar.test.ts:208-227`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalSidecar.test.ts#L208-L227) の「rebuilds a session whose standalone selection claim timed out」テストにて、`setSelection()` 呼び出しに対して `{ ok: false, tainted: true, error: '...' }` を返すと `first.kill` が呼ばれ `children.length` が 2 に増える挙動がアサート検証されています。

3. **[確認済み] `resources/native/portal-remote.py:323` / `tests/portalClipboardPython.test.ts:34`**
   - **確認内容**: `on_session_closed()` および `setup_session()` 時における `OwnerChangeBarrier.reset()` の呼び出しとシグナル世代のリセット。
   - **根拠**: [`portal-remote.py:323, 406, 496`](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L323) でセッションリセット時に `owner_change_barrier.reset()` が呼び出され、[`tests/portalClipboardPython.test.ts:34-36`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalClipboardPython.test.ts#L34-L36) にて `reset()` 呼び出し後に `reset_checkpoint` の `wait_until_owned` が `False` を返して過去のオーナー状態が失効することがテストされています。

REVIEW_DONE
