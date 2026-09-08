// popup の UI の穴（フェーズ8）のテスト。
//
// 直しているのは、どれも「見えている不具合」——
// #13 キーボードで触れない / #15 起動直後のちらつき /
// #16 ボタンの二重配線 / #17 文言と挙動の食い違い / #19 チップ幅の跳ね。
//
// CSS と HTML は文字列として見る（偽DOMは CSS を解釈しないので、
// 「タブ順から外れているか」は原理的に実行では確かめられない）。
// 配線のほうは偽DOMで実際に押して確かめる。

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadPopup } = require('./helpers/popup-harness');

const POPUP_DIR = path.join(__dirname, '..', 'src', 'popup');
const POPUP_JS = fs.readFileSync(path.join(POPUP_DIR, 'popup.js'), 'utf8');
const POPUP_CSS = fs.readFileSync(path.join(POPUP_DIR, 'popup.css'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(POPUP_DIR, 'popup.html'), 'utf8');

/** チェックボックスを隠している規則の中身を取り出す */
function checkboxRule() {
  const match = POPUP_CSS.match(/\.filter-toggle-container input\[type="checkbox"\]\s*{([^}]*)}/);
  assert.ok(match, '.filter-toggle-container input[type="checkbox"] の規則が見つからない');
  return match[1];
}

