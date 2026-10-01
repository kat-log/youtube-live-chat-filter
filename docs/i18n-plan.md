# 英語対応（i18n）計画

> 進み具合は末尾の「実施記録」。

## Context

`docs/redesign-plan.md` の「残っている宿題 1. i18n」を独立計画として実施する。
ストアはグローバル公開で日本語・英語の掲載があり、**Chrome 標準の `_locales/` 仕様**で作れば
ストアの拡張機能名・短い説明が閲覧者の言語ごとに自動で切り替わる（利用者の狙いはここ）。
加えて、オプション画面で表示言語を手動で切り替えたい。

決まったこと（利用者回答）:
- 仕組みは **Chrome 標準の `_locales/<lang>/messages.json` を唯一の正**にする。
  手動切替は同じ messages.json を自前で読むだけの薄い上乗せで、独自形式は作らない
- `default_locale` は **`en`**（日英以外のブラウザは英語。日本語 Chrome の既存利用者は変化なし）
- スコープ: UI 全部 + ストア掲載文の英語版 + README/CHANGELOG の英語版 + コンソールログの英語化

### 標準仕様でどこまで行けるか（調査結果）
| 対象 | 標準の `chrome.i18n` | 手動切替 |
| --- | --- | --- |
| manifest の `name` / `description` / `default_title`（`__MSG_x__`） | ○ ストアもこれを言語別に使う | ✕（ブラウザ言語固定。仕様上変えられない） |
| popup / options / SW の文言 | ○ `chrome.i18n.getMessage()` | △ `getMessage` は上書き不可 → 同じ messages.json を `fetch(chrome.runtime.getURL(...))` して引く |
| HTML 内の `__MSG_` | ✕ 非対応（manifest と CSS のみ） | — |
| CSS 内の `__MSG_` | ○ だが手動切替に追従しない → **使わない** | — |
| 複数形 | ✕ 仕組みなし → 「件数: 3」型の数に依らない言い回しにする | — |

## 調査で分かった現状

日本語リテラル（コメント除く行数）: `popup.js` 109 / `service-worker.js` 52 / `options.html` 51 /
`popup.html` 48 / `options.js` 25 / `dom-chat.js` 5 / `comment.js` 4 / CSS の `content:` 2（`popup.css:416`, `:1351`）/
`manifest.json` 2。`content-script.js`・`store.js`・`theme.js` は 0。
**DOM の読み取り（`SELECTORS` / `KIND_BY_TAG` / `AUTHOR_TYPE_ATTR`）はタグと id だけで、YouTube の表示言語に依存しない。**
`parseTimestampText()`（`dom-chat.js:703`）は「午前/午後」と「AM/PM」の両方を既に読める。

### 罠（設計に効くもの）
1. **ID に入る文字列を訳さない。** DOMモードの `eventText: 'スーパーステッカー'`（`dom-chat.js:559`）は
   `commentKeyOf()`（`comment.js:276`）でキーに混ざる。訳すとロケールごとに ID が変わり履歴が二重に積まれる。
   → **保存値は正準トークンのまま据え置き、popup の描画時に訳す**（`kind === 'supersticker'` の既定文言は表示側で差し替え）。
2. **APIモードの `eventText`（`comment.js:146-173`）** は ID に入らない（API の `id` を使う）が IndexedDB に保存される。
   → 構造化データ（`eventKey` + 引数）として持ち、表示時に訳す。旧履歴の日本語 `eventText` はそのまま表示（移行しない）。
   `searchText` は取り込み時に作るので、検索は「保存時の言語」で当たる — 許容し docs に明記。
3. **文言で分岐しているコード**: `popup.js:2198` `status.includes('取得中')`、`popup.js:739` `textContent === '修復中...'`。
   → 状態キー（`'monitoring'` 等）で分岐し、文言は表示だけにする。
