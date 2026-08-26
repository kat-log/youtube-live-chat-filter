# コメント者アバター画像の表示 — 調査と設計

## 調査日
2026-08-26

## 結論（先に）

**サクッとできる。ハードルは思ったより低い。**

- 容量制限は実質問題にならない（`unlimitedStorage` 済み。かつ後述の設計なら
  ストレージ増加はコメント数ではなく**発言者数**に比例する）
- CSP も問題にならない（MV3 の既定 CSP は `img-src` を制限しない）
- API クォータの追加消費は **ゼロ**（APIモードは既に画像URLを取得済み）
- 実装量は APIモードだけなら数十行。DOMモード込みでも 1〜2 時間規模

ただし細かい落とし穴が4つある（後述の「ハマりどころ」）。

---

## 1. 画像URLはどこから来るか

このアプリは2系統でコメントを取っている。それぞれ事情が違う。

### APIモード（`chatMode === 'api'`、APIキー設定時）

`service-worker.js:881` で既に `part=snippet,authorDetails` を投げており、
レスポンスの `authorDetails.profileImageUrl` に画像URLが入っている。
さらに `popup.js:1258` で `formatComment()` が
`profileImageUrl: authorDetails.profileImageUrl` として**すでに拾っている**。

> つまりAPIモードは「取得済みだが描画していない」だけ。
> `renderComments()` のテンプレート（`popup.js:1379`）に `<img>` を足すだけで出る。
> **追加のAPIリクエストもクォータ消費も発生しない。**

### DOMモード（`chatMode === 'dom'`、既定）

`dom-chat.js` の `extractMessage()`（53行目〜）は `#author-name` と `#message`
しか見ておらず、アバターを捨てている。`popup.js:1227` は DOMモードのコメントに
対して `profileImageUrl: null` を明示的に返している。

YouTubeのライブチャットDOMは概ね次の構造:

```html
<yt-live-chat-text-message-renderer author-type="moderator">
  <yt-img-shadow id="author-photo">
    <img id="img" src="https://yt3.ggpht.com/ytc/XXXX=s32-c-k-c0x00ffffff-no-rj">
  </yt-img-shadow>
  <span id="author-name">…</span>
  <span id="message">…</span>
</yt-live-chat-text-message-renderer>
```

よって `el.querySelector('#author-photo img')?.src` で取れる。
URL 末尾の `=s32-…` はサイズ指定なので、Retina 用に `=s64-…` へ書き換えてよい。

**注意**: この構造は実ブラウザで要確認。YouTube側のDOM変更に弱いのは
既存のスクレイピングと同じリスクで、新規に増えるリスクではない。
取れなければ `null` にしてフォールバック表示に落とす（機能停止させない）。

---

## 2. 「難しいのでは？」と思われがちな点の検証

| 懸念 | 実際 | 根拠 |
|---|---|---|
| ポップアップで外部画像が CSP で弾かれる？ | **弾かれない** | MV3 拡張ページの既定CSPは `script-src 'self'; object-src 'self'` のみ。`img-src` の指示子が無い＝画像は制限なし |
| `host_permissions` に `yt3.ggpht.com` が要る？ | **不要** | ホスト権限が要るのは `fetch`/XHR。`<img src>` のサブリソース読み込みには不要 |
| ストレージ容量が破綻する？ | **ほぼ無害** | URLは約100バイト。最悪ケース（2000件×5動画）で約1.1MB。しかも `unlimitedStorage` 取得済み。§3の設計なら発言者数×100バイト（数十KB）で済む |
| APIクォータが増える？ | **増えない** | `authorDetails` は既にリクエスト済み |
| ストア審査で問題になる？ | **ならない** | リモート「コード」ではなくリモート画像。Google自身のCDN |

---

## 3. 設計

### 3.1 保存形式：コメントごとではなく「発言者ごと」に持つ

素直にやるならコメントオブジェクトに `avatarUrl` を足すだけだが、
同じ人が100回喋れば同じURLを100回保存することになる。
このアプリは過去に**ストレージ肥大化で監視が止まる障害**を出しているので、
そこは踏まないほうがいい。

そこで**発言者→URLのマップを動画ごとに1つ持つ**:

```js
// service-worker.js
const AVATAR_KEY_PREFIX = 'commentAvatars_';
const MAX_AVATARS_PER_VIDEO = 500;

monitoringState.avatarsByAuthor = {}; // { [displayName]: avatarUrl }
```

- コメントオブジェクトの形は**変えない** → 既存の保存済み履歴の
  マイグレーション不要。古いコメントも、同じ人が再度喋ればアバターが付く
- 保存キーは履歴と別（`commentAvatars_<videoId>`）。既存の
  `cleanupCommentsHistory()` / `emergencyCleanup()` の削除対象に**同じ動画IDの
  アバターキーも含める**こと（片方だけ残るとゴミになる）
