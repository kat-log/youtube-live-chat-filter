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

describe('監視開始時の全件スキャン', () => {
  // dom-chat.js は監視開始前からDOMを見ており、流れたコメントを送信済み扱いで
  // 抱えている。force を付けないと開始時に1件も送られず、
  // 「クリック以降のコメントしか見られない」状態になる
  const sweepRequests = calls => calls.tabMessages
    .filter(m => m.message.action === 'requestInitialSweep');

  test('監視開始時に force 付きで全件スキャンを要求する', async () => {
    const { chrome, calls } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    await sw.startDomMonitoring(3, 'V');
    await settle();

    const requests = sweepRequests(calls);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tabId, 3);
    assert.equal(requests[0].message.force, true, 'force が無いと過去分が送られてこない');
  });

  test('同じ動画の監視を張り直したときも force 付きで要求する', async () => {
    const { chrome, calls } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    await sw.startDomMonitoring(3, 'V');
    await sw.startDomMonitoring(3, 'V'); // content script と popup の自動開始が競合したケース
    await settle();

    const requests = sweepRequests(calls);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.message.force === true));
  });

  test('全件スキャンで再送された既存履歴のコメントは重複しない', async () => {
    // 開始時の履歴復元と全件スキャンが噛み合わないと、再開のたびに
    // 同じコメントが積み上がっていく
    const { chrome, store } = createChromeMock({ tabs: watchTab(3, 'V') });
    store['commentsHistory_V'] = [domComment(1), domComment(2)];

    const sw = loadServiceWorker(chrome);
    await settle();

    await sw.startDomMonitoring(3, 'V');
    // 全件スキャンは履歴にある2件＋開始前に流れた新しい1件を送ってくる
    await sw.handleDomChatMessages(
      [domComment(1), domComment(2), domComment(3)], senderFor(3, 'V'));

    const history = sw.monitoringState.commentsHistory;
    assert.equal(history.length, 3, '既存の履歴とスキャン分が二重に積まれている');
    assert.deepEqual(history.map(c => c.id), ['dom_1', 'dom_2', 'dom_3']);
  });
});

describe('アバターの取り込み', () => {
  // 発言者ごとに1つだけ持つ設計。コメント件数に比例させると、同じURLを
  // 何百回も履歴に書くことになり、過去に障害を出した肥大化を再発させる。
  const AVATAR = 'https://yt3.ggpht.com/AAA=s64-c-k-c0x00ffffff-no-rj';

  const startedSession = (sw, filters) => sw.setState({
    isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
    commentsHistory: [], processedMessageIds: new Set(), avatarsByAuthor: {},
    ...(filters ? { commentFilters: filters } : {})
  });

  test('アバターは発言者ごとのマップに入り、コメント本体には残らない', async () => {
    const { chrome, store } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw);

    // 同じ人が3回発言しても、保存されるURLは1つだけ
    await sw.handleDomChatMessages([
      { ...domComment(1), displayName: '常連さん', avatarUrl: AVATAR },
      { ...domComment(2), displayName: '常連さん', avatarUrl: AVATAR },
      { ...domComment(3), displayName: '常連さん', avatarUrl: AVATAR }
    ], senderFor(3, 'V'));
    await sw.getCommentsHistory('V');

    assert.deepEqual({ ...sw.monitoringState.avatarsByAuthor }, { '常連さん': AVATAR });
    assert.equal(store['commentAvatars_V']['常連さん'], AVATAR);

    const saved = store['commentsHistory_V'];
    assert.equal(saved.length, 3);
    for (const comment of saved) {
      assert.ok(!('avatarUrl' in comment), 'コメント本体にURLが残っている');
    }
  });

  test('新着通知には追加分のアバターだけが載る', async () => {
    const { chrome, calls } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw);

    await sw.handleDomChatMessages(
      [{ ...domComment(1), displayName: 'A', avatarUrl: AVATAR }], senderFor(3, 'V'));
    await sw.handleDomChatMessages(
      [{ ...domComment(2), displayName: 'A', avatarUrl: AVATAR }], senderFor(3, 'V'));

    // Service Worker は vm コンテキスト内で動くため、そこで作られたオブジェクトは
    // プロトタイプが別realmになる。deepEqual を通すために展開して比較する
    const deltas = calls.runtimeMessages
      .filter(m => m.action === 'newSpecialComments')
      .map(m => ({ ...m.avatars }));
    assert.deepEqual(deltas[0], { A: AVATAR });
    assert.deepEqual(deltas[1], {}, '既知のアバターを毎回送り直している');
  });

  test('フィルターで除外された種別のアバターは取り込まない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw, { owner: true, moderator: true, sponsor: true, normal: false });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal', displayName: '一般人', avatarUrl: AVATAR },
      { ...domComment(2), role: 'owner', displayName: '配信者', avatarUrl: AVATAR }
    ], senderFor(3, 'V'));

    assert.deepEqual(Object.keys(sw.monitoringState.avatarsByAuthor), ['配信者']);
  });

  test('上限を超えたアバターは古い方から捨てられる', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw);

    const over = sw.MAX_AVATARS_PER_VIDEO + 10;
    await sw.handleDomChatMessages(
      Array.from({ length: over }, (_, i) =>
        ({ ...domComment(i), displayName: `視聴者${i}`, avatarUrl: `${AVATAR}#${i}` })),
      senderFor(3, 'V'));

    const names = Object.keys(sw.monitoringState.avatarsByAuthor);
    assert.equal(names.length, sw.MAX_AVATARS_PER_VIDEO);
    assert.ok(!names.includes('視聴者0'), '古いアバターが残っている');
    assert.ok(names.includes(`視聴者${over - 1}`), '最新のアバターが消えている');
  });

  test('履歴のクリーンアップでアバターも一緒に消える', async () => {
    // 片方だけ残ると、参照されないアバターが永久にストレージを食う
    const { chrome, store } = createChromeMock({ tabs: watchTab(7, 'ACTIVE') });
    const base = Date.parse('2026-08-01T00:00:00Z');
    ['ACTIVE', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'].forEach((videoId, i) => {
      store[`commentsHistory_${videoId}`] = [domComment(1, base + i * 86400000)];
      store[`commentAvatars_${videoId}`] = { 誰か: AVATAR };
    });
    store.monitoringState = activeSession(7, 'ACTIVE');

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.cleanupOldCommentHistories();

    const avatarKeys = Object.keys(store).filter(k => k.startsWith('commentAvatars_')).sort();
    const remaining = historyKeys(store).map(k => k.replace('commentsHistory_', ''));
    assert.deepEqual(avatarKeys.map(k => k.replace('commentAvatars_', '')), remaining,
      '履歴とアバターの残り方がずれている');
  });

  test('同じ動画の監視を再開するとアバターが復元される', async () => {
    const { chrome, store } = createChromeMock({ tabs: watchTab(3, 'V') });
    store['commentsHistory_V'] = [domComment(1)];
    store['commentAvatars_V'] = { 常連さん: AVATAR };

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.startDomMonitoring(3, 'V');

    assert.equal(sw.monitoringState.avatarsByAuthor['常連さん'], AVATAR);

    const result = await sw.getCommentsHistory('V');
    assert.equal(result.avatars['常連さん'], AVATAR, 'ポップアップにアバターが渡っていない');
  });
});

