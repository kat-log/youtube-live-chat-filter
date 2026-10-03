import asyncio, sys, os, io
from playwright.async_api import async_playwright
from PIL import Image
W = os.path.dirname(os.path.abspath(__file__))
async def main(times, out):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--allow-file-access-from-files'])
        pg = await b.new_page(viewport={'width':1080,'height':1920})
        await pg.goto('file://' + W + '/stage.html'); await pg.evaluate('document.fonts.ready')
        ims = []
        for t in times:
            await pg.evaluate(f'render({t})')
            ims.append(Image.open(io.BytesIO(await pg.screenshot(type='jpeg', quality=80))).resize((360,640)))
        cols = 6; rows = (len(ims)+cols-1)//cols
        sh = Image.new('RGB', (360*cols, 640*rows), 'white')
        for i, im in enumerate(ims): sh.paste(im, ((i%cols)*360, (i//cols)*640))
        sh.save(out); await b.close()
asyncio.run(main([float(x) for x in sys.argv[1].split(',')], sys.argv[2]))
