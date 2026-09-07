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
  - `shared/comment.js` - **コメントの型・正規化・IDの唯一の置き場**（3環境から読む）
  - `shared/store.js` - **コメント履歴の唯一の保存先**（IndexedDB。Service Worker と popup から読む）
  - `background/` - Background Scripts
  - `content/` - Content Scripts
  - `popup/` - ポップアップ画面のHTML/CSS/JS
  - `options/` - 設定画面のHTML/CSS/JS
- `test/` - テスト（Node標準の`node:test`。拡張機能本体には同梱されない）
  - `helpers/service-worker-harness.js` - chrome APIモックとService Workerローダー
  - `helpers/dom-chat-harness.js` - 偽DOM（セレクタは厳格）とService Workerへの送信の記録
  - `helpers/popup-harness.js` - 偽 document（id の正は `popup.html`）と chrome APIモック
  - `helpers/indexeddb-mock.js` - IndexedDB の最小の偽実装（依存パッケージは足していない）
  - `helpers/store-harness.js` - `shared/store.js` を単体で評価する

3つのハーネスはいずれも、対象スクリプトより先に `src/shared/comment.js` を
同じコンテキストで評価する（本番の読み込み順を再現するため）。
popup ハーネスはそのあと `src/shared/store.js` も評価する（`popup.html` と同じ順番）。

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
  `setTimeout` は dom-chat ハーネスと同じく**積むだけ**で、テストから進める
  （実時間で回すと初期化の再試行だけで1本十数秒かかる）。
  `PopupController` と唯一のインスタンスは `context.__popup` から触れる。
  出来上がった DOM は `readCommentRows()` / `visibleUsernames()` でほどく
  （`test/popup-filters.test.js` がフィルターの2軸を、
  `test/popup-render.test.js` が描き方そのものを確かめる）。
  `loadPopup({ maxCommentsToPopup })` でメモリ上限を小さくできる
- `test/helpers/indexeddb-mock.js` — `shared/store.js` が使う9つのAPIだけを実装した
  偽 IndexedDB。**コールバックは必ず非同期に発火させる**（同期で撃つと、
  カーソルの `continue()` の後に張り直されるハンドラが宙に浮いて1歩も進まない）。
  トランザクションの完了はマクロタスクで判定する（本物の
  「制御がイベントループに戻ったら commit」に揃える）
- `test/helpers/store-harness.js` — `shared/comment.js` → `shared/store.js` の順に
  評価して、偽 IndexedDB と偽 `storage.local` を差す。移行のテストはここから

対象は「数時間使い込まないと発現せず手動再現が困難」なバグに絞っている。
これまでに4度、その種のバグが本番で発覚しているため（Service Worker終了時の
コメント取りこぼし、ストレージ肥大化による監視停止、**新着ステッカーだけ画像が
落ちる取得タイミング**、**チャットからコピーした語に混ざる不可視文字で検索が
全滅する**）、その周辺を重点的に固定している。

モックの限界として、以下は検証できない:

- 実ブラウザの挙動（本物のquotaの出方、Service Workerが終了するタイミング、
  メッセージパッシングの実挙動、**IndexedDB の実際の書き込み量**）
- YouTube側のDOM変更。dom-chat のモックはセレクタ文字列の完全一致でしか引けず、
  検証できるのは「どのタイミングで何を読むか」という段取りだけ。
  **セレクタが今のYouTubeで正しいかどうかは、実ブラウザでしか確認できない**
- ポップアップ／オプション画面のUI

`monitoringState` は `startDomMonitoring` などで丸ごと再代入されるため、
ハーネスは getter 経由で露出している。テストから直接参照を保持しないこと。

