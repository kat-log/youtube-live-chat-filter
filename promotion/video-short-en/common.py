import asyncio, os, json, urllib.parse
from playwright.async_api import async_playwright
W = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(W, 'site')
EXT = os.path.abspath(os.path.join(W, '..', '..', 'src'))
# 夜の配信に見えるよう、いまが夜になるタイムゾーンを選ぶ（画面に出るのは時刻だけ）
import datetime
TZ = 'Asia/Tokyo' if 18 <= (datetime.datetime.utcnow().hour + 9) % 24 <= 23 else min(('America/New_York','Europe/London','Asia/Tokyo','America/Los_Angeles','Asia/Kolkata','Australia/Sydney'), key=lambda z: abs(((datetime.datetime.now(datetime.timezone.utc).astimezone(__import__('zoneinfo').ZoneInfo(z)).hour) - 21)))
WATCH = 'https://www.youtube.com/watch?v=DEMOkiri02x'

async def route_yt(route):
    u = urllib.parse.urlparse(route.request.url)
    if u.path.startswith('/live_chat'):
        return await route.fulfill(path=os.path.join(SITE, 'live_chat.html'), content_type='text/html')
    if u.path.startswith('/watch'):
        return await route.fulfill(path=os.path.join(SITE, 'watch.html'), content_type='text/html')
    return await route.fulfill(status=404, body='')

async def route_av(route):
    p = urllib.parse.unquote(urllib.parse.urlparse(route.request.url).path)
    name = p.split('/demo/')[-1].split('=')[0]
    f = os.path.join(SITE, 'av', name + '.png')
    if os.path.exists(f):
        return await route.fulfill(path=f, content_type='image/png')
    return await route.fulfill(status=404, body='')

async def launch(p, prof, scale=1.5):
    ctx = await p.chromium.launch_persistent_context(prof, executable_path='/opt/pw-browsers/chromium', headless=False, no_viewport=True,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}',
              f'--force-device-scale-factor={scale}', '--lang=en-US', '--hide-scrollbars',
              '--disable-infobars', '--no-first-run', '--disable-features=Translate'],
        ignore_default_args=['--enable-automation'], locale='en-US', timezone_id=TZ,
        env={**os.environ, 'TZ': TZ, 'LANGUAGE': 'en', 'LANG': 'en_US.UTF-8'})
    await ctx.route('https://www.youtube.com/**', route_yt)
    await ctx.route('https://yt3.ggpht.com/**', route_av)
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    return ctx, sw.url.split('/')[2]

async def set_bounds(ctx, page, left, top, w, h):
    s = await ctx.new_cdp_session(page)
    r = await s.send('Browser.getWindowForTarget')
    await s.send('Browser.setWindowBounds', {'windowId': r['windowId'], 'bounds': {'windowState': 'normal'}})
    await s.send('Browser.setWindowBounds', {'windowId': r['windowId'], 'bounds': {'left': left, 'top': top, 'width': w, 'height': h}})
