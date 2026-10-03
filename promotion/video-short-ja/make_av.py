# 架空の視聴者のアイコン（頭文字入りの丸）を作る
import os
from PIL import Image, ImageDraw, ImageFont
W = os.path.dirname(os.path.abspath(__file__))
F = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
PEOPLE = {
 '空乃キリ': '#7c4dff', 'よふかしフクロウ': '#3949ab', 'もちこ': '#ec407a', 'そらまめ': '#26a69a', 'はなび': '#ef6c00',
 'ぱんだ丸': '#5d4037', 'あおいとり': '#1e88e5', 'こたつねこ': '#8d6e63', 'らーめん太郎': '#f9a825', 'ゆずぽん': '#7cb342',
 'ねむねむ': '#5c6bc0', 'ほしくず': '#ab47bc', 'たこやき': '#e53935', 'みかん箱': '#fb8c00', 'しずく': '#00acc1',
 'くろまめ': '#455a64', 'ぽてと': '#c0ca33', 'つきみ': '#6d4c41', 'さくら餅': '#f06292', 'ぴこ': '#00897b',
}
os.makedirs(f'{W}/site/av', exist_ok=True)
for name, col in PEOPLE.items():
    s = 176; im = Image.new('RGB', (s, s), col); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(F, 92)
    d.text((s/2, s/2+4), name[0], font=f, fill='white', anchor='mm')
    im.save(f'{W}/site/av/{name}.png')
print(len(PEOPLE))