4. **SW が表示文言を作って popup に送っている**: `ERROR_TYPES`（`service-worker.js:63-134`）、
   `cleanErrorMessage` の対訳表（`:146-155`、`options.js:35-41` と重複）、`autoStopMonitoring(reason)`（`:1761`, `:2083`）、
   ストレージ上限エラー（`:450`）、`reconcile` の理由（`:591-603`, デバッグ用）。
   → **SW はコード（`errorType` / `reasonKey`）だけを送り、文言は popup / options が引く。**
   手動切替を SW に同期させずに済み、「正は1か所」にも合う。重複する対訳表は `shared/i18n.js` に1つにまとめる。

## 設計

### ファイル
- `src/_locales/en/messages.json`, `src/_locales/ja/messages.json` — 唯一の正。キーは `camelCase`、
  `description` 欄に使われる場所を書く。置換は Chrome 標準の `placeholders`（`$COUNT$`）。
- `src/shared/i18n.js`（新規）— `self.YTFi18n`。`shared/` の流儀どおり即時関数で包み、ガードで包まない。
  - `t(key, subs)`: 上書き辞書があればそこから、無ければ `chrome.i18n.getMessage(key, subs)`、それも空ならキー自身
    （欠落が画面で目に見える）。上書き辞書の置換は Chrome と同じ `$1`/名前付き placeholder 規則を自前で解決。
  - `loadOverride()`: `storage.local.uiLanguage`（`'auto' | 'en' | 'ja'`、既定 `'auto'`）を読み、`auto` 以外なら
    `fetch(chrome.runtime.getURL('_locales/<lang>/messages.json'))` して辞書に。
  - `applyTo(root)`: `data-i18n`（textContent）/ `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria-label` を走査、
    `document.documentElement.lang` も設定。
  - `API_ERROR_KEYS`: `'exceeded your quota' → 'errQuota'` などの対訳表（SW と options の重複を統合）。
- 読み込み: popup / options は `theme.js` の次に `<head>` で読み、`popup.js` / `options.js` の初期化冒頭で
  `await loadOverride(); applyTo(document)`。HTML の静的文言は **en の文言をそのまま書いておく**（JS が走る前の既定）。
  SW は表示文言を持たなくなるので `i18n.js` を読まない（`API_ERROR_KEYS` が要るなら `importScripts`）。
- CSS の `content: '日本語'` 2箇所 → `content: attr(data-hint)` にし、JS が `t()` で属性を入れる。

### 手動切替
- options に「言語: 自動（ブラウザに従う）/ English / 日本語」のセレクトを追加（`uiLanguage`）。
- popup は開くたびに読むので即反映。options はその場で `loadOverride(); applyTo(document)` し直す。
- manifest 由来の名前・ツールバーのツールチップはブラウザ言語のまま（仕様上の制約として options に注記）。

### manifest
- `"default_locale": "en"`、`name` / `description` / `action.default_title` を `__MSG_extName__` 等に。
- `description` は各言語 132 文字以内。ja は現行文字列をそのまま移す（`docs/store-listing.md` と同一の原則を維持）。

## 実施フェーズ（各フェーズ単独でリリース可能・テスト緑を保つ）

1. **土台**: `_locales/{en,ja}`、`shared/i18n.js`、manifest の `__MSG_`、テストハーネスに `chrome.i18n` モック
   （**実際の `_locales/ja/messages.json` を読んで置換まで再現**するので既存の日本語アサーション約390件はそのまま通る。
   ロケールは引数で `en` にも切替可）。`eslint.config.js` の globals 追加。
2. **popup**: `popup.html` に `data-i18n*`、`popup.js` の 109 行を `t()` に。状態分岐をキー化（罠3）、
   役割・種別ラベル表（`popup.js:112-123`）をキー参照に、件数表示を複数形不要の言い回しに、
   スーパーステッカーの表示時翻訳（罠1）、CSS `content` の置換。
3. **SW → コード化**: `ERROR_TYPES` を `errorType` だけ送る形に、自動停止理由を `reasonKey` に、
   APIモードの `eventText` を構造化（罠2）。popup 側で引く。
