# 雪風 `88a8946` AGY 20観点レビュー判定書（2026-08-04）

対象: `fix/linux-inject` / `88a894633ac7f6511a4172dce9e8e33e6d536c59`

入力: `docs/reviews/agy-20260804/*.md` 20本、`docs/reviews/yukikaze-fix-report-2026-08-04.md`

判定件数: **採用 4 / 却下 7 / 見送り 9（計20）**

## 判定基準と検証境界

- **採用**: 実障害の受領境界を壊す、本文の取り違え・取りこぼしを起こす、または今回追加した安全経路のテストが実効性を欠くもの。
- **却下**: 現行コードと矛盾する誤読、既存の直列化・手動回収・ログ経路で反証できるもの、または提案どおりに直す方が誤判定・二重貼り付けを招くもの。
- **見送り（将来課題）**: 改善余地はあるが、今回の実測障害へ至る経路が示されていないもの。実機計測、別fixture、または別ブリーフで扱う。
- 行番号は判定時の `88a8946` を基準とし、実装で移動した箇所は「実装結果」で更新する。
- ローカルfixtureはGNOME compositor / xdg-desktop-portal実機を代替しない。雪風でのみ確認できる事項は末尾に分離する。

## 全指摘の統合判定

### AGY-01

- **出典観点**: `xdg-spec`
- **要約**: `options['session_is_owner']` が未アンパックのVariantの場合、`False` でもPythonオブジェクトのtruthy評価により所有中と誤認し得る。
- **判定**: **採用**
- **根拠**: `resources/native/portal-remote.py:298-309` は `params.unpack()` 後の辞書要素をそのまま `bool(...)` に渡す一方、同ファイル `280-295` は入れ子Variantが残るPyGObject差異を既に考慮している。ここで偽のowner通知をtrueにすると `resources/native/portal_clipboard.py:40-49` のbarrierを誤通過し、今回防いだ未反映selectionへのキー注入が再発する。
- **採用時の修正方針**: `session_is_owner` 値だけを必要に応じて明示的に `unpack()` してからbool化し、ラップされたfalse/trueの両方を実行テストする。

### AGY-02

- **出典観点**: `test-quality`, `test-gaps`（重複統合）
- **要約**: ownership喪失/resetの既存テストは状態変更後にcheckpointしているため常にfalseとなり、実装バグを検出できない。待機中のfalse通知、続くtrue通知、falseのままtimeoutする経路も未検証。
- **判定**: **採用**
- **根拠**: `tests/portalClipboardPython.test.ts:29-36` は `owner_changed(False)` / `reset()` の後にcheckpointしている。比較対象が同一sequenceなので `_is_owner` の値に関係なく `resources/native/portal_clipboard.py:44` のsequence条件で落ちる。
- **採用時の修正方針**: checkpointを状態変更前へ移し、reset前にowner=trueを作る。さらにfalse通知だけでは待機を打ち切らず、期限内のtrueを受理することと、falseのままなら期限でfalseになることを回帰テストする。

### AGY-03

- **出典観点**: `test-gaps`
- **要約**: paste成功後のrestore ownership timeoutについて、貼り付け成功を維持しつつ `restored=false`, `sessionReset=true` として子を再生成する複合テストがない。
- **判定**: **採用**
- **根拠**: `resources/native/portal-remote.py:794-823` はrestore timeoutをtainted応答にし、`src/main/linux/portalSidecar.ts:466-493` は `injected && selectionRead` からpaste成功を再計算しつつrestartする。しかし `tests/portalSidecar.test.ts:180-227` はinject taintと単独setSelection taintしか覆っていない。
- **採用時の修正方針**: 実プロトコルどおり `ok=true, injected=true, selectionRead=true, restored=false, stage=restore, tainted=true` を返すfixtureを追加し、成功維持・restore失敗・session再生成を同時にassertする。

### AGY-04

- **出典観点**: `test-gaps`
- **要約**: ownership timeout時は遅延SelectionTransferへ新本文を供給できるようselection本文/generationを保持し、同期D-Bus例外時だけrollbackする設計の直接テストがない。
- **判定**: **採用**
- **根拠**: `resources/native/portal-remote.py:623-657` は `SelectionOwnerTimeout` と一般例外を意図的に分離する。ここを誤って共通rollbackすると遅延transferへ旧clipboard本文を返すため、本文取り違えに直結する。既存 `tests/portalClipboardPython.test.ts` はhelper単体だけでこの分岐を実行していない。
- **採用時の修正方針**: `portal-remote.py` の実際の `set_selection` 関数を依存なしfixtureへ取り出して実行し、owner timeoutでは新本文/generation保持、同期例外では旧値rollbackを検証する。挙動が正しいためproduction変更は行わない。

