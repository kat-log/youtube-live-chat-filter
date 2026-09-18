// スーパーステッカーの取り込みに対する回帰テスト。
//
// ここで守りたいのは「新着だけが落ちる」種類の不具合。ステッカーの画像は
// 行がDOMに入った直後にはまだ存在せず（yt-img-shadow が後から img を作る）、
// その場で読むと画像もステッカー名（alt）も空になる。過去分の全件スキャンでは
// 画像が揃っているため取れてしまい、実配信で新着を待たないと再現しない。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadDomChat, element, stickerImage, avatarImage, emojiImage, stickerRow, textRow,
  withLateAvatar, added
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
  test('#items に childList で張り、祖先には差し替え検知のために subtree で張る', () => {
    const h = loadDomChat();

    const observations = h.observations();
    assert.equal(observations.length, 2, '監視の数が想定と違う');

    const [items, host] = observations;
    assert.equal(items.target, h.itemList, '#items 以外を監視している');
    // options は vm コンテキスト側で作られた物なので、deepEqual では比べられない
    // （プロトタイプが別realm）。中身だけ見る
    assert.equal(items.options.childList, true, 'childList を購読していない');
    assert.equal(items.options.subtree, undefined,
      '#items の購読に subtree は要らない（行の中の変化まで拾うと無駄に呼ばれる）');

    // 祖先側は「#items そのものが差し替わったこと」に気付くための購読（#2）。
    // #items は祖先の直下とは限らないので subtree が要る
    assert.equal(host.target, h.host, '祖先を監視していない');
    assert.equal(host.options.childList, true);
    assert.equal(host.options.subtree, true);

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

// 監視の張り直し（#2 = フェーズ7の本体）。
//
// YouTube が #items を作り直すと、張ったままの observer は二度と発火しない。
// 「上位のチャット ↔ チャット」の切り替えで実際に起き、症状は
// 「コメントが来なくなる」だけなので、静かな配信と見分けが付かない。
//
// なお、ここで確かめられるのは「差し替えに気付いて張り直す段取り」であって、
// セレクタがいまの YouTube で正しいかどうかではない（#T1 #T2）。それは実ブラウザでしか分からない。
describe('#items が差し替わったときの張り直し', () => {
  test('古い監視を切って、新しい #items に張り直す', () => {
    const h = loadDomChat();
    const first = h.itemList;

    const next = h.replaceItemList();
    h.emitHost(); // 差し替えそのものが祖先側の記録になる

    assert.equal(h.disconnections().length, 1, '古い監視を切っていない（購読が増えていく）');

    const lists = h.observations().filter(o => o.target === first || o.target === next);
    assert.equal(lists.length, 2, '張り直していない');
    assert.equal(lists[1].target, next, '差し替え後の #items を見ていない');
  });

  test('張り直したあと、新しい #items に流れた行が届く', () => {
    const h = loadDomChat();

    h.replaceItemList();
    h.emitHost();
    const delivered = h.emit(added(textRow({ message: 'チャットを切り替えた' })));

    assert.equal(delivered, 1, '生きている監視が1つではない');
    assert.equal(h.messages().length, 1, '張り直したあとのコメントが届いていない');
    assert.equal(h.messages()[0].message, 'チャットを切り替えた');
  });

  test('外れていた間に積まれた行も、張り直しの全件スキャンで拾う', () => {
    const h = loadDomChat();

    // 差し替え後の #items には、気付くまでの間に流れた行が入っている
    h.replaceItemList([textRow({ message: '切替中に流れた' })]);
    h.emitHost();

    assert.equal(h.messages().length, 1, '外れていた間のコメントを取りこぼしている');
    assert.equal(h.messages()[0].message, '切替中に流れた');
  });

  test('差し替わっていなければ、祖先が動いても張り直さない', () => {
    // 祖先の購読は subtree なので、行が増えるたびに呼ばれる。
    // そのたびに張り直すと、購読と全件スキャンが際限なく走る
    const h = loadDomChat();

    h.emitHost();
    h.emitHost();

    assert.equal(h.disconnections().length, 0, '生きている監視を切っている');
    assert.equal(h.observations().length, 2, '監視を張り足している');
  });

  test('番人からの再スキャンでも張り直す（祖先ごと差し替えられた場合の保険）', () => {
    // 祖先の監視まで外れると emitHost は誰にも届かない。
    // Service Worker の番人が3分の沈黙で送ってくる再スキャンが最後の受け皿になる
    const h = loadDomChat();
    const next = h.replaceItemList([textRow({ message: '番人が拾った' })]);

    h.deliver({ action: 'requestInitialSweep', force: true });

    const lists = h.observations().filter(o => o.target === next);
    assert.equal(lists.length, 1, '再スキャンの要求で張り直していない');
    assert.equal(h.messages().length, 1);
    assert.equal(h.messages()[0].message, '番人が拾った');
  });
});

// ヘルス状態（フェーズ7）。
//
// 「セレクタが変わって、行は流れているのに1件も取り込めない」が、いまいちばん危ない
// 壊れ方。症状は「コメントが来ない」だけで、静かな配信と区別が付かない（根本原因F）。
describe('ヘルス状態の報告', () => {
  test('監視を張ったら watching、1件でも取り込めたら reading', () => {
    const h = loadDomChat();
    assert.equal(h.healthState(), 'watching', '監視を張ったことを報告していない');

    h.emit(added(textRow({ message: 'こんばんは' })));

    assert.equal(h.healthState(), 'reading');
  });

  test('#items が見つからないまま諦めたら no-chat', () => {
    const h = loadDomChat({ hasItemList: false });
    h.flush();

    assert.equal(h.healthState(), 'no-chat', '諦めたことを報告していない');
  });

  test('行は流れているのに読み取れないと unreadable になる', () => {
    // 本文の器（#message）ごと無い行 = セレクタが変わった状況。
    // 1〜2件では騒がず、連続したときだけ壊れたとみなす
    const h = loadDomChat();
    const broken = () => {
      const row = element('', { '#author-name': element('@viewer') });
      row.tagName = 'yt-live-chat-text-message-renderer';
      return row;
    };

    h.emit(added(broken(), broken()));
    assert.equal(h.healthState(), 'watching', '数件で壊れたことにしている');

    h.emit(added(broken(), broken(), broken()));
    assert.equal(h.healthState(), 'unreadable', 'セレクタが壊れたことに気付いていない');
  });

  test('全件スキャンで既知のタグが1つも無ければ unreadable', () => {
    // 行のタグ名ごと変わった状況。1行ずつ見ても「知らないタグ」は普通に混ざるので、
    // 全件を数えられる全件スキャンでだけ判定する
    const unknownRow = () => {
      const row = element('', { '#author-name': element('@viewer') });
      row.tagName = 'yt-live-chat-renamed-message-renderer';
      return row;
    };
    const h = loadDomChat({ rows: [unknownRow(), unknownRow(), unknownRow(), unknownRow(), unknownRow()] });

    assert.equal(h.healthState(), 'unreadable');
  });

  test('お知らせ行が数本あるだけでは騒がない', () => {
    const unknownRow = () => {
      const row = element('', {});
      row.tagName = 'yt-live-chat-viewer-engagement-message-renderer';
      return row;
    };
    const h = loadDomChat({ rows: [unknownRow(), unknownRow()] });

    assert.equal(h.healthState(), 'watching');
  });

  test('Service Worker から聞かれたら、いまの状態を答える', () => {
    // Service Worker は終了すると控えを失う。正は content script 側が持っている
    const h = loadDomChat();
    h.emit(added(textRow({ message: 'ただいま' })));

    const response = h.deliver({ action: 'getDomChatHealth' });

    assert.equal(response.health.state, 'reading');
    assert.equal(response.health.extracted, 1);
  });

  test('張り直した回数を報告に載せる', () => {
    const h = loadDomChat();

    h.replaceItemList();
    h.emitHost();
    h.emit(added(textRow({ message: '再開' })));

    const last = h.healthReports().at(-1);
    assert.equal(last.reattached, 1, '張り直しの回数が残っていない');
  });
});

// 発言者の役割（#T9）。この拡張機能の存在意義そのものなのに、一度も検証されていなかった
describe('発言者の役割の判定', () => {
  const rowWith = (attributes, children = {}) => {
    const row = element('', children, attributes);
    row.tagName = 'yt-live-chat-text-message-renderer';
    return row;
  };

  test('author-type 属性から引く', () => {
    const h = loadDomChat();

    assert.equal(h.domChat.roleOf(rowWith({ 'author-type': 'owner' }), 'text'), 'owner');
    assert.equal(h.domChat.roleOf(rowWith({ 'author-type': 'moderator' }), 'text'), 'moderator');
    assert.equal(h.domChat.roleOf(rowWith({ 'author-type': 'member' }), 'text'), 'member');
    assert.equal(h.domChat.roleOf(rowWith({}), 'text'), 'normal');
  });

  test('属性が無ければバッジから補う（有料メッセージの行には付かないことがある）', () => {
    const h = loadDomChat();
    const badge = selector => rowWith({}, { [selector]: element('') });

    assert.equal(
      h.domChat.roleOf(badge('yt-live-chat-author-badge-renderer[type="moderator"]'), 'superchat'),
      'moderator');
    assert.equal(
      h.domChat.roleOf(badge('yt-live-chat-author-badge-renderer[type="member"]'), 'superchat'),
      'member');
  });

  test('加入・ギフトのイベントは、手掛かりが無くてもメンバー', () => {
    const h = loadDomChat();

    assert.equal(h.domChat.roleOf(rowWith({}), 'membership'), 'member');
    assert.equal(h.domChat.roleOf(rowWith({}), 'gift'), 'member');
    // スパチャは一般視聴者からも飛んでくるので、種別からは補わない
    assert.equal(h.domChat.roleOf(rowWith({}), 'superchat'), 'normal');
  });
});

// アバターURLの取り方（#28）。ステッカー側と同じ罠を、こちらだけ踏んでいた
describe('アバターURLの取り出し', () => {
  const rowWithAvatar = (selector, img) => element('', { [selector]: img });

  test('プロトコル相対（//lh3...）でも https に解決して返す', () => {
    const h = loadDomChat();
    const row = rowWithAvatar('#author-photo img',
      avatarImage({ src: '//yt3.ggpht.com/AVATAR=s32-c-k' }));

    assert.equal(h.domChat.extractAvatarUrl(row), 'https://yt3.ggpht.com/AVATAR=s64-c-k');
  });

  test('有料メッセージの行（img#img）からも取れる', () => {
    const h = loadDomChat();
    const row = rowWithAvatar('img#img',
      avatarImage({ src: '//lh3.googleusercontent.com/AVATAR=s32-c-k' }));

    assert.equal(h.domChat.extractAvatarUrl(row), 'https://lh3.googleusercontent.com/AVATAR=s64-c-k');
  });

  test('https 以外は返さない', () => {
    const h = loadDomChat();
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'http://example.com/a=s32-c']) {
      const img = avatarImage({ src });
      img.src = src; // プロトコル相対の解決を挟まず、そのままの値を見せる
      assert.equal(h.domChat.extractAvatarUrl(rowWithAvatar('#author-photo img', img)), null,
        `${src} を通してしまっている`);
    }
  });

  test('アバターが無くても null を返すだけ（コメントの取り込みは止めない）', () => {
    const h = loadDomChat();

    assert.equal(h.domChat.extractAvatarUrl(element('', {})), null);
  });
});