**`src/shared/` のファイルを二重注入ガードで包まないこと。** `dom-chat.js` より先に
読まれる別ファイルなので、ガードの中に入れると Service Worker と popup から見えなくなる。
代入先は `self`（`window` ではない。Service Worker に `window` は無い）。
中身は即時実行関数で包む — content script では `dom-chat.js` と、`importScripts` では
`service-worker.js` と同じスコープを共有するので、トップレベルに `const` を置くと名前がぶつかる。

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
どの枠に属するかの判定は `src/shared/comment.js` の `filterKeyOf()` が唯一の正で、
`isCommentEnabled()` もそれを呼ぶ（絞り込みと件数の集計で軸がずれないため）。

**取り込みは全件・フィルターは表示側だけ**（再設計の決定1、フェーズ4で実現）。
Service Worker が取り込み口で見るのは `isDisplayableKind()`
——「そもそも表示する形を持つ種別か」——だけで、役割・種別のトグルは見ない。
既読マーク（`processedMessageIds`）を付けるのも**保存すると決めたあと**にしてある。
そのため、あとからトグルをONにすれば過去分もそのまま表示される。

> 以前は取り込み時にフィルターをかけ、外れたコメントは保存されないのに
> 既読扱いになっていた（`docs/audit-2026-09.md` #4）。全件スキャンで送り直しても
> 二度と拾えず、件数バッジの「一般: 0」も「取り込んでいない」の意味で嘘をついていた。

件数バッジは、絞り込みと同じ母集団を同じ軸（`filterKeyOf()`）で数える。
表示中の枠の内訳を足すと、必ず合計値に一致する（切った枠も本当の件数を出し続ける）。
ただし**「メンバー」「一般」は `bulk` 枠**で、既定ではメモリに載っていない（決定4）。
まだ読んでいないあいだ、この2つだけは数字ではなく `?` を出す
（`0` と書くと「そもそも無い」という嘘になる。バッジ自身がトグルなので、
押せば読み込まれて数字になる）。残り4つの枠は必ず `primary` に入るので、
`primary` だけを載せた状態でも常に正確に数えられる。

落とすのは表示する形を持たないものだけ。APIモードのチャット終了・削除済みイベントと、
ギフトの受領告知（量が多いので意図的に対象外。後述）がこれに当たる。

保存済みの設定に新しいキーが無い場合（旧バージョンからの更新直後）は
`normalizeCommentFilters()` が既定値で補うため、更新した瞬間にスパチャが消えることはない。

### 一覧の描画

行は**1コメントにつき1回だけ**作る（決定4、フェーズ5で実現）。新着は新しい行だけを
`DocumentFragment` にまとめて1回 `appendChild` し、フィルターや検索の切り替えでは
**既存行の `hidden` を切り替えるだけ**にする。以前は新着1件ごとに `innerHTML` を
全置換していた（`docs/audit-2026-09.md` #22 = 根本原因D）。

- 行の組み立ては `document.createElement` + `textContent` + `setAttribute`。
  文字列HTMLを組まないので、属性のエスケープ漏れ（#25）が種類ごと成立しない
- リスナーは `commentsList` に `click` 1つと（捕捉フェーズの）`error` 1つだけ。
  行ごとには張らない
- レイアウトの読み取りは1描画につき1回。下端の判定は、代入した値から計算で出す
- 画像URLは https に加えて**配信ホストも確認する**（`AVATAR_IMAGE_HOSTS` /
  `STICKER_IMAGE_HOSTS`）。`https://` の前方一致だけだと任意のHTTPS先へ
  `img` のリクエストが飛ぶ（#26）

**CSS のクラス名と DOM 構造は描画方式を変えても維持すること**
（`popup.css:1009-1012` が `:has()` で構造に依存している）。
`hidden` で隠した行は `:last-child` のままなので、区切り線を消す
「最後に見えている行」には JS が `comment-item--last` を付ける。

### コメント履歴の保存（IndexedDB）

保存は `src/shared/store.js` に集約している（再設計の決定2）。
以前は `storage.local` に「動画1本ぶんの配列」を置き、500ms ごとに全件を
書き直していた（賑わった配信で毎秒約0.8MiB）。いまは追記が1レコードの `put` で済む。

