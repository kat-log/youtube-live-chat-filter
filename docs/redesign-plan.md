# 再設計計画 — 2026-09

策定日: 2026-09-07 / 起点: v1.12.5 (`7fdf3da`)

## この文書の使い方

**実装はフェーズごとに別セッションで行う。** 各セッションは次の順で読む。

1. この文書の「背景」「根本原因」「決定事項」「目指す設計」（全部で15分ほど）
2. 担当フェーズの節（「やること」「完了条件」「テスト」「注意」）
3. 必要に応じて [`audit-2026-09.md`](./audit-2026-09.md) の該当する欠陥番号

**欠陥番号（#1〜#46）は `audit-2026-09.md` の見出し番号と対応している。**
行番号は v1.12.5 時点のもの。ずれていたら該当箇所を探し直すこと。

各フェーズは**単独でリリースできる**。前のフェーズが終わっていない状態で次に進まない。

---

## 背景

v1.12.5 まで来て機能は揃っている。だが非マージコミット58件のうち
**14件（24%）が `fix:`** で、直近1か月に集中している。

CLAUDE.md 自身が「4度、その種のバグが本番で発覚している」と記録しているとおり、
**個々のバグは正しく直っているのに、同じ場所から次のバグが生えてくる。**

2026-09-07 に `src/` 全7,371行を調査し、**46件の欠陥**と、
それを生み続けている**6つの構造的原因**を特定した。
この計画はその原因を潰すためのもので、個別バグの修正リストではない。

### 先に評価しておくべき点

作り直しを提案しない理由でもある。

- コードは丁寧で、コメントは「なぜそうしたか」まで日本語で書かれている
- 48件のテストは「数時間使い込まないと発現しないバグ」だけに的を絞っていて、よく当たっている。
  依存パッケージなしで1.8秒で回る
- `docs/store-listing.md` の**根拠テーブル**（主張とそれを支えるコードの対応表）は、
  他のドキュメントも倣うべき良い型
- `docs/super-sticker-image.md` は残存する不具合まで正直に書いている良い事後分析

問題は書き方ではなく、**土台の前提**にある。

---

## 6つの根本原因

### A. 「いま何を監視しているか」の正が4か所にある

| 置き場所 | 実体 |
| --- | --- |
| SW メモリ | `monitoringState`（11フィールド、`service-worker.js:256-268`） |
| `storage.local.monitoringState` | 上の**部分集合**。書き込み箇所ごとに形が違う（3キー版 `548`/`659`/`1159`、5キー版 `1125`/`1360`） |
| popup | `isMonitoring` / `currentVideoId` / `monitoringVideoId` / `chatMode` / `comments` |
| content-script | `isMonitoring` / `currentVideoId` / `liveChatId` / `specialComments` |

ズレたときの突き合わせが、そのつど**別々に**足されてきた。

- `getStaleSessionReason()` (`SW:520`)
- `startDomMonitoring` の再利用分岐 (`SW:1304-1311`)
- `handleDomChatMessages` の動画変更検知 (`SW:1404-1412`)
- `tryDomAutoStart` の `isStaleSession` 判定 (`popup:1129`)
- `getMonitoringState` の `||` チェーン (`SW:1189-1193`)

**新しいバグが出るたび突き合わせ分岐が1本増える。これが最大の駆動力。**

`||` チェーンは「明示的な false / null」を表現できないため、
片方に残った古い `true` が必ず勝つ。`stopBackgroundMonitoring` (`SW:1143-1170`) が
メモリ側をクリアしないので、停止のたびに両者がずれる。

→ **決定6**（フェーズ6）で解消。

### B. フィルターを取り込み時にかけている

保存する前に捨てているため不可逆。詳細は #4。
→ **決定1**（フェーズ4）で解消。

### C. 履歴を毎回まるごと書き直す

500ms ごとに配列全体を `set()`。賑わった配信で毎秒約0.8MiB。詳細は #21。
→ **決定2・決定3**（フェーズ3）で解消。

### D. popup が新着1件ごとに一覧を全部作り直す

`innerHTML` の全置換 + 行ごとのリスナー再登録。N=10,000 で1描画300〜800ms。詳細は #22。
→ **決定4**（フェーズ5）で解消。

### E. 2つの取得モードが最後まで合流しない

コメントの形が違うまま3か所で別々に正規化している。

- SW: `apiCommentKind` / `apiCommentRole` (`SW:236-247`)
- popup: `formatComment` の2分岐 (`popup:1335-1385`)
- content-script: `formatComment` (`cs:408`) ← **完全な死にコード。形も違う**

新機能は毎回2回実装が要り、片方だけ直すと片肺バグになる。
実例が #10（`avatarsByAuthor` が API 側だけ無い）。

→ **決定7**（フェーズ2）で解消。

### F. 壊れても見えない

`debugLog` / `debugWarn` / **`debugError` すべてが `debugMode` off で沈黙する** (`SW:16-32`)。
そして `debugMode` を on にする経路は、既定構成のユーザーには**閉じている**（#12）。

**「数時間使わないと出ないバグ」を追うのに、既定でエラーが消えている。**
このプロジェクトが最も苦しんでいる問題に対して、いちばん効く道具が塞がれている。

→ フェーズ0で最優先に解消。

---

## 決定事項

調査の結果として確定した方針。**実装セッションはこれを前提にしてよい。**

### 決定1: 取り込みは全件。フィルターは表示側だけ

この拡張機能の売りは「取得済み全件をキーワード検索できる」こと。
CLAUDE.md にもそう書いてある。**取り込み時に捨てていたらその約束が成立しない。**

> 取り込まないコメントがあるなんてバグにしか思えない。フィルターは任意。

**取り込まれないコメントが存在する状態は、設計上のバグとして扱う。**

- SW は表示フィルターを取り込み時にかけない。見るのは「表示可能な種別か」だけ
- 既読マークは「保存すると決めたあと」に付ける（#4 の順序を入れ替える）
- 絞り込みは popup が担当する。いまも `renderComments` でやっているので、二重の片方を消す

**残す除外**: ギフトの受領告知（`giftMembershipReceivedEvent` /
`yt-live-chat-sponsorships-gift-redemption-announcement-renderer`）は
受け取った人数ぶん流れて量が多く、意図的に対象外にしている。これは維持する。

### 決定2: 保存は IndexedDB

決定1で保存件数が桁違いに増えるため、配列全体の書き換え方式は続けられない。

IndexedDB を選ぶ理由:

- **追記が1レコード追加で済む**（いまは全件の再直列化）
- **範囲読みでページングできる**（popup が全件をメモリに載せなくてよくなる）
- **上限の管理が素直**（古いものから消すのがカーソルで書ける）
- Service Worker から使える

`storage.local` のチャンク分割でも書き込み量は同程度まで落ちるが、
決定4（popup が全件をメモリに持たない）に必要な範囲読みが素直に書けないため、IndexedDB を採る。

### 決定3: 保持枠を2つに分ける

決定1に対して「一般コメントが特別コメントを押し出す」心配が出るが、
IndexedDB なら枠を分けられるので**構造的に起きなくできる**。

| 保持枠 | 対象 | 想定件数（5時間配信） | 上限の考え方 |
| --- | --- | --- | --- |
| `primary`（低頻度） | `owner` / `moderator` / `superchat` / `supersticker` / `membership` / `gift` | 数百〜数千 | 大きく取れば実質無制限 |
| `bulk`（高頻度） | `member` / `normal` | 数万〜数十万 | 別枠で上限。溢れたら古い順に落とす |

**枠が別なので、一般がいくら流れても特別コメントは絶対に押し出されない。**

枠の判定は「役割」でも「種別」でもなく**流量**で決めている。
`member`（メンバー）は製品の意味づけとしては特別だが、
大きな配信では一般と同じ流量になるため `bulk` に入れる。

具体的な上限値は実測して決める。出発点として `primary` = 20,000 / `bulk` = 50,000（動画あたり）。
保持動画数は現行の `MAX_HISTORY_VIDEOS = 5` を踏襲する。

**保持枠と表示フィルターのキーは1対1で対応している。** これは偶然ではなく、
どちらも「流量」で切っているため。決定4（popup が bulk をメモリに載せない）を
実装するとき、この対応が効いてくるので先に書いておく。

| 保持枠 | `filterKeyOf()` が返すキー |
| --- | --- |
| `primary` | `owner` / `moderator` / `superchat` / `membership` |
| `bulk` | `sponsor`（メンバー） / `normal` |

帰結が2つある。

- **`primary` だけをメモリに載せていても、4つのバッジの件数は常に正確に出せる。**
  数字を出せないのは「メンバー」「一般」の2つだけ
- **その2つを表示するときは必ず `bulk` を読んでいる**ので、
  表示中の件数の内訳が合計値と食い違うことも起きない（#18 の不変条件が保たれる）

### 決定4: popup は「全件をメモリに載せる」のをやめる

決定1の必然的な帰結。数十万件を `this.comments` に積むことはできない。

- 起動時に **`primary` だけ**全件メモリへ（数千件・軽い）
- `bulk` は既定では読まない。「メンバー」「一般」トグルON、または検索実行時に IndexedDB から引く
- 検索は `primary` がメモリで即答、`bulk` は IndexedDB をカーソル走査（デバウンス後、進捗表示つき）
- 描画は差分追加 + ウィンドウ（最新N件を出し、古い分はスクロールで追加読み）

「全部取り込む」を守りつつ popup が固まらない形は、これで成立する。

**ただし効くのは「特別」プリセットの利用者に対してだけ。**
`DEFAULT_COMMENT_FILTERS` も popup の初期値も全部ONなので、
既定の利用者は起動直後に「メンバー」「一般」のトグルがONで、結局その場で bulk を読む。
既定の利用者にとっての改善は**決定4ではなく差分描画のほう**（根本原因D）。
期待値をここで揃えておくこと。

### 決定5: 「依存パッケージなし」方針を転換する

CLAUDE.md の現行方針だが、固執するデメリットのほうが大きい。

- **リリース zip は `src/` 以下だけ**なので、devDependency は同梱物に影響しない
- 今回見つかった死にコード（#38）や `avatarsByAuthor` の欠落キー（#10）の類は、
  `no-undef` / `no-unused-vars` だけでも機械的に防げる
- devcontainer は既に ESLint / Prettier が効いている前提の設定になっている（#43）。
  実態と設定が食い違っているほうが有害

→ CLAUDE.md の記述を「**実行時の依存はゼロ。開発ツールは必要なものを入れる**」に改める。

**ただし「ビルド不要」は維持する。** `src/` をそのまま
「パッケージ化されていない拡張機能を読み込む」で使える性質は、この拡張機能の開発体験の核。

### 決定6: セッション状態を1つにする

- `monitoringState` を**まるごと**永続化する（部分集合をやめる）。
  入口は `loadSession()` / `saveSession()` の2つだけ
- `epoch`（世代番号）を持たせ、非同期処理の続きは
  **自分の epoch がまだ現役かを確認してから**状態に触る
- 突き合わせ分岐5本を `reconcile(tabId, videoId)` 1本に畳む。`||` チェーンをやめる

**「まるごと」は文字どおりには書けない。** `processedMessageIds`（`Set`）と
タイマーIDは `storage.local`（JSON）に置けないし、置く意味も無い（前者は
IndexedDB から、後者は番人が作り直せる）。実体は
**「永続化するキーの一覧を定数で持ち、`saveSession()` は毎回その全部を書く」**形になる。
やめたいのは*保存する項目が書き込み箇所ごとに変わること*であって、
持ち物を全部ストレージに置くことではない。

### 決定7: コメントの型を1つにする

`src/shared/comment.js` を新設し、`self.YTF` へのグローバル代入で公開する。
**ビルド不要のまま3つの実行環境すべてから使える。**

| 環境 | 読み込み方 |
| --- | --- |
| Service Worker | `importScripts('../shared/comment.js')` |
| content script | manifest の `js: ["shared/comment.js", "content/dom-chat.js"]` |
| popup / options | `<script src="../shared/comment.js">` を先に置く |

---

## 目指す設計

### コメントの正準形

```js
{
  v: 1,                  // スキーマ版。将来の移行のため
  id,                    // 一意。末端まで通す（#3 と #22 が同時に消える）
  bucket,                // 'primary' | 'bulk'（決定3）
  kind,                  // 'text' | 'superchat' | 'supersticker' | 'membership' | 'gift'
  role,                  // 'owner' | 'moderator' | 'member' | 'normal'
  displayName,
  message,
  amountText,            // スパチャの金額表示（無ければ null）
  eventText,             // 「新規メンバー」等（無ければ null）
  stickerUrl,            // スーパーステッカーの画像（無ければ null）
  publishedAt,           // ISO文字列
  searchText             // 取り込み時に生成（#23 が消える）
}
```

`kind` は現状「テキストなら省略」という省サイズ最適化をしている (`dom-chat:139`)。
IndexedDB 移行後は1件あたり数十バイトの節約に意味が無くなるので、**常に入れる**。
ただし**旧形式（`kind` 無し = テキスト）を読めることは残す**。

### ID の作り方

現状の32bitハッシュは衝突する（#9）。キー文字列そのものを ID にすれば衝突はゼロ。

```
key = displayName + U+0000 + message + U+0000 + timestampText
      (+ U+0000 + kind + U+0000 + amountText + U+0000 + eventText)  ← kind !== 'text' のとき
id  = key + U+0000 + occurrence
```

長さが問題になるなら 64bit 相当（2本の32bitハッシュの連結）でもよい。
どちらにせよ **`occurrence` の全消し（#29）は FIFO 間引きに変える。**

**旧 ID 形式 `dom_<hash>_<n>` を読めることは必ず残す。** 保存済み履歴と重複させないため。

### 保存レイアウト（IndexedDB）

```
DB: ytChatFilter
  store: comments
    keyPath: 'pk'                       // `${videoId}:${seq}` （seq は単調増加）
    index:   'byVideoBucket'  -> [videoId, bucket, seq]
    index:   'byVideo'        -> [videoId, seq]
  store: avatars
    keyPath: ['videoId', 'displayName']
  store: meta
    keyPath: 'videoId'                  // { lastSeq, counts: {primary, bulk}, updatedAt }
```

- 追記は `comments` への `put` のみ
- popup の初期表示は `byVideoBucket` の `[videoId, 'primary']` 範囲を新しい順に読む
- 上限超過の削除も同じインデックスをカーソルで古い方から

### 状態管理

```js
// SW 内で唯一の正
let session = {
  epoch,            // 世代番号。startXxx のたびに +1
  isMonitoring,
  chatMode,         // 'dom' | 'api'
  videoId,
  tabId,
  liveChatId,       // APIモードのみ
  pageToken,        // APIモードのみ。永続化する（#36）
  startedAt
};
```

- 保存・復元は `saveSession()` / `loadSession()` のみ。**部分集合を書かない**
- `reconcile(tabId, videoId)` が唯一の突き合わせ口
- 非同期処理の続きは必ず `if (myEpoch !== session.epoch) return;` を通す

### 番人（`chrome.alarms`、1分周期）

MV3 の Service Worker は約30秒アイドルで終了する。
`setTimeout` は SW ごと消えるので、外から起こす仕組みが要る（#37）。

| モード | 番人がやること | 何を見て決めるか |
| --- | --- | --- |
| API | 「動いているべきなのにタイマーが無い」なら再開。#8 と #37 の実害が消える | メモリでよい（タイマーの有無は SW と生死を共にする） |
| DOM | 「N分コメントが来ていない」なら再注入 + 再スキャン。#2 の実害が消える | **SW の終了に耐える場所**（IndexedDB の `meta.updatedAt`） |

**番人が見る値は、Service Worker の終了に耐える場所に置くこと。**
「最後にコメントが来た時刻」をメモリに持つと、**番人に起こされるたびにリセットされ**、
沈黙を一生検知できない（番人を作る目的が SW の終了に耐えることなのに、
判断材料が SW と一緒に消える）。IndexedDB の `meta` は append のたびに
`updatedAt` が入るので、そこから引けば足りる。

**番人の「再注入」で直せるのは、注入時に走るものだけ**（フェーズ7で判明）。
content script は二重注入ガード（`window.__domChatInitialized`）で包まれているので、
`executeScript` をもう一度撃っても**中身は1行も走らない**。つまり
「すでに走っているスクリプトの壊れた状態」——外れた `MutationObserver` など——は、
番人からは直せない。番人が実際に効かせられるのは、一緒に送っている
`requestInitialSweep`（＝メッセージを受けて動く処理）の側だけ。
**自分で気付いて直す仕組みは content script 側に要る。** 番人はその保険。

### 壊れたことを見えるようにする（ヘルス状態）

根本原因F の裏返し。**ログを出しても利用者には見えない**ので、
「いま読めているか」は画面に出す。フェーズ7で DOMモードに入れた形を残す。

- **正は、いちばん現場に近いところ（content script）が持つ。**
  Service Worker のメモリに置くと約30秒で消え、popup を開いた時点では
  たいてい失われている。SW は受けた報告を控えるだけにして、
  控えが無い／古いときは**タブに聞き直す**
- 送るのは**状態が変わったときだけ**（片道の通知）。1件ごとに送ると、
  その通信自体が流量になる