- `MAX_AVATARS_PER_VIDEO` を超えたら古い順に捨てる（上限は履歴と同思想）

同名ユーザーの衝突: DOMモードでは表示名しかキーに使えない（チャンネルIDは
Polymer要素のJSプロパティ側にあり、isolated world のコンテントスクリプトからは
読めない）。同名の別人がいるとアバターが混ざるが、影響はアイコン1つの誤表示に
留まるので許容する。APIモードは `authorDetails.channelId` があるのでそちらを
キーにしてもよいが、ポップアップ側の照合を単純に保つため表示名で統一する。

### 3.2 データの流れ

```
[DOMモード]
dom-chat.js extractMessage()
    └ avatarUrl を message に添えて送る（ワイヤ上はコメント単位でよい）
        ↓
service-worker.js handleDomChatMessages()
    └ フィルタ通過分のみ avatarsByAuthor に取り込む
      （除外された種別のアバターを溜めない＝マップが無駄に膨らまない）
    └ 履歴保存時、コメント側の avatarUrl は落として map だけ保存
        ↓
popup.js
    └ getCommentsHistory / newSpecialComments のレスポンスに avatars を同梱
    └ formatComment() で profileImageUrl = comment.avatarUrl ?? avatars[displayName] ?? null

[APIモード]
既に authorDetails.profileImageUrl がある。§3.1のマップに同じ形で取り込むだけ。
```

### 3.3 描画（popup）

`renderComments()`（`popup.js:1379`）のテンプレートで `.comment-header` の
先頭に `<img>` を差す。`.comment-header` は既に flex なので CSS 追加は最小:

```css
.comment-avatar {
    width: 20px; height: 20px;      /* 必ず幅高さを指定（レイアウトシフト防止）*/
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--border);      /* 読み込み中/失敗時の下地 */
    object-fit: cover;
}
```

`<img>` には `loading="lazy"` と `decoding="async"` を付ける。

---

## 4. ハマりどころ（実装前に押さえる）

1. **インライン `onerror=` は使えない**
   MV3 の `script-src 'self'` はインラインイベントハンドラを禁止する。
   画像読み込み失敗時のフォールバックは、`innerHTML` 適用後に
   `querySelectorAll('.comment-avatar')` へ JS から `addEventListener('error', …)`
   を張る（既にユーザー名クリックで同じことをしている＝同じ場所に追記できる）。

2. **URL のスキーム検証**
   URLはYouTubeのDOM由来＝外部入力。`escapeHtml` だけでは
   `javascript:` / `data:` を排除できない。`https://` で始まるものだけ通す
   ホワイトリスト方式にする。

3. **再描画コスト**
   `renderComments()` は新着のたびに**リスト全体を `innerHTML` で作り直す**。
   最大1万件（`popup.js:1202`）なので、画像を足すと img 要素の再生成が
   そのまま乗る。ネットワークは HTTP キャッシュが効くので再取得は起きないが、
   デコード/レイアウトのコストは増える。
   → これは**アバター以前からある構造的な負債**。アバター導入を機に
   「表示は直近N件だけ」等の差分描画を検討する価値がある（別タスク推奨）。

4. **フォールバック表示を必ず用意する**
   URLが取れない（旧履歴・DOM構造変化・画像404）ケースは必ず出る。
   表示名の頭文字1文字を丸背景に出す等、常に何かが出る形にする。
   アバター無しでレイアウトが崩れないこと。

---

## 5. 実装ステップ（推奨順）

| Phase | 内容 | 変更ファイル | 規模 |
|---|---|---|---|
| 1 | APIモードのアバター表示 | `popup.js` / `popup.css` | 約30行。**まずここだけで動くものが見える** |
| 2 | DOMモードの取得 | `dom-chat.js` / `service-worker.js` / `popup.js` | 約80行 |
| 3 | マップのクリーンアップ連動 | `service-worker.js` | 約20行 |
| 4 | 回帰テスト追加 | `test/service-worker.test.js` | 約40行 |
| 5 | （任意）オプションでON/OFF | `options.*` | 約20行 |

Phase 5 を入れるかは好み。アイコン非表示のほうが情報密度が高いと感じる人は
いるはずなので、`showAvatars` トグル（既定ON）はあってよい。

### 追加すべきテスト（Phase 4）

`test/helpers/service-worker-harness.js` は chrome API をモックした
Service Worker 状態機械のテストなので、以下は書ける:

- フィルターで除外された種別のアバターはマップに入らない
- 動画が変わったらアバターマップも新しい動画のものに切り替わる
- 上限を超えたら古いものから捨てられる
- 履歴クリーンアップでアバターキーも一緒に消える

書けないもの（既存の制約と同じ）: `dom-chat.js` の実DOMスクレイピング、
ポップアップの見た目。Phase 1/2 の目視確認は実ブラウザで行うこと。
