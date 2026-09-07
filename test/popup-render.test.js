// popup の描画（フェーズ5・決定4）のテスト。
//
// 見ているのは「何が出ているか」ではなく **描き方** ——
// 行を作り直していないか、属性が壊れないか、レイアウトを何回読むか。
// 根本原因D（新着1件ごとに一覧を全部作り直す）が戻ってこないための網。
//
// 出来上がった DOM は popup-harness の readCommentRows でほどく。
// createElement の呼び出し回数は document.calls.createElement に貯まる。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadPopup, readCommentRows, visibleUsernames, findByClass } = require('./helpers/popup-harness');

const ALL_ON = {
  owner: true, moderator: true, sponsor: true,
  normal: true, superchat: true, membership: true
};

let seq = 0;
const comment = (fields = {}) => ({
  id: `dom2_render_${seq++}`,
  role: 'normal',
  displayName: `視聴者${seq}`,
  message: 'こんにちは',
  publishedAt: '2026-09-07T13:02:00.000Z',
  ...fields
});

function controller(options = {}) {
  const popup = loadPopup(options);
  const c = new popup.__popup.PopupController();
  c.commentFilters = { ...ALL_ON };
  c.popup = popup;
  return c;
}

/** コメント一覧のスクロール枠。closest('.comments-area') の行き先を作っておく */
function attachCommentsArea(c) {
  const area = c.popup.document.createElement('div');
  c.elements.commentsList.selectors['.comments-area'] = area;
  return area;
}

describe('行の組み立て（#25 #26）', () => {
  test('発言者名にクォートやタグを入れても、属性と本文が壊れない', () => {
    // 以前は escapeHtml（" と ' を素通しする）の結果を data-username="..." に
    // 差し込んでいたので、名前に " を入れると属性を閉じて任意の属性を注入できた。
    // createElement + setAttribute になったので、そもそも差し込む先が無い
    const c = controller();
    const evil = '" onerror="alert(1)';
    c.setComments([
      { ...comment({ displayName: evil }), id: 'a' },
      { ...comment({ displayName: "it's <img src=x>", message: '<b>太字</b>' }), id: 'b' }
    ]);
    c.renderComments();

    const rows = readCommentRows(c.elements.commentsList);
    assert.equal(rows.length, 2);
    // 属性にも本文にも、入力そのものが入っている（エスケープの入れ違いが起きない）
    assert.equal(rows[0].username, evil);
    assert.equal(rows[0].authorText, evil);
    assert.equal(rows[1].username, "it's <img src=x>");
    assert.equal(rows[1].message, '<b>太字</b>');

    // 名前に混ぜたタグが要素として生えていないこと（1行 = 想定した要素だけ）
    assert.deepEqual(c.popup.document.calls.createElement.filter(t => t === 'img'), []);
  });

  test('アバターは許可したホストの https だけを img にする（#26）', () => {
    // 取り込み口（formatComment）を通す。avatarUrl -> profileImageUrl はそこで移る
    const c = controller();
    c.addNewComments([
      { ...comment({ displayName: 'ok' }), id: 'a', avatarUrl: 'https://yt3.ggpht.com/abc=s64-c' },
      { ...comment({ displayName: 'ng' }), id: 'b', avatarUrl: 'https://evil.example.com/a.png' },
      { ...comment({ displayName: 'js' }), id: 'c', avatarUrl: 'javascript:alert(1)' }
    ]);

    const rows = readCommentRows(c.elements.commentsList);
    assert.equal(rows[0].avatar.tagName, 'IMG');
    assert.equal(rows[0].avatar.getAttribute('src'), 'https://yt3.ggpht.com/abc=s64-c');
    // 許可していないホストは頭文字にフォールバックする（リクエストを飛ばさない）
    assert.equal(rows[1].avatar.tagName, 'SPAN');
    assert.equal(rows[1].avatar.textContent, 'n');
    assert.equal(rows[2].avatar.tagName, 'SPAN');
  });

  test('ステッカーは配信ホストのものだけを img にする', () => {
    const c = controller();
    c.setComments([
      { ...comment({ kind: 'supersticker', displayName: 'ok' }), id: 'a',
        stickerUrl: 'https://lh3.googleusercontent.com/s=s192-rwa' },
      { ...comment({ kind: 'supersticker', displayName: 'ng' }), id: 'b',
        stickerUrl: 'https://evil.example.com/s.webp' }
    ]);
    c.renderComments();

    const rows = readCommentRows(c.elements.commentsList);
    assert.ok(findByClass(rows[0].element, 'comment-sticker'));
    assert.equal(findByClass(rows[1].element, 'comment-sticker'), null);
  });

  test('CSS が頼りにしている構造とクラス名は変わっていない', () => {
    // popup.css:1005-1008 の :has(.role-owner) と kind-* は DOM 構造に依存する。
    // 描画の方式だけを変えるフェーズなので、ここが変わったら見た目が変わっている
    const c = controller();
    c.addNewComments([{ ...comment({
      role: 'owner', kind: 'superchat', amountText: '¥1,000', eventText: null,
      displayName: '配信者'
    }), id: 'a' }]);

    const [row] = readCommentRows(c.elements.commentsList);
    // comment-item--last は「最後に見えている行」の印（区切り線を消すため）
    assert.deepEqual(row.classes, ['comment-item', 'kind-superchat', 'comment-item--last']);
    const header = row.element.children[0];
    assert.ok(header.classList.contains('comment-header'));
    assert.deepEqual(
      header.children.map(child => child.classList._names[0]),
      ['comment-avatar', 'comment-role', 'comment-kind', 'comment-author',
        'comment-amount', 'comment-time']);
    assert.ok(findByClass(row.element, 'role-owner'), ':has(.role-owner) の当たり先が無い');
  });
});

