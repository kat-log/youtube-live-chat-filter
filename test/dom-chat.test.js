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

  test('チャットを開いた直後の全件スキャンでも、画像が揃うまで待つ', () => {
    // 過去分は画像が読み込み済みのことが多いが、開いた直後は間に合っていない
    // ことがある。新着と同じ待ちがここにも要る
    const row = stickerRow({ timestamp: '23:02' });
    const h = loadDomChat({ rows: [row] }); // 読み込みと同時に全件スキャンが走る

    assert.equal(h.sendCount(), 0, '画像が無いうちに送ってしまっている');

    row.attachSticker();
    h.flush();

    const messages = h.messages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].stickerUrl, 'https://lh3.googleusercontent.com/STICKER=s192-rwa');
    // 過去分なので投稿時刻はDOMの時刻表示（分単位）から作る
    assert.equal(new Date(messages[0].publishedAt).getSeconds(), 0, '受信時刻で上書きしている');
  });

  test('全件スキャンで画像が揃っている行はその場で取り込む', () => {
    const row = stickerRow();
    row.attachSticker();
    const h = loadDomChat({ rows: [row] });

    assert.equal(h.sendCount(), 1, '揃っている行まで遅延させている');
    assert.equal(h.messages()[0].stickerUrl, 'https://lh3.googleusercontent.com/STICKER=s192-rwa');
  });

  test('通常のコメントは待たずにその場で送る', () => {
    const h = loadDomChat();

    h.domChat.handleMutations(added(textRow({ message: 'こんばんはー' })));

    assert.equal(h.sendCount(), 1, 'テキストコメントまで遅延させている');
    assert.equal(h.messages()[0].message, 'こんばんはー');
    assert.equal(h.messages()[0].kind, undefined, 'テキストには種別を載せない');
  });
});

// チャットのDOMが現れないフレームに注入されたときの振る舞い（#1）。
//
// service-worker は allFrames で dom-chat.js を注入するため、watch のトップフレームなど
// ライブチャットが存在しないフレームにも届く。そこで attachObserver が無限に再試行すると、
// 500ms ごとの querySelector がセッションの最後まで回り続ける。
describe('チャットが無いフレームでの自衛', () => {
  test('#items が見つからないとき、再試行は上限で止まる', () => {
    const h = loadDomChat({ hasItemList: false });

    assert.equal(h.pendingTimers(), 1, '最初の再試行が予約されていない');

    // 尽きなければ flush が例外を投げる（＝再試行が止まっていない）
    const ticks = h.flush();

    assert.equal(ticks, 60, '再試行の回数が想定と違う（500ms x 60 = 30秒）');
    assert.equal(h.pendingTimers(), 0, '諦めたあとにもタイマーが残っている');
    assert.equal(h.sendCount(), 0);
    assert.equal(h.warnings().length, 1, '諦めたことがログに残っていない');
  });

  test('live_chat 以外のフレームでは何も仕掛けない', () => {
    const h = loadDomChat({ pathname: '/watch', hasItemList: false });

    assert.equal(h.pendingTimers(), 0, 'チャットの無いフレームで再試行を始めている');
    assert.equal(h.domChat.window.__domChatInitialized, undefined,
      '再注入を塞ぐと、SPA遷移でチャットのフレームになったときに拾えなくなる');
    // ガードのブロックごと評価されないので、内部関数はどれも生えない
    assert.equal(h.domChat.handleMutations, undefined);
  });
});

// MutationObserver の張り方（#T3）。
//
// これまでのテストは handleMutations を直接呼んでいて、observe の配線を迂回していた。
// 「どこに・何を・いくつ張ったか」が見えないと、YouTube が #items を作り直したときに
// 無言で止まる不具合（#2）を、フェーズ7 で直したかどうか確かめられない。
describe('チャットの監視の張り方', () => {
  test('#items に childList で1つだけ張る', () => {
    const h = loadDomChat();

    const observations = h.observations();
    assert.equal(observations.length, 1, '監視の数が想定と違う');
    assert.equal(observations[0].target, h.itemList, '#items 以外を監視している');
    // options は vm コンテキスト側で作られた物なので、deepEqual では比べられない
    // （プロトタイプが別realm）。中身だけ見る
    assert.equal(observations[0].options.childList, true, 'childList を購読していない');
    assert.equal(observations[0].options.subtree, undefined);
    assert.equal(h.disconnections().length, 0);
  });

  test('張った監視から流れてきた行を取り込む', () => {
    const h = loadDomChat();

    // handleMutations を直接呼ばず、observe されたコールバック経由で流す
    const delivered = h.emit(added(textRow({ message: 'ただいま' })));

    assert.equal(delivered, 1, '生きている監視が無い');
    assert.equal(h.messages().length, 1);
    assert.equal(h.messages()[0].message, 'ただいま');
  });

  test('チャットのDOMが無いフレームでは何も監視しない', () => {
    const h = loadDomChat({ hasItemList: false });

    assert.deepEqual(h.observations(), []);
  });
});

