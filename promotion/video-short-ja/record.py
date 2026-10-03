# 架空の配信ページ（site/）を www.youtube.com に被せ、src/ の拡張機能をそのまま動かして録る。
# watch は縦長（CSS 720×1280 前後）、popup は別ウィンドウ。CDP screencast の JPEG と frames.json、markers.json を rec/ に出す
import asyncio, shutil, time, base64
from common import *
OUT = os.path.join(W, 'rec'); shutil.rmtree(OUT, ignore_errors=True)
T0 = None
markers = {}
def mark(name, **kw):
    markers[name] = {'t': time.time() - T0, **kw}; print(f'{markers[name]["t"]:6.2f} {name}', flush=True)

class Cast:
    def __init__(self, ctx, page, name):
        self.ctx, self.page, self.name, self.n = ctx, page, name, 0
        self.dir = os.path.join(OUT, name); os.makedirs(self.dir, exist_ok=True); self.log = []
    async def start(self):
        self.s = await self.ctx.new_cdp_session(self.page)
        self.s.on('Page.screencastFrame', self.on)
        await self.s.send('Page.startScreencast', {'format': 'jpeg', 'quality': 92, 'everyNthFrame': 1})
    def on(self, ev):
        self.n += 1; f = f'{self.n:06d}.jpg'
        open(os.path.join(self.dir, f), 'wb').write(base64.b64decode(ev['data']))
        self.log.append([ev['metadata']['timestamp'] - T0, f])
        asyncio.ensure_future(self.s.send('Page.screencastFrameAck', {'sessionId': ev['sessionId']}))
    async def stop(self):
        await self.s.send('Page.stopScreencast')
        json.dump(self.log, open(os.path.join(self.dir, 'frames.json'), 'w'))

S = lambda **k: json.dumps(k, ensure_ascii=False)
SEED = [
 dict(name='空乃キリ', role='owner', text='みんなこんばんは〜！今日もいっぱい歌うよ🌙'),
 dict(name='よふかしフクロウ', role='moderator', text='こんばんは！チャットは楽しく使ってね💜'),
 dict(name='もちこ', role='member', text='あとで「ブルーアワー」歌ってほしい！'),
 dict(kind='superchat', name='そらまめ', amount='¥500', text='初スパチャです！声が大好き', color='#1de9b6', color2='#00bfa5'),
 dict(kind='membership', name='はなび', text='「ほしぞら組」へようこそ！'),
 dict(name='空乃キリ', role='owner', text='@そらまめ ありがとう〜！！😭💙'),
 dict(name='あおいとり', role='member', text='歌リク：ペーパームーンお願いします🙏'),
 dict(name='しずく', role='', text='最初の曲なんだっけ？'),
 dict(kind='superchat', name='らーめん太郎', amount='¥2,000', text='2周年おめでとう！！🎉', color='#ffca28', color2='#ffb300'),
 dict(name='よふかしフクロウ', role='moderator', text='セットリストは配信後に載せます！'),
 dict(name='もちこ', role='member', text='さっきの高音すごかった！！'),
]

async def main():
    global T0
    prof = os.path.join(W, 'prof-rec'); shutil.rmtree(prof, ignore_errors=True)
    async with async_playwright() as p:
        ctx, ext = await launch(p, prof)
        T0 = time.time()
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await set_bounds(ctx, page, 0, 0, 720, 1360)
        await page.goto(WATCH)
        print('viewport', await page.evaluate('[innerWidth, innerHeight, devicePixelRatio]'))
        await asyncio.sleep(2)
        chat = [f for f in page.frames if 'live_chat' in f.url][0]
        await chat.evaluate('setRate(5)')
        for spec in SEED:
            await chat.evaluate(f'addRow({S(**spec)})'); await asyncio.sleep(1.3)
        s = await ctx.new_cdp_session(page)
        await s.send('Target.createTarget', {'url': 'about:blank', 'newWindow': True})
        await asyncio.sleep(1)
        pop = [pg for pg in ctx.pages if pg != page][0]
        await pop.add_init_script("""(()=>{const q=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async(o)=>{if(o&&o.active&&o.currentWindow){const t=await q({url:'https://www.youtube.com/watch*'});if(t.length)return t;}return q(o)}})()""")
        await set_bounds(ctx, pop, 740, 0, 420, 740)
        popup_url = f'chrome-extension://{ext}/popup/popup.html'
        await pop.goto(popup_url); await asyncio.sleep(2)
        print('popup viewport', await pop.evaluate('[innerWidth, innerHeight]'))
        # 「特別だけ」のプリセットから始める（メンバーはあとで足す）
        await pop.click('#settings-toggle-btn'); await asyncio.sleep(0.6)
        await pop.click('#preset-special'); await asyncio.sleep(0.6)
        await pop.mouse.click(200, 570); await asyncio.sleep(0.6)
        await pop.goto('about:blank')
        await asyncio.sleep(2)

        # ===== 収録 =====
        T0 = time.time()
        cw = Cast(ctx, page, 'watch'); await cw.start()
        await chat.evaluate('setRate(9)')
        mark('rec_start')
        await asyncio.sleep(1.5)
        await chat.evaluate(f"addRow({S(name='空乃キリ', role='owner', text='@ぽてと リクエストありがとう！次に歌うね🎤', focus=True, mark='reply')})")
        mark('reply')
        await asyncio.sleep(6)
        await chat.evaluate('setRate(6)')
        cp = Cast(ctx, pop, 'popup')
        await pop.goto(popup_url); await cp.start(); mark('popup_open')
        await asyncio.sleep(3)
        await chat.evaluate(f"addRow({S(kind='superchat', name='あおいとり', amount='¥1,000', text='歌声に癒されてます✨', color='#e040fb', color2='#d500f9')})"); mark('sc_new')
        await asyncio.sleep(2.5)
        await chat.evaluate(f"addRow({S(name='よふかしフクロウ', role='moderator', text='歌リクはメンバー限定チャットでお願いします！')})"); mark('mod_new')
        await asyncio.sleep(2.5)
        async def click(sel, name, at=None):
            b = at or await pop.locator(sel).bounding_box()
            mark(name, x=b['x'] + b['width']/2, y=b['y'] + b['height']/2, page='popup')
            await pop.mouse.move(b['x'] + b['width']/2, b['y'] + b['height']/2); await pop.mouse.down(); await pop.mouse.up()
        await click('#settings-toggle-btn', 'gear'); await asyncio.sleep(1.6)
        await click('label:has(#sponsor-toggle)', 'member_on'); await asyncio.sleep(1.6)
        await click(None, 'gear_close', at={'x': 190, 'y': 560, 'width': 20, 'height': 20}); await asyncio.sleep(1.0)
        await chat.evaluate(f"addRow({S(name='もちこ', role='member', text='メンバー限定の配信も楽しみ🥹')})"); mark('member_new')
        await asyncio.sleep(3)
        await click('#search-keyword-input', 'search_click'); await asyncio.sleep(0.4)
        await pop.keyboard.insert_text('歌'); mark('search_typed'); await asyncio.sleep(4)
        await click('#clear-search-btn', 'search_clear'); await asyncio.sleep(1.5)
        await click('#settings-toggle-btn', 'gear2'); await asyncio.sleep(4)
        mark('end')
        await cw.stop(); await cp.stop()
        json.dump(markers, open(os.path.join(OUT, 'markers.json'), 'w'), indent=1, ensure_ascii=False)
        await ctx.close()
asyncio.run(main())
