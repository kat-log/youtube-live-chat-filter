# lines.json のセリフを ElevenLabs で合成し、前後の無音を詰めて timeline.json と data.js を作る。
# キーは環境の「API認証情報」が api.elevenlabs.io 宛てに xi-api-key ヘッダーで付ける（コードには持たない）
import json, os, subprocess, urllib.request
W = os.path.dirname(os.path.abspath(__file__)); os.chdir(W); os.makedirs('vo', exist_ok=True)
VOICES = {'A': 'cgSgspJ2msm6clMCkdW9',   # Jessica（元気なファン役）
          'B': 'EXAVITQu4vr4xnSDxMaL'}   # Sarah（案内役）
STARTS = {'L01':0.30,'L02':5.75,'L03':9.20,'L04':13.90,'L05':20.45,'L06':23.40,'L07':25.55,
          'L08':31.20,'L09':33.95,'L10':36.30,'L11':40.50,'L12':43.15,'L13':46.50,'L14':48.65}
TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse'
tl = []
for lid, sp, text, disp in json.load(open('lines.json')):
    if not os.path.exists(f'vo/{lid}.mp3'):
        body = json.dumps({'text': text, 'model_id': 'eleven_v3'}).encode()
        req = urllib.request.Request(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICES[sp]}?output_format=mp3_44100_128',
                                     data=body, headers={'Content-Type': 'application/json'})
        open(f'vo/{lid}.mp3', 'wb').write(urllib.request.urlopen(req, timeout=90).read())
    subprocess.run(['ffmpeg','-v','error','-y','-i',f'vo/{lid}.mp3','-ar','48000','-ac','1','-af',TRIM,f'vo/t_{lid}.wav'], check=True)
    d = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f'vo/t_{lid}.wav']))
    tl.append({'id': lid, 'sp': sp, 'text': disp, 'start': STARTS[lid], 'end': round(STARTS[lid] + d, 3)})
json.dump(tl, open('timeline.json', 'w'), indent=1)
m = json.load(open('rec/markers.json'))
open('data.js', 'w').write('window.TL=' + json.dumps(tl) + ';\nwindow.MK=' + json.dumps(m) + ';\n')
