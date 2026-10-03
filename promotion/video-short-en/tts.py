# lines.json のセリフを ElevenLabs で合成し、前後の無音を詰めて vo/ に置く。長さは lens.json
# キーは環境の「API認証情報」が api.elevenlabs.io 宛てに xi-api-key ヘッダーで付ける（コードには持たない）
import json, os, subprocess, urllib.request
W = os.path.dirname(os.path.abspath(__file__)); os.chdir(W); os.makedirs('vo', exist_ok=True)
VOICES = {'A': 'cgSgspJ2msm6clMCkdW9',   # Jessica（元気なファン役）
          'B': 'EXAVITQu4vr4xnSDxMaL'}   # Sarah（案内役）
TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse'
lens = {}
for lid, sp, text, disp in json.load(open('lines.json')):
    if not os.path.exists(f'vo/{lid}.mp3'):   # 生成済みは使い回す（クレジット節約）
        body = json.dumps({'text': text, 'model_id': 'eleven_v3'}).encode()
        req = urllib.request.Request(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICES[sp]}?output_format=mp3_44100_128',
                                     data=body, headers={'Content-Type': 'application/json'})
        open(f'vo/{lid}.mp3', 'wb').write(urllib.request.urlopen(req, timeout=90).read())
    subprocess.run(['ffmpeg','-v','error','-y','-i',f'vo/{lid}.mp3','-ar','48000','-ac','1','-af',TRIM,f'vo/t_{lid}.wav'], check=True)
    lens[lid] = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f'vo/t_{lid}.wav']))
    print(lid, sp, round(lens[lid], 2), disp.replace('\n', ' '))
json.dump(lens, open('lens.json', 'w'), indent=1)
print('total', round(sum(lens.values()), 2))
