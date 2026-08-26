# コメント表示の「太字・フォント・時刻表示」— 調査と設計

## 調査日
2026-08-26

## 依頼の要約

1. 全体的に文字が細い。**太字にしたい**（特にコメント者名とコメント本文）
2. フォントを**ゴシック**にしたい（今は細くて見づらい／楽しさが無い）
3. コメント時刻を **12時間表記（AM/PM）** に切り替えるトグルを設定歯車に
4. コメント時刻の**秒を非表示**にするトグルを設定歯車に
5. 機能重視の設計の結果、見た目が「真面目系」になってしまった。もっと**楽しく**したい

## 結論（先に）

**全部できる。CSSと popup.js の局所改修で済み、フォントの追加同梱もいらない。**

- 「細い」原因は3つあり、**フォントを変えなくても大半は直る**（§2）
  - 最大の犯人は `popup.css:89` の `-webkit-font-smoothing: antialiased`
- 時刻トグルは、**「時刻を文字列で持っている」設計を先に直す必要がある**（§4.1）。
  ここが唯一の設計変更で、そこさえ通せばトグル自体は各20行程度
- 「楽しさ」は**参考画像（YouTube本家）が答えを持っている**：発言者名を役割色で
  色分けして太字にするだけで印象が大きく変わる（§5）
- Google Fonts等のリモートフォントは技術的には読めるが**やめたほうがいい**（§3.3）

工数感：フォント・太字だけなら30分。時刻トグル込みで2〜3時間規模。

---

## 1. 現状はどうなっているか

### 1.1 フォント指定は1箇所だけ

`popup.css:81`

```css
body {
    font-family: -apple-system, 'Hiragino Sans', 'Yu Gothic UI', 'Segoe UI', sans-serif;
    font-size: 13px;
    ...
    -webkit-font-smoothing: antialiased;   /* ← 89行目 */
}
```

**すでにゴシック体である**（ヒラギノ角ゴ／游ゴシックUI はどちらもゴシック）。
つまり「ゴシックにしたい」という要望の実体は *書体の種類* ではなく
**線の太さ（ウェイト）と描画の細さ**の問題。ここを取り違えると
フォントを差し替えても直らない。

### 1.2 コメント周辺のウェイト