### AGY-05

- **出典観点**: `deadlock`
- **要約**: checkpoint後に `owner_changed(False)` を受けたら2秒を待たず即失敗すべき。
- **判定**: **却下**
- **根拠**: `resources/native/portal_clipboard.py:40-49` は「checkpoint後の任意の通知」ではなく「期限内の新しいowned通知」を待つbarrierである。falseは競合ownerの通知であり、その後に非同期SetSelectionのtrueが届く経路を否定しない。提案どおり即失敗すると正常な遅延claimを偽陰性にする。
- **採用時の修正方針**: なし。AGY-02のfalse→trueテストで現仕様を固定する。

### AGY-06

- **出典観点**: `design-alt`
- **要約**: `reset()` は `owner_changed(False)` と同じ実装なので委譲して重複を除くべき。
- **判定**: **却下**
- **根拠**: `resources/native/portal_clipboard.py:24-34` の処理は現在同型だが、resetは「セッション境界」、owner_changedは「portal通知」という別の意味を持つ。挙動不良はなく、今回の受領障害を直さない純粋リファクタである。
- **採用時の修正方針**: なし。

### AGY-07

- **出典観点**: `latency`
- **要約**: owner barrier後の固定 `settleMs` は二重待機なので150msから30〜50msへ短縮できる。
- **判定**: **見送り（将来課題）**
- **根拠**: `resources/native/portal-remote.py:779-783` のsettleはownershipだけでなく対象側がselection changeを観測してからキーを処理する余裕も兼ねる。レビューの「数ms〜15ms」「30〜50msで十分」は実測値ではなく、雪風の連続成功率を測らず短縮すると今回の取りこぼしを再導入し得る。
- **採用時の修正方針**: 雪風でsettle値別の連続paste成功率・p95を計測して別ブリーフで決める。

### AGY-08

- **出典観点**: `observability`
- **要約**: 単独 `setSelection()` / `keyPaste()` の失敗・tainted restart理由がPortalSidecar自身のdebugログにない。
- **判定**: **見送り（将来課題）**
- **根拠**: `src/main/linux/portalSidecar.ts:508-533` に専用ログはなく診断改善としては正しい。一方、呼び出し側は `src/main/inject/streamingTyper.ts:257-283` と `src/main/inject/paste.ts:25-31` で失敗を扱い、今回のpaste本経路は `src/main/inject/typer.ts:274-280` に構造化結果を残す。受領障害や本文喪失を新たに起こす欠陥ではない。
- **採用時の修正方針**: 将来、本文を含めずop・tainted・error categoryだけを共通ログ化し、debug mockで検証する。

### AGY-09

- **出典観点**: `observability`
- **要約**: `SelectionOwnerTimeout` の文言に実際のtimeout秒数がない。
- **判定**: **見送り（将来課題）**
- **根拠**: `resources/native/portal_clipboard.py:52-64` はdeadline超過を明示し、現呼び出し値は `resources/native/portal-remote.py:78,641-645` の固定2.0秒で追跡できる。診断性改善だが動作修正ではない。
- **採用時の修正方針**: timeout設定を複数化する時点で例外へ値を含め、ログ文言テストを追加する。

### AGY-10

- **出典観点**: `observability`
- **要約**: `sessionRecyclePending=true` 設定時点の即時ログがない。
- **判定**: **却下**
- **根拠**: `src/main/inject/typer.ts:274-280` はpaste応答直後に `recyclePending=${...}` を必ずログ出力する。実機資料 `docs/reviews/yukikaze-2026-08-04-logs.txt` にも `recyclePending=true` が残っており、全体経路として観測欠落はない。
- **採用時の修正方針**: なし。PortalSidecar内へ同内容を重複記録しない。

### AGY-11

- **出典観点**: `resource-leak`, `ts-supervisor`（重複統合）
- **要約**: tainted応答の `restart()` が `MAX_RESPAWNS` をリセットし、Mutter sessionを無限自動生成・蓄積する。
- **判定**: **却下**
- **根拠**: `src/main/linux/portalSidecar.ts:434-535` はtainted応答1件につきrestartを1回行うだけで、操作の自動再送はない。新childのsetup失敗は `365-384` から `requestRespawn()` の上限へ入る。旧childは `255-271` でkillされ、D-Bus接続終了がportal sessionの破棄境界になる。「入力なしで無限ループ」「session蓄積」の発生経路は示されていない。
- **採用時の修正方針**: なし。ユーザー操作を環境変化として再試行可能にする現設計を維持する。