- popup 側は「読めている」を静かに、「読めていない」を目立たせる。
  平常時に幅を取る表示は、既存の画面を押しのけるだけで情報量が無い
- **「壊れた」の判定は、単発の失敗ではなく連続で見る。** 本文の器を持たない行や
  お知らせ行は普通に混ざるので、1件2件で騒ぐと狼少年になる

### popup と SW の通信

`chrome.runtime.connect` のポートに変える。得られるもの:

- SW 側が「popup が開いているか」を知れる
- 送信順が保たれる
- 「Receiving end does not exist」の握りつぶしが要らなくなる
- popup が開いている間 SW が生きる
- **`waitForServiceWorker` の8回 ping (`popup:328`) と、
  3か所に重複している retry ヘルパーが不要になる**

**ポートにするのは popup ↔ SW だけ。** content script は `runtime.connect` の
相手ではない（SW から見て content script は「タブの中のスクリプト」で、
話しかける口は `tabs.sendMessage`）。つまり拡張機能の中には
**通信路が2本ある**状態が残る。

**content script への `tabs.sendMessage` を `await` するときは、必ず打ち切りを
付けること**（フェーズ7で判明）。`content-script.js` の `onMessage` は
**扱わない `action` でも同期分岐で `return true`** を返す（#30）ため、
応答チャネルが開いたまま残り、**応答が永久に返らない**ことがある。
`Promise.race` でタイムアウトを添えるか、そもそも応答を要らない形にする。
—— 皮肉なことに、これがいちばん起きるのは
「content script が正常に動いていないのでは」と疑って問い合わせるときで、
つまり**診断のための問い合わせが、いちばん固まりやすい**。SW 側で分岐を2組持たないよう、
要求の処理は1つの関数（`handleRequest`）に畳み、
ポートと `onMessage` はその応答を配るだけの薄い口にする。

**ポートは「要求と応答」ではなく「双方向に流れる管」である。**
`sendMessage` はコールバックが応答と1対1で結び付くが、ポートの `postMessage` は
ただ流すだけで、返事という概念が無い。**要求ごとの ID を自分で振り、
応答にそれを載せて返す**こと（`{ requestId, payload }`）。
「届いた順に対応づける」形にすると、処理時間の違う要求
（`getCommentsHistory` と `getApiKey` を並べる、など）で入れ替わる。
SW からの片道の通知（新着コメント等）は `requestId` を持たない形にして、
popup 側の受け口で区別する。

**知らない `action` にも必ず応答を返すこと。** `sendMessage` なら
応答が無ければ呼び出し側は「チャネルが閉じた」で終わるが、ポートでは
待ち行列に入ったまま**永久に解けない**（拡張機能を更新して popup と SW の
版がずれた瞬間に起きる）。

**ポートが切れたときの後始末も決めておくこと。** 待っている要求は
もう応答が来ないので、握りつぶさずに落とす。張り直したあとは、
切れていた間に流れた片道の通知が失われているので、**保存済みの履歴から
差分を取り込み直す**（既読の id で落ちるので、増えるのは取りこぼしぶんだけ）。

---

## フェーズ

| # | 名前 | 主な対象 | 消える欠陥 |
| --- | --- | --- | --- |
| 0 | 出血を止める | 各所 | #1 #12 #20 #39 + 根本原因F |
| 1 | 足場 | `.github/`, `test/helpers/` | #42 #43 |
| 2 | 型の一本化 | 全体 | #3 #9 #23 #27 #29 #38 |
| 3 | IndexedDB 移行 | `service-worker.js` | #6 #7 #21 #33 |
| 4 | 全件取り込み | `service-worker.js` | #4 #18 |
| 5 | popup の読み方と描画 | `popup.js`, `popup.css` | #11 #22 #25 #26 #34 |
| 6a | ライフサイクル（状態） | `service-worker.js`, `manifest.json` | #5 #8 #10 #35 #36 #37 |
| 6b | ライフサイクル（通信） | `service-worker.js`, `popup.js` | #32 |
| 7 | dom-chat 耐性 | `dom-chat.js` | #2 #28 |
| 8 | UI の穴 | `popup.css`, `popup.html`, `options.css` | #13 #14 #15 #16 #17 #19 |
| 9 | 掃除 | `content-script.js`, `manifest.json`, docs | #24 #30 #31 #40 #41 #44 #45 #46 |

---

### フェーズ0 — 出血を止める

**目的**: 設計変更を伴わない独立した修正。以降の調査を楽にすることを最優先する。

**やること**

1. **#12 デバッグモードを既定構成で有効にできるようにする** ← 最優先
   `options.js:60` のデバッグトグルを `saveSettings()` から切り離し、
   `saveAutoStart()` (`options.js:151`) と同じ形の独立した保存関数に変える
   （配線は `options.js:61` が手本）。
   APIキーの有無と無関係に保存されること。

2. **根本原因F: `debugError` を無条件出力にする**
   `service-worker.js:28-32`、`popup.js:58-62`、`content-script.js:35-39` の3箇所。
   `debugLog` / `debugWarn` は現状のまま（`debugMode` で制御）。
   エラーだけは既定で見えるようにする。

3. **#1 dom-chat.js の注入先を限定し、再試行に上限を付ける**
   - `service-worker.js:1375-1378` の `executeScript` に URL 条件を足す。
     `chrome.webNavigation.getAllFrames` で `live_chat` のフレームIDを引いて
     `target: { tabId, frameIds }` にするのが確実
     （`webNavigation` 権限が要る。ただしフェーズ9で権限を絞る方針なので、
     **`dom-chat.js` の先頭で `location.pathname` を見て即 return するほうが望ましい**。
     権限が増えず、manifest の自動注入とも整合する）
   - 早期 return を採る場合、`window.__domChatInitialized = true`
     (`dom-chat.js:3`) はガードの直後に立つ点に注意。チャットが無いフレームでは
     以後の注入もスキップされるが、そのフレームにチャットが現れることは無いので問題ない
   - `dom-chat.js:50-56` の `attachObserver` に再試行回数の上限を付ける
     （例: 60回 = 30秒。到達したら諦めてログを出す）

4. **#39 不要な `web_accessible_resources` を削除**
   `manifest.json:49-54` を丸ごと削除。`chrome.runtime.getURL` の使用は
   #31 の死んだ `sendBeacon` だけなので、参照は壊れない。

5. **#20 API疎通テストのコストを100分の1にする**
   `options.js:196` の `search` を `videos.list` に変える。
   例: `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=<KEY>`
   （キーが有効なら 200、無効なら 400/403 が返る）

**完了条件**

- APIキーを設定していない状態で、設定画面のデバッグモードをONにでき、リロード後も保持される
- `chrome://extensions` の Service Worker コンソールに、`debugMode` OFF でもエラーが出る
- watch ページの DevTools > Performance に 500ms 周期のタイマーが残っていない
- 既存48件のテストが通る

**テスト**

- `dom-chat.test.js` に「`#items` が見つからないとき、再試行が上限で止まる」を追加。
  ハーネスの `flush(limit)` (`dom-chat-harness.js:66-74`) が既に
  「タイマーが尽きない」を例外で検知する作りになっているので、そのまま使える
- options ページのテストは無い（#T7）。#12 は手で確認する

**注意**

- **このフェーズは引き継ぎ資料のテストでもある。** この節だけを読んで着手できなければ、
  資料が足りていない。詰まった点をこの文書に書き足してから進むこと

**実施記録（2026-09-07 完了）**

実装できた。手が止まった箇所と、書いておけば止まらなかったことを残す。
以降のフェーズで同じ形の指示を書くときの参考に。

1. **「早期 return」は文字どおりには書けない。** `dom-chat.js` の本体は関数ではなく
   二重注入ガードの `else` ブロックなので、トップレベルに `return` は置けない
   （ハーネスは `vm.runInContext` で評価するため `Illegal return statement` になる）。
   実際に採ったのは**ガードの条件を足す**形:

   ```js
   if (window.__domChatInitialized || !location.pathname.startsWith('/live_chat')) { /* noop */ } else {
   ```

   この形だと `__domChatInitialized` はチャット以外のフレームでは**立たない**ので、
   節に書かれていた「以後の注入もスキップされる」という注意は、結果として不要になった。
   SPA遷移でそのフレームがチャットになった場合に拾える分こちらが良い。

2. **再試行上限のテストには、ハーネスの変更が要る。** 節には「`flush(limit)` が
   そのまま使える」とあるが、`flush` はタイマーを進める側の道具でしかない。
   `#items` が見つからない状況そのものが作れない —
   `document.querySelector: () => ({ children: rows })` は**どのセレクタでも同じ物を返す**
   （#T2 に書いてあるとおり）。`loadDomChat` に `hasItemList` を足して null を
   返せるようにした。同じく `location` もコンテキストに無いので追加が要る。
   **「テスト」欄には、必要になるハーネス側の変更まで書いたほうがよい。**

3. **#12 は「配線を変える」だけでは終わらない。** `saveSettings()` の中にも
   `debugMode` の読み取りと `saveDebugMode` の送信が残っており、放置すると
   保存ボタンとトグルの二重書き込みになる。`saveSettings()` からはAPIキーの保存だけを
   残した（保存ボタンはデバッグモードを書かなくなる）。

4. **#20 は URL の差し替えだけで完結する。** 成功判定の `if (data.items)` は
   `videos.list` でもそのまま通る（存在しないIDでも `items: []` が返り、真になる。
   無効なキーは 400/403 なので `response.ok` の側で弾かれる）。

5. **バージョンは上げていない。** リリース判断は持ち主に任せる。
   `manifest.json` の `version` は 1.12.5 のまま。

テストは 48 件 → **50 件**（フレーム限定と再試行上限の2件を追加）。

---

### フェーズ1 — 足場

**目的**: 以降のフェーズが安全に進むための検知網を張る。

**やること**

1. **CI**: `.github/workflows/ci.yml` を新設。push と PR で `npm ci` → `npm run lint` → `npm test`
2. **ESLint**（決定5）: `eslint` を devDependency に。フラット設定 `eslint.config.js`。
   最低限 `no-undef`（`chrome` / `self` などは globals で宣言）と `no-unused-vars`。
   `package.json` に `"lint"` スクリプト。**インデントは既存に合わせて2スペース**
   （`options.js` だけ4スペースなので、そこは整形するか個別に除外する）
3. **popup ハーネスに偽 `document` を足す**（#T8）。
   `dom-chat-harness.js:79-89` の `element()` と同じ流儀で、
   `createElement` / `appendChild` / `textContent` / `setAttribute` を記録する最小の偽DOM。
   フェーズ5 の描画テストの土台になる
4. **セレクタモックを厳格にする**（#T1 #T2）。
   `dom-chat-harness.js:38` の `document.querySelector` を
   「知らないセレクタを引かれたら例外」に変える。セレクタ名の取り違えが検出できるようになる
5. **`MutationObserver` モックに記録を持たせる**（#T3）。
   `observe` / `disconnect` の呼び出しを記録。フェーズ7 の張り直しテストの土台

**完了条件**

- PR を作ると CI が走り、`npm test` と `npm run lint` の結果が見える
- `npm run lint` がエラー0で通る（既存コードの指摘は直すか、理由を書いて個別に無効化）
- 既存50件（フェーズ0で2件増えた）が引き続き通る

**注意**

- **`'use strict'` を足したり ES モジュールに変換したりしないこと。**
  両 content script は二重注入ガードのブロックで包まれており、ハーネスは
  Annex B の関数巻き上げで内部関数に到達している。触ると48件が
  原因不明の `TypeError` で全滅する（`audit-2026-09.md` の「実装時に踏んではいけない地雷」）
- ESLint の設定で `sourceType` を `module` にしないこと。同じ理由

**実施記録（2026-09-07 完了）**

5つとも実装できた。地雷は踏んでいない（`sourceType` は `script` のまま、
`'use strict'` も足していない）。手が止まった箇所と、節の記述が実態と違っていた点を残す。

1. **`npm ci` にはロックファイルが要る。** このリポジトリには依存が1つも無かったので
   `package-lock.json` も無く、CI の `npm ci` は最初の実行で落ちる。
   ESLint を入れる時点でロックファイルが生まれるので、**それを必ずコミットする**。
   このリポジトリで初めての `package-lock.json` になる（`.gitignore` は `node_modules/` を
   既に除外しているので、そちらの手当ては不要）。

2. **`globals` パッケージは入れなくてよい。** 節には「`chrome` / `self` などは globals で
   宣言」とあるが、パッケージを足す必要は無く、`languageOptions.globals` に手書きで足りる
   （実行環境は3つで、必要なグローバルは片手で数えられる程度）。フラット設定の
   `ecmaVersion: 2022` が ES 組み込みを供給してくれるので、書くのはブラウザ／Worker／Node の
   API だけ。**開発ツールの依存も eslint 1つで済んでいる。**
   環境ごとに `files` を分ける必要はある（Service Worker には `window` も `document` も無く、
   一緒くたにすると `no-undef` が骨抜きになる）。

3. **`no-undef` の指摘は0件、`no-unused-vars` は10件だった。** 内訳は
   使っていない `catch` の束縛が9件（optional catch binding にして解消）と、
   `popup.js` の `debugError` が1件（呼び出し側の差し替えはフェーズ5＝#34 の担当なので、
   理由を書いて個別に無効化）。**src/ の挙動は変えていない。**

4. **決定5 の「#38 の死にコードは `no-unused-vars` で拾える」は、半分しか当たらない。**
   `sourceType: script` ではトップレベルの関数宣言はグローバルなので報告されないし、
   `content-script.js:409` の `formatComment` は**クラスのメソッド**なので、
   そもそも `no-unused-vars` の対象外。**#38 はフェーズ2 で人手で消すしかない。**
   lint が拾ってくれるのは #10 型（未定義の参照・使っていないローカル）だけと見ておくこと。

5. **「`options.js` だけ4スペース」は不正確。** 実測すると `popup.js` も
   （クラス本体が）4スペース優勢で 280行、`content-script.js` も 163行ある。
   **整形ルール（`indent` など）を入れると全ファイルが書き換わる**ので入れなかった。
   節の最低要件（`no-undef` と `no-unused-vars`）だけにしてある。
   整形を入れるなら、差分が埋もれないよう再設計が終わってからにしたほうがよい。
   ついでに #43（devcontainer が存在しない formatter を有効化している）を、
   Prettier 側の設定を落とす形で解消した。

6. **やること4は、行の `querySelector` にも広げた。** 節が名指ししていたのは
   `document.querySelector`（#T2）だけだが、それだけだと #T1（行の中のセレクタが
   完全一致マップ）が残る。`dom-chat.js` が実際に引くセレクタ13個を
   `ROW_SELECTORS` に列挙し、**表に無いセレクタを引かれたら例外／
   表にあってその行に無いものは null** に分けた。既存50件はそのまま通ったので、
   `dom-chat.js` が引くセレクタは全部この表に載っていることも同時に確認できている。
   申し送りにあった `hasItemList: false` の道（既知のセレクタで意図的に null）は残してある。

7. **偽 document は、PopupController を実際に組み立てられるところまで届いた。**
   `document.fire('DOMContentLoaded')` で構築でき、`getElementById` は58個引かれて
   1つも未知の id は出なかった（`popup.html` にある59個のうち `error-actions` だけが
   JS から引かれていない）。ただし**初期化が実時間の再試行を回す**
   （Service Worker への ping 8回 + 1秒/2秒の待ち）ため、そのままテストに載せると
   1本で十数秒かかる。**フェーズ5 では、dom-chat ハーネスと同じように
   `setTimeout` を差し替え可能にするところから始めること。**
   今回は描画までは踏み込まず、偽DOM自体の振る舞いと
   「JS が引く id が HTML に実在するか」の契約テストだけを置いた。

8. **CI は `npm ci` → `npm run lint` → `npm test` の3ステップ。**
   ビルドは呼んでいない（`src/` をそのまま読み込める性質を維持するため）。
   Node は `engines` に合わせて20。

9. **CI は最初の実行でいきなり1件見つけた。** `npm test` の
   `node --test "test/**/*.test.js"` は、**Node 20 では動かない**
   （`--test` の引数でのグロブ展開は Node 22 から）。手元が Node 22 だと通るので
   気付けないが、devcontainer は `node:20` で `engines` も `>=20`。
   `node --test test/*.test.js`（シェルにグロブを展開させる形）に変えた。
   **CI を入れる価値がいちばん分かりやすく出た箇所。**

テストは 50 件 → **57 件**（監視の張り方3件・セレクタの厳格さ1件・偽DOM3件を追加）。

---

### フェーズ2 — 型の一本化

**目的**: 根本原因E を潰す。コメントの形と正規化を1か所に集める。

**やること**

1. **`src/shared/comment.js` を新設**（決定7）。`self.YTF = { ... }` に代入する素のスクリプト。
   移してくるもの:
   - `service-worker.js` から: `DEFAULT_COMMENT_FILTERS` (`193`), `normalizeCommentFilters` (`204`),
     `isCommentEnabled` (`215`), `KIND_BY_API_TYPE` (`226`), `apiCommentKind` (`236`),
     `apiCommentRole` (`242`), `stripHtmlTags` (`119`)
   - `popup.js` から: `FILTER_KEYS` (`69`), `filterKeyOf` (`107`), `INVISIBLE_CHARS` (`123`),
     `normalizeForSearch` (`130`), `KIND_BY_API_TYPE` (`86` — SW と重複している)
   - 新設: `normalizeComment(raw)` — API item / DOM message / 旧保存形式の3入力を正準形に変換
   - 新設: `bucketOf(comment)` — `'primary'` / `'bulk'` の判定（決定3）
   - 新設: `escapeAttr(text)` — `"` と `'` も escape する版（フェーズ5 まで暫定で使う）
