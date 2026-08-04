^D[重大度: 中] tests/portalClipboardPython.test.ts:31-36 / 所有権喪失およびセッションリセット検証において、状態変更後に checkpoint を取得しているため判定条件が常に偽となり、実装バグを検出できない / [`portal_clipboard.py` の `wait_until_owned`](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal_clipboard.py#L40-L49) は `self._sequence > after_sequence and self._is_owner` を評価する。[PROBE Script](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalClipboardPython.test.ts#L31-L36) の31〜36行目では、`barrier.owner_changed(False)` や `barrier.reset()` を呼んだ**後**に `lost_checkpoint` / `reset_checkpoint` を取得している。このため `wait_until_owned` 内で `self._sequence` と `after_sequence` が同値になり、`_is_owner` の状態にかかわらず常に `False` が返ってしまう。仮に `owner_changed(False)` や `reset()` 内で `self._is_owner = True` に誤設定されるバグが存在してもテストが通過する。 / 状態変更を伴う操作の**前**に checkpoint を取得し、操作後にその checkpoint に対して `wait_until_owned` を呼び出すように変更する。
```python
# Losing ownership must also be visible
lost_checkpoint = barrier.checkpoint()
barrier.owner_changed(False)
results.append(barrier.wait_until_owned(lost_checkpoint, 0))

# Session reset must invalidate ownership
barrier.owner_changed(True)
reset_checkpoint = barrier.checkpoint()
barrier.reset()
results.append(barrier.wait_until_owned(reset_checkpoint, 0))
```

[確認済み] tests/portalSidecar.test.ts:208-227 / `setSelection` タイムアウト時のセッション再構築テストの実効性 / [`portalSidecar.test.ts`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalSidecar.test.ts#L208-L227) で Python 側からの `tainted: true` 応答をモックし、[`PortalSidecar.setSelection`](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L509-L517) が `{ ok: false, uncertain: true }` を返すと同時に古い子プロセスを `kill()` して新しいプロセスを spawn することを適切に検証できている。Python 側 ([`portal-remote.py`](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L767-L771)) の `SelectionOwnerTimeout` 時の応答プロトコルとモックの定義が完全一致している。

[確認済み] tests/portalClipboardPython.test.ts:41-69 / `CLAIM_PROBE` による古い所有権 (stale owner) の判定すり抜け防止の検証実効性 / 過去の `SelectionOwnerChanged(True)` により `_is_owner = True` の状態であっても、新しい SetSelection 呼び出しに対してシグナルが再発火しない場合 ([`apply_selection_and_wait_for_owner`](file:///Users/yukitsuruoka/Development/projects/windvoice/tests/portalClipboardPython.test.ts#L56-L59) に `lambda: None` を渡すケース) に確実に `SelectionOwnerTimeout` に倒れることがアサートされており、SetSelection D-Bus 応答と所有権変更の競合をシミュレートするテストとして妥当に機能している。

REVIEW_DONE