```
DB: ytChatFilter
  comments  keyPath 'pk' = `${videoId}:${seq}`  index: [videoId, bucket, seq] / [videoId, seq]
  avatars   keyPath ['videoId', 'displayName']
  meta      keyPath 'videoId'  { lastSeq, counts: {primary, bulk}, updatedAt }
```

**保持枠は2つある**（決定3）。枠が別なので、一般コメントがいくら流れても
特別コメントは押し出されない。

| 枠 | 対象 | 上限（動画あたり） |
| --- | --- | --- |
| `primary` | 配信者・モデレーター・スパチャ・メンバーシップ・ギフト | 20,000 |
| `bulk` | メンバー・一般 | 50,000 |

枠の判定は `shared/comment.js` の `bucketOf()` が正で、store 側には書かない。
保持する動画は5本（`MAX_HISTORY_VIDEOS`）。

更新前に `storage.local` へ保存された履歴は、Service Worker の起動時に
**片道で** IndexedDB へ移る。旧データを消すのは書き込みを読み直して確かめた後で、
移行を走らせるのは Service Worker だけ（popup と同時に走らせると二重に積まれる）。

### キーワード検索

ポップアップの検索は、画面に見えている範囲ではなく `this.comments`（取得済みの
全件）を対象にする。popup がメモリに載せる上限（`MAX_COMMENTS_TO_POPUP`）は
`shared/store.js` にあり、Service Worker が1回に渡す件数と同じ値を見る
（以前は popup 10,000 / SW 2,000 と食い違っていた）。

**メモリに載せるのは起動時は `primary` 枠だけ**（決定4、フェーズ5で実現）。
`bulk` 枠（メンバー・一般）は、そのトグルをONにしたか、**検索を始めたか**、
ユーザー絞り込みを掛けたときに、popup が `shared/store.js` 経由で
IndexedDB から直接読む（Service Worker のメッセージで数万件を往復させないため）。
**検索は取得済み全件に効く**——その約束を守るために、検索は読み込みの引き金の1つにしてある。
Service Worker が渡すのは `readCommentsForPopup(videoId, 'primary')` の結果で、
`MAX_COMMENTS_TO_POPUP` はメモリの上限として popup 側でも効き続ける。

> popup は `store.migrateFromLocal()` を**呼ばない**。移行は片道で、
> Service Worker と同時に走らせると履歴が二重に積まれる。

比較の前に `normalizeForSearch()` で NFKC 正規化・小文字化・
**ゼロ幅文字などの不可視文字の除去**・空白の連なりの圧縮・前後の空白除去を通す。
正規化済みの文字列（`searchText`）は**取り込み時に1件ずつ**作って持たせる。
検索を始めてから遅延生成すると、最初の1文字で全件ぶんの正規化が同期的に走り、
数千件で目に見えて固まる。更新前に保存された履歴には `searchText` が無いので、
`searchTextOf()` がそのぶんだけ遅延生成で補う。

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
| 2 | 型の一本化（`src/shared/comment.js`） | **完了**（2026-09-07） |
| 3 | IndexedDB 移行 | **完了**（2026-09-07） |
| 4 | 全件取り込み | **完了**（2026-09-07） |
| 5 | popup の読み方と描画 | **完了**（2026-09-07） |
| 6 | ライフサイクル（単一状態・alarms・ポート） | 未着手 |
| 7 | dom-chat 耐性 | 未着手 |
| 8 | UI の穴（キーボード・テーマ） | 未着手 |
| 9 | 掃除（権限・docs） | 未着手 |

各フェーズの「やること／完了条件／テスト／注意」は
[`docs/redesign-plan.md`](docs/redesign-plan.md) にある。
**フェーズを終えたらこの表の状態を更新すること。**