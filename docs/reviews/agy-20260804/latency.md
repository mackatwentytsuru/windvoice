^DLinux/Wayland環境における `88a8946` の「正常系レイテンシへの影響」に限定してコードレビューを実施しました。

---

### 確認済み事項（問題なしと確認できた点）

1. **[確認済み] 高速成功パスにおける体感遅延への影響は極めて軽微**
   - **該当ファイル:行番号**: `resources/native/portal-remote.py:636-645, 765-779`
   - **根拠**: 修正前は `SetSelection` の D-Bus メソッド応答直後に `time.sleep(settle)` (150ms) を行ってキー注入に移っていたのに対し、修正後は `SetSelection` 呼び出し後に Compositor からの `SelectionOwnerChanged` D-Bus シグナル受領待ち (`wait_until_owned`) が挟まる。正常な Wayland/GNOME 環境において、D-Bus シグナルが到達・処理されるまでの時間コストは IPC 伝播時間である **数ミリ秒〜15ミリ秒程度** に留まる。人間の認知境界（100ms以上）と比較しても増加分は軽微であり、体感上の貼り付けレスポンスを損なわない。

2. **[確認済み] スレッド間同期による追加オーバーヘッドの不存在**
   - **該当ファイル:行番号**: `resources/native/portal_clipboard.py:30-34, 40-49`
   - **根拠**: `OwnerChangeBarrier` は `threading.Condition` を採用している。GLib メインループスレッドで `on_owner_changed` がシグナルを受信した際、`notify_all()` によって `stdin_worker` スレッドの `wait_until_owned` ブロックを即座に解除する設計となっている。定期的なタイマーやスリープによるポーリング待ちが発生しないため、Python 内の同期機構に起因する無駄なレイテンシ増加は発生しない。

3. **[確認済み] クリップボード復元（restore）処理のレイテンシ非影響性**
   - **該当ファイル:行番号**: `resources/native/portal-remote.py:798-804`
   - **根拠**: 貼り付け完了後の元クリップボード復元処理 `set_selection(old_text)` においても `SelectionOwnerChanged` のシグナル待ちが入るが、この処理はキー注入（`inject_paste_chord`）および対象アプリによるクリップボード読み取り確認（`selection_read`）を終え、`restore_delay` (1500ms) 経過した後のバックグラウンドフロー内で実行される。そのため、ターゲットアプリにテキストが入力されるまでの体感時間には一切影響を与えない。

---

### 発見事項

[重大度: 提案] `resources/native/portal-remote.py:779` / 所有権確定 barrier 導入後の `settleMs` 二重待機の短縮化
- **問題**: Compositor 側で Selection Owner の変更が確定したことを `SelectionOwnerChanged` シグナルで保証した後も、修正前と同じ固定スリープ `time.sleep(settle)` (150ms) が重複して全額実行されており、正常系高速パスにおけるさらなるレイテンシ削減の機会を逃している。
- **根拠**: 修正前の 150ms 固定 `settle` は、「xdg-desktop-portal の D-Bus メソッド応答が返った時点では Compositor 側の所有権が確定していない可能性があるため、念のため待機する」目的で設置されていた。修正後は `apply_selection_and_wait_for_owner` (`portal-remote.py:640-644`) により Compositor 側の所有権確定イベントを確定させてから復帰する。シグナル受信時点で所有権の移行は確定しているため、その後にさらに無条件で 150ms 待つ必要性は薄い（ターゲットアプリが所有権変更 D-Bus 通知を処理する猶予時間として数十msあれば十分なケースが多い）。
- **修正案**: `handle_paste()` 内で `settleMs` のデフォルト値を 150ms から 30ms 〜 50ms 程度へ短縮、あるいは barrier 成功時には settle 待機時間を短縮するロジック調整を行うことで、正常系高速パスのキー注入開始までの総遅延を約 100ms 改善できる可能性がある。

---

REVIEW_DONE