### AGY-12

- **出典観点**: `resource-leak`
- **要約**: `SelectDevices` / `Start` 非0終了時に作成済みportal sessionを明示Closeしていない。
- **判定**: **見送り（将来課題）**
- **根拠**: `resources/native/portal-remote.py:445-464` は明示Closeせずfailed eventを返すため、資源解放の明示性には改善余地がある。ただし親は `src/main/linux/portalSidecar.ts:365-373` で直ちにchildをkillし、接続切断でsessionも閉じる。今回のownership barrier障害や実測されたsession蓄積には結び付いていない。
- **採用時の修正方針**: setupを別ブリーフでtry/finally化し、期待Closed管理とdenied/timeoutのfixtureを揃えて明示Closeする。

### AGY-13

- **出典観点**: `restore-path`, `ts-supervisor`（重複統合）
- **要約**: tainted restartがstdinにキュー済みの次要求や並行pendingをuncertainで中断し、ready復帰前の後続要求も失敗する。
- **判定**: **却下**
- **根拠**: 実アプリのstreaming経路は `src/main/inject/streamingTyper.ts:237-248,385-455` でin-flight境界を待ち、非streaming dictationもorchestratorが一件ずつ完了させる。tainted child上のmutationは続行不能で、`src/main/linux/portalSidecar.ts:315-320` がpending mutationをuncertainにするのは二重pasteを避ける安全動作である。自動再試行案は配信済みか不明な本文を重複注入し得る。
- **採用時の修正方針**: なし。並行mutationを新たに導入する場合のみ上位で明示直列化する。

### AGY-14

- **出典観点**: `restore-path`
- **要約**: paste timeout予算の15秒marginにclaim/restore各2秒が名前付きで現れず保守しにくい。
- **判定**: **見送り（将来課題）**
- **根拠**: `src/main/linux/portalSidecar.ts:440-451` の固定15秒は現行のD-Bus、snapshot、claim/restore owner待ちを包含し、実際のtimeout逆転はない。Python定数をTSへ重複定義すると値のドリフトも生むため、単純な定数追加が必ずしも改善ではない。
- **採用時の修正方針**: プロトコルhandshakeでdeadlineを共有するか、Python timeout変更時に契約テストで予算包含を検証する。

### AGY-15

- **出典観点**: `security`
- **要約**: Pythonの `protocol_error` が不正stdin先頭200文字を返し、文字起こし本文を漏らし得る。
- **判定**: **却下**
- **根拠**: production入力は `src/main/linux/portalSidecar.ts:394-428` の `JSON.stringify` のみで、不正JSON生成経路がない。さらに `resources/native/portal-remote.py:915-919` のイベントを受けた `src/main/linux/portalSidecar.ts:385-388` は `msg.message` だけをログし、`line` を記録しない。既に親子pipeに渡した本文以上の外部露出経路は示されていない。
- **採用時の修正方針**: なし。外部clientを許すプロトコルに変更する場合は固定エラーへ置換する。

### AGY-16

- **出典観点**: `test-gaps`
- **要約**: 単独 `keyPaste()` のtainted応答でchildを再生成する専用テストがない。
- **判定**: **見送り（将来課題）**
- **根拠**: `src/main/linux/portalSidecar.ts:522-533` の分岐は88a8946以前からあり、今回のownership変更箇所ではない。tainted再生成の共通挙動は `tests/portalSidecar.test.ts:180-227` のpaste/setSelectionで既に実行される。
- **採用時の修正方針**: Sidecar supervisionテストを整理する際にtable-driven化し、3 mutation opを同じ契約で覆う。

### AGY-17

- **出典観点**: `xdg-spec`
- **要約**: `SetSelection` の同期D-Bus例外時にもbarrierをresetすべき。
- **判定**: **却下**
- **根拠**: `resources/native/portal_clipboard.py:52-65` のcheckpointは呼び出しローカルで、同期例外後に待機者は残らない。次回は現在sequenceを新しくcheckpointするため不整合はない。`resources/native/portal-remote.py:652-656` の本文/generation rollbackで必要な状態は戻る。resetしても遅延signalを識別・遮断する能力は増えない。
- **採用時の修正方針**: なし。

### AGY-18

- **出典観点**: `env-edge`
- **要約**: give-up後の最初のdictationは `retryForDictation()` がreadyを待たず、短い録音ならmanual pasteへ落ちる可能性がある。
- **判定**: **見送り（将来課題）**
- **根拠**: `src/main/index.ts:77-80` は同期retry後に録音を始め、`src/main/inject/typer.ts:322-335` は未readyなら本文をmanual paste用に保持して通知するため、本文消失はしない。録音・認識・整形中にsidecarがreadyになる通常経路もあり、レビューは実際にreadyが間に合わなかった計測を示していない。
- **採用時の修正方針**: 起動時間分布を測り、必要なら録音開始を止めずpaste直前だけbounded ready待ちを入れる。

