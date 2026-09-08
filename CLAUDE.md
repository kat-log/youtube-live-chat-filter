# YouTube ライブチャット特別コメントフィルター

このプロジェクトは、YouTubeライブチャットでモデレーター、メンバー（スポンサー）、配信者からのコメントのみを表示するChrome拡張機能です。

## 再設計は完了した（2026-09-07 〜 2026-09-08）

**この文書が現状の正である。** 以下の記述はフェーズ9 完了時点の実装と一致している。

なぜこの形なのかは、2つの文書に残してある。**設計の意図に反する変更をしそうなときは
先にこちらを読むこと**（とくに「決定事項」と「目指す設計」）。

- [`docs/redesign-plan.md`](docs/redesign-plan.md) — 決定事項・目指す設計・
  フェーズ0〜9の**実施記録**（各フェーズで詰まった箇所と、その理由）。
  末尾に**「この再設計のあとに残っている宿題」**がある
- [`docs/audit-2026-09.md`](docs/audit-2026-09.md) — 2026-09-07 時点の全体監査。
  **凍結された記録**で、行番号はいまのコードと対応しない。
  欠陥番号（#1〜#46 / #T1〜#T11）を引くための索引として読む

きっかけ: 非マージコミット58件のうち14件（24%）が `fix:` で、同じ場所から
バグが生え続けていた。`src/` 全体を調査して46件の欠陥と6つの構造的原因を特定し、
10回のセッションに分けて（フェーズ0〜9）片付けた。

## プロジェクト構成

- `docs/` - 設計書などのドキュメント
  - `audit-2026-09.md` - **全体監査（2026-09）。46件の欠陥を行番号つきで列挙**
  - `redesign-plan.md` - **再設計計画。決定事項とフェーズ0〜9の実行手順**
  - `store-listing.md` - **ストア掲載文の正**（短い説明は `manifest.json` の `description` と同一文字列）。
    更新の告知文と、ストア審査用の権限の説明もここ
  - `release-checklist.md` - **リリース手順と確認項目**（機械で見られるもの／偽 YouTube で見られるもの／
    実配信でしか踏めないものの3段）と、各リリースの実施記録
- `CHANGELOG.md` - **利用者から見える変更だけ**を書く。2.0.0 から
- `.github/workflows/ci.yml` - push と PR で lint とテストを回す
- `eslint.config.js` - ESLint のフラット設定（ルールは最低限の2つ）
- `src/` - Chrome拡張機能のソースコード
  - `manifest.json` - Chrome拡張機能のマニフェストファイル
  - `shared/comment.js` - **コメントの型・正規化・IDの唯一の置き場**（3環境から読む）
  - `shared/store.js` - **コメント履歴の唯一の保存先**（IndexedDB。Service Worker と popup から読む）
  - `shared/theme.js` - **テーマの唯一の当て場**（popup と options から読む。
    `document` と `localStorage` を使うので **Service Worker からは読めない**）
  - `background/` - Background Scripts
  - `content/` - Content Scripts
  - `popup/` - ポップアップ画面のHTML/CSS/JS
  - `options/` - 設定画面のHTML/CSS/JS
- `test/` - テスト（Node標準の`node:test`。拡張機能本体には同梱されない）
  - `helpers/service-worker-harness.js` - chrome APIモックとService Workerローダー
  - `helpers/content-script-harness.js` - 偽 window/document と chrome APIモック。
    **内部の関数は露出させない**（本体が class 宣言なので、二重注入ガードの
    ブロックから漏れない）。見るのは外から見える振る舞いだけ
  - `helpers/dom-chat-harness.js` - 偽DOM（セレクタは厳格）とService Workerへの送信の記録
  - `helpers/popup-harness.js` - 偽 document（id の正は `popup.html`）と chrome APIモック
  - `helpers/indexeddb-mock.js` - IndexedDB の最小の偽実装（依存パッケージは足していない）
  - `helpers/store-harness.js` - `shared/store.js` を単体で評価する
  - `helpers/options-harness.js` - 偽 document（id の正は `options.html`）と chrome APIモック。
    `storage.local.set` は本物と同じく `onChanged` を発火させる
  - `helpers/theme-harness.js` - `shared/theme.js` を単体で評価する（`localStorage` は差し替え可能）

