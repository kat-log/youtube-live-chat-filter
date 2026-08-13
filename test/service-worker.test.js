// Service Worker の状態機械に対する回帰テスト。
//
// ここで守りたいのは「数時間使い込まないと発現しない」種類の不具合。
// 過去に2度、同じクラスのバグが本番で発覚している:
//   #40 Service Worker 終了で DOM モードのコメントが取得できなくなる
//   #41 ストレージ肥大化で書き込みが失敗し、監視自体が始まらなくなる
// どちらも手動再現が困難なため、ロジックはここで固定する。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createChromeMock, loadServiceWorker, settle, domComment, senderFor
} = require('./helpers/service-worker-harness');

const historyKeys = store => Object.keys(store).filter(k => k.startsWith('commentsHistory_')).sort();
const watchTab = (id, videoId) => ({ [id]: { id, url: `https://www.youtube.com/watch?v=${videoId}` } });
const activeSession = (tabId, videoId) => ({
  isMonitoring: true, liveChatId: null, tabId, videoId, chatMode: 'dom'
});

describe('履歴のクリーンアップ', () => {
  test('DOMモードの履歴でも新しい順に残り、監視中の動画は消されない', async () => {
    // DOMモードのコメントは publishedAt がトップレベルにあり、snippet.publishedAt を
    // 決め打ちで読むと全件0になって並べ替えが壊れる（#41で修正したバグ）
    const { chrome, store } = createChromeMock({ tabs: watchTab(7, 'ACTIVE') });
    const base = Date.parse('2026-08-01T00:00:00Z');

    // ACTIVE は「一番古い」ので、保護が無ければ真っ先に消える
    ['ACTIVE', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'].forEach((videoId, i) => {
      store[`commentsHistory_${videoId}`] = [domComment(1, base + i * 86400000)];
    });
    store.monitoringState = activeSession(7, 'ACTIVE');

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.cleanupOldCommentHistories();

    const remaining = historyKeys(store);
    assert.equal(remaining.length, sw.MAX_HISTORY_VIDEOS);
    assert.ok(remaining.includes('commentsHistory_ACTIVE'), '監視中の動画が保護されていない');
    for (const videoId of ['v7', 'v6', 'v5']) {
      assert.ok(remaining.includes(`commentsHistory_${videoId}`), `新しい ${videoId} が消えている`);
    }
    for (const videoId of ['v1', 'v2', 'v3']) {
      assert.ok(!remaining.includes(`commentsHistory_${videoId}`), `古い ${videoId} が残っている`);
    }
  });

  test('上限を超えた履歴は新しい方を残して切り詰められる', async () => {
    const { chrome, store } = createChromeMock();
    const base = Date.parse('2026-08-01T00:00:00Z');
    store['commentsHistory_BIG'] = Array.from({ length: 5000 }, (_, i) => domComment(i, base + i * 1000));

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.cleanupOldCommentHistories();

    const trimmed = store['commentsHistory_BIG'];
    assert.equal(trimmed.length, sw.MAX_COMMENTS_PER_VIDEO);
    assert.equal(trimmed.at(-1).id, 'dom_4999', '新しい方を残していない');
  });

  test('メタ情報が記録され、実体の無いエントリは残らない', async () => {
    const { chrome, store } = createChromeMock();
    store['commentsHistory_a'] = [domComment(1)];
    store.commentsHistoryMeta = { a: Date.now(), 消えた動画: Date.now() };

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.cleanupOldCommentHistories();

    assert.deepEqual(Object.keys(store.commentsHistoryMeta), ['a']);
  });
});

describe('ストレージ容量超過時のフォールバック', () => {
  test('書き込みが失敗しても監視は開始され、dom-chat.js が注入される', async () => {
    // #41 の本体。set() の例外で startDomMonitoring が中断すると、
    // バッジ更新とスクリプト注入がスキップされコメントが1件も来なくなる
    const { chrome, store, calls } = createChromeMock({
      quotaBytes: 2000,
      tabs: watchTab(42, 'NEW')
    });
    store['commentsHistory_OLD1'] = Array.from({ length: 20 }, (_, i) => domComment(i));
    store['commentsHistory_OLD2'] = Array.from({ length: 20 }, (_, i) => domComment(i));

    const sw = loadServiceWorker(chrome);
    await settle();
    calls.badge.length = 0;
    calls.executeScript.length = 0;

    const result = await sw.startDomMonitoring(42, 'NEW');

    assert.equal(result.success, true);
    assert.ok(calls.badge.includes('ON'), 'バッジが ON になっていない');
    assert.ok(
      calls.executeScript.some(o => o.files?.includes('content/dom-chat.js')),
      'dom-chat.js が注入されていない'
    );
    assert.equal(sw.monitoringState.isMonitoring, true);

    // 保存は失敗しうるが、コメントの取り込み自体は続く
    await sw.handleDomChatMessages([domComment(999)], senderFor(42, 'NEW'));
    assert.equal(sw.monitoringState.commentsHistory.length, 1);
  });
});

