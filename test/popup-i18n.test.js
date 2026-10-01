// popup の英語対応（docs/i18n-plan.md の段階2・3）のテスト。
//
// 既存の popup のテストは chrome.i18n のモックが ja で動いている（日本語の
// アサーションをそのまま通すため）。ここでは en で開いて、
//   - 文言で分岐していた箇所（罠3）が、英語でも同じように動くこと
//   - ID に入る文字列を訳していないこと（罠1）
//   - popup.html に直接書いた英語が、en の messages.json と食い違っていないこと
//   - Service Worker がコードだけで送るもの（エラー詳細・自動停止の理由）と、
//     APIモードのメンバーイベント（eventKey）を、popup が英語で引くこと（段階3）
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

  test('コードを持たない eventText（DOMモード・旧履歴の日本語）は受け取ったまま出す', () => {
    // DOMモードの eventText は YouTube の表示そのもの（ID のキーにも混ざる）。
    // 旧履歴の日本語も移行しない（罠2）
    const c = controller();
    c.setComments([{
      id: 'old_member', kind: 'membership', role: 'member', displayName: 'Bob',
      message: '', eventText: '新規メンバー', publishedAt: '2026-09-07T13:02:00.000Z'
    }]);
    c.renderComments();
    const [row] = readCommentRows(c.elements.commentsList);
    assert.equal(findByClass(row.element, 'comment-event').textContent, '新規メンバー');
    assert.equal(c.comments[0].eventText, '新規メンバー');
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

});

// Service Worker は文言を作らない（段階3）。届くのはコードだけで、popup が引く
describe('英語で開いた popup: Service Worker から届くコード', () => {
  const errorView = c => ({
    title: c.elements.errorTitle.textContent,
    message: c.elements.errorDescription.textContent,
    solution: c.elements.errorSolution.textContent
  });

  test('エラー詳細は errorType から英語の見出し・説明・解決方法を引く', () => {
    const c = controller();
    c.popup.chrome.__deliver({
      action: 'showDetailedError',
      errorInfo: { errorType: 'quotaExceeded', action: 'waitOrUpgrade', severity: 'medium',
        originalError: 'exceeded your quota', pattern: 'exceeded your quota' }
    });
    assert.deepEqual(errorView(c), {
      title: EN.errQuotaTitle.message,
      message: EN.errQuotaMessage.message,
      solution: EN.errQuotaSolution.message
    });
    assert.equal(c.elements.errorTitle.textContent, 'API quota reached');
    assert.equal(c.elements.errorDetails.style.display, 'block');
    assert.equal(c.elements.errorDetails.className, 'error-details severity-medium');
    assert.equal(c.elements.optionsButton.textContent, 'Cloud Console');
  });

  test('SW が送る errorType は全部 en と ja の文言を持つ', () => {
    const types = ['apiKeyInvalid', 'apiKeyMissing', 'quotaExceeded', 'rateLimited', 'liveChatDisabled',
      'liveChatNotFound', 'videoNotLive', 'network', 'forbidden', 'storageQuota', 'unknown'];
    for (const locale of ['en', 'ja']) {
      const c = controller(locale);
      for (const errorType of types) {
        const { title, message, solution } = c.errorTextOf({ errorType });
        for (const text of [title, message, solution]) {
          assert.ok(text && !/^err[A-Z]/.test(text), `${locale}: ${errorType} の文言が引けない（${text}）`);
        }
      }
    }
  });

  test('保存領域の上限も英語になる', () => {
    const c = controller();
    c.showDetailedError({ errorType: 'storageQuota', action: 'clearHistory', severity: 'medium' });
    assert.equal(c.elements.errorTitle.textContent, 'Storage is full');
    assert.equal(c.elements.errorDescription.textContent, 'Saving the comment history is failing');
  });

  test('分類できないエラーは API の説明（訳さない）を出し、無ければ既定の説明', () => {
    const c = controller();
    c.showDetailedError({ errorType: 'unknown', detail: 'YouTube API Error: Bad Request', severity: 'medium' });
    assert.equal(c.elements.errorTitle.textContent, 'Connection error');
    assert.equal(c.elements.errorDescription.textContent, 'YouTube API Error: Bad Request');

    c.showDetailedError({ errorType: 'unknown', detail: '', severity: 'medium' });
    assert.equal(c.elements.errorDescription.textContent, EN.errUnknownMessage.message);

    // popup より新しい SW が知らない errorType を送ってきても、unknown として出す
    c.showDetailedError({ errorType: 'somethingNew', severity: 'low' });
    assert.equal(c.elements.errorTitle.textContent, 'Connection error');
  });

  test('popup 自身が出すエラー（errorType なし）は渡した文言のまま', () => {
    const c = controller();
    c.showDetailedError({ title: 'T', message: 'M', solution: 'S', action: 'reload', severity: 'high' });
    assert.deepEqual(errorView(c), { title: 'T', message: 'M', solution: 'S' });
  });

  test('日本語では従来と同じ文言になる', () => {
    // 文言を SW から messages.json に移しただけで、日本語の表示は変わらない
    const c = controller('ja');
    c.showDetailedError({ errorType: 'quotaExceeded', action: 'waitOrUpgrade', severity: 'medium' });
    assert.deepEqual(errorView(c), {
      title: 'API使用量制限に達しました',
      message: '1日のYouTube Data API使用量制限に達しました（1日10,000リクエスト制限）',
      solution: '明日の00:00（太平洋標準時）にリセットされます。今すぐ使いたい場合はGoogle Cloud Consoleで制限を増やしてください'
    });
  });

  test('自動停止の理由は reasonKey から英語で引く', () => {
    const c = controller();
    c.isMonitoring = true;
    c.popup.chrome.__deliver({ action: 'monitoringAutoStopped', reasonKey: 'tabClosed' });
    assert.equal(c.isMonitoring, false);
    assert.equal(c.elements.errorMessage.textContent,
      'ℹ️ Collecting stopped automatically: The YouTube tab was closed');
    assert.equal(c.elements.statusIndicator.textContent, EN.statusAutoStopped.message);
  });

  test('知らない reasonKey は理由を伏せる（コードをそのまま見せない）', () => {
    const c = controller();
    c.showAutoStopNotification('somethingNew');
    assert.equal(c.elements.errorMessage.textContent, 'ℹ️ Collecting stopped automatically');
  });
});

