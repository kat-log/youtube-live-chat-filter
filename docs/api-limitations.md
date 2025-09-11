# YouTube Data API v3 制限事項調査結果

## 調査日時
2025-09-11

## 概要
YouTube Data API v3の`liveChatMessages`エンドポイントについて、公式ドキュメントと実際の動作に差異があることが判明した。本ドキュメントはその調査結果を記録する。

## 制限事項の詳細

### liveChatMessages/list エンドポイント

#### 公式仕様
- **maxResults**: 200〜2,000件（デフォルト: 500件）
- **ソース**: https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list

#### 実測結果
- **実際の取得可能件数**: 最大75件程度
- **maxResultsパラメータの効果**: 1000を指定しても約69-75件しか取得できない
- **制限の性質**: 現在画面に表示されているメッセージ範囲のみ取得可能

#### 開発者コミュニティでの報告
- **Stack Overflow での報告**: 75件の制限が確認されている
- **参考URL**: https://stackoverflow.com/questions/39444145/youtube-v3-livechatmessages-list-only-returns-a-max-of-75-requests
- **投稿内容**: maxResults=250を設定しても75件しか返されない（2016年の報告）

### liveChatMessages/streamList エンドポイント

#### 公式仕様
- **maxResults**: 200〜2,000件（デフォルト: 500件）  
- **機能**: サーバーストリーミング接続による低遅延メッセージ受信
- **初回接続**: 最近のチャット履歴を送信（具体的件数は未記載）
- **ソース**: https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList

#### 想定される動作
- リアルタイム監視用途に最適化
- 初回接続時に一定量の履歴を送信後、新しいメッセージをリアルタイムで配信

## 推測される制限の原因

1. **表示範囲制限**: YouTube画面上に表示されているメッセージのみが取得対象
2. **メモリ効率**: 大量の履歴データ送信を避けるための制限
3. **リアルタイム重視**: 過去のメッセージより現在進行中のチャットを重視する設計

## 対処方法

### 現実的な解決策
1. **リアルタイム蓄積**: 配信開始時から継続的に監視し、新しいコメントを蓄積
2. **streamListエンドポイントの利用**: より多くの初期履歴が取得できる可能性
3. **制限の受け入れ**: 75件制限を前提とした機能設計

### 非推奨の方法
- YouTube画面の自動スクロール（技術的に複雑、仕様変更リスクあり）

## 注意事項

- この制限は公式ドキュメントに明記されていない**非公式な制限**
- YouTube側の仕様変更により、制限値が変動する可能性がある
- 実測値は配信状況や時期により変動する可能性がある

## 参考資料

### 公式ドキュメント
- [LiveChatMessages: list](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list)
- [LiveChatMessages: streamList](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList)
- [LiveChatMessages](https://developers.google.com/youtube/v3/live/docs/liveChatMessages)

### コミュニティ情報
- [Stack Overflow: YouTube V3 - LiveChatMessages.list only returns a max of 75 requests](https://stackoverflow.com/questions/39444145/youtube-v3-livechatmessages-list-only-returns-a-max-of-75-requests)