describe('差分追加（#22 = 根本原因D）', () => {
  test('新着1件で、既存の行は作り直されない', () => {
    const c = controller();
    c.setComments([1, 2, 3].map(n => ({ ...comment({ displayName: `既存${n}` }), id: `old${n}` })));
    c.renderComments();

    const before = readCommentRows(c.elements.commentsList);
    const createdBefore = c.popup.document.calls.createElement.length;

    c.addNewComments([{ ...comment({ displayName: '新着' }), id: 'new1' }]);

    const after = readCommentRows(c.elements.commentsList);
    assert.equal(after.length, 4);
    // 既存の3行は「同じ要素のまま」。作り直していれば参照が変わる
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].element, before[i].element, `${i}行目が作り直されている`);
    }
    // 新しく作ったのは新着1行ぶんの要素だけ
    // （行 div + header div + アバター span + 発言者 span + 時刻 span + 本文 div = 6）
    assert.equal(c.popup.document.calls.createElement.length - createdBefore, 6);
  });

  test('新着はまとめて1回だけ appendChild する（DocumentFragment）', () => {
    const c = controller();
    c.setComments([]);
    const appendsBefore = c.popup.document.calls.appendChild
      .filter(call => call.parent === 'comments-list').length;

    c.addNewComments([1, 2, 3].map(n => ({ ...comment(), id: `n${n}` })));

    // fragment の中身は展開されて記録されるので、数えるのは createDocumentFragment のほう
    assert.equal(c.popup.document.calls.createDocumentFragment.length, 1);
    const appends = c.popup.document.calls.appendChild
      .filter(call => call.parent === 'comments-list').length - appendsBefore;
    assert.equal(appends, 3, '行を1つずつ足している（fragment を使っていない）');
  });

  test('描画のたびに innerHTML を書き直さない', () => {
    // innerHTML への代入は HTML のパースと約4N要素の再生成を伴う（#22）。
    // 母集団が入れ替わるとき以外は1回も書かない
    const c = controller();
    c.setComments([{ ...comment(), id: 'a' }]);
    const writesAfterSet = c.elements.commentsList.writes.innerHTML.length;

    c.renderComments();
    c.addNewComments([{ ...comment(), id: 'b' }]);
    c.commentFilters.normal = false;
    c.renderComments();

    assert.equal(c.elements.commentsList.writes.innerHTML.length, writesAfterSet);
  });

  test('フィルターの切替は行を作り直さず hidden を切り替えるだけ', () => {
    const c = controller();
    c.setComments([
      { ...comment({ role: 'owner', displayName: '配信者' }), id: 'a' },
      { ...comment({ role: 'normal', displayName: '一般' }), id: 'b' }
    ]);
    c.renderComments();
    const created = c.popup.document.calls.createElement.length;
    const rowsBefore = readCommentRows(c.elements.commentsList).map(row => row.element);

    c.commentFilters.normal = false;
    c.renderComments();

    assert.equal(c.popup.document.calls.createElement.length, created, '行を作り直している');
    const rows = readCommentRows(c.elements.commentsList);
    assert.deepEqual(rows.map(row => row.element), rowsBefore);
    assert.deepEqual(rows.map(row => row.hidden), [false, true]);

    // 戻せば同じ要素がそのまま出てくる
    c.commentFilters.normal = true;
    c.renderComments();
    assert.deepEqual(readCommentRows(c.elements.commentsList).map(row => row.hidden), [false, false]);
  });

  test('メモリの上限を超えたら、古い行も DOM から消える', () => {
    // 行だけ残ると、メモリから落ちたコメントのDOMが永久に居座る
    const c = controller({ maxCommentsToPopup: 3 });
    c.setComments([]);
    c.addNewComments([1, 2, 3].map(n => ({ ...comment({ displayName: `古${n}` }), id: `o${n}` })));
    c.addNewComments([4, 5].map(n => ({ ...comment({ displayName: `新${n}` }), id: `o${n}` })));

    assert.equal(c.comments.length, 3);
    assert.deepEqual(visibleUsernames(c.elements.commentsList), ['古3', '新4', '新5']);
    // 落ちたIDが残っていると、同じコメントが二度と入らなくなる
    assert.equal(c.commentIds.has('o1'), false);
  });
});

