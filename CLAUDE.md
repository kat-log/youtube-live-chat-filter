# YouTube ライブチャット特別コメントフィルター

このプロジェクトは、YouTubeライブチャットでモデレーター、メンバー（スポンサー）、配信者からのコメントのみを表示するChrome拡張機能です。

## 再設計が進行中（2026-09〜）

**コードに手を入れる前に [`docs/redesign-plan.md`](docs/redesign-plan.md) を読むこと。**

非マージコミット58件のうち14件（24%）が `fix:` で、同じ場所からバグが生え続けていた。
2026-09-07 に `src/` 全体を調査し、46件の欠陥と6つの構造的原因を特定した。

- [`docs/audit-2026-09.md`](docs/audit-2026-09.md) — 何が壊れているか（行番号つき、裏取り済み）
- [`docs/redesign-plan.md`](docs/redesign-plan.md) — どう直すか（決定事項とフェーズ0〜9）

**この文書の以下の記述は v1.12.5 時点の「現状」であり、
再設計で変わる予定のものが含まれる。** 変わる予定のものには印をつけてある。

## プロジェクト構成

- `docs/` - 設計書などのドキュメント
  - `audit-2026-09.md` - **全体監査（2026-09）。46件の欠陥を行番号つきで列挙**
  - `redesign-plan.md` - **再設計計画。決定事項とフェーズ0〜9の実行手順**
- `.github/workflows/ci.yml` - push と PR で lint とテストを回す
- `eslint.config.js` - ESLint のフラット設定（ルールは最低限の2つ）
- `src/` - Chrome拡張機能のソースコード
  - `manifest.json` - Chrome拡張機能のマニフェストファイル
  - `background/` - Background Scripts
  - `content/` - Content Scripts
  - `popup/` - ポップアップ画面のHTML/CSS/JS
  - `options/` - 設定画面のHTML/CSS/JS
- `test/` - テスト（Node標準の`node:test`。拡張機能本体には同梱されない）
  - `helpers/service-worker-harness.js` - chrome APIモックとService Workerローダー
  - `helpers/dom-chat-harness.js` - 偽DOM（セレクタは厳格）とService Workerへの送信の記録
  - `helpers/popup-harness.js` - 偽 document（id の正は `popup.html`）と chrome APIモック

## 技術スタック

- HTML, CSS, JavaScript
- Chrome Extensions API
- YouTube Data API v3

## 開発コマンド

```bash
npm install   # 初回のみ（開発ツールは ESLint だけ）
npm run lint
npm test
```

`npm ci` → `npm run lint` → `npm test` は push と PR で CI が回す
（`.github/workflows/ci.yml`）。

ビルド不要。`src/` をそのまま「パッケージ化されていない拡張機能を読み込む」で使う。
リリース用zipは `/release` が生成する（`src/` 以下のみ同梱）。

**ビルド不要は今後も維持する。** これはこのプロジェクトの開発体験の核。

### 依存パッケージの方針（2026-09 に転換）

**実行時の依存はゼロ。開発ツールは必要なものを入れる。**

以前は「依存パッケージなし」を全面的な方針にしていたが、
リリースzipは `src/` 以下だけなので devDependency は同梱物に影響しない。
lint が無かったことで死にコードや欠落キーを見逃していた（`docs/audit-2026-09.md` #38, #10）ため、
機械的に防げるものは道具で防ぐ方針に改めた。
（ただし `no-unused-vars` が拾えるのは #10 型まで。#38 の死にコードは
トップレベルの関数宣言やクラスのメソッドなので、人手で消すしかない）

ESLint と CI はフェーズ1で導入済み。devDependency は `eslint` 1つだけで、
`globals` などの周辺パッケージは入れていない（`eslint.config.js` に手書きで足りる）。

ルールは `no-undef` と `no-unused-vars` の2つだけ。**整形ルールは入れていない。**
インデントはファイルごとに2スペースと4スペースが混在しており（`options.js` と
`popup.js` のクラス本体、`content-script.js` は4スペース）、いま揃えると
再設計の差分が読めなくなるため。

