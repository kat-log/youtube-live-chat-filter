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

// 保存された履歴は IndexedDB にある（決定2）。保存はデバウンスされているので、
// 読む前に必ず flush する。ここを通さずに store を直接読むと、
// 「まだ書いていないだけ」を「保存されていない」と読み違える
const savedComments = async (sw, videoId) => {
  await sw.flushCommentsHistory();
  return sw.store.read(videoId);
};
// vm コンテキスト側で作られた配列は prototype が別realmになるので、
// deepEqual に渡す前に展開してこちら側の配列に直す
const savedIds = async (sw, videoId) => [...(await savedComments(sw, videoId)).map(c => c.id)];
const savedVideoIds = async sw => [...(await sw.store.listVideos()).map(v => v.videoId)].sort();

const watchTab = (id, videoId) => ({ [id]: { id, url: `https://www.youtube.com/watch?v=${videoId}` } });
/** popup から届くメッセージを、本物と同じ onMessage の口に流す */
const sendMessage = (chrome, request) =>
  new Promise(resolve => chrome.__onMessage(request, {}, resolve));
const activeSession = (tabId, videoId) => ({
  isMonitoring: true, liveChatId: null, tabId, videoId, chatMode: 'dom'
});

describe('履歴のクリーンアップ', () => {
  test('DOMモードの履歴でも新しい順に残り、監視中の動画は消されない', async () => {
    // DOMモードのコメントは publishedAt がトップレベルにあり、snippet.publishedAt を
    // 決め打ちで読むと全件0になって並べ替えが壊れる（#41で修正したバグ）。
    // 旧 storage.local の履歴は読み込み時に IndexedDB へ移る
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

    const remaining = await savedVideoIds(sw);
    assert.equal(remaining.length, sw.MAX_HISTORY_VIDEOS);
    assert.ok(remaining.includes('ACTIVE'), '監視中の動画が保護されていない');
    for (const videoId of ['v7', 'v6', 'v5']) {
      assert.ok(remaining.includes(videoId), `新しい ${videoId} が消えている`);
    }
    for (const videoId of ['v1', 'v2', 'v3']) {
      assert.ok(!remaining.includes(videoId), `古い ${videoId} が残っている`);
    }
  });

  test('保持枠の上限を超えた履歴は、古い方から切り詰められる', async () => {
    const { chrome } = createChromeMock();
    const sw = loadServiceWorker(chrome);
    await settle();

    // 上限そのものは shared/store.js が持つ。テストでは小さくして流量を減らす
    sw.store.LIMITS.bulk = 10;

    await sw.store.append('BIG', Array.from({ length: 25 }, (_, i) => domComment(i)));
    await sw.cleanupOldCommentHistories();

    const remaining = await sw.store.read('BIG');
    assert.equal(remaining.length, 10);
    assert.equal(remaining.at(-1).id, 'dom_24', '新しい方を残していない');
    assert.equal(remaining[0].id, 'dom_15', '古い方から消していない');
  });

  test('履歴を消すと、その動画のメタ情報も残らない', async () => {
    // 実体とメタが別々に消えると、どちらか片方だけが永久に居座る（#6 と同じ形）
    const { chrome } = createChromeMock();
    const sw = loadServiceWorker(chrome);
    await settle();

    await sw.store.append('a', [domComment(1)]);
    await sw.store.append('消える動画', [domComment(2)]);
    await sw.store.dropVideo('消える動画');

    assert.deepEqual(await savedVideoIds(sw), ['a']);
    assert.deepEqual((await sw.store.count('消える動画')).total, 0);
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
    // 履歴は IndexedDB へ移ったので、storage.local を埋めるのは設定側のキー。
    // 移行で消えないものを置かないと、この状況自体が作れない
    store.someLargeSetting = 'x'.repeat(3000);

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

    // storage.local への保存は失敗しうるが、コメントの取り込み自体は続く
    await sw.handleDomChatMessages([domComment(999)], senderFor(42, 'NEW'));
    assert.deepEqual(await savedIds(sw, 'NEW'), ['dom_999']);
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
    assert.deepEqual(await savedIds(sw, 'SAME'), ['dom_1']);
    // 履歴そのものはメモリに載せない。復帰後に必要なのは「どこまで取り込んだか」だけ
    assert.ok(sw.monitoringState.processedMessageIds.has('dom_1'),
      '復元した履歴のIDが既読になっていない');
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
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'VIDEO_B') });
    const sw = loadServiceWorker(chrome);
    await settle();

    // 「復元は通ったが実は動画が変わっていた」状況を作る
    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'VIDEO_A',
      processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'VIDEO_B'));
    await settle();

    assert.equal(sw.monitoringState.currentVideoId, 'VIDEO_B');

    assert.deepEqual(await savedIds(sw, 'VIDEO_B'), ['dom_1']);
    assert.deepEqual(await savedIds(sw, 'VIDEO_A'), [], '古い動画にコメントが混ざっている');
  });

  test('監視停止中は自動再開せず、コメントも取り込まない', async () => {
    // 停止ボタンが効かなくなる回帰を防ぐ
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({ isMonitoring: false, chatMode: 'dom', tabId: 3, currentVideoId: 'V' });
    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));

    assert.equal(sw.monitoringState.isMonitoring, false);
    assert.deepEqual(await savedIds(sw, 'V'), []);
  });

  test('表示フィルターで外れる種別も履歴には残る', async () => {
    // フェーズ4の本体（決定1）。取り込み時に捨てていたので、あとから
    // トグルをONに戻しても過去分が戻らなかった（#4）。絞り込みは表示側の担当で、
    // 「フィルターを切ると出ない」ことは test/popup-filters.test.js が見ている
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set(),
      commentFilters: { owner: true, moderator: false, sponsor: false, normal: false }
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal' },
      { ...domComment(2), role: 'owner' },
      { ...domComment(3), role: 'member' },
      { ...domComment(4), role: 'moderator' }
    ], senderFor(3, 'V'));

    assert.deepEqual(await savedIds(sw, 'V'), ['dom_1', 'dom_2', 'dom_3', 'dom_4']);
  });

  test('表示できない種別は落とし、既読にもしない', async () => {
    // 既読マークを付けるのは「保存すると決めたあと」（#4）。捨てるものまで
    // 既読にすると、全件スキャンで送り直させても二度と拾えない
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), kind: 'giftRedemption' },
      { ...domComment(2), kind: 'superchat', amountText: '¥500' }
    ], senderFor(3, 'V'));

    assert.deepEqual(await savedIds(sw, 'V'), ['dom_2']);
    assert.deepEqual([...sw.monitoringState.processedMessageIds], ['dom_2'],
      '保存しなかったコメントを既読にしている');
  });

  test('保持枠は取り込み口で焼き付ける', async () => {
    // 決定3。付けずに渡すと store 側が1件ずつ正準形に通し直すことになる
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal' },
      { ...domComment(2), role: 'member' },
      { ...domComment(3), role: 'owner' },
      { ...domComment(4), role: 'moderator' },
      { ...domComment(5), role: 'normal', kind: 'superchat', amountText: '¥500' }
    ], senderFor(3, 'V'));

    const saved = await savedComments(sw, 'V');
    assert.deepEqual([...saved.map(c => c.bucket)],
      ['bulk', 'bulk', 'primary', 'primary', 'primary']);
  });

  test('同じコメントが再送されても重複しない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));
    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));

    assert.deepEqual(await savedIds(sw, 'V'), ['dom_1']);
  });

  test('更新前に保存された旧形式のIDでも重複と分かる', async () => {
    // IDの作り方を変えた直後は、保存済み履歴のIDが旧形式（dom_<hash>_<n>）で、
    // dom-chat.js が送ってくるのは新形式。突き合わせられないと、更新した瞬間の
    // 全件スキャンで履歴が丸ごと二重になる（#9 の移行）
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set(['dom_-1234567_0'])
    });

    const message = domComment(1, Date.now(), {
      id: 'dom2_0000000100000002_0',
      legacyId: 'dom_-1234567_0'
    });
    await sw.handleDomChatMessages([message], senderFor(3, 'V'));

    assert.deepEqual(await savedIds(sw, 'V'), [], '旧IDで弾けていない');
  });

  test('旧IDに心当たりが無ければ取り込む。ただし保存はしない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set()
    });

    await sw.handleDomChatMessages([
      domComment(1, Date.now(), { id: 'dom2_0000000100000002_0', legacyId: 'dom_-1234567_0' })
    ], senderFor(3, 'V'));

    const [saved] = await savedComments(sw, 'V');
    assert.equal(saved.id, 'dom2_0000000100000002_0');
    assert.equal('legacyId' in saved, false, '突き合わせ用のIDを履歴に残している');
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

    const history = await savedIds(sw, 'V');
    assert.equal(history.length, 3, '既存の履歴とスキャン分が二重に積まれている');
    assert.deepEqual(history, ['dom_1', 'dom_2', 'dom_3']);
  });
});