// アバターの拾い直し。
//
// アバターの img は行と同時には生えず、いつ生えるかは YouTube の都合
// （ビューポートに入ってから読み込む）で上限が無い。取り込みをそれに待たせると、
// 待ち時間をいくつに決めても「コメントが遅れる」か「頭文字のまま取りこぼす」の
// どちらかになる（0.5秒待つ版を実配信で試して、半分が間に合わなかった）。
// そこで取り込みは待たせず、アバターだけを別便で追いかける
describe('アバターの拾い直し', () => {
  test('アバターが無くてもコメントは待たせずに送る', () => {
    const h = loadDomChat();

    h.domChat.handleMutations(added(withLateAvatar(textRow({ message: 'こんばんは' }))));

    assert.equal(h.sendCount(), 1, 'アバターのためにコメントを待たせている');
    assert.equal(h.messages()[0].message, 'こんばんは');
    assert.equal(h.messages()[0].avatarUrl, null);
    assert.equal(h.avatarSendCount(), 0, 'まだ生えていないのに送っている');
  });

  test('あとから生えたら、発言者ぶんのアバターだけを別便で送る', () => {
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: '@viewer' }));

    h.domChat.handleMutations(added(row));
    row.attachAvatar(avatarImage({ src: '//yt3.ggpht.com/AVATAR=s32-c-k' }));
    h.flush();

    const updates = h.avatarUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].displayName, '@viewer');
    assert.equal(updates[0].avatarUrl, 'https://yt3.ggpht.com/AVATAR=s64-c-k');
    assert.equal(h.sendCount(), 1, 'コメントを送り直している');
  });

  test('枠の材料（役割・種別）を載せる。スパチャのアバターを一般の流量で失わないため', () => {
    // 枠（primary / bulk）を決めるのは Service Worker の bucketOf なので、
    // その材料を落とさずに渡す。落とすと有料の行のアバターが bulk 扱いになり、
    // 一般コメントの流量で押し出される
    const h = loadDomChat();
    const row = withLateAvatar(stickerRow({ displayName: '@fan' }));
    row.attachSticker();

    h.domChat.handleMutations(added(row));
    row.attachAvatar();
    h.flush();

    const [update] = h.avatarUpdates();
    assert.equal(update.kind, 'supersticker');
    assert.equal(update.role, 'normal', 'スパチャは一般視聴者からも飛んでくる');
  });

  test('行が流れてくるたびに拾い直す（タイマー任せにしない）', () => {
    // 背面タブではタイマーが間引かれる。行が動いたときにも見に行く
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: '@viewer', message: '1本目' }));

    h.domChat.handleMutations(added(row));
    row.attachAvatar();
    h.domChat.handleMutations(added(textRow({ displayName: '@other', message: '2本目' })));

    assert.equal(h.avatarSendCount(), 1, '行が動いたときに拾い直していない');
  });

  test('同じ発言者のアバターを何度も送らない', () => {
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: '@viewer', message: '1本目' }));

    h.domChat.handleMutations(added(row));
    row.attachAvatar();
    h.flush();

    h.domChat.handleMutations(added(textRow({ displayName: '@viewer', message: '2本目' })));
    h.flush();

    assert.equal(h.avatarSendCount(), 1, '同じ発言者を送り直している');
  });

  test('コメントに載って届いた発言者は追いかけない', () => {
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: '@viewer' }));
    row.attachAvatar(); // 行が入った時点で生えていた（間に合った行）

    h.domChat.handleMutations(added(row));
    h.flush();

    assert.ok(h.messages()[0].avatarUrl, 'コメントに載っていない');
    assert.equal(h.avatarSendCount(), 0, '同じURLを別便でも送っている');
  });

  test('行がチャットから流れ去ったら諦める', () => {
    // その行からはもう取れない。同じ人が次に喋れば、新しい行で追いかけ直す
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: '@viewer' }));

    h.domChat.handleMutations(added(row));
    row.attached = false; // YouTube が古い行を捨てた
    const ticks = h.flush();

    assert.equal(h.avatarSendCount(), 0);
    assert.ok(ticks <= 2, `諦めるまでに見に行きすぎ（${ticks}回）`);
  });

  test('外れた行でも、読めるなら拾う（URLは行ではなく発言者のもの）', () => {
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: '@viewer' }));

    h.domChat.handleMutations(added(row));
    row.attachAvatar();
    row.attached = false;
    h.flush();

    assert.equal(h.avatarSendCount(), 1, '読めるのに捨てている');
  });

  test('生えないまま居座る行も、いつかは諦める（見に行き続けない）', () => {
    const h = loadDomChat();

    h.domChat.handleMutations(added(withLateAvatar(textRow({ displayName: '@viewer' }))));
    // 尽きなければ flush が例外を投げる（＝見に行くのが止まっていない）
    h.flush();

    assert.equal(h.avatarSendCount(), 0);
    assert.equal(h.pendingTimers(), 0, '諦めたあとにもタイマーが残っている');
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

  test('closest も、解釈できないセレクタは例外にする', () => {
    // 受け付けるのは `#id` とタグ名だけ（dom-chat.js が実際に使う2つの形）。
    // 黙って null を返すと、クリックの当たり判定が外れたことに気付けない
    const row = textRow();

    assert.throws(() => row.closest('[author-type="owner"]'), /closest が解釈できない/);
    assert.equal(row.closest('yt-live-chat-text-message-renderer'), row);
    assert.equal(row.closest('#author-name'), null, '祖先側を引いてしまっている');
  });
});

describe('本文の絵文字', () => {
  // 本文に混ざる絵文字は img で入っていて、文字としては alt にしか残らない。
  // alt は「:_hearts:」のような短縮名のこともあれば、実配信で確かめた
  // 「2BROOtojya」「eyes-pink-heart-shape」のようにコロンの無い裸の名前のこともある。
  // どちらも画像に戻せないと、画面に名前の文字が並ぶ
  test('コロンの無い名前でも対応表に載せる（実配信の形）', () => {
    const h = loadDomChat();
    const row = textRow({
      messageParts: ['こんばんは', emojiImage({ alt: '2BROOtojya' }), emojiImage({ alt: '2BROAnijya' })]
    });

    h.domChat.handleMutations(added(row));

    const [message] = h.messages();
    // 本文の文字列は従来どおり alt をそのまま並べる（IDが変わらないように）
    assert.equal(message.message, 'こんばんは2BROOtojya2BROAnijya');
    assert.deepEqual(Object.keys({ ...message.emojis }), ['2BROOtojya', '2BROAnijya']);
  });

  test('短縮名の形でも載せる', () => {
    const h = loadDomChat();
    const row = textRow({
      messageParts: ['おめでとう', emojiImage({ alt: ':_hearts:' }), '！']
    });

    h.domChat.handleMutations(added(row));

    const [message] = h.messages();
    assert.equal(message.message, 'おめでとう:_hearts:！');
    // vm コンテキスト側の Object を Node 側のものに写してから比べる
    assert.deepEqual({ ...message.emojis }, {
      ':_hearts:': 'https://yt3.ggpht.com/EMOJI=w48-h48-c-k-nd'
    });
  });

  test('同じ絵文字を連投しても対応表は1つ', () => {
    const h = loadDomChat();
    const row = textRow({
      messageParts: [
        emojiImage({ alt: '2BROOtocry' }),
        emojiImage({ alt: '2BROOtocry' }),
        emojiImage({ alt: '2BROOtocry' })
      ]
    });

    h.domChat.handleMutations(added(row));

    const [message] = h.messages();
    assert.equal(message.message, '2BROOtocry2BROOtocry2BROOtocry');
    assert.deepEqual(Object.keys({ ...message.emojis }), ['2BROOtocry']);
  });

  test('Unicode の絵文字は対応表に載せない（alt が絵文字そのもので読める）', () => {
    const h = loadDomChat();
    for (const alt of ['\u{1F527}', '\u{1F389}', '\u{1F44D}\u{1F3FD}', '1\uFE0F\u20E3']) {
      const h2 = loadDomChat();
      h2.domChat.handleMutations(added(textRow({
        messageParts: ['やった', emojiImage({ alt, src: '//www.youtube.com/s/gaming/emoji/x/e.svg' })]
      })));

      const [message] = h2.messages();
      assert.equal(message.message, `やった${alt}`);
      assert.equal(message.emojis, undefined, `${alt} まで画像にしようとしている`);
    }
    assert.equal(h.messages().length, 0);
  });

  test('YouTube 標準の絵文字は静的ファイルのパスをそのまま使う', () => {
    const h = loadDomChat();
    const row = textRow({
      messageParts: [emojiImage({
        alt: 'eyes-pink-heart-shape',
        src: '//www.youtube.com/s/gaming/emoji/abc/eyes.svg'
      })]
    });

    h.domChat.handleMutations(added(row));

    assert.deepEqual({ ...h.messages()[0].emojis }, {
      'eyes-pink-heart-shape': 'https://www.youtube.com/s/gaming/emoji/abc/eyes.svg'
    });
  });

  test('チャンネルの画像置き場は番号違いのホストでも通す', () => {
    const h = loadDomChat();
    // yt3 / yt4 のような番号違いが実際にある。末尾一致で見ている
    const row = textRow({ messageParts: [emojiImage({ alt: '2BROOtojya', src: '//yt4.ggpht.com/E=w24-h24-c-k-nd' })] });

    h.domChat.handleMutations(added(row));

    assert.deepEqual({ ...h.messages()[0].emojis }, {
      '2BROOtojya': 'https://yt4.ggpht.com/E=w48-h48-c-k-nd'
    });
  });

  test('配信ホスト以外のURLは載せない（本文の名前は残す・1度だけ警告する）', () => {
    for (const src of ['https://evil.example.com/e=w24-h24', 'javascript:alert(1)',
      'https://www.youtube.com/watch?v=x']) {
      const h = loadDomChat();
      const image = emojiImage({ alt: 'ng-emoji', src });
      image.src = src; // プロトコル相対の解決を挟まず、そのままの値を見せる
      const row = textRow({ messageParts: ['ねえ', image] });

      h.domChat.handleMutations(added(row));

      const [message] = h.messages();
      assert.equal(message.emojis, undefined, `${src} を通してしまっている`);
      assert.equal(message.message, 'ねえng-emoji', '画像が読めなくても本文は残す');
    }

    // 未知の配信元は診断できるように知らせる（同じホストで繰り返さない）
    const h = loadDomChat();
    const bad = () => {
      const image = emojiImage({ alt: 'ng-emoji', src: 'https://cdn.example.com/e.png' });
      image.src = 'https://cdn.example.com/e.png';
      return textRow({ messageParts: [image] });
    };
    h.domChat.handleMutations(added(bad(), bad()));
    assert.equal(h.warnings().filter(w => w.includes('cdn.example.com')).length, 1);
  });

  test('名前が「__proto__」でもプロトタイプを汚さない', () => {
    const h = loadDomChat();
    const row = textRow({ messageParts: [emojiImage({ alt: '__proto__' })] });

    h.domChat.handleMutations(added(row));

    const { emojis } = h.messages()[0];
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    assert.deepEqual(Object.keys({ ...emojis }), ['__proto__']);
  });

  test('絵文字を含まない普通のコメントには対応表を生やさない', () => {
    const h = loadDomChat();

    h.domChat.handleMutations(added(textRow({ message: 'こんばんは' })));

    assert.equal(h.messages()[0].emojis, undefined,
      '全件に生やすと1件あたりのバイト数が全部に効く');
  });

  test('画像URLが変わってもIDは変わらない（履歴と二重にならない）', () => {
    const first = loadDomChat();
    first.domChat.handleMutations(added(textRow({
      messageParts: ['やあ', emojiImage({ alt: '2BROOtojya', src: '//yt3.ggpht.com/A=w24-h24-c-k-nd' })]
    })));

    // 同じコメントだが、YouTube が別のIDやサイズで画像を出した場合
    const second = loadDomChat();
    second.domChat.handleMutations(added(textRow({
      messageParts: ['やあ', emojiImage({ alt: '2BROOtojya', src: '//yt3.ggpht.com/OTHER=w96-h96-c-k-nd' })]
    })));

    assert.equal(second.messages()[0].id, first.messages()[0].id);
    assert.notEqual(second.messages()[0].emojis['2BROOtojya'],
      first.messages()[0].emojis['2BROOtojya'], '前提が崩れている（同じURLになっている）');
  });
});