describe('Content Script の再注入', () => {
  // 再注入は二重注入を招きやすく、content-script.js のトップレベル宣言と衝突すると
  // SyntaxError でスクリプトが丸ごと読み込まれない（拡張機能一覧に Error が出る）
  const watchPageScript = {
    matches: ['*://*.youtube.com/watch*'],
    js: ['content/content-script.js']
  };
  const completeTab = id => ({ id, url: `https://www.youtube.com/watch?v=V${id}`, status: 'complete' });

  test('既に動いているタブには再注入しない', async () => {
    const { chrome, calls } = createChromeMock({
      contentScripts: [watchPageScript],
      queryTabs: [completeTab(1)],
      onTabMessage: () => ({ success: true })  // ping に応答する = 生きている
    });

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.reinjectContentScripts('manual');

    assert.equal(calls.executeScript.length, 0);
  });

  test('応答しないタブには再注入する', async () => {
    const { chrome, calls } = createChromeMock({
      contentScripts: [watchPageScript],
      queryTabs: [completeTab(1)],
      onTabMessage: () => { throw new Error('Could not establish connection'); }
    });

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.reinjectContentScripts('manual');

    assert.equal(calls.executeScript.length, 1);
    assert.deepEqual(calls.executeScript[0].files, ['content/content-script.js']);
    assert.equal(calls.executeScript[0].target.tabId, 1);
  });

  test('タブを指定したときは他のタブに注入しない', async () => {
    const { chrome, calls } = createChromeMock({
      contentScripts: [watchPageScript],
      queryTabs: [completeTab(1), completeTab(2)],
      onTabMessage: () => { throw new Error('Could not establish connection'); }
    });

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.reinjectContentScripts('manual', 2);

    assert.equal(calls.executeScript.length, 1);
    assert.equal(calls.executeScript[0].target.tabId, 2);
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

describe('スーパーチャットとメンバーシップ', () => {
  // スパチャは一般視聴者からも飛んでくるので、役割で絞ると取りこぼす。
  // 種別（kind）を役割とは別の軸として扱えているかをここで固定する
  const startedSession = (sw, filters) => sw.setState({
    isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
    commentsHistory: [], processedMessageIds: new Set(), avatarsByAuthor: {},
    ...(filters ? { commentFilters: filters } : {})
  });

  const kindsOf = sw => sw.monitoringState.commentsHistory.map(c => c.kind);

  test('一般視聴者のスパチャは「一般」を切っていても残る', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw, {
      owner: true, moderator: true, sponsor: true, normal: false,
      superchat: true, membership: true
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal', kind: 'superchat', amountText: '¥1,000' },
      { ...domComment(2), role: 'normal', kind: 'text' }
    ], senderFor(3, 'V'));

    assert.deepEqual(kindsOf(sw), ['superchat']);
  });

  test('種別を切ると、その発言者の役割が有効でも残らない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw, {
      owner: true, moderator: true, sponsor: true, normal: true,
      superchat: false, membership: true
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'member', kind: 'superchat', amountText: '¥500' },
      { ...domComment(2), role: 'member', kind: 'supersticker', amountText: '¥200' },
      { ...domComment(3), role: 'member', kind: 'membership', eventText: '新規メンバー' },
      { ...domComment(4), role: 'member', kind: 'gift', eventText: 'ギフト5個' }
    ], senderFor(3, 'V'));

    assert.deepEqual(kindsOf(sw), ['membership', 'gift']);
  });

  test('旧バージョンが保存した4項目のフィルターでも新しい種別は表示される', async () => {
    // 更新直後は storage に superchat / membership が無い。欠けたキーを
    // false と解釈すると、アップデートした瞬間にスパチャが消える
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw, { owner: true, moderator: true, sponsor: true, normal: true });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal', kind: 'superchat', amountText: '¥1,000' },
      { ...domComment(2), role: 'member', kind: 'membership', eventText: '新規メンバー' }
    ], senderFor(3, 'V'));

    assert.deepEqual(kindsOf(sw), ['superchat', 'membership']);
  });

  test('kind を持たない旧 dom-chat.js のコメントは従来どおり役割で絞られる', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw, {
      owner: true, moderator: true, sponsor: true, normal: false,
      superchat: true, membership: true
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal' },
      { ...domComment(2), role: 'owner' }
    ], senderFor(3, 'V'));

    assert.equal(sw.monitoringState.commentsHistory.length, 1);
    assert.equal(sw.monitoringState.commentsHistory[0].role, 'owner');
  });

  test('フィルターの欠けたキーは既定値で補い、想定外のキーは捨てる', async () => {
    const { chrome } = createChromeMock();
    const sw = loadServiceWorker(chrome);
    await settle();

    // vm コンテキスト側で作られたオブジェクトはプロトタイプが別realmになるため、
    // 展開してこちら側のプレーンオブジェクトに直してから比べる
    const normalized = filters => ({ ...sw.normalizeCommentFilters(filters) });
    const defaults = { ...sw.DEFAULT_COMMENT_FILTERS };

    assert.deepEqual(normalized({ normal: false }), { ...defaults, normal: false });
    assert.deepEqual(normalized(null), defaults);
    assert.deepEqual(normalized({ owner: 'yes', unknown: true }), defaults);
  });

  test('APIの種別は kind に対応づけられ、表示できないものは落とされる', async () => {
    const { chrome } = createChromeMock();
    const sw = loadServiceWorker(chrome);
    await settle();

    const kindOf = type => sw.apiCommentKind({ snippet: { type } });
    assert.equal(kindOf('textMessageEvent'), 'text');
    assert.equal(kindOf('superChatEvent'), 'superchat');
    assert.equal(kindOf('superStickerEvent'), 'supersticker');
    assert.equal(kindOf('newSponsorEvent'), 'membership');
    assert.equal(kindOf('memberMilestoneChatEvent'), 'membership');
    assert.equal(kindOf('membershipGiftingEvent'), 'gift');
    assert.equal(kindOf('chatEndedEvent'), null);
    assert.equal(kindOf('messageDeletedEvent'), null);
    // type を持たない古い履歴はテキスト扱い
    assert.equal(sw.apiCommentKind({ snippet: {} }), 'text');
  });

  test('displayMessage を持たないイベントでもログ用プレビューで落ちない', async () => {
    // ここで例外が出るとポーリングの catch に落ち、pageToken が進まないまま
    // リトライを繰り返して監視が事実上止まる
    const { chrome } = createChromeMock();
    const sw = loadServiceWorker(chrome);
    await settle();

    assert.equal(sw.commentPreview({ snippet: { type: 'membershipGiftingEvent' } }), '');
    assert.equal(sw.commentPreview({ snippet: { displayMessage: 'こんにちは' } }), 'こんにちは');
    assert.equal(sw.commentPreview({ message: 'DOMモードのコメント' }), 'DOMモードのコメント');
    assert.equal(sw.commentPreview(undefined), '');
  });
});