// IDの発番（#9 #29）。旧形式との互換と、上限に達したときの間引き方を固定する。
// ここが崩れると「コメントが1件だけ黙って消える」という、いちばん見つけにくい
// 種類の不具合になる
describe('コメントIDの発番', () => {
  test('新旧2つのIDを載せて送る', () => {
    // 旧形式は、更新前に保存された履歴と突き合わせるために background が使う
    const h = loadDomChat();

    h.domChat.handleMutations(added(textRow({ message: 'こんばんは', timestamp: '23:02' })));

    const [msg] = h.messages();
    assert.match(msg.id, /^dom2_[0-9a-f]{16}_0$/);
    assert.match(msg.legacyId, /^dom_-?\d+_0$/);
  });

  test('同じ人が同じ分に同じ本文を投げたら、連番だけが増える', () => {
    const h = loadDomChat();
    const line = () => textRow({ displayName: '@mod', message: '8888', timestamp: '23:02' });

    h.domChat.handleMutations(added(line()));
    h.domChat.handleMutations(added(line()));

    const ids = h.messages().map(m => m.id);
    assert.equal(ids.length, 2, '連投の2件目を送っていない');
    assert.equal(ids[0].replace(/_0$/, ''), ids[1].replace(/_1$/, ''), 'キーの部分が違う');
    assert.notEqual(ids[0], ids[1]);
  });

  test('上限を超えても、少し前のコメントの連番は 0 に戻らない', () => {
    // 全消しにすると連番が 0 に戻り、クリア前と同じIDが振られる。
    // background 側では「既出」として落とされるのでコメントが消える（#29）。
    // 古い方から間引く形なら、まだ新しいキーの連番は残る
    const h = loadDomChat();
    const flood = (from, count) => {
      for (let i = from; i < from + count; i++) {
        h.domChat.handleMutations(added(textRow({ displayName: `@u${i}`, message: `m${i}`, timestamp: '23:02' })));
      }
    };
    const hot = () => textRow({ displayName: '@mod', message: '8888', timestamp: '23:02' });

    // 上限（occurrenceByKey は 5000 件）の少し手前で1回投げ、そのあと超えさせる
    flood(0, 4990);
    h.domChat.handleMutations(added(hot()));
    flood(4990, 100);
    h.domChat.handleMutations(added(hot()));

    const hotIds = h.messages().filter(m => m.displayName === '@mod').map(m => m.id);
    assert.equal(hotIds.length, 2);
    assert.ok(hotIds[1].endsWith('_1'), `連番が戻っている: ${hotIds[1]}`);
    assert.notEqual(hotIds[0], hotIds[1]);
  });

  test('送信済みIDの上限を超えても、少し前に送った行は既出のまま', () => {
    // seenIds も全消しではなく古い方から間引く。全消しだと直後の再スキャンで
    // 全件を送り直すことになる（background で弾かれるとはいえ無駄な往復）
    const h = loadDomChat();
    const flood = (from, count) => {
      for (let i = from; i < from + count; i++) {
        h.domChat.handleMutations(added(textRow({ displayName: `@u${i}`, message: `m${i}`, timestamp: '23:02' })));
      }
    };

    // 上限（seenIds は 2000 件）の少し手前で1行送り、そのあと超えさせる
    flood(0, 1990);
    const row = textRow({ displayName: '@mod', message: 'こんばんは', timestamp: '23:02' });
    h.domChat.handleMutations(added(row));
    flood(1990, 100);

    const before = h.messages().length;
    h.domChat.handleMutations(added(row)); // 同じ要素＝同じID

    assert.equal(h.messages().length, before, '既出のはずの行をもう一度送っている');
  });
});

// セレクタのモックが厳格であること（#T1 #T2）。
// 「知らないセレクタなら例外」にしておかないと、dom-chat.js 側の綴りが変わっても
// モックが null を返すだけで、テストは通ったまま本番でだけ壊れる
describe('ハーネスのセレクタ', () => {
  test('知らないセレクタを引かれたら例外にする', () => {
    const h = loadDomChat();

    assert.throws(() => h.domChat.document.querySelector('#items'),
      /知らないセレクタ/, 'document 側が素通りしている');

    const row = textRow();
    assert.throws(() => row.querySelector('#autor-name'), /知らないセレクタ/);
    // 既知のセレクタで、その行に無いものは null（例外にしない）
    assert.equal(row.querySelector('#purchase-amount'), null);
  });
});
