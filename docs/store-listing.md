# Chrome ウェブストア掲載情報

ストアの掲載文はこのファイルを正とする。機能を追加・変更したら、コードと一緒にここも更新すること。
（ストア側への反映は手動。デベロッパーダッシュボードに貼り付ける）

最終更新: 2026-10-01（英語対応。名前・詳細な説明・スクリーンショット・告知文の英語版を追加）

**英語版の掲載文**はこのファイルの「・英語」の付いた節にある。ストアは掲載文を言語ごとに持つので、
ダッシュボードの「ストアの掲載情報」で言語に English を追加し、英語の節を貼る。
**名前と短い説明だけは貼らない**（manifest の `__MSG_` が `_locales/<lang>/messages.json` から
言語ごとに引くので、zip をアップロードすれば両方の言語に入る）。日英以外の言語の閲覧者には
`default_locale` の `en` が出る。

v1.11.0 でスーパーチャット・スーパーステッカーとメンバーシップ（新規加入・継続・ギフト）を
取り込むようになった。「役割（配信者／モデレーター／メンバー／一般）」とは別に「種別」の軸が増え、
フィルターのトグルが4つから6つになっているため、掲載文の本文もあわせて書き換えている。

v1.12.0 でスーパーステッカーの画像そのものをポップアップに出すようになった（DOMモードのみ）。
見た目が変わる変更なので、掲載中のスクリーンショットも差し替え対象。
v1.12.4 / v1.12.5 では検索の取りこぼしを直し、全角・半角、末尾スペース、チャットからコピーした
文字列に混ざる不可視文字を吸収するようにしている。

**v2.0.0**（再設計フェーズ0〜9）で、掲載文に関わる変更が3つある。
(a) 取り込みが全件になり、**フィルターの切り替えが過去のコメントにも効く**
（「特別なコメントだけを取得」という書き方は決定的に嘘になった）、
(b) **要求する権限が減った**（`activeTab` と `tabs` を削除、googleapis を API のパスに限定）。
審査でもレビューでも効くので、掲載文と告知の両方に書く、
(c) 履歴の保存先が IndexedDB になり、長時間の配信でも重くならない。
変更の一覧は [`../CHANGELOG.md`](../CHANGELOG.md) が正。

**v2.1.0 / v2.1.1** で、コメント中の絵文字（メンバー限定絵文字と YouTube 標準の絵文字）を
名前の文字ではなく画像で出すようになった（DOMモードのみ）。見た目が変わる変更なので、
絵文字が写っているスクリーンショットがあれば差し替え対象。

**v2.2.0** で、YouTube のチャット欄で発言者を Alt+クリックすると、その人で絞り込んだ状態で
ポップアップが開くようになった（両モード）。ポップアップ自体の見た目は変わらないので、
スクリーンショットの差し替えは要らない。

**英語対応**（未リリース。`docs/i18n-plan.md`）で、ポップアップと設定画面が英語でも出るようになった。
表示言語はブラウザに従い、設定画面で English / 日本語 を選ぶこともできる。英語の掲載文とスクリーンショットを
新たに用意する（下の「・英語」の節）。日本語の見た目は変わっていないので、日本語のスクリーンショットはそのまま使える。

---

## 名前（75文字以内）

`src/_locales/<lang>/messages.json` の `extName`。manifest の `name` と、ツールバーのツールチップ
（`action.default_title`）にも使われる。ここを直したら messages.json も揃えること（`test/manifest.test.js` が突き合わせる）。

日本語:

```
YouTube特別コメントフィルター
```

英語:

```
YouTube Special Comments Filter
```

---

## 短い説明（132文字以内）

ストアの検索結果とカード表示に出る。**`src/manifest.json` の `description`（= `__MSG_extDescription__`）が
言語ごとに `src/_locales/<lang>/messages.json` の `extDescription` から引かれる**ので、
ここを直したら messages.json も同じ文言に揃えること（`test/manifest.test.js` が突き合わせる）。
日本語は `_locales/ja`、英語は `_locales/en`。

```
APIキー不要。YouTubeライブチャットの配信者・モデレーター・メンバーのコメントとスーパーチャット・メンバー加入を取り込んで表示。フィルターは過去のコメントにも効き、キーワード検索や発言者での絞り込みにも対応。
```

