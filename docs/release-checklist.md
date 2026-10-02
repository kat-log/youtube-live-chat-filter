# リリース手順と確認項目

ストアに出すまでにやることと、**何をどこまで確かめたか**を残す場所。
掲載文そのものは [`store-listing.md`](store-listing.md)、変更履歴は
[`../CHANGELOG.md`](../CHANGELOG.md) が正。

このファイルは「次のリリースでも同じ抜けを踏まない」ために置いている。
実際、v1.12.5 までは**バージョンの記載が README と manifest で食い違ったまま**だった（監査 #44）。

---

## 手順

1. `npm run lint` と `npm test` が通る
2. `src/manifest.json` の `version` を上げる。**`README.md` と `README.en.md` の「バージョンと変更履歴」の節と対で直す**
   （`test/manifest.test.js` が食い違いを落とす）
3. `CHANGELOG.md` に、利用者から見える変更だけを書く。`### English` の節も併記する
   （「未リリース」の節があれば、そのバージョンの見出しに付け替える）
4. `docs/store-listing.md` の掲載文を実体に合わせる。日本語と英語（「・英語」の節）の両方。
   **名前と短い説明は `_locales/<lang>/messages.json` の `extName` / `extDescription` と同一文字列**にする
   （こちらも `test/manifest.test.js` が固定している）
5. 権限を変えたなら「権限の説明（ストア審査用）」の表も直す
6. zip を作る（`/release`）。**同梱するのは `src/` 以下だけ**
7. 下の確認項目を実施する。実配信での確認は zip を出す前でも後でもよいが、
   **ストアに提出する前**に済ませる
8. ダッシュボードに掲載文・告知文・権限の説明を貼り、zip をアップロードする。
   **英語の掲載情報**（言語に English を追加し、詳細な説明・告知文・スクリーンショットを英語のものに）も同時に。
   名前と短い説明は zip の `_locales` から入るので貼らない。
   **`alarms` は「プライバシーへの取り組み」タブに個別の理由を入力しないと審査を通らない**
   （2026-09 に差し戻された）。貼る文面は `docs/store-listing.md` の
   「`alarms` の正当性（そのまま貼る文面）」にある

---

## 確認項目

出どころは [`redesign-plan.md`](redesign-plan.md) の「実ブラウザでの検証」。
3段に分かれる。**下に行くほど代替が効かない。**

### A. 機械で確かめられる（毎回やる）

| 項目 | 方法 |
| --- | --- |
| lint とテスト | `npm run lint` / `npm test` |
| manifest の match と権限 | `test/manifest.test.js`（権限を増やすと落ちる） |
| version が README と揃っている | 同上 |
| 短い説明が manifest の description と同一 | 同上 |
| zip の同梱物が `src/` 以下だけ | `unzip -l` で `test/` `docs/` `node_modules` `.devcontainer` が無いこと |

### B. 偽 YouTube + 実 Chromium で確かめられる（挙動が変わったリリースでやる）

自己署名の証明書で `https://127.0.0.1:8443` に `/watch` と `/live_chat` を返し、
`--host-resolver-rules="MAP www.youtube.com 127.0.0.1:8443"` と
`--load-extension=src` で Chromium に見せる。手順は
[`redesign-plan.md`](redesign-plan.md) の「実ブラウザでの検証」にある。
**道具立てはリポジトリに入れない**（書き捨てる）。

| 項目 | 対応する欠陥・フェーズ |
| --- | --- |
| 権限を絞った状態で拡張機能が読み込め、Service Worker が起動する | 9 |
| `tabs` 権限なしで youtube.com のタブの `url` が読める | 9 |
| watch のトップフレームに content-script、チャットの iframe に dom-chat だけが立つ | #1 |
| ポップアウトのチャット窓で二重注入が起きない | #41 |
| DOMモードが自動で始まり、IndexedDB に入る | 4 |
| 取り込みが全件（一般コメントもスパチャも入る） | 決定1 |
| 読み取り状態（ヘルス）が `reading` を返す | 7 |
| `#items` を差し替えても監視が張り直される | #2 / 7 |
| 履歴が `storage.local` に積まれていない | 3 |
| 数千件ためても popup の描画・検索・スクロールが返る | 5 |
| `--lang=en-US` と `--lang=ja` で名前・popup・options がその言語で出る。日英以外（`--lang=ko`）は英語 | i18n |
| 英語の長い文言が 420px の popup のトップバー・件数バッジ（4〜5桁）・エラー詳細で折り返し崩れしない（`scrollWidth` が 420） | i18n |
| options の言語セレクトで切り替えるとその場で変わり、次に開いた popup も同じ言語になる | i18n |

### C. 本物でしか踏めない（**リリース前に人がやる**）

偽 YouTube では代替できない。**セレクタとAPIモードはここでしか確かめられない。**

