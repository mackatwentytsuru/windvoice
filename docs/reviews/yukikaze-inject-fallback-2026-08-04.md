# 雪風 Wayland 注入フォールバック修正報告（2026-08-04）

## 結論

GNOME Wayland の portal RemoteDesktop 経路を、明示的なキー down/up と設定可能なイベント間隔、receipt 検証付きの段階フォールバックへ変更した。Windows の `pasteWin32` / `sendCtrlVAtomic` 経路は変更していない。

ローカルでは Python 構文検査、TypeScript typecheck、全 402 テスト、production build が成功した。ただし雪風実機の Claude Code デスクトップへの貼り付けはこの作業環境では測っていないため、「実機で直った」とは判定しない。

## 設計判断

### 1. 明示キーシーケンスと設定可能な間隔

`portal_input.py` は keycode / keysym の両方で次の順序を使用する。

1. Ctrl down、必要なら Shift down
2. 各イベント間で設定値だけ待機
3. V down → V up
4. 各イベント間で待機し、Shift up → Ctrl up
5. 途中失敗時も全キーの up をベストエフォートで続行する

既存の `pasteCompatibility` を注入間隔の設定にも使用した。初回 / 低速 retry は `fast=12/40ms`、`balanced=20/60ms`、`safe=30/90ms`。sidecar は受信値を 0〜250ms に制限する。

### 2. receipt を維持したフォールバック連鎖

selection claim と generation は1回だけ作り、次の順序で注入する。

| 試行 | shortcut | API | 間隔 |
|---|---|---|---|
| 1 | Ctrl+Shift+V | `NotifyKeyboardKeycode` | profile 初回値 |
| 2 | Ctrl+Shift+V | `NotifyKeyboardKeycode` | profile 低速値 |
| 3 | Ctrl+V | `NotifyKeyboardKeysym` | profile 低速値 |

各試行の直前に `transfer_checkpoint()` を取得し、その試行後の `SelectionTransfer` 完了だけを receipt とする。receipt が成立した時点で同一ループから即 return し、後続 chord を発行しない。dispatch が部分成功または不明の例外になった場合も再試行せず、既存どおり session を破棄する。

全3試行で receipt が成立しなければ transcript の selection を復元せず残し、Node 側の既存手動貼り付けトーストへ進む。元 clipboard の restore は receipt 成立後だけ実行するため、既存 barrier / receipt セマンティクスを維持している。

### 3. keysym 代替経路

XKB keysym の `Control_L=0xffe3`、`Shift_L=0xffe1`、`v=0x76` を定義し、plain fallback では `NotifyKeyboardKeysym` を使用する。日本語配列で evdev keycode と解釈が噛み合わない場合にも、物理位置ではなく keysym を compositor へ渡せる。

XDG portal の公開仕様で `NotifyKeyboardKeycode` と `NotifyKeyboardKeysym` の引数および state 0/1 を照合した: [RemoteDesktop portal API](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)。

### 4. focused app のベストエフォート記録

paste 開始時に `org.gnome.Shell.Introspect.GetWindows` を最大800msで呼び、`has-focus=true` の `app-id` を `targetApp` として paste result に付ける。AccessDenied、service 不在、未知の応答形はすべて非致命の `unknown` とする。ログは `targetApp`、試行回数、最終 shortcut / API、`injected`、`selectionRead` を記録する。

GNOME Shell の公開ソース上の返却型 `a{ta{sv}}` と `app-id` / `has-focus` を照合した: [GNOME Shell GetWindows 導入差分](https://lists.gnome.org/archives/commits-list/2019-February/msg08231.html)。GNOME拡張で権限を迂回する実装は追加せず、コード上の TODO のみに留めた。

## 変更ファイル

- `resources/native/portal_input.py`: 明示シーケンス、keycode/keysym、receipt 付き試行ループ
- `resources/native/portal_focus.py`: GNOME GetWindows 応答の安全な解析
- `resources/native/portal-remote.py`: attempt plan 実行、keysym D-Bus、target app、結果メタデータ
- `src/main/linux/portalSidecar.ts`: 3段 attempt plan、timeout budget、結果ログ/型
- `src/main/inject/pasteTiming.ts`: profile 別 key event 間隔
- `src/main/inject/typer.ts`, `streamingTyper.ts`: timing の伝播と結果ログ
- `src/shared/types.ts`, `i18n.ts`: 既存設定の意味と表示説明を更新
- `tests/portalInputPython.test.ts`: event 順序、遅延、keysym、成功時停止
- `tests/portalPasteFallbackPython.test.ts`: mock portal で claim 1回、各 receipt、fallback 順序
- `tests/portalFocusPython.test.ts`: focused app、AccessDenied、D-Bus 契約
- `tests/portalSidecar.test.ts`, `pasteTimingWayland.test.ts`: Node protocol と profile 値

依存追加はない。`package.json` / `package-lock.json` は変更していない。

## TDD・検証ログ要約

### RED

実装前に次を実行し、18件中9件が意図した未実装理由で失敗した。

```text
npm test -- --run tests/portalInputPython.test.ts tests/portalFocusPython.test.ts tests/portalSidecar.test.ts tests/pasteTimingWayland.test.ts

9 failed / 9 passed
- inject_paste_chord: method 引数未実装
- run_verified_paste_attempts: 未実装
- portal_focus: 未実装
- attempt plan / timing fields: 未実装
```

### GREEN

```text
python3 -m py_compile resources/native/portal_clipboard.py resources/native/portal_input.py resources/native/portal_focus.py resources/native/portal-remote.py
# exit 0

npm run typecheck
# typecheck:node success / typecheck:web success

npm test
# Test Files 53 passed (53)
# Tests 402 passed (402)

npm run build
# build:fnwatcher success (x86_64 arm64)
# main 53 modules / preload 2 modules / renderer 43 modules built
# exit 0
```

全テスト中に既存 `typer.test.ts` の負系 fixture が `[error] paste keyTap failed: uiohook-napi: keyTap not available` を stderr に出したが、当該テストを含め全402件は成功している。build には `secure.ts` の static/dynamic import 併用 warning が1件あったが、生成は完了した。

## 未確認・実機引き継ぎ

- 雪風 Ubuntu 24.04 GNOME Wayland の Claude Code デスクトップへの実貼り付けは未確認。
- focused app は雪風の既知状態では AccessDenied が想定されるため、まず `targetApp=unknown` が paste を阻害しないことをログで確認する。
- 実機合格には、同一入力先で4〜5回連続の音声入力、各回 `selectionRead=true`、本文の目視完全一致、重複貼り付けなしを確認する。
- 初回失敗を再現できる場合は、ログの `attempts`、最終 `shortcut` / `method`、`targetApp` を併記し、どの段で receipt が成立したかを判断する。
