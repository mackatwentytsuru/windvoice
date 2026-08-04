^D/Users/yukitsuruoka/Development/projects/windvoice (ブランチ `fix/linux-inject`) コミット `88a8946` について、ご指定の担当観点（barrier方式の設計妥当性、代替案との比較、過剰・過小設計の指摘）に絞ってレビューを実施いたしました。

---

### レビュー結果

[確認済み] `resources/native/portal_clipboard.py:11-50` / シグナル駆動 + 単調増加シーケンスによる Barrier 方式の設計妥当性
- **問題なしの確認**: `SetSelection` D-Bus メソッドの復帰応答は xdg-desktop-portal フロントエンドがリクエストを受理した時点を示しているだけであり、コンポジタ側で Selection 所有権が反映されたこととは非同期です。本修正では `SetSelection` 実行前に `checkpoint()` で単調増加シーケンス `_sequence` を取得し、実行後に `_sequence > checkpoint` かつ `_is_owner == True` となる `SelectionOwnerChanged` シグナルを受信するまで待機する `OwnerChangeBarrier` を導入しています。
- **根拠**: 自アプリが前回のコピー等で既に クリップボード所有者（`_is_owner == True`）であっても、単なるブール値ではなく `checkpoint()` 取得「後」の新しい所有権確認シグナルのみを受理するため、以前の所有状態を新リクエストの完了と判定してしまう競合状態（stale owner 誤判別）が確実に防がれています。また `apply_selection()` 呼び出し直後にシグナルが先回りして届いた場合でも、`checkpoint` が呼び出し前にあるため取りこぼすことがありません。

[確認済み] `resources/native/portal-remote.py:636-646` / イベント駆動待ちと代替案（ポーリング・Selection読み戻し）の比較による最善性
- **問題なしの確認**: イベント駆動シグナル待ち（`SelectionOwnerChanged` の barrier 待ち）は、代替案である「ポーリング」や「Selection データ読み戻し確認（Read-back verification）」と比較して最善の設計です。
- **根拠**:
  1. **ポーリング案との比較**: xdg-desktop-portal の Clipboard API には所有権状態を即座に返す同期型取得 API は存在せず、一定周期で問い合わせるポーリングは無駄な CPU 消費と遅延の増加を招きます。
  2. **Selection 読み戻し確認案との比較**: `SetSelection` 後に Portal の `RequestData` 等で自アプリからデータを読み戻して確認する手法は、不要な IPC / パイプ転送のオーバーヘッドを生み、自プロセス内の `SelectionTransfer` 状態管理と競合するリスクを伴います。
  したがって、コンポジタからの公式通知 `SelectionOwnerChanged` D-Bus シグナルを同期バリアとして利用する本設計が、低遅延・低オーバーヘッドかつ最も整合性の高い解となります。

[確認済み] `resources/native/portal-remote.py:78,639-652`, `src/main/linux/portalSidecar.ts:510-515` / 適切なスケールの過不足のない設計（過剰・過小設計の検証）
- **問題なしの確認**: タイムアウト設定とセッション汚染時（`tainted`）のリカバリ制御について、過大設計（オーバーエンジニアリング）および過小設計（アンダーエンジニアリング）がない適切な規模の設計であることを確認しました。
- **根拠**:
  - `SELECTION_OWNER_TIMEOUT_S = 2.0`（Python側）および Sidecar の 7,000ms（TypeScript側）のタイムアウト設定は、D-Bus タイムアウト（3,000ms）とコンポジタの所有権反映遅延を十分に許容しつつ、UIを長時間フリーズさせない適切な設定です。
  - 所有権確認がタイムアウトした際、エラーを揉み消さず `tainted=True` を返して Python / TypeScript 双方で Portal セッション全体を再構築 (`restart()`) させる構成をとっています。これにより、非同期で遅れて届く可能性のある `SetSelection` リクエストによる状態汚染をリセットによって確実にクリアできるため、自己回復能力が高く過不足のない設計となっています。

[提案] `resources/native/portal_clipboard.py:24-28` / `reset()` メソッドの内部重複
- **問題**: `reset()` メソッド内の処理（`_sequence` インクリメント、`_is_owner = False` 設定、`notify_all()` 呼び出し）は、`owner_changed(False)` の処理内容と完全に同一です。
- **根拠**: `reset()` は所有権を強制的に `False` に落としてシーケンスを進める操作であるため、`owner_changed(False)` の動作と同等です。
- **修正案**: `reset()` 内で直接ロック操作を行う代わりに `self.owner_changed(False)` を呼び出す形にリファクタリングすることで、ロジック重複を排出し保守性を向上させることができます。

---

REVIEW_DONE
