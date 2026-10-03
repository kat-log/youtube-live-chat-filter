# stage.html が読む素材をそろえる：収録を 30fps の連番に並べ直す・フォント・QR・アイコン
import json, os, bisect, re, shutil, urllib.request
import qrcode
W = os.path.dirname(os.path.abspath(__file__)); os.chdir(W)
N = {}
for name in ('watch', 'popup'):
    log = json.load(open(f'rec/{name}/frames.json')); ts = [x[0] for x in log]
    d = f'rec/{name}30'; shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    N[name] = int(ts[-1]*30) + 1
    for k in range(N[name]):
        i = max(0, bisect.bisect_right(ts, k/30) - 1)
        os.symlink(os.path.abspath(f'rec/{name}/{log[i][1]}'), f'{d}/{k:05d}.jpg')
os.makedirs('fonts', exist_ok=True)
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
css = urllib.request.urlopen(urllib.request.Request('https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=M+PLUS+Rounded+1c:wght@500;800&display=block', headers={'User-Agent': UA})).read().decode()
out = []
for b in re.findall(r'(@font-face \{.*?\})', css, re.S):
    url = re.search(r'url\((.*?)\)', b).group(1); fn = url.split('/')[-1]
    if not os.path.exists(f'fonts/{fn}'): urllib.request.urlretrieve(url, f'fonts/{fn}')
    out.append(b.replace(url, fn))
open('fonts/fonts.css', 'w').write('\n'.join(out))
q = qrcode.QRCode(border=1, box_size=20); q.add_data('https://chromewebstore.google.com/detail/ngdfibejjanimbkpnenkhfdiledjmogo'); q.make()
q.make_image(fill_color='#1a1033', back_color='white').save('qr.png')
shutil.copy('../../src/icons/icon.svg', 'icon.svg')
json.dump(N, open('nframes.json', 'w'))
print(N)