service-worker / dom-chat / popup / options のハーネスはいずれも、対象スクリプトより先に
`src/shared/comment.js` を同じコンテキストで評価する（本番の読み込み順を再現するため）。
popup ハーネスはさらに `theme.js`（`popup.html` の `<head>`）→ `comment.js` → `store.js`、
options ハーネスは `theme.js` → `comment.js` の順に評価する（どちらも HTML と同じ順番）。

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
  `MutationObserver` は `observe` / `disconnect` を記録し、
  `emit()` で `#items` の監視へ、`emitHost()` で祖先の監視へミューテーションを流す。
  `#items` の差し替え（フェーズ7）は `replaceItemList(rows)` で作り、
  `document.contains()` の答えもそれに追随する。
  Service Worker からの要求は `deliver(request)`、
  ヘルスの報告は `healthState()` / `healthReports()` で見る
  （`sendCount()` と `messages()` は**コメントの送信だけ**を数える）
- `test/helpers/popup-harness.js` — chrome API と偽 document をモックして
  `popup.js` を読み込む。偽 document が引ける id の正は `popup.html` の実物で、
  そこに無い id を引かれたら例外にする。
  `setTimeout` は dom-chat ハーネスと同じく**積むだけ**で、テストから進める
  （検索のデバウンスやメッセージの自動消去を実時間で待たないため）。
  `chrome.runtime.connect` は偽ポートを返し、**既定では応答を返さない**
  （本物の Service Worker が居ない状態）。そのため初期化は最初の要求
  （`getCommentFilters`）で止まったままになり、テストは組み立てられた DOM だけを
  見られる。応答が要るときは `loadPopup({ onRequest })` で作る。
  SW からの通知は `chrome.__deliver(message)`、切断は `chrome.__disconnect()`、
  張られたポートの本数は `chrome.__portCount()`。
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
- `test/helpers/options-harness.js` — 設定画面（フェーズ8で新設）。popup ハーネスの
  偽 document を借り、**引ける id の正だけ `options.html` の実物**に差し替える。
  `storage.local.set` が `onChanged` を発火するので、
  「保存 → 通知 → 塗り直し」の往復がそのまま見える
- `test/helpers/theme-harness.js` — `shared/theme.js` を単体で評価する。
  `localStorage` は「無い」「例外を投げる」も作れる（写しが取れない環境で
  ページが死なないことを見るため）

対象は「数時間使い込まないと発現せず手動再現が困難」なバグに絞っている。
これまでに4度、その種のバグが本番で発覚しているため（Service Worker終了時の
コメント取りこぼし、ストレージ肥大化による監視停止、**新着ステッカーだけ画像が
落ちる取得タイミング**、**チャットからコピーした語に混ざる不可視文字で検索が
全滅する**）、その周辺を重点的に固定している。

モックの限界として、以下は検証できない:

- 実ブラウザの挙動（本物のquotaの出方、Service Workerが終了するタイミング、
  メッセージパッシングの実挙動、**IndexedDB の実際の書き込み量**）
- **CSS の効き方**。偽DOMはセレクタもレイアウトも解釈しないので、
  「Tab で本当に届くか」「テーマの色が読めるか」は実ブラウザでしか分からない
  （CSS 側は文字列として規則の有無を見ているだけ）
- YouTube側のDOM変更。dom-chat のモックはセレクタ文字列の完全一致でしか引けず、
  検証できるのは「どのタイミングで何を読むか」という段取りだけ。
  **セレクタが今のYouTubeで正しいかどうかは、実ブラウザでしか確認できない**
- ポップアップ／オプション画面の**見た目**（配線と組み立ては
  popup / options のハーネスで見ている）

ただし**実ブラウザでの確認は、かなりのところまで機械にやらせられる**。
偽の `www.youtube.com`（自己署名TLS + Chromium の `--host-resolver-rules`）を立てて
拡張機能を読み込ませると、manifest の `matches` も `host_permissions` も本物と同じに
効くので、注入先のフレーム・自動開始・取り込み・SPA遷移・popup の描画まで通しで
確かめられる。手順は `docs/redesign-plan.md` の「実ブラウザでの検証」にある
（道具立てはリポジトリに入れていない。必要なときに書き捨てる）。

Service Worker の状態は `session` 1つに畳んである（フェーズ6a）。
`beginSession()` のたびに丸ごと再代入されるため、ハーネスは getter 経由で
露出している（`sw.session`。旧名の `sw.monitoringState` は同じものを指す別名）。
テストから直接参照を保持しないこと。
番人の alarm は `chrome.__fireAlarm()` で発火させ、作成・削除は `calls.alarms` に残る。

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

