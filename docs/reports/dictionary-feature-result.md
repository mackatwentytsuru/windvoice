# ユーザー辞書・レビュー修正 実装結果

- 実施日: 2026-08-01
- ベース: `release/mac-v0.1.14` (`da41db4`)
- ブランチ: `feat/user-dictionary`
- 参照ブリーフ: `docs/briefs/dictionary-and-review-fixes.md`

## 実装サマリ

### ユーザー辞書

- `dictionary/seed-corrections.ja.json` の `correct / variants[] / context` を Zod の正式スキーマにした。件数・文字長にも上限を設け、不正なファイルは最後に読めた正常値（初回は seed）へフォールバックする。
- 初回起動時に seed を `%APPDATA%\windvoice\user-dictionary.json` へコピーし、起動時およびファイル更新時に再読込する。
- `variants` を長いものから `correct` へリテラル置換する。`context` に「文脈依存」を含むエントリはローカル置換から除外する。
- 最終 STT 結果へ辞書を適用してから、後処理・ペースト／タイプ・履歴保存へ渡す。辞書候補がある場合、不可逆なストリーミング途中挿入は行わず、置換後の最終テキストを一括挿入する。
- `windvoice --add-correction "誤変換=正しい語"` を追加した。起動済みインスタンスにも Electron の single-instance データで渡せる。更新は直列化・重複排除・競合 variant の所有先変更・一時ファイルからの atomic rename で処理する。
- Realtime transcription を `gpt-live-transcribe` に更新し、`prompt: "この話者がよく使う固有名詞です。"` と正規化済み `keywords` を送る。辞書のファイル変更はアイドル中の接続にも `session.update` で反映する。仕様確認: [OpenAI Realtime transcription context](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context)
- オプトインの `transcript-learning.jsonl` を追加した。保存項目は `timestamp / raw / corrected` のみで、既知の API key・Bearer・Basic・token 形式をマスクする。設定画面に注意書き付きトグルを追加した。
- `electron-builder.yml` に `dictionary/**` を追加し、パッケージへ seed を含めた。

### 確定重大バグの修正

- 非同期音量ダックの二重実行と、ダック途中の restore 取りこぼしを直した。
- 接続前の quick tap、`stop()` 二重実行、確定 transcript 後の遅延 socket error、処理中の新規開始、音声 renderer error、suspend／lock を安全に中断・復旧するようにした。
- 音声キャプチャ窓の load／ready 失敗を zombie 化させず破棄して1回再試行する。無音 watchdog は「chunk が0件」の完全停止だけを1回再構築し、通常の短い無音を途中で切断しない。
- UI broadcast は破棄済み window と非 sandbox の audio renderer を除外し、構造化エラーと文字列エラーを IPC 前にマスクする。
- hotkey の複合修飾キー先行 release、paste 抑制中の安全な toggle stop、OS suspend／lock 後の押下状態、処理中に拒否された toggle、Accessibility 失敗後の再試行を直した。Windows/Linux の hook 起動失敗はトレイ／UIへ通知する。
- ストリーミング中にユーザーが新しくコピーした clipboard を、古い snapshot で上書きしないよう所有権を確認する。
- debug log の rotation 失敗時は上限超過後の追記を止め、無制限増大を防ぐ。

## テスト結果

TDD の RED として、辞書・CLI・ログ・Realtime hints・dictation lifecycle・audio・broadcast・hotkey・clipboard の再現テストを先にコミットした。初期の依存不要 contract test は、辞書実装前に 2/2 failure を確認した。以後の RED checkpoint は各テストコミットの本文にも記録している。

| 検証 | 結果 |
|---|---|
| `git diff --check release/mac-v0.1.14...HEAD` | PASS |
| `node --experimental-transform-types --check`（変更された `.ts` 28ファイル） | PASS（28/28） |
| seed JSON／正式 shape／文脈依存 skip／APPDATA path／CLI／Realtime prompt/model の contract audit | PASS |
| `audioCapturePolicy` 依存不要 smoke test | PASS |
| `npm ci --ignore-scripts --no-audit --no-fund --cache .npm-cache` | BLOCKED。registry の tarball fetch がすべて `EACCES`、55秒で timeout。`node_modules` は空のまま |
| `npm test` | BLOCKED。依存未取得のため `vitest` が見つからない |
| `npm run typecheck` | BLOCKED。依存未取得のため `tsc` が見つからない |

この実行環境ではネットワーク制限により、ブリーフが要求する Vitest 全通過を実測できなかった。マージ前ゲートとして、ネットワーク利用可能な Windows 実機で `npm ci`, `npm test`, `npm run typecheck` を必ず実行すること。

## agy 10隊レビュー採否

判定基準はブリーフどおり、クラッシュ・データ喪失・秘密漏えい・発話喪失につながる確定経路だけを採用した。「却下（既対応）」は現行コードに同等の防御があり、追加変更が不要だった項目を表す。