2. **3環境から読み込む**。manifest の `content_scripts[].js` の先頭、
   SW の `importScripts`、popup/options の `<script>`
3. **`id` を末端まで通す**。`popup.js:1335` の `formatComment` が `id` を落としているのを直し、
   `addNewComments` (`popup:1312-1320`) の5フィールド比較を **`Set` による `id` 判定**に置き換える（#3）
4. **`searchText` を取り込み時に生成**（#23）。`normalizeComment` の中で作る。
   `popup.js:141-149` の遅延生成 `searchTextOf` は、旧データ用のフォールバックとして残す
5. **ID を衝突しない形に**（#9）。`dom-chat.js:249-270`。**旧形式を読めることは残す**
6. **全消しを FIFO 間引きに**（#29）。`dom-chat.js:89` と `dom-chat.js:265`
7. **`stripHtmlTags` の重複を解消**（#27）。`popup.js:2016` と `options.js:9` の
   `innerHTML` 版を捨て、`shared` の正規表現版に統一
8. **死にコードを削除**（#38）。特に `content-script.js:408` の `formatComment` と、
   到達しないメッセージ分岐4つ。ESLint（フェーズ1）が候補を挙げてくれる

**完了条件**

- `popup.js` と `service-worker.js` から、重複していた定数・関数の定義が消えている
- 同じコメントが API 経路と DOM 経路のどちらから来ても、正準形が一致する
- 既存57件（フェーズ1で7件増えた）が通る

**テスト**

- **正準形への変換**: API item / DOM message / 旧保存形式（`kind` 無し・`id` が旧形式）の
  3入力を `normalizeComment` に通し、同じ形になること
- **`id` による重複判定**: 同一分・同一本文の連投が **2件とも残る**こと。
  現状は消える（#3）ので、これは**いま落ちるテストを先に書く**形になる
- **旧 ID の読み込み**: `dom_<hash>_<n>` 形式の保存済みコメントが重複扱いされないこと
- **FIFO 間引き**: 上限超過後も、直前のコメントの `occurrence` が 0 に戻らないこと

**注意**

- `shared/comment.js` は `self` に代入する。`window` ではない（SW には `window` が無い）
- 既存の `service-worker.test.js` のうち、`normalizeCommentFilters` /
  `isCommentEnabled` / `apiCommentKind` を検証している7件は、
  ハーネスの読み込み対象を変えるだけで通るはず。**通らなくなったら移行の設計を疑う**

**実施記録（2026-09-07 完了）**

8つとも実装できた。地雷は踏んでいない（`'use strict'` を足していない、
`sourceType` は `script` のまま、`shared/comment.js` はガードで包まず `self` へ代入）。
フェーズ1からの申し送り5点はどれも正確で、そのとおりに手当てすれば通った。
詰まった箇所と、節の指示だけでは決まらなかった判断を残す。

1. **ソースに生の U+0000 を書いてはいけない。** IDのキーの区切りは U+0000 のままだが、
   `shared/comment.js` に**生のNUL文字**で書いたら `git` も `grep` も
   そのファイルをバイナリ扱いにした（差分がレビューできない）。
   `dom-chat.js` が `'\u0000'` とエスケープで書いていたのは、
   たまたまテンプレートリテラルだったからではなく**必然**だった。移すときも同じ形にすること。

2. **`normalizeComment` の出力に `avatarUrl` を足した。** 節の「コメントの正準形」には
   無いが、無いと popup が `comment.avatarUrl`（DOM）と
   `authorDetails.profileImageUrl`（API）を自分で見分けることになり、
   潰したいはずの2分岐が popup に residue として残る。
   `bucket` と同じく「保存するかどうかは後のフェーズが決める」ものとして正準形に入れた。

3. **役割の名前が2つある問題は、`role` を正準形のキー、`roleLabel` を表示用に分けて解いた。**
   移行前の popup は `comment.role` に**日本語ラベル**（「モデレーター」）を入れ、
   絞り込みは `comment.roleClass`（`'role-sponsor'`）を見ていた。
   正準形の `role` は `'owner' | 'moderator' | 'member' | 'normal'` なので、
   同じ名前のまま入れ替えると絞り込みが全部 `normal` に落ちる。
   `filterKeyOf` を `role` ベースに変え、表示側だけ `roleLabel` / `roleClass` を足す形にした
   （`roleClass` は CSS のクラス名なので描画の都合。フェーズ5 まで残す）。

4. **#3 のテストは「別々のバッチで送る」でないと赤くならない。** 節は
   「同一分・同一本文の連投が2件とも残る」としか書いていないが、旧実装の突き合わせ先は
   **取り込み済みの `this.comments` だけ**なので、2件を1バッチで渡すと旧実装でも素通りする。
   `addNewComments` を2回呼ぶ形にして初めて落ちた（確認済み: 旧 popup.js で赤 → 新で緑）。

5. **#29 のテストも「全消しと FIFO を区別できる並び」を作る必要がある。**
   FIFO は定義上いちばん古いものを捨てるので、「上限を超えさせてから最初のコメントを
   投げ直す」形だと FIFO でも連番が戻り、新旧どちらも落ちる。
   **上限の少し手前（4990件目）で1回投げ、そこから100件流して超えさせる**という並びにすると、
   全消しだけが連番を失う。`seenIds` 側も同じ形（1990件 → 対象 → 100件）。
   **「上限を超えたら」ではなく「上限を超えたときに何が残っているべきか」で書くこと。**

6. **旧IDは `legacyId` として1件ごとに載せ、Service Worker が突き合わせてから捨てる。**
   節は「旧形式を読めることは残す」としか書いていないが、これは2つ意味がある。
   (a) 保存済み履歴の旧IDが壊れないこと（IDは不透明な文字列なので自動的に満たされる）と、
   (b) **更新直後の全件スキャンで、同じコメントが新IDで二重に積まれないこと**。
   効くのは (b) のほうで、そのために `dom-chat.js` が新旧2つのIDを載せ、
   `handleDomChatMessages` が `processedMessageIds` を両方で引いてから `legacyId` を
   `delete` する（保存はしない＝ストレージは1バイトも増えない）。
   キーの作り方が1文字でも変わると (b) が崩れるので、
   **旧実装をそのまま書き写して突き合わせるテスト**を置いた。

7. **`getDiagnosticsInfo()` を消したので、テストが1件減った。** #38 の表にある
   「到達しないメッセージ分岐4つ」の1つが `getDiagnostics` で、その受け側が
   `getDiagnosticsInfo()`。分岐だけ消すと関数が完全に浮くので両方消したが、
   これには `service-worker.test.js` の「診断はストレージを全件読まずに使用量を返す」が
   ぶら下がっていた（死にコードを守るテストだったので一緒に消した）。
   **完了条件の「既存57件が通る」は、この1件だけ意図的に満たしていない。**
   `ERROR_SOLUTIONS` は #38 の表に載っているが**消していない** —
   「APIモードからしか到達しない」は死にコードではない。

8. **`shared/comment.js` は ESLint のどの `files` にも当たっていなかった。**
   `eslint.config.js` は `src/background` / `src/content` / `src/popup` / `src/options` を
   列挙する作りなので、新しいディレクトリを足すと**ルールが1つも適用されない状態**になる
   （エラーが出ないので気付きにくい）。`src/shared/**` のブロックを足し、
   globals は3環境の共通部分（`self` とログだけ）に絞った。
   `self` は `BROWSER_GLOBALS` にも足す必要がある。

9. **`content_scripts` への追加は dom-chat 側だけにした。** 節は
   「`content_scripts[].js` の先頭」とあるが、`content-script.js`（watch ページ側）は
   死にコードの `formatComment` を消したあと共有モジュールを1つも使わない。
   watch ページ全部で読ませる意味が無いので入れていない。
   Service Worker からの手動注入（`executeScript`）のほうは
   `files: ['shared/comment.js', 'content/dom-chat.js']` に直す必要がある（見落とすと
   注入経路だけ `self.YTF` が undefined で落ちる）。

10. **popup ハーネスの `setTimeout` 差し替えは、フェーズ5 を待たずに必要だった。**
    #3 のテストで `PopupController` を作る必要があり、実時間のままだと初期化の
    ping 8回でテストが十数秒かかる。dom-chat ハーネスと同じ「積むだけ」に変え、
    `context.__popup` から `PopupController` と唯一のインスタンスを触れるようにした
    （どちらもトップレベルの `class` / `let` なので、グローバルの属性にはならない。
    Service Worker ハーネスと同じ「末尾に expose を連結する」やり方で解いた）。
    偽要素に `closest()` も足した（`renderComments` が呼ぶ）。
    **フェーズ5 はこの土台から始められる。**

11. **vm コンテキストをまたぐ値は `deepEqual` で比べられない。** popup の中で作られた
    配列やオブジェクトは prototype が違うので、
    `assert.deepEqual` が「same structure but not reference-equal」で落ちる。
    テスト側で `JSON.parse(JSON.stringify(...))` に通してから比べている。

テストは 57 件 → **77 件**（正準形10件・popup の取り込み5件・IDの発番4件・
旧IDの突き合わせ2件を追加、死にコードのテスト1件を削除）。

---

### フェーズ3 — IndexedDB 移行

**目的**: 根本原因C を潰し、決定1（全件取り込み）の受け皿を作る。

**やること**

1. **`src/shared/store.js` を新設**。上の「保存レイアウト」のとおり。
   API は最小限に: `append(videoId, comments)` / `read(videoId, {bucket, limit, before})` /
   `count(videoId)` / `clear(videoId)` / `trim(videoId)` / `listVideos()` / `dropVideo(videoId)`
2. **`storage.local` からの移行**。初回読み出し時に `commentsHistory_<vid>` と
   `commentAvatars_<vid>` を IndexedDB へ移し、移行済みなら旧キーを削除。
   **移行前のデータを消す前に、書き込み成功を確認すること**
3. **保持枠ごとの上限**（決定3）。`trim` は `byVideoBucket` インデックスを
   古い方からカーソルで削除
4. **#6 履歴クリアの取りこぼしを直す**。アバター、`processedMessageIds`、
   `avatarsByAuthor` も消す
5. **#33 上限の不一致を解消**。popup 側の 10,000 (`popup:1326`) と
   復元経路の無制限 (`popup:1056`/`1075`) をやめ、決定4 の読み方に合わせる
6. **#7 / #21 の後始末**。`unlimitedStorage` を維持するなら、
   `isQuotaError` / `emergencyCleanup` / `safeStorageSet` のリトライ経路は
   IndexedDB 移行で役目を終える。**削除するか、IndexedDB の
   `QuotaExceededError` を扱う形に作り直すかを決めて、コメントも現状に合わせる**
   （`SW:270-273` のコメントは既に現状と食い違っている）

**完了条件**

- 賑わった配信で1時間流し、書き込み量が明確に減っている
  （`chrome://extensions` の Service Worker で計測、または DevTools > Performance）
- 既存の `storage.local` に履歴がある状態から更新して、コメントが失われない
- 履歴をクリアしたあと再スキャンすると、コメントが戻ってくる（#6 の逆確認）

**テスト**

- **追記が末尾だけを触る**こと（既存レコードへの `put` が発生しない）
- **旧 `storage.local` からの移行**: 旧形式のデータを置いた状態で読み出し、
  正しく移り、旧キーが消えること
- **保持枠が独立**であること: `bulk` を上限まで積んでも `primary` が1件も減らない ← **決定3の核心**
- **`clear` 後に再スキャンで戻る**こと（#6）

**注意**

- **IndexedDB のモックをハーネスに新設する必要がある。** 依存パッケージを増やしたくないなら、
  使っている API だけを実装した最小の偽実装でよい（`open` / `transaction` /
  `objectStore` / `put` / `getAll` / `openCursor` / `delete` / `index`）。
  `service-worker-harness.js` の `storage` モックが良い手本
- **移行は片道**。ロールバックできないので、書き込み成功の確認を丁寧に

**実施記録（2026-09-07 完了）**

6つとも実装できた。地雷は踏んでいない（`'use strict'` を足していない、`sourceType` は
`script` のまま、`shared/store.js` はガードで包まず `self` へ代入、生の U+0000 も書いていない、
実行時の依存はゼロのまま、フェーズ4以降には手を出していない）。
フェーズ2からの申し送り7点はどれも正確で、そのとおりに手当てすれば通った。
判断が要った点と、節の指示だけでは決まらなかったことを残す。

1. **`self.YTFStore` にした（`self.YTF` への相乗りではない）。** 理由は3つ。
   (a) `comment.js` は `global.YTF = { ... }` と丸ごと代入するので、相乗りには
   `Object.assign` への書き換えと「comment.js が先」という順序依存が要る。
   名前空間を分ければ、順序を間違えたときに `ReferenceError` でその場で分かる。
   (b) 読む環境が違う（`store.js` は content script では要らない）。
   (c) 「型」と「保存」は別の関心事で、`YTF` に混ぜると `bucketOf` と `LIMITS` が
   同じ名前空間に並ぶ。**ただし store.js は comment.js に依存する**
   （枠の判定は `YTF.bucketOf` が正で、store 側に書き直していない）ので、
   読み込み順は comment.js → store.js で固定。

2. **`monitoringState.commentsHistory` を消した。これがこのフェーズで一番大きい決断。**
   節には「store.js を新設して移行する」としか書いていないが、メモリ側の配列を
   残したまま IndexedDB を足すと、**保存先が2つある状態**が続く（#33 の食い違いは
   まさにそこから生えていた）。消した結果、依存していた箇所が
   `restoreStateFromStorage` / `startBackgroundMonitoring` / `startDomMonitoring` /
   `startPollingLoop` / `handleDomChatMessages` / `getCommentsHistory` /
   `cleanupOldCommentHistories` / `getMonitoringState` の8か所あり、
   **既存テストも12件書き換えになった**（保存されたかの確認先が
   `sw.monitoringState.commentsHistory` から `store.read()` に変わるため）。
   次に同じ規模のことをするフェーズがあるなら、
   **節に「メモリ側の持ち物をどうするか」まで書いておくと迷わない。**
   メモリに残したのは `avatarsByAuthor`（アバターの差分を出すためのキャッシュ）と
   `processedMessageIds` だけ。どちらも履歴そのものではない。

3. **#6 の消し忘れは4つある。** 節（と申し送り）が挙げているのは3つ
   （アバター・`processedMessageIds`・`avatarsByAuthor`）だが、
   IndexedDB 化で**「保存待ちのバッファ」という新しい置き場**ができる。
   デバウンス中（500ms）にクリアされると、直後の flush で消したはずのコメントが
   書き戻る。`clearCommentsHistory` は `pendingSave` も捨てる必要がある。
   テストも別に1本置いた。

4. **`cleanupOldCommentHistories` が `ensureStateRestored()` を待っていなかった。**
   これは移行前からあった順序依存で、「監視中の動画を守る」ための
   `currentVideoId` が復元前だと `null` なので、**いま見ている配信の履歴を
   真っ先に消す**（いちばん古いことが多いため）。移行のぶん復元が遅くなり、
   テストが `settle()` の30msを超えて**不安定になって初めて見つかった**。
   `cleanup` の先頭で待つように直した。
   **テストが揺れたら、待ち時間ではなく順序依存を疑うこと。**

5. **IndexedDB のモックは、非同期の発火タイミングが全部。** 作ったのは
   `test/helpers/indexeddb-mock.js`（依存パッケージは足していない）。踏んだ穴は2つ。
   - **コールバックを同期で発火してはいけない。** `openCursor` の request は
     `continue()` のたびに `onsuccess` が再発火するが、呼び出し側は
     `continue()` の**後**にハンドラを張り直す。同期で発火すると
     その1回が宙に浮き、カーソルが1歩も進まない（テストが無言でハングする）
   - **トランザクションの完了はマクロタスクで判定する。** 保留リクエストが0に
     なった瞬間に `oncomplete` を撃つと、`await` で繋いでいる途中（マイクロタスク）で
     閉じたことになる。`setTimeout(..., 0)` にすると、本物と同じ
     「制御がイベントループに戻ったら commit」に揃う
   逆に、本物の IndexedDB で怖い「`await` を挟むとトランザクションが閉じる」は、
   **同じトランザクションのリクエストを待つぶんには起きない**（マイクロタスクは
   commit より先に回る）。store.js は1つの操作を1つのトランザクションで完結させている。

6. **#7 / #21 の去就はこう決めた。**
   - `emergencyCleanup` は**削除**。全件書き直しが無くなったので「手元の配列を
     切り詰めて送り直す」対象そのものが存在しない
   - `safeStorageSet` は**残すがリトライを削除**。履歴が移った後、
     `storage.local` に残るのは設定と監視状態だけ（数百バイト）。
     「書き込み失敗で監視開始が中断しない」という #41 の性質はテストごと維持
   - `isQuotaError` / `notifyStorageQuotaError` は**残して IndexedDB に付け替え**。
     append が容量超過で落ちたら、監視中以外の動画の履歴を捨てて**1回だけ**再試行する。
     #7 の形（切り詰める対象と送り直す対象が同じ配列）にならないよう、
     捨てるのは「他の動画」、送り直すのは「新着のバッチ」で別物にしてある
   - `SW:270-273` の「unlimitedStorage 無しだと10MB上限で」というコメントは、
     現状に合わせて書き直した

