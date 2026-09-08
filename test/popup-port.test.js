// popup と Service Worker の通信（フェーズ6b）のテスト。
//
// 見ているのは「何が表示されるか」ではなく **通信路そのもの** ——
// ポートが1本しか張られないか（#32）、要求と応答が取り違えられないか、
// 切れたときに待ちが宙に浮かないか、張り直しで取りこぼしが出ないか。
//
// ポートに変えた目的は、以前の sendMessage が「届いたかどうか分からない」ため
// 8回の ping と指数バックオフの retry を必要としていたのをやめること。
// その前提が本物になっていることを、ここで固定する。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadPopup, readCommentRows } = require('./helpers/popup-harness');

const ALL_ON = {
  owner: true, moderator: true, sponsor: true,
  normal: true, superchat: true, membership: true
};

let seq = 0;
const comment = (fields = {}) => ({
  id: `port_${seq++}`,
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

/** Node 側の実時間で1周させる（偽ポートの応答はマイクロタスクで返る） */
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('ポートは1本だけ（#32）', () => {
  test('コンストラクタで1本張り、二度目の connectToBackground では増えない', () => {
    const c = controller();
    assert.equal(c.popup.chrome.__portCount(), 1);
    c.connectToBackground();
    assert.equal(c.popup.chrome.__portCount(), 1, 'ポートが2本張られている');
  });

  test('緊急フォールバック初期化を通っても、受け口は1つのまま', async () => {
    // emergencyFallbackInitialization は completeBasicInitialization の途中の
    // 例外から呼ばれる。以前はどちらも setupMessageListener() を呼んでいたので、
    // 通過位置によっては onMessage のリスナーが2つ登録され、新着が二重に処理された
    const c = controller();
    await c.emergencyFallbackInitialization();

    assert.equal(c.popup.chrome.__portCount(), 1, '受け口が二重になっている');

    // 二重登録が起きていれば、1バッチで行が2つ出来る
    c.popup.chrome.__deliver({ action: 'newSpecialComments', comments: [comment({ id: 'x' })] });
    assert.equal(readCommentRows(c.elements.commentsList).length, 1);
  });
});

describe('要求と応答', () => {
  test('応答は requestId で対応づく（先に投げた要求が後から返っても取り違えない）', async () => {
    const c = controller({
      onRequest: request => {
        // わざと逆順に返す。requestId を見ずに「届いた順」で対応づけていると入れ替わる
        if (request.action === 'getApiKey') {
          return new Promise(resolve => setTimeout(() => resolve({ apiKey: 'KEY' }), 20));
        }
        if (request.action === 'getAutoStart') return { autoStart: true };
        return undefined; // それ以外は応答しない（初期化はここで止まる）
      }
    });

    const [apiKey, autoStart] = await Promise.all([
      c.requestBackground({ action: 'getApiKey' }),
      c.requestBackground({ action: 'getAutoStart' })
    ]);
    assert.deepEqual({ ...apiKey }, { apiKey: 'KEY' });
    assert.deepEqual({ ...autoStart }, { autoStart: true });
  });

  test('知らない action の応答（undefined）でも待ちは解ける', async () => {
    const c = controller();
    const pending = c.requestBackground({ action: 'まだ無い機能' });
    c.popup.chrome.__port().__deliver({ requestId: c.lastRequestId, payload: undefined });
    assert.equal(await pending, undefined);
  });
});

describe('切断と再接続', () => {
  test('切れたら待っている要求は落ち、ポートは張り直される', async () => {
    const c = controller();
    const pending = c.requestBackground({ action: 'getMonitoringState' });
    const requestId = c.lastRequestId;

    c.popup.chrome.__disconnect();

    await assert.rejects(pending, /接続が切れました/);
    assert.equal(c.pendingRequests.has(requestId), false, '応答が来ない要求が残っている');
    assert.equal(c.popup.chrome.__portCount(), 2, 'ポートを張り直していない');
    assert.equal(c.port, c.popup.chrome.__port());
  });

  test('張り直せなければ、黙って落ちずに知らせる', async () => {
    const c = controller({
      chrome: (() => {
        const { createChromeMock } = require('./helpers/popup-harness');
        let connects = 0;
        return createChromeMock({
          onConnect: () => {
            connects += 1;
            if (connects > 1) throw new Error('Extension context invalidated');
          }
        });
      })()
    });

    c.popup.chrome.__disconnect();
    await settle();

    assert.equal(c.port, null);
    // 初期化の続きが別のエラーを上書きするので、書かれた履歴の方を見る
    assert.ok(c.elements.errorMessage.writes.textContent.some(text => /接続が失われました/.test(text)),
      '接続が失われたことを知らせていない');
  });

  test('再接続すると、切れていた間のコメントを取りこぼさない', async () => {
    // ポートが切れている間の通知はどこへも届かない。張り直したあと、
    // 保存済みの履歴から差分だけを取り込む（既知の id は Set が落とす）
    const history = [comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })];
    const c = controller({
      onRequest: request => {
        if (request.action === 'getCommentsHistory') {
          return { success: true, comments: history, avatars: {} };
        }
        return undefined;
      }
    });
    c.currentVideoId = 'VIDEO';

    // 切れる前に届いていたのは a だけ
    c.popup.chrome.__deliver({ action: 'newSpecialComments', comments: [history[0]] });
    assert.deepEqual(readCommentRows(c.elements.commentsList).map(row => row.id), ['a']);

    c.popup.chrome.__disconnect();
    await settle();

    // b と c が足される。a は作り直されない（差分追加のまま。フェーズ5）
    assert.deepEqual(readCommentRows(c.elements.commentsList).map(row => row.id),
      ['a', 'b', 'c']);
  });

  test('再接続の取り込みでも、既知のコメントは二重にならない', async () => {
    const history = [comment({ id: 'a' })];
    const c = controller({
      onRequest: request => (request.action === 'getCommentsHistory'
        ? { success: true, comments: history, avatars: {} }
        : undefined)
    });
    c.currentVideoId = 'VIDEO';
    c.popup.chrome.__deliver({ action: 'newSpecialComments', comments: history });

    c.popup.chrome.__disconnect();
    await settle();

    assert.deepEqual(readCommentRows(c.elements.commentsList).map(row => row.id), ['a']);
  });
});

