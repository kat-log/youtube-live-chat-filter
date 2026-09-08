# リリース手順と確認項目

ストアに出すまでにやることと、**何をどこまで確かめたか**を残す場所。
掲載文そのものは [`store-listing.md`](store-listing.md)、変更履歴は
[`../CHANGELOG.md`](../CHANGELOG.md) が正。

このファイルは「次のリリースでも同じ抜けを踏まない」ために置いている。
実際、v1.12.5 までは**バージョンの記載が README と manifest で食い違ったまま**だった（監査 #44）。

---

## 手順

1. `npm run lint` と `npm test` が通る
2. `src/manifest.json` の `version` を上げる。**`README.md` の冒頭と対で直す**
   （`test/manifest.test.js` が食い違いを落とす）
3. `CHANGELOG.md` に、利用者から見える変更だけを書く
4. `docs/store-listing.md` の掲載文を実体に合わせる。
   **短い説明は `manifest.json` の `description` と同一文字列**にする
   （こちらも `test/manifest.test.js` が固定している）
5. 権限を変えたなら「権限の説明（ストア審査用）」の表も直す
6. zip を作る（`/release`）。**同梱するのは `src/` 以下だけ**
7. 下の確認項目を実施する。実配信での確認は zip を出す前でも後でもよいが、
   **ストアに提出する前**に済ませる
8. ダッシュボードに掲載文・告知文・権限の説明を貼り、zip をアップロードする

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
