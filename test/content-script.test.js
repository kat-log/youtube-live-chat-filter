// content-script.js のテスト（#T6 の穴埋め）。
//
// このファイルは長らくテスト0件だった。フェーズ9 で大きく削るので、
// **削る前に「いま何が起きているか」を固定する網**として書き始めたもの。
// 「いまの挙動」には #24 #30 #31 の3つの不具合も含まれていて、
// それらは同じフェーズの中で対の期待値ごと書き換えている（履歴に差分が残る）。
//
// 確かめられるのは外から見える振る舞いだけ（ハーネスの冒頭を参照）。

const test = require('node:test');
const assert = require('node:assert');

const { loadContentScript } = require('./helpers/content-script-harness');

// 読み込み直後の初期化（SWの起床待ち → liveChatId 取得 → 自動開始）が
// 落ち着くまで進める。実時間は1ミリ秒も待たない
const boot = async harness => { await harness.advance(5000); return harness; };

test('起動時の段取り', async t => {
  await t.test('Service Worker の起床を確かめてから初期化する', async () => {
    const h = await boot(loadContentScript());
    const actions = h.actions();

    assert.ok(actions.indexOf('ping') < actions.indexOf('getLiveChatIdFromVideo'),
      'ping より先に liveChatId を引きに行っている');
  });

  await t.test('メッセージリスナーは ping を待たずに登録する', () => {
    // Service Worker が起きるまで応答しない状況でも、popup からの ping には答える。
    // 答えられないと「未注入」と誤判定され、不要な再注入を招く
    const h = loadContentScript({ onRuntimeMessage: () => 'never' });

    assert.equal(h.listenerCount(), 1);
    assert.equal(h.deliver({ action: 'ping' }).response.success, true);
  });

  await t.test('DOMモードで自動開始が入っていれば、SW に開始を要求する', async () => {
    const h = await boot(loadContentScript());

    const start = h.sent().find(m => m.action === 'startDomMonitoring');
    assert.ok(start, 'DOMモードの自動開始が走っていない');
    assert.equal(start.videoId, 'VIDEO123');
  });

  await t.test('自動開始が切られていれば、開始を要求しない', async () => {
    const h = await boot(loadContentScript({
      onRuntimeMessage: m => (m.action === 'getAutoStart' ? { autoStart: false } : undefined)
    }));

    assert.equal(h.actions().includes('startDomMonitoring'), false);
  });

  await t.test('APIモードでは DOM の開始を要求しない', async () => {
    const h = await boot(loadContentScript({
      onRuntimeMessage: m => (m.action === 'getChatMode' ? { chatMode: 'api' } : undefined)
    }));

    assert.equal(h.actions().includes('startDomMonitoring'), false);
  });

  await t.test('watch ページでなければ liveChatId を引きに行かない', async () => {
    const h = await boot(loadContentScript({ url: 'https://www.youtube.com/' }));

    assert.equal(h.actions().includes('getLiveChatIdFromVideo'), false);
  });

  await t.test('二重注入されても2回目は何もしない', async () => {
    const h = await boot(loadContentScript());
    const before = h.listenerCount();

    // 同じ isolated world でもう一度評価する（SW の再注入と同じ状況）
    const fs = require('node:fs');
    const vm = require('node:vm');
    const path = require('node:path');
    const file = path.join(__dirname, '..', 'src', 'content', 'content-script.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), h.context, { filename: file });

    assert.equal(h.listenerCount(), before, '二重注入ガードが効いていない');
  });
});

test('video ID の取り出し', async t => {
  const videoIdFor = async url => {
    const h = await boot(loadContentScript({ url }));
    return h.deliver({ action: 'ping' }).response.videoId;
  };

  await t.test('?v= から', async () => {
    assert.equal(await videoIdFor('https://www.youtube.com/watch?v=abc123&t=10'), 'abc123');
  });

  await t.test('/live/ から', async () => {
    assert.equal(await videoIdFor('https://www.youtube.com/live/xyz789'), 'xyz789');
  });

  await t.test('URL から取れなければ meta[og:url] を見る', async () => {
    const h = await boot(loadContentScript({
      url: 'https://www.youtube.com/watch',
      elements: {
        'meta[property="og:url"]': {
          getAttribute: () => 'https://www.youtube.com/watch?v=fromMeta'
        }
      }
    }));

    assert.equal(h.deliver({ action: 'ping' }).response.videoId, 'fromMeta');
  });
});

test('メッセージの受け口', async t => {
  await t.test('ping には現在の状態を添えて答える', async () => {
    const h = await boot(loadContentScript({
      onRuntimeMessage: m =>
        (m.action === 'getLiveChatIdFromVideo' ? { liveChatId: 'CHAT1' } : undefined)
    }));

    const { response } = h.deliver({ action: 'ping' });
    assert.equal(response.success, true);
    assert.equal(response.videoId, 'VIDEO123');
    assert.equal(response.liveChatId, 'CHAT1');
  });

  await t.test('同期で応答した分岐はチャネルを開いたままにしない', async () => {
    // #30。開いたままにすると、送信側の await が永久に解けないことがある
    const h = await boot(loadContentScript());

    assert.equal(h.deliver({ action: 'ping' }).keepOpen, false);
    assert.equal(h.deliver({ action: 'stopMonitoring' }).keepOpen, false);
  });

  await t.test('知らない action にも必ず応答する', async () => {
    // #30。応答しないまま return true にすると、送信側は永久に待つ
    const h = await boot(loadContentScript());

    const result = h.deliver({ action: 'somethingFromANewerVersion' });
    assert.equal(result.responded, true, '知らない action に応答していない');
    assert.equal(result.keepOpen, false, 'チャネルを開いたままにしている');
    assert.equal(result.response.success, false);
  });

  await t.test('dom-chat.js 宛ての action には横から答えない', async () => {
    // tabs.sendMessage はタブの全フレームに配られ、応答は最初の1つが勝つ。
    // ここが即答すると、live_chat の iframe に居る dom-chat.js の応答を
    // 追い越して「読み取り状態は不明」にしてしまう（実ブラウザで確認済み）。
    // 応答しないだけならチャネルは開いたままにならないので、#30 の害は無い
    for (const action of ['getDomChatHealth', 'requestInitialSweep']) {
      const h = await boot(loadContentScript());
      const result = h.deliver({ action });
      assert.equal(result.responded, false, `${action} に横から答えている`);
      assert.equal(result.keepOpen, false, `${action} でチャネルを開いたままにしている`);
    }
  });

  await t.test('DOMモードの開始要求は SW へ回して、その応答を返す', async () => {
    const h = await boot(loadContentScript());

    const result = h.deliver({ action: 'startMonitoring', chatMode: 'dom' });
    assert.equal(result.keepOpen, true, '非同期に応答するなら true が要る');
    await h.advance(10);

    assert.equal(result.response.success, true);
    assert.equal(h.sent().filter(m => m.action === 'startDomMonitoring').length, 2,
      '自動開始ぶんと合わせて2回のはず');
  });
});

test('SPA遷移', async t => {
  await t.test('ページ全体の DOM 変化を購読しない', async () => {
    // #24。location.href という文字列を見るためだけに watch ページ全体を
    // 購読していた（拡張機能がやっていることの中で最も高価な処理）。
    // 検知は Service Worker の chrome.tabs.onUpdated に移した
    const h = await boot(loadContentScript());

    const bodyWatchers = h.observations().filter(o => o.target?.__isDocumentBody);
    assert.equal(bodyWatchers.length, 0, 'document.body を購読している');
    assert.equal(h.observations().length, 0);
  });

  await t.test('SW からの通知で、新しい動画の取得を組み立て直す', async () => {
    const h = await boot(loadContentScript());
    const before = h.sent().length;

    h.navigateTo('https://www.youtube.com/watch?v=NEXT456');
    h.deliver({ action: 'pageNavigated', videoId: 'NEXT456' });
    await h.advance(5000);

    const after = h.sent().slice(before);
    assert.ok(after.some(m => m.action === 'getLiveChatIdFromVideo' && m.videoId === 'NEXT456'),
      '新しい動画の liveChatId を引きに行っていない');
    assert.ok(after.some(m => m.action === 'startDomMonitoring' && m.videoId === 'NEXT456'),
      '新しい動画で自動開始していない');
  });

  await t.test('遷移の通知にも応答する（送信側を待たせない）', async () => {
    const h = await boot(loadContentScript());

    const result = h.deliver({ action: 'pageNavigated', videoId: 'NEXT456' });
    assert.equal(result.responded, true);
    assert.equal(result.keepOpen, false);
    await h.advance(5000);
  });
});

test('残骸の撤去', async t => {
  await t.test('ページ離脱時に sendBeacon を撃たない', async () => {
    // #31。chrome-extension:// への beacon は onMessage にはならない。
    // 一度も届いたことがない要求で、実際に畳んでいるのは tabs.onRemoved
    const h = await boot(loadContentScript());

    assert.equal(h.windowListeners('beforeunload').length, 0,
      'beforeunload のリスナーが残っている');
    h.fireWindowEvent('beforeunload');
    assert.equal(h.beacons().length, 0);
  });

  await t.test('watch ページでなくても、毎秒のポーリングを回さない', async () => {
    // waitForYouTubeLive の setInterval（1秒ごと・30秒）。SPA遷移の検知が
    // SW に移った以上、ページ側で URL を見張り続ける必要はない
    const h = await boot(loadContentScript({ url: 'https://www.youtube.com/' }));

    assert.equal(h.pendingTimers(), 0, 'タイマーが残っている');
  });

  await t.test('コメントの控えを持たない', async () => {
    // APIモードの残骸。SW → content script → popup のリレーはフェーズ7で消えており、
    // 控えを配る先はもう無い（popup は SW から直接もらう）
    const h = await boot(loadContentScript());

    const result = h.deliver({ action: 'getSpecialComments' });
    assert.equal(result.response.success, false, 'まだコメントを控えている');
  });
});
