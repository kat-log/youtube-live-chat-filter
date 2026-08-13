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

YouTube Data API v3を使用してライブチャットメッセージを取得し、以下のフラグを持つコメントのみを抽出します：

- `isChatModerator`: モデレーターのコメント
- `isChatSponsor`: メンバー（スポンサー）のコメント  
- `isChatOwner`: 配信者本人のコメント

抽出されたコメントは拡張機能のポップアップ画面にリアルタイムで表示されます。

## 次のステップ

1. manifest.jsonの作成
2. Background Scriptの実装
3. Content Scriptの実装
4. Popup画面の実装
5. APIキー管理機能の実装