### watch ページ側（`content/content-script.js`）

このスクリプトが持つのは「この画面はどの配信か」と「その配信のチャットIDは何か」
だけで、**コメントは1件も持たない**（APIモードの残骸だった控えはフェーズ9で撤去した。
popup は SW から直接もらう）。やることは3つ。

- 配信の特定（`extractVideoId` / `extractLiveChatId`）
- 自動開始の要求（`tryDomModeAutoStart` / `tryAutoStart`）
- SW からの要求への応答（`ping` / `startMonitoring` / `stopMonitoring` /
  `getLiveChatId` / `pageNavigated`）

**SPA遷移の検知は Service Worker が持つ**（`chrome.tabs.onUpdated`。#24）。
以前はここが `document.body` 全体を `MutationObserver` で購読して
`location.href` の変化を見ており、拡張機能がやっていることの中で最も高価な処理だった。
いまは SW が `pageNavigated` を送ってきて、それを受けて自分の控えを捨て、
新しい動画で組み立て直す。**セッションを畳むのは SW の側**（`session` の正はあちら。
ここで `stopBackgroundMonitoring` を呼ぶと突き合わせの正が2つに戻る）。

### DOMモードの読み取り（`content/dom-chat.js`）

**YouTube の DOM に依存する文字列は `SELECTORS` レジストリに集約している**
（フェーズ7）。セレクタ14個・行のタグ名5個（`KIND_BY_TAG`）・属性名で計19個が
1か所にあるので、YouTube 側の変更で直す場所は1つ。
**ここ以外に生の文字列を書かないこと。** ハーネスは「知らないセレクタを
引かれたら例外」なので、足したら `test/helpers/dom-chat-harness.js` の
許可リストにも足す。

**`MutationObserver` は張り直せる。** `#items` を抱えている祖先を
`subtree` 付きで監視し、`#items` が差し替わったら（`document.contains()` で
判定）古い監視を切って張り直し、外れていた間に流れた行を全件スキャンで拾う。
YouTube の「上位のチャット ↔ チャット」切り替えで実際に起きる（#2）。

**番人（`chrome.alarms`）からの再注入では、この不具合は直らない。**
`executeScript` は二重注入ガード（`window.__domChatInitialized`）に弾かれて
1行も走らないので、外れた observer はそのまま残る。番人が効かせているのは
一緒に送る `requestInitialSweep` の側だけで、そこでも張り直しを確かめている
（祖先ごと差し替えられた場合の3分後に効く保険）。

**ヘルス状態を持ち、popup まで出す。** DOMモードの壊れ方は症状がつねに
「コメントが来ない」だけで、静かな配信と見分けが付かない（根本原因F）。

| 状態 | 意味 | popup の表示 |
| --- | --- | --- |
| `searching` | `#items` を探している最中 | 橙・「チャットを探しています」 |
| `no-chat` | 30秒探して見つからなかった | 赤・「チャットが見つかりません」 |
| `watching` | 監視中。まだ1件も流れていない | 緑の点だけ |
| `reading` | 監視中。取り込めている | 緑の点だけ |
| `unreadable` | 行はあるのに読み取れない（セレクタ破損の疑い） | 赤・「チャットを読み取れません」 |

- **正は dom-chat.js が持つ。** Service Worker のメモリに置くと約30秒で消え、
  popup を開いた時点ではたいてい失われている。SW は受けた報告を控えるだけで、
  popup に聞かれたら（`getDomChatHealth`）**タブに聞き直す**
- 送るのは**状態が変わったときだけ**（片道の通知）。1件ごとに送ると通信が流量になる
- `unreadable` の判定は**5件連続で読み取れなかったとき**。単発の失敗は普通に起きる。
  行のタグ名ごと変わった場合は「失敗」としてすら数えられないので、
  **全件スキャンでだけ**「既知のタグが1つも無く、行が5つ以上ある」を見る
- popup の表示は DOMモードで監視中のときだけ。読めているうちは点だけを出す
  （トップバーの幅を平常時に取らないため。文言は `title` から読める）
- **聞き直す先はフレームで指定する**（フェーズ9）。`tabs.sendMessage` はタブの
  全フレームに配られ、応答は最初に返した1つが勝つ。dom-chat.js から届いた
  `sender.frameId` を控えておき、そこへ聞く。控えが無いとき（SW の終了後）は
  宛先なしで聞き、`health` を持たない応答は捨てる