describe('履歴のクリア', () => {
  test('クリア後に再スキャンすると、コメントが戻ってくる', async () => {
    // 既読マークを消し忘れると、クリア後の全件スキャンで全部が「重複」として
    // 弾かれ、画面は空のまま戻らない（#6）。利用者から見ると
    // 「クリアしたら二度と戻らなくなった」
    const AVATAR = 'https://yt3.ggpht.com/AAA=s64-c';
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.startDomMonitoring(3, 'V');

    const batch = () => [
      { ...domComment(1), displayName: '常連さん', avatarUrl: AVATAR },
      domComment(2)
    ];
    await sw.handleDomChatMessages(batch(), senderFor(3, 'V'));
    assert.deepEqual(await savedIds(sw, 'V'), ['dom_1', 'dom_2']);

    const response = await sendMessage(chrome, { action: 'clearCommentsHistory', videoId: 'V' });
    assert.equal(response.success, true);

    assert.deepEqual(await savedIds(sw, 'V'), []);
    assert.deepEqual({ ...await sw.store.readAvatars('V') }, {}, 'アバターが残っている');
    assert.deepEqual({ ...sw.monitoringState.avatarsByAuthor }, {});
    assert.equal(sw.monitoringState.processedMessageIds.size, 0, '既読マークが残っている');

    // dom-chat.js が全件を送り直す（requestInitialSweep と同じ流れ）
    await sw.handleDomChatMessages(batch(), senderFor(3, 'V'));
    assert.deepEqual(await savedIds(sw, 'V'), ['dom_1', 'dom_2'],
      'クリア後に再スキャンしてもコメントが戻らない');
    assert.equal((await sw.store.readAvatars('V'))['常連さん'], AVATAR);
  });

  test('クリアしても、保存待ちのコメントが書き戻らない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.startDomMonitoring(3, 'V');

    // flush する前（デバウンス中）にクリアされたケース
    await sw.handleDomChatMessages([domComment(1)], senderFor(3, 'V'));
    await sendMessage(chrome, { action: 'clearCommentsHistory', videoId: 'V' });

    assert.deepEqual(await savedIds(sw, 'V'), [], '消したはずのコメントが書き戻っている');
  });
});