| 項目 | 必要なもの | 誰が |
| --- | --- | --- |
| 本物のライブ配信で DOMモードを**1時間以上**流す | 実配信 | 開発者 |
| 「上位のチャット ↔ チャット」の切り替えで止まらない | 実配信 | 開発者 |
| セレクタが当たっている（役割バッジ・スパチャの金額・ステッカーの画像） | 実配信（スパチャが飛ぶ配信） | 開発者 |
| APIモードで取得できる（`liveChatId`・`pageToken` の続き） | **APIキー** | 開発者 |
| APIモードで quota エラーを踏んだあと、放置して再開する | **APIキー**・quota を使い切る配信 | 開発者 |
| Service Worker を手動で「終了」させても取得が続く | `chrome://extensions` | 開発者 |
| 書き込み量が減っている（更新前後の `getBytesInUse` 比較） | 更新前のプロファイル | 開発者 |
| 既存の履歴が IndexedDB に引き継がれる | 旧バージョンで貯めた履歴 | 開発者 |
| Tab キーだけでフィルターとダークモードを操作できる | — | 開発者 |
| 英語の YouTube（表示言語 English）でも DOMモードで役割・スパチャ・メンバー加入・時刻（AM/PM）が読める | 実配信 | 開発者 |
| 公開後、ストアの掲載名・短い説明・詳細な説明が閲覧者の言語（日本語／英語）で出る | 公開後のストア | 開発者 |

---

## v3.0.1（2026-10-02）の実施記録

中身は #113（「上位のチャット ↔ チャット」の切り替えでコメントが二重に取り込まれる）の修正 #115 だけ。
`dom-chat.js` の `messageIdFor()` が、行の `id` 属性（YouTube のメッセージID）で「描き直された同じ行」を見分ける。
保存するIDの形（`dom2_<key>_<N>`）は変えていない。権限は変えていない。

### 手順

- 1: 済。`npm run lint` / `npm test`: **440件 パス**
- 2〜5: 済（`manifest.json`・`README.md`・`README.en.md` を 3.0.1 に、CHANGELOG の「未リリース」を 3.0.1 に付け替え、
  `store-listing.md` に v3.0.1 の告知文。掲載文・スクリーンショット・権限の説明は変更なし）
- 6: 済。`youtube-live-chat-filter-v3.0.1.zip`（SHA-256 `503af218e93e98f4af527aed79b2fa26cb1673bd85722b2a5b27ef72f2b7203f`）。
  `git archive --format=zip HEAD:src`（manifest が zip の直下）。`git ls-files src` と1対1で一致、version 3.0.1、
  `test/` `docs/` `node_modules` `.devcontainer` なし
- 7: 下の C
- 8: 未（v3.0.0 の審査が終わってから。審査中のアイテムには新しいパッケージを上げられない）

### C. 本物でしか踏めないもの

| 項目 | 結果 |
| --- | --- |
| 「上位のチャット ↔ チャット」の切り替え | **済（直った）**。2026-10-02、#115 をマージした main（92b2edf。src は v3.0.1 と version 以外同一）を Chromium 1194 に読み込み、hololive の英語配信で監視中に「上位のチャット → チャット → 上位のチャット → チャット」と3回切り替えた。295件中、ID の末尾が `_1` 以上になったのは2件だけで、どちらも切り替え前からある本物の連投（同じ人が「nice」を20秒あけて2回）。切り替えの前後で同じ本文の行の YouTube のID（`id` 属性）はほぼ一致した（例: 74行中69行。残りは別の人・別の時の同じ文） |
| DOMモードを1時間以上 | 未（v3.0.0 から持ち越し） |
| APIモード | 未（APIキーなし。v3.0.0 から持ち越し） |

---

## v3.0.0（2026-10-01）の実施記録

中身は英語対応（`docs/i18n-plan.md` の段階1〜6）だけ。権限は変えていない。
メジャーを上げたのは、表示言語という利用者から見える軸が増えたため（互換性を壊す変更は無い。
保存済みの履歴・設定はそのまま読める）。

### 手順

- 1〜5: 済（`manifest.json`・`README.md`・`README.en.md` を 3.0.0 に、CHANGELOG の「未リリース」を
  3.0.0 に付け替え、`store-listing.md` の告知文を v3.0.0 に。権限は変えていないので「権限の説明」はそのまま）
- 6: 済。`youtube-live-chat-filter-v3.0.0.zip`（SHA-256 `e1cdc97cdd484f976973cffdfb59ee4f4a14ead7154e02948ff0a90013c0f214`）。
  `git archive --format=zip HEAD:src` で作り、**`manifest.json` が zip の直下に来る形**にした
  （v2.2.1 までの zip は `src/` が1段挟まっていた）