describe('英語で開いた popup: APIモードのメンバーイベント', () => {
  const apiItem = (id, type, details) => ({
    id,
    snippet: { type, publishedAt: '2026-09-07T13:02:00.000Z', ...details },
    authorDetails: { displayName: `fan-${id}`, isChatSponsor: true }
  });
  const items = [
    apiItem('new', 'newSponsorEvent', { newSponsorDetails: { memberLevelName: 'Gold' } }),
    apiItem('upgrade', 'newSponsorEvent', { newSponsorDetails: { isUpgrade: true } }),
    apiItem('milestone', 'memberMilestoneChatEvent', { memberMilestoneChatDetails: { memberMonth: 12, userComment: 'thanks' } }),
    apiItem('gift', 'membershipGiftingEvent', { membershipGiftingDetails: { giftMembershipsCount: 5, giftMembershipsLevelName: 'Gold' } }),
    apiItem('gift0', 'membershipGiftingEvent', {})
  ];
  // 履歴の読み込みと同じく formatComment（正準形への変換）を通してから載せる
  const load = c => c.setComments(items.map(item => c.formatComment(item)));
  const eventTexts = c => {
    load(c);
    c.renderComments();
    return Object.fromEntries(readCommentRows(c.elements.commentsList)
      .map(row => [row.id, findByClass(row.element, 'comment-event').textContent]));
  };

  test('描画するときに eventKey を英語で引く（レベル名は訳さずに添える）', () => {
    assert.deepEqual(eventTexts(controller()), {
      new: 'New member · Gold',
      upgrade: 'Upgraded membership',
      milestone: 'Member for 12 mo',
      gift: 'Gifted memberships: 5 · Gold',
      gift0: 'Gifted memberships'
    });
  });

  test('日本語では従来と同じ文言になる', () => {
    assert.deepEqual(eventTexts(controller('ja')), {
      new: '新規メンバー · Gold',
      upgrade: 'メンバーシップをアップグレード',
      milestone: '12か月連続のメンバー',
      gift: 'メンバーシップギフト 5個 · Gold',
      gift0: 'メンバーシップギフト'
    });
  });

  test('検索は popup の表示言語の文言で当たる', () => {
    const c = controller();
    load(c);
    c.searchKeyword = 'New member';
    c.searchQuery = 'new member';
    c.renderComments();
    const shown = readCommentRows(c.elements.commentsList).filter(row => !row.hidden).map(row => row.id);
    assert.deepEqual(shown, ['new']);
    // 保存値はコードのまま（文言は焼き付けない）
    const stored = c.comments.find(comment => comment.id === 'new');
    assert.equal(stored.eventKey, 'newMember');
    assert.equal(stored.eventText, null);
  });
});
