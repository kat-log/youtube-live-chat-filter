// 表示側のフィルター（役割4種 × 種別2種）のテスト。
//
// フェーズ4（決定1）で、役割・種別の絞り込みは Service Worker の取り込み口から
// popup の表示側へ移った。取り込みは全件なので「保存されるか」ではもう
// 確かめられない。フィルターの2軸はこの製品の仕様の核心なので、
// 移設先のここで固定する（元は service-worker.test.js の
// describe('スーパーチャットとメンバーシップ') と「フィルターで除外された種別は
// 履歴に残らない」だった）。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadPopup, visibleUsernames } = require('./helpers/popup-harness');

const ALL_ON = {
  owner: true, moderator: true, sponsor: true,
  normal: true, superchat: true, membership: true
};

/** フィルターを当てた PopupController を1つ作る */
function controller(filters = ALL_ON) {
  const popup = loadPopup();
  const c = new popup.__popup.PopupController();
  c.commentFilters = { ...filters };
  return c;
}

let seq = 0;
/** 1件ぶんのコメント。発言者名を一意にして、描画結果から拾えるようにする */
const comment = (fields = {}) => ({
  id: `dom2_test_${seq++}`,
  role: 'normal',
  displayName: fields.kind ? `${fields.kind}の人${seq}` : `一般の人${seq}`,
  message: 'こんにちは',
  publishedAt: '2026-09-07T13:02:00.000Z',
  ...fields
});

/**
 * いま画面に出ている発言者名。出来上がった DOM を読むのは、
 * 「絞り込みの結果が本当に描画まで届いているか」まで見たいため。
 * フェーズ5 より前は innerHTML の文字列を正規表現で拾っていた
 */
const visibleNames = c => visibleUsernames(c.elements.commentsList);

/** バッジに出ている件数（数字だけ）を全部拾う */
const badgeCounts = c => Object.fromEntries(
  ['owner', 'moderator', 'sponsor', 'normal', 'superchat', 'membership']
    .map(key => [key, Number(c.elements[key + 'Count'].textContent.match(/\d+/)[0])]));

describe('表示側のフィルター（役割と種別の2軸）', () => {
  test('一般視聴者のスパチャは「一般」を切っていても表示される', () => {
    // スパチャは一般視聴者からも飛んでくるので、役割だけで絞ると取りこぼす
    const c = controller({ ...ALL_ON, normal: false });
    const paid = comment({ kind: 'superchat', amountText: '¥1,000', displayName: '投げた人' });
    c.setComments([paid, comment({ displayName: '普通の人' })]);

    c.renderComments();

    assert.deepEqual(visibleNames(c), ['投げた人']);
  });

  test('種別を切ると、その発言者の役割が有効でも表示されない', () => {
    const c = controller({ ...ALL_ON, superchat: false });
    c.setComments([
      comment({ role: 'member', kind: 'superchat', amountText: '¥500', displayName: 'スパチャ' }),
      comment({ role: 'member', kind: 'supersticker', amountText: '¥200', displayName: 'ステッカー' }),
      comment({ role: 'member', kind: 'membership', eventText: '新規メンバー', displayName: '加入' }),
      comment({ role: 'member', kind: 'gift', eventText: 'ギフト5個', displayName: 'ギフト' })
    ]);

    c.renderComments();

    assert.deepEqual(visibleNames(c), ['加入', 'ギフト']);
  });

  test('旧バージョンが保存した4項目のフィルターでも新しい種別は表示される', () => {
    // 更新直後は storage に superchat / membership が無い。欠けたキーを
    // false と解釈すると、アップデートした瞬間にスパチャが消える
    const popup = loadPopup();
    const c = new popup.__popup.PopupController();
    c.commentFilters = popup.YTF.normalizeCommentFilters(
      { owner: true, moderator: true, sponsor: true, normal: true });

    c.setComments([
      comment({ role: 'normal', kind: 'superchat', amountText: '¥1,000', displayName: 'スパチャ' }),
      comment({ role: 'member', kind: 'membership', eventText: '新規メンバー', displayName: '加入' })
    ]);
    c.renderComments();

    assert.deepEqual(visibleNames(c), ['スパチャ', '加入']);
  });

  test('kind を持たない旧 dom-chat.js のコメントは従来どおり役割で絞られる', () => {
    const c = controller({ ...ALL_ON, normal: false });
    c.setComments([
      comment({ role: 'normal', displayName: '一般' }),
      comment({ role: 'owner', displayName: '配信者' })
    ]);

    c.renderComments();

    assert.deepEqual(visibleNames(c), ['配信者']);
  });

  test('絞り込みで外したコメントも、トグルをONに戻すと出てくる', () => {
    // フェーズ4の本体。以前は Service Worker が取り込み時に捨てていたので、
    // ONに戻しても過去分は二度と戻らなかった（#4）
    const c = controller({ ...ALL_ON, normal: false });
    c.setComments([
      comment({ role: 'normal', displayName: '一般' }),
      comment({ role: 'owner', displayName: '配信者' })
    ]);

    c.renderComments();
    assert.deepEqual(visibleNames(c), ['配信者']);

    c.commentFilters.normal = true;
    c.renderComments();
    assert.deepEqual(visibleNames(c), ['一般', '配信者']);
  });
});

