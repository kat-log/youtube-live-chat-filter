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

## 技術スタック

- HTML, CSS, JavaScript
- Chrome Extensions API
- YouTube Data API v3

## 開発コマンド

現在はまだ設定されていません。

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