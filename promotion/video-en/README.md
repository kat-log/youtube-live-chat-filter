# 英語版プロモーション動画（作業中）

日本語版（https://youtu.be/HZnoYyByUos ・約62秒・ずんだもん＋四国めたん）の英語版。
英語圏向けに作り直す。声は ElevenLabs、2人の掛け合い、アニメ調で元気・ポップ。

## 決まったこと（2026-10-02 ユーザーと相談済み）

- 構成：英語圏向けに作り直す（日本語版の直訳ではない）。横16:9・60秒前後
- 声：ElevenLabs の英語の声 2人の掛け合い
  - **A** … 元気なファン役（ずんだもんの位置）
  - **B** … 頼れる案内役（四国めたんの位置）
- 雰囲気：アニメ調で元気・ポップ
- 冒頭：日本語版と同じ方向（推しの返事を見逃す「あるある」）。配信者を指す代名詞は `they`
- 声の候補は同じ1文で数本ずつサンプルを作り、ユーザーに聞き比べてもらってから決める（まだ）

## 台本（確定前の叩き台。冒頭の一言だけ確定）

| 章 | 話者 | セリフ | 画面（`rec/markers.json` のマーカー） |
|---|---|---|---|
| 0:00 Opening | A | "Wait, did they just reply to me?! …Aaand it's gone." | watch：`reply` の黄枠の行が流れ去る |
| | B | "Live chat moves fast. Way too fast." | |
| | B | "Meet YouTube Special Comments Filter, a free Chrome extension." | タイトル |
| Catch what matters | B | "Click the icon while you watch. Streamer replies, mod messages, and Super Chats stay right here." | `popup_open` → `sc_new` / `mod_new` |
| | A | "Even the ones that scrolled away ages ago!" | popup の @pixelpanda への返事 |
| Your filters | A | "Can I see member comments too?" | |
| | B | "Just flip on Members. Six toggles, so you see exactly who you want." | `gear` → `member_on` → `gear_close` |
| Search & follow | A | "Wait, who requested that song?" | |
| | B | "Search every comment you've collected." | `search_click` → `search_typed`（"song" で4件） |
| | B | "Or Alt-click any name in chat to see only their messages." | `alt_hover` → `alt_click`（watch 側にカーソルと Alt キーを描く） |
| Ready to go | A | "No API key? No setup?" | `gear2`（"DOM mode (no API key)" が見える） |
| | B | "Nope. Install it and you're good to go." | |
| | A & B | "Never miss the comments that matter!" | エンドカード：ストアURL＋QR（フェードさせず最後まで残す） |

ストア：https://chromewebstore.google.com/detail/ngdfibejjanimbkpnenkhfdiledjmogo

## デモ収録（済み・再現可）

架空の配信ページ（`site/`。架空ブランド「StarTube」・架空の配信者「Kiri Aozora」）を
`www.youtube.com` に被せて返し、`src/` の拡張機能をそのまま動かして録る。

```bash
pip install playwright pillow numpy qrcode
apt-get install -y xvfb fonts-noto-color-emoji fonts-roboto
Xvfb :99 -screen 0 2560x1440x24 &
DISPLAY=:99 python3 record.py      # → rec/watch/, rec/popup/（CDP screencast の JPEG ＋ frames.json）, rec/markers.json
python3 sheet.py popup 9.5,20,27,36 sheet.jpg   # 指定秒のコマを並べて確認
```

- 収録は約45秒の1テイク。watch は 1920×1080、popup は 750×980（中身は左上 630×900、残りは灰色の余白なので切り取る）
- screencast は画面が変わったときだけコマが来る（可変フレームレート）。`frames.json` の時刻で 30fps に並べ直す
- popup は別ウィンドウで開き、`chrome.tabs.query` を init script で watch タブに向けている
- 時刻は America/Los_Angeles・12時間表示で、夜の配信に見えるようにしてある

## 残り

1. ElevenLabs：環境変数 `ELEVENLABS_API_KEY`。声の候補サンプル → ユーザーが選ぶ → 全セリフ生成・長さを測る
   （`eleven_v3` なら `[excited]` などの音声タグで感情を付けられる）
2. タイムラインを組み、`stage.html` の `render(t)` で1フレームずつ描く（watch と popup を並べて構成。Alt+クリックのカーソルとキーは描き足す）
3. BGM・効果音は numpy で自作、ダッキング、`loudnorm=I=-14:TP=-1.5`
4. エンドカードに「デモ画面は説明用に用意した架空のもの」「Voices: ElevenLabs」を入れる
5. 限定公開でアップロード → 確認 → 公開。README.en.md の動画リンク差し替え（README.md は日本語版のまま）
