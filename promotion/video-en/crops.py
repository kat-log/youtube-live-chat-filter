import asyncio, sys, os, io
from playwright.async_api import async_playwright
from PIL import Image
W = os.path.dirname(os.path.abspath(__file__))
async def main(specs, out):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--allow-file-access-from-files'])
        pg = await b.new_page(viewport={'width':1920,'height':1080})
        await pg.goto('file://' + W + '/stage.html'); await pg.evaluate('document.fonts.ready')
        ims = []
        for t, x, y, w, h in specs:
            await pg.evaluate(f'render({t})')
            ims.append(Image.open(io.BytesIO(await pg.screenshot(clip={'x':x,'y':y,'width':w,'height':h}))).convert('RGB'))
        W2 = sum(i.width for i in ims); H = max(i.height for i in ims)
        sh = Image.new('RGB', (W2, H), 'white'); x = 0
        for i in ims: sh.paste(i, (x, 0)); x += i.width
        sh.save(out); await b.close()
specs = [tuple(map(float, s.split(':'))) for s in sys.argv[1].split(',')]
asyncio.run(main(specs, sys.argv[2]))