describe('新着の受け口', () => {
  test('ポートで届いたバッチは、届いた順に行として足される', () => {
    const c = controller();
    const first = [comment({ id: 'a' }), comment({ id: 'b' })];
    const second = [comment({ id: 'c' })];

    c.popup.chrome.__deliver({ action: 'newSpecialComments', comments: first });
    c.popup.chrome.__deliver({ action: 'newSpecialComments', comments: second });

    assert.deepEqual(readCommentRows(c.elements.commentsList).map(row => row.id),
      ['a', 'b', 'c']);
  });

  test('アバターはコメントより先に取り込まれる', () => {
    const c = controller();
    c.popup.chrome.__deliver({
      action: 'newSpecialComments',
      comments: [comment({ id: 'a', displayName: '配信者' })],
      avatars: { 配信者: 'https://yt3.ggpht.com/AAA=s64-c' }
    });

    const [row] = readCommentRows(c.elements.commentsList);
    assert.equal(row.avatar.tagName, 'IMG', 'アバターが行に載っていない');
  });

  test('自動停止の通知はそのまま届く', () => {
    const c = controller();
    c.isMonitoring = true;
    c.popup.chrome.__deliver({ action: 'monitoringAutoStopped', reason: 'テスト' });
    assert.equal(c.isMonitoring, false);
  });
});

// チャットの読み取り状態の表示（フェーズ7）。
//
// DOMモードで無言で0件になったとき、利用者が「静かな配信」と区別できるようにする
// のがこの表示の目的（根本原因F）。読めているうちは点だけを出し、
// 読めていないときにだけ文言を添える（トップバーの見た目を崩さないため）。
describe('チャットの読み取り状態', () => {
  const domController = () => {
    const c = controller();
    c.chatMode = 'dom';
    c.isMonitoring = true;
    return c;
  };
  const chip = c => c.popup.document.peek('chat-health');
  const label = c => c.popup.document.peek('chat-health-text');

  test('既定では何も出さない（APIモードの見た目は変わらない）', () => {
    const c = controller();
    assert.equal(chip(c).style.display, 'none');
  });

  test('読み取れているときは点だけ、文言は出さない', () => {
    const c = domController();

    c.popup.chrome.__deliver({ action: 'domChatHealth', health: { state: 'reading' } });

    assert.notEqual(chip(c).style.display, 'none', '状態が出ていない');
    assert.match(chip(c).className, /chat-health--ok/);
    assert.equal(label(c).textContent, '', '平常時に文言で幅を取っている');
    assert.match(chip(c).title, /読み取れています/);
  });

  test('読み取れなくなったら、そうと分かる文言を出す', () => {
    const c = domController();

    c.popup.chrome.__deliver({ action: 'domChatHealth', health: { state: 'unreadable' } });

    assert.match(chip(c).className, /chat-health--error/);
    assert.match(label(c).textContent, /読み取れません/);
  });

  test('チャットが見つからないときも分かる', () => {
    const c = domController();

    c.popup.chrome.__deliver({ action: 'domChatHealth', health: { state: 'no-chat' } });

    assert.match(label(c).textContent, /見つかりません/);
  });

  test('APIモードには出さない（DOMの話なので）', () => {
    const c = controller();
    c.chatMode = 'api';

    c.popup.chrome.__deliver({ action: 'domChatHealth', health: { state: 'unreadable' } });

    assert.equal(chip(c).style.display, 'none');
  });

  test('停止したら消える（「読み取れています」が居座らない）', () => {
    const c = domController();
    c.popup.chrome.__deliver({ action: 'domChatHealth', health: { state: 'reading' } });

    c.handleAutoStop('テスト');

    assert.equal(chip(c).style.display, 'none');
  });

  test('知らない状態の語は出さない（拡張機能の版がずれたとき）', () => {
    const c = domController();

    c.popup.chrome.__deliver({ action: 'domChatHealth', health: { state: 'まだ無い状態' } });

    assert.equal(chip(c).style.display, 'none');
  });

  test('開いた時点の状態は Service Worker に聞く', async () => {
    const c = controller({
      onRequest: request =>
        request.action === 'getDomChatHealth' ? { success: true, health: { state: 'unreadable' } } : undefined
    });
    c.chatMode = 'dom';
    c.isMonitoring = true;

    await c.refreshChatHealth();

    assert.match(label(c).textContent, /読み取れません/);
  });
});
