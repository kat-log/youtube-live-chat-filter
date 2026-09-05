# スーパーステッカーの画像表示 — 調査と実装メモ

## 調査日

2026-09-05

## 依頼の要約

スーパーステッカーをテキスト（altのステッカー名）だけで出しているが、
画像そのものをポップアップに出せないか。動くステッカーもあるが、そもそも
どんなファイル形式で取得できるのかも分からない、という相談。

## 結論（先に）

- 形式は **アニメーションWebP**。GIFでもSVGでもLottieでもなく、`<img>` に貼れば動く
- DOMモードでは画像URLが**既にDOMにある**。`extractDetail()` が alt を読んでいる
  `#sticker img` の `src` がそれ
- 追加の権限もCSPの変更も不要。ポップアップはアバターで既にリモート画像を表示している
- APIモードは画像URLを返さないので**今回は対象外**（下の「APIモードをやる場合」を参照）

## 1. ファイル形式とURLの形

YouTube自身がステッカーIDと画像URLの対応表を公開している。

```
https://youtube.googleapis.com/super_stickers/sticker_ids_to_urls.csv

biggest_fans_brb_ja,https://lh3.googleusercontent.com/zEhiy98...LQ
```

この表を定期取得している [RealityRipple/yt-super-stickers](https://github.com/RealityRipple/yt-super-stickers)
が、URLの組み立てテンプレートも残している。

```
https://yt3.ggpht.com/%STICKER_ID%=s256-rwa
```

`=` 以降はGoogleの画像配信パラメータで、`sNN` が長辺のピクセル数、
`-rwa` が **r**equest **w**ebp **a**nimated。つまりアニメーションWebPが返る。
調査時点で全337種類。

ライブチャットのDOMに入っている実物（2026-09-05 時点で確認）。

```html
<img id="img" class="style-scope yt-img-shadow" width="104" height="104"
     alt="チアリーダーの服装で空中にジャンプしているファン"
     src="//lh3.googleusercontent.com/WtHjpCnBi5Q9OlDrc...=s208-rwa">
```

- **`src` はプロトコル相対**（`//lh3...`）。`getAttribute('src')` で読むと
  `https://` 判定に引っかかるので、絶対URLに解決される `.src` から取る
- 表示104pxに対して `=s208-rwa`、つまりYouTube自身が2倍で要求している

こちらの表示は96pxなので、同じく2倍の `=s192-rwa` に差し替えて使う（`dom-chat.js`
の `STICKER_IMAGE_SIZE`）。ID部分に `=` は入らないので、最初の `=` で切れば安全。
なお古い版では `=s40-rp` のような小さい静止版が入っていた記録もあるため、
サイズ指定は当てにせず必ず書き換える。

## 2. 実装

### 2.1 取得（`content/dom-chat.js`）

`extractStickerUrl(img)` を追加し、`extractDetail()` の supersticker 分岐から呼ぶ。

- **`getAttribute('src')` ではなく `.src` を使う**。属性値はプロトコル相対
  （`//lh3...`）で入っており、絶対URLに解決されるのはプロパティの方
- https と配信ホスト（`lh3.googleusercontent.com` / `yt3.ggpht.com`）を確認してから通す
- 読めない形なら `null`。ステッカー行そのものは今までどおり取り込む

**`messageIdFor()` のキーには混ぜていない。** 混ぜると拡張機能の更新前後で
同じステッカーに違うIDが振られ、保存済み履歴と重複する。

### 2.2 保存

`stickerUrl` はステッカー行にだけ載る約100バイトのフィールド。アバターURLのような
発言者マップ化（`collectAvatars`）はしていない。ステッカーは1配信で数件〜数十件しか
流れず、コメント件数に比例しないため。**もし将来ステッカーが常時流れるほど
増えたら、ここは肥大化対策の見直し対象になる。**

### 2.3 表示（`popup/popup.js`, `popup/popup.css`）

- `formatComment()` はホワイトリストなので、`stickerUrl` の受け渡しを明示的に追加
  （足し忘れると無言で消える）
- `safeStickerUrl()` は既存の `safeAvatarUrl()`（https限定）にホスト確認を重ねる。
  本文と違って `img` の `src` に流し込むため
- 描画順は「イベント行 → 画像 → ステッカー名」。**ステッカー名（alt）は本文として
  残す**。消すとキーワード検索が効かなくなる
- 読み込み失敗時は `img` を取り除くだけ。ステッカー名の行が残るので情報は消えない
  （MV3のCSPはインラインの `onerror=` を禁止するので、アバターと同じくJSから張る）
- `.comment-item.kind-supersticker` の `contain-intrinsic-size` を 197px に上書き。
  共通の見積り（76px）のままだと画面外の行の高さがずれてスクロールバーが跳ねる。
  実測197px＝通常行74＋イベント行19＋画像104

## 3. ハマりどころ

### 3.1 `-rwa` を強制するのでURLが変わる

YouTube側が返している静止版URLをそのまま使わず、サイズ指定を書き換えている。
YouTube自身のテンプレートと同じ形なので通るはずだが、将来パラメータの仕様が
変わると404になりうる。その場合は画像が消えてステッカー名だけが残る
（＝この機能を入れる前の表示に戻る）ので、実害は表示だけに閉じる。

### 3.2 テストで守れる範囲は限られる

`test/dom-chat.test.js` で「いつ読むか」の段取りは固定した。ただしモックのDOMは
セレクタ文字列の完全一致でしか引けないので、YouTube側のDOM変更
（`#sticker img` が消える、`src` の形が変わる）には無力なまま。
`src` が取れない場合は必ず画像なしに落ちる作りにしてある。

### 3.3 アニメーションは止められない

アニメーションWebPの再生はCSSでは止められない。うるさい場合に備えて
オプションでON/OFFを付けるなら、`stickerHtml()` の入口に設定値を1つ足すだけで済む。
今回は入れていない。

## 4. APIモードをやる場合

`superStickerDetails.superStickerMetadata` にあるのは `stickerId` / `altText` /
`altTextLanguage` だけで、画像URLは含まれない（[SuperChatEvents](https://developers.google.com/youtube/v3/live/docs/superChatEvents)）。
1章のCSVが `sticker_ids_to_urls` という名前のとおり `stickerId` で引ける想定だが、
**実レスポンスで確認していない**。やるとしたら、

- CSVをService Workerで1日1回取得してキャッシュ（新作にも追従。`host_permissions` の
  `*://*.googleapis.com/*` で既にカバー済み）
- もしくはスナップショットJSON（約35KB）を同梱（通信ゼロ、新作は名前だけ）

のどちらか。

## 5. 実装後に見つかった不具合（2026-09-05）

初版は**新着のステッカーだけ画像もステッカー名も落ちる**状態だった。過去分の
全件スキャン（`doInitialSweep`）では取れてしまうため、実配信で新着を待たないと
再現しない。

原因は読むタイミング。行がDOMに入った直後は `yt-img-shadow` の中に `img` がまだ
存在せず、`MutationObserver` のコールバックで読むと `#sticker img` が `null` を返す。
`#author-name` などは埋まっているのでコメント自体は成立してしまい、
ステッカーだけが中身の無い状態で保存されていた。

初版から変わっていない `alt` の取得も同じ入り口を使っており、**そちらも以前から
空だった**。画面に「スーパーステッカー」と出ていたのは `eventText` の固定文言で、
ステッカー名が取れているように見えていたのはそのため。

対処として `handleMutations()` にステッカー専用の待ち（`waitForStickerImage()`）を
入れた。

- 100ms間隔・最大15回（約1.5秒）まで `#sticker img` に `src` が入るのを待つ
- 待っている間に投稿時刻がずれないよう、**受信時刻は行を見つけた時点のもの**を
  `extractMessage()` へ持ち回る
- 生えてこなければ打ち切って取り込む（画像なしで従来どおりの表示になる）

**この待ちはステッカーだけに掛ける。** 全種別を遅延させると通常のコメントまで
表示が遅れるうえ、取り込み順も入れ替わる。

同じ待ちを `doInitialSweep()` にも入れてある。過去分は画像が読み込み済みのことが
多いが、チャットを開いた直後は間に合っていないことがあり、そこだけ素通しにすると
「再読み込みすれば直る」が成り立たなくなるため。

### 5.1 直したあとに残ること

- **既に保存済みの履歴は画像なしのまま。** 取り込んだ時点の情報しか持っていない
- ページを再読み込みすると、チャットのDOMに残っている範囲は画像付きで拾い直せる。
  ただしステッカーのIDは本文（alt）から作るため、空で保存された行とはIDが変わり、
  **同じステッカーが画像あり・なしで2行並ぶ**。気になる場合は「履歴クリア」→
  監視の停止→開始で、`processedMessageIds` ごと作り直すときれいになる