- 7: 一部済（下の C）
- 8: 済。zip のアップロード、日本語の詳細な説明の差し替えと「このバージョンの新機能」、
  English の掲載情報（詳細な説明・告知文・スクリーンショット3枚）を入力し、**2026-10-01 に審査へ提出した**。
  名前と短い説明は貼らず、ダッシュボードで日本語「YouTube特別コメントフィルター」／英語「YouTube Special Comments Filter」と
  出ていること、「プライバシーへの取り組み」の `alarms` の理由が入っていることは開発者が確認した
- **ダッシュボードは自動化できない。** Chrome ウェブストアのページは拡張機能からの操作・読み取りを Chrome 自身が拒む
  （"The extensions gallery cannot be scripted"）ので、Claude in Chrome でもスクリーンショットすら取れない。
  入力は人が行い、貼る文面はこのリポジトリの `store-listing.md` からスクリプトでそのまま抜き出して渡した

### 英語のスクリーンショット

`promotion/store-screenshots-en/` の3枚（1280x800）。`store-listing.md` の「スクリーンショット・英語」の3構図
（監視中／フィルターのドロワー／`Matches: N` の検索）。実配信（hololive の英語配信）を `--lang=en-US` の Chromium で
読み込んだ popup（420x600 を2倍で撮影）に、掲載文の言い回しから取った見出しを添えた。
**スパチャが流れなかったため、1枚目に金額チップとステッカー画像は写っていない。** 次に撮り直すときの宿題。

### A. 機械で確かめられるもの — 済

- `npm ci` → `npm run lint` → `npm test`: **431件 パス**（main d53e8e8）
- zip の同梱物: `unzip -l` で `test/` `docs/` `node_modules` `.devcontainer` が無いこと、
  `git ls-files src` と1対1で一致すること、`manifest.json` の `version` が 3.0.0 であることを確認

### B. 偽 YouTube + 実 Chromium

i18n の段階2〜4で確認済み（`docs/i18n-plan.md` の実施記録）。下の C は v3.0.0 の zip の中身そのもので行った。

### C. 本物でしか踏めないもの — 一部済

zip を展開したものを Chromium 1194（Playwright 同梱、Xvfb 上で headful）に `--load-extension` で読み込み、
本物の YouTube のライブ配信で確認した（クラウドの作業環境。開発者の Mac の Chrome ではない）。

| 項目 | 結果 |
| --- | --- |
| DOMモードを1時間以上流す | **未達（約31分）**。15:55〜16:26 JST、ヘルスは `reading` のまま、件数は 86 → 751 と増え続け、止まった形跡は無い。作業環境（クラウドのコンテナ）が再起動されてブラウザごと消えたため打ち切り。拡張機能の不具合ではない |
| 「上位のチャット ↔ チャット」の切り替え | **不具合あり（v3.0.0 由来ではない）**。止まりはしないが、切り替えた時点でチャット欄に出ているコメントが**もう一度取り込まれて二重に並ぶ**（2026-10-02 に日本語の配信で確認。スパチャ2件が各2行になり「スパチャ: 4」、一般・メンバーも193件中71件が重複。重複分の ID は末尾が `_1` で、同じ人が同じ文を2回送った扱い）。当初「件数が増え続けた」で済としたのは、この重複を数えていた可能性が高い。`dom-chat.js` は v2.2.1 からログ文言しか変わっていないので、前からある挙動。**#115 で修正し v3.0.1 で出す**（上の v3.0.1 の実施記録） |
| 英語の YouTube（`--lang=en-US`）で役割が読める | 済。owner（配信者）・member を取り込んだ（バッジは `Member (1 year)` などの英語表記） |
| 英語の YouTube で時刻（AM/PM）が読める | 済。チャット欄の `3:55 PM` が 15:55 JST として保存された（12時間表示で `4:09:00 PM` と出る） |
| 英語の YouTube でスパチャ・メンバー加入が読める | **未確認**。3配信で計20分ほど待ったがスパチャも加入も流れなかった |
| 日本語のブラウザ（`--lang=ja`）で従来どおり日本語で出る | 済。popup が「取得中（DOMモード）」「コメント」「101件」と日本語で出た |
| 設定画面の言語で English / 日本語 を切り替えると popup が追従する | 済。日本語ブラウザで English → 日本語 → 自動、英語ブラウザで 日本語 → 自動 と切り替え、そのたびに設定画面がその場で変わり、次に開いた popup も同じ言語になった（監視中の配信でも確認） |
| APIモード（取得・quota からの復帰） | **未実施**（APIキーが無い）。v3.0.0 では APIモードのメンバー加入・継続・ギフトの一行が文言からコード（`eventKey`）に変わっている（`shared/comment.js` の `apiDetailOf`）ので、**次に APIキーで流すときに最初に見る** |
| SW の手動終了・書き込み量・履歴の引き継ぎ・Tab キー | 未実施 |
| 公開後、ストアの掲載名・説明が閲覧者の言語で出る | 未実施（公開後に見る） |