describe('0件のときの後始末（#11）', () => {
  test('全部隠れても、スクロール状態の再同期まで到達する', () => {
    // 以前はここで早期 return していたので、古いDOMが残ったまま display:none になり、
    // 下端のフェード表示も前の状態で固まっていた
    const c = controller();
    const area = attachCommentsArea(c);
    c.setComments([{ ...comment({ role: 'normal', displayName: '一般' }), id: 'a' }]);
    c.renderComments();
    area.classList.remove('scrolled-to-bottom');

    c.commentFilters.normal = false;
    c.renderComments();

    assert.deepEqual(visibleUsernames(c.elements.commentsList), []);
    assert.equal(c.elements.noComments.style.display, 'block');
    assert.equal(c.elements.commentsList.style.display, 'none');
    assert.ok(area.classList.contains('scrolled-to-bottom'), 'スクロール状態が更新されていない');
  });

  test('コメントを空にすると、行そのものが DOM から消える', () => {
    const c = controller();
    c.setComments([{ ...comment(), id: 'a' }, { ...comment(), id: 'b' }]);
    c.renderComments();

    c.setComments([]);
    c.renderComments();

    assert.deepEqual(c.elements.commentsList.children, []);
    assert.equal(c.rows.size, 0);
  });

  test('0件の文言は、検索した件数を添える', () => {
    const c = controller();
    c.setComments([{ ...comment({ message: 'こんばんは' }), id: 'a' }]);
    c.searchQuery = 'みつからない';
    c.renderComments();

    assert.match(c.elements.noComments.textContent, /取得済み1件すべてを検索/);
  });
});