7. **#33 は popup にも `shared/store.js` を読ませて解いた。** 上限を1か所にしないと
   また食い違う。`popup.html` は `comment.js` → `store.js` → `popup.js` の順。
   popup はまだ IndexedDB を読まない（それは決定4＝フェーズ5）が、
   `MAX_COMMENTS_TO_POPUP` を store から引く。あわせて上限の判定を
   `setComments()` に移した（追記経路にしか上限が無く、**復元経路が無制限**だったのが
   #33 の後半）。SW 側は `readCommentsForPopup()` が
   **primary を先に確保してから残り枠を bulk の直近で埋める**ので、
   上限に当たっても特別コメントは押し出されない。
   なお `MAX_COMMENTS_TO_POPUP` だけは SW 側で分割代入せず毎回 store から引いている
   （10,000件を積まずに上限のテストを書けるようにするため）。

8. **上限値（primary 20,000 / bulk 50,000）は決定3の出発点のまま。** 「実測して決める」は
   フェーズ4（全件取り込み）で実際の流量が出てから。テストからは `store.LIMITS` を
   書き換えて小さくしている（上限まで積むテストを現実的な時間で書くため）。

9. **完了条件のうち「賑わった配信で1時間流して書き込み量が減っている」は未実施。**
   実ブラウザでの計測なのでモックでは代替できない。代わりに
   「追記が末尾だけを触る（既存レコードへの put が発生しない）」をテストで固定した。
   残り2つ（旧データからの更新でコメントが失われない／クリア後に再スキャンで戻る）は
   テストで確認済み。**実ブラウザでの計測は持ち主の手元でお願いしたい。**

10. **移行は「書けたのを読み直してから消す」形にした。** `append` のトランザクション完了に
    加えて `count()` で件数を確かめてから旧キーを消す。さらに、
    「書けたが消す前に落ちた」あとの再起動に備えて、既に入っているIDは除いてから積む
    （2度走らせても二重にならないことをテストで固定した。この確認は
    **重複除去を外すと落ちる**ところまで見ている）。

11. **テストは 77 件 → 93 件**（store 単体11件・#6 のクリア2件・容量超過1件・
    popup へ渡す件数1件・popup 側の上限1件を追加。既存の12件は保存先の変更に合わせて
    書き換えたが、確かめている内容は変えていない）。
    新しいハーネスは `test/helpers/indexeddb-mock.js` と `test/helpers/store-harness.js`。

12. **行番号の申し送りは全部当たっていた。** 8か所を探し直さずに済んだ。
    次のフェーズでも同じ形で残しておくと速い。

---

### フェーズ4 — 全件取り込み

**目的**: 決定1。根本原因B を潰す。

**やること**

1. **`handleDomChatMessages` (`SW:1423-1428`) から表示フィルターを外す。**
   残すのは「表示可能な種別か」の判定だけ（`apiCommentKind` が `null` を返すものは落とす）
2. **既読マークの順序を入れ替える**（#4）。保存すると決めたあとに `add` する
3. **`fetchLiveChatMessages` (`SW:1045-1049`) も同様。**
   フィルターは適用せず、表示可能な種別だけに絞る
4. **`bucket` を付けて保存**（決定3）。`shared/comment.js` の `bucketOf` を使う
5. **#18 件数バッジの母集団を揃える**。合計 (`popup:1619`) と内訳 (`popup:1621-1626`) が
   同じ集合を数えるようにする

**完了条件**

- **「特別」プリセットで取り込み → 「一般」をON → 過去分が表示される。**
  これがこのフェーズの本体
- 件数バッジの内訳の合計が、合計値と一致する
- 賑わった配信で1時間流しても popup が固まらない（フェーズ5前なので、
  `bulk` を読まない既定状態での確認）

**テスト**

- **フィルターOFFで取り込み → ONに戻す → 過去分が出る**（現状は落ちる）
- 表示できない種別（チャット終了・削除済み・ギフト受領告知）は引き続き落ちること
- 既読マークが、保存されたコメントにだけ付くこと

**注意**

- **`isCommentEnabled` を消さないこと。** 表示側（popup）で引き続き使う。
  移動するだけで、ロジックは変えない
- 既存テスト「フィルターで除外された種別は履歴に残らない」と
  「フィルターで除外された種別のアバターは取り込まない」は、
  **このフェーズで意図的に成立しなくなる。**
  削除ではなく「表示側で除外される」テストに**書き換える**こと

**実施記録（2026-09-07 完了）**

5つとも実装できた。地雷は踏んでいない（`'use strict'` を足していない、
`sourceType` は `script` のまま、`shared/` はガードで包まず `self` へ代入、
生の U+0000 も書いていない、実行時の依存はゼロのまま、`isCommentEnabled` も残っている、
フェーズ5以降には手を出していない）。
フェーズ3からの申し送り8点はどれも正確で、行番号も全部当たっていた。
判断が要った点と、節の指示だけでは決まらなかったことを残す。

1. **`isCommentEnabled` は「残す」だけだと死にコードになる。** 節の注意は
   「表示側（popup）で引き続き使う」と書いているが、**フェーズ2の時点で
   popup は既に `isCommentEnabled` を使っていない**（`filterKeyOf` に置き換わっていた）。
   Service Worker から外すと、`src/` 内の呼び出し元が0になる。
   フェーズ2 が #38 で「死にコードは人手で消すしかない」と苦労した直後に
   死にコードを1つ増やすのは筋が悪いので、**`isCommentEnabled` を
   `filterKeyOf` の上に定義し直して popup に使わせた**:

   ```js
   function isCommentEnabled(kind, role, filters) {
     return filters[filterKeyOf({ kind, role })] === true;
   }
   ```

   これで、フィルターの2軸を判定する分岐は `filterKeyOf` の1か所だけになる。
   （それまでは `isCommentEnabled` と `filterKeyOf` が同じ分岐を別々に書いていて、
   #18 の「合計と内訳で数え方が割れる」余地がそもそも構造として残っていた。）
   ロジックは変えていない — 唯一の違いは、キーが欠けた `filters` を渡したときに
   `undefined` ではなく `false` を返すことだけ。

2. **#18 の「どちらに揃えるか」は、第3の答えにした。**
   合計（絞り込み後）と内訳（全件）のどちらかに寄せる二択に見えるが、どちらも悪い。
   - 内訳を合計に合わせる（＝絞り込み後を数える）と、**切った枠のバッジが 0 になる。**
     バッジ自身がトグルなので、「そもそも無い」のか「隠しているだけ」なのかが
     利用者から見分けられなくなる。#4 の副作用として audit が批判していた
     「一般: 0 が嘘をつく」を、別の理由で復活させることになる
   - 合計を内訳に合わせる（＝全件を出す）と、検索しても合計が動かない

   採ったのは「**母集団を1つにし、そこから引く軸を役割・種別トグルだけにする**」形。
   `scoped`（ユーザー絞り込みと検索まで適用した集合）を作り、内訳はそれを数え、
   表示するコメントは `scoped` からトグルで引く。
   **表示中の枠ぶんの内訳を足すと、定義上かならず合計値に一致する**
   （`scoped` のうち有効なキーを持つ件数＝表示件数）。切った枠のバッジは
   本当の件数を出し続ける。完了条件の「内訳の合計が合計値と一致する」は
   この意味で満たしている。テストで不変条件として固定した。

3. **やること4（bucket を付けて保存）は、APIモードだけ形が違う。**
   DOMモードのメッセージは `kind` / `role` が正準形なので `bucketOf(msg)` をそのまま
   呼べるが、**APIモードは生の API item のまま保存する**ので、`bucketOf(item)` は
   `kind` も `role` も読めず全部 `bulk` になる（配信者のコメントもスパチャも）。
   `bucketOf({ kind: apiCommentKind(item), role: apiCommentRole(item.authorDetails) })`
   と組み立ててから焼き付ける必要がある。**申し送りに「DOMモードは」と
   書いてあったので気付けたが、書かれていなければ静かに間違えていた。**

4. **アバターの上限（申し送り4）は、踏むことにした。ただし完全には守れていない。**
   全件取り込みで一般視聴者のアバターが上限500人を埋めるようになり、
   挿入順の古い方から捨てる作りのままだと配信者やモデレーターのアバターが
   真っ先に落ちる（決定3が保持枠を分けたのと同じ問題）。踏んだ理由は2つ。
   (a) 落ちたアバターは IndexedDB からも消えるので、**過去のコメントの
   アバターが表示されなくなる**（次の発言で戻るが、その間ずっと欠ける）。
   (b) 500人ぶんが常時入れ替わると、**入れ替わるたびに書き込みが走る** —
   流量が桁違いになるフェーズ4でそれを放置すると、フェーズ3で減らした書き込み量が
   別の口から戻ってくる。
   採った手当ては最小限で、**`bucket === 'primary'` の発言者だけ、発言のたびに
   マップの末尾へ入れ直す**（`delete` してから代入し直す）。追加分の通知（`delta`）は
   増やさないので、書き込みは増えない。
   **守れないケースが2つ残っている**（コードにも書いた）:
   1バッチの中だけで上限を超えるほど流れた場合と、Service Worker の復帰直後
   （保存済みアバターに枠の情報が無いので、次に発言するまで区別できない）。
   構造的に守るには**アバターの保存の形（`発言者名 -> URL`）に枠を持たせる**必要があり、
   これは popup・store・メッセージの3か所に波及する。**フェーズ5送り**にした。

5. **決定3の上限（申し送り6）は、実測して据え置きにした。** 実ブラウザでの計測は
   できないが、保存レコードの大きさはモックで測れる。日本語のコメント1件は
   JSON でおよそ **375 バイト**（`pk` / `videoId` / `seq` / `bucket` と `searchText` 込み）。
   - `primary` 20,000 件 ≒ 7 MiB、`bulk` 50,000 件 ≒ 18 MiB（動画1本 25 MiB）
   - 保持5本ぶん、両枠とも上限まで使った最悪ケースで **125 MiB**
   - 賑わった配信で毎分200件としても `bulk` が埋まるまで4時間

   `unlimitedStorage` があるので通るが、これ以上大きくすると「もう見ていない
   過去の配信」で数百MiBを占め始める。**据え置きが妥当**と判断して、
   根拠を `shared/store.js` のコメントに残した。
   IndexedDB の実際の占有量（構造化クローンのオーバーヘッド）は
   実ブラウザでしか出ないので、そこは持ち主の手元でお願いしたい。

6. **完了条件の「bulk を読まない既定状態」は、まだ存在しない。**
   節はフェーズ5前の確認として「`bulk` を読まない既定状態での確認」と書いているが、
   いまの `readCommentsForPopup()` は primary を先に確保したうえで
   **残り枠を bulk で埋める**（`MAX_COMMENTS_TO_POPUP` = 10,000 まで）。
   「起動時は primary だけ」にするのは決定4＝フェーズ5 の担当なので、この条件は
   フェーズ4では満たしようがない。
   実害の見立て: **既定の利用者にとっては新しい負荷ではない**
   （`DEFAULT_COMMENT_FILTERS` も popup の初期値も全部ONなので、既定では
   以前から全件が popup に載っていた）。重くなるのは「特別」プリセットを
   使っていた人だけで、その人たちも 10,000 件で頭打ちになる。
   **フェーズ5 を早めに回したほうがよい、という以上のことはしていない。**

7. **移設したテストは、節が挙げる2件＋申し送りの4件で合っていた。**
   `describe('スーパーチャットとメンバーシップ')` は名前ごと
   `describe('種別とフィルターの読み取り')` に変え、フィルターの2軸を確かめる4件は
   新しい `test/popup-filters.test.js` へ移した。移設先では
   **`renderComments()` を実際に走らせ、出来上がった HTML の
   `data-username` を拾って「画面に出ている発言者」を見ている**
   （「絞り込みの結果が描画まで届いているか」まで確かめたいため）。
   偽 document は描画を通せるところまで届いていて、ハーネスの変更は要らなかった。

8. **APIモードの取り込み（やること3）にはハーネスの変更が要る。**
   `fetchLiveChatMessages` は露出しておらず、コンテキストの `fetch` は
   「ネットワークは使えない」を投げる作りだった。`__sw.fetchLiveChatMessages` と
   `__sw.setFetch(fn)` を足した。**やること3 はこれが無いとテストで固定できない**
   （DOMモードだけ直してAPIモードを直し忘れる、というのが根本原因Eの典型なので、
   両方をテストで押さえておきたかった）。

9. **`fetchLiveChatMessages` の戻り値から `commentFilters` を落とした。**
   フィルターを適用しなくなったので、返しても意味が無い（読んでいる場所も無かった）。
   `storage.local` から `commentFilters` を読む往復も1回減っている。

テストは 93 件 → **104 件**（DOMモードの取り込み3件・popup への受け渡し1件・
アバター2件・APIモードの取り込み2件・表示側のフィルター8件を追加、
Service Worker 側でフィルターを確かめていた5件を popup 側へ移設）。

**詰まった箇所**: 上の1（`isCommentEnabled` が既に浮いていた）と
3（APIモードの bucket）の2つ。どちらも申し送りと実際のコードを突き合わせて
気付いたもので、節だけを読んで進めていたら静かに間違えていた。
**資料に書いてほしかったこと**は2で挙げた #18 の三択の存在
（「どちらに揃えるか」の二択に見えるが、どちらも別の嘘を生む）。

**フェーズ5への申し送り**

- **行番号**（フェーズ4後の実測）
  - `popup.js`: `setComments` 1274 / `addNewComments` 1281 / `isAtBottom` 1336 /
    `safeAvatarUrl` 1354 / `avatarHtml` 1359 / `safeStickerUrl` 1372 /
    **`renderComments` 1478** / 母集団 `scoped` 1496 / 集計 1509 / 絞り込み 1514 /
    バッジ描画 1529-1538 / **`innerHTML` の全置換 1555** / 行ごとのリスナー 1582-1613 /
    `updateEmptyStateMessage` 2116。無条件の `console.log` は **97箇所**（#34）
  - `service-worker.js`: `collectAvatars` 247 / `appendComments` 420 /
    `handleDomChatMessages` 1285 / **`readCommentsForPopup` 1516**
  - `shared/store.js`: `LIMITS` 48 / `MAX_COMMENTS_TO_POPUP` 57 /
    `MAX_AVATARS_PER_VIDEO` 61 / `readInternal`（範囲読みの本体）207
  - `shared/comment.js`: `filterKeyOf` 57 / `isCommentEnabled` 72 / `bucketOf` 81 /
    `isDisplayableKind` 97
- **決定4 の受け皿はもう揃っている。** `store.read(videoId, { bucket, limit, before })` が
  枠を指定した範囲読みをそのまま持っている（`before` は排他なので
  「これより古いぶんをもう1ページ」の形で使える）。popup は既に
  `popup.html` から `shared/store.js` を読んでいるので、IndexedDB を直接引ける。
- **`renderComments` の母集団は1つに畳んである**（上の2）。ウィンドウ描画や
  差分追加を入れるときも、`scoped` → 内訳 → 表示、の順序は崩さないこと。
  崩すと #18 が戻る。テストは `test/popup-filters.test.js` の
  「表示中の枠の内訳を足すと、合計値に一致する」が不変条件として押さえている。
- **アバターの保持枠はフェーズ5 の宿題**（上の4）。`発言者名 -> URL` という
  保存の形に枠を持たせるには、`shared/store.js` の `avatars` ストア、
  `collectAvatars` / `saveAvatars`、`newSpecialComments` の `avatars`、
  popup の受け取りの4か所が動く。**popup がアバターをどう引くかを決めるついでに
  やるのがいちばん安い。**
- **popup の描画テストは `renderComments()` を実際に走らせる形で書ける。**
  偽 document はそこまで届いている（ハーネスの変更は不要だった）。
  `createElement` の呼び出し回数は `document.calls.createElement` に、
  `innerHTML` への代入履歴は要素の `writes.innerHTML` に貯まるので、
  「新着1件で既存行が作り直されないこと」はそのまま数えられる。

---

### フェーズ5 — popup の読み方と描画

**目的**: 決定4。根本原因D を潰す。

**やること**

1. **読み方を変える**（決定4）。起動時は `primary` のみ。
   `bulk` はトグルONまたは検索時に IndexedDB から引く
2. **`innerHTML` の文字列組み立てをやめる**（#22 #25 #26）。
   `document.createElement` + `textContent` + `setAttribute` で組む。
   **これで属性エスケープの問題が種類ごと消える**
3. **差分追加**。新着は新しい行だけ `DocumentFragment` にまとめて1回 `appendChild`
4. **フィルター・検索の切替は作り直さない**。既存行の `hidden` を切り替える
5. **イベント委譲**。`commentsList` に1つだけリスナーを張る（いまは行ごとに3種類）
6. **レイアウト読み取りを1回に**（#22）。いま `1721` / `1733` / `1734` で3回
7. **#11 0件時に `innerHTML` を空にする**
8. **#26 `safeAvatarUrl` にホスト許可リストを足す**。`safeStickerUrl` (`popup:1480`) と同じ形に
9. **#34 ログ整理**。96箇所の無条件 `console.log` を `debugLog` に通す。
   `debugError` はフェーズ0 で無条件になっている

