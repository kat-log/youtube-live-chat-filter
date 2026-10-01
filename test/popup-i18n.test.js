// popup の英語対応（docs/i18n-plan.md の段階2）のテスト。
//
// 既存の popup のテストは chrome.i18n のモックが ja で動いている（日本語の
// アサーションをそのまま通すため）。ここでは en で開いて、
//   - 文言で分岐していた箇所（罠3）が、英語でも同じように動くこと
//   - ID に入る文字列を訳していないこと（罠1）
//   - popup.html に直接書いた英語が、en の messages.json と食い違っていないこと
// を見る。

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadPopup, createChromeMock, readCommentRows, findByClass } = require('./helpers/popup-harness');
const { LOCALES_DIR } = require('./helpers/i18n-mock');

const POPUP_DIR = path.join(__dirname, '..', 'src', 'popup');
const POPUP_HTML = fs.readFileSync(path.join(POPUP_DIR, 'popup.html'), 'utf8');
const POPUP_CSS = fs.readFileSync(path.join(POPUP_DIR, 'popup.css'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en', 'messages.json'), 'utf8'));

const ALL_ON = {
  owner: true, moderator: true, sponsor: true,
  normal: true, superchat: true, membership: true
};

function controller(locale = 'en') {
  const popup = loadPopup({ chrome: createChromeMock({ locale }) });
  const c = new popup.__popup.PopupController();
  c.commentFilters = { ...ALL_ON };
  c.popup = popup;
  return c;
}

const decode = text => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('popup.html の既定文言', () => {
  test('data-i18n* を付けた要素に直接書いた文言は、en の messages.json と同じ', () => {
    // JS が走る前（と、走らなかったとき）に見えるのは HTML の文言。
    // en と食い違うと、英語の利用者には一瞬だけ別の文言が見える
    const bindings = [
      ['data-i18n-title', 'title'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label']
    ];
    let checked = 0;
    for (const [, tag, rest] of POPUP_HTML.matchAll(/<([a-z0-9]+)\b([^>]*\bdata-i18n[^>]*)>/g)) {
      const attr = name => rest.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
      const textKey = attr('data-i18n');
      if (textKey) {
        const start = POPUP_HTML.indexOf(`<${tag}${rest}>`) + `<${tag}${rest}>`.length;
        const text = POPUP_HTML.slice(start, POPUP_HTML.indexOf('<', start)).replace(/\s+/g, ' ').trim();
        assert.equal(decode(text), EN[textKey].message, `data-i18n="${textKey}" の既定文言`);
        checked++;
      }
      for (const [binding, target] of bindings) {
        const key = attr(binding);
        if (!key) continue;
        assert.equal(decode(attr(target) ?? ''), EN[key].message, `${binding}="${key}" の既定文言`);
        checked++;
      }
    }
    assert.ok(checked > 30, `data-i18n* が少なすぎる（${checked}）`);
  });

  test('popup.html には日本語の文言が残っていない（コメントを除く）', () => {
    const html = POPUP_HTML.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(html, /[぀-ヿ一-鿿]/);
    assert.match(POPUP_HTML, /<html lang="en">/);
  });

  test('CSS の content に日本語を書かない（属性から引く）', () => {
    // CSS の __MSG_ は手動の言語切替に追従しないので使わない
    const contents = Array.from(POPUP_CSS.matchAll(/content:\s*([^;]+);/g), m => m[1]);
    for (const value of contents) {
      assert.doesNotMatch(value, /[぀-ヿ一-鿿]/, `content: ${value}`);
      assert.doesNotMatch(value, /__MSG_/, `content: ${value}`);
    }
    assert.match(POPUP_CSS, /\.mode-select-wrapper\.monitoring:hover::after\s*{[^}]*content:\s*attr\(data-hint\)/);
    assert.match(POPUP_CSS, /\.error-solution::before\s*{[^}]*attr\(data-label\)/);
  });
});

describe('英語で開いた popup', () => {
  test('初期化の冒頭で表示言語を当てる（CSS の吹き出しの文言も入る）', async () => {
    const c = controller();
    await c.applyLanguage();
    assert.equal(c.elements.modeSelectWrapper.getAttribute('data-hint'), EN.chatModeLockedHint.message);
    assert.equal(c.elements.errorSolution.getAttribute('data-label'), EN.errorSolutionLabel.message);
  });

  test('取得中かどうかの色は、文言ではなく状態のキーで決まる', () => {
    // 以前は status.includes('取得中') で決めていたので、訳すと常にオフライン色になった
    const c = controller();
    for (const [state, online] of [
      ['monitoring', true], ['monitoringDom', true], ['stopped', false],
      ['autoStopped', false], ['liveChatFound', false], ['error', false]
    ]) {
      c.updateStatus(state);
      assert.equal(c.status, state);
      assert.equal(c.elements.statusIndicator.className,
        `status-indicator ${online ? 'status-online' : 'status-offline'}`, state);
    }
    c.updateStatus('monitoringDom');
    assert.equal(c.elements.statusIndicator.textContent, 'Collecting (DOM)');
  });

  test('件数バッジとツールチップは「名前: 数」の形で、複数形に頼らない', () => {
    const c = controller();
    c.unloadedBulk = 3;
    c.updateCountBadges({ owner: 1, moderator: 2, sponsor: 0, normal: 0, superchat: 4, membership: 5 }, 12);
    assert.equal(c.elements.totalCount.textContent, 'Total: 12');
    assert.equal(c.elements.ownerCount.textContent, 'Streamer: 1');
    assert.equal(c.elements.moderatorCount.textContent, 'Moderator: 2');
    assert.equal(c.elements.sponsorCount.textContent, 'Member: ?');
    assert.equal(c.elements.normalCount.textContent, 'Regular: ?');
    assert.equal(c.elements.superchatCount.textContent, 'Super Chat: 4');
    assert.equal(c.elements.membershipCount.textContent, 'Joins & gifts: 5');
    assert.equal(c.elements.normalCount.title, 'Click to load and show (not loaded yet: 3)');
    assert.equal(c.elements.ownerCount.title, 'Click to hide (currently shown)');
  });

  test('スーパーステッカーは描画するときだけ訳し、保存値と ID は変えない', () => {
    // eventText は DOMモードで commentKeyOf() のキーに混ざる。訳すと言語ごとに
    // ID が変わり、更新前の履歴と突き合わせられなくなる
    const c = controller();
    const sticker = {
      id: 'dom2_sticker_en', kind: 'supersticker', role: 'normal', displayName: 'Alice',
      message: 'cat-wave', amountText: '¥200', eventText: 'スーパーステッカー',
      publishedAt: '2026-09-07T13:02:00.000Z'
    };
    c.setComments([sticker]);
    c.renderComments();

    const [row] = readCommentRows(c.elements.commentsList);
    assert.equal(findByClass(row.element, 'comment-event').textContent, 'Super Sticker');
    assert.equal(findByClass(row.element, 'comment-kind').getAttribute('title'), 'Super Sticker');
    assert.equal(row.id, 'dom2_sticker_en');
    // メモリ上の保存値は日本語の正準トークンのまま
    assert.equal(c.comments[0].eventText, 'スーパーステッカー');
  });

  test('スーパーステッカー以外の eventText は受け取ったまま出す（段階3まで）', () => {
    const c = controller();
    c.setComments([{
      id: 'api_member', kind: 'membership', role: 'member', displayName: 'Bob',
      message: '', eventText: '新規メンバー', publishedAt: '2026-09-07T13:02:00.000Z'
    }]);
    c.renderComments();
    const [row] = readCommentRows(c.elements.commentsList);
    assert.equal(findByClass(row.element, 'comment-event').textContent, '新規メンバー');
  });

  test('役割バッジの名前も英語になる', () => {
    const c = controller();
    const formatted = c.formatComment({
      id: 'm1', role: 'moderator', displayName: 'Mod', message: 'hi',
      publishedAt: '2026-09-07T13:02:00.000Z'
    });
    assert.equal(formatted.roleLabel, 'Moderator');
  });

  test('0件の理由も英語で、検索語を差し込める', () => {
    const c = controller();
    c.setComments([{
      id: 'a', role: 'normal', displayName: 'Carol', message: 'good evening',
      publishedAt: '2026-09-07T13:02:00.000Z'
    }]);
    c.searchKeyword = 'nothing$1';
    c.searchQuery = 'nothing$1';
    c.renderComments();
    assert.equal(c.elements.noComments.textContent,
      'No comments match “nothing$1” (searched all 1 collected)');
  });

  test('修復が成功したらボタンを戻す（ボタンの文言では判定しない）', async () => {
    // 以前は textContent === '修復中...' で判定していたので、訳すと戻らなくなった
    const c = controller();
    c.delay = async () => {};
    c.currentTab = { id: 1 };
    c.requestBackground = async () => ({ success: true });
    c.sendTabMessageWithTimeout = async () => ({ success: true });
    await c.fixExtension();
    assert.equal(c.elements.fixExtensionBtn.textContent, 'Repair');
    assert.equal(c.elements.fixExtensionBtn.disabled, false);
    assert.equal(c.elements.fixExtensionBtn.dataset.action, undefined);
  });

  test('修復に失敗したら「タブを再読み込み」のまま残す', async () => {
    const c = controller();
    c.delay = async () => {};
    c.currentTab = { id: 1 };
    c.requestBackground = async () => ({ success: false });
    await c.fixExtension();
    assert.equal(c.elements.fixExtensionBtn.textContent, 'Reload tab');
    assert.equal(c.elements.fixExtensionBtn.dataset.action, 'reload');
  });

  test('自動停止の理由（SW が作った文言）は、そのまま英語の枠に入れる', () => {
    const c = controller();
    c.showAutoStopNotification('配信が終了しました');
    assert.equal(c.elements.errorMessage.textContent,
      'ℹ️ Collecting stopped automatically: 配信が終了しました');
  });
});