4. **options**: `options.html` / `options.js`、`API_ERROR_KEYS` への統合、言語セレクト（手動切替）。
5. **コンソールログの英語化**: `debugLog` / `console.warn` の日本語を英語に（`t()` は通さない。開発者向け固定英語）。
   コードコメントは日本語のまま。
6. **文書**: `docs/store-listing.md` に英語版（名前・短い説明＝`_locales/en` と同一文字列・詳細説明・スクショ文言）、
   `README.en.md`、`CHANGELOG` の英語併記方針、`docs/architecture.md` に i18n の節、
   `CLAUDE.md` に罠（ID に入る文字列を訳さない／文言で分岐しない／SW は文言を作らない／HTML に `__MSG_` は効かない／
   CSS の `__MSG_` は手動切替に追従しない）、`docs/redesign-plan.md` の宿題1を完了扱いに。
   リリース時はストアのデベロッパーダッシュボードで英語の詳細説明・スクショを別途登録（**提出は要確認操作**）。

## 機械で防ぐもの（新規テスト `test/i18n.test.js`）
- en と ja のキー集合・placeholder 名が一致する
- ソース中の `t('...')` / `data-i18n*="..."` / `__MSG_...__` が全部 messages.json に存在する（逆に未使用キーも検出）
- `description` が各ロケール 132 文字以内、`extName` が 75 文字以内
- **popup / options / SW の非コメント行に日本語リテラルが残っていない**（許可リスト: `parseTimestampText` の「午前/午後」、
  ID に入る正準トークン `'スーパーステッカー'`）
- `t()` の上書き辞書の置換が `chrome.i18n.getMessage` と同じ結果になる
- `manifest.test.js`: description と `docs/store-listing.md` の突き合わせを `_locales/*/messages.json` 経由に変更

## 重要ファイル
`src/manifest.json`, `src/shared/i18n.js`（新）, `src/_locales/*/messages.json`（新）, `src/popup/popup.{html,js,css}`,
`src/options/options.{html,js}`, `src/background/service-worker.js`, `src/shared/comment.js`,
`test/helpers/*-harness.js`, `test/manifest.test.js`, `test/i18n.test.js`（新）, `eslint.config.js`, `CLAUDE.md`, `docs/*`

## 検証
- `npm run lint` / `npm test`（既存は ja モックで緑、追加の en ケースで英語表示を確認）
- 実ブラウザ: `src/` を読み込み、Chrome の言語を英語／日本語で起動
  （`--lang=en` / `--lang=ja`）、および options の手動切替で popup・options・エラー表示・自動停止の文言を確認。
  **420px の popup で英語の長い文言がトップバー・件数バッジで折り返し崩れしないか**を偽 YouTube で目視
  （`docs/release-checklist.md` の偽YouTube段に項目追加）
- 既存履歴（日本語 `eventText` 入り）を持ったまま英語表示にして、二重積み・ID 変化が無いこと

## 実施記録

### 段階1: 土台（2026-09-30）

- `src/_locales/{en,ja}/messages.json` を新設。キーはまだ `extName` / `extDescription` の2つだけ
  （使われていないキーは `test/i18n.test.js` が落とすので、文言は段階2以降で使う側と一緒に足す）
- `manifest.json`: `default_locale: "en"`、`name` / `description` / `action.default_title` を `__MSG_` に。
  日本語の短い説明は従来と同一文字列。英語の短い説明は
  「No API key needed. Shows streamer, moderator and member comments, Super Chats and memberships from YouTube live chat, with search.」（130文字）
- `src/shared/i18n.js`（`self.YTFi18n`）: `t()` / `loadOverride()` / `applyTo()` / `currentLanguage()` /
  `formatMessage()`。popup と options の `<head>` で `theme.js` の次に読むが、**まだ誰も呼んでいない**
  （呼び出しと `data-i18n*` は段階2・4）。`API_ERROR_KEYS` は使う段階4で足す
