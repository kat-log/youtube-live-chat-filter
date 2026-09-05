# YouTube ライブチャット特別コメントフィルター

このプロジェクトは、YouTubeライブチャットでモデレーター、メンバー（スポンサー）、配信者からのコメントのみを表示するChrome拡張機能です。

## プロジェクト構成

- `docs/` - 設計書などのドキュメント
- `src/` - Chrome拡張機能のソースコード
  - `manifest.json` - Chrome拡張機能のマニフェストファイル
  - `background/` - Background Scripts
  - `content/` - Content Scripts
  - `popup/` - ポップアップ画面のHTML/CSS/JS
  - `options/` - 設定画面のHTML/CSS/JS
- `test/` - テスト（Node標準の`node:test`。拡張機能本体には同梱されない）
  - `helpers/service-worker-harness.js` - chrome APIモックとService Workerローダー

## 技術スタック

- HTML, CSS, JavaScript
- Chrome Extensions API
- YouTube Data API v3

## 開発コマンド

```bash
npm test
```

ビルド不要。`src/` をそのまま「パッケージ化されていない拡張機能を読み込む」で使う。
リリース用zipは `/release` が生成する（`src/` 以下のみ同梱）。

### テストについて

依存パッケージなし。`test/helpers/service-worker-harness.js` が chrome API を
モックした vm コンテキストで `service-worker.js` を丸ごと評価し、内部の関数と
状態をテストへ露出させる。

対象は **Service Worker の状態機械** に限定している。過去に2度、
「数時間使い込まないと発現せず手動再現が困難」なバグが本番で発覚しているため
（Service Worker終了時のコメント取りこぼし、ストレージ肥大化による監視停止）、
その周辺を重点的に固定している。

モックの限界として、以下は検証できない:

- 実ブラウザの挙動（本物のquotaの出方、Service Workerが終了するタイミング、
  メッセージパッシングの実挙動）
- `dom-chat.js` のYouTube DOMスクレイピング（YouTube側のDOM変更には無力）
- ポップアップ／オプション画面のUI

`monitoringState` は `startDomMonitoring` などで丸ごと再代入されるため、
ハーネスは getter 経由で露出している。テストから直接参照を保持しないこと。

## 設計概要

ライブチャットのメッセージを取得し、フィルターに合うものだけをポップアップ画面に
リアルタイム表示する。取得元は2モードある。

- **DOMモード（既定・APIキー不要）**: `dom-chat.js` がライブチャットのDOMを直接監視する
- **APIモード**: YouTube Data API v3 の `liveChatMessages` をポーリングする

### フィルターの2軸

役割（発言者が誰か）と種別（何のメッセージか）は別の軸として扱う。
スーパーチャットは一般視聴者からも飛んでくるため、役割だけで絞ると取りこぼす。

| 軸 | フィルターキー | 対象 |
| --- | --- | --- |
| 役割 | `owner` / `moderator` / `sponsor` / `normal` | 配信者 / モデレーター / メンバー / 一般（APIモードでは `isChatOwner` などのフラグ、DOMモードでは `author-type` 属性で判定） |
| 種別 | `superchat` | スーパーチャット・スーパーステッカー |
| 種別 | `membership` | メンバー新規加入・継続（マイルストーン）・メンバーギフト |

種別が付いているメッセージは種別のフィルターで絞り、役割のフィルターは見ない。
判定は Service Worker の `isCommentEnabled()` に集約している。

保存済みの設定に新しいキーが無い場合（旧バージョンからの更新直後）は
`normalizeCommentFilters()` が既定値で補うため、更新した瞬間にスパチャが消えることはない。

なお、ギフトの受領告知（`giftMembershipReceivedEvent` /
`yt-live-chat-sponsorships-gift-redemption-announcement-renderer`）は
受け取った人数ぶん流れて量が多いため、意図的に対象外にしている。

## 次のステップ

1. manifest.jsonの作成
2. Background Scriptの実装
3. Content Scriptの実装
4. Popup画面の実装
5. APIキー管理機能の実装