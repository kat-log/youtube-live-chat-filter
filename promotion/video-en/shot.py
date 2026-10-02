import asyncio, sys, os
from playwright.async_api import async_playwright
W = os.path.dirname(os.path.abspath(__file__))
async def main(t, out, clip):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--allow-file-access-from-files'])
        pg = await b.new_page(viewport={'width':1920,'height':1080})
        await pg.goto('file://' + W + '/stage.html'); await pg.evaluate('document.fonts.ready')
        await pg.evaluate(f'render({t})')
        x,y,w,h = map(int, clip.split(','))
        await pg.screenshot(path=out, clip={'x':x,'y':y,'width':w,'height':h}); await b.close()
asyncio.run(main(float(sys.argv[1]), sys.argv[2], sys.argv[3]))