- テスト: `test/helpers/i18n-mock.js`（本物の messages.json を読む `chrome.i18n`。既定 `ja`）を
  popup / options のハーネスに差した。SW のハーネスには差していない（SW は文言を作らない設計なので、
  段階3で要ると分かったときに足す）。`test/i18n.test.js` を新設、`test/manifest.test.js` の説明文の突き合わせを
  `_locales` 経由に変更。`docs/store-listing.md` に「短い説明・英語」の節を追加
- 計画からの変更: 「日本語リテラルが残っていない」テストは、残っているうちは書けないので段階2〜4の最後に入れる
- 実ブラウザ（Chromium 1194、`--load-extension`）で確認: manifest が読み込めること、
  `--lang=en-US` → 「YouTube Special Comments Filter」、`--lang=ja` → 「YouTube特別コメントフィルター」、
  `--lang=ko`（_locales に無い言語）→ 英語に落ちること。ストアの表示は提出後にしか確かめられない

### 段階2: popup（2026-10-01）

- `popup.html`: 静的な文言に `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria-label` を付け、
  直接書く文言は英語に（`<html lang="en">`）。開始・停止ボタンは SVG と並んでいるので、文言だけ `<span>` で包んだ
  （`applyTo()` は textContent を書き換えるので、包まないとアイコンが消える）。
  APIキーの案内は語順が言語で違うので「APIキーの取得先: <リンク>」の形に変えた
- **JS が書き換える要素には `data-i18n` を付けない**（件数バッジ・合計）。`applyTo()` があとから走ると
  JS が書いた数字を消すため。初期値は英語で書いておき、最初の `renderComments` で JS が書く
- `popup.js`: 表示文言 109 行を `t('key')` に。キーは 128 個（en / ja 両方）。
  初期化の冒頭（`runInitialization` の最初）で `applyLanguage()` = `loadOverride()` → `applyTo(document)`。
  コンストラクタでは待たない（テストが `new PopupController()` を同期で使っている）
- 文言で分岐していた2か所（罠3）:
  - `updateStatus()` は文言ではなく状態キー（`STATUS_VIEW` の `'monitoring'` / `'monitoringDom'` / `'stopped'` …）を受け取り、
    色（`status-online`）はキーから決める。`this.status` にキーを持つ
  - 修復ボタンを戻すかどうかは `textContent === '修復中...'` ではなく、`fixExtension()` の中の
    「タブの再読み込みに切り替えたか」のフラグで決める
- 役割・種別のラベル表（`ROLE_LABELS` / `KIND_ICONS`）と `CHAT_HEALTH_VIEW` は、文言を関数（`() => t('…')`）で持つ。
  読み込み時に固めると、`loadOverride()` より先に評価されて手動切替（段階4）に追従しない
- 件数は「名前: 数」「Total: 12」「Matches: 3」のような数に依らない言い回しに（複数形の仕組みが無いため）。
  ja は従来と同一文字列
- CSS の `content: '日本語'` 2か所は `attr(data-hint)` / `"💡 " attr(data-label) ": "` にし、`applyLanguage()` が属性を入れる
- スーパーステッカー（罠1）: 保存値 `'スーパーステッカー'` は popup.js の `SUPER_STICKER_EVENT_TEXT` と突き合わせ、
  描画時（`eventTextOf()`）だけ `t('kindSuperSticker')` に差し替える。ID と保存値は変わらない
- SW 由来の文言（`showDetailedError` に届く title/message/solution、自動停止の理由）は受け取ったまま表示。
  自動停止の枠「取得が自動停止されました: …」だけは popup の文言なので訳した（理由の部分は段階3まで日本語）
- テスト: `test/popup-i18n.test.js` を新設（en で開いて状態キー・件数・スーパーステッカー・修復ボタン・0件の文言、
  popup.html の既定文言＝en の messages.json、CSS の `content` に日本語・`__MSG_` が無いこと）。
  `popup-ui.test.js` の「チップ幅の跳ね（#19）」は、HTML の初期値を英語の JS 出力と突き合わせる形に書き直した。
  「Service Worker との往復を待たずに塗る」は、冒頭の `storage.local` 読みのぶん待つマイクロタスクを増やした