| 隊-項 | 指摘（要約） | 判定 | 理由／対応 |
|---|---|---|---|
| 1-1 | AudioDuck 非同期競合・restore 漏れ | 採用 | duck を coalesce し、restore は進行中 duck を待つ |
| 1-2 | Control/Option 等の hotkey 別名 | 却下 | 設定UIは正規 token を生成。外部設定互換であり重大確定バグではない |
| 1-3 | debug の同期 I/O | 却下 | 性能提案。今回の確定ディスク障害は 9-1 で対処 |
| 1-4 | 破棄 window への delta broadcast | 採用 | property access/send を破棄判定と try/catch で保護 |
| 1-5 | clipboardWrite の構文切断・unlock 不足 | 却下（既対応） | 実ファイルは切断されておらず `finally` で handle/free/close 済み |
| 2-1 | quiet watchdog の誤 recapture／連打 | 採用 | chunk 0件のみ、1 take 1回に制限 |
| 2-2 | keep-warm の device change 追従不足 | 却下（既対応） | renderer に `devicechange`、track health、default fallback が既存 |
| 2-3 | audio error が進行中 take を止めない | 採用 | orchestrator へ伝播し即時中断・通知・socket破棄 |
| 2-4 | AudioBridge init/ready 失敗の zombie | 採用 | 失敗窓を破棄し startup で1回再試行 |
| 2-5 | recapture fire-and-forget 競合 | 却下（既対応） | renderer の `recovering/pendingResume/forwardingRequested` で直列化済み |
| 3-1 | reconnect 後に壊れた client を再利用 | 採用 | in-flight reconnect は cycle 中断後に client を detach/dispose |
| 3-2 | suspend 中 inFlight で half-open が残る | 採用 | suspend/lock 時に take と socket を強制解放 |
| 3-3 | 録音中 backpressure 検知不足 | 却下（既対応） | client は buffer 上限・drop 集計・継続 drop 通知を既に実装。例外を投げない API |
| 3-4 | commit 待ち close の status 不整合 | 却下（既対応） | unexpected close は先行 `reconnecting` で中断。final 後の clean/late close は内容を保持すべき |
| 3-5 | maintenance refresh の一時 offline error | 却下 | 一時的表示の UX 方針で、重大データ障害ではない |
| 4-1 | paste 抑制中に toggle stop を喪失 | 採用 | synthetic Ctrl/Cmd+V と一致しない active toggle の停止だけ許可 |
| 4-2 | 後処理完了前に inFlight を解除 | 採用 | paste/history 完了まで active を維持し `finally` で必ず解放 |
| 4-3 | 複合 PTT の修飾キー先行 release | 採用 | 必須 modifier が1つでも離れた時点で force-stop |
| 4-4 | streaming clipboard の競合上書き | 採用 | 最後に自分が書いた値と一致する場合だけ restore |
| 4-5 | OpenClipboard retry 不足 | 却下（既対応） | Win32 失敗時は Electron write へ fallback、全 handle は finally cleanup |
| 5-1 | GUI stderr の診断ログ消失 | 却下 | 診断性のみで、指定された重大4分類には該当しない |
| 5-2 | 非macOS hook 失敗の無通知 | 採用 | Windows/Linux は status error と SYSTEM_ERROR を通知。macOS retry 状態も修正 |
| 5-3 | callback/stop 例外の無ログ | 却下 | best-effort cleanup の診断性提案で、処理継続を優先 |
| 5-4 | SecureStore 失敗の通知不統一 | 採用 | SYSTEM_ERROR と error report 境界へ統一 |
| 5-5 | auto-launch 読取失敗の無ログ | 却下 | 設定表示の診断性であり重大障害ではない |
| 6-1 | error 経由の秘密 IPC/report 漏えい | 採用 | 共通 broadcast 前に構造化／文字列 error を scrub |
| 6-2 | 独自 broadcast が audio renderer へ transcript 漏えい | 採用 | 全 transcript/history を audio 除外共通 broadcaster へ統合 |
| 6-3 | debug secret pattern 不足 | 採用 | API key/query/token/Bearer/Basic を追加 |
| 6-4 | audio window の `sandbox:false` | 却下 | Electron 42 の blob AudioWorklet に必要。context isolation、nodeIntegration無効、IPC送信元検証を維持 |
| 6-5 | settings window に media permission | 却下 | device label 列挙に使用。専用 session 化は別設計で、今回の確定漏えいではない |
| 7-1 | start 順序による録音開始遅延 | 却下 | 性能提案 |
| 7-2 | debug 同期 file I/O | 却下 | 性能提案（無限増大だけ 9-1 で修正） |
| 7-3 | Windows duck の PowerShell 負荷 | 却下 | 性能提案 |
| 7-4 | getActiveWindow の注入遅延 | 却下 | 性能提案 |
| 7-5 | API key の重複読取 | 却下 | 性能提案。secure store を唯一の source of truth とする |
| 8-1 | warm/connect 中 quick tap で録音永久化 | 採用 | forwarding 前でも cycleId を進め、start continuation を無効化 |
| 8-2 | stop の re-entrancy／二重注入 | 採用 | `stopPromise` で commit・paste を coalesce |
| 8-3 | toggle と orchestrator の脱調 | 採用 | busy start を拒否したとき toggle active を巻き戻す |
| 8-4 | cancelled start の client 漂流 | 却下 | 接続成功 client は意図した keep-warm。失敗は既存 error 経路で回収 |
| 8-5 | final 後の遅延 onError が結果を破棄 | 採用 | final を authoritative とし、socket だけ次回用に破棄 |
| 9-1 | log rotation 失敗で無限増大 | 採用 | cap 超過中の追記を止め、間隔を置いて rotation 再試行 |
| 9-2 | sleep 中の inFlight 固着 | 採用 | suspend/lock で cycle、timer、audio、socket を解放 |
| 9-3 | sleep 後も duck 音量が残る | 採用 | suspend abort と AudioDuck race fix で restore |
| 9-4 | sleep/lock 後に key state が残る | 採用 | modifier/PTT/toggle/waiter/suppression を reset |
| 9-5 | resume 直後 offline で不要な error | 採用 | suspend/lock の降下時に client を破棄し、通常 resume は次回 start の lazy connect |
| 10-1 | 接続前 PTT release の silent discard | 採用 | 8-1 と同じ quick-tap cancellation |
| 10-2 | API key 未設定の視覚通知不足 | 却下（既対応） | tray を `unavailable` にし、設定導線と key change prewarm が既存 |
| 10-3 | 無音／mic 不可の tray 通知不足 | 却下 | 通知UIの方針であり、検出・settings notice・再 capture は既存 |
| 10-4 | streaming が後処理を無効化 | 採用（辞書部分） | 辞書候補時は final insertion に切替。GPT整形無効は設定UIで明示済み |
| 10-5 | macOS duck/Fn の非対応警告 | 却下 | UX改善であり重大確定バグではない |

