import json, sys, os, bisect
from PIL import Image
W = os.path.dirname(os.path.abspath(__file__))
def frame_at(name, t):
    log = json.load(open(f'{W}/rec/{name}/frames.json'))
    ts = [x[0] for x in log]; i = max(0, bisect.bisect_right(ts, t) - 1)
    return Image.open(f'{W}/rec/{name}/{log[i][1]}')
if __name__ == '__main__':
    name = sys.argv[1]; times = [float(x) for x in sys.argv[2].split(',')]; out = sys.argv[3]
    ims = [frame_at(name, t) for t in times]; w, h = ims[0].size; s = 0.5
    cols = 4; rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (int(w*s)*cols, int(h*s)*rows), 'white')
    for k, im in enumerate(ims):
        sheet.paste(im.resize((int(w*s), int(h*s))), ((k % cols)*int(w*s), (k//cols)*int(h*s)))
    sheet.save(out)