- 実ブラウザ（Chromium 1194、`--lang=en-US` / `ja`、420px）で popup を開き、取得中（DOM）・読み取れない表示・
  4〜5桁の件数・エラー詳細・ドロワー・取得中のモード切替の吹き出しを確認。英語はトップバーにも件数バッジにも収まる。
  日本語は従来どおり（文言が同じなので見た目も変わらない。長い状態表示のときに動画IDのチップが隠れるのも従来から）

### 段階3: SW → コード化（2026-10-01）

- **エラー**: `service-worker.js` の `ERROR_SOLUTIONS` から文言を抜き、`errorType` / `action` / `severity` だけの
  分類表にした。`analyzeError()` が返すのも同じ形（＋ `originalError` / `pattern`）。errorType は
  `apiKeyInvalid` / `apiKeyMissing` / `quotaExceeded` / `rateLimited` / `liveChatDisabled` / `liveChatNotFound` /
  `videoNotLive` / `network` / `forbidden` / `storageQuota` / `unknown`。
  popup は `ERROR_TEXT`（errorType → 見出し・説明・解決方法の `t()`）から引く（`errorTextOf()`）。
  知らない errorType（SW だけ新しい版など）は `unknown` 扱い。errorType を持たない errorInfo は
  popup 自身が出すエラー（再読み込みの案内など。すでに `t()` 済み）なので渡された文言のまま。
  キー名は `err<種類>Title` / `Message` / `Solution`（33個）。日本語は従来の SW の文言と同一
- **分類できないエラー**（`unknown`）は、API が返した説明をタグだけ除いて `detail` で送り、popup は
  それを説明欄にそのまま出す（こちらの文言ではないので訳さない。無ければ `errUnknownMessage`）
- **`cleanErrorMessage` の対訳表（`improveErrorMessage`）は SW から消した。** 突き合わせは分類表が英語のまま
  行うので、日本語への置き換えは表示のためだけにあった。分類表に無い `Access denied` / `Bad Request` の2つだけは
  以前は `unknown` の説明欄に日本語で出ていたが、いまは API の英語の説明がそのまま出る（見出しと解決方法は訳される）。
  **段階4の `API_ERROR_KEYS` は options の対訳表だけを置き換えればよい**（SW 側の重複はもう無い）。
  popup の `detail` にも同じ表を当てたくなったら、そのとき popup から引く
- **ストレージ上限**: `notifyStorageQuotaError()` は `errorType: 'storageQuota'` を送るだけにした
- **自動停止**: `autoStopMonitoring(reasonKey)`。呼び出しは1か所（タブが閉じられた = `'tabClosed'`）。
  popup は `AUTO_STOP_REASONS[reasonKey]` を `t('autoStopped', …)` に入れる。知らない reasonKey は
  コードを見せずに `autoStoppedNoReason`（「取得が自動停止されました」）
- **対象外にしたもの**: `staleSessionReason()` の理由（「タブ情報なし」など）と `discardSession()` の引数は
  `debugLog` に出るだけで表示しないので、段階5（ログの英語化）で扱う。`openUserFilter()` が content script へ
  返す `error: '発言者名が空です'` も、受け取り側が表示しない（片道の通知）ので同じく段階5
- **SW のハーネスに i18n モックは足していない**（足す必要が出なかった）。SW のテストには「分類表は
  errorType / action / severity だけを持つ」「popup へ届く errorInfo に title / message / solution が無い」
  「分類できないエラーの値に日本語が無い」「自動停止は reasonKey を送り reason を送らない」を足した
