# lines.json のセリフを VOICEVOX（127.0.0.1:50021）で合成し、前後の無音を詰めて vo/ に置く。長さは lens.json
import json, os, subprocess, urllib.request, urllib.parse
W = os.path.dirname(os.path.abspath(__file__)); os.chdir(W); os.makedirs('vo', exist_ok=True)
SPK = {'Z': 3, 'M': 2}   # ずんだもん（ノーマル）・四国めたん（ノーマル）
E = 'http://127.0.0.1:50021'
def post(path, body=None, **q):
    req = urllib.request.Request(f'{E}{path}?{urllib.parse.urlencode(q)}', data=body or b'', method='POST', headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=120).read()
for s in SPK.values(): post('/initialize_speaker', speaker=s)
TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse'
lens = {}
for lid, sp, text, disp in json.load(open('lines.json')):
    q = json.loads(post('/audio_query', text=text, speaker=SPK[sp]))
    q.update(speedScale=1.15, intonationScale=1.3, prePhonemeLength=0.05, postPhonemeLength=0.05)
    open(f'vo/{lid}.wav', 'wb').write(post('/synthesis', json.dumps(q).encode(), speaker=SPK[sp]))
    subprocess.run(['ffmpeg','-v','error','-y','-i',f'vo/{lid}.wav','-ar','48000','-ac','1','-af',TRIM,f'vo/t_{lid}.wav'], check=True)
    lens[lid] = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f'vo/t_{lid}.wav']))
    print(lid, sp, round(lens[lid], 2), disp)
json.dump(lens, open('lens.json', 'w'), indent=1)
print('total', round(sum(lens.values()), 2))