（108文字）

## 短い説明・英語（132文字以内）

英語（と、日英以外のすべての言語。`default_locale` が `en`）のストアで出る。`src/_locales/en/messages.json` の
`extDescription` と同一文字列。英語版の詳細な説明は下の「詳細な説明・英語」。

```
No API key needed. Shows streamer, moderator and member comments, Super Chats and memberships from YouTube live chat, with search.
```

（130文字）

---

## 詳細な説明

```
YouTubeライブチャットの重要なコメントを見逃さない！

YouTubeのライブ配信では大量のコメントが流れるため、重要なメッセージを見逃しがちです。
この拡張機能では、ライブチャットの流れを以下の6種類に分けて、見たいものだけを表示できます↓

✅ 配信者本人のコメント – ストリーマー自身からの直接メッセージ
✅ モデレーターのコメント – チャンネルの管理者からの重要な連絡
✅ メンバー（スポンサー）のコメント – チャンネルをサポートしているファンからのメッセージ
✅ 一般のコメント – その他すべてのユーザーのメッセージ
✅ スーパーチャット – 投げ銭とスーパーステッカー。金額つきで表示され、ステッカーは画像も出ます
✅ メンバー加入・ギフト – 新規加入、継続（マイルストーン）、メンバーシップギフト

★ スーパーチャットとメンバー加入も逃しません
投げ銭やメンバー加入は通常のコメントとは別のメッセージとして流れるため、
「気づいたら画面から消えていた」が起こりがちです。金額や加入の告知をそのまま残して一覧できます。
スーパーチャットは一般の視聴者からも飛んでくるので、発言者の役割とは切り離して表示・非表示を切り替えられます。

★ APIキーなしで、インストールしてすぐ使えます
ライブチャットを直接読み取るモードを標準搭載。面倒な事前設定は不要です。
（YouTube Data API v3を使うモードも選べます）

★ あとからフィルターを変えれば、過去のコメントも出てきます
表示を切り替えるだけなので、「一般コメントもやっぱり見たい」と思ったときに
それまで隠れていた分もまとめて出てきます。取りこぼしはありません。

★ 必要最小限の権限しか要求しません
読み取るのは YouTube のライブチャットだけです。他のタブのURLやタイトルは見ません。
外部への通信は、APIモードを使うときの YouTube Data API v3 だけです。

主な機能：
	•	取得を始めた時点でチャット欄に残っている過去のコメントもまとめて取り込み。「面白いコメントが流れていってしまった」あとからでも拾えます
	•	リアルタイムでフィルタリング（配信者／モデレーター／メンバー／一般／スパチャ／加入・ギフトをワンクリックで切り替え）
	•	「特別」「すべて」「なし」のプリセットで表示をまとめて切り替え
	•	スーパーチャットは金額を、メンバー加入は告知の文言をそのまま表示
	•	スーパーステッカーは画像もそのまま表示。どのステッカーが飛んできたかが見た目でわかります
	•	メンバー限定絵文字やYouTubeの絵文字も、名前の文字ではなく画像で表示。チャット欄と同じ見た目で読めます
	•	種別ごとの件数を表示。その配信でスパチャや加入が何件あったかがひと目でわかります
	•	ユーザー名クリックで、その人のコメントだけを表示
	•	YouTubeのチャット欄でも、名前かアイコンを Alt+クリック（Mac は Option+クリック）すると、その人で絞り込んだ状態でポップアップが開きます
	•	キーワード検索で、流れていったコメントをあとから絞り込み。チャットからコピーした語や全角・半角の違いもそのまま引けます
	•	アイコン画像つき表示で、誰の発言かひと目でわかる
	•	配信ごとにコメントを保存。ポップアップを閉じても消えません（直近5配信ぶん）
	•	ダークモード対応。設定画面も同じテーマになります
	•	時刻表示を24時間／12時間（AM・PM）で切り替え。秒の表示・非表示も選べます
	•	ライブ配信ページを開くと自動で取得開始
	•	チャットを読み取れているかを表示。動いているのに増えないのか、読めていないのかがわかります
	•	Tabキーだけでフィルターとダークモードを操作できます
	•	長時間の配信でも軽いまま。数千件たまってもスクロールと検索が引っかかりません
	•	表示言語は日本語と英語。ブラウザの言語に合わせて切り替わり、設定画面で選ぶこともできます

使い方：
	1.	YouTubeのライブ配信ページを開く
	2.	拡張機能アイコンをクリック
	3.	重要なコメントだけが表示されます

※ 自動で始まらない場合は「開始」ボタンを押してください。
※ YouTube Data API v3モードを使う場合のみ、設定画面でAPIキーの登録が必要です。

配信者の方、ライブ配信をよく見る方におすすめの便利ツールです！
```