### 権限（`manifest.json`）

実際に使う分だけ（#40。フェーズ9で `activeTab` と `tabs` を落とした）。
内容は `test/manifest.test.js` が固定しているので、増やすとテストが落ちる。

| 権限 | 用途 |
| --- | --- |
| `storage` / `unlimitedStorage` | 設定とセッション（`storage.local`）、履歴（IndexedDB） |
| `scripting` | dom-chat.js の注入 |
| `alarms` | 番人（1分周期） |
| `https://*.youtube.com/*` | チャットの読み取り、タブのURLの判定 |
| `https://www.googleapis.com/youtube/v3/*` | APIモードのときだけ |

- **`tabs` 権限は要らない。** タブの `url` は host permission があれば読める。
  ただし**youtube.com 以外のタブでは `url` が `undefined` になる**ので、
  無防備に `tab.url.includes(...)` と書かないこと
- **`host_permissions` のパスは通信の可否には効かない**（実測）。
  `/youtube/v3/*` に絞るのは審査と権限表示のための宣言であって、封じ込めではない
- content_scripts の `matches` は2エントリで揃えてある（`https://*.youtube.com/`）。
  エントリ1は `/watch*` と `/live/*`。**`/live*` と書くと `/live_chat*` を飲み込み、
  ポップアウトのチャット窓で content-script.js と dom-chat.js が同居する**（#41）

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

### いま何を監視しているか（セッション状態）

Service Worker の状態は `session` ただ1つが正（再設計の決定6、フェーズ6aで実現）。
以前は SW のメモリ・`storage.local`・popup・content script の4か所に別々の正があり、
ズレるたびに突き合わせの分岐が1本ずつ増えていた（`docs/audit-2026-09.md` 根本原因A）。

- 永続化の口は `saveSession()` / `loadSession()` の2つだけ。書くのは
  `PERSISTED_SESSION_KEYS`（`epoch` / `isMonitoring` / `chatMode` / `videoId` /
  `tabId` / `liveChatId` / `pageToken` / `startedAt`）の**全部**で、
  書き込み箇所ごとに形が変わることはない
- 突き合わせは `reconcile(tabId, videoId)` 1つだけ。返すのは
  `idle` / `same` / `changed` / `other` の4語。**`||` のチェーンは書かないこと**
  （「明示的な false / null」を表現できず、片方に残った古い `true` が必ず勝つ）
- `epoch` は世代番号。`beginSession()` のたびに +1 され、非同期処理の続きは
  **自分の世代がまだ現役かを確かめてから**状態に触る
- 既読マーク（`Set`）・アバター・ポーリングのタイマーは永続化しない。
  復帰時に作り直せる（前2つは IndexedDB から、タイマーは番人が張り直す）
- 表示フィルターは `session` に持たない。正は `storage.local` で、読むのは popup

DOMモードのバッチは `enqueueDomChatMessages()` が1本の `Promise` の鎖に並べる。
要求の受け口は応答を即返して処理を切り離すので、並べないと
バッチ同士が互いの状態更新を踏む。**この鎖は content script → SW の区間を
守っている**（SW → popup の順序を守るのはポート。区間が別なので、
ポート化しても鎖は外さない）。

**タブが閉じられたら監視を止める**（`chrome.tabs.onRemoved` のリスナーは1本だけ）。
以前は2本あり、片方は「自動停止」、もう片方は「継続」と正反対のことをしていた。

### popup と Service Worker の通信（ポート）

popup ↔ SW は `chrome.runtime.connect` のポート1本で話す（フェーズ6b）。
`sendMessage` は「届いたかどうか分からない」ので、popup 側に
ping 8回の起床待ち（`waitForServiceWorker`）とタイムアウト付きの retry が
足されていた。ポートにするとそれが要らなくなる。

- SW は開いているポートを `popupPorts`（`Set`）で持つ。**`session` には持たせない**
  （永続化できないうえ、popup が開いているかはセッションの持ち物ではない。
  `PERSISTED_SESSION_KEYS` を増やさないこと）
- popup へ片道で流すのは `notifyPopup()` だけ。新着・`showDetailedError`・
  `monitoringAutoStopped`・`domChatHealth` の4つが通る。開いていなければ何も起きない
