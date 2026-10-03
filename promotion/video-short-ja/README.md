# ショート動画（日本語・縦 9:16・約31秒）

ずんだもん＋四国めたんの掛け合い（VOICEVOX）。横の日本語版（https://youtu.be/HZnoYyByUos）を縦ショート向けに短くしたもの。

## 決まったこと（2026-10-03）

- 縦 1080×1920・30秒前後。冒頭は「推しの返事を見逃すあるある」
- 字幕・ステッカー・QR は y=150〜1550 に収める（ショートの UI が下と右に重なる）
- 転換の効果音は上昇するベルのアルペジオ（ノイズの whoosh は使わない）。エンドカードでチャイムは鳴らさない
- 最後の画面（ストア＋QR）はフェードさせず最後まで残す

## 台本（`lines.json`）

| 秒 | 話者 | セリフ | 画面 |
|---|---|---|---|
| 0.25 | ずんだもん | えっ、推しがボクに返事くれた!? | ページ全体 → チャット欄に寄る。配信者の返事の行 |
| 3.0 | ずんだもん | …あっ、流れちゃったのだ… | 返事が流れ去る |
| 5.3 | めたん | そんなときは「YouTube特別コメントフィルター」よ！ | タイトル |
| 8.6 | めたん | アイコンを押せば、配信者・モデレーター・スパチャだけが並ぶの | アイコンをクリック → popup |
| 12.75 | ずんだもん | さっきの返事も、ちゃんと残ってるのだ！ | popup の返事の行に枠 |
| 15.6 | ずんだもん | メンバーのコメントも見たいのだ！ | 設定を開く |
| 17.8 | めたん | スイッチひとつよ。キーワード検索もできるわ | メンバーを ON → 「歌」で検索 |
| 21.3 | ずんだもん | APIキーも、設定もいらないのだ!? | 設定の「DOMモード（APIキー不要）」に枠 |
| 24.4 | めたん | 入れるだけで、すぐ使えるわ | |
| 26.7 | ずんだもん | ストアから無料で入れられるのだ！ | エンドカード（ストア＋QR） |

## 作り方

```bash
pip install playwright pillow numpy qrcode
apt-get install -y xvfb fonts-noto-color-emoji fonts-roboto fonts-noto-cjk
python3 make_av.py                  # 架空の視聴者のアイコン（頭文字入りの丸）
Xvfb :99 -screen 0 2560x2160x24 &
DISPLAY=:99 python3 record.py       # → rec/watch/, rec/popup/, rec/markers.json（約34秒の1テイク）
# VOICEVOX エンジンを 127.0.0.1:50021 で起動しておく（github.com が通らない環境では Docker Hub の voicevox/voicevox_engine:cpu-latest から取り出す）
python3 tts.py                      # → vo/、lens.json
python3 timeline.py                 # → timeline.json、data.js
python3 prep.py                     # 30fps の連番・フォント・QR・アイコン
python3 preview.py 1.6,10.5,22.5 pv.jpg
python3 audio.py && ffmpeg -i mix_raw.wav -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 -ac 2 mix.wav
python3 render.py 31.5              # → video.mp4
ffmpeg -i video.mp4 -i mix.wav -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart short-ja.mp4
```

- 架空の配信（`site/`。配信者「空乃キリ」・架空のチャンネル）を `www.youtube.com` に被せて返し、`src/` の拡張機能をそのまま動かして録る
- 時刻は「いまが夜になるタイムゾーン」を選んで夜の配信に見せている（`common.py` の `TZ`）
- 収録と動画の時刻の対応は `stage.html` の `watchRec()` / `popRec()`、popup の枠の座標は収録フレーム（CSS の 1.5倍）上の値
- 声と BGM の差は 12dB に合わせている（`audio.py`）
- クレジット：VOICEVOX:ずんだもん / 四国めたん（動画内と概要欄）
