# Short video (English, vertical 9:16, about 31 seconds)

英語版のショート。日本語版（`../video-short-ja/`）と同じ構成で、声は ElevenLabs の2人（`eleven_v3`）。

- **A** … Jessica（元気なファン役）／ **B** … Sarah（案内役）
- 架空の配信（`site/`。配信者「Kiri Aozora」）を `www.youtube.com` に被せ、`src/` の拡張機能を英語表示（`--lang=en-US`）で動かして録る
- **公開するときはタイトルに `elevenlabs.io` を入れる**（ElevenLabs 無料プランの条件。概要欄だけでは不可）。動画のエンドカードと概要欄にも `ElevenLabs (elevenlabs.io)` を書く

## 台本（`lines.json`）

| 秒 | 話者 | セリフ |
|---|---|---|
| 0.3 | A | Wait, did they just reply to me?! |
| 3.0 | A | …Aaand it's gone. |
| 5.6 | B | Meet YouTube Special Comments Filter! |
| 8.6 | B | Click the icon, and only the streamer, mods, and Super Chats show up. |
| 13.0 | A | Even the reply that scrolled away! |
| 15.6 | A | Can I see member comments too? |
| 17.8 | B | One switch. And you can search, too. |
| 21.2 | A | No API key? No setup? |
| 23.95 | B | Nope. Just install it and go. |
| 26.7 | A | Get it free on the Chrome Web Store! |

## 作り方

日本語版と同じ（`../video-short-ja/README.md`）。違いは声だけで、`tts.py` は ElevenLabs を呼ぶ
（キーは環境の「API認証情報」が `api.elevenlabs.io` 宛てに付ける。生成済みの mp3 は使い回す）。

```bash
python3 make_av.py && DISPLAY=:99 python3 record.py
python3 tts.py && python3 prep.py && python3 timeline.py
python3 audio.py && ffmpeg -i mix_raw.wav -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 -ac 2 mix.wav
python3 render.py 31.5
ffmpeg -i video.mp4 -i mix.wav -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart short-en.mp4
```

サムネイルは `thumbnail.html` → `thumbnail.png`（1080×1920）。