---

## 詳細な説明・英語

上の日本語版の訳。**用語は popup の英語表示（`_locales/en/messages.json`）に揃える**:
役割は Streamer / Moderator / Member / Regular、種別は Super Chat / Joins & gifts、
プリセットは Special / All / None、ボタンは Start。画面と違う呼び方をすると、説明を読んだ人が画面で見つけられない。
日本語版にある「YouTubeの絵文字」「Tabキー」などの各項目は、根拠も含めて下の「記載内容の根拠」がそのまま当てはまる。

```
Never miss the important comments in YouTube live chat!

Live chat on YouTube moves fast, and important messages are easy to miss.
This extension sorts the live chat into the six groups below, so you can show only what you want to see:

✅ Streamer – messages from the streamer themselves
✅ Moderator – important notices from the channel's moderators
✅ Member – messages from fans who support the channel with a membership
✅ Regular – messages from everyone else
✅ Super Chat – paid messages and Super Stickers, shown with the amount; stickers are shown as images too
✅ Joins & gifts – new members, membership milestones and gifted memberships

★ Never lose a Super Chat or a new member again
Super Chats and membership announcements arrive separately from regular comments,
so they often scroll away before you notice them. Here they stay, with the amount and the announcement as they were.
Super Chats can come from any viewer, so you can show or hide them independently of who sent them.

★ No API key needed – it works right after you install it
The default mode reads the live chat on the page directly. No setup required.
(A mode that uses the YouTube Data API v3 is also available.)

★ Change the filters later and past comments appear too
The filters only change what is shown, so when you decide you want regular comments after all,
everything that was hidden until then shows up at once. Nothing is lost.

★ Only the permissions it needs
It reads only YouTube live chat. It does not look at the URLs or titles of your other tabs.
The only outside connection is the YouTube Data API v3, and only when you use API mode.

Features:
	•	Picks up the past comments still in the chat when you start, so you can catch up on a comment that already scrolled away
	•	Real-time filtering (Streamer / Moderator / Member / Regular / Super Chat / Joins & gifts, one click each)
	•	"Special", "All" and "None" presets to switch everything at once
	•	Super Chats show their amount, and membership events show their announcement as is
	•	Super Stickers are shown as images, so you can see which sticker was sent
	•	Member-only emoji and YouTube emoji are shown as images, not as their names – just like in the chat
	•	Counts for each group, so you can see at a glance how many Super Chats and new members a stream had
	•	Click a user name to show only that person's comments
	•	In the YouTube chat itself, Alt+click (Option+click on Mac) a name or avatar to open the popup filtered to that person
	•	Keyword search to find comments that already scrolled away. Text copied from the chat and full-width/half-width differences still match
	•	Avatars next to each comment, so you can tell who said what at a glance
	•	Comments are saved per stream and stay after you close the popup (last 5 streams)
	•	Dark mode, including the settings page
	•	24-hour or 12-hour (AM/PM) time, with or without seconds
	•	Starts automatically when you open a live stream page
	•	Shows whether the chat is being read, so you can tell "no new comments" from "can't read the chat"
	•	Filters and dark mode can be operated with the Tab key alone
	•	Stays fast on long streams – scrolling and search stay smooth with thousands of comments
	•	English and Japanese. Follows your browser language, or choose one on the settings page

How to use:
	1.	Open a YouTube live stream page
	2.	Click the extension icon
	3.	The important comments are shown

* If it does not start automatically, click "Start".
* An API key (set on the settings page) is only needed if you use the YouTube Data API v3 mode.

A handy tool for streamers and anyone who watches live streams a lot!
```