describe('件数バッジの母集団（#18）', () => {
  // 合計は「絞り込み後」、内訳は「取得済み全件」を数えていたので、
  // 並べて出しているのに数が合わなかった
  const sample = () => [
    comment({ role: 'owner', displayName: '配信者' }),
    comment({ role: 'moderator', displayName: 'モデレーター' }),
    comment({ role: 'member', displayName: 'メンバー' }),
    comment({ role: 'normal', displayName: '一般1' }),
    comment({ role: 'normal', displayName: '一般2' }),
    comment({ role: 'normal', kind: 'superchat', amountText: '¥500', displayName: 'スパチャ' }),
    comment({ role: 'member', kind: 'membership', eventText: '新規メンバー', displayName: '加入' })
  ];

  const totalOf = c => Number(c.elements.totalCount.textContent.match(/\d+/)[0]);

  test('表示中の枠の内訳を足すと、合計値に一致する', () => {
    const c = controller({ ...ALL_ON, normal: false, superchat: false });
    c.setComments(sample());

    c.renderComments();

    const counts = badgeCounts(c);
    const shown = Object.entries(counts)
      .filter(([key]) => c.commentFilters[key])
      .reduce((sum, [, n]) => sum + n, 0);
    assert.equal(shown, totalOf(c), '内訳の合計と合計値が食い違っている');
    assert.equal(totalOf(c), visibleNames(c).length, '合計値と実際に出ている件数が違う');
  });

  test('検索で絞ると、合計も内訳も同じ母集団になる', () => {
    // 以前は合計だけが検索の影響を受け、内訳は全件のままだった
    const c = controller();
    c.setComments(sample().map(x => ({ ...x, message: x.displayName })));
    c.searchQuery = '一般';

    c.renderComments();

    const counts = badgeCounts(c);
    assert.equal(counts.normal, 2, '内訳が検索前の件数のまま');
    assert.equal(counts.owner, 0);
    assert.equal(totalOf(c), 2);
    assert.equal(
      Object.values(counts).reduce((a, b) => a + b, 0), totalOf(c),
      '全部ONなら内訳の合計は合計値と一致する');
  });

  test('切ったフィルターの件数も数え続ける', () => {
    // バッジ自身がトグルなので、0 になってしまうと
    // 「そもそも無いのか、隠しているだけなのか」が利用者から見分けられない
    const c = controller({ ...ALL_ON, normal: false });
    c.setComments(sample());

    c.renderComments();

    assert.equal(badgeCounts(c).normal, 2, '隠しただけの枠が 0 になっている');
  });
});