describe('イベント委譲（#22）', () => {
  test('一覧に張ったリスナー1つで、発言者名のクリックを拾う', () => {
    const c = controller();
    c.setComments([
      { ...comment({ displayName: 'にゃんこ' }), id: 'a' },
      { ...comment({ displayName: 'わんこ' }), id: 'b' }
    ]);
    c.renderComments();

    // 行にはリスナーを張らない（以前は1行につき3種類まで張っていた）
    const [row] = readCommentRows(c.elements.commentsList);
    assert.deepEqual(Object.keys(row.author.listeners), []);
    assert.deepEqual(Object.keys(c.elements.commentsList.listeners).sort(),
      ['click', 'error', 'scroll']);

    c.elements.commentsList.fire('click', { target: row.author });
    assert.equal(c.selectedUser, 'にゃんこ');
    assert.deepEqual(visibleUsernames(c.elements.commentsList), ['にゃんこ']);

    // 同じ名前をもう一度クリックしたら絞り込み解除
    c.elements.commentsList.fire('click', { target: row.author });
    assert.equal(c.selectedUser, null);
  });

  test('選択中の発言者は、行を作り直さずに selected が付け外しされる', () => {
    const c = controller();
    c.setComments([{ ...comment({ displayName: 'にゃんこ' }), id: 'a' }]);
    c.renderComments();
    const [row] = readCommentRows(c.elements.commentsList);
    const created = c.popup.document.calls.createElement.length;

    c.filterByUser('にゃんこ');
    assert.ok(row.author.classList.contains('selected'));
    c.clearUserFilter();
    assert.equal(row.author.classList.contains('selected'), false);
    assert.equal(c.popup.document.calls.createElement.length, created);
  });

  test('アバターが読めなかったら頭文字に差し替える', () => {
    const c = controller();
    c.addNewComments([{ ...comment({ displayName: 'にゃんこ' }), id: 'a',
      avatarUrl: 'https://yt3.ggpht.com/abc=s64-c' }]);

    const [row] = readCommentRows(c.elements.commentsList);
    c.elements.commentsList.fire('error', { target: row.avatar });

    const fallback = readCommentRows(c.elements.commentsList)[0].avatar;
    assert.equal(fallback.tagName, 'SPAN');
    assert.equal(fallback.textContent, 'に');
  });
});

describe('レイアウトの読み取り（#22）', () => {
  test('スクロール位置の再同期で、寸法を読み直さない', () => {
    // 以前は scrollTop/scrollHeight を3か所で読み書きしていて、
    // そのたびに強制同期レイアウトが走っていた
    const c = controller();
    const list = c.elements.commentsList;
    let reads = 0;
    Object.defineProperty(list, 'scrollHeight', { get: () => { reads++; return 500; } });
    Object.defineProperty(list, 'clientHeight', { get: () => { reads++; return 100; } });

    c.setComments([{ ...comment(), id: 'a' }]);
    c.autoScroll = true;
    c.renderComments();

    assert.equal(reads, 2, '寸法の読み取りが1回ぶんに収まっていない');
    assert.equal(list.scrollTop, 500);
    assert.equal(c.autoScroll, true);
  });
});