describe('Service Worker 復帰時の状態復元', () => {
  test('同じ動画を見続けているセッションは履歴ごと復元される', async () => {
    const { chrome, store } = createChromeMock({
      tabs: { 5: { id: 5, url: 'https://www.youtube.com/watch?v=SAME&t=10' } }
    });
    store.monitoringState = activeSession(5, 'SAME');
    store['commentsHistory_SAME'] = [domComment(1)];

    const sw = loadServiceWorker(chrome);
    await settle();

    assert.equal(sw.monitoringState.isMonitoring, true);
    assert.equal(sw.monitoringState.currentVideoId, 'SAME');
    assert.equal(sw.monitoringState.commentsHistory.length, 1);
  });

  test('タブの動画が変わっていた古いセッションは破棄される', async () => {
    const { chrome, store, calls } = createChromeMock({ tabs: watchTab(9, 'NEWVIDEO') });
    store.monitoringState = activeSession(9, 'OLDVIDEO');

    const sw = loadServiceWorker(chrome);
    await settle();

    assert.equal(sw.monitoringState.isMonitoring, false);
    assert.equal(store.monitoringState.isMonitoring, false);
    assert.ok(calls.badge.includes(''), 'バッジが消えていない');
  });

  test('タブごと無くなっていたセッションは破棄される', async () => {
    const { chrome, store } = createChromeMock({ tabs: {} });
    store.monitoringState = activeSession(123, 'X');

    const sw = loadServiceWorker(chrome);
    await settle();

    assert.equal(sw.monitoringState.isMonitoring, false);
  });
});

describe('DOMモードのコメント取り込み', () => {
  test('同一タブで動画が変わったら新しい動画の履歴に入る', async () => {
    const { chrome, store } = createChromeMock({ tabs: watchTab(3, 'VIDEO_B') });
    const sw = loadServiceWorker(chrome);
    await settle();

    // 「復元は通ったが実は動画が変わっていた」状況を作る
    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'VIDEO_A',
      commentsHistory: [], processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'VIDEO_B'));
    await settle();

    assert.equal(sw.monitoringState.currentVideoId, 'VIDEO_B');
    assert.equal(sw.monitoringState.commentsHistory.length, 1);

    await sw.getCommentsHistory('VIDEO_B');
    assert.equal(store['commentsHistory_VIDEO_B'].length, 1);
    assert.equal(store['commentsHistory_VIDEO_A'], undefined, '古い動画にコメントが混ざっている');
  });

  test('監視停止中は自動再開せず、コメントも取り込まない', async () => {
    // 停止ボタンが効かなくなる回帰を防ぐ
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: false, chatMode: 'dom', tabId: 3, currentVideoId: 'V', commentsHistory: []
    });
    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));

    assert.equal(sw.monitoringState.isMonitoring, false);
    assert.equal(sw.monitoringState.commentsHistory.length, 0);
  });

  test('フィルターで除外された種別は履歴に残らない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      commentsHistory: [], processedMessageIds: new Set(),
      commentFilters: { owner: true, moderator: true, sponsor: true, normal: false }
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal' },
      { ...domComment(2), role: 'owner' }
    ], senderFor(3, 'V'));

    assert.equal(sw.monitoringState.commentsHistory.length, 1);
    assert.equal(sw.monitoringState.commentsHistory[0].role, 'owner');
  });

  test('同じコメントが再送されても重複しない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      commentsHistory: [], processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));
    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));

    assert.equal(sw.monitoringState.commentsHistory.length, 1);
  });
});

describe('ユーティリティ', () => {
  test('URL から videoId を抽出できる', async () => {
    const sw = loadServiceWorker(createChromeMock().chrome);
    await settle();
    const extract = sw.extractVideoIdFromUrl;

    assert.equal(extract('https://www.youtube.com/watch?v=abc123'), 'abc123');
    assert.equal(extract('https://www.youtube.com/watch?t=5&v=abc123&x=1'), 'abc123');
    assert.equal(extract('https://www.youtube.com/live/abc123'), 'abc123');
    assert.equal(extract('https://www.youtube.com/live_chat?is_popout=1&v=abc123'), 'abc123');
    assert.equal(extract('https://www.youtube.com/'), null);
    assert.equal(extract(null), null);
  });

  test('最終コメント時刻を DOM / API 両形式から読める', async () => {
    const sw = loadServiceWorker(createChromeMock().chrome);
    await settle();
    const at = Date.parse('2026-08-10T00:00:00Z');
    const iso = new Date(at).toISOString();

    assert.equal(sw.latestTimestampOf([{ publishedAt: iso }]), at);
    assert.equal(sw.latestTimestampOf([{ snippet: { publishedAt: iso } }]), at);
    assert.equal(sw.latestTimestampOf([]), 0);
  });

  test('診断はストレージを全件読まずに使用量を返す', async () => {
    const { chrome, store } = createChromeMock();
    store['commentsHistory_a'] = [domComment(1)];

    const sw = loadServiceWorker(chrome);
    await settle();
    const { diagnostics } = await sw.getDiagnosticsInfo();

    assert.equal(typeof diagnostics.storage.bytesInUse, 'number');
    assert.equal(diagnostics.storage.historyEntriesCount, 1);
  });
});
