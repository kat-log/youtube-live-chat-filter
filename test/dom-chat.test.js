// スーパーステッカーの取り込みに対する回帰テスト。
//
// ここで守りたいのは「新着だけが落ちる」種類の不具合。ステッカーの画像は
// 行がDOMに入った直後にはまだ存在せず（yt-img-shadow が後から img を作る）、
// その場で読むと画像もステッカー名（alt）も空になる。過去分の全件スキャンでは
// 画像が揃っているため取れてしまい、実配信で新着を待たないと再現しない。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadDomChat, stickerImage, stickerRow, textRow, added
} = require('./helpers/dom-chat-harness');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('スーパーステッカーの取り込み', () => {
  test('画像が生えるまで待ってから、名前と画像URLを揃えて1件だけ送る', () => {
    const h = loadDomChat();
    const row = stickerRow();

    h.domChat.handleMutations(added(row));
    assert.equal(h.sendCount(), 0, '画像が無いうちに送ってしまっている');
    assert.ok(h.pendingTimers() > 0, '再チェックが予約されていない');

    // YouTubeがまだ img を作っていない状態を数回ぶん再現する
    h.tick();
    h.tick();
    assert.equal(h.sendCount(), 0, '空振り中に送ってしまっている');

    row.attachSticker(stickerImage({ alt: 'チアリーダーの服装のファン' }));
    h.flush();

    const messages = h.messages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'supersticker');
    assert.equal(messages[0].message, 'チアリーダーの服装のファン');
    assert.equal(messages[0].amountText, '¥1,000');
    assert.equal(messages[0].stickerUrl, 'https://lh3.googleusercontent.com/STICKER=s192-rwa');
  });

  test('画像URLはプロトコル相対でも https に解決し、表示の2倍で要求する', () => {
    const h = loadDomChat();
    const row = stickerRow();
    // 実物は「//lh3.googleusercontent.com/<ID>=s208-rwa」の形で入っている。
    // getAttribute で読むと https チェックに引っかかるので .src から取っている
    row.attachSticker(stickerImage({ src: '//yt3.ggpht.com/ABC=s40-rp' }));

    h.domChat.handleMutations(added(row));
    h.flush();

    assert.equal(h.messages()[0].stickerUrl, 'https://yt3.ggpht.com/ABC=s192-rwa');
  });

  test('配信ホスト以外のURLは載せない', () => {
    for (const src of ['https://evil.example.com/x=s40-rp', 'javascript:alert(1)', 'data:image/png;base64,AAA']) {
      const h = loadDomChat();
      const row = stickerRow();
      const image = stickerImage({ src });
      image.src = src; // プロトコル相対の解決を挟まず、そのままの値を見せる
      row.children['#sticker img'] = image;

      h.domChat.handleMutations(added(row));
      h.flush();

      const message = h.messages()[0];
      assert.equal(message.stickerUrl, undefined, `${src} を通してしまっている`);
      assert.equal(message.kind, 'supersticker', '画像が読めなくても行そのものは残す');
    }
  });

  test('画像が生えてこなくても打ち切って取り込む', () => {
    const h = loadDomChat();

    h.domChat.handleMutations(added(stickerRow()));
    h.flush();

    const messages = h.messages();
    assert.equal(messages.length, 1, '待ち続けてコメントごと落としている');
    assert.equal(messages[0].kind, 'supersticker');
    assert.equal(messages[0].stickerUrl, undefined);
  });

  test('待っている間に投稿時刻が後ろへずれない', async () => {
    const h = loadDomChat();
    const row = stickerRow();

    h.domChat.handleMutations(added(row));
    const detectedAt = Date.now();

    // 画像が生えるまで実時間が経つ状況を作る
    await wait(30);
    row.attachSticker();
    h.flush();

    const publishedAt = Date.parse(h.messages()[0].publishedAt);
    assert.ok(publishedAt <= detectedAt, '待った時間ぶん投稿時刻がずれている');
  });

  test('同じ行がもう一度流れてきても二重に送らない', () => {
    const h = loadDomChat();
    const row = stickerRow();
    row.attachSticker();

    h.domChat.handleMutations(added(row));
    h.domChat.handleMutations(added(row));
    h.flush();

    assert.equal(h.messages().length, 1);
  });

  test('通常のコメントは待たずにその場で送る', () => {
    const h = loadDomChat();

    h.domChat.handleMutations(added(textRow({ message: 'こんばんはー' })));

    assert.equal(h.sendCount(), 1, 'テキストコメントまで遅延させている');
    assert.equal(h.messages()[0].message, 'こんばんはー');
    assert.equal(h.messages()[0].kind, undefined, 'テキストには種別を載せない');
  });
});