`eslint.config.js` の `sourceType` は `script` から変えないこと。理由は次節の最後にある。

### テストについて

ハーネスが vm コンテキストで対象スクリプトを丸ごと評価し、
内部の関数と状態をテストへ露出させる（テスト自体に実行時依存は無い）。

- `test/helpers/service-worker-harness.js` — chrome API をモックして
  `service-worker.js` を読み込む
- `test/helpers/dom-chat-harness.js` — 最小のDOMと、明示的に進める `setTimeout`
  をモックして `dom-chat.js` を読み込む。`querySelector` は
  **`dom-chat.js` が実際に使うセレクタしか受け付けず、知らないものは例外**にする
  （黙って null を返すと、セレクタ名の取り違えがテストを素通りするため）。
  `MutationObserver` は `observe` / `disconnect` を記録する
- `test/helpers/popup-harness.js` — chrome API と偽 document をモックして
  `popup.js` を読み込む。偽 document が引ける id の正は `popup.html` の実物で、
  そこに無い id を引かれたら例外にする。
  描画のテストはまだ無い（`PopupController` は DOMContentLoaded で生成でき、
  実際に組み立てられるところまでは届いているが、初期化が実時間の再試行を回すため、
  `setTimeout` を差し替え可能にするのがフェーズ5 の最初の仕事）

対象は「数時間使い込まないと発現せず手動再現が困難」なバグに絞っている。
これまでに4度、その種のバグが本番で発覚しているため（Service Worker終了時の
コメント取りこぼし、ストレージ肥大化による監視停止、**新着ステッカーだけ画像が
落ちる取得タイミング**、**チャットからコピーした語に混ざる不可視文字で検索が
全滅する**）、その周辺を重点的に固定している。

モックの限界として、以下は検証できない:

- 実ブラウザの挙動（本物のquotaの出方、Service Workerが終了するタイミング、
  メッセージパッシングの実挙動）
- YouTube側のDOM変更。dom-chat のモックはセレクタ文字列の完全一致でしか引けず、
  検証できるのは「どのタイミングで何を読むか」という段取りだけ。
  **セレクタが今のYouTubeで正しいかどうかは、実ブラウザでしか確認できない**
- ポップアップ／オプション画面のUI

`monitoringState` は `startDomMonitoring` などで丸ごと再代入されるため、
ハーネスは getter 経由で露出している。テストから直接参照を保持しないこと。

**両 content script に `'use strict'` を足したり ES モジュールに変換したりしないこと。**
どちらも二重注入ガードの `if (...) { } else { ... }` ブロックで包まれており、
ハーネスは Annex B の sloppy モード関数巻き上げ（ブロック内の関数宣言が
スクリプトスコープに漏れる挙動）で内部関数に到達している。触ると
テストが原因不明の `TypeError` で全滅する（`docs/audit-2026-09.md` 末尾に詳述）。
ESLint の `sourceType` を `module` にするのも同じ理由で不可。

## 設計概要

ライブチャットのメッセージを取得し、フィルターに合うものだけをポップアップ画面に
リアルタイム表示する。取得元は2モードある。

- **DOMモード（既定・APIキー不要）**: `dom-chat.js` がライブチャットのDOMを直接監視する
- **APIモード**: YouTube Data API v3 の `liveChatMessages` をポーリングする

### フィルターの2軸

役割（発言者が誰か）と種別（何のメッセージか）は別の軸として扱う。
スーパーチャットは一般視聴者からも飛んでくるため、役割だけで絞ると取りこぼす。

| 軸 | フィルターキー | 対象 |
| --- | --- | --- |
| 役割 | `owner` / `moderator` / `sponsor` / `normal` | 配信者 / モデレーター / メンバー / 一般（APIモードでは `isChatOwner` などのフラグ、DOMモードでは `author-type` 属性で判定） |
| 種別 | `superchat` | スーパーチャット・スーパーステッカー |
| 種別 | `membership` | メンバー新規加入・継続（マイルストーン）・メンバーギフト |

