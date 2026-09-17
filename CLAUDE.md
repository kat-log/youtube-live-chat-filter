# YouTube ライブチャット特別コメントフィルター

YouTubeライブチャットから配信者・モデレーター・メンバーのコメントと
スーパーチャット・メンバー加入を取り込み、ポップアップに表示する Chrome 拡張機能（MV3）。
取得元は **DOMモード（既定・APIキー不要）** と **APIモード** の2つ。

この文書には**毎回効く罠と判断の基準だけ**を置く。
仕組みの説明は [`docs/architecture.md`](docs/architecture.md) にある。

## 開発コマンド

```bash
npm install   # 初回のみ（devDependency は eslint 1つだけ）
npm run lint
npm test
```

`npm ci` → `npm run lint` → `npm test` は push と PR で CI が回す
（`.github/workflows/ci.yml`）。**ビルドは無い。** `src/` をそのまま
「パッケージ化されていない拡張機能を読み込む」で使う。

---

## 環境の罠

コードを読んでも分からない、踏むと原因不明の壊れ方をするもの。
**どれも実際に踏んだ結果として書いてある。**
根拠の全文はソースの定義位置のコメントと `docs/architecture.md` にある。

### スクリプトの読み込みとスコープ

- **両 content script に `'use strict'` を足したり ES モジュールに変換したりしない。**
  どちらも二重注入ガードの `if (...) { } else { ... }` ブロックで包まれており、
  ハーネスは Annex B の sloppy モード関数巻き上げ（ブロック内の関数宣言が
  スクリプトスコープに漏れる挙動）で内部関数に到達している。触るとテストが
  原因不明の `TypeError` で全滅する（`docs/audit-2026-09.md` 末尾に詳述）。
  **`eslint.config.js` の `sourceType` を `module` にするのも同じ理由で不可。**
- **`src/shared/` のファイルを二重注入ガードで包まない。** `dom-chat.js` より先に
  読まれる別ファイルなので、ガードの中に入れると Service Worker と popup から
  見えなくなる。代入先は `self`（`window` ではない。SW に `window` は無い）。
  中身は即時実行関数で包む —— content script では `dom-chat.js` と、
  `importScripts` では `service-worker.js` とスコープを共有するので、
  トップレベルに `const` を置くと名前がぶつかる。
- **`shared/theme.js` を Service Worker から読まない。** `document` と
  `localStorage` を触る。読むのは popup と options の2ページだけ。
- **`theme.js` は両ページの `<head>` から読み込む。** body の末尾に置くと、
  ライトテーマの利用者が起動直後に真っ黒な画面を見る（#15）。

### YouTube の DOM

- **YouTube に依存する文字列は `SELECTORS` レジストリ以外に書かない**
  （`dom-chat.js`。セレクタ・`KIND_BY_TAG`・`AUTHOR_TYPE_ATTR` が1か所にある）。
  足したら `test/helpers/dom-chat-harness.js` の許可リストにも足す ——
  ハーネスは知らないセレクタを引かれたら例外にする。
- **content_scripts の `matches` に `/live*` と書かない。** `/live_chat*` を飲み込み、
  ポップアウトのチャット窓で content-script.js と dom-chat.js が同居する（#41）。
  正しくは `/watch*` と `/live/*`。
- **絵文字の `alt` が「短縮名（`:_hearts:`）の形」だと決めてかからない。**
  実際には `2BROOtojya` や `eyes-pink-heart-shape` のような裸の名前で来る
  （メンバー限定絵文字も YouTube 標準の絵文字も）。見分けるのは
  **「`alt` が絵文字そのものではないか」の1点だけ**（`isEmojiLabel()`）。
  Unicode の絵文字も `img` で来るが、そちらは `alt` が絵文字そのものなので文字のまま出す。
- **行の中の画像（ステッカー・アバター）は、行がDOMに入った直後にはまだ無い。**
  `yt-img-shadow` があとから `img` を作るので、その場で読むと空になる
  （アバターはほとんどの行で間に合わず、popup が頭文字（@）だらけになる）。
  生えるまで待ってから取り込む。**待ちは1本の列（`pendingRows`）にまとめる** ——
  行ごとに待たせると、待っている行をあとの行が追い越して popup の並びが前後する。
- **本文の文字列（`alt` の並び）に手を入れない。画像URLもIDのキーに混ぜない。**
  本文から ID と `searchText` を作っているので、変えると更新前に保存した履歴と
  突き合わせられなくなり、全件スキャンで二重に積まれる。
- **絵文字の名前を素のオブジェクトのキーに直接代入しない**（`__proto__` が来る）。
  `Map` に貯めて `Object.fromEntries()` で組み立てる。
