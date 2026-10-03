import numpy as np, json, wave, subprocess
import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
SR = 48000; DUR = 31.5; N = int(SR*DUR)
rng = np.random.default_rng(7)
def tone(f, d, kind='sine'):
    t = np.arange(int(SR*d))/SR
    if kind == 'saw': return 2*((f*t) % 1) - 1
    if kind == 'tri': return 2*np.abs(2*((f*t) % 1) - 1) - 1
    return np.sin(2*np.pi*f*t)
def env(n, a=.005, r=.2):
    t = np.arange(n)/SR; e = np.minimum(t/a, 1)*np.exp(-t/r); return e
def add(buf, x, at):
    i = int(at*SR); j = min(len(buf), i+len(x));
    if i < len(buf): buf[i:j] += x[:j-i]
mid = lambda n: 440*2**((n-69)/12)

bpm = 120; beat = 60/bpm; bar = beat*4
music = np.zeros(N)
chords = [[60,64,67],[67,71,74],[69,72,76],[65,69,72]]   # C G Am F
roots = [36,43,45,41]
t0 = 0.0
nb = int(DUR/bar)+1
for b in range(nb):
    bt = t0 + b*bar; ch = chords[b%4]; rt = roots[b%4]
    for k in range(4):   # kick 4つ打ち、スネア2・4
        x = tone(1,0.25)  # placeholder
        tt = np.arange(int(SR*.25))/SR; f = 50 + 90*np.exp(-tt*35)
        kick = np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-tt*12)
        add(music, 0.9*kick, bt+k*beat)
        if k in (1,3):
            n = int(SR*.18); sn = rng.standard_normal(n)*env(n,.001,.06)*0.35 + tone(190,.18)*env(n,.001,.05)*0.3
            add(music, sn, bt+k*beat)
    for k in range(8):   # ハット
        n = int(SR*.05); h = np.diff(rng.standard_normal(n+1))*env(n,.0005,.012)*0.12
        add(music, h, bt+k*beat/2 + (0 if k%2==0 else 0.0))
    for k in range(8):   # ベース 8分
        n = int(SR*beat/2*.9); x = tone(mid(rt + (12 if k%4==3 else 0)), beat/2*.9, 'tri')*env(n,.005,.15)*0.35
        add(music, x, bt+k*beat/2)
    for k in range(16):  # ベルのアルペジオ 16分
        nt = ch[[0,1,2,1][k%4]] + 12 + (12 if k%8>=4 else 0)
        n = int(SR*.35); x = (tone(mid(nt),.35) + .3*tone(mid(nt)*2,.35) + .15*tone(mid(nt)*3.01,.35))*env(n,.002,.12)*0.10
        add(music, x, bt+k*beat/4)
    n = int(SR*bar)  # パッド
    pad = sum(tone(mid(nn),bar,'saw') for nn in ch)*0.018
    pad *= np.minimum(np.arange(n)/(SR*.3),1)*np.minimum((n-np.arange(n))/(SR*.3),1)
    add(music, pad, bt)
# 冒頭は軽く（キック無しで入る感じにするため、最初の2小節は控えめ）
fade_in = np.minimum(np.arange(N)/(SR*1.0), 1)
music *= fade_in
music *= np.minimum((N-np.arange(N))/(SR*2.5), 1)   # 最後2秒で音だけ落とす（画面は残す）

# ナレーション
tl = json.load(open('timeline.json'))
vo = np.zeros(N)
def readwav(p):
    out = subprocess.check_output(['ffmpeg','-v','error','-i',p,'-f','s16le','-ac','1','-ar',str(SR),'-'])
    return np.frombuffer(out, np.int16).astype(float)/32768
for l in tl: add(vo, readwav(f"vo/t_{l['id']}.wav"), l['start'])

# 効果音
sfx = np.zeros(N)
def popfx():
    n = int(SR*.12); t = np.arange(n)/SR; f = 500 + 900*np.exp(-t*40)
    return np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,.001,.04)*0.35
def clickfx():
    n = int(SR*.03); return (rng.standard_normal(n)*env(n,.0003,.004)*0.5 + tone(2400,.03)*env(n,.0003,.006)*0.25)
def sparkle():
    out = np.zeros(int(SR*1.0))
    for k, nn in enumerate([79, 84, 88, 91, 96]):   # G5-C6-E6-G6-C7 を 45ms 間隔
        n = int(SR*.6); x = (tone(mid(nn),.6)+.25*tone(mid(nn)*2,.6))*env(n,.002,.18)*0.10
        add(out, x, k*.045)
    n = int(SR*.35); tt = np.arange(n)/SR; f = 900 + 2600*tt/.35   # 軽いスイープ
    add(out, np.sin(2*np.pi*np.cumsum(f)/SR)*np.sin(np.pi*tt/.35)**2*0.035, 0)
    return out
for at in (1.1, 3.1, 18.0, 20.2, 21.8, 22.8): add(sfx, popfx(), at)
for at in (5.22, 8.5): add(sfx, sparkle(), at)
add(sfx, 0.6*popfx(), 26.7)
for at in (8.42, 15.63, 17.29, 18.93, 19.85, 21.31): add(sfx, clickfx(), at)

# ダッキング：声があるときは BGM を下げる
a = np.abs(vo); k = int(SR*.05)
e = np.convolve(a, np.ones(k)/k, 'same')
on = (e > 0.01).astype(float)
k2 = int(SR*.25); duck = np.convolve(on, np.ones(k2)/k2, 'same')
gain = 10**((-11*duck)/20)
music *= gain
# 声が BGM より 12dB 大きくなるように BGM を合わせる（VOICEVOX は ElevenLabs より小さく出る）
on0 = on > 0
music *= np.sqrt(np.mean(vo[on0]**2)) / np.sqrt(np.mean(music[on0]**2)) / 10**(12/20)
sfx *= 0.6
mix = vo*1.0 + music + sfx
mix /= max(1e-9, np.abs(mix).max()) / 0.95
pcm = (mix*32767).astype(np.int16)
with wave.open('mix_raw.wav','wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
# 声と BGM の差を確認
vm = np.sqrt(np.mean(vo[on>0]**2)); mm = np.sqrt(np.mean(music[on>0]**2))
print('voice vs music under voice (dB):', 20*np.log10(vm/mm))
