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

ライブチャットのDOMに入っている実物は小さい静止版のことがある。

```html
<yt-img-shadow id="sticker">
  <img id="img" src="//lh3.googleusercontent.com/KP--Ps9ho0...=s40-rp" alt="...">
</yt-img-shadow>
```

そのため `=` 以降だけを `s96-rwa` に差し替えて使う（`dom-chat.js` の
`STICKER_IMAGE_SIZE`）。ID部分に `=` は入らないので、最初の `=` で切れば安全。

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

### 3.2 テストは守ってくれない

`test/` はService Workerの状態機械限定で、`dom-chat.js` のDOMスクレイピングは
対象外のまま。YouTube側のDOM変更（`#sticker img` が消える、`src` の形が変わる）には
無力なので、`src` が取れない場合は必ず画像なしに落ちる作りにしてある。

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