describe('bulk 枠の遅延読み込み（決定4）', () => {
  // 起動時にメモリへ載せるのは primary だけ。メンバー・一般（bulk）は
  // 表示や検索で要るときだけ IndexedDB から引く。
  //
  // 保存は shared/store.js が正なので、種は popup と同じコンテキストの
  // store から入れる（偽 IndexedDB は popup ハーネスが差している）

  const bulkComment = (n, fields = {}) => ({
    id: `bulk_${n}`,
    kind: 'text',
    role: 'normal',
    bucket: 'bulk',
    displayName: `一般${n}`,
    message: `一般のコメント${n}`,
    searchText: `一般${n} 一般のコメント${n}`,
    publishedAt: '2026-09-07T13:02:00.000Z',
    ...fields
  });

  const primaryComment = (n, fields = {}) => ({
    id: `primary_${n}`,
    kind: 'text',
    role: 'moderator',
    bucket: 'primary',
    displayName: `モデ${n}`,
    message: `モデのコメント${n}`,
    searchText: `モデ${n} モデのコメント${n}`,
    publishedAt: '2026-09-07T13:02:00.000Z',
    ...fields
  });

  /** primary だけをメモリに載せた状態の popup を作る（起動直後の姿） */
  async function withStoredComments(stored, { filters = {}, maxCommentsToPopup = null } = {}) {
    const popup = loadPopup({ maxCommentsToPopup });
    await popup.YTFStore.append('vid1', stored);

    const c = new popup.__popup.PopupController();
    c.popup = popup;
    c.commentFilters = { ...ALL_ON, sponsor: false, normal: false, ...filters };
    c.currentVideoId = 'vid1';

    const primary = await popup.YTFStore.read('vid1', { bucket: 'primary' });
    c.setComments(primary.map(comment => c.formatComment(comment)));
    await c.loadBulkCount('vid1');
    await c.renderWithBulk();
    return c;
  }

  test('起動時は primary だけを載せ、bulk は読まない', async () => {
    const c = await withStoredComments([
      primaryComment(1), bulkComment(1), bulkComment(2), primaryComment(2)
    ]);

    assert.deepEqual(visibleUsernames(c.elements.commentsList), ['モデ1', 'モデ2']);
    assert.equal(c.comments.length, 2, 'bulk までメモリに載せている');
    assert.equal(c.rows.size, 2, 'bulk の行まで作っている');
    assert.equal(c.unloadedBulk, 2);
  });

  test('「一般」をONにすると IndexedDB から引いて、保存順に並ぶ', async () => {
    const c = await withStoredComments([
      primaryComment(1), bulkComment(1), primaryComment(2), bulkComment(2)
    ]);

    c.commentFilters.normal = true;
    await c.renderWithBulk();

    assert.deepEqual(visibleUsernames(c.elements.commentsList),
      ['モデ1', '一般1', 'モデ2', '一般2']);
    assert.equal(c.unloadedBulk, 0);
  });

  test('検索は、メモリに無い bulk にも効く', async () => {
    // 「取得済み全件を検索できる」がこの拡張機能の売り。bulk を遅延にしても
    // そこは崩さない（検索が始まったら読む）
    const c = await withStoredComments([
      primaryComment(1), bulkComment(1, { message: 'ここにしかない語' , searchText: 'ここにしかない語' })
    ]);
    assert.equal(c.comments.length, 1);

    c.searchQuery = 'ここにしかない語';
    c.commentFilters.normal = true;
    await c.renderWithBulk();

    assert.deepEqual(visibleUsernames(c.elements.commentsList), ['一般1']);
  });

  test('未読み込みのあいだ、メンバーと一般の件数は数字を出さない', async () => {
    // 0 と出すと「そもそも無い」という嘘になる（#18 が批判していた形）。
    // バッジ自身がトグルなので、押せば読み込まれて数字になる
    const c = await withStoredComments([primaryComment(1), bulkComment(1), bulkComment(2)]);

    assert.equal(c.elements.normalCount.textContent, '一般: ?');
    assert.equal(c.elements.sponsorCount.textContent, 'メンバー: ?');
    assert.match(c.elements.normalCount.title, /未読み込み2件/);
    // 数えられる枠は今までどおり数字
    assert.equal(c.elements.moderatorCount.textContent, 'モデレーター: 1');

    c.commentFilters.normal = true;
    await c.renderWithBulk();
    assert.equal(c.elements.normalCount.textContent, '一般: 2');
    assert.equal(c.elements.sponsorCount.textContent, 'メンバー: 0');
  });

  test('保存された bulk が無ければ、最初から数字で出す', async () => {
    const c = await withStoredComments([primaryComment(1)]);
    assert.equal(c.elements.normalCount.textContent, '一般: 0');
    assert.equal(c.unloadedBulk, 0);
  });

  test('メモリの上限に当たったら、載せきれなかった件数を残す', async () => {
    // 上限は primary と bulk で共有する。primary を先に確保してあるので、
    // 溢れるのは bulk の古い方（特別コメントは押し出されない＝決定3）
    const c = await withStoredComments(
      [primaryComment(1), bulkComment(1), bulkComment(2), bulkComment(3)],
      { filters: { normal: true }, maxCommentsToPopup: 3 });

    assert.equal(c.comments.length, 3);
    assert.deepEqual(visibleUsernames(c.elements.commentsList), ['モデ1', '一般2', '一般3']);
    assert.equal(c.unloadedBulk, 1, '載せきれなかったぶんを 0 と言っている');
    assert.equal(c.elements.normalCount.textContent, '一般: ?');
  });

  test('popup は storage.local からの移行を走らせない', async () => {
    // 移行は片道で、Service Worker と同時に走らせると履歴が二重に積まれる
    // （フェーズ3の制約）。popup が IndexedDB を開くのはフェーズ5からなので、
    // ここを踏み外していないことを固定する
    const popup = loadPopup({ storage: { commentsHistory_vid1: [primaryComment(9)] } });
    const c = new popup.__popup.PopupController();
    c.currentVideoId = 'vid1';
    await c.loadBulkCount('vid1');

    assert.equal(c.unloadedBulk, 0);
    // 旧キーは popup 側では触られないまま残っている（消すのは Service Worker）
    const left = await popup.chrome.storage.local.get(['commentsHistory_vid1']);
    assert.equal(left.commentsHistory_vid1.length, 1);
  });
});
