^D[重大度: 軽微] resources/native/portal-remote.py:918 / stdinパース失敗イベント (`protocol_error`) への入力文字列平文混入リスク / `stdin_worker` 内で JSON パース例外が発生した際、`emit({'event': 'protocol_error', 'line': line[:200]})` により受信した生の `line` (先頭200文字) を `stdout` イベントとして出力している。`stdin` から送られる IPC メッセージには `paste` や `set_selection` の `text` フィールドとして音声文字起こしデータ（個人情報となり得るデータ）が含まれるため、構文エラーのある JSON が送信された場合に IPC イベント経由で個人情報が露出・ログ混入するリスクがある（※現状の `src/main/linux/portalSidecar.ts:387` は `msg.message` を参照しているためデバッグログ出力時の混入は免れているが、Python 側のイベント構造として未暗号化の入力テキストを返送するリスクが残っている）。 / `line[:200]` のような生の入力文字列を返送せず、`emit({'event': 'protocol_error', 'message': 'invalid JSON format'})` のように固定のエラー概要メッセージのみを返送する実装に変更する。

---

[確認済み] クリップボード本文（音声文字起こしデータ）のログ出力平文混入防止
- 根拠: [portal-remote.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L700-L718) (700–718行, 858–863行) および [portalSidecar.ts](file:///Users/yukitsuruoka/Development/projects/windvoice/src/main/linux/portalSidecar.ts#L453) (453行, 472行) を確認。D-Bus 応答や失敗通知を行う `emit_paste_result` および Node.js 側の `debug` ログにおいて、レスポンスやエラーメッセージには固定のエラー文字列 (`'selection ownership was not confirmed before the deadline'` 等) や判定フラグのみが含まれ、クリップボードの内容である `text` や `old_text` の生データをログ出力・エラーメッセージに埋め込まない設計となっている。

[確認済み] restore token 保存用一時ファイルのセキュアなハンドリング
- 根拠: [portal-remote.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L355-L386) (355–386行) の `save_restore_token` を確認。`secrets.token_hex(8)` による推測不可能な一時ファイル名の生成、`O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC` フラグを用いたオープン、パーミッション `0o600` の設定、`fsync` および `os.replace` によるアトミック置換が実装されており、他ユーザーからのファイル閲覧、シンボリックリンク攻撃、および作成途中の不完全なファイル読み込みが防止されている。

[確認済み] 境界待ち合わせ (barrier) のスレッドセーフティおよびプロセス間受け渡しにおける DoS 防御
- 根拠: [portal_clipboard.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal_clipboard.py#L19-L50) (19–50行) の `OwnerChangeBarrier` は `threading.Condition` を使用し、GLib 主スレッドの D-Bus シグナル受領と Worker スレッドからの待機処理をスレッドセーフに同期・排他制御している。また、[portal-remote.py](file:///Users/yukitsuruoka/Development/projects/windvoice/resources/native/portal-remote.py#L212-L231) (212–231行, 581–611行) の `write_bounded` および `read_selection_snapshot` では、他プロセスとの UNIX FD 送受信においてノンブロッキング I/O とタイムアウト (`select.select`)、および 1MB の最大サイズ制限が適用されており、不応答な他プロセスによるスレッド無期限ブロックやメモリ枯渇 (DoS) が防止されている。

REVIEW_DONE