踏んだ環境の罠（次に同じ道具立てで確かめるとき用）:

- **Linux の Chromium は `--lang` だけでは `chrome.i18n.getUILanguage()` が `en-US` のまま**になる
  （`getMessage()` は `--lang` に従うので画面は日本語になるが、`<html lang>` が `en` になる）。
  `LANGUAGE=ja LANG=ja_JP.UTF-8` を環境変数でも渡すと `ja` になる。Mac / Windows の Chrome では起きない
- クラウドの IP から新しいプロファイルで YouTube を何度も開くと、途中から `google.com/sorry`（ボット確認）に飛ばされる。
  すでに開いているタブのチャットは読み続けられる。動画は「Sign in to confirm you're not a bot」で再生されないが、チャットは流れる
- 確認用のブラウザは CDP で Service Worker に1分おきに `evaluate` していたので、SW のアイドル終了は起きにくい条件だった。
  「SW が終了しても取得が続く」の確認にはならない

---

## v2.0.0（2026-09-08）の実施記録

### A. 機械で確かめられるもの — 済

- `npm run lint` / `npm test`: **281件 パス**（`test/manifest.test.js` に
  「description が掲載文と同一」「version が README と同一」の2件を追加した）
- zip: `youtube-live-chat-filter-v2.0.0.zip`。同梱物は `src/` 以下のみ
  （`test/` `docs/` `node_modules` `.devcontainer` が無いことを `unzip -l` で確認）

### B. 偽 YouTube + 実 Chromium — 済（書き捨てのハーネスで自動化）

Chromium（Chrome for Testing 1234）に `--load-extension=src` で読み込み、
偽 `www.youtube.com` を見せて CDP から確認。**14項目すべてパス。**
主な結果:

- 権限は `alarms` / `scripting` / `storage` / `unlimitedStorage` の4つだけが付与され、
  `tabs` も `activeTab` も無い状態で全機能が動いた
- `chrome.permissions.getAll()` が返す `origins` は
  **`https://www.googleapis.com/*` とホスト単位に丸められる**。
  manifest にパスまで書いても Chrome の付与はホストまで（CLAUDE.md の
  「パスは通信の可否には効かない」の裏取り）。**審査と表示のための宣言**という位置づけは変わらない
- watch のトップフレームは content-script だけ、チャットの iframe は dom-chat だけ。
  ポップアウトのチャット窓（`/live_chat?is_popout=1`）でも content-script は立たない（#41）
- 自動開始 → 取り込み → IndexedDB → popup の描画までひと続きで通り、
  取り込みは全件（`normal` の役割と `superchat` の種別が両方入っていた）
- `#items` を差し替えたあとも新着が増え続けた（フェーズ7 の自己修復）
- `chrome.storage.local` の使用量は **287バイト**（設定とセッションだけ。履歴は IndexedDB）

**数千件ためたときの popup**（別のハーネスで計測。3,000件を流し込んだ状態）:

| 測ったもの | 結果 |
| --- | --- |
| IndexedDB への定着 | 3,013件（`primary` 1,009 / `bulk` 2,004。決定3 のとおり枠が分かれている） |
| `chrome.storage.local` の使用量 | **287バイト**（3,000件ためても増えない） |
| popup の描画 | 3,014行を描き切る |
| 検索の初回（`bulk` 枠の読み込み込み） | **155ms** |
| 2回目の検索（111件に絞る） | **172ms** |
| スクロール30回 | 合計 577ms・**最悪フレーム 105ms**（1フレームだけ 100ms を超えた） |

計測の但し書きが2つある。どちらも次に測るときに踏む。

- **popup を背面のタブに置いたままでは計測にならない。** 背面タブは
  `setTimeout` が1秒に間引かれ `requestAnimationFrame` も回らないため、
  最初の計測では検索が2秒かかったように見えていた（実際は155ms）。
  本物のツールバーのポップアップは前面なので、**計測の直前に popup のタブを前面へ出す**。
  ただし読み込みは背面のまま行う（`tabs.query({ active: true, currentWindow: true })` が
  YouTube のタブを指している必要があるため）
- **取り込み直後に IndexedDB を読むと 0 件のことがある。** 書き込みは 500ms の
  まとめ書き（`flushCommentsHistory`）なので、流し込みが終わってから読む

### C. 本物でしか踏めないもの — **未実施。ストア提出前に人がやる**

この環境には実配信もAPIキーも無いため、C の表は**1件も消化していない**。
とくに v2.0.0 は権限を絞っている（フェーズ9）ので、
**DOMモードとAPIモードの両方を実配信で1時間以上**流してから提出すること。
APIモードの確認はAPIキーを持っている開発者本人にしかできない。