**完了条件**

- 数千件たまった状態で、新着が来てもスクロールが引っかからない
- 検索の1文字目でフリーズしない（#23 はフェーズ2で解消済み。ここで実測確認）
- 発言者名に `"` や `<img src=x>` を含むコメントで、レイアウトが壊れない
- 既存57件（フェーズ1で7件増えた） + 新規が通る

**テスト**

- **偽 `document`（フェーズ1で用意）で行を組み立て、
  表示名に `"` / `'` / `<img src=x>` を入れても属性が壊れないこと** ← #25 の再発防止
- **新着1件で既存行が作り直されないこと**（`createElement` の呼び出し回数を数える）
- フィルター切替で行が作り直されず `hidden` だけが変わること
- 0件の絞り込み後、リストが空になっていること（#11）

**注意**

- **見た目は変えない。** このフェーズは描画の**方式**だけを変える。
  CSS のクラス名と DOM 構造は維持すること（`popup.css:1005-1015` が
  `:has()` で DOM 構造に依存している）
- `content-visibility` (`popup.css:990-998`) はそのまま残す。効果は限定的（#22）だが害は無い

**実施記録（2026-09-07 完了）**

9つとも実装できた。地雷は踏んでいない（`'use strict'` を足していない、`sourceType` は
`script` のまま、`shared/` はガードで包まず `self` へ代入、生の U+0000 も書いていない、
実行時の依存はゼロのまま、CSS のクラス名と DOM 構造は維持、`content-visibility` も残した、
フェーズ6以降には手を出していない）。
フェーズ4からの申し送り7点はどれも正確で、行番号も全部当たっていた。
判断が要った点と、節の指示だけでは決まらなかったことを残す。

1. **このフェーズで一番大きい判断は「バッジが何を数えるか」だった。**
   申し送りが名指ししていたとおり、決定4 で bulk をメモリに載せなくなると
   「メンバー」「一般」の件数はメモリから出せない。`store.count()` が持っているのは
   **枠ごとの合計だけ**で、bulk の中を「メンバー」と「一般」に割ることはできない。
   採ったのは「**数えられないものは数字を出さない**」形:

   - 役割・種別の6キーと保持枠は**きれいに対応している**（`filterKeyOf` が
     `owner`/`moderator`/`superchat`/`membership` を返すコメントは必ず `primary`、
     `sponsor`/`normal` は必ず `bulk`）。だから primary さえ載っていれば、
     残り4つのバッジは常に正確に数えられる
   - `sponsor` / `normal` は、未読み込みの bulk がある間だけ `?` を出し、
     title に「未読み込み◯件。クリックで読み込んで表示する」と書く。
     バッジ自身がトグルなので、押せば読み込まれて数字になる
   - 保存された bulk が0件なら最初から `0` と出す（嘘にならない）

   `0` と出すのは論外（#18 が批判していた「一般: 0 が嘘をつく」の再来）で、
   逆に「正確に出すために毎回 bulk を全部読む」と決定4 が無意味になる。
   **表示できない数を `?` にするのは、この2つの間の唯一の正直な答え**だと判断した。
   保持枠と表示キーが1対1で対応していることに気付くまで遠回りしたので、
   ここは節に書いておいてよかった点として残す。

2. **決定4 の効きは「特別プリセットの利用者」に限られる。** `DEFAULT_COMMENT_FILTERS` も
   popup の初期値も全部ONなので、**既定の利用者は起動直後に bulk のトグルがONで、
   結局その場で読み込む**。遅延読み込みが効くのは「特別」プリセットの人だけ
   （＝フェーズ4の実施記録6が「重くなる」と名指ししていた人たち）。
   節の完了条件「数千件たまった状態で新着が来てもスクロールが引っかからない」は
   遅延読み込みではなく**差分追加のほう**で満たしている。
   **決定4 の効能書きは「全員が軽くなる」ではなく「特別プリセットの人が軽くなる」**
   と書いたほうが正確だった。

3. **`renderComments` が同期のままか非同期になるかは、体感に直結する。**
   トグルや検索の入口は `renderWithBulk()`（async）に変えたが、
   これを素直に書くと**読むものが無いときでも描画が1マイクロタスク遅れる**。
   async 関数は最初の `await` まで同期で走るので、
   `if (this.shouldLoadBulk()) await this.ensureBulkLoaded();` と**先に分岐を置く**と、
   読み込みが要らない場合は完全に同期のまま描ける。テストも同期のまま書ける
   （逆に言うと、この分岐が無いと既存テストが全部 async 化を強いられる）。

4. **`seq` を正準形の外側で持ち越す必要があった。** あとから読んだ bulk を
   既存の並びへ差し込むには、保存時の通し番号 `seq` が要る。ところが
   `formatComment` は `normalizeComment` の結果を返すので、**`seq` は正準形に
   無いぶん黙って落ちていた**（全部が同順位になり、bulk がまとめて末尾に並ぶ）。
   `formatComment` で `seq: comment.seq` を持ち越し、
   持たないもの（popup を開いている間に届いた新着）は `Infinity` 扱いで末尾に置いている。
   **正準形に無いが表示に要る値**は `avatarUrl`（フェーズ2の記録2）に続いて2つ目。

5. **`hidden` で隠すと、CSS の `:last-child` が効かなくなる。**
   `.comment-item:last-child { border-bottom: none; }` は「最後の要素」を指すので、
   末尾の行が隠れていると**区切り線が1本余る**。CSS には「最後の見えている兄弟」を
   指す書き方が無い（`:has()` と一般兄弟結合子で書けるが、行数に比例して
   再評価が走るので性能を直すフェーズで使う道具ではない）。
   `syncRowVisibility` が `comment-item--last` を付け外しし、CSS に1行足して解いた。
   **「見た目を変えない」を守るには、こういう CSS 側の追従が要る。**

6. **#11 は「innerHTML を空にする」ではなく「早期 return をやめる」で解いた。**
   新方式では行が残っているのは**意図どおり**（それが差分追加の前提）なので、
   節の字面どおりに0件で空にすると、フィルターを戻すたびに全件を作り直すことになる。
   #11 の実害は2つあって、(a) 母集団から消えたコメントのDOMが残り続けることと、
   (b) 0件の経路だけスクロール状態の再同期に到達しないこと。
   (a) は `setComments` / `trimCommentsToLimit` が行を必ず取り除く形にして、
   (b) は早期 return を無くして解決した。**「最大1万ノード残る」は消えている**
   （残るのは、メモリに載っているコメントのぶんだけ）。

7. **アバターの保持枠（申し送り3）はやらなかった。フェーズ6 送りにする。**
   申し送りは「popup がアバターをどう引くかを決めるついでにやるのがいちばん安い」と
   見立てていたが、**実際には安くならなかった**。今回 popup が直接 IndexedDB を読むのは
   コメントの bulk 枠だけで、**アバターの受け取り方は1行も変えていない**
   （Service Worker がマップを持ち、差分を `newSpecialComments` に載せる形のまま）。
   ついでにできる場所がそもそも生まれていない。
   一方フェーズ6 は `monitoringState` を丸ごと単一の `session` に畳む回で、
   `avatarsByAuthor` の置き場そのものが動く（#10 が既にフェーズ6 の担当に入っている）。
   **枠を持たせるならそこでやるのが本当に安い。** 残っている問題は変わらず
   「1バッチ内で上限を超えた場合と Service Worker の復帰直後は、配信者や
   モデレーターのアバターが一般視聴者に押し出される」。

8. **ログの差し替えは97箇所すべて機械的にできた**（`console.log` → `debugLog`、
   `console.warn` → `debugWarn`、`console.error` → `debugError`）。
   `debugLog` などの定義本体だけ除外すればよい。あわせて `debugError` の
   `eslint-disable` も外した（申し送り5）。**`renderComments` の中の11個は
   差し替えではなく削除した** — 新着のたびに走る場所なので、
   `debugMode` がONのときだけとはいえ残す意味が薄い。

9. **ハーネスに足したもの**（描画テストの土台）。フェーズ4の申し送り4は
   「ハーネスの変更は要らなかった」と書いていたが、それは
   `innerHTML` の文字列を正規表現で読んでいたから。**要素で組むように変えると、
   偽DOMに足りないものが一気に出る**:
   - `createDocumentFragment`（と、`appendChild` が fragment の中身だけを移すこと）
   - `closest` を「対応表 → 自分から親へ」の順にたどる形へ（イベント委譲が使う）
   - `replaceWith`（アバターの読み込み失敗）
   - `scrollTop` / `scrollHeight` / `clientHeight` / `hidden` の数値の既定値
   - `requestAnimationFrame`（`updateUserFilterStatus` が呼ぶ。setTimeout と同じ「積むだけ」）
   - `loadPopup({ maxCommentsToPopup })`（10,000件を積まずに切り詰めを見るため。
     `shared-store.test.js` が `LIMITS` を書き換えているのと同じ流儀）
   出来上がった DOM を読む道具（`readCommentRows` / `visibleUsernames` / `findByClass`）も
   ハーネス側に置いた。`popup-filters.test.js` の `visibleNames` はこれを呼ぶだけになっている。

10. **完了条件のうち実ブラウザでの確認は未実施。** 「数千件たまった状態で新着が来ても
    スクロールが引っかからない」「検索の1文字目でフリーズしない」は実測なので
    モックでは代替できない。代わりに「新着1件で既存行が作り直されないこと」
    「描画のたびに innerHTML を書き直さないこと」「寸法の読み取りが1回に収まること」を
    テストで固定した。**実ブラウザでの体感確認は持ち主の手元でお願いしたい。**
    「発言者名に `"` や `<img src=x>` を含むコメントでレイアウトが壊れない」は
    テストで確認済み（属性に差し込む経路そのものが無くなった）。

11. **「行に焼き付けた値」は2つある。** 行を作り直さなくなると、
    作成時に文字列にして埋めた値は、あとから設定を変えても追従しない。
    実際に踏んだのは**時刻表記**（`applyTimeSettings` が 12/24時間と秒の有無を切り替える）で、
    ここだけは `rebuildCommentRows()` を通す必要がある。もう1つは**アバターのURL**だが、
    これは以前から `formatComment` の時点で焼き付けていたので挙動は変わらない。
    **新しく行に値を埋めるときは「その値は後から変わるか」を必ず確かめること。**

12. **`loadCommentFilters()` を `Promise.all` から出した。** フィルターの状態は
    「bulk を読むかどうか」を決めるので、履歴の復元と**並列**に走らせると、
    順番次第で「特別」プリセットの人にも bulk を読み込んでしまう
    （`this.commentFilters` の初期値が全部ONなので）。決定4 が効いてほしい
    相手にだけ効かない、といういちばん惜しい壊れ方をする。
    `loadTimeSettings()` と同じく、描画より先に確定させる形にした。

テストは 104 件 → **127 件**（描画17件・bulk の遅延読み込み7件を追加、
`escapeAttr` の1件を削除）。新しいテストは `test/popup-render.test.js`。

**詰まった箇所**: 上の1（バッジが何を数えるか）と4（`seq` が落ちる）の2つ。
1 は申し送りが「意識して設計してください」と予告してくれていたので身構えられたが、
**保持枠と表示キーが1対1で対応している**という事実（＝primary だけでも4つのバッジは
正確に出せる）に気付くまでが長かった。4 はテストが赤くなって初めて分かったもので、
**「正準形に無い値は formatComment を通ると消える」という性質**が
どこにも書かれていない。フェーズ2の記録2（`avatarUrl` を足した話）と同じ罠。

**資料に書いてほしかったこと**: 決定4 の効きが「特別プリセットの利用者」に
限られること（上の2）。既定が全部ONだという事実と突き合わせないと出てこないので、
決定4 の本文に一言あると、期待値の置き方を間違えずに済む。

**フェーズ6への申し送り**（6a・6b の両方が読むこと）

- **行番号**（フェーズ5後の実測）
  - `popup.js`（全2,545行）: `debugError` 61 / 共有モジュールの取り込み 73-82 /
    `MAX_COMMENTS_IN_MEMORY` 93 / `store` 100 / `BULK_FILTER_KEYS` 104 /
    `AVATAR_IMAGE_HOSTS` 131 / イベント委譲の受け口 795・811 /
    `setComments` 1351 / `addNewComments` 1360 / `trimCommentsToLimit` 1385 /
    `formatComment` 1405 / `safeImageUrl` 1448 / `createNode` 1471 /
    `createCommentRow` 1605 / **`needsBulk` 1664 / `shouldLoadBulk` 1672 /
    `loadBulkCount` 1680 / `ensureBulkLoaded` 1696 / `mergeBulkComments` 1721 /
    `renderWithBulk` 1736** / `rebuildCommentRows` 1751 / `appendCommentRows` 1761 /
    **`renderComments` 1776** / `updateCountBadges` 1831 / `syncRowVisibility` 1861 /
    `syncScrollPosition` 1888 / `updateEmptyStateMessage` 2403。
    無条件の `console` は**0箇所**（`window.open` の URL 文字列を除く）
  - `service-worker.js`: `collectAvatars` 247 / `saveAvatars` 314 /
    `handleDomChatMessages` 1285 / `readCommentsForPopup` 1520 / `getCommentsHistory` 1532
  - `popup.css`: `content-visibility` 990 / `comment-item--last` 1005 / `:has()` の役割色 1009-1012
  - `shared/store.js` と `shared/comment.js` は行番号が変わっていない
    （`escapeAttr` を消したぶん `comment.js` は 388 → 376 行）
- **`popup.js` の `renderComments` は、もう描かない。** 数える・`hidden` を切り替える・
  スクロール位置を直すだけ。行を作るのは `setComments`（作り直し）と
  `addNewComments`（差分追加）の2経路だけなので、**新しく行を増やす経路を足すときは
  必ずこのどちらかを通すこと**。直接 `commentsList` に足すと `this.rows` と食い違い、
  二度と隠せない行ができる。
- **`this.rows` の並びは `this.comments` の並びと一致している必要がある。**
  bulk を差し込むときだけ順番が変わるので、そこは `setComments` で作り直している
  （`mergeBulkComments`）。ウィンドウ描画（最新N件だけ出して古い分はスクロールで
  足す）は**入れていない**。入れるなら `appendCommentRows` の手前に「どこまで作るか」を
  1つ挟む形になるはずで、`rows` と `comments` の対応をそこで崩さないこと。
- **popup が IndexedDB を開くようになった。** いまは同じ `DB_VERSION` を見ているので
  衝突しないが、**将来スキーマを上げるときは popup の接続が `onblocked` を引き起こす**
  （開いている接続があるとバージョン変更が止まる）。`store.js` の `openDatabase` は
  `onblocked` で reject するようになっている。ポート化（フェーズ6b）で popup の
  生存期間が Service Worker から見えるようになるので、そのとき手当てを考えるとよい。
- **アバターの保持枠はフェーズ6a の宿題**（上の7。フェーズ6a の「やること8」に入れた）。`monitoringState` を
  単一の `session` に畳む回（#10 が同じ場所を触る）で、`発言者名 -> URL` という
  保存の形に枠を持たせるのがいちばん安い。動くのは
  `shared/store.js` の `avatars` ストア・`collectAvatars`（`SW:247`）/
  `saveAvatars`（`SW:314`）・`newSpecialComments` の `avatars`・popup の
  `this.avatarsByAuthor` と `formatComment`（`popup:1405`）。
- **ポート化（フェーズ6b）は、この描画方式と相性がよい。**
  差分追加は「新着のバッチが順番どおりに1回ずつ届く」ことを前提にしている。
  いまの `chrome.runtime.sendMessage` は順序が保証されないので、
  ポートに変えると前提が本物になる。
- **`waitForServiceWorker` の8回 ping はまだ残っている**（`popup:` の初期化）。
  フェーズ6b で消える予定のもの。テストハーネスの `setTimeout` が「積むだけ」なのは
  これがあるからで、消えたらハーネスの但し書きも一緒に直せる。

---

### フェーズ6 — ライフサイクル

**目的**: 根本原因A を潰す。MV3 の現実に合わせる。

**6a と 6b に分ける**（2026-09-08 に決定）。当初は9項目を1フェーズにしていたが、
**軸が2つ入っていた** —「Service Worker が自分の状態をどう持つか」と
「Service Worker と popup がどう話すか」。前者だけで `service-worker.js` の
`monitoringState` 参照が112箇所、後者は popup の `sendMessageWithRetry` 呼び出し15箇所と
SW の `onMessage` 分岐21本に触る。1本にすると差分がレビューできる大きさを超える。

**順番は 6a → 6b で固定。** ポートのハンドラは単一の `session` を読み書きするので、
先に 6b をやると同じ場所を2度書き直すことになる。

| | 名前 | 対象 | 消える欠陥 |
| --- | --- | --- | --- |
| 6a | 状態の一本化 | `service-worker.js`, `manifest.json` | #5 #8 #10 #35 #36 #37 |
| 6b | ポート化 | `service-worker.js`, `popup.js` | #32 |