---

## 更新の告知文（英語対応のリリース。バージョン未定）

英語対応を出すときに使う下書き。**バージョンを決めたら見出しと1行目の番号を直す**。
日本語版は日本語の掲載情報に、英語版は English の掲載情報に貼る。
英語の利用者にとってはこれが最初の告知なので、英語版は「何が変わったか」ではなく「英語で使えるようになった」だけを書く。
権限は増えていないので、更新で拡張機能が無効化されることはない。

```
このバージョンから、英語でも使えるようになりました。

■ 表示言語を選べるようになりました
ポップアップと設定画面が、日本語と英語に対応しました。
・ふだんはブラウザの言語に合わせて切り替わります（日本語のブラウザではこれまでどおり日本語です）
・設定画面の「言語」で、English / 日本語 を選ぶこともできます
・拡張機能の名前とツールバーのツールチップは、Chrome の仕様でブラウザの言語のままです

・要求する権限は変わっていません
```

```
The extension is now available in English.

■ English is now supported
The popup and the settings page are now available in English and Japanese.
・They follow your browser language by default
・You can also choose English or 日本語 under "Language" on the settings page
・The extension name and the toolbar tooltip always follow the browser language (a Chrome limitation)

・No new permissions are requested
```

---

## 更新の告知文（v2.2.1）

ダッシュボードの「このバージョンの新機能」や、公開後の案内に貼る。
v2.1.2 〜 v2.2.1 をまとめて書いている（途中のバージョンを公開していなくても、利用者から見た差分はこれで足りる）。
v2.1.3 までを告知済みなら、「アイコン」の段落は削ってよい。
Alt+クリックは DOMモード・APIモードのどちらでも効く（`dom-chat.js` はモードに関係なくチャット欄に入る）ので、
モードの注記は付けない。Mac では Alt が Option キーなので**併記する**。
ポップアップが自動で開くのは Chrome 127 以降（`chrome.action.openPopup()`）。
開かなくても次に手で開いたときに効くので、告知では「開かないときは」の一文で済ませる。
権限は増えていないので、更新で拡張機能が無効化されることはない。

```
v2.2.1 では、YouTube のチャット欄から直接、発言者で絞り込めるようになりました。

■ チャット欄から発言者を絞り込めるようになりました
YouTube のチャットで、気になる人の名前かアイコンを Alt+クリック（Mac は Option+クリック）すると、
その人のコメントだけに絞り込んだ状態でポップアップが開きます。
・普通のクリックはこれまでどおり YouTube のメニュー（ブロック・報告など）が開きます
・ポップアップが自動で開かないときは、拡張機能のアイコンを押すと絞り込んだ状態で開きます

■ 直したこと
・配信者・モデレーターの発言もスーパーチャットも無い配信で、メンバー・一般のコメントがポップアップを開いたあとの分しか出なかったのを直しました。閉じて開き直しても、保存済みのコメントがすべて表示されます
・コメント一覧のアイコンが頭文字（@）のままになることが多かったのを直しました。アイコンは用意でき次第、表示中の行にもあとから入ります

・要求する権限は変わっていません
```

---

## 更新の告知文（v2.1.1）

ダッシュボードの「このバージョンの新機能」や、公開後の案内に貼る。
v2.1.0 と v2.1.1 をまとめて書いている（2.1.0 だけを公開していない場合でも、利用者から見た差分はこれで足りる）。
**「DOMモードのみ」は必ず入れる**（APIモードは画像URLが取れず、名前の文字のまま出る）。
権限は増えていないので、更新で拡張機能が無効化されることはない。

```
v2.1.1 では、コメント中の絵文字が画像で表示されるようになりました。

■ 絵文字が画像で表示されるようになりました
これまでは「:_hearts:」のような絵文字の名前が文字のまま出ていました。
メンバー限定絵文字も、YouTube 標準の絵文字も、チャット欄と同じ画像で表示します。
・画像が読み込めなかったときは、これまでどおり名前の文字を出します
・APIキーを使わない標準のモード（DOMモード）が対象です。APIモードは YouTube から画像を受け取れないため、従来どおり名前の文字のままです
・要求する権限は変わっていません
```