| 要素 | 現状 | CSS |
|---|---|---|
| コメント本文 `.comment-message` | **指定なし＝400（Regular）** | `popup.css:1002` |
| 発言者名 `.comment-author` | 600、かつ色が `--text-secondary`(#909090) で**沈んでいる** | `popup.css:943` |
| 役割バッジ `.comment-role` | 700 | `popup.css:550` |
| 時刻 `.comment-time` | 指定なし＝400、色 `--text-muted`(#555) | `popup.css:994` |

本文が400、発言者名が「太さ600だが灰色」。**画面上で一番読みたい2つが
一番弱い**という状態になっている。参考画像のYouTube本家は逆で、
発言者名は役割色＋太字、本文もしっかり太い。

### 1.3 時刻の生成箇所

`popup.js:1232` と `popup.js:1264`（DOMモード／APIモードの2箇所）

```js
timestamp: new Date(comment.publishedAt).toLocaleTimeString('ja-JP'),
```

`ja-JP` の既定は `H:mm:ss` の24時間表記。描画は `popup.js:1413`:

```html
<span class="comment-time">${comment.timestamp}</span>
```

**重要**：`timestamp` は *受信時に整形済みの文字列* としてメモリ上のコメント
オブジェクトに固定されている。しかも `popup.js:1197-1202` の重複判定が
この文字列を比較キーに使っている。

```js
existingComment.timestamp === newComment.timestamp
```

→ 表示形式を後から切り替えるには、**この設計をまず直す**（§4.1）。

### 1.4 設定の置き場所（既存パターン）

「設定歯車」はポップアップ右上のギアで開く**ドロワー**（`popup.html:35`〜、
`popup.js:2044 initDrawer()`）。ダークモードのトグルが既に同じ形で入っており
（`popup.html:101-107`）、そのまま模倣できる。

設定の永続化は `chrome.storage.local` のフラットなキー（`theme` / `debugMode` /
`autoStart` / `chatMode`）。反映は `popup.js:25` の `chrome.storage.onChanged`
リスナーでリアルタイムに行う既存の仕組みがある。オプション画面
（`options.html`）にも同じ設定が並んでいるので、そちらにも足すのが筋。

---

## 2. なぜ「細い」のか — 原因は3つ

### 原因A：`-webkit-font-smoothing: antialiased`（最大の犯人）

`popup.css:89`。macOS の Chrome では、この指定は「サブピクセル
アンチエイリアスを切る」＝**文字を意図的に細く描く**指定。デザイン用途で
使われることが多いが、日本語の小さい文字（13px）では可読性が明確に落ちる。

**これを外すだけで、1文字も書き換えずに全体が太くなる。**
添付画像のYouTube本家がぽってり見えるのは、YouTube側がこれを指定していない
（＝既定のサブピクセル描画）ことも効いている。

### 原因B：本文のウェイトが 400

`.comment-message` に `font-weight` 指定が無い。日本語フォントの Regular は
13px だと線が痩せる。

### 原因C：フォントスタックがOSごとに細い方を引き当てる

- **macOS**: `Hiragino Sans` は W0〜W9 の実ウェイトを持つ。`font-weight: 500/600`
  を指定すれば**合成太字ではなく本物の中太**が出る。今は指定していないので W3 相当
- **Windows**: `Yu Gothic UI` の Regular は「細くて薄い」ことで有名。
  `'Yu Gothic Medium'` をスタックに入れるか、ウェイトを上げないと同じ症状が出る
- 数字（時刻）は `'SF Mono', 'Consolas', monospace`（`popup.css:999`）で、
  これも Regular

---

## 3. 設計：太字化とフォント

### 3.1 ベース（`popup.css:81` body）

```css
body {
    font-family:
        -apple-system, BlinkMacSystemFont,
        'Hiragino Sans', 'Hiragino Kaku Gothic ProN',
        'Yu Gothic Medium', 'Yu Gothic UI', 'Yu Gothic',
        Meiryo,
        'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    /* -webkit-font-smoothing: antialiased; を削除（＝既定のsubpixelに戻す） */
}
```

- `Hiragino Kaku Gothic ProN` は古いmacOS向けの保険
- `Yu Gothic Medium` を `Yu Gothic UI` より**前**に置くのがWindows対策の定石
- `Meiryo` は最後の砦（丸みがあって「楽しい」方向にも寄る）
- Latin/数字は `Roboto`（YouTubeと同じ）まで落ちる

### 3.2 ウェイト設計

| 要素 | 現状 | 変更後 | 意図 |
|---|---|---|---|
| `.comment-message` 本文 | 400 / 13px / lh1.5 | **500 / 14px / lh1.6** | 主役。太く・少し大きく |
| `.comment-author` 発言者名 | 600 / 12px / 灰色 | **700 / 12.5px / 役割色**（§5.1） | 主役その2 |
| `.comment-time` 時刻 | 400 / 11px | **500 / 11px** | 脇役のまま少し起こす |
| `.comment-role` バッジ | 700 | 700（据え置き） | 既に十分 |
| ドロワー等のUI文言 | 500〜600 | 据え置き | UIまで太くすると逆に五月蝿い |

> 全体を一律 bold にしないのが要点。**コメント（名前＋本文）だけを太く**して
> UIとの主従をはっきりさせるほうが、結果的に「太くなった」と感じる。

### 3.3 リモートフォント（Google Fonts）を使わない理由

技術的には**読める**（MV3拡張ページの既定CSPは `script-src 'self'; object-src 'self'`
のみで `font-src` を制限しない。アバター画像で確認済みの事情と同じ）。
それでも採らない：

- オフライン／回線不調でフォントが落ちると**文字が一瞬消える**（FOIT）
- Chrome ウェブストア審査でリモートリソースは説明を求められがち
- 日本語Webフォントは1ウェイト数MB。**同梱も現実的でない**

代案（やるなら Phase 2）：`M PLUS Rounded 1c` などの**Latin/数字だけのサブセット
woff2（20〜40KB）を同梱**し、時刻・件数バッジ・役割バッジにだけ当てる。
日本語本文は引き続きOS標準ゴシック。これなら容量もオフライン耐性も問題ない。

---

## 4. 設計：時刻表示の2トグル

### 4.1 前提となる設計変更 — 「整形済み文字列」をやめる

現状は受信時に `toLocaleTimeString()` した文字列を保持しているため、
トグルを切り替えても**既に画面にある数千件は古い形式のまま**になる。
（全件を作り直すこともできるが、`formatComment()` の再実行はアバター解決も
巻き込むので筋が悪い。）

**方針：生の `publishedAt` を保持し、描画時に整形する。**

```js
// formatComment() の戻り値（popup.js:1232 / 1264 の2箇所）
{
    ...,
    publishedAt: comment.publishedAt,   // ← 生のISO文字列を持つ（新規）
    // timestamp: ... は廃止
}
```

```js
// 描画時（popup.js:1413）
<span class="comment-time">${this.formatTimestamp(comment.publishedAt)}</span>
```

トグル切り替え時は `renderComments()` を呼ぶだけで全件が新形式になる。

**重複判定（`popup.js:1197-1202`）の比較キーも `publishedAt` に差し替える。**
これは副次的にバグ修正でもある：現状は「時:分:秒」文字列比較なので、
*日付が違うだけの同一発言*（例：翌日の同じ秒に同じ人が同じ文言）を
誤って重複扱いしていた。生のISOなら日付まで見る。

> 逆リスク：秒→ミリ秒精度になるため、**同一秒内の完全同一発言が重複除去
> されなくなる**。ただしAPIモードの `publishedAt` はYouTube発行のミリ秒付き
> 値なので同一コメントは必ず一致し、実害は無い。DOMモードは
> `dom-chat.js:71` でスクレイプ時刻を打っているため元々秒単位の一致に
> 依存していない。

### 4.2 整形関数（locale に頼らず自前で組む）

`ja-JP` に `hour12: true` を渡すと「午後10:34:56」になり、依頼の
AM/PM 表記にならない。`en-US` に切り替える手もあるが、ロケール実装差に
左右されるので**自前で組む**。

```js
formatTimestamp(raw) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';

    const pad = n => String(n).padStart(2, '0');
    const h24 = d.getHours();
    const h   = this.timeHour12 ? (h24 % 12 || 12) : h24;

    let s = `${pad(h)}:${pad(d.getMinutes())}`;
    if (this.timeShowSeconds) s += `:${pad(d.getSeconds())}`;
    if (this.timeHour12)      s += ` ${h24 < 12 ? 'AM' : 'PM'}`;
    return s;
}
```

出力例：

| hour12 | 秒 | 出力 |
|---|---|---|
| OFF | ON | `22:34:56`（現状と同じ） |
| OFF | OFF | `22:34` |
| ON | ON | `10:34:56 PM` |
| ON | OFF | `10:34 PM` |

### 4.3 設定キーと既定値

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `timeHour12` | boolean | `false` | true で 12時間表記（AM/PM） |
| `timeShowSeconds` | boolean | `true` | false で秒を隠す |

**既定値は現状の見た目を維持する**（＝24時間・秒あり）。既存ユーザーが
アップデート直後に「勝手に変わった」と感じない。

### 4.4 UI 配置

ドロワーのダークモード行（`popup.html:101-107`）の直下に「表示」小見出しで
2行追加。マークアップは既存の `.drawer-theme-row` + `.filter-toggle-container`
をそのまま流用する（新規CSSほぼ不要）。

```html
<div class="drawer-row drawer-theme-row">
    <label class="drawer-label" for="time-hour12-toggle">12時間表記（AM/PM）</label>
    <label class="filter-toggle-container">
        <input type="checkbox" id="time-hour12-toggle">
        <span class="toggle-slider"></span>
    </label>
</div>
<div class="drawer-row drawer-theme-row">
    <label class="drawer-label" for="time-seconds-toggle">秒を表示</label>
    <label class="filter-toggle-container">
        <input type="checkbox" id="time-seconds-toggle" checked>
        <span class="toggle-slider"></span>
    </label>
</div>
```

配線は `initDrawer()`（`popup.js:2044`）内のダークモードトグルと同じ形。
ただしダークモードは `document.documentElement` を触るだけの独立処理なのに対し、
時刻トグルは `PopupController` の再描画が要る。`initDrawer()` は
`new PopupController()` と並列に呼ばれていて参照を持っていないので、

- `DOMContentLoaded` で `const controller = new PopupController(); initDrawer(controller);`
  と参照を渡す
- あるいは `chrome.storage.onChanged`（`popup.js:25`）側に集約し、
  トグルは `storage.set` するだけにする ← **こちらを推奨**

後者なら「ドロワーで変えた」「オプション画面で変えた」「別ウィンドウで変えた」
の3経路が1箇所に収束する。`popup.js:25` のリスナーを拡張：

```js
if (changes.timeHour12 || changes.timeShowSeconds) {
    window.__popupController?.applyTimeSettings();   // 値を読み直して renderComments()
}
```

オプション画面（`options.html` / `options.js`）にも「表示」セクションとして
同じ2トグルを追加。`saveTheme()` と同型の `saveTimeFormat()` を足すだけ。

---

## 5. 「楽しさ」の底上げ（本題の裏テーマ）

参考画像のYouTube本家が楽しく見える理由を分解すると、効いているのは
**フォントではなく色とコントラスト**だった。

### 5.1 発言者名を役割色にする（効果が一番大きい）

現在、発言者名は全員 `--text-secondary`（灰色）で、役割は左の小さいバッジと
左端3pxのラインでしか分からない。本家は**名前そのものが色**。

```css
.comment-item:has(.role-owner)     .comment-author { color: var(--owner); }
.comment-item:has(.role-moderator) .comment-author { color: var(--moderator); }
.comment-item:has(.role-sponsor)   .comment-author { color: var(--sponsor); }
.comment-item:has(.role-normal)    .comment-author { color: var(--text-secondary); }
```

`:has()` は既に `popup.css:921-924` で使っている手法なので新しい依存は無い。
一般コメントだけ灰色に留めることで、**特別コメントが自然に浮き上がる**
（この拡張の目的そのもの）。

- 注意1：`.comment-author.selected`（`popup.css:965`）は青背景＋白文字なので、
  役割色より詳細度を高く保つ必要がある
- 注意2：ライトテーマは `.comment-author` に薄グレー背景チップが付く
  （`popup.css:961`）。役割色との組み合わせでコントラストを実測すること
  （`--sponsor: #4ade80` は白背景だと薄い → ライトテーマ用に暗めの値を別途定義）

### 5.2 その他（優先度順）

| 案 | 効果 | コスト |
|---|---|---|
| 本文 13→14px / lh 1.6 | 読みやすさ＋余白の呼吸 | 極小 |
| アバター 20→24px（`popup.css:970`） | 「人」が見えて賑やかになる | 極小 |
| 役割バッジを絵文字化（👑/🛡/⭐） | 横幅が空き、名前と本文に回せる | 小。ただし好み分かれる |
| 行間パディング 10px→11px | 詰まりの解消 | 極小 |
| 新着コメントのスライドイン | 「流れている」感 | **要注意** → §6 |

---

## 6. ハマりどころ

### 6.1 新着アニメーションは今のままだと全件で暴発する

`renderComments()`（`popup.js:1400`）は **毎回 `innerHTML` で全件を作り直す**。
`.comment-item` に `animation` を付けると、新着1件のたびに**画面上の全行が
一斉に再生**される。やるなら差分描画へ変えるか、新着行にだけクラスを付けて
`animation` を限定する必要がある。今回のスコープでは**入れない**判断を推奨。

### 6.2 `contain-intrinsic-size` の更新を忘れない

`popup.css:906-914` に

```css
content-visibility: auto;
contain-intrinsic-size: auto 60px;
```

があり、コメント欄の描画コスト対策（2000件で約16倍差の実測あり）。
本文を14px・行間1.6に上げると1行の実高さが 60px から膨らむため、
**この見積り値も一緒に更新する**。ずれるとスクロールバーが跳ねる。

### 6.3 時刻の幅が変わるとレイアウトが動く

秒のON/OFFとAM/PMで文字列長が `22:34` 〜 `10:34:56 PM` まで変わる。
`.comment-time` は `flex-shrink: 0` で、隣の `.comment-author` が `flex: 1`
なので**名前の省略位置が動く**。`font-variant-numeric: tabular-nums`
（`popup.css:998`）は既に入っているので桁揺れは無い。気になるなら
`min-width` を持たせる。

### 6.4 `-webkit-font-smoothing` を外すと Windows では変化しない

この指定はmacOS/WebKit系にしか効かない。Windowsで細く見える問題は
§3.1 のフォントスタック（`Yu Gothic Medium`）と §3.2 のウェイトで対処する。
**2つの環境で必ず実機確認すること。**

### 6.5 テストは通るが、守ってはくれない

`test/` の対象は Service Worker の状態機械のみ。今回の変更は
`popup.css` / `popup.js` / `options.*` に閉じるので**既存テストは無風**。
逆に言えば `formatTimestamp()` の正しさは自動テストで守られない。
純粋関数として切り出しておけば、後からハーネス無しで単体テストを足せる。

---

## 7. 実装ステップ

| # | 内容 | 触るファイル | 依存 |
|---|---|---|---|
| 1 | `-webkit-font-smoothing` 削除、フォントスタック更新 | `popup.css:81-89` | なし |
| 2 | コメント周りのウェイト／サイズ調整、`contain-intrinsic-size` 更新 | `popup.css:906,943,994,1002` | 1 |
| 3 | 発言者名の役割色（ライトテーマのコントラスト調整含む） | `popup.css` | 2 |
| 4 | `timestamp` 文字列 → 生 `publishedAt` 保持へ。重複判定キーも差し替え | `popup.js:1197,1232,1264` | なし |
| 5 | `formatTimestamp()` 追加、描画時整形に変更 | `popup.js:1413` | 4 |
| 6 | 設定の読み込み＋`storage.onChanged` での再描画 | `popup.js:25` ほか | 5 |
| 7 | ドロワーに2トグル追加・配線 | `popup.html:101`, `popup.js:2044` | 6 |
| 8 | オプション画面にも同じ2トグル | `options.*` | 6 |
| 9 | macOS / Windows 実機確認、`/release` で zip | — | 全部 |

1〜3（見た目）と 4〜8（時刻）は独立しているので、**別々にコミットして
別々に見た目を確認できる**。まず1だけ入れて体感を確かめるのが早い。

---

## 8. 決めてほしいこと

1. **本文サイズ 13px → 14px** に上げてよいか（1画面あたりの表示件数が
   約1割減る。遡って読む用途とのトレードオフ）
2. **発言者名の役割色**（§5.1）を入れるか。効果は大きいが、
   左端ライン＋バッジ＋名前色で「色が3重」になるので、
   バッジを絵文字化するなど整理とセットのほうが綺麗になる
3. 12時間表記の区切り。`10:34 PM`（スペースあり）か `10:34PM`（詰め、参考画像準拠）か
4. Latin/数字用の丸ゴシック同梱（§3.3 Phase 2）まで踏み込むか