どちらも**単独でリリースできる**。6a だけでも
「APIモードで quota を踏んだあと放置して再開する」という実害が消える。

---

### フェーズ6a — ライフサイクル（状態の一本化）

**目的**: 根本原因A を潰す。「いま何を監視しているか」の正を1つにする。

**やること**

1. **セッション状態を1つに**（決定6）。`loadSession()` / `saveSession()` / `reconcile()`。
   突き合わせ分岐5本（根本原因A の一覧）を畳む
2. **`epoch` を導入**（#5）。`handleDomChatMessages` と `startPollingLoop` の
   非同期の続きが、自分の世代を確認してから状態に触る
3. **`chrome.alarms` の番人**（#37 #8）。1分周期。上の「番人」の表のとおり
4. **#36 `pageToken` を永続化**
5. **#8 catch の中を防御**。`error?.message ?? String(error)` にする
6. **#35 `tabs.onRemoved` を1本に**。「タブを閉じたら監視を止める」か
   「継続する」かを**決めてから**書く。現状は両方が登録されていて方針が矛盾している
7. **#10 API モードの状態に `avatarsByAuthor` を足す**（決定6 の単一状態に統合すれば自然に消える）
8. **アバターに保持枠を持たせる**（フェーズ4→5と2回持ち越した宿題）。
   全件取り込み（決定1）で一般視聴者のアバターだけで上限500人が埋まり、
   配信者やモデレーターのアバターが押し出される。緩和（primary の発言者は
   発言のたびにマップの末尾へ入れ直す）は入っているが、**1バッチの中だけで
   上限を超えた場合と Service Worker の復帰直後は守れない**。
   構造的に守るには保存の形（`発言者名 -> URL`）に枠を持たせる必要があり、
   動くのは `shared/store.js` の `avatars` ストア・`collectAvatars` / `saveAvatars`・
   `newSpecialComments` の `avatars`・popup の `this.avatarsByAuthor` と `formatComment` の4か所。
   **`avatarsByAuthor` の置き場そのものが動く 6a が、いちばん安い**（やること7と同じ場所）

**完了条件**

- Service Worker を手動で終了させても、DOMモードでコメントが続く（既存の挙動の維持）
- **APIモードで quota エラーを踏んだあと、放置しても取得が再開する**（#37 #8）
- 動画を切り替えても、切替中のコメントが失われない（#5）
- 一般コメントがいくら流れても、配信者・モデレーターのアバターが消えない
- 既存127件（フェーズ5終了時点） + 新規が通る

**テスト**

- **alarm 発火で、停止していたポーリングが再開すること**
- **epoch 違いの続きが状態に触らないこと**（#5）。
  バッチAが `await` 中にバッチBが入る状況を再現する
- `message` を持たない例外を投げても、次のタイマーが張られること（#8）
- `pageToken` が保存・復元されること（#36）
- **アバターの上限を超えても、primary 枠の発言者のアバターが1つも落ちないこと**
  （1バッチで超えた場合と、保存済みアバターから復帰した直後の両方）

**注意**

- **`chrome.alarms` 権限を manifest に足す**のを忘れないこと
- リリース済み拡張機能の alarm の最小周期は**1分**。それより短くはできない
- `onSuspend` (`SW:1478`) は MV3 では配送されない（#38）。番人に置き換えたら削除する
- **ポート化（6b）には手を出さない。** `sendMessage` のままで 6a を完結させる

**実施記録（2026-09-08 完了）**

8つとも実装できた。地雷は踏んでいない（`'use strict'` を足していない、`sourceType` は
`script` のまま、`shared/` はガードで包まず `self` へ代入、生の U+0000 も書いていない、
実行時の依存はゼロのまま、`alarms` 権限は manifest に足した、見た目は1ピクセルも
変えていない、フェーズ6b には手を出していない）。
フェーズ5からの申し送り8点はどれも正確で、行番号も全部当たっていた。
判断が要った点と、節の指示だけでは決まらなかったことを残す。

1. **「突き合わせ分岐5本」のうち、SW 側の4本は畳めた。5本目（popup:1175）は残した。**
   `getStaleSessionReason` / `startDomMonitoring` の再利用分岐 /
   `handleDomChatMessages` の動画変更検知 / `getMonitoringState` の `||` チェーンは、
   `reconcile(tabId, videoId)` が返す4語（`idle` / `same` / `changed` / `other`）に
   全部載った。残る `tryDomAutoStart` の `isStaleSession` は **popup のローカル状態**
   （`this.monitoringVideoId !== this.currentVideoId`）で判断していて、SW からは
   見えない。いま消すと「古いセッションを掴んだままの popup が開始し直せない」
   ので、消せるのは popup が SW に判断を委ねられるようになってから ——
   つまりポート化（6b）で SW が popup の生存と対象動画を知るときが本当に安い。
   **害は無い**（SW 側の reconcile が同じ結論を出すので、popup の判断は
   「もう一度 start を投げるかどうか」にしか効かない）が、5本目が残っていることは
   ここに明記しておく。

2. **`reconcile` に第4の語（`other`）が要った。** 節が挙げる4本を読むと
   「同じ／変わった」の2値で足りそうに見えるが、**送り主が別のタブ**という
   場合がある。manifest の自動注入で dom-chat.js は監視していないタブの
   live_chat にも乗るので、2値だと別配信のコメントがいま見ている配信の履歴に
   積まれる（実際、これまでは積まれていた。`handleDomChatMessages` の
   ガードは「DOMモードで監視中か」しか見ていない）。テストを1本足してある。
   ついでに `idle`（そもそも監視していない）も語にしたので、
   呼び出し側から `isMonitoring` の直接参照が消えた。

3. **「セッション状態をまるごと永続化する」は、そのままでは書けない。**
   決定6 は「`monitoringState` をまるごと永続化する（部分集合をやめる）」だが、
   `processedMessageIds` は `Set`、`pollingTimer` はタイマーIDで、
   どちらも `storage.local` に置けない（`Set` は構造化クローンできるが
   `storage.local` は JSON なので `{}` になる）。採ったのは
   **「永続化するキーの一覧（`PERSISTED_SESSION_KEYS`）を定数で持ち、
   `saveSession()` は毎回その全部を書く」**形。「部分集合を書かない」の実体は
   *保存する項目を毎回変えない* ことなので、これで趣旨は満たせる。
   runtime だけの持ち物（既読マーク・アバター・タイマー）は復帰時に作り直せる
   （前2つは IndexedDB から、タイマーは番人が張り直す）。
   **節に「永続化できない持ち物をどう扱うか」を一言書いておくと、ここで迷わない。**

4. **`commentFilters` を session から外した。** 決定1（フェーズ4）で
   Service Worker は取り込み時にフィルターを見なくなったので、
   `monitoringState.commentFilters` は**書かれるだけで誰も読まない**状態だった
   （`setCommentFilters` が代入し、`startXxxMonitoring` が引き継ぎ、
   判断には一度も使われない）。根本原因A を潰す回に「同じことの正が2か所」を
   残す理由が無いので消した。正は `storage.local` ただ1つで、読むのは popup。
   これは #38（死にコード）と同じ形の残骸で、`no-unused-vars` では拾えない
   （プロパティなので）。**フェーズ4 の時点で消せたはずのもの。**

5. **#35 は「タブを閉じたら止める」を採った。** 節は「決めてから書く」としか
   書いていないので、判断の根拠を残す。
   - DOMモードのコメントはそのタブの live_chat から届く。タブが無ければ
     以後1件も来ない。「継続」はバッジだけ ON で何も起きない状態を作る
     （根本原因F「壊れても見えない」の典型）
   - そもそも「継続」は成立していなかった。タブを失ったセッションは、
     次に Service Worker が復帰した時点で `staleSessionReason` の
     「タブ情報なし」で破棄される。つまり継続するのは SW が生きている間だけで、
     利用者から見て挙動が説明できない
   - APIモードだけは技術的に継続できるが、見ていない配信のために quota を
     使い続けることになる
   停止処理が履歴を flush するので、閉じる直前のコメントは失われない。

6. **番人の DOM 側は「最後に保存した時刻」をどこから取るかが問題になった。**
   素直にメモリへ `lastCommentAt` を持つと、**Service Worker が終了するたびに
   リセットされる**（番人に起こされた直後は必ず「たったいま始まった」ことになり、
   沈黙を一生検知できない）。番人を作る目的が SW の終了に耐えることなのに、
   判断材料が SW と一緒に消えるのでは意味が無い。
   IndexedDB の `meta.updatedAt` が append のたびに更新されているので、
   `store.listVideos()` から引くことにした（1分に1回の読み出しなので安い）。
   **「SW が死んでも残る場所にあるか」は、番人が見る値すべてに問うこと。**
   あわせて、静かな配信で毎分注入し直さないよう立て直しの間隔（3分）も入れた。

7. **ポーリングの二重起動を止めるには、`epoch` だけでは足りない。**
   #5 の後半（「実行中の fetch は止められず、その `.then` がタイマーを張り直す」）は
   epoch で止まるが、**番人が「タイマーが無いから再開」と判断する側**が新しく
   増える。復元直後は `startPollingLoop()` を呼んだ直後でもまだタイマーが
   張られていない（fetch の応答待ち）ので、そこへ番人が来ると2本目が走る。
   `pollingInFlight`（fetch が飛んでいる最中）と `pollingTimer` の
   **どちらかが立っていれば生きている**、という判定（`isPollingAlive()`）にして解いた。

8. **DOMモードのバッチは、入口で1本の鎖に並べた。** #5 の表題は
   「直列化されておらず」なので、epoch の確認だけでは半分しか直らない
   （世代が変わったと分かっても、そのバッチのコメントはもう既読マークだけ
   付いて捨てられる）。`enqueueDomChatMessages` が
   `onMessage` の口で `Promise` の鎖に並べ、バッチAが `startDomMonitoring` の
   中にいる間にバッチBが割り込めないようにした。そのうえで epoch は残してある
   （鎖に乗らない経路 —— 番人・タブ削除・popup からの停止 —— があるため）。
   テストは**本物の `onMessage` の口から2バッチを待たずに流す**形で書いた。

9. **アバターの保持枠は `DB_VERSION` を上げずに済んだ。** 申し送り8 が
   「上げると popup の接続が `onblocked` を引き起こす」と警告していた点。
   `avatars` のレコードに `bucket` フィールドを足すだけで、インデックスは
   要らない（間引きは SW のメモリ上のマップで完結し、IndexedDB 側は
   put / delete しかしない）。**スキーマ変更はゼロ。**
   枠を持たない古いレコードは読むときに `bulk` として補う。
   上限は `MAX_AVATARS_PER_VIDEO = 500` を
   `AVATAR_LIMITS = { primary: 200, bulk: 500 }` に置き換えた。
   **bulk を 500 のまま据え置いて primary を上に足した**のは、
   既存の利用者から見て一般視聴者のアバターが減らないようにするため
   （500 を分け合う形にすると、いま出ているアバターが消える人が出る）。

10. **アバターの「差分」は2つに分かれた。** 枠を持たせると、
    **URLは同じだが枠が変わった**（一般だった人がスパチャを投げた）場合が
    出てくる。保存には要るが popup には要らない（popup は枠を見ない）ので、
    `collectAvatars` は `persist`（保存する差分）と `notify`（popup へ送る差分）を
    別々に返す。**popup へ渡す形（`発言者名 -> URL`）は1バイトも変えていない。**
    フェーズ5の申し送りは「popup の `this.avatarsByAuthor` と `formatComment` も
    動く」と見ていたが、枠は*保持*のための持ち物で、保持をするのは
    SW と store だけなので、境界で `avatarUrlsOf()` を1回通せば popup は無傷だった。
    メッセージも太らない。

11. **枠は上げるだけで下げない。** 一度スパチャを投げた人のアバターを、
    その後の通常コメントで `bulk` に落とすと、**過去のスパチャの行のアバターが
    一般の流量で消える**。`collectAvatars` は `primary` への昇格だけを行う。

12. **完了条件のうち実ブラウザでの確認は未実施。**
    「Service Worker を手動で終了させても DOMモードでコメントが続く」
    「APIモードで quota エラーを踏んだあと放置しても取得が再開する」は
    実ブラウザでしか確かめられない。代わりに
    「alarm の発火で止まっていたポーリングが再開する」
    「`message` を持たない例外でも次のタイマーが張られる」
    「動いているポーリングを番人が二重に起こさない」をテストで固定した。
    **実ブラウザでの確認は持ち主の手元でお願いしたい**
    （`chrome://extensions` の Service Worker を Terminate してから、
    1分以内にコメントが再開すること）。
    残り3つ（動画切替でコメントが失われない・一般の流量で配信者のアバターが
    消えない・既存テストが通る）はテストで確認済み。

テストは 127 件 → **147 件**（状態の一本化4件・epoch 2件・番人5件・
エラー処理2件・pageToken 1件・APIモードの持ち物1件・タブ削除3件・アバター2件を追加。
既存の12件は `currentVideoId` → `videoId` の改名に追随させたが、
確かめている内容は変えていない）。

**詰まった箇所**: 上の3（永続化できない持ち物）と6（番人が見る値の置き場）の2つ。
どちらも「節のとおりに書くと、目的を果たさないものが出来上がる」形だったので、
手が止まったというより**一度書いてから気付いて書き直した**。
**資料に書いてほしかったこと**は2つ。
(a) 決定6 の「まるごと永続化」に、`Set` とタイマーIDは保存できないという但し書き。
(b) 番人の表（API / DOM）に「判断材料も SW の終了に耐えること」の一言。
表は「何をするか」だけを書いていて、**何を見て決めるか**が書かれていない。
**どちらもこのフェーズで、決定6 と「番人」の節の本文に書き足した**
（実施記録ではなく指針側に置かないと、次に読む人は同じところで手を止める）。

**フェーズ6b への申し送り**

- **行番号**（フェーズ6a 後の実測）
  - `service-worker.js`（全1,817行）: `emptySession` 240 / `session` の宣言 260 /
    **`beginSession` 264 / `saveSession` 271 / `loadSession` 279 / `reconcile` 308** /
    `carryOverFor` 318 / `collectAvatars` 349 / `evictAvatars` 377 /
    `avatarUrlsOf` 397 / `saveAvatars` 428 / `staleSessionReason` 590 /
    `discardSession` 612 / `restoreStateFromStorage` 620 /
    `onMessage` の分岐 849-1019（**21本**） / `startBackgroundMonitoring` 1087 /
    `stopBackgroundMonitoring` 1127 / `getMonitoringState` 1151 /
    `stopPolling` 1176 / `isPollingAlive` 1184 / `scheduleNextPoll` 1188 /
    `startPollingLoop` 1196 / `onPollSuccess` 1221 / `onPollError` 1289 /
    `injectDomChat` 1323 / `requestInitialSweep` 1339 / `startDomMonitoring` 1344 /
    **`enqueueDomChatMessages` 1393 / `handleDomChatMessages` 1400** /
    `handleTabRemoved` 1514 / 番人の定数 1527-1537 / `startWatchdog` 1539 /
    `runWatchdog` 1574 / `readCommentsForPopup` 1749 / `getCommentsHistory` 1761
  - `popup.js`（全2,551行・フェーズ6a では1行も触っていない）:
    `waitForServiceWorker` 326（**8回 ping。6b で消える**）/
    `onMessage` の受け口 829 / `tryDomAutoStart` の `isStaleSession` **1175**
    （上の1。畳むならここ）/ `sendMessageWithRetry` の呼び出しは**15箇所**
  - `shared/store.js`（全571行）: `LIMITS` 48 / `MAX_COMMENTS_TO_POPUP` 57 /
    **`AVATAR_LIMITS` 68** / `readInternal` 207 / `putAvatarsInternal` 404 /
    `readAvatarsInternal` 424
  - `shared/comment.js` は行番号が変わっていない（`filterKeyOf` 57 /
    `isCommentEnabled` 72 / `bucketOf` 81 / `isDisplayableKind` 97）
- **ポートのハンドラは `session` を読み書きする。** 6a で入口が
  `beginSession` / `saveSession` / `reconcile` の3つに絞れているので、
  ポート化で足すのは「`onConnect` で popup を覚える」「`onDisconnect` で忘れる」
  だけにできるはず。**`session` に `port` を持たせないこと** ——
  永続化できないうえ、popup の生存はセッションの持ち物ではない
  （別の変数に置き、`PERSISTED_SESSION_KEYS` を増やさない）。
- **新着の通知は2か所ある。** `onPollSuccess`（APIモード）と
  `handleDomChatMessages`（DOMモード）が、それぞれ
  `chrome.runtime.sendMessage` と `chrome.tabs.sendMessage` を撃っている。
  ポート化するのは popup 向け（前者）だけで、**content script 向けは
  `tabs.sendMessage` のまま残す**（content script は `chrome.runtime.connect`
  の相手ではない）。
- **DOMモードのバッチは既に直列化されている**（上の8）。ポート化で
  「送信順が保たれる」ようになっても、`enqueueDomChatMessages` の鎖は外さないこと。
  順序を保証するのはポート（SW→popup）で、鎖が守っているのは
  content script→SW の側。**別の区間の話**。