describe('キーボード到達性（#13）', () => {
  test('チェックボックスを display: none で隠していない', () => {
    // display: none は要素をタブ順から外す。9個のトグル（フィルター6つ・
    // ダークモード・12時間表記・秒表示）が、キーボードだけの利用者には
    // まったく操作できなかった。ダークモードと時刻表示には代替経路も無い
    const rule = checkboxRule();
    assert.doesNotMatch(rule, /display:\s*none/);
    // 「見えないが掴める」形（レイアウトに影響しない絶対配置 + 透明）
    assert.match(rule, /position:\s*absolute/);
    assert.match(rule, /opacity:\s*0/);
  });

  test('掴んでいることが見える（スライダーに :focus-visible）', () => {
    // input 自体は透明なので、枠は隣の（見えている）スライダーに出す
    assert.match(
      POPUP_CSS,
      /\.filter-toggle-container input\[type="checkbox"\]:focus-visible\s*\+\s*\.toggle-slider\s*{[^}]*outline:/
    );
  });

  test('フォーカス表示が無かったボタン6種に付いている', () => {
    // 監査時点で :focus / :focus-visible は CSS 全体に4か所しか無く、
    // そのどれもボタンではなかった（.comment-count-item だけが正しく作られていた）
    for (const selector of [
      '.tb-btn', '.btn', '.btn-preset', '.btn-save', '.btn-clear-search', '.btn-clear-filter'
    ]) {
      assert.ok(
        POPUP_CSS.includes(`${selector}:focus-visible`),
        `${selector}:focus-visible が無い`
      );
    }
    // フェーズ7で足したヘルス表示は読み上げ専用。フォーカスを取らせない
    assert.doesNotMatch(POPUP_CSS, /\.chat-health[^{,]*:focus/);
    assert.doesNotMatch(POPUP_HTML, /id="chat-health"[^>]*tabindex/);
  });

  test('閉じているドロワーは inert（見えないトグルにフォーカスが入らない）', () => {
    // 閉じたドロワーは max-height: 0 + overflow: hidden で切り取られているだけで、
    // 中の要素は生きている。チェックボックスが掴めるようになったぶん、
    // 何もしないと Tab で「見えない9個のトグル」を順に踏むことになる
    const popup = loadPopup();
    popup.document.fire('DOMContentLoaded');

    const drawer = popup.document.peek('settings-drawer');
    const gear = popup.document.peek('settings-toggle-btn');
    assert.equal(drawer.inert, true);

    gear.fire('click', { stopPropagation() {} });
    assert.equal(drawer.inert, false);
    assert.equal(drawer.getAttribute('aria-hidden'), 'false');

    gear.fire('click', { stopPropagation() {} });
    assert.equal(drawer.inert, true);
    assert.equal(drawer.getAttribute('aria-hidden'), 'true');
  });

  test('Esc で閉じ、フォーカスは開けた歯車へ戻る', () => {
    const popup = loadPopup();
    popup.document.fire('DOMContentLoaded');
    const drawer = popup.document.peek('settings-drawer');
    const gear = popup.document.peek('settings-toggle-btn');

    gear.fire('click', { stopPropagation() {} });
    popup.document.activeElement = null;

    popup.document.fire('keydown', { key: 'Escape' });
    assert.equal(drawer.classList.contains('open'), false);
    assert.equal(drawer.inert, true);
    // inert にするとフォーカスは中に居られない。返さないと Tab が先頭に戻る
    assert.equal(popup.document.activeElement, gear);
  });

  test('閉じているときの Esc では何も起きない', () => {
    const popup = loadPopup();
    popup.document.fire('DOMContentLoaded');
    const gear = popup.document.peek('settings-toggle-btn');
    popup.document.activeElement = null;

    popup.document.fire('keydown', { key: 'Escape' });
    assert.equal(popup.document.activeElement, null);
    assert.notEqual(popup.document.activeElement, gear);
  });
});

describe('テーマのちらつき（#15）', () => {
  test('popup.html は theme.js を <head> で読む', () => {
    // body の末尾（popup.js の隣）で読むと、最初の描画に間に合わない
    const head = POPUP_HTML.slice(0, POPUP_HTML.indexOf('</head>'));
    assert.match(head, /<script src="\.\.\/shared\/theme\.js">/);
  });

  test('Service Worker との往復を待たずに塗る', async () => {
    // 偽ポートは既定で応答を返さない = Service Worker が居ない状態。
    // 以前はこの状態だと completeBasicInitialization が進まず、
    // ライトテーマの利用者が真っ黒な popup を見たまま待たされた
    const popup = loadPopup({ storage: { theme: 'dark' } });
    popup.document.fire('DOMContentLoaded');
    for (let i = 0; i < 5; i++) await Promise.resolve();

    assert.equal(popup.document.documentElement.getAttribute('data-theme'), 'dark');
    // ポートには要求が積まれたまま（＝応答は1つも返っていない）
    assert.ok(popup.chrome.__port().posted.length > 0);
  });

  test('popup.js は自前で loadTheme を持たない（正は shared/theme.js）', () => {
    assert.doesNotMatch(POPUP_JS, /async function loadTheme\s*\(/);
  });
});

describe('ボタンの二重配線（#16）', () => {
  test('popup.js に onclick の代入が1つも無い', () => {
    // addEventListener と onclick は共存する（両方発火する）。
    // しかも onclick は後から外す経路が無く、quota エラーを一度踏むと
    // 「設定画面」を押すたびに Cloud Console と設定画面の両方が開いた
    const assignments = POPUP_JS.match(/\.onclick\s*=/g) || [];
    assert.deepEqual(assignments, []);
  });

  test('quota エラーを踏んでも、次のエラーで「設定画面」に戻る', () => {
    const popup = loadPopup();
    const c = new popup.__popup.PopupController();
    const opened = [];
    c.openOptionsPage = () => opened.push('options');
    c.openQuotaConsole = () => opened.push('console');

    c.updateErrorActionButtons('waitOrUpgrade');
    assert.equal(c.elements.optionsButton.dataset.action, 'quotaConsole');
    c.elements.optionsButton.fire('click');
    assert.deepEqual(opened, ['console']);

    // 別のエラーに変わったら、行き先も文言も戻る（ここが戻らなかったのが #16）
    c.updateErrorActionButtons('checkApiKey');
    assert.equal(c.elements.optionsButton.dataset.action, 'options');
    c.elements.optionsButton.fire('click');
    assert.deepEqual(opened, ['console', 'options']);
  });

  test('修復に失敗したボタンは dataset.action で行き先を伝える', () => {
    const popup = loadPopup();
    const c = new popup.__popup.PopupController();
    const reloads = [];
    c.reloadCurrentTab = () => reloads.push(true);
    c.fixExtension = () => reloads.push('fix');

    c.showContentScriptError();
    assert.equal(c.elements.fixExtensionBtn.dataset.action, 'reload');

    c.elements.fixExtensionBtn.fire('click');
    // リスナー1本だけが動く（onclick と二重に発火しない）
    assert.deepEqual(reloads, [true]);
  });
});

describe('再試行ボタンの文言と挙動（#17）', () => {
  const controller = () => {
    const popup = loadPopup();
    const c = new popup.__popup.PopupController();
    c.hideDetailedError = () => {};
    return c;
  };

  test('名乗る文言は、実際にできる2つだけ', () => {
    // 以前は「1分後に再試行」「明日再試行」「接続確認」「再確認」も出していたが、
    // handleRetry は常に同じことをしていた（5種類のうち4つが嘘）。
    // 待ち時間の案内は solution の文に残っている
    const c = controller();
    const actions = [
      'setApiKey', 'checkApiKey', 'waitAndRetry', 'waitOrUpgrade',
      'checkConnection', 'reload', 'waitForChat', 'findLiveStream', undefined
    ];
    for (const action of actions) {
      c.updateErrorActionButtons(action);
      const label = c.elements.retryButton.textContent;
      assert.ok(['再試行', 'ページ再読込'].includes(label), `知らない文言: ${label}`);
      assert.equal(label === 'ページ再読込', c.elements.retryButton.dataset.action === 'reload');
    }
  });

  test('「ページ再読込」はタブを読み込み直す', () => {
    const c = controller();
    const done = [];
    c.reloadCurrentTab = () => done.push('reload');
    c.startMonitoring = () => done.push('start');

    c.updateErrorActionButtons('reload');
    c.elements.retryButton.fire('click');
    assert.deepEqual(done, ['reload']);
  });

  test('「再試行」は取得を開始し直す', () => {
    const c = controller();
    const done = [];
    c.reloadCurrentTab = () => done.push('reload');
    c.startMonitoring = () => done.push('start');

    c.updateErrorActionButtons('waitOrUpgrade');
    c.elements.retryButton.fire('click');
    assert.deepEqual(done, ['start']);
  });

  test('前のエラーの行き先を引きずらない', () => {
    const c = controller();
    const done = [];
    c.reloadCurrentTab = () => done.push('reload');
    c.startMonitoring = () => done.push('start');

    c.updateErrorActionButtons('reload');
    c.updateErrorActionButtons('checkConnection');
    c.elements.retryButton.fire('click');
    assert.deepEqual(done, ['start']);
  });
});

describe('チップ幅の跳ね（#19）', () => {
  test('件数バッジの初期値は、JS が最初に書く文言と一致する', () => {
    // HTML が「モデレ: 0」、JS が「モデレーター: 0」だったので、
    // 最初の renderComments でチップが横に広がり、レイアウトが目に見えて動いた
    const prefixes = Array.from(
      POPUP_JS.matchAll(/elements\.(\w+)Count\.textContent = `([^:`$\n]+): /g),
      m => [m[1], m[2]]
    );
    assert.equal(prefixes.length, 6);

    for (const [key, prefix] of prefixes) {
      const id = key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
      const cell = POPUP_HTML.match(new RegExp(`id="${id}-count"[^>]*>([^<]*)<`));
      assert.ok(cell, `popup.html に ${id}-count が無い`);
      assert.match(cell[1], new RegExp(`^${prefix}: `), `${id}-count の初期値がずれている`);
    }
  });
});

describe('ヘルス表示の色（フェーズ7からの申し送り）', () => {
  test('色は変数で、ライトテーマにも値がある', () => {
    // 緑・橙・赤を直書きしていたので、ライトテーマ（白地）では
    // 文言のコントラストが 2〜3 しか無かった
    for (const name of ['--health-ok', '--health-warn', '--health-error']) {
      assert.ok(POPUP_CSS.includes(`var(${name})`), `${name} が使われていない`);
      const defs = POPUP_CSS.match(new RegExp(`${name}:`, 'g')) || [];
      assert.equal(defs.length, 2, `${name} はダークとライトの2か所で定義する`);
    }
    assert.doesNotMatch(POPUP_CSS, /\.chat-health--\w+[^{]*{[^}]*#[0-9a-fA-F]{3,8}/);
  });
});