- **番人（`chrome.alarms`）の再注入で直せるのは、注入時に走るものだけ。**
  `executeScript` は二重注入ガードに弾かれて1行も走らない。効くのは一緒に送る
  `requestInitialSweep` の側だけで、外れた `MutationObserver` のような
  「すでに走っているスクリプトの壊れた状態」は content script 自身が直す。

### メッセージのやりとり

- **`content-script.js` の `onMessage` は、同期で応答した分岐で `return true` を
  返さない**（#30）。`true` は「あとで応答する」の宣言なので、同期で済ませたあとに
  返すと応答チャネルが開いたまま残り、送信側の `await` が永久に解けない。
- **知らない `action` には応答する。ただし dom-chat.js 宛て（`DOM_CHAT_ACTIONS`）には
  応答しない。** `tabs.sendMessage` は全フレームに配られ最初の応答が勝つので、
  横から即答すると本来の宛先を追い越す（ヘルス表示が消える）。
  応答しないだけならチャネルは開いたままにならないので害は無い。
- **ポートは知らない `action` にも必ず応答を返す**（返さないと popup の待ちが
  永久に解けない）。ポートに「応答」の仕組みは無いので `requestId` で対応させる。
- **dom-chat のヘルスを聞き直す先は `frameId` で指定する**（フェーズ9）。
  控えが無いとき（SW の終了後）は宛先なしで聞き、`health` を持たない応答は捨てる。
- **`setupMessageListener()` は SW の起床待ちより先に張る。** 待っているあいだに
  popup の `ping` が来ると「未注入」と誤判定され、要らない再注入を招く。
- **新着を content script 経由で popup へリレーしない**（フェーズ7で削除）。
  popup は同じバッチを SW から直接もらうので、echo になるだけ。
- **DOMモードで liveChatId を引きに行かない。** APIキーの要らない既定の構成で
  「API key not found」だけが返る往復になり、しかも失敗として2秒おきに10回繰り返す。
  **モードの既定は `dom`**（未保存を `api` 扱いにするとインストール直後にエラーが出る）。

### 状態と保存

- **`reconcile()` を `||` のチェーンで書かない。**「明示的な false / null」を
  表現できず、片方に残った古い `true` が必ず勝つ。返すのは
  `idle` / `same` / `changed` / `other` の4語。
- **popup が「いま監視しているのは同じ配信か」を自前で比べない。**
  `reconcileSession` を SW に聞く（正は `reconcile` 1つ）。
- **`PERSISTED_SESSION_KEYS` を増やさない。** `popupPorts` のように
  永続化できないものを `session` に入れないため。
- **SPA遷移で content script 側から `stopBackgroundMonitoring` を呼ばない。**
  セッションを畳むのは SW の側で、呼ぶと突き合わせの正が2つに戻る。
- **番人が見る値は Service Worker の終了に耐える場所に置く。** メモリに持つと
  起こされるたびにリセットされ、沈黙を一生検知できない（だから「最後にコメントが
  来た時刻」は IndexedDB の `meta.updatedAt` から引いている）。
  alarm の最小周期は1分で、それより短くはできない。
- **popup は `store.migrateFromLocal()` を呼ばない。** 移行は片道で、
  Service Worker と同時に走らせると履歴が二重に積まれる。
- **既読マーク（`processedMessageIds`）は「保存すると決めたあと」に付ける。**
  先に付けると、落としたコメントを全件スキャンでも二度と拾えない（#4）。
- **アバターの保持枠は上げるだけで下げない。** 一度スパチャを投げた人を通常コメントで
  `bulk` に落とすと、過去のスパチャの行のアバターが一般の流量で消える。
- **`tab.url` は youtube.com 以外のタブで `undefined` になる。**
  無防備に `tab.url.includes(...)` と書かない（`tabs` 権限を足しても直らない）。
- **テストから `sw.session` の参照を直接保持しない。** `beginSession()` のたびに
  丸ごと再代入されるので、getter 経由で都度読む。

### UI

- **CSS のクラス名と DOM 構造は描画方式を変えても維持する**
  （`popup.css` の `.comment-item:has(.role-*)` が構造に依存している）。
- **検索の不可視文字除去は必須で、飾りではない。** YouTubeのチャットからコピーすると
  ゼロ幅スペース（`U+200B`）や方向制御文字が付いてきて、見た目は同じなのに
  `includes()` が外れ**全件が0件になる**。「検索中かどうか」の判定も
  入力そのままではなく正規化後の `searchQuery` で行う。
- **`searchText` は取り込み時に1件ずつ作る。** 検索開始後に遅延生成すると、
  最初の1文字で全件ぶんの正規化が同期的に走り、数千件で目に見えて固まる。
- **トグルの `input` を `display: none` / `visibility: hidden` で隠さない**
  （タブ順から外れる）。レイアウトに影響しない絶対配置 + `opacity: 0` を使い、
  フォーカス枠は見えている代役に `:focus-visible` で出す。