- **`waitForServiceWorker` を消したら、popup ハーネスの但し書きも直すこと**
  （`test/helpers/popup-harness.js` の `setTimeout` が「積むだけ」なのは
  初期化の ping 8回のため、と書いてある）。
- **`chrome.alarms` のモックはハーネスに入れた。**
  `chrome.__fireAlarm()` で1回発火、`calls.alarms` に create / clear が残る。
  `chrome.__closeTab(tabId)` と `chrome.__onTabRemoved`（登録されたリスナーの配列。
  **2本目が足されたら気付ける**）も足してある。
- **`sw.session` と `sw.monitoringState` は同じものを指す**（ハーネスの getter）。
  旧名を残したのは既存テストのためで、新しく書くテストは `sw.session` を使うこと。
  世代ごと作り直したいときは `sw.beginSession(patch)`、
  世代を変えずに差し替えたいときは `sw.setState(patch)`。
- **popup が IndexedDB を開いている件は、まだ手当てしていない。**
  6a ではスキーマを変えずに済んだので `onblocked` に触れずに済んだだけで、
  次にスキーマを上げる回には残っている問題。ポート化で popup の生存期間が
  SW から見えるようになるので、そのとき考えるのが安い（フェーズ5からの申し送りのまま）。

---

### フェーズ6b — ライフサイクル（ポート化）

**目的**: SW と popup の通信を `chrome.runtime.connect` に変え、
「届いたかどうか分からない」前提で足された retry を消す。

**前提**: 6a が終わっていること（ポートのハンドラは単一の `session` を読み書きする）。

**やること**

1. **ポート化**。`chrome.runtime.connect`。得られるものは「目指す設計」の節のとおり
   （SW が popup の生存を知れる・送信順が保たれる・「Receiving end does not exist」の
   握りつぶしが要らない・popup が開いている間 SW が生きる）
2. **`waitForServiceWorker` の8回 ping と、重複した retry ヘルパー3つを削除**
3. **#32 リスナーの二重登録を防ぐ**
4. **popup ハーネスに `chrome.runtime.connect` のモックを足す**

**完了条件**

- popup を開いた瞬間からコメントが届く（ping の待ちが無くなる）
- 新着のバッチが送った順に届く（差分描画の前提が本物になる）
- 既存 + 新規のテストが通る

**テスト**

- ポートが切れたら SW 側が「popup は閉じている」と分かること
- 再接続で取りこぼしが出ないこと

**注意**

- **差分追加（フェーズ5）は「新着のバッチが順番どおりに1回ずつ届く」ことを前提にしている。**
  ポート化はその前提を本物にする変更なので、順序の保証を崩さないこと
- `waitForServiceWorker` が消えたら、popup ハーネスの `setTimeout` が
  「積むだけ」である理由（初期化の ping 8回で十数秒かかる）も消える。
  ハーネスの但し書きを現状に合わせて直すこと
- **popup が IndexedDB を開くようになっている**（フェーズ5）。将来スキーマを上げるとき、
  popup の接続が `onblocked` を引き起こす。ポート化で popup の生存期間が
  SW から見えるようになるので、手当てを考えるならこのフェーズが安い

**実施記録（2026-09-08 完了）**

4つとも実装できた。地雷は踏んでいない（`'use strict'` を足していない、
`sourceType` は `script` のまま、`shared/` はガードで包まず `self` へ代入、
生の U+0000 も書いていない、実行時の依存はゼロのまま、見た目は1ピクセルも
変えていない、`enqueueDomChatMessages` の鎖は外していない、
content script の通信には触っていない、フェーズ7以降には手を出していない）。
フェーズ6a からの申し送り8点はどれも正確で、行番号も全部当たっていた。
判断が要った点と、節の指示だけでは決まらなかったことを残す。

1. **`onMessage` の21分岐は、ポートと共用にした**（`reconcileSession` を足して22本）。 ポート化の素直な書き方は
   「popup 用のハンドラをもう1組書く」だが、それだと同じ `action` の処理が
   2か所になる —— 根本原因A（同じことの正が複数ある）を潰す最中に、
   通信の側で同じ形を作ることになる。採ったのは
   **`handleRequest(request, sender)` が応答の `Promise` を返し、
   ポートと `onMessage` はそれを配るだけ**という形。
   `sendResponse` の呼び分け（`.then(sendResponse).catch(...)` が
   分岐ごとに書かれていた）も `dispatchRequest` 1か所に寄ったので、
   分岐の中身は「何を返すか」だけになった。差分は増えたが、
   **足したのは口であって処理ではない**。

2. **ポートには「応答」という概念が無い。** ここが `sendMessage` からの
   いちばん大きな段差で、節の「送信順が保たれる」だけを読むと見落とす。
   `port.postMessage` はただ流すだけなので、要求ごとに `requestId` を振って
   `{ requestId, payload }` で送り、応答に同じ ID を載せて返す形を自分で作った。
   届いた順で対応づけると、処理時間の違う要求（`getCommentsHistory` と
   `getApiKey` を並べたときなど）で入れ替わる。テストを1本足してある。
   **指針側の節に書き足した。**

3. **知らない `action` にも応答を返す必要がある。** `sendMessage` は
   応答が無ければチャネルが閉じて呼び出し側の待ちが解けるが、ポートでは
   待ち行列に入ったまま永久に解けない。拡張機能を更新して popup と SW の
   版がずれた瞬間に、popup が無言で固まる形になる。
   `handleRequest` が `undefined` を返したら空の応答を返す、とした。
   **これも指針側に書き足した。**

4. **「retry ヘルパー3つ」のうち、消えたのは2つ。** 節は3つと書いているが、
   popup にあるもう1本（`sendTabMessageWithRetry`）は **popup → content script** の
   区間で、ポートの相手ではない（`sendTabMessageWithTimeout` も同じ）。
   3本目は content script の `sendMessageWithRetry`（`cs:568`、9箇所から呼ばれる）で、
   これも区間が別。**このフェーズで消えたのは popup → SW の
   `waitForServiceWorker` / `sendMessageWithTimeout` / `sendMessageWithRetry` の3つ**
   （数としては3つだが、節が数えていたものとは中身が違う）。
   残る2本は content script をどうするかの話で、フェーズ7以降。

5. **突き合わせ分岐の5本目は畳めた**（6a の申し送り4）。
   popup の `isStaleSession` は、SW に `reconcileSession` を聞いて
   `same` 以外なら開始し直す、という形になった。
   これで popup 側から「監視中の動画IDの控え」（`monitoringVideoId`）が消え、
   **突き合わせの正は `reconcile` ただ1つ**になった。
   ついでに、以前は拾えていなかった「**別のタブ**の配信を掴んでいる」も拾える
   （`reconcile` は `other` を返すため）。
   なお `videoId` が読めない（`null`）ときの結論だけは変わっている ——
   以前は「一致しない」で開始し直していたが、`reconcile` は
   判断を保留して `same` を返すので、開始し直さない。
   URLが読めないときに監視を切るのは誤動作なので、こちらが正しい。

6. **`getMonitoringState` のキー名を `currentVideoId` → `videoId` に揃えた。**
   6a が「通信の作り替えはフェーズ6b」とコメントを残していた箇所。
   読み手は popup の1か所だけだった。

7. **popup の初期化から Step が1つ消えた。** 「Service Worker を確認中」は
   ping 8回の待ちそのものだったので、ポートを張った時点で意味が無い
   （繋がること自体が生存確認で、繋がらなければ `connect` が投げる）。
   3ステップ表示は2ステップになった。**画面に出る文言は変わるが、
   これは「見た目の変更」ではなく消えた工程の反映**（フェーズ8の対象外）。

8. **ハーネスの偽ポートは、既定で応答を返さない形にした。**
   ポート化の前は「初期化が ping 8回の待ちで止まる」ことが、
   テストから見て「初期化が邪魔をしない」保証になっていた。
   応答を自動で返す偽ポートにすると初期化が最後まで走り、
   テスト本体と競って `setComments([])` を踏む。
   既定は無応答（＝本物の SW が居ない状態）にして、
   応答が要るテストだけ `loadPopup({ onRequest })` で作る。
   **止まる位置は1つ後ろにずれた**（`waitForServiceWorker` →
   `loadCommentFilters` の `getCommentFilters`）。ハーネスの但し書きは
   その旨に書き換えた（CLAUDE.md も同じ）。

9. **popup の IndexedDB / `onblocked` には手を付けていない**（節も「必須ではない」）。
   ポートで popup の生存が見えるようになったので、道具は揃った。
   やるなら「SW がスキーマを上げる前に、開いている popup へ
   `closeDb` を流す → popup が接続を閉じて応答 → SW が版を上げる」で足りるが、
   `shared/store.js` に接続を閉じる口（と `onversionchange` の手当て）を
   足す必要があり、それは `DB_VERSION` を上げる回に一緒にやる方が安い。
   **フェーズ7への申し送りに具体案として残した。**

10. **content script が popup へ新着をリレーする経路は残っている。**
    SW → `tabs.sendMessage` → content script の `addNewComments` →
    `runtime.sendMessage` → SW のリレー分岐 → popup、という往復があり、
    popup は同じバッチを2回受け取る（id の `Set` で落ちるので実害は無い）。
    ポート化で「送った順に1回ずつ」が本物になったので、
    **この echo だけが1回ずつを崩している**。消すのは content script 側の
    2行だが、区間が違ううえ影響範囲が読み切れないので触らなかった。
    **フェーズ7への申し送りに書いた。**

テストは 147 件 → **167 件**（SW 側のポート9件・popup 側のポート11件を追加。
既存の4件は、通知の宛先が `runtimeMessages` から popup のポートへ移ったのと
`currentVideoId` → `videoId` の改名に追随させた。確かめている内容は変えていない）。

**詰まった箇所**: 上の2（応答という概念が無い）と8（偽ポートの既定）の2つ。
2 は書き始めてすぐ気付いたが、3（知らない action）は
**テストを書いていて初めて気付いた**（popup が永久に固まる形なので、
気付かないまま出すと厄介だった）。8 は一度自動応答で書いてから、
既存の popup テストが不規則に落ちるのを見て書き直した。
**資料に書いてほしかったこと**は3つで、どれも
「ポートは sendMessage の置き換えではなく、別の道具である」の系:
(a) 要求と応答の対応づけは自分で作る、(b) 知らない action にも返す、
(c) 切れたときの後始末（待ちを落とす・張り直す・取りこぼしを取り込み直す）。
**3つとも「popup と SW の通信」の節の本文に書き足した**
（実施記録ではなく指針側に置かないと、次に読む人は同じところで手を止める）。

**フェーズ7への申し送り**

- **行番号**（フェーズ6b 後の実測）
  - `service-worker.js`（全1,856行）: `emptySession` 240 / `beginSession` 264 /
    `saveSession` 271 / `loadSession` 279 / `reconcile` 308 /
    `restoreStateFromStorage` 620 / **ポートの節 849-1064**
    （`onConnect` 866 / `isPopupOpen` 885 / `postToPort` 891 /
    `notifyPopup` 901 / **`handleRequest` 907**（22分岐）/
    `dispatchRequest` 1030 / `onMessage` 1043 / `clearCommentsHistory` 1047）/
    `getMonitoringState` 1196 / `onPollSuccess` 1265 / `injectDomChat` 1365 /
    `startDomMonitoring` 1386 / `enqueueDomChatMessages` 1435 /
    `handleDomChatMessages` 1442 / `handleTabRemoved` 1556 /
    `startWatchdog` 1581 / `runWatchdog` 1616 / `notifyPopupOfError` 1710
  - `popup.js`（全2,562行）: `runInitialization` 198 /
    `completeBasicInitialization` 257 / `emergencyFallbackInitialization` 283 /
    **`connectToBackground` 336 / `requestBackground` 352 /
    `handleBackgroundMessage` 373 / `handleBackgroundDisconnect` 403 /
    `resyncAfterReconnect` 437** / `sendTabMessageWithTimeout` 697 /
    `loadExistingComments` 1035 / `restoreCommentHistory` 1132 /
    `tryDomAutoStart` 1236 / `startMonitoring` 1272 /
    `sendTabMessageWithRetry` 2464（**8箇所から呼ばれる。ここは popup →
    content script で、ポートの相手ではない**）
  - `content/content-script.js` は1行も触っていない（全641行）。
    `onMessage` 264 / `notifyPopupOfNewComments` 401 /
    `sendMessageWithRetry` 568（9箇所から呼ばれる）
- **content script の新着リレーは消してよい**（上の10）。
  `notifyPopupOfNewComments`（`cs:401`）は SW から受け取ったバッチを
  そのまま `runtime.sendMessage` で送り返しているだけで、popup は同じものを
  SW から直接もらっている。SW 側のリレー分岐（`handleRequest` の
  `newSpecialComments`）と対で消せる。**dom-chat 耐性の回に、
  content script を触るついでが一番安い。**
- **popup の IndexedDB / `onblocked`**（上の9）。ポートがあるので、
  SW から「接続を閉じてくれ」と頼めるようになった。必要になるのは
  `DB_VERSION` を上げる回で、要るのは
  `shared/store.js` の閉じる口（`close()`）と `onversionchange` の手当て、
  popup 側の `closeDb` の受け口、SW 側の「上げる前に流して待つ」の3つ。
- **`onSuspend`（`SW:1478` にあったもの）は 6a で消えている。**
  #38 の死にコードのうち、まだ残っているものがあれば
  `no-unused-vars` では拾えない（トップレベルの関数宣言とクラスのメソッド）ので、
  人手で探すこと。
- **テストの現在値は 167 件。**
- ハーネスに増えた口: popup 側は `chrome.__port()` / `__portCount()` /
  `__deliver(message)` / `__disconnect()` と `loadPopup({ onRequest })`、
  SW 側は `chrome.__connectPopup()`（返り値の `request()` / `notifications()` /
  `disconnect()`）と `calls.portMessages`。
  `sw.isPopupOpen()` / `sw.notifyPopup()` も露出している。

### フェーズ7 — dom-chat 耐性

**目的**: 「無言で止まる」をなくす。

**やること**

1. **observer を張り直せるようにする**（#2）。
   observer を変数に持ち、`#items` が `document.contains()` でなくなったら
   `disconnect()` して張り直す。安定した祖先を監視するか、番人（フェーズ6）から定期確認する
2. **ヘルス状態を popup に出す**。「チャットを読み取れています / 読み取れていません」。
   **セレクタが壊れたときに無言で0件になるのが、いまいちばん危ない**
3. **セレクタをレジストリにまとめる**。19個がインラインに散っている
   （一覧は `audit-2026-09.md` の #2 周辺と、調査時に列挙済み）。
   1か所に集めれば、YouTube の DOM 変更時に直す場所が1つになる
4. **#28 `extractAvatarUrl` を `.src` に揃える**。ステッカー側 (`dom-chat:212-215`) と同じ形に

**完了条件**

- **YouTube 側で「上位のチャット ↔ チャット」を切り替えても、取得が止まらない** ← 本体
- チャットが読めない状態のとき、popup にそうと分かる表示が出る
- プロトコル相対のアバターURLでも画像が出る（#28）

**テスト**

- `#items` が差し替わったら再観測すること（フェーズ1で `MutationObserver` モックに
  記録を持たせてあるので検証できる）
- `extractAvatarUrl` が `//lh3...` 形式を `https://` に解決すること
- `roleOf` の分岐（#T9）。`author-type` 属性、バッジ、`kind` からの推定の3経路

**注意**

- **モックでは YouTube の DOM 変更を検知できない**（#T1 #T2）。
  ここでのテストは「壊れたときに気付ける仕組みが動くか」であって、
  「セレクタが正しいか」ではない。セレクタの正しさは実ブラウザでしか確認できない

**実施記録（2026-09-08 完了）**

4つとも実装できた。地雷は踏んでいない（両 content script に `'use strict'` を
足していない、ES モジュールにもしていない、`sourceType` は `script` のまま、
`shared/` はガードで包まず `self` へ代入、生の U+0000 も書いていない、
実行時の依存はゼロのまま、`enqueueDomChatMessages` の鎖は外していない、
既存の見た目は変えていない（足したのはヘルス表示だけ）、
フェーズ8以降には手を出していない）。
フェーズ6b からの申し送り6点はどれも正確で、行番号も全部当たっていた。
判断が要った点と、節の指示だけでは決まらなかったことを残す。

1. **「番人から定期確認する」は、それだけでは成立しない。** 節のやること1は
   「安定した祖先を監視するか、番人（フェーズ6）から定期確認する」と
   2つを同格に並べているが、**番人からの再注入では直らない**。
   `executeScript` は二重注入ガード（`window.__domChatInitialized`）に弾かれて
   1行も走らないので、外れた `MutationObserver` はそのまま残る。
   番人が実際に効かせているのは、一緒に送っている `requestInitialSweep`
   （メッセージを受けて動く処理）の側だけで、これは3分ごとの取りこぼし回収にしかならない。
   採ったのは**祖先の監視（自己修復）を本体、番人の再スキャンを保険**という形。
   両方入れても「静かな配信で毎分張り直す」にはならない ——
   `ensureObserving()` が「差し替わっていなければ何もしない」ので、
   番人から来ても普通は空振りするため。**指針側（「番人」の節）に書き足した。**