---

## 更新の告知文（v2.0.0）

ダッシュボードの「このバージョンの新機能」や、公開後の案内に貼る。
**「権限が減ったこと」は必ず入れる**（利用者にとって良い知らせで、審査でも効く）。
権限は減る方向なので、更新で拡張機能が無効化されることはない。

```
v2.0.0 では中身を作り直しました。

■ 要求する権限が減りました
これまで要求していた「すべてのタブのURLとタイトルを読む権限」（tabs / activeTab）を削除しました。
外部への通信も、APIモードを使うときの YouTube Data API v3 だけに限定しています。

■ フィルターが過去のコメントにも効くようになりました
チャットは全部取り込んでおいて、表示だけを絞る形に変えました。
あとからトグルをONにすれば、それまで隠れていたコメントも遡って出てきます。

■ 止まりにくく、重くなりにくくなりました
・数千件たまってもポップアップのスクロールと検索が引っかかりません
・しばらく放置していても取得が止まりません。APIの割り当てエラーからも自動で復帰します
・YouTubeの「上位のチャット ↔ チャット」を切り替えても止まりません
・チャットを読み取れているかがポップアップの上部に出ます

■ そのほか
・Tabキーだけでフィルターとダークモードを操作できます
・設定画面もダークテーマになります
・コメントの保存先を変更しました。これまでの履歴（直近5配信ぶん）はそのまま引き継がれます
```

---

## 権限の説明（ストア審査用）

ダッシュボードの「権限の正当性」に貼る。正は `manifest.json` で、内容は
`test/manifest.test.js` が固定している（増やすとテストが落ちる）。
実装の根拠は [`../CLAUDE.md`](../CLAUDE.md) の「権限（`manifest.json`）」の節。

| 権限 | 何に使うか | 根拠 |
|---|---|---|
| `storage` | 表示フィルター・テーマ・時刻表示・動作モード・APIキーの保存と、監視中のセッション状態（どの動画を見ているか）の保持。`chrome.storage.local` のみで、同期はしない | `options.js` / `popup.js` / `service-worker.js` |
| `unlimitedStorage` | コメント履歴（直近5配信ぶん）を IndexedDB に保存する。長時間の配信では1配信で数万件になり、既定の枠では途中で書けなくなって取得が止まる | `shared/store.js`（`primary` 20,000 / `bulk` 50,000 件） |
| `scripting` | ライブチャット（`/live_chat` の iframe）へ読み取りスクリプトを注入する。YouTube はページ遷移でリロードしない（SPA）ため manifest の自動注入が走らず、拡張機能の更新直後も既に開いているタブには届かない。その2つの場合にだけ呼ぶ | `service-worker.js` の `injectDomChat()` / `reinjectContentScripts()` |
| `alarms` | 1分ごとの見張り。Service Worker が終了して取得が止まっていないか、APIの割り当て（quota）エラーから復帰できるかを定期的に確かめる | `service-worker.js` の「番人」 |
| `https://*.youtube.com/*` | ライブチャットの読み取りと、対象タブが YouTube かどうかの判定。**ここだけで済ませるために `tabs` 権限を落とした**（タブのURLはホスト権限があれば読める） | `content/dom-chat.js` / `content/content-script.js` |
| `https://www.googleapis.com/youtube/v3/*` | APIモードを選んだときだけ、YouTube Data API v3 でチャットを取得する。利用者が設定画面で登録した自分のAPIキーを使う。DOMモード（既定）では一度も通信しない | `service-worker.js` の `liveChat/messages` と `videos`、`options.js` の疎通テスト |

### `alarms` の正当性（そのまま貼る文面）

2026-09 の審査で「alarms の権限を要求する理由が必要です。[プライバシーへの取り組み] タブで
入力してください」と個別に求められた。以下を**そのまま**貼る（796文字。入力欄の上限は1000文字）。
実装は `service-worker.js` の「番人」（`WATCHDOG_PERIOD_MINUTES = 1` /
`DOM_SILENCE_LIMIT_MS = 3分`）で、**数字を変えたらこの文面も直すこと**。

