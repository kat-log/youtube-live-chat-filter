# 設計とテストの仕組み

この拡張機能が**どう動いているか**を書いた文書。
[`../CLAUDE.md`](../CLAUDE.md) から分離した（CLAUDE.md は毎回読まれるので、
そちらには罠と判断の基準だけを置き、仕組みの説明はこちらに寄せた）。

**この文書は現状の正である。** フェーズ9 完了時点（2026-09-08）の実装と一致している。
「なぜこの形なのか」は [`redesign-plan.md`](redesign-plan.md) の決定事項と実施記録、
欠陥番号（#1〜#46）は [`audit-2026-09.md`](audit-2026-09.md) を引くこと。

なお、ここに書いた根拠の多くは**ソース側にも定義位置のコメントとして書いてある**
（`service-worker.js` の `session` / `reconcile`、`dom-chat.js` の `HEALTH`、
`theme.js` の冒頭など）。実装を触るときは、そちらも合わせて読むほうが早い。

---

## 設計概要

ライブチャットのメッセージを取得し、フィルターに合うものだけをポップアップ画面に
リアルタイム表示する。取得元は2モードある。

- **DOMモード（既定・APIキー不要）**: `dom-chat.js` がライブチャットのDOMを直接監視する
- **APIモード**: YouTube Data API v3 の `liveChatMessages` をポーリングする

### watch ページ側（`content/content-script.js`）

このスクリプトが持つのは「この画面はどの配信か」と「その配信のチャットIDは何か」
だけで、**コメントは1件も持たない**（APIモードの残骸だった控えはフェーズ9で撤去した。
popup は SW から直接もらう）。やることは4つ。

- SW の起床待ち（`waitForServiceWorkerAndInit`）。`ping` を最大10回・指数バックオフで
  投げてから `init()` に入る。**`setupMessageListener()` だけは待たずに先に張る** ——
  待っているあいだに popup の `ping` が来ると「未注入」と誤判定され、
  要らない再注入を招く。**popup ↔ SW のポート化（フェーズ6b）で消えたのは popup 側の
  待ちだけで、こちらは `sendMessage` のままなので残っている**
- 配信の特定（`extractVideoId` / `extractLiveChatId`）
- 自動開始の要求（`tryDomModeAutoStart` / `tryAutoStart`）
- SW からの要求への応答（`ping` / `startMonitoring` / `stopMonitoring` /
  `getLiveChatId` / `pageNavigated`）

**watch ページで何をするかは、先にモードを聞いてから決める**（`startForCurrentPage`）。
APIモードなら `extractLiveChatId`（liveChatId を引いて `tryAutoStart`）、
DOMモードなら `tryDomModeAutoStart` だけ。**DOMモードで liveChatId を引きに行かないこと** ——
APIキーの要らない既定の構成で「API key not found」だけが返る往復になり、
しかも失敗として2秒おきに10回まで繰り返す。**モードの既定は `dom`**
（`resolveChatMode` と SW の `getChatMode`、`getLiveChatIdFromVideo` は同じ既定を使う。
未保存を `api` 扱いにすると、インストール直後にエラーが出る）。

**SPA遷移の検知は Service Worker が持つ**（`chrome.tabs.onUpdated`。#24）。
以前はここが `document.body` 全体を `MutationObserver` で購読して
`location.href` の変化を見ており、拡張機能がやっていることの中で最も高価な処理だった。
いまは SW が `pageNavigated` を送ってきて、それを受けて自分の控えを捨て、
新しい動画で組み立て直す。**セッションを畳むのは SW の側**（`session` の正はあちら。
ここで `stopBackgroundMonitoring` を呼ぶと突き合わせの正が2つに戻る）。

### DOMモードの読み取り（`content/dom-chat.js`）

**YouTube の DOM に依存する文字列は `SELECTORS` レジストリに集約している**
（フェーズ7）。セレクタ15個・行のタグ名5個（`KIND_BY_TAG`）・属性名1個（`AUTHOR_TYPE_ATTR`）の
計21個が1か所にあるので、YouTube 側の変更で直す場所は1つ。
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

**行の中の画像は、行がDOMに入った直後にはまだ無い。** `yt-img-shadow` が
あとから `img` を作るので、その場で読むと空になる。空振りするのは2か所あり、
ステッカーは画像URLもステッカー名（`alt`）も取れず、アバターはURLが取れない。
**扱いは2つで違う。**

**ステッカーは待つ。** 名前（`alt`）は**本文そのもの**で、IDも本文から作るので、
あとから足すと別のコメントになってしまう。100ms ごとに見に行き、1.5秒で打ち切って
画像なしで取り込む。待ちは1本の列（`pendingRows`）にまとめ、**先頭から順に出す**
——行ごとに待たせると、待っている行をあとの行が追い越して popup の並びが前後する
（popup は届いた順に積む）。待っているあいだに投稿時刻が後ろへずれないよう、
受信時刻は行を見つけた時点のものを持ち回る。