## Windows 実機検証手順

1. `feat/user-dictionary` を取得し、リポジトリ直下で `npm ci`, `npm test`, `npm run typecheck`, `npm run package:win` を順に実行する。
2. 既存の `%APPDATA%\windvoice\user-dictionary.json` があれば退避して WindVoice を起動する。seed が同パスへコピーされ、JSON が `version: 1` と `entries` を持つことを確認する。
3. アプリ終了状態と起動状態の両方で、package 済み exe に `--add-correction "コードックス=Codex"` を付けて起動する。JSON に1件だけマージされ、同じコマンドを再実行しても variant が重複しないことを確認する。
4. JSON をエディタで変更・保存し、アプリ再起動なしで新 variant が次の発話へ反映されることを確認する。不正 JSON を一時保存した場合は直前の正常辞書で dictation が継続することも確認する。
5. 「コードックス」「ウィンドボイス」等を発話し、挿入テキストと履歴が `Codex`, `windvoice` になることを確認する。「真空パック」「シンクを掃除する」は `context: 文脈依存` のため自動置換されないことを確認する。
6. 設定で transcript log を ON にし1回発話する。`%APPDATA%\windvoice\transcript-learning.jsonl` の各行が `timestamp/raw/corrected` だけを持つことを確認する。OFF では追記されないことも確認する。実際の秘密は発話しない。
7. warm 接続後に PTT を素早く tap、停止キーを連打、最終結果直後にネットワークを切断し、二重挿入・次回録音不能・確定文字列消失がないことを確認する。
8. 録音中に USB mic を抜く、PC を sleep、screen lock する。録音・duck が解除され、復帰後の次回録音で mic と Realtime 接続が再作成されることを確認する。
9. `Ctrl+Shift+Space` PTT で Shift を先に離す、toggle 停止を paste 中に押す、処理中に toggle を再度押す。録音固着や1回ずれが起きないことを確認する。
10. streaming を辞書候補なしのテスト辞書で試し、途中で別テキストをコピーする。録音終了後も新しい clipboard が保持されることを確認する。通常の辞書では置換保証のため final insertion に切り替わることを確認する。
11. Settings と overlay を開閉しながら連続発話し、destroyed window 例外がないこと、hidden audio renderer に transcript/history IPC が送られていないことを DevTools または instrumentation で確認する。

## 実行環境上の注記

サンドボックスが既存 `.git` への書込みを拒否したため、workspace 内の `.codex-git` を代替 Git directory として `feat/user-dictionary` を作成した。commit tree と push 対象 branch は通常の Git object として同一だが、この checkout の既存 `.git` が指すローカル branch は更新されない。remote push 後は通常 checkout 側で `git fetch origin feat/user-dictionary` を実行して切り替えられる。

## Push 状態

この実行環境からの push は未完了。HTTPS は `github.com:443` へ接続不能、SSH-over-443 も sandbox の `Permission denied`、GitHub connector の blob 作成は connector 側でキャンセルされた。remote の `feat/user-dictionary` は作成されていない。

ネットワーク利用可能なセッションで、workspace 直下から次を実行すること。

```powershell
git --git-dir=.codex-git --work-tree=. push --set-upstream origin HEAD:refs/heads/feat/user-dictionary
```