- **content script との通信は `tabs.sendMessage` / `onMessage` のまま。**
  content script は `connect` の相手ではない。要求の処理は
  `handleRequest(request, sender)` 1つに畳んであり、ポートと `onMessage` は
  その応答を配るだけ（同じ `action` の処理を2か所に書かないため）
- **新着を content script 経由で popup へ送り返さない**（フェーズ7で削除）。
  popup は同じバッチを SW から直接もらっているので、リレーすると
  ポートで保証した「送った順に1回ずつ」を崩す echo になるだけだった
- **`content-script.js` の `onMessage` は、同期で応答した分岐で `return true` を
  返さないこと**（#30。フェーズ9で直した）。`true` は「あとで応答する」の宣言なので、
  同期で済ませたあとに返すと応答チャネルが開いたまま残り、送信側の `await` が
  永久に解けない。**知らない `action` には応答する。**
  ただし**同じタブの dom-chat.js 宛ての `action`（`DOM_CHAT_ACTIONS`）には
  応答しないこと** —— `tabs.sendMessage` は全フレームに配られ、最初の応答が勝つので、
  横から即答すると本来の宛先の応答を追い越す（ヘルスの表示が消える）。
  応答しないだけならチャネルは開いたままにならないので害は無い
- ポートに「応答」という仕組みは無いので、**要求ごとに `requestId` を振って**
  `{ requestId, payload }` で送り、応答に同じ ID を載せて返す。
  片道の通知は `requestId` を持たない。**知らない `action` にも必ず応答を返すこと**
  （返さないと popup の待ちが永久に解けない）
- popup 側の口は `requestBackground(message)` 1つ。処理の失敗は
  `{ success: false, error }` として返り、投げるのは繋がらなかったときだけ
- 切れたら（拡張機能の再読み込みなど）待っている要求を全部落として張り直し、
  **保存済みの履歴から差分を取り込み直す**（`resyncAfterReconnect`）。
  既読の id で落ちるので、増えるのは取りこぼしぶんだけ
- popup の受け口はコンストラクタで張るポート1本だけ。`connectToBackground()` は
  張り済みなら何もしないので、二重登録は起こり得ない（#32）

**「いま監視しているのは同じ配信か」を popup が自前で比べないこと。**
`reconcileSession` を SW に聞き、返ってきた4語で決める（正は `reconcile` 1つ）。

### 番人（`chrome.alarms`、1分周期）

MV3 の Service Worker は約30秒アイドルで終了し、`setTimeout` はSWごと消える。
APIモードの quota リトライ（60秒待ち）はこの上限を超えるので、以前は一度 quota を
踏むと popup を開き直すまでポーリングが再開しなかった。

| モード | 番人がやること |
| --- | --- |
| API | 「動いているべきなのにタイマーが無い」なら再開する |
| DOM | 3分コメントが来ていないなら dom-chat.js を注入し直して再スキャンさせる |

**番人の「再注入」で直せるのは、注入時に走るものだけ。** content script は
二重注入ガードで包まれているので、`executeScript` をもう一度撃っても中身は
1行も走らない。効くのは一緒に送る `requestInitialSweep`（メッセージを受けて
動く処理）の側だけで、すでに走っているスクリプトの壊れた状態
（外れた `MutationObserver` など）は content script 自身が直す。

**番人が見る値は、Service Worker の終了に耐える場所に置くこと。**
DOMモードの「最後にコメントが来た時刻」を IndexedDB の `meta.updatedAt` から
引いているのはそのため（メモリに持つと、起こされるたびにリセットされて
沈黙を一生検知できない）。alarm の最小周期は**1分**で、それより短くはできない。

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

**保持枠と表示フィルターのキーは1対1で対応している**（どちらも流量で切っているため）。
`primary` は `owner` / `moderator` / `superchat` / `membership`、
`bulk` は `sponsor`（メンバー） / `normal`。
そのため `primary` だけをメモリに載せていても、
**4つのバッジの件数は常に正確に出せる**（決定4はこの性質の上に成り立っている）。

**アバターにも同じ保持枠がある**（フェーズ6a）。`avatars` ストアのレコードは
`{ videoId, displayName, url, bucket }` で、上限は `AVATAR_LIMITS`
（`primary` 200 / `bulk` 500）。枠ごとに間引くので、一般視聴者のアバターが
いくら流れても配信者・モデレーター・スパチャの発言者のアバターは落ちない
（1バッチの中で上限を超えても、Service Worker の復帰直後も）。
枠は**上げるだけで下げない** — 一度スパチャを投げた人を通常コメントで `bulk` に
落とすと、過去のスパチャの行のアバターが一般の流量で消えるため。
popup へ渡す形は `発言者名 -> URL` のまま（枠は保持のための持ち物で、表示には要らない）。

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