- **APIモードの eventText（罠2）**: `apiDetailOf()` はメンバーイベントを `eventKey` + `eventArgs` で返し、
  `eventText` は `null`。`eventKey` は `newMember` / `memberUpgrade` / `memberMilestone`（`{ months }`）/
  `gift`（`{ count }`。数が無ければ `null`）。メンバーシップのレベル名は `eventArgs.level` に入れ、
  訳さずに「 · レベル名」で後ろへ添える（従来と同じ形）。正準形に `eventKey` / `eventArgs` を足し、
  `fromDomMessage()` も引き継ぐ（正準形を通し直しても落ちない）。popup の `EVENT_LABELS` / `eventLabelOf()` が訳し、
  `eventTextOf()` はまず `eventKey` を見て、無ければ従来どおり `eventText`（DOMモード・旧履歴の日本語はそのまま）
  - 英語の文言は複数形を避けた: 「New member」「Upgraded membership」「Member for 12 mo」
    「Gifted memberships: 5」「Gifted memberships」
  - スーパーステッカーの `eventText: 'スーパーステッカー'` は APIモードでも正準トークンのまま
    （DOMモードと同じ扱い。訳すのは段階2の `eventTextOf()`）
  - **DOMモードの `eventText`（dom-chat.js）は変えていない**（罠1）
- **調べて分かったこと（計画の罠2の前提の訂正）**: APIモードのコメントは IndexedDB に **API の item のまま**
  保存されていて（`fetchLiveChatMessages` が `bucket` だけ焼き付けて渡す）、`eventText` も `searchText` も
  保存されていない。正準形に通すのは popup が取り込むとき（`formatComment()`）で、開くたびに作り直す。
  だから「旧履歴の日本語 eventText」は APIモードの保存データには実質無く、更新後は旧履歴の API item も
  `eventKey` で訳される（storage.local からの移行も形を変えずに移すだけなので同じ）。
  `eventText` が文言のまま出るのは DOMモードの行（YouTube の画面の文言）と、`eventText` を持った形で
  保存されたもの。「旧履歴の日本語はそのまま表示」の約束は `eventTextOf()` の後段として残してある
- **検索の言語**: `searchText` を作るのは `shared/comment.js` で、このファイルは表示言語を知らない
  （SW と content script からも読まれる）。そこで `buildSearchText(comment, eventLabel)` に訳した一行を
  渡せる口を足し、popup の `formatComment()` が `eventKey` を持つ行だけ作り直す。結果として
  **APIモードのメンバーイベントは「popup を開いたときの表示言語」で当たる**（計画で許容していた
  「保存時の言語」より良い）。**「保存時の言語」で当たるのは、DOMモードの `eventText`（YouTube の表示言語）と
  旧履歴の日本語 `eventText`**（どちらも訳し直さない）。`docs/architecture.md` の「キーワード検索」に明記した
- `docs/architecture.md` の「表示言語」の節に「SW は文言を作らない」「メンバーイベントはコードで持つ」を足した
- テスト: `test/popup-i18n.test.js` に、en でのエラー詳細（errorType から引く・Cloud Console のボタン・
  ストレージ上限・unknown の detail と既定・知らない errorType・errorType 無しは素通し）、全 errorType が
  en / ja で引けること、ja で従来と同じ文言、自動停止（reasonKey・知らない reasonKey）、
  APIモードのメンバーイベント（en / ja の文言、英語で検索して当たる、保存値はコードのまま）を足した。
  `test/shared-comment.test.js` に `eventKey` / `eventArgs` の形、通し直し、スーパーステッカーと DOMモードは
  据え置き、の各テスト。`popup-port.test.js` の自動停止は reasonKey に直した
- 実ブラウザ（Chromium 1194、`--lang=en-US` / `ja`、420px）で popup を開き、**本物の SW から本物のポートで**
  `notifyPopupOfError(analyzeError(…))`（quota / 分類できないエラー）・`notifyStorageQuotaError()`・
  `autoStopMonitoring('tabClosed')`・APIモードのメンバーイベント3種を流して表示を確認。どれも横にはみ出さない
  （`scrollWidth` = 420）。日本語の文言は従来と同一