### AGY-19

- **出典観点**: `env-edge`
- **要約**: suspendからresumeしたがunlockイベントがない環境ではsidecarを能動再起動しない。
- **判定**: **見送り（将来課題）**
- **根拠**: `src/main/index.ts:506-523` はresumeでaudio/realtime、unlockでWayland sidecarを回復する。想定環境でresume後にD-Bus sessionだけが死に、Closed/exitイベントもunlockも来ない実測経路は提示されていない。
- **採用時の修正方針**: 雪風でlock無効・suspend/resume時のPortal eventを採取し、再現時にresume handlerとpower eventテストを追加する。

### AGY-20

- **出典観点**: `env-edge`
- **要約**: setup失敗後の1時間sleep中に親Nodeが事故終了するとPython側車が最大1時間残る。
- **判定**: **見送り（将来課題）**
- **根拠**: `resources/native/portal-remote.py:905-921` はfailed eventを親に読ませるため意図的にsleepし、通常は親が即killする。親がその数msの間に異常死する複合条件は成立し得るが、今回の実測障害との関係や残留プロセスの観測はない。
- **採用時の修正方針**: stdout flush後の短い猶予で明示exitする方式、またはparent-death検出を別ブリーフで評価する。

## 採用項目の実装結果

- AGY-01: **実装済み** — `resources/native/portal-remote.py:298-312` で `session_is_owner` を明示アンパックしてからbool化。`tests/portalClipboardPython.test.ts:79-145,302-320` でラップfalse/trueを実行検証。
- AGY-02: **実装済み** — `tests/portalClipboardPython.test.ts:29-37` のcheckpointを状態変更前へ修正。`42-77,289-300` でforeign-owner通知後のowned復帰とdeadline timeoutを検証。
- AGY-03: **実装済み** — `tests/portalSidecar.test.ts:229-257` にrestore ownership timeoutの複合回帰テストを追加。paste成功維持、restore失敗、session再生成を同時検証。
- AGY-04: **実装済み** — `tests/portalClipboardPython.test.ts:147-224,323-334` で `portal-remote.py:626-660` の実関数をfixture実行し、owner timeout時の新本文/generation保持と同期例外時のrollbackを検証。production変更なし。

## テスト結果

1. 変更前の対象baseline: `npm test -- --run tests/portalClipboardPython.test.ts tests/portalSidecar.test.ts` — **2 files / 10 tests passed**。
2. RED: 同コマンド — **1 failed / 13 passed**。ラップされた `False` が `isOwner=true`, `barrierValue=true` となる意図した誤判定だけを検出。
3. 対象GREEN: 同コマンド — **2 files / 14 tests passed**。
4. Python構文: `python3 -m py_compile resources/native/portal_clipboard.py resources/native/portal_input.py resources/native/portal-remote.py` — **pass**。
5. 全件: `npm test` — **51 files / 393 tests passed**（既存389 + 新規4、skip/disabledなし）。
6. 型検査: `npm run typecheck` — **node/webともpass**。
7. build: `npm run build` — **pass**。fnwatcherはx86_64/arm64、main/preload/rendererの全bundle成功。既存の `secure.ts` dynamic/static import warningのみ。
8. 差分: `git diff --check` — **pass**。

## 変更ファイル

- `resources/native/portal-remote.py` — ラップされたowner boolの誤判定防止。
- `tests/portalClipboardPython.test.ts` — barrier負系、Variant、timeout時state保持/rollbackの回帰テスト。
- `tests/portalSidecar.test.ts` — restore timeout後の成功維持とsession再生成テスト。
- `docs/briefs/yukikaze-agy20-verdict-2026-08-04.md` — 本判定書・実装証跡。

入力資料の `docs/reviews/agy-20260804/*.md` 20本は変更していない。ブリーフ指定どおりgit commitは試みていない。

## 雪風実機でのみ確認できる事項

- ラップされたVariantが雪風のPyGObject/portal組合せで実際に届くかは、このMacのfixtureでは確認できない。修正は両表現を受理する防御である。
- GNOME Wayland上の連続10回paste、Terminal 3回、負系後の回復、元clipboard復元は `docs/reviews/yukikaze-fix-report-2026-08-04.md` の手順で別途実施する。
- ローカルの `npm test` / typecheck / buildは実機配備・Portal E2E合格を意味しない。