種別が付いているメッセージは種別のフィルターで絞り、役割のフィルターは見ない。
判定は `isCommentEnabled()` に集約している。

> **【変更予定】** 現状この判定は Service Worker の**取り込み時**に走り、
> 外れたコメントは保存されない（しかも既読扱いになる）。そのため後からトグルを
> ONにしても過去分は戻らない。再設計の決定1で
> **「取り込みは全件・フィルターは表示側だけ」**に変える。
> 詳細は `docs/audit-2026-09.md` #4 と `docs/redesign-plan.md` の決定1。

保存済みの設定に新しいキーが無い場合（旧バージョンからの更新直後）は
`normalizeCommentFilters()` が既定値で補うため、更新した瞬間にスパチャが消えることはない。

### キーワード検索

ポップアップの検索は、画面に見えている範囲ではなく `this.comments`（取得済みの
全件）を対象にする。

> **【変更予定】** 全件をメモリの配列に載せる前提は、決定1（全件取り込み）で
> 成立しなくなる。決定4で「低頻度枠はメモリ・高頻度枠は IndexedDB から引く」に変える。
> 検索が全件に効くという**約束は維持する**。詳細は `docs/redesign-plan.md` の決定4。
比較の前に `normalizeForSearch()` で NFKC 正規化・小文字化・
**ゼロ幅文字などの不可視文字の除去**・空白の連なりの圧縮・前後の空白除去を通す。
正規化済みの文字列はコメントごとに1度だけ作って持たせる（1文字打つたびに全件を
正規化し直すと数千件で遅くなる）。

不可視文字を落とすのは必須で、飾りではない。YouTubeのライブチャットからコメントを
コピーするとゼロ幅スペース（`U+200B`）や方向制御文字が一緒に付いてきて、貼り付けた
見た目は同じなのに `includes()` が外れ、**全件が0件になる**。同じ理由で、
バックスペースで消しきったつもりの検索欄に不可視文字が残り、空に見えるのに
「0件一致」で固まることもある。そのため「検索中かどうか」の判定（×ボタンや
一致件数バッジの表示）も入力そのままではなく正規化後の `searchQuery` で行う。

なお、チャットの行をトリプルクリックで丸ごとコピーすると時刻と発言者名まで
含まれるため、それは仕様上ヒットしない（検索対象は発言者名と本文のみ）。

0件のときの文言は `updateEmptyStateMessage()` が出し分ける。「まだコメントが
ありません」だけだと、検索が全件に効いているのか取得できていないのかが
利用者から見分けられないため、検索語と検索した件数を必ず添える。

なお、ギフトの受領告知（`giftMembershipReceivedEvent` /
`yt-live-chat-sponsorships-gift-redemption-announcement-renderer`）は
受け取った人数ぶん流れて量が多いため、意図的に対象外にしている。

## 次のステップ

再設計のフェーズを順に進める。**各フェーズは別セッションで、単独でリリースできる形で行う。**

| # | 名前 | 状態 |
| --- | --- | --- |
| 0 | 出血を止める（独立した5つの小修正） | **完了**（2026-09-07） |
| 1 | 足場（CI・ESLint・テストハーネス拡張） | **完了**（2026-09-07） |
| 2 | 型の一本化（`src/shared/comment.js`） | 未着手 |
| 3 | IndexedDB 移行 | 未着手 |
| 4 | 全件取り込み | 未着手 |
| 5 | popup の読み方と描画 | 未着手 |
| 6 | ライフサイクル（単一状態・alarms・ポート） | 未着手 |
| 7 | dom-chat 耐性 | 未着手 |
| 8 | UI の穴（キーボード・テーマ） | 未着手 |
| 9 | 掃除（権限・docs） | 未着手 |

各フェーズの「やること／完了条件／テスト／注意」は
[`docs/redesign-plan.md`](docs/redesign-plan.md) にある。
**フェーズを終えたらこの表の状態を更新すること。**