const test = require('node:test');
const assert = require('node:assert');
const { loadPopup } = require('./helpers/popup-harness');

const popup = loadPopup();
// 正規化と検索文字列の生成は shared/comment.js に移った（再設計の決定7）。
// popup.js は self.YTF から取り込んで使う
const { normalizeForSearch, searchTextOf } = popup.YTF;

// 検索対象を1件ぶん組み立てる（ポップアップが持つ整形済みコメントと同じ形）
function comment(fields) {
  return { displayName: '', message: '', eventText: null, amountText: null, ...fields };
}

function hits(comments, keyword) {
  const query = normalizeForSearch(keyword);
  return comments.filter(c => !query || searchTextOf(c).includes(query)).length;
}

test('YouTubeのチャットからコピーしたキーワードでもヒットする', () => {
  // ライブチャットのコメントをコピーすると、先頭にゼロ幅スペースなどの
  // 見えない文字が付いてくる。貼り付けた見た目は同じなのに0件になっていた
  const comments = [
    comment({ displayName: 'maki_nao', message: 'お、直通' }),
    comment({ displayName: 'BunchozYk', message: 'おお' }),
    comment({ displayName: 'sn490b', message: 'いけそうだ' })
  ];

  assert.strictEqual(hits(comments, 'お'), 2);
  assert.strictEqual(hits(comments, '​お'), 2);          // ゼロ幅スペース
  assert.strictEqual(hits(comments, '﻿お‎'), 2);    // BOM・左横書き記号
  assert.strictEqual(hits(comments, '​お、直通'), 1);
});

test('見えない文字だけが残った入力は「検索していない」扱いになる', () => {
  // バックスペースで消しきったつもりでもゼロ幅文字が残ることがある。
  // 空扱いにしないと、見た目が空の検索欄で全件が消える
  assert.strictEqual(normalizeForSearch('​​'), '');
  assert.strictEqual(normalizeForSearch('﻿ 　'), '');
});

test('全角・半角の揺れと前後の空白では取りこぼさない', () => {
  const comments = [comment({ displayName: 'ｶﾅ太郎', message: 'すごい！' })];

  assert.strictEqual(hits(comments, 'カナ'), 1);
  assert.strictEqual(hits(comments, 'すごい!'), 1);
  assert.strictEqual(hits(comments, '  すごい！  '), 1);
});

test('コメントの側に見えない文字が入っていてもヒットする', () => {
  const comments = [comment({ displayName: 'nao', message: 'お​、直通' })];

  assert.strictEqual(hits(comments, 'お、直通'), 1);
});

test('名前と本文をまとめてコピーしても、区切りの空白差で外れない', () => {
  // 検索対象は名前と本文を改行でつないだもの。貼り付け側は空白1個になる
  const comments = [comment({ displayName: 'maki_nao', message: 'お、直通' })];

  assert.strictEqual(hits(comments, 'maki_nao お、直通'), 1);
});

test('正規化済みの文字列はコメントごとに1度だけ作る', () => {
  const target = comment({ displayName: 'nao', message: 'おお' });

  assert.strictEqual(searchTextOf(target), 'nao おお');
  target.message = '書き換えても作り直さない';
  assert.strictEqual(searchTextOf(target), 'nao おお');
});