- **畳んである入れ物は `inert` にする。** `max-height: 0` は切り取っているだけで、
  閉じたままでも中の要素にフォーカスが入る。
- **コメント一覧の行に `tabindex` を配らない**（行が数千あれば Tab も数千回）。

---

## 判断の基準

- **ビルド不要は今後も維持する。** これはこのプロジェクトの開発体験の核。
- **実行時の依存はゼロ。開発ツールは必要なものを入れる。** リリースzipは `src/` 以下
  だけなので devDependency は同梱物に影響しない。lint が無かったことで死にコードや
  欠落キーを見逃していた（#38, #10）ので、機械的に防げるものは道具で防ぐ。
- **整形ルールは入れない。** ESLint のルールは `no-undef` と `no-unused-vars` の2つだけ。
  インデントは2スペースと4スペースが混在しているが、いま揃えると再設計の差分が
  読めなくなる。
- **取り込みは全件、フィルターは表示側だけ**（決定1）。取り込み口で見るのは
  `isDisplayableKind()` だけで、役割・種別のトグルは見ない。あとからトグルをONに
  すれば過去分もそのまま表示される。
- **「正」は1か所に置き、分岐で突き合わせない**（根本原因A）。
  セッション＝`session`、枠と軸の判定＝`shared/comment.js` の `filterKeyOf()` /
  `bucketOf()`、履歴＝`shared/store.js`、テーマ＝`storage.local` の `theme`。
  同じことを2か所で決めそうになったら、まず設計のほうを疑う。
- **迷ったら `docs/redesign-plan.md` の「決定事項」と実施記録を先に読む。**
  設計の意図に反する変更をしそうなときは特に。

---

## 実行前に確認を取る操作

- **Chrome ウェブストアへの提出・公開。** 取り消しが効かない。手順は
  [`docs/release-checklist.md`](docs/release-checklist.md)。
  `alarms` は「プライバシーへの取り組み」タブに個別の理由を入力しないと
  審査を通らない（2026-09 に差し戻された）。
- **`manifest.json` の権限を増やすこと。** 審査のやり直しになるうえ、
  `test/manifest.test.js` が固定しているのでテストも落ちる。
- **バージョンを上げること。** `src/manifest.json` と `README.md` の冒頭は
  対で直す（食い違いは `test/manifest.test.js` が落とす）。

---

## 必要なときに読むもの

| 文書 | 中身 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | **仕組みの説明の正。** 2モード・セッション・ポート・番人・IndexedDB・検索・テーマ・テストのハーネス |
| [`docs/redesign-plan.md`](docs/redesign-plan.md) | 決定事項・目指す設計・フェーズ0〜9の実施記録。末尾に**残っている宿題** |
| [`docs/audit-2026-09.md`](docs/audit-2026-09.md) | 2026-09-07 の全体監査。**凍結された記録**で行番号はいまのコードと対応しない。欠陥番号（#1〜#46 / #T1〜#T11）を引く索引として読む |
| [`docs/release-checklist.md`](docs/release-checklist.md) | リリース手順と確認項目（機械／偽YouTube／実配信の3段）、各リリースの実施記録 |
| [`docs/store-listing.md`](docs/store-listing.md) | ストア掲載文の正。短い説明は `manifest.json` の `description` と同一文字列 |
| [`CHANGELOG.md`](CHANGELOG.md) | 利用者から見える変更だけ。2.0.0 から |

`docs/` のこれ以外（`requirements.md` / `comment-display-design.md` /
`avatar-design.md` / `super-sticker-image.md` / `api-limitations.md`）は
**再設計より前の調査・設計の記録**で、現状とは異なる。各ファイル冒頭の注記を読むこと。

### ソースの構成

- `src/shared/` — 3環境から読む共有部分。`comment.js`（型・正規化・ID・枠と軸の判定）、
  `store.js`（履歴＝IndexedDB。SW と popup が読む）、`theme.js`（テーマ。2ページが読む）
- `src/background/service-worker.js` — セッション、取り込み、番人、popup とのポート
- `src/content/` — `content-script.js`（watch ページ。配信の特定と自動開始）、
  `dom-chat.js`（`live_chat` フレーム。DOMの読み取り）
- `src/popup/` / `src/options/` — 画面
- `test/` — Node 標準の `node:test`。ハーネスが vm コンテキストで対象を丸ごと評価する
  （拡張機能本体には同梱されない）

**再設計のフェーズ0〜9 は完了している（2026-09-08）。** 次にやることは
`docs/redesign-plan.md` の「この再設計のあとに残っている宿題」にある
（i18n、`optional_host_permissions`、実ブラウザでしか確認できないもの、
残ったテストの盲点、通信路がまだ2本あること、リリース作業）。