### テーマとキーボード操作

**テーマの正は `chrome.storage.local` の `theme` ただ1つ。当てるのは
`src/shared/theme.js` だけ**（popup と options の両方が読む）。
以前は popup だけが仕組みを持っていて、**ダークモードのトグルを載せている
設定画面自身が永久にライトテーマ**だった（`docs/audit-2026-09.md` #14）。

- `theme.js` は **両ページの `<head>`** から読み込む。`localStorage` の写しで
  同期に塗ってから、`storage.local` の応答で塗り直す。
  body の末尾で読むと、ライトテーマの利用者が起動直後に真っ黒な画面を見る（#15）
- 塗る口は `applyTheme()` 1つ。写しの更新もその中でやる
- `popup.css` は `:root` がダークで `[data-theme="light"]` が上書き側、
  `options.css` は**逆**（`:root` がライト、`[data-theme="dark"]` が上書き側）。
  options は元からライトしか無かったページなので、
  こうすると JS が動かなくても既存の見た目が保たれる

**キーボードで触れること**は、`display: none` をやめるだけでは成立しない。

- トグルの `input` は「レイアウトに影響しない絶対配置 + `opacity: 0`」で隠す。
  `display: none` / `visibility: hidden` はタブ順から外れる
- フォーカスの枠は、見えている代役（`.toggle-slider` / `.switch-label`）に
  `:focus-visible` で出す。マウス操作時の見た目は変わらない
- **畳んである入れ物は `inert` にする。** 設定ドロワーは `max-height: 0` で
  切り取られているだけなので、閉じたままでも中の要素にフォーカスが入る。
  Esc で閉じたらフォーカスは歯車ボタンへ返す
- **コメント一覧の行には `tabindex` を配らない**（行が数千あれば Tab も数千回）。
  役割での絞り込みは件数バッジ（`role="button" tabindex="0"`）から届く

## 次のステップ

**再設計のフェーズ0〜9 はすべて完了した（2026-09-08）。**
次にやることは [`docs/redesign-plan.md`](docs/redesign-plan.md) の
**「この再設計のあとに残っている宿題」**にまとめてある
（i18n、`optional_host_permissions`、実ブラウザでしか確認できないもの、
残ったテストの盲点、通信路がまだ2本あること、リリース作業）。

以下は完了記録。各フェーズは別セッションで、単独でリリースできる形で行った。

| # | 名前 | 状態 |
| --- | --- | --- |
| 0 | 出血を止める（独立した5つの小修正） | **完了**（2026-09-07） |
| 1 | 足場（CI・ESLint・テストハーネス拡張） | **完了**（2026-09-07） |
| 2 | 型の一本化（`src/shared/comment.js`） | **完了**（2026-09-07） |
| 3 | IndexedDB 移行 | **完了**（2026-09-07） |
| 4 | 全件取り込み | **完了**（2026-09-07） |
| 5 | popup の読み方と描画 | **完了**（2026-09-07） |
| 6a | ライフサイクル: 状態の一本化（単一状態・epoch・alarms・アバターの保持枠） | **完了**（2026-09-08） |
| 6b | ライフサイクル: ポート化（`chrome.runtime.connect`・retry の撤去） | **完了**（2026-09-08） |
| 7 | dom-chat 耐性 | **完了**（2026-09-08） |
| 8 | UI の穴（キーボード・テーマ） | **完了**（2026-09-08） |
| 9 | 掃除（権限・docs） | **完了**（2026-09-08） |

フェーズ6は当初1本だったが、**軸が2つ入っていた**ため 6a / 6b に分けた
（「SWが自分の状態をどう持つか」と「SWとpopupがどう話すか」）。
**順番は 6a → 6b で固定**（ポートのハンドラは単一の `session` を読み書きするため）。

各フェーズの「やること／完了条件／テスト／注意」と、
**実施記録（詰まった箇所と、その理由）**は
[`docs/redesign-plan.md`](docs/redesign-plan.md) にある。
実施記録は「なぜこの形なのか」を残すためのもので、
似た形の変更をするときは先に読むと同じ穴を踏まずに済む。
