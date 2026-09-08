// 設定画面（options）のテスト。フェーズ8で新設。
//
// この画面は長らくテスト0件で、そのせいで #12（既定構成の利用者は
// デバッグモードを一生ONにできない）が見逃されていた（#T7）。
// ここで固定するのは、フェーズ8で触った2つ——テーマの追従（#14）と、
// 画面と JS の対応（引く id、スイッチがキーボードで掴めるか）。

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadOptions, idsInOptionsHtml } = require('./helpers/options-harness');

const OPTIONS_DIR = path.join(__dirname, '..', 'src', 'options');
const OPTIONS_JS = fs.readFileSync(path.join(OPTIONS_DIR, 'options.js'), 'utf8');
const OPTIONS_CSS = fs.readFileSync(path.join(OPTIONS_DIR, 'options.css'), 'utf8');
const OPTIONS_HTML = fs.readFileSync(path.join(OPTIONS_DIR, 'options.html'), 'utf8');

/** DOMContentLoaded まで流して、コントローラを作る */
function openOptions(options = {}) {
  const h = loadOptions(options);
  h.document.fire('DOMContentLoaded');
  return h;
}

/** loadSettings の await が全部解けるまで待つ */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('options.js と options.html の対応', () => {
  test('getElementById で引いている id は、すべて options.html にある', () => {
    const htmlIds = idsInOptionsHtml();
    const jsIds = new Set(
      Array.from(OPTIONS_JS.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g), m => m[1])
    );
    const missing = [...jsIds].filter(id => !htmlIds.has(id));
    assert.deepEqual(missing, [], `options.html に無い id を引いている: ${missing.join(', ')}`);
  });

  test('DOMContentLoaded で組み上がる（引かれた id が全部実在する）', () => {
    // 偽 document は options.html に無い id を引かれたら例外にする。
    // つまりこのテストは「例外なく組み上がること」そのものを見ている
    const h = openOptions();
    assert.ok(h.document.peek('theme-toggle'));
    assert.ok(h.document.peek('debug-mode'));
  });
});

describe('テーマの追従（#14）', () => {
  test('保存されたテーマで、読み込みと同時に data-theme が立つ', async () => {
    // 以前はこの画面だけが仕組みの外にあり、data-theme も
    // prefers-color-scheme も出現回数0だった（永久にライトテーマ）
    const h = loadOptions({ storage: { theme: 'dark' } });
    await settle();
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
  });

  test('この画面でONにすると、この画面自身も即その場で暗くなる', async () => {
    const h = openOptions({ storage: {} });
    await settle();
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light');

    const toggle = h.document.peek('theme-toggle');
    toggle.checked = true;
    toggle.fire('change');
    await settle();

    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.deepEqual(h.chrome.__calls.storageWrites, [{ theme: 'dark' }]);
  });

  test('popup 側で変えられても追従し、トグルの位置も合わせる', async () => {
    const h = openOptions({ storage: {} });
    await settle();

    h.chrome.__emitStorageChange({ theme: { newValue: 'dark' } });
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(h.document.peek('theme-toggle').checked, true);

    h.chrome.__emitStorageChange({ theme: { newValue: 'light' } });
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(h.document.peek('theme-toggle').checked, false);
  });

  test('テーマ以外の storage 変更では塗り直さない', async () => {
    const h = openOptions({ storage: { theme: 'dark' } });
    await settle();
    h.chrome.__emitStorageChange({ debugMode: { newValue: true } });
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
  });
});

describe('options.css（#13 #14）', () => {
  test('スイッチを display: none で隠していない（タブ順から外れる）', () => {
    // 5つのスイッチ（ダークモード・12時間表記・秒表示・デバッグ・自動取得）が
    // キーボードだけの利用者には操作できなかった
    assert.doesNotMatch(OPTIONS_CSS, /\.debug-switch\s*{[^}]*display:\s*none/);
    assert.match(OPTIONS_CSS, /\.debug-switch\s*{[^}]*opacity:\s*0/);
  });

  test('掴んでいることが見える（:focus-visible）', () => {
    assert.match(OPTIONS_CSS, /\.debug-switch:focus-visible\s*\+\s*\.switch-label/);
    assert.match(OPTIONS_CSS, /\.btn:focus-visible/);
  });

  test('ダークテーマの変数を持っている', () => {
    assert.match(OPTIONS_CSS, /\[data-theme="dark"\]\s*{/);
  });

  test('色は変数経由（ダーク側に取り残しが無い）', () => {
    // 生の16進が残っていると、その要素だけライトのまま取り残される。
    // 例外は「テーマに関係なく同じ」もの: 役割バッジ・トーストの4色と
    // 白（バッジやヘッダーの文字色）
    const ALLOWED = new Set([
      '#ff9800', '#2196f3', '#4caf50', '#9e9e9e', // 役割バッジ
      '#f44336', // トースト（error）
      '#ffffff'
    ]);
    // コメントと、変数の定義そのもの（:root と [data-theme="dark"] のブロック）は対象外
    const body = OPTIONS_CSS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(:root|\[data-theme="dark"\])\s*{[^}]*}/g, '');
    const leftovers = Array.from(body.matchAll(/#[0-9a-fA-F]{3,8}\b/g), m => m[0].toLowerCase())
      .filter(hex => !ALLOWED.has(hex));
    assert.deepEqual(leftovers, [], `変数にしていない色が残っている: ${leftovers.join(', ')}`);
  });
});

describe('options.html', () => {
  test('テーマは <head> で読む（最初の描画より前に決めるため）', () => {
    const head = OPTIONS_HTML.slice(0, OPTIONS_HTML.indexOf('</head>'));
    assert.match(head, /<script src="\.\.\/shared\/theme\.js">/);
  });
});