**アバターは待たない。別便で追いかける**（「アバターの拾い直し」）。

- 有料の行はアバターの器が違うので `img#img` で拾い直すが、**ステッカーの `img` も
  同じ id を持つ**。取り違えるとスパチャの行に投げたステッカーが顔として並ぶので、
  ステッカーの `img` は除いてある

### アバターの拾い直し（`content/dom-chat.js` → `domChatAvatars`）

アバターの `img` は行と同時には生えない。`yt-img-shadow` がビューポートに入って
から作るので、**いつ生えるかは YouTube の都合で上限が無い**。取り込みをそれに
待たせると、待ち時間をいくつに決めても「コメントが遅れる」か「頭文字（`@`）のまま
取りこぼす」のどちらかになる（0.5秒待つ版を実配信で試して、**半分が間に合わなかった**）。
だから**取り込みは1msも待たせず、アバターだけを別便で追いかける**。

- 追いかける単位は**発言者**。保存も popup の表示も「発言者名 → URL」のマップが正
  なので、1人ぶん取れれば**その人の過去の行もまとめて埋まる**
- コメントに載ってURLが届いた発言者は追いかけない（`knownAvatars`）。
  取れていない発言者だけを `pendingAvatars` に控え、**行が流れてくるたび**と
  **1秒ごと**に読み直す（背面タブではタイマーが間引かれるので、行の動きにも乗せる）
- 諦めるのは、行がチャットから流れ去ったとき（`document.contains`）か、
  30回見に行っても生えなかったとき。どちらで諦めても、**同じ人が次に喋れば
  新しい行で追いかけ直す**。諦めても消えるのは丸い画像だけで、コメントは既にある
- 外れた行でも読めるなら拾う。URLは行ではなく**発言者のもの**だから
- 送るのは `{ displayName, avatarUrl, role, kind }`。枠（primary / bulk）の判定は
  `bucketOf()` が正（決定3）なので、その材料だけを渡して SW に決めさせる
- SW 側（`handleDomChatAvatars`）はコメントと**同じ関門・同じ鎖**を通す
  （別のタブのアバターを混ぜない・セッションの張り直しと競合させない）。
  popup へは `comments: []` と差分のアバターだけを送り、popup は
  `fillInAvatars()` で**描画済みの行の丸い画像だけ**を差し替える（行は作り直さない）

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

### 本文に混ざる画像（絵文字）

チャットの本文に入る絵文字は、文字ではなく `img` として DOM に入っている。
文字として残るのは `alt` だけで、その中身は2種類ある。

| 種類 | `alt` の例 | 画像 | 扱い |
| --- | --- | --- | --- |
| Unicode の絵文字 | 🔧 🎉 👍🏽 1️⃣ | あってもなくてもよい | **文字のまま**。画像に戻す必要が無い |
| 名前の付いた絵文字 | `2BROOtojya` / `eyes-pink-heart-shape` / `:_hearts:` | 必須 | 名前 → 画像URL の対応表を持たせ、**表示側で画像に戻す** |

**名前の形はまちまちで、コロンで囲まれているとは限らない**（実配信で確認）。
メンバー限定絵文字はチャンネルが付けた名前がそのまま入り、YouTube標準の絵文字も
`eyes-pink-heart-shape` のような裸の名前で来る。だから見分けるのは
**「`alt` が絵文字そのものではないか」の1点だけ**にしてある
（`shared/comment.js` の `isEmojiLabel()`。`Extended_Pictographic` などだけで
出来た文字列なら文字のまま出す）。

`extractMessageContent()` が `#message` の子節点を1回だけ走査して、
本文の文字列と対応表（`emojis`）を同時に作る。

- **本文の文字列は書き換えない。** `alt` をそのまま並べる（名前にコロンを足したりもしない）。
  ID の元になるキー（`commentKeyOf()`）と検索対象（`searchText`）が本文から
  作られているので、**本文を変えると更新前に保存した履歴と突き合わせられなくなり、
  全件スキャンで二重に積まれる**。画像URLを混ぜないのも同じ理由
  （スーパーステッカーの `stickerUrl` をキーに混ぜないのと同じ）
- 対応表は**使っている行にだけ**生やす。1件あたり数十バイトでも、履歴は
  1動画で数万件になりうる（`kind` を通常のコメントに載せないのと同じ理由）
- 同じ絵文字を何度使っても対応表は1つ。種類数の上限は16、名前の長さは64文字まで
  （`normalizeEmojis()`。保存に載る値なので形と件数はここで揃える）
- 名前は外から来る文字列なので、**素のオブジェクトに直接代入しない**
  （`__proto__` が来ると代入がプロトタイプへ流れる）。`Map` に貯めて
  `Object.fromEntries()` で組み立てる
