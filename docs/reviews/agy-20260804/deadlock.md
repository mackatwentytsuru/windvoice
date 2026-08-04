^D担当観点（ブロッキングとタイムアウトの整合性、タイムアウト階層の破綻、GLibメインループの自己デッドロックの可能性）に基づき、コミット `88a8946` および関連ファイルをレビューしました。

---

### [確認済み]
**ファイル:行番号**: [portal-remote.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L924-L925), [portal_clipboard.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal_clipboard.py#L40-L49)  
**確認内容**: wait中にメインループが止まりシグナル自体が処理されない自己デッドロックの不在  
**根拠**: Pythonプロセスのメインスレッドで `GLib.MainLoop().run()` が動作しており、D-Busシグナル `SelectionOwnerChanged`（`on_owner_changed`）はメインスレッドで非同期に受信・処理されます。一方、`set_selection` 内の `apply_selection_and_wait_for_owner` による待機処理は、サブスレッド `stdin_worker` 上で `threading.Condition().wait(remaining)` を呼び出して行われます。シグナル受信スレッドと待機スレッドが分離されているため、`stdin_worker` がウェイト中であってもメインスレッドの GLib メインループは停止せず、D-Bus シグナルを正常に受容して `owner_change_barrier.owner_changed()` を呼び出し `Condition` を通知できます。自己デッドロックが発生する構造にはなっていません。

### [確認済み]
**ファイル:行番号**: [portalSidecar.ts](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L511), [portal-remote.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L77-L78)  
**確認内容**: `setSelection` における TS (7s) / Python (2s) / D-Bus (3s) タイムアウト階層の整合性  
**根拠**: [portalSidecar.ts:511](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L511) では `setSelection` のタイムアウトを 7000ms (7.0s) に設定しています。これに対し Python 側での最大処理時間は、D-Bus `SetSelection` 呼び出しタイムアウト 3000ms (`DBUS_TIMEOUT_MS`) + シグナル待機タイムアウト 2000ms (`SELECTION_OWNER_TIMEOUT_S`) = 計 5000ms (5.0s) です。最悪のケース（D-Bus応答が3s直前に返り、その後にシグナルが来ず2s待機）でも Python 側の自律タイムアウト処理が 5.0s で完了するため、TS 側の 7.0s タイマーが先行して切れることはありません。また D-Bus 呼び出し自体が 3000ms を超えた場合は `dbus_timeout_exit` により即座に `os._exit(1)` されるため、TS 側がタイムアウトする前に子プロセスの終了を検知できます。

### [確認済み]
**ファイル:行番号**: [portal-remote.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L646-L651), [portalSidecar.ts](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L471)  
**確認内容**: ownership タイムアウト発生時のセッション汚染 (tainted) と再構築の整合性  
**根拠**: [portal-remote.py:646-651](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L646-L651) で ownership 確認が 2 秒でタイムアウトして `SelectionOwnerTimeout` が発生した際、Python 側は `tainted=True` をレスポンスに含めて送信し、[portalSidecar.ts:471, 512](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L471) で `r.tainted === true` を検知して `this.restart()` を呼び出し RemoteDesktop セッションごとプロセスを再構築します。これにより、遅れて届く可能性のある `SetSelection` の反映による古い状態の持ち越しや不整合が安全にリセットされます。

---

### [提案]
**ファイル:行番号**: [portal_clipboard.py:40-49](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal_clipboard.py#L40-L49)  
**問題**: 他プロセスによる ownership 奪取通知を受領した際、2秒間のタイムアウト満了まで不要な待機が発生する  
**根拠**: `wait_until_owned` のループ条件（`if self._sequence > after_sequence and self._is_owner: return True`）において、`after_sequence` より新しいシグナルを受信した際、`self._is_owner` が `False`（他アプリがクリップボード権限を取得）であると条件を満たさず、`remaining` が 0 になるまで `self._condition.wait(remaining)` で待機を継続します。他アプリへ所有権が移って `_is_owner` が `False` になったことが確定した場合でも、2.0秒のタイムアウト満了まで無駄にブロックされてしまいます。  
**修正案**: `_sequence > after_sequence` かつ `not self._is_owner` であることが判明した場合は、権限取得失敗が確定したとして即座に `return False` で早期復帰させる。

```python
    def wait_until_owned(self, after_sequence, timeout_s):
        end = time.monotonic() + timeout_s
        with self._condition:
            while True:
                if self._sequence > after_sequence:
                    if self._is_owner:
                        return True
                    return False
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
```

---

REVIEW_DONE