// チャット側から popup を絞り込む入口（YouTube のチャットで発言者を Alt+クリック）。
//
// ここで守りたいのは2つ。
//  - **素のクリックを奪わないこと。** 名前とアイコンのクリックは YouTube 自身が
//    使っている（「ブロック」「報告」のメニューが開く）。奪うと本体の機能が壊れる
//  - **送る名前が取り込みと同じ読み方であること。** popup 側の突き合わせは
//    displayName の一致なので、ここだけ別の場所から読むと無言で0件になる
describe('チャット側のクリックでの絞り込み', () => {
  test('Alt+クリックで発言者名を送り、YouTube のメニューは開かせない', () => {
    const h = loadDomChat();
    const row = textRow({ displayName: 'にゃんこ' });

    const result = h.click(row.children['#author-name']);

    assert.deepEqual(h.userFilterClicks(), ['にゃんこ']);
    assert.ok(result.prevented && result.stopped, 'YouTube 側へクリックが渡っている');
  });

  test('素のクリックは YouTube のもの（送らないし、止めもしない）', () => {
    const h = loadDomChat();
    const row = textRow({ displayName: 'にゃんこ' });

    const result = h.click(row.children['#author-name'], { altKey: false });

    assert.deepEqual(h.userFilterClicks(), []);
    assert.equal(result.prevented, false, '素のクリックを奪っている（メニューが開かなくなる）');
    assert.equal(result.stopped, false, '素のクリックを止めている');
  });

  test('アイコンを Alt+クリックしても、同じ行の発言者名を送る', () => {
    const h = loadDomChat();
    const row = withLateAvatar(textRow({ displayName: 'にゃんこ' }));
    const avatar = row.attachAvatar();

    h.click(avatar);

    assert.deepEqual(h.userFilterClicks(), ['にゃんこ']);
  });

  test('名前でもアイコンでもない場所の Alt+クリックは無視する', () => {
    const h = loadDomChat();
    const row = textRow({ displayName: 'にゃんこ' });

    const result = h.click(row.children['#message']);

    assert.deepEqual(h.userFilterClicks(), []);
    assert.equal(result.prevented, false);
  });

  test('名前が読めない行では何も送らない（空の絞り込みを作らない）', () => {
    const h = loadDomChat();
    const row = element('', { '#message': element('こんばんは') });
    row.tagName = 'yt-live-chat-text-message-renderer';
    // 名前の器だけあって中身が空、という壊れ方（セレクタ変更時に起きる形）
    row.children['#author-name'] = element('');
    row.children['#author-name'].id = 'author-name';
    row.children['#author-name'].parentElement = row;

    h.click(row.children['#author-name']);

    assert.deepEqual(h.userFilterClicks(), []);
  });
});
