import asyncio, shutil, sys, time, base64
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

S = lambda **k: json.dumps(k)
SEED = [
 dict(name='Kiri Aozora', role='owner', text='Thank you all for coming tonight!! 🌙'),
 dict(name='NightOwl', role='moderator', text='Welcome in! Please keep the chat kind 💜'),
 dict(name='mochi_fan', role='member', text="Can you sing 'Blue Hour' later? That song always gets me"),
 dict(kind='superchat', name='Sora_K', amount='$5.00', text='First Super Chat! Love your voice', color='#1de9b6', color2='#00bfa5'),
 dict(kind='membership', name='Hana', text='Welcome to Starlight Club!'),
 dict(name='Kiri Aozora', role='owner', text='@Sora_K thank you so much!! 😭💙'),
 dict(name='bluejay', role='member', text='song request: Paper Moon pls 🙏'),
 dict(name='quietfox', role='', text='what was the first song?'),
 dict(name='mochi_fan', role='member', text='that high note in the last song!!'),
 dict(kind='superchat', name='ramen4ever', amount='$20.00', text='Happy 2nd anniversary!! 🎉', color='#ffca28', color2='#ffb300'),
 dict(name='NightOwl', role='moderator', text='The setlist will be posted after the stream!'),
 dict(name='Kiri Aozora', role='owner', text="Okay okay, 'Blue Hour' is on the list! 🎶"),
]

async def main():
    global T0
    prof = os.path.join(W, 'prof-rec'); shutil.rmtree(prof, ignore_errors=True)
    async with async_playwright() as p:
        ctx, ext = await launch(p, prof)
        T0 = time.time()
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await set_bounds(ctx, page, 0, 0, 1280, 912)
        await page.goto(WATCH)
        print('viewport', await page.evaluate('[innerWidth, innerHeight, devicePixelRatio]'))
        await asyncio.sleep(2)
        chat = [f for f in page.frames if 'live_chat' in f.url][0]
        await chat.evaluate('setRate(5)')
        for spec in SEED:
            await chat.evaluate(f'addRow({S(**spec)})'); await asyncio.sleep(1.3)
        # popup window
        s = await ctx.new_cdp_session(page)
        await s.send('Target.createTarget', {'url': 'about:blank', 'newWindow': True})
        await asyncio.sleep(1)
        pop = [pg for pg in ctx.pages if pg != page][0]
        await pop.add_init_script("""(()=>{const q=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async(o)=>{if(o&&o.active&&o.currentWindow){const t=await q({url:'https://www.youtube.com/watch*'});if(t.length)return t;}return q(o)}})()""")
        await set_bounds(ctx, pop, 1290, 0, 420, 740)
        popup_url = f'chrome-extension://{ext}/popup/popup.html'
        await pop.goto(popup_url); await asyncio.sleep(2)
        print('popup viewport', await pop.evaluate('[innerWidth, innerHeight]'))
        await pop.click('#settings-toggle-btn'); await asyncio.sleep(0.6)
        await pop.click('#preset-special'); await asyncio.sleep(0.6)
        await pop.click('label:has(#time-hour12-toggle)'); await asyncio.sleep(0.4)
        await pop.mouse.click(200, 570); await asyncio.sleep(0.6)
        await pop.goto('about:blank')
        await asyncio.sleep(2)

        # ===== recording =====
        T0 = time.time()
        cw = Cast(ctx, page, 'watch'); await cw.start()
        await chat.evaluate('setRate(9)')
        mark('rec_start')
        await asyncio.sleep(1.5)
        await chat.evaluate(f"addRow({S(name='Kiri Aozora', role='owner', text='@pixelpanda YES!! I’ll sing your request next 🎤', focus=True, mark='reply')})")
        mark('reply')
        await asyncio.sleep(7)
        await chat.evaluate('setRate(6)')
        cp = Cast(ctx, pop, 'popup')
        await pop.goto(popup_url); await cp.start(); mark('popup_open')
        await asyncio.sleep(3)
        await chat.evaluate(f"addRow({S(kind='superchat', name='bluejay', amount='$10.00', text='Your voice is pure magic ✨', color='#e040fb', color2='#d500f9')})"); mark('sc_new')
        await asyncio.sleep(2.5)
        await chat.evaluate(f"addRow({S(name='NightOwl', role='moderator', text='Song requests → members chat, please!')})"); mark('mod_new')
        await asyncio.sleep(3)
        async def click(sel, name, at=None):
            b = at or await pop.locator(sel).bounding_box()
            mark(name, x=b['x'] + b['width']/2, y=b['y'] + b['height']/2, page='popup')
            await pop.mouse.move(b['x'] + b['width']/2, b['y'] + b['height']/2); await pop.mouse.down(); await pop.mouse.up()
        await click('#settings-toggle-btn', 'gear'); await asyncio.sleep(1.6)
        await click('label:has(#sponsor-toggle)', 'member_on'); await asyncio.sleep(1.6)
        await click(None, 'gear_close', at={'x': 190, 'y': 560, 'width': 20, 'height': 20}); await asyncio.sleep(1.0)
        await chat.evaluate(f"addRow({S(name='mochi_fan', role='member', text='omg the members stream is SO cozy 🥹')})"); mark('member_new')
        await asyncio.sleep(3)
        await click('#search-keyword-input', 'search_click'); await asyncio.sleep(0.4)
        for ch in 'song':
            await pop.keyboard.type(ch); await asyncio.sleep(0.28)
        mark('search_typed'); await asyncio.sleep(4)
        await click('#clear-search-btn', 'search_clear'); await asyncio.sleep(1.5)
        # Alt-click
        await chat.evaluate('setRate(1.2)')
        await chat.evaluate(f"addRow({S(name='mochi_fan', role='member', text='Blue Hour next?? 👀', mark='mochi')})")
        await asyncio.sleep(1.0)
        await chat.evaluate('setRate(0)')
        await asyncio.sleep(0.3)
        nm = chat.locator('[data-mark="mochi"] #author-name')
        b = await nm.bounding_box()
        mark('alt_hover', x=b['x'] + b['width']/2, y=b['y'] + b['height']/2, page='watch')
        await page.mouse.move(b['x'] + b['width']/2, b['y'] + b['height']/2); await asyncio.sleep(0.8)
        await page.keyboard.down('Alt'); await asyncio.sleep(0.4)
        mark('alt_click', x=b['x'] + b['width']/2, y=b['y'] + b['height']/2, page='watch')
        await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Alt')
        await asyncio.sleep(1.0)
        await chat.evaluate('setRate(1.5)')
        await asyncio.sleep(4)
        await click('#clear-user-filter', 'user_clear'); await asyncio.sleep(1.5)
        await chat.evaluate('setRate(6)')
        await click('#settings-toggle-btn', 'gear2'); await asyncio.sleep(4)
        mark('end')
        await cw.stop(); await cp.stop()
        json.dump(markers, open(os.path.join(OUT, 'markers.json'), 'w'), indent=1)
        await ctx.close()
asyncio.run(main())