2. **祖先の購読には `subtree: true` が要る。** `#items` は
   `yt-live-chat-item-list-renderer` の直下ではなく、間にスクローラが挟まる。
   `childList` だけだと `#items` の差し替えを拾えない。そのぶん**行が増えるたびに
   コールバックが呼ばれる**ので、中身は「いま見ている `#items` がまだ
   `document.contains()` か」を確かめるだけにして、
   外れているときだけ `querySelector` からやり直す形にした。

3. **ヘルスの正を Service Worker に置くと、popup を開いた時点でたいてい失われている。**
   SW は約30秒で終了するので、受けた報告をメモリに控えるだけでは
   「監視中だが状態は不明」になる時間のほうが長い。正は dom-chat.js（content script）に
   置き、SW は控えるだけ、popup に聞かれたら**タブに聞き直す**形にした。
   フェーズ6a の「番人が見る値は SW の終了に耐える場所に」と同じ形の問題だが、
   **答えは違う**（あちらは IndexedDB、こちらは content script に聞く）。
   共通しているのは「SW のメモリは判断材料の置き場にならない」という一点で、
   **指針側に「壊れたことを見えるようにする（ヘルス状態）」の節を新設して書いた。**

4. **その「聞き直す」が、いちばん固まりやすい経路だった。** `tabs.sendMessage` は
   タブの全フレームに配られ、`content-script.js` の `onMessage` は
   **扱わない `action` でも同期分岐で `return true`** を返す（#30）。
   dom-chat.js が居ないフレーム構成だと応答チャネルが開いたまま残り、
   `await` が永久に解けない —— そしてそれは、まさにこの問い合わせで
   診断したい状況そのもの。`Promise.race` で 1.5 秒の打ち切りを付けた。
   **指針側（「popup と SW の通信」の節）に書き足した。** 根治は #30 で、フェーズ9。

5. **「読み取れない」の判定は、連続で見ないと狼少年になる。** 単発の取り込み失敗は
   普通に起きる（本文の器を持たない行など）。5件連続で失敗したときだけ
   `unreadable` にした。あわせて**行のタグ名ごと変わった場合**も要る ——
   この場合 `kindOf()` が全部 null になるので「失敗」としてすら数えられない。
   ただし1行ずつ見ると、お知らせ行（`yt-live-chat-viewer-engagement-message-renderer`）
   のような未知のタグは普通に混ざるので、**全件スキャンでだけ**
   「既知のタグが1つも無く、行は5つ以上ある」を見る形にした。

6. **状態の語は5つになった。** 節は「読み取れています / 読み取れていません」の
   2値で書かれているが、実際には利用者への言い分けが要る:
   `searching`（探している最中）/ `no-chat`（30秒探して見つからない）/
   `watching`（監視中・まだ1件も流れていない）/ `reading`（読み取れている）/
   `unreadable`（行はあるのに読めない）。
   とくに `watching` と `unreadable` を分けないと、**静かな配信が
   「壊れています」と表示される**（この機能で避けたかったことの裏返し）。

7. **見た目は「読めているときに幅を取らない」形にした。** トップバーは 420px の中で
   開始／停止ボタンと場所を分け合っていて、動画IDのチップは既に
   `max-width: 120px` で省略されている。文言を常時出すと動画IDが潰れるので、
   平常時は点（7px の丸）だけ、異常時にだけ文言を添える。文言はいつでも
   `title` から読める。**見た目の変更はこの1要素だけ**で、APIモードでは出ない。

8. **セレクタのレジストリは19個ちょうどだった。** 内訳は `querySelector` の
   文字列14個（`#items` とその祖先を含む）＋ 行のタグ名5個（`KIND_BY_TAG`）。
   属性名（`author-type`）も YouTube 由来なので同じブロックに入れた。
   ハーネス側の許可リスト（`ROW_SELECTORS` / `ITEM_LIST_SELECTOR`）は
   文字列が変わっていないのでそのまま通ったが、**祖先のセレクタが増えたぶんだけ
   `document.querySelector` のモックを2つ引ける形に直した**（#T2 の厳格さは維持）。

9. **#28 は `.src` に揃えるだけで済んだ。** 配信ホストの確認は入れていない ——
   popup 側の `AVATAR_IMAGE_HOSTS`（`.ggpht.com` / `.googleusercontent.com`）が
   既にやっており、ステッカーと違って**アバターはホストの幅が広い**ので、
   ここで狭めると表示が減るだけになる。dom-chat 側は `https:` のみを見る。

10. **content script の新着リレー（echo）を消した**（フェーズ6b からの申し送り1）。
    `content-script.js` の `notifyPopupOfNewComments` と、SW 側の
    `handleRequest` の `newSpecialComments` 分岐を対で削除。
    `addNewComments` 自体は残す（`getSpecialComments` が返す配列を保っているため）。
    テストは「SW が `newSpecialComments` を**扱わない**」ことを、
    `onMessage` の戻り値が `false` になることで固定した。

11. **完了条件のうち、実ブラウザでの確認は未実施。**
    「YouTube 側で『上位のチャット ↔ チャット』を切り替えても取得が止まらない」は、
    モックでは原理的に確かめられない（#T1 #T2）。固定したのは
    「差し替えを検知して古い監視を切り、新しい `#items` に張り直し、
    外れていた間の行を全件スキャンで拾う」という段取りのほう。
    **セレクタが今の YouTube で正しいかどうかは、実ブラウザでしか分からない**ので、
    切り替え操作での確認は持ち主の手元でお願いしたい。
    残り2つ（読めないときに popup に出る・プロトコル相対のアバターURLが解決される）は
    テストで確認済み。

テストは 167 件 → **201 件**（張り直し5件・ヘルス（dom-chat 側）8件・
役割の判定3件（#T9）・アバターURL 4件・SW 側のヘルス7件・popup の表示8件を追加。
既存の1件は、祖先の監視が増えたぶん「監視は1つだけ」→「#items と祖先に1つずつ」に
書き換えた。確かめている内容は変えていない）。

**詰まった箇所**: 上の1（番人では直らない）と4（診断の問い合わせが固まる）の2つ。
1 は節の書き方を素直に読むと「番人からの再注入で直す」を選びかねないので、
**書く前に気付けたのは二重注入ガードのコメントを読んでいたから**という、
かなり運の要素があった。4 は逆に、テストを書くまで気付かなかった
（ハーネスの `onTabMessage` が既定で `undefined` を返すため、素直に書くと通ってしまう。
「いつまでも返らない」タブを作るテストを足して固定した）。
**資料に書いてほしかったこと**は3つで、どれも指針側に書き足した:
(a) 番人の「再注入」で直せるのは注入時に走るものだけ（「番人」の節）、
(b) 「いま読めているか」の正の置き場（新設した「壊れたことを見えるようにする」の節）、
(c) content script への `tabs.sendMessage` は打ち切ること（「popup と SW の通信」の節）。

**フェーズ8への申し送り**

- **行番号**（フェーズ7 後の実測）
  - `content/dom-chat.js`（全606行）: **`SELECTORS` 62**（セレクタの正。
    ここ以外に生の文字列を書かないこと）/ `HEALTH` 103 / `health` 118 /
    `setHealthState` 129 / `doInitialSweep` 150 / `attachObserver` 185 /
    **`ensureObserving` 232 / `observeHost` 271 / `handleHostMutations` 280** /
    `onMessage` 287 / `handleMutations` 300 / `takeMessage` 323 /
    `roleOf` 483 / `extractAvatarUrl` 556 / `sendToBackground` 589
  - `content/content-script.js`（全634行）: `setupMessageListener` 263
    （**扱わない action でも `return true` する = #30。フェーズ9**）/
    `addNewComments` 387 / `sendMessageWithRetry` 561（9箇所から呼ばれる）
  - `background/service-worker.js`（全1,926行）: `isPopupOpen` 885 /
    `notifyPopup` 901 / **`domChatHealth` 914 / `recordDomChatHealth` 916 /
    `askTabForHealth` 937 / `getDomChatHealth` 946** / `handleRequest` 970（23分岐）/
    `dispatchRequest` 1098 / `stopBackgroundMonitoring` 1240 / `injectDomChat` 1435 /
    `requestInitialSweep` 1451 / `startDomMonitoring` 1456 /
    `enqueueDomChatMessages` 1505 / `handleDomChatMessages` 1512 /
    `startWatchdog` 1651 / `runWatchdog` 1686
  - `popup/popup.js`（全2,648行）: **`CHAT_HEALTH_VIEW` 140**（表示の語の対応表）/
    `connectToBackground` 373 / `requestBackground` 389 /
    `handleBackgroundMessage` 410 / `resyncAfterReconnect` 476 /
    `initializeElements` 780 / **`updateChatHealth` 2049 / `refreshChatHealth` 2068** /
    `updateStatus` 2081
  - `popup/popup.html`（全246行）: ヘルスの表示は 15-20行目（トップバーの中）
- **フェーズ8は `popup.css` / `popup.html` / `options.css` が主戦場。**
  フェーズ7で足した見た目は
  `#chat-health` / `.chat-health-dot` / `.chat-health-text`（`popup.css` の
  「Video ID chip」の直前）の1組だけ。**ダークモード（#14 #15）を触るとき、
  この3つの色（緑 `#4caf50` / 橙 `#e0a02a` / 赤 `#e05a5a`）も一緒に見ること** ——
  いまは変数化しておらず、ライトテーマで見え方が変わる。
- **キーボード操作（#13）を入れるとき、ヘルス表示は操作対象ではない**
  （`role="status"` の読み上げ専用。フォーカスを取らせないこと）。
- **`updateStatus()`（`popup:2081`）と `updateChatHealth()`（`popup:2049`）は別物。**
  前者は「取得中／停止済み」（拡張機能が動いているか）、後者は
  「チャットを読み取れているか」（YouTube 側のDOMが読めているか）。
  #17（エラーの再試行ボタンが文言と違うことをする）を直すときに、
  この2つを1つにまとめたくなるが、**別の軸なので混ぜないこと**。
- **ハーネスに増えた口**: dom-chat 側は `h.replaceItemList(rows)`（#items の差し替え）/
  `h.emitHost(records)`（祖先側の監視を叩く）/ `h.deliver(request)`（SW からの要求）/
  `h.healthState()` / `h.healthReports()` / `h.host` と、`avatarImage()`。
  `h.sendCount()` と `h.messages()` は**コメントの送信だけ**を数えるようになった
  （ヘルスの報告が混ざらないよう `action` で振り分けている）。
  SW 側は `createChromeMock({ onTabMessage })` でタブの応答を作れる
  （既存の口だが、フェーズ7で初めて使った）。
- **テストの現在値は 201 件。**

---

### フェーズ8 — UI の穴

**目的**: 見えている不具合を直す。設計変更は伴わない。

**やること**

1. **#13 キーボード到達性**。`popup.css:532` の `display: none` を
   視覚的に隠す方式（`position: absolute; opacity: 0` など）に変え、
   `.toggle-slider` に `:focus-visible` のスタイルを付ける。
   フォーカス表示が無い7つのセレクタにも足す
2. **#14 options ページのダークテーマ**。popup と同じ変数方式を持ち込む
3. **#15 テーマのちらつき**。`loadTheme()` を `popup.js:278` の `Promise.all` から出し、
   `loadDebugMode()` (`popup:65`) と同じくモジュール読み込み時に実行する
4. **#16 ボタンの二重配線**。`onclick` 代入 (`popup:583`, `popup:2074`) をやめ、
   状態で分岐する形に
5. **#17 再試行ボタンの文言と挙動を一致させる**。
   文言どおりに動かすか、文言を「再試行」に統一するかを決める
6. **#19 `popup.html:181` の「モデレ:」を「モデレーター:」に**

**完了条件**

- **Tab キーだけでフィルターの ON/OFF とダークモード切替ができる**
- 設定画面がダークテーマに追従する
- popup を開いた瞬間から正しいテーマで表示される
- 初回描画でチップの幅が動かない

**注意**

- **見た目を変えない。** 到達できるようにするだけ。
  `docs/comment-display-design.md` で決めた font-weight とフォントスタックは維持する

---

### フェーズ9 — 掃除

**目的**: 残骸の撤去と、ストア審査に向けた最小化。

**やること**

1. **`content-script.js` から API モードの残骸を撤去**。
   `specialComments` (`cs:48`)、`waitForYouTubeLive` の `setInterval` (`cs:404`)、
   `setupVisibilityMonitoring` (`cs:607`、#31)
   （`notifyPopupOfNewComments` は**フェーズ7で削除済み**。SW 側のリレー分岐と対で消した）
2. **#24 SPA遷移検知を SW へ**。`cs:446-475` の `document.body` 全体購読をやめ、
   `chrome.tabs.onUpdated`（`tabs` 権限は取得済み）に移す
3. **#30 メッセージリスナーを整理**。同期分岐の `return true` をやめ、
   未知の `action` に応答する分岐を足す。
   **これには外から支えが1つ乗っている**（フェーズ7）——
   Service Worker が dom-chat.js のヘルスをタブに聞く `askTabForHealth`
   (`SW:937`) は、#30 のせいで応答が永久に返らないことがあるため
   `HEALTH_QUERY_TIMEOUT_MS`（1.5秒）で打ち切っている。**対症療法なので、
   #30 を直したら一緒に外せるか確かめること**（外すなら、
   「タブが応答しなくても問い合わせは打ち切られる」テストも対で見直す）。
   なお `tabs.sendMessage` を `await` する箇所は他にもあるので、
   #30 を直す前に一度洗い出すこと
4. **#40 権限を絞る**。`activeTab` を削除、`*://*.googleapis.com/*` を
   `https://www.googleapis.com/youtube/v3/*` に、`tabs` の要否を確認。
   APIモードが任意機能である以上、googleapis は `optional_host_permissions` が本来の形
5. **#41 content_scripts の match を整理**。`/live*` が `/live_chat*` を
   飲み込む問題と、エントリ2 だけ `https` + `www` 限定の非対称
6. **ドキュメント更新**
   - `README.md`: バージョン（#44）、機能一覧、`npm test` の記載
   - `docs/requirements.md`: 現状に合わせて全面改訂するか、
     「初期MVPの記録であり現状とは異なる」と冒頭に明記して歴史文書にする（#45）
   - `docs/avatar-design.md` / `docs/comment-display-design.md`: §1 の「現状」節に
     「実装前の記述」と注記する（#46）
   - **`docs/store-listing.md` の根拠テーブルの型を、他の文書にも導入する**
7. **#43 devcontainer**: フェーズ1 で ESLint が入っているので、設定と実態が一致する

**完了条件**

- 権限を絞った状態で、DOMモードとAPIモードの両方が動く
- ポップアウトのチャット窓で二重注入が起きない（#41）
- README のバージョンと機能一覧が実体と一致する

**注意**

- **権限の削減は挙動に影響しうる。** 1つずつ外して実ブラウザで確認すること。
  特に `tabs` は `popup.js:299` / `popup.js:912` / `popup.js:602` が依存している

---

## 実ブラウザでの検証

モックでは検証できないもの（CLAUDE.md に記載のとおり）:
実ブラウザの挙動、本物の quota、Service Worker が終了するタイミング、
メッセージパッシングの実挙動、YouTube 側の DOM 変更、popup / options の UI。

**各フェーズの最後に必ず実施する。**

1. `chrome://extensions` でデベロッパーモードをONにし、`src/` を
   「パッケージ化されていない拡張機能を読み込む」で読み込む
2. 実際のライブ配信で**1時間以上**流しっぱなしにして確認

| 確認項目 | 対象フェーズ |
| --- | --- |
| watch ページの DevTools > Performance に 500ms 周期のタイマーが無い | 0 |
| APIキー無しでデバッグモードをONにでき、リロード後も残る | 0 |
| `chrome://extensions` の Service Worker を手動で「終了」させてもコメントが続く | 3, 6a |
| **YouTube 側で「上位のチャット ↔ チャット」を切り替えても止まらない** | 7 |
| DOMモードで監視中、トップバーに読み取り状態の点が出る（読めていれば緑） | 7 |
| **フィルターを切り替えると過去分にも効く** | 4 |
| 数千件たまっても popup のスクロールと検索がカクつかない | 5 |
| APIモードで quota エラーを踏んだあと、放置して再開する | 6a |
| Tab キーだけでフィルターとダークモードを操作できる | 8 |
| 書き込み量が減っている（`chrome.storage.local.getBytesInUse(null)` と DevTools で前後比較） | 3 |

---

## やらないこと

- **作り直さない。** 動いて出荷されているものを止めない。全フェーズが単独でリリース可能
- **ビルドステップを入れない**（決定5）。`src/` をそのまま読み込める性質を維持する
- **`'use strict'` / ES モジュール化はしない。** テストハーネスが Annex B の
  関数巻き上げに依存しており、触ると48件が原因不明で落ちる。
  やるならハーネスの露出方式ごと作り直す別計画にする
- **UI の見た目を変えない。** フェーズ5 は描画の**方式**だけ、フェーズ8 は**到達性**だけ
- **i18n（英語対応）は入れない。** 約125個の日本語リテラルが3ファイル + manifest に散っている。
  やる価値はあるが独立した計画にすべき
- **ギフト受領告知の取り込みは追加しない。** 受け取った人数ぶん流れて量が多く、
  意図的に対象外にしている既存の判断を維持する
