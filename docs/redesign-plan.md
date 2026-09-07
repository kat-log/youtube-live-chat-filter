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

### 決定4: popup は「全件をメモリに載せる」のをやめる

決定1の必然的な帰結。数十万件を `this.comments` に積むことはできない。

- 起動時に **`primary` だけ**全件メモリへ（数千件・軽い）
- `bulk` は既定では読まない。「メンバー」「一般」トグルON、または検索実行時に IndexedDB から引く
- 検索は `primary` がメモリで即答、`bulk` は IndexedDB をカーソル走査（デバウンス後、進捗表示つき）
- 描画は差分追加 + ウィンドウ（最新N件を出し、古い分はスクロールで追加読み）

「全部取り込む」を守りつつ popup が固まらない形は、これで成立する。

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

| モード | 番人がやること |
| --- | --- |
| API | 「動いているべきなのにタイマーが無い」なら再開。#8 と #37 の実害が消える |
| DOM | 「N分コメントが来ていない」なら再注入 + 再スキャン。#2 の実害が消える |

### popup と SW の通信

`chrome.runtime.connect` のポートに変える。得られるもの:

- SW 側が「popup が開いているか」を知れる
- 送信順が保たれる
- 「Receiving end does not exist」の握りつぶしが要らなくなる
- popup が開いている間 SW が生きる
- **`waitForServiceWorker` の8回 ping (`popup:328`) と、
  3か所に重複している retry ヘルパーが不要になる**

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
| 6 | ライフサイクル | `service-worker.js`, `popup.js` | #5 #8 #10 #32 #35 #36 #37 |
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

---

### フェーズ6 — ライフサイクル

**目的**: 根本原因A を潰す。MV3 の現実に合わせる。

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
8. **#32 リスナーの二重登録を防ぐ**。`popup:283` と `popup:296`
9. **ポート化**。`chrome.runtime.connect`。
   `waitForServiceWorker` (`popup:328`) と重複した retry ヘルパー3つを削除

**完了条件**

- Service Worker を手動で終了させても、DOMモードでコメントが続く（既存の挙動の維持）
- **APIモードで quota エラーを踏んだあと、放置しても取得が再開する**（#37 #8）
- 動画を切り替えても、切替中のコメントが失われない（#5）
- 既存57件（フェーズ1で7件増えた） + 新規が通る

**テスト**

- **alarm 発火で、停止していたポーリングが再開すること**
- **epoch 違いの続きが状態に触らないこと**（#5）。
  バッチAが `await` 中にバッチBが入る状況を再現する
- `message` を持たない例外を投げても、次のタイマーが張られること（#8）
- `pageToken` が保存・復元されること（#36）

**注意**

- **`chrome.alarms` 権限を manifest に足す**のを忘れないこと
- リリース済み拡張機能の alarm の最小周期は**1分**。それより短くはできない
- `onSuspend` (`SW:1478`) は MV3 では配送されない（#38）。番人に置き換えたら削除する

---

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
   `specialComments` (`cs:47`)、`notifyPopupOfNewComments` (`cs:400`)、
   `waitForYouTubeLive` の `setInterval` (`cs:432`)、`setupVisibilityMonitoring` (`cs:635`、#31)
2. **#24 SPA遷移検知を SW へ**。`cs:446-475` の `document.body` 全体購読をやめ、
   `chrome.tabs.onUpdated`（`tabs` 権限は取得済み）に移す
3. **#30 メッセージリスナーを整理**。同期分岐の `return true` をやめ、
   未知の `action` に応答する分岐を足す
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
| `chrome://extensions` の Service Worker を手動で「終了」させてもコメントが続く | 3, 6 |
| **YouTube 側で「上位のチャット ↔ チャット」を切り替えても止まらない** | 7 |
| **フィルターを切り替えると過去分にも効く** | 4 |
| 数千件たまっても popup のスクロールと検索がカクつかない | 5 |
| APIモードで quota エラーを踏んだあと、放置して再開する | 6 |
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