```
alarms は、コメントの取得が止まっていないかを1分ごとに自己点検し、止まっていれば再開するためだけに使用します。

本拡張機能は Manifest V3 のため、Service Worker が約30秒のアイドルで終了します。終了すると setTimeout などのタイマーも一緒に失われ、ライブチャットの取得が利用者に気づかれないまま停止します。実際に次の2つの停止が起きていました。

(1) APIモードで割り当て超過（quota）に達したあとの60秒待ちが Service Worker の終了で消え、ポップアップを開き直すまでポーリングが再開しない。
(2) DOMモードで、YouTube 側がチャット欄を作り替えた際に読み取りが外れ、ページを開いたままなのにコメントが一件も届かなくなる。

chrome.alarms は Service Worker が終了していても拡張機能を起こせる唯一の手段のため、監視を開始したときだけ1分周期のアラームを1つ登録します。起床のたびに「監視中のはずなのに取得が動いていないか」を確認し、APIモードではポーリングを張り直し、DOMモードでは3分以上コメントが届いていない場合にだけ読み取りスクリプトを入れ直します。監視を停止したときはアラームを削除します。

アラームで行うのは自身の状態の点検と復旧だけです。通知の表示、定期的な外部への通信、利用者データの送信は一切行いません。取得したコメントは端末内（storage.local と IndexedDB）にのみ保存されます。

代替手段も検討しましたが、setTimeout / setInterval は Service Worker の終了で失われるため使えず、ポップアップを開いている間だけ点検する方式では閉じている間の停止を検知できないため、alarms が必要です。
```

書くときに外せない3点（審査で見られているのはここ）:

- **なぜ他の手段では駄目か**（MV3 の Service Worker が約30秒で終了し `setTimeout` が消える）
- **何をしないか**（通知を出さない・定期的な外部通信をしない・データを送らない）
- **いつ登録して、いつ消すか**（監視中だけ。1分周期のアラーム1つ）

審査で併せて聞かれるものへの答え:

- **単一用途**: YouTube のライブチャットを取り込んで、見たいものだけを絞り込んで表示する
- **リモートコードの実行**: しない。すべてのコードを拡張機能に同梱している（ビルド手順も無い）
- **データの収集・送信**: しない。コメントも設定も端末内（`storage.local` と IndexedDB）にとどまる。
  外部への通信はAPIモードの `googleapis.com` だけで、宛先は利用者自身のAPIキーで叩く YouTube API

---

## 記載内容の根拠（更新時の確認ポイント）

掲載文が実装から乖離しやすい箇所と、その根拠コード。