describe('保存が容量超過で失敗したとき', () => {
  test('他の動画の履歴を捨てて書き直す', async () => {
    // 旧 emergencyCleanup は「切り詰めた配列」ではなく元の巨大な配列を
    // 送り直していたので、復旧という存在理由を果たしていなかった（#7）。
    // いま切り詰める対象（他の動画）と書き直す対象（新着のバッチ）は別物
    const { chrome, idb } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    await sw.store.append('OLD1', [domComment(1)]);
    await sw.store.append('OLD2', [domComment(2)]);
    await sw.startDomMonitoring(3, 'V');

    // ここから先、1バイトでも増える put は失敗する
    idb.setQuotaBytes(idb.usedBytes());

    await sw.handleDomChatMessages([domComment(9)], senderFor(3, 'V'));

    assert.deepEqual(await savedIds(sw, 'V'), ['dom_9'], '空きを作っても保存できていない');
    assert.deepEqual(await savedVideoIds(sw), ['V'], '他の動画の履歴が残っている');
  });
});

describe('popup へ渡すコメント', () => {
  test('上限に当たっても、特別コメントは一般コメントに押し出されない', async () => {
    // popup 10,000 / SW 2,000 と食い違っていた上限を1つにした（#33）。
    // 枠が別なので、上限に当たって削られるのは bulk（一般）だけ
    const { chrome } = createChromeMock();
    const sw = loadServiceWorker(chrome);
    await settle();
    sw.store.MAX_COMMENTS_TO_POPUP = 5;

    await sw.store.append('V', [
      { ...domComment(0), role: 'owner' },
      ...Array.from({ length: 20 }, (_, i) => domComment(i + 1))
    ]);

    const comments = await sw.readCommentsForPopup('V');
    const ids = [...comments.map(c => c.id)];

    assert.equal(ids.length, 5);
    assert.ok(ids.includes('dom_0'), '配信者のコメントが押し出されている');
    // 残りの枠は新しい方の一般コメントで埋まり、並びは古い順のまま
    assert.deepEqual(ids, ['dom_0', 'dom_17', 'dom_18', 'dom_19', 'dom_20']);
  });

  test('取り込み時に非表示だったコメントも、popup には渡される', async () => {
    // 「特別」プリセットで取り込んだあと「一般」をONに戻すと過去分が出る、
    // というフェーズ4の約束の受け渡し口。あとは popup が絞り込むだけで、
    // そちらは test/popup-filters.test.js が見ている
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();

    sw.setState({
      isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
      processedMessageIds: new Set(),
      // 「特別」プリセット相当（メンバーと一般が非表示）
      commentFilters: { owner: true, moderator: true, sponsor: false, normal: false,
        superchat: true, membership: true }
    });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'owner' },
      { ...domComment(2), role: 'normal' },
      { ...domComment(3), role: 'member' }
    ], senderFor(3, 'V'));
    await sw.flushCommentsHistory();

    const history = await sw.getCommentsHistory('V');
    assert.deepEqual([...history.comments.map(c => c.id)], ['dom_1', 'dom_2', 'dom_3']);
  });
});

