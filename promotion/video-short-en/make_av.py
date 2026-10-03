# 架空の視聴者のアイコン（頭文字入りの丸）を作る
import os
from PIL import Image, ImageDraw, ImageFont
W = os.path.dirname(os.path.abspath(__file__))
F = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
PEOPLE = {
 'Kiri Aozora': '#7c4dff', 'NightOwl': '#3949ab', 'mochi_fan': '#ec407a', 'Sora_K': '#26a69a', 'Hana': '#ef6c00',
 'pixelpanda': '#5d4037', 'bluejay': '#1e88e5', 'cozy_cat': '#8d6e63', 'ramen4ever': '#f9a825', 'tofu_time': '#7cb342',
 'starlight77': '#5c6bc0', 'LunaLover': '#ab47bc', 'pancake_p': '#e53935', 'gamer_gus': '#fb8c00', 'quietfox': '#00acc1',
 'MapleSyrup': '#455a64', 'echo_echo': '#c0ca33', 'zzz_nap': '#6d4c41', 'ribbon': '#f06292', 'Taro': '#00897b',
}
os.makedirs(f'{W}/site/av', exist_ok=True)
for name, col in PEOPLE.items():
    s = 176; im = Image.new('RGB', (s, s), col); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(F, 92)
    d.text((s/2, s/2+4), name[0].upper(), font=f, fill='white', anchor='mm')
    im.save(f'{W}/site/av/{name}.png')
print(len(PEOPLE))