| 記載 | 根拠 |
|---|---|
| APIキー不要が標準 | `popup.js` / `service-worker.js` とも `chatMode` の既定は `'dom'`（`result.chatMode \|\| 'dom'`） |
| 開くと自動で始まる | `autoStart` の既定は `true`（`service-worker.js` の `result.autoStart ?? true`）。DOMモードは `content-script.js` の `tryDomModeAutoStart()` がAPIキー無しで開始する |
| APIモードは自動開始にキーが要る | `content-script.js` の `tryAutoStart()` はキー未設定ならスキップする |
| 履歴は直近5配信ぶん | `shared/store.js` の `MAX_HISTORY_VIDEOS = 5`（保存は IndexedDB。1配信あたりの上限は保持枠ごとに `primary` 20,000 / `bulk` 50,000） |
| 開始前の過去コメントも取り込む | `service-worker.js` の `startDomMonitoring()` が `requestInitialSweep` を `force: true` で送り、`dom-chat.js` がチャット欄に残っている分を全件送り直す。取れるのはYouTubeがDOMに保持している範囲（およそ直近200件）だけで、それより前は遡れない |
| ポップアップを開くだけで壊れない | v1.10.1 で `content-script.js` 全体を `window.__ytSpecialCommentsInitialized` ガードで囲み、`reinjectContentScripts()` は ping で生存確認して動作中のタブをスキップする。「動かないので再インストール」系のレビューにつながる挙動なので、掲載文で安定性をうたう際はここを確認する |
| 6種類に分けて表示 | `shared/comment.js` の `FILTER_KEYS`（`owner` / `moderator` / `sponsor` / `normal` / `superchat` / `membership`）とトグルが1対1で対応する。「特別なコメントのみ」という書き方は一般コメントを出せる現状と矛盾するため使わない |
| 取り込みは全件で、フィルターは表示側だけ | 取り込み口が見るのは `shared/comment.js` の `isDisplayableKind()` だけ（再設計の決定1）。「特別なコメントだけを取得」と書くと嘘になる —— あとからトグルをONにすれば過去分も出る |
| 権限は最小限 | `manifest.json` の `permissions` は `storage` / `unlimitedStorage` / `scripting` / `alarms` の4つ、ホストは `https://*.youtube.com/*` と `https://www.googleapis.com/youtube/v3/*` だけ（2026-09 に `activeTab` と `tabs` を削除）。審査で必ず聞かれるので、増やしたらここも直す |
| スパチャは役割と切り離して切り替えられる | 種別を持つメッセージは種別のフィルターだけを見て、役割のフィルターは参照しない（スパチャは一般視聴者からも飛んでくるため、役割で絞ると取りこぼす） |
| 拾うのはスパチャ／ステッカー／加入・継続・ギフト購入 | DOMモードは `dom-chat.js` の監視対象タグ（`yt-live-chat-paid-message-renderer` / `paid-sticker` / `membership-item` / `sponsorships-gift-purchase-announcement`）、APIモードは `service-worker.js` の `KIND_BY_API_TYPE`（`superChatEvent` / `superStickerEvent` / `newSponsorEvent` / `memberMilestoneChatEvent` / `membershipGiftingEvent`）。**ギフトの受領告知は受け取った人数ぶん流れて量が多いため対象外**なので、「ギフト対応」と書くときは購入の告知だけを指すことに注意 |
| 金額・件数を表示 | 金額チップは `shared/comment.js` の正準形の `amountText` / `dom-chat.js` の `extractDetail()`、件数バッジは `superchat-count` / `membership-count` |
| ステッカーの画像を表示 | `dom-chat.js` が `#sticker img` から `stickerUrl` を拾い（新着も全件スキャンも `waitForStickerImage()` で `src` が入るまで待つ）、`popup.js` の `stickerHtml()` が `img` で描く。**DOMモードのみ**で、APIモードは画像URLを返さないため出ない。URLは `safeStickerUrl()` が `STICKER_IMAGE_HOSTS` のホストだけ通す。画像が出せなくてもステッカー名は本文として残る |
| 絵文字を画像で表示 | `dom-chat.js` の `extractMessageContent()` が本文中の `img` の `alt`（`shared/comment.js` の `isEmojiLabel()` で名前らしいものだけ）と URL を拾い、`extractEmojiUrl()` が YouTube の画像ホスト（`*.ggpht.com` / `*.googleusercontent.com` / `www.youtube.com` の静的ファイル）だけを通す。**DOMモードのみ**で、APIモードは画像URLを返さないため名前の文字のまま。画像が出せないときも名前の文字が残る。コロンで囲まれていない名前（`2BROOtojya` など）も対象（v2.1.1） |
| チャット欄の Alt+クリックで絞り込める | `dom-chat.js` の `onAuthorClick()`（修飾キーは `USER_FILTER_MODIFIER = 'altKey'`。Mac の Option も `altKey` になる）が表示名を送り、`service-worker.js` が `pendingUserFilter` に置いて `chrome.action.openPopup()` で開く。popup は `takePendingUserFilter` で受け取る。**両モードで効く**（`dom-chat.js` はモードに関係なくチャット欄に入る）。自動で開くのは Chrome 127 以降だけで、開けなくても置いたぶんは10分間残り、次に手で開いたときに効く。**素のクリックは YouTube のメニューのまま**なので、「クリックで絞り込み」とは書かない（v2.2.0） |
| チャットを読み取れているかが出る | `popup.html` の `#chat-health`（DOMモードで監視中だけ出る。読めていれば緑の点）。状態は `dom-chat.js` が返す `health` を Service Worker 経由で受ける |
| Tabキーだけで操作できる | フィルターとテーマの操作要素がフォーカス可能で、フォーカスリングを消していない（フェーズ8）。**「すべての操作ができる」とは書かない**。到達性を上げただけで、全機能のキーボード操作を保証してはいない |
| 設定画面もダークテーマになる | `options.html` が `shared/theme.js` を読み、`storage.onChanged` でポップアップ側の切り替えにも追従する |
| 数千件でも軽い | popup の一覧は新着分だけを足す描画で、`bulk` 枠は検索を始めた時点で読む（決定4・5）。**実測は長時間配信での確認に依存する**ので、断定的な数字は書かない |
| コピーした語でも検索が引ける | `shared/comment.js` の `normalizeForSearch()` が NFKC 正規化（全角・半角の吸収）＋不可視文字の除去＋ `trim()` を通す。検索対象の文字列（`searchText`）は取り込み時に1件ずつ作る |
| 日本語と英語。ブラウザに従い、設定画面でも選べる | 文言は `src/_locales/{en,ja}/messages.json`、引くのは `shared/i18n.js` の `t()`。設定画面の言語セレクト（`#ui-language`）が `storage.local.uiLanguage` に `auto` / `en` / `ja` を保存する。**名前とツールバーのツールチップは manifest 由来なのでブラウザの言語のまま**（Chrome の仕様）。だから「すべての表示を選べる」とは書かない。日英以外のブラウザでは英語になる（`default_locale: "en"`） |

