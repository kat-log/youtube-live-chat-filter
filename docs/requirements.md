# YouTube ライブチャット特別コメントフィルター MVP 設計書 (最終版)

## 1. 概要

本 Chrome 拡張機能は、YouTube ライブチャットにおいて、**配信者が設定したモデレーター、メンバー（スポンサー）、および配信者本人からのコメントのみを抽出して表示すること**を目的とします。これにより、通常のコメントの流れに埋もれがちな重要なコメントを見逃すことなく、効率的に確認できるようにします。

---

## 2. 機能要件

### 2.1 コメントの識別と抽出

- **API によるコメント情報の取得:** YouTube Data API v3 の`liveChatMessages`リソースを使用して、ライブチャットのメッセージデータを取得します。
- **特別アカウントの識別:** 取得した`liveChatMessages`の`authorDetails`プロパティに含まれる以下のフラグを確認し、特別アカウントのコメントを識別します。
  - `isChatModerator`: コメントがモデレーターによるものであるかを識別します。
  - `isChatSponsor`: コメントがメンバー（スポンサー）によるものであるかを識別します。
  - `isChatOwner`: コメントが配信者本人によるものであるかを識別します。
- **コメントのフィルタリング:** 上記のいずれかのフラグが`true`であるコメントのみを抽出します。

### 2.2 コメントの表示

- **独立したポップアップ表示:** Chrome 拡張機能のアイコンをクリックした際に表示される**ポップアップウィンドウ**内に、フィルタリングされた特別コメントのみを時系列順に表示します。
- **リアルタイム更新:** ライブチャットの更新に合わせて、ポップアップ内のコメントリストもリアルタイムに更新されるようにします。
- **コメント内容の表示:** 抽出されたコメントは、投稿者のユーザー名とコメント内容が識別できるように表示します。
  - 例: `[モデレーター] ユーザー名: コメント内容`
  - 例: `[メンバー] ユーザー名: コメント内容`
  - 例: `[配信者] ユーザー名: コメント内容`

### 2.3 API キーの管理

- **API キー入力インターフェース:** Chrome 拡張機能のポップアップ、または専用の設定ページ（`options_page`）を介して、ユーザーが YouTube Data API キーを入力できるフォームを提供します。
- **API キーの永続化:** 入力された API キーは、Chrome の`chrome.storage.local` API などを使用してユーザーのローカル環境に安全に保存し、拡張機能の再起動後も利用できるようにします。
- **API キーの利用:** Background Script から API を呼び出す際に、保存された API キーを使用します。

---

## 3. 非機能要件 (MVP フェーズ)

- **パフォーマンス:** 現時点では、極端なパフォーマンス劣化がなければ詳細なチューニングは行いません。
- **設定の保存:** MVP ではユーザー設定の保存機能は API キー以外は実装しません。
- **ブラウザ互換性:** Chrome ブラウザのみを対象とします。

---

## 4. 技術スタック

- **フロントエンド:** HTML, CSS, JavaScript
- **Chrome 拡張機能 API:**
  - `chrome.runtime` (メッセージングなど)
  - `chrome.tabs` (現在のタブの URL 取得など)
  - `chrome.action` (ポップアップ表示トリガー)
  - `chrome.storage` (API キーの保存)
- **データ取得:** YouTube Data API v3

---

## 5. 設計詳細

### 5.1 アーキテクチャ概要

- **Background Script:**
  - Chrome 拡張機能のライフサイクル管理。
  - 保存された API キーの取得と管理。
  - YouTube Data API との通信管理。
  - Content Script からのリクエストを受けて API を呼び出し、結果を Content Script または Popup Script に返す。
- **Content Script:**
  - YouTube のライブ配信ページに注入され、現在のライブチャット ID などを取得。
  - Background Script にライブチャットメッセージの取得をリクエスト。
  - 取得した特別コメントを Popup Script に渡す。
- **Popup Script & Popup HTML:**
  - ユーザーが拡張機能アイコンをクリックした際に表示される UI。
  - Content Script から受け取った特別コメントを表示。
  - API キー入力フォームの表示と、入力された API キーの保存処理。

### 5.2 データフロー

1.  ユーザーは拡張機能のポップアップまたは設定ページから YouTube Data API キーを入力し、保存する。
2.  ユーザーが YouTube ライブ配信ページを開く。
3.  Content Script がページに注入され、現在のライブチャットの ID などを取得。
4.  Content Script が Background Script に対し、ライブチャットメッセージの定期的な取得を要求。
5.  Background Script が保存された API キーを使用し、YouTube Data API v3 の`liveChatMessages.list`エンドポイントを定期的にポーリング。
6.  API レスポンスから`isChatModerator`、`isChatSponsor`、または`isChatOwner`のいずれかが`true`のコメントをフィルタリング。
7.  フィルタリングされたコメントを Background Script から Content Script へ送信。
8.  Content Script が、抽出されたコメントを Popup Script へ送信。
9.  Popup Script が受信したコメントを Popup HTML に表示。

### 5.3 ユーザーインターフェース (UI)

- **ポップアップウィンドウ:** シンプルなリスト形式でコメントを表示します。各コメントは投稿者の表示名とコメント内容を含みます。
  - 例: `[モデレーター] ユーザー名: コメント内容`
  - 例: `[メンバー] ユーザー名: コメント内容`
  - 例: `[配信者] ユーザー名: コメント内容`
- **API キー入力フォーム:** ポップアップ、またはオプションページ内に、API キーを入力するためのテキストフィールドと保存ボタンを設けます。
- **アイコン:** Chrome ツールバーに表示される拡張機能のアイコン（例: ライブチャット関連の分かりやすいアイコン）をクリックすることでポップアップが表示されるようにします。

---

## 6. 今後の展望 (MVP 後)

- YouTube Data API の利用クォータに関する考慮と、クォータ消費状況の表示。
- 「ユーザー任意のアカウント」のコメント抽出機能と設定保存。
- コメントの表示形式（ハイライト、通知など）のオプション追加。
- パフォーマンス最適化。
- より詳細なフィルタリングオプション（例: 特定のキーワードを含むコメントのみ）。
- API キーの有効性チェック機能の強化。
- **アーカイブ配信（VOD）におけるコメント対応:** ライブ終了後のアーカイブ動画でも、特別アカウントのコメントを抽出・表示できるようにする。
