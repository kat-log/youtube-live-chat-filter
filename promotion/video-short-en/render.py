import asyncio, os, subprocess, sys
from playwright.async_api import async_playwright
W = os.path.dirname(os.path.abspath(__file__))
DUR, FPS = float(sys.argv[1]), 30
async def main():
    ff = subprocess.Popen(['ffmpeg','-v','error','-y','-f','image2pipe','-framerate',str(FPS),'-c:v','mjpeg','-i','-',
        '-c:v','libx264','-preset','medium','-crf','16','-pix_fmt','yuv420p', os.path.join(W,'video.mp4')], stdin=subprocess.PIPE)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--allow-file-access-from-files'])
        pg = await b.new_page(viewport={'width':1080,'height':1920})
        await pg.goto('file://' + W + '/stage.html'); await pg.evaluate('document.fonts.ready')
        n = int(DUR*FPS)
        for i in range(n):
            await pg.evaluate(f'render({i/FPS})')
            ff.stdin.write(await pg.screenshot(type='jpeg', quality=93))
            if i % 150 == 0: print(i, n, flush=True)
        await b.close()
    ff.stdin.close(); ff.wait(); print('done')
asyncio.run(main())