### 過去に古くなっていた記述

- **「使い方 1. YouTube APIキーを設定」** — DOMモード追加でキーが不要になった後も残っていた。
  ストアで最大級の離脱要因になるため、機能追加時は真っ先に見直す
- **「YouTube Data API v3を使用した確実な抽出」** — APIモードが選択制になった時点で
  機能の売りとしては位置づけが変わっている
- **「4種類に分けて」** — v1.11.0 で種別（スパチャ／加入・ギフト）が増えて6種類になった。
  トグルの数を書くときは `popup.js` の `FILTER_KEYS` と突き合わせること
- **ステッカーを「金額つきで表示」だけと書く** — v1.12.0 で画像表示が入っている。
  ただし画像が出るのはDOMモードだけなので、「必ず出る」とは書かないこと

## スクリーンショット

v1.11.0 でフィルターのトグルが6つに増え、スパチャの金額チップとメンバー加入の告知行が表示に加わった。
掲載中のスクリーンショットが v1.10.x 以前のものなら差し替えが必要（トグルが4つのままなら古い）。

v1.12.0 でスーパーステッカーの画像がコメント行に出るようになったので、スパチャを写した
スクリーンショットは撮り直したほうが実物に近い。あわせて一般バッジのコントラストと
フィルターのON/OFF表示も変わっている。

v2.0.0 では、DOMモードで監視している間だけトップバーに読み取り状態の点（読めていれば緑）が出る。
掲載中のスクリーンショットに写っていないのは古いというほどではないが、
「読み取れているかが分かる」を掲載文で謳っているので、**1枚はこの点が写ったものにする**。
それ以外の見た目（配色・余白・コメント行の構造）は v1.12.x から変えていないため、
既存のスクリーンショットはそのまま使える。

### スクリーンショット・英語

英語の掲載情報には英語表示のスクリーンショットを別に用意する（日本語のものを流用すると、
説明の「Streamer」「Super Chat」などが画面に見当たらない）。撮り方:

- Chrome を `--lang=en-US` で起動する（または設定画面の言語で English を選ぶ。popup は次に開いたときに切り替わる）。
  **ツールバーのツールチップと拡張機能の名前はブラウザの言語に従う**ので、名前が写るカットは `--lang=en-US` で撮る
- 日本語版と同じ構図にする。最低限そろえるのは次の3枚:
  1. 監視中のポップアップ（トップバーの読み取り状態の緑の点、件数バッジ、スパチャの金額チップとステッカー画像が写るもの）
  2. フィルターのドロワーを開いたところ（Streamer / Moderator / Member / Regular / Super Chat / Joins & gifts と Special / All / None）
  3. キーワード検索で絞り込んだところ（`Matches: N` が写るもの）
- 配信のコメントそのものは英語の配信を使うと掲載文と噛み合う（日本語の配信でも誤りではない）
- 420px の popup に英語の文言が収まることは段階2〜4で確認済み（`docs/i18n-plan.md` の実施記録）
