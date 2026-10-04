# セリフの開始時刻（動画の秒）と lens.json から timeline.json と data.js を作る
import json, os
W = os.path.dirname(os.path.abspath(__file__)); os.chdir(W)
STARTS = {'L01':0.3,'L02':3.0,'L03':5.6,'L04':8.6,'L05':13.0,'L06':15.6,'L07':17.8,'L08':21.2,'L09':23.95,'L10':26.7}
lens = json.load(open('lens.json'))
tl = [{'id': lid, 'sp': sp, 'text': disp, 'start': STARTS[lid], 'end': round(STARTS[lid] + lens[lid], 3)}
      for lid, sp, text, disp in json.load(open('lines.json'))]
for a, b in zip(tl, tl[1:]): assert a['end'] < b['start'], (a['id'], b['id'])
json.dump(tl, open('timeline.json', 'w'), indent=1, ensure_ascii=False)
open('data.js', 'w').write('window.TL=' + json.dumps(tl, ensure_ascii=False) + ';\nwindow.MK=' + open('rec/markers.json').read() + ';\nwindow.NF=' + open('nframes.json').read() + ';\n')