describe('アバターの取り込み', () => {
  // 発言者ごとに1つだけ持つ設計。コメント件数に比例させると、同じURLを
  // 何百回も履歴に書くことになり、過去に障害を出した肥大化を再発させる。
  const AVATAR = 'https://yt3.ggpht.com/AAA=s64-c-k-c0x00ffffff-no-rj';

  const startedSession = (sw, filters) => sw.setState({
    isMonitoring: true, chatMode: 'dom', tabId: 3, currentVideoId: 'V',
    processedMessageIds: new Set(), avatarsByAuthor: {},
    ...(filters ? { commentFilters: filters } : {})
  });

  test('アバターは発言者ごとのマップに入り、コメント本体には残らない', async () => {
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw);

    // 同じ人が3回発言しても、保存されるURLは1つだけ
    await sw.handleDomChatMessages([
      { ...domComment(1), displayName: '常連さん', avatarUrl: AVATAR },
      { ...domComment(2), displayName: '常連さん', avatarUrl: AVATAR },
      { ...domComment(3), displayName: '常連さん', avatarUrl: AVATAR }
    ], senderFor(3, 'V'));

    assert.deepEqual({ ...sw.monitoringState.avatarsByAuthor }, { '常連さん': AVATAR });
    assert.equal((await sw.store.readAvatars('V'))['常連さん'], AVATAR);

    const saved = await savedComments(sw, 'V');
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

  test('表示フィルターで外れる発言者のアバターも取り込む', async () => {
    // 取り込みが全件になった以上、アバターも全件ぶん要る（決定1）。
    // 一般コメントを表示するときに、その人のアバターだけ無いことになる
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw, { owner: true, moderator: true, sponsor: true, normal: false });

    await sw.handleDomChatMessages([
      { ...domComment(1), role: 'normal', displayName: '一般人', avatarUrl: AVATAR },
      { ...domComment(2), role: 'owner', displayName: '配信者', avatarUrl: AVATAR }
    ], senderFor(3, 'V'));

    assert.deepEqual(Object.keys(sw.monitoringState.avatarsByAuthor), ['一般人', '配信者']);
  });

  test('発言し続けている配信者のアバターは、一般の流量で押し出されない', async () => {
    // 全件取り込みにすると、一般視聴者のアバターだけで上限（500人）に届く。
    // 挿入順の古い方から捨てるだけの作りだと、配信開始直後に発言している
    // 配信者やモデレーターのアバターが真っ先に落ちる
    // （決定3が保持枠を分けたのと同じ問題がアバターに出る）
    const { chrome } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw);

    const owner = index => ({
      ...domComment(index), role: 'owner', displayName: '配信者', avatarUrl: AVATAR
    });

    // 配信者が最初に発言し、そのあと一般視聴者が上限を超えるまで流れる。
    // 配信者は途中でも発言する（実際の配信で必ず起きる並び）
    await sw.handleDomChatMessages([owner(0)], senderFor(3, 'V'));

    const viewers = Array.from({ length: sw.MAX_AVATARS_PER_VIDEO + 10 }, (_, i) => ({
      ...domComment(i + 1), role: 'normal',
      displayName: `視聴者${i}`, avatarUrl: `${AVATAR}#${i}`
    }));
    for (let at = 0; at < viewers.length; at += 50) {
      await sw.handleDomChatMessages(viewers.slice(at, at + 50), senderFor(3, 'V'));
      await sw.handleDomChatMessages([owner(9000 + at)], senderFor(3, 'V'));
    }

    const names = Object.keys(sw.monitoringState.avatarsByAuthor);
    assert.equal(names.length, sw.MAX_AVATARS_PER_VIDEO);
    assert.ok(names.includes('配信者'), '配信者のアバターが押し出されている');
    assert.equal((await sw.store.readAvatars('V'))['配信者'], AVATAR);
    // 押し出されるのは、古くて以後発言していない一般視聴者の方
    assert.ok(!names.includes('視聴者0'), '一般視聴者の古い方が残っている');
  });

  test('同じアバターを送り直しても、追加分としては通知しない', async () => {
    // 末尾へ入れ直す処理を足したので、delta が毎回ふくらんでいないかを見る
    const { chrome, calls } = createChromeMock({ tabs: watchTab(3, 'V') });
    const sw = loadServiceWorker(chrome);
    await settle();
    startedSession(sw);

    const owner = index => ({
      ...domComment(index), role: 'owner', displayName: '配信者', avatarUrl: AVATAR
    });
    await sw.handleDomChatMessages([owner(1)], senderFor(3, 'V'));
    await sw.handleDomChatMessages([owner(2)], senderFor(3, 'V'));

    const deltas = calls.runtimeMessages
      .filter(m => m.action === 'newSpecialComments')
      .map(m => ({ ...m.avatars }));
    assert.deepEqual(deltas[1], {}, '同じURLを送り直している');
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
    const videoIds = ['ACTIVE', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
    const base = Date.parse('2026-08-01T00:00:00Z');
    videoIds.forEach((videoId, i) => {
      store[`commentsHistory_${videoId}`] = [domComment(1, base + i * 86400000)];
      store[`commentAvatars_${videoId}`] = { 誰か: AVATAR };
    });
    store.monitoringState = activeSession(7, 'ACTIVE');

    const sw = loadServiceWorker(chrome);
    await settle();
    await sw.cleanupOldCommentHistories();

    const remaining = await savedVideoIds(sw);
    const withAvatars = [];
    for (const videoId of videoIds) {
      if (Object.keys(await sw.store.readAvatars(videoId)).length > 0) withAvatars.push(videoId);
    }
    assert.deepEqual(withAvatars.sort(), remaining, '履歴とアバターの残り方がずれている');
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
});

describe('種別とフィルターの読み取り', () => {
  // 「スパチャは一般視聴者からも飛んでくるので役割で絞ると取りこぼす」など、
  // フィルターの2軸そのものを確かめるテストは test/popup-filters.test.js に移した。
  // 取り込みは全件になったので（決定1）、「Service Worker が保存するか」では
  // もう確かめられない。ここに残すのは、取り込み口が見る種別の判定だけ

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

describe('APIモードの取り込み', () => {
  // DOMモードと同じ規則で動くこと。以前はAPI側だけ「フィルター → 重複判定」の
  // 順で、同じ操作をしてもモードによって挙動が違った（#4）
  const apiItem = (id, type, authorDetails = {}) => ({
    id,
    snippet: { type, publishedAt: '2026-09-07T13:02:00.000Z', displayMessage: id },
    authorDetails: { displayName: id, ...authorDetails }
  });

  const fetched = async (sw, items) => {
    sw.setFetch(async () => ({ ok: true, json: async () => ({ items, nextPageToken: 'next' }) }));
    return sw.fetchLiveChatMessages('LIVE_CHAT_ID');
  };

  test('表示フィルターは適用せず、表示できない種別だけ落とす', async () => {
    const { chrome, store } = createChromeMock();
    store.youtubeApiKey = 'KEY';
    // 「一般」も「スパチャ」も切った状態。それでも取り込みは全件
    store.commentFilters = { owner: true, moderator: true, sponsor: false, normal: false,
      superchat: false, membership: false };
    const sw = loadServiceWorker(chrome);
    await settle();

    const response = await fetched(sw, [
      apiItem('text', 'textMessageEvent'),
      apiItem('paid', 'superChatEvent'),
      apiItem('joined', 'newSponsorEvent'),
      apiItem('ended', 'chatEndedEvent'),
      apiItem('deleted', 'messageDeletedEvent'),
      apiItem('redeemed', 'giftMembershipReceivedEvent')
    ]);

    assert.deepEqual([...response.comments.map(c => c.id)], ['text', 'paid', 'joined']);
  });

  test('保持枠を焼き付けてから返す', async () => {
    const { chrome, store } = createChromeMock();
    store.youtubeApiKey = 'KEY';
    const sw = loadServiceWorker(chrome);
    await settle();

    const response = await fetched(sw, [
      apiItem('normal', 'textMessageEvent'),
      apiItem('member', 'textMessageEvent', { isChatSponsor: true }),
      apiItem('mod', 'textMessageEvent', { isChatModerator: true }),
      apiItem('owner', 'textMessageEvent', { isChatOwner: true }),
      apiItem('paid', 'superChatEvent')
    ]);

    assert.deepEqual([...response.comments.map(c => c.bucket)],
      ['bulk', 'bulk', 'primary', 'primary', 'primary']);
  });
});