- ホストは末尾一致で見る（`.ggpht.com` / `.googleusercontent.com`。`yt3` と `yt4` の
  ような番号違いが実際にある）。YouTube標準の絵文字は `www.youtube.com` の
  `/s/` 以下の静的ファイルで、サイズ指定を受け付けないのでパスをそのまま使う。
  通らなかったホストは**1回だけ `console.warn` に出す**（画面には名前の文字が
  出るだけなので、置き場が変わったのか絵文字でない画像なのか区別が付かない）
- 要求するサイズは表示（24px）の2倍
- **APIモードには対応表が付かない。** `displayMessage` には名前しか入らず、
  画像URLは返ってこないので、APIモードでは名前の文字のまま表示される

表示側（`popup.js` の `messageNode()`）は**対応表にある名前そのもの**で本文を切り分け、
ホストの確認も通ったものだけを `img` に差し替える（名前の形が決まっていないので、
正規表現のパターンは名前をエスケープして組み立てる。**長い名前から**当てるのは、
短い名前が長い名前の一部だったときに先に食われないようにするため）。
差し替えないものは文字のまま残るので、対応表を持たない履歴（更新前に保存したもの・
APIモード）でも本文は欠けない。画像が読めなかったときも名前の文字に戻す
（ステッカーと違い、本文の一部だから）。

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
> 既読扱いになっていた（`audit-2026-09.md` #4）。全件スキャンで送り直しても
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
全置換していた（`audit-2026-09.md` #22 = 根本原因D）。

- 行の組み立ては `document.createElement` + `textContent` + `setAttribute`。
  文字列HTMLを組まないので、属性のエスケープ漏れ（#25）が種類ごと成立しない
- リスナーは `commentsList` に `click` 1つと（捕捉フェーズの）`error` 1つだけ。
  行ごとには張らない
- レイアウトの読み取りは1描画につき1回。下端の判定は、代入した値から計算で出す
- 画像URLは https に加えて**配信ホストも確認する**（`AVATAR_IMAGE_HOSTS` /
  `STICKER_IMAGE_HOSTS` / `EMOJI_IMAGE_HOSTS`）。`https://` の前方一致だけだと
  任意のHTTPS先へ `img` のリクエストが飛ぶ（#26）

**CSS のクラス名と DOM 構造は描画方式を変えても維持すること**
（`popup.css` の `.comment-item:has(.role-*)` が構造に依存している）。
`hidden` で隠した行は `:last-child` のままなので、区切り線を消す
「最後に見えている行」には JS が `comment-item--last` を付ける。

### いま何を監視しているか（セッション状態）

Service Worker の状態は `session` ただ1つが正（再設計の決定6、フェーズ6aで実現）。
以前は SW のメモリ・`storage.local`・popup・content script の4か所に別々の正があり、
ズレるたびに突き合わせの分岐が1本ずつ増えていた（`audit-2026-09.md` 根本原因A）。

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
  （あとから届いたアバターは、新着と同じ `newSpecialComments` を
  `comments: []` で流す）
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
設定画面自身が永久にライトテーマ**だった（`audit-2026-09.md` #14）。

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

---

## テストの仕組み


ハーネスが vm コンテキストで対象スクリプトを丸ごと評価し、
内部の関数と状態をテストへ露出させる（テスト自体に実行時依存は無い）。

- `test/helpers/service-worker-harness.js` — chrome API をモックして
  `service-worker.js` を読み込む
- `test/helpers/content-script-harness.js` — 偽 window/document と chrome API をモックして
  `content-script.js` を読み込む。**内部の関数は露出させない（できない）** ——
  本体が `class` 宣言で、クラス宣言は二重注入ガードのブロックに閉じるため
  （Annex B の巻き上げが効くのは関数宣言だけ）。見るのは外から見える振る舞いだけ:
  chrome へ何を送るか / 何に応答するか / どのタイマーと監視を張るか
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

service-worker / dom-chat / popup / options のハーネスはいずれも、対象スクリプトより先に
`src/shared/comment.js` を同じコンテキストで評価する（本番の読み込み順を再現するため）。
popup ハーネスはさらに `theme.js`（`popup.html` の `<head>`）→ `comment.js` → `store.js`、
options ハーネスは `theme.js` → `comment.js` の順に評価する（どちらも HTML と同じ順番）。


Service Worker の状態は `session` 1つに畳んである（フェーズ6a）。`beginSession()` の
たびに丸ごと再代入されるため、ハーネスは getter 経由で露出している
（`sw.session`。旧名の `sw.monitoringState` は同じものを指す別名）。
**テストから直接参照を保持しないこと。**
番人の alarm は `chrome.__fireAlarm()` で発火させ、作成・削除は `calls.alarms` に残る。

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
確かめられる。手順は `redesign-plan.md` の「実ブラウザでの検証」にある
（道具立てはリポジトリに入れていない。必要なときに書き捨てる）。
