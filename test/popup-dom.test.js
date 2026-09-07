// popup の偽DOM（ハーネス）と、popup.js ↔ popup.html の対応の回帰テスト。
//
// popup の描画そのものは、まだテストできない（PopupController は
// DOMContentLoaded でしか生成されず、初期化が実時間の再試行を伴う）。
// ここで固定しているのは、その土台になる偽DOMの振る舞いと、
// 「JS が引く id が HTML に実在するか」という一番安い契約だけ。

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeDocument, idsInPopupHtml } = require('./helpers/popup-harness');

const POPUP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'popup', 'popup.js'), 'utf8'
);

describe('popup.js と popup.html の対応', () => {
  test('getElementById で引いている id は、すべて popup.html にある', () => {
    const htmlIds = idsInPopupHtml();
    const jsIds = new Set(
      Array.from(POPUP_JS.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g), m => m[1])
    );

    // 綴り違いや、HTMLから消えた要素への参照は、その要素だけが黙って
    // null になる。押しても何も起きないボタンとして本番でだけ現れる
    const missing = [...jsIds].filter(id => !htmlIds.has(id));
    assert.deepEqual(missing, [], `popup.html に無い id を引いている: ${missing.join(', ')}`);
  });
});

describe('偽 document', () => {
  test('popup.html に無い id を引いたら例外にする', () => {
    const doc = createFakeDocument();

    // 実在する id は要素を返し、同じ id なら常に同じ要素
    const list = doc.getElementById('comments-list');
    assert.equal(doc.getElementById('comments-list'), list);

    assert.throws(() => doc.getElementById('comments-lst'), /popup\.html に id/);
  });

  test('書き込みを記録する（描画テストの土台）', () => {
    const doc = createFakeDocument();
    const list = doc.getElementById('comments-list');

    const row = doc.createElement('div');
    row.setAttribute('data-comment-id', 'dom_1_0');
    row.textContent = 'こんばんは';
    list.appendChild(row);

    assert.deepEqual(doc.calls.createElement, ['div']);
    assert.deepEqual(row.writes.textContent, ['こんばんは']);
    assert.equal(row.getAttribute('data-comment-id'), 'dom_1_0');
    assert.deepEqual(list.children, [row]);

    // innerHTML の全置換は子を作り直す（#22 が消えたかを見るための土台）
    list.innerHTML = '';
    assert.deepEqual(list.children, []);
    assert.equal(list.writes.innerHTML.length, 1);
  });
});
