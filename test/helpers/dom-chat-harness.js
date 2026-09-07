// dom-chat.js を Node 上で実行するためのテストハーネス。
//
// dom-chat.js は content script として書かれており、読み込みと同時に window と
// document を触りにいく。最小限のDOMモックを用意した vm コンテキストでスクリプトごと
// 評価し、内部の関数をテストから呼べるように露出させる。
//
// 注意: これは本物のDOMではない。querySelector はセレクタ文字列の完全一致でしか
// 引けないし、YouTube側のDOM変更を検知する力も無い。ここで検証できるのは
// 「どのタイミングで何を読むか」という dom-chat.js 側の段取りだけ。
//
// ただし「知らないセレクタを引かれたら例外」にしてある（docs/audit-2026-09.md #T1 #T2）。
// 黙って null を返すモックだと、セレクタ名の取り違えがテストを通ってしまい、
// YouTube側のDOM変更で無言で止まる種類の不具合（#2）と見分けがつかない。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const DOM_CHAT_PATH = path.join(__dirname, '..', '..', 'src', 'content', 'dom-chat.js');
// dom-chat.js より先に読み込まれる共有モジュール（再設計の決定7）。
// 本番では manifest の content_scripts[].js の並びがこの順序を作る
const SHARED_PATH = path.join(__dirname, '..', '..', 'src', 'shared', 'comment.js');

// チャット行の入れ物。dom-chat.js が document から引く唯一のセレクタ
const ITEM_LIST_SELECTOR = 'yt-live-chat-item-list-renderer #items';

// dom-chat.js が行の中から引くセレクタの全部。
//
// dom-chat.js 側で新しいセレクタを使い始めたら、ここにも足す。この手間は意図的で、
// 「モックが知らないセレクタ = テストが何も検証していない範囲」を可視化するためにある。
const ROW_SELECTORS = new Set([
  '#author-name',
  '#timestamp',
  '#message',
  '#header-primary-text',
  '#header-subtext',
  '#primary-text',
  '#sticker img',
  '#purchase-amount',
  '#purchase-amount-chip',
  '#author-photo img',
  'img#img',
  'yt-live-chat-author-badge-renderer[type="moderator"]',
  'yt-live-chat-author-badge-renderer[type="member"]'
]);

function unknownSelector(selector, known) {
  return new Error(
    `ハーネスが知らないセレクタを引かれた: ${JSON.stringify(selector)}\n` +
    `dom-chat.js が使うセレクタを変えたなら、dom-chat-harness.js の ${known} にも足すこと`
  );
}

/**
 * dom-chat.js を評価して、テスト用の操作口とまとめて返す。
 *
 * setTimeout は積むだけにして、テストから明示的に進める。実時間を待たずに
 * 「YouTubeがまだ画像を作っていない」状況を何度でも再現するため。
 *
 * @param {object}   [options]
 * @param {object[]} [options.rows] 読み込み時点で既にチャットにある行。
 *                                  attachObserver の全件スキャンが拾う
 * @param {boolean}  [options.hasItemList] false にすると querySelector が常に null を
 *                                  返し、「チャットのDOMが現れないフレーム」を再現する。
 *                                  attachObserver の再試行の打ち切りを見るためのもの
 * @param {string}   [options.pathname] 注入先フレームのパス。live_chat 以外にすると
 *                                  スクリプトはフレーム限定ガードで丸ごと止まる（#1）
 */
function loadDomChat({ rows = [], hasItemList = true, pathname = '/live_chat' } = {}) {
  const timers = [];
  const sent = [];
  const warnings = [];
  // MutationObserver の観測記録。張り方と後始末（#2 / #T3）を見るためのもの
  const observations = [];
  const disconnections = [];

  // 監視対象になるチャット行の入れ物。observe の target と同一性で比べられるよう
  // 1つだけ作って使い回す
  const itemList = { children: rows };

  class RecordingMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
    }

    observe(target, options) {
      observations.push({ observer: this, target, options });
    }

    disconnect() {
      this.disconnected = true;
      disconnections.push(this);
    }
  }

  const context = vm.createContext({
    window: {},
    // dom-chat.js は読み込み時に location.pathname を見て、チャットのフレームか
    // どうかを判定する
    location: { pathname, href: `https://www.youtube.com${pathname}` },
    Node: { TEXT_NODE: 3 },
    URL,
    // 警告は素通しにせず溜める。テストの出力を汚さずに
    // 「諦めたときにログを出したか」を確かめられるようにするため
    console: Object.assign({}, console, { warn: (...args) => warnings.push(args.join(' ')) }),
    // attachObserver をその場で張り付かせる。#items を返さないと
    // 500ms ごとの再試行タイマーがテスト対象のタイマーに混ざる
    // 引けるのは #items だけ。知らないセレクタは例外にして、セレクタ名の
    // 取り違えがテストを素通りしないようにする（#T2）。
    // hasItemList: false は「既知のセレクタだが、まだDOMに無い」の再現なので null を返す
    document: {
      querySelector(selector) {
        if (selector !== ITEM_LIST_SELECTOR) throw unknownSelector(selector, 'ITEM_LIST_SELECTOR');
        return hasItemList ? itemList : null;
      }
    },
    MutationObserver: RecordingMutationObserver,
    setTimeout: fn => timers.push(fn),
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage: (payload, callback) => {
          sent.push(payload);
          if (callback) callback();
        }
      }
    }
  });

  // shared/comment.js は self.YTF に代入する。content script の isolated world と
  // 同じく、両方のスクリプトが同じグローバルを共有する形で再現する
  context.self = context;
  vm.runInContext(fs.readFileSync(SHARED_PATH, 'utf8'), context, { filename: SHARED_PATH });
  vm.runInContext(fs.readFileSync(DOM_CHAT_PATH, 'utf8'), context, { filename: DOM_CHAT_PATH });

  return {
    domChat: context,
    // MutationObserver が張られた対象（#items）
    itemList,
    // chrome.runtime.sendMessage で送られたコメントの一覧
    messages: () => sent.flatMap(payload => payload.messages || []),
    sendCount: () => sent.length,
    pendingTimers: () => timers.length,
    // console.warn に出た内容（素通ししていない）
    warnings: () => warnings,
    /** observe() の呼び出し記録: { observer, target, options } の配列 */
    observations: () => observations,
    /** disconnect() された observer の一覧。張り直しの後始末を見る（#2） */
    disconnections: () => disconnections,
    /**
     * 生きている observer にミューテーションを流す。
     * handleMutations を直接呼ぶのと違い、observe の配線を通る（#T3）
     */
    emit(records) {
      const live = observations.filter(o => !o.observer.disconnected);
      for (const { observer } of live) observer.callback(records, observer);
      return live.length;
    },
    /** 積まれているタイマーを1つ進める（進めた先で積まれた分は次の tick へ回る） */
    tick() {
      const fn = timers.shift();
      if (fn) fn();
    },
    /** タイマーが尽きるまで進める。無限に積み続ける実装を踏んだら例外で気付ける */
    flush(limit = 100) {
      let count = 0;
      while (timers.length > 0) {
        if (++count > limit) throw new Error('タイマーが尽きない（再試行が止まっていない）');
        timers.shift()();
      }
      return count;
    }
  };
}

/**
 * セレクタ→要素の対応表だけを持つ最小の偽要素。
 *
 * querySelector は ROW_SELECTORS に載っているセレクタしか受け付けない。
 * 対応表に無い（＝この行には存在しない）ものは null、
 * dom-chat.js 側の綴りが変わった／モックが古いものは例外で落ちる（#T1）
 */
function element(textContent = '', children = {}, attributes = {}) {
  for (const selector of Object.keys(children)) {
    if (!ROW_SELECTORS.has(selector)) throw unknownSelector(selector, 'ROW_SELECTORS');
  }
  return {
    textContent,
    children,
    attributes,
    // extractText() が絵文字画像を混ぜて本文を組み立てるために辿る
    childNodes: textContent ? [{ nodeType: 3, textContent }] : [],
    querySelector(selector) {
      if (!ROW_SELECTORS.has(selector)) throw unknownSelector(selector, 'ROW_SELECTORS');
      return this.children[selector] || null;
    },
    getAttribute(name) { return this.attributes[name] ?? null; }
  };
}

/** ステッカー画像の img。src はYouTubeの実物と同じくプロトコル相対で持たせる */
function stickerImage({ alt = 'ステッカーの説明', src = '//lh3.googleusercontent.com/STICKER=s208-rwa' } = {}) {
  const img = element('', {}, { alt, src });
  // ブラウザの .src は絶対URLに解決済みの値を返す
  img.src = src.startsWith('//') ? `https:${src}` : src;
  return img;
}

/**
 * スーパーステッカーの行。画像は最初は付いていない（YouTubeが後から作るため）。
 * `attachSticker()` で生やせる。
 */
function stickerRow({ displayName = '@viewer', timestamp = '23:02', amount = '¥1,000' } = {}) {
  const row = element('', {
    '#author-name': element(displayName),
    '#timestamp': element(timestamp),
    '#purchase-amount': element(amount)
  });
  row.tagName = 'yt-live-chat-paid-sticker-renderer';
  row.attachSticker = (image = stickerImage()) => {
    row.children['#sticker img'] = image;
    return image;
  };
  return row;
}

/** 通常のテキストコメントの行 */
function textRow({ displayName = '@viewer', message = 'こんばんは', timestamp = '23:02' } = {}) {
  const row = element('', {
    '#author-name': element(displayName),
    '#timestamp': element(timestamp),
    '#message': element(message)
  });
  row.tagName = 'yt-live-chat-text-message-renderer';
  return row;
}

/** MutationObserver のコールバックに渡される形 */
const added = (...nodes) => [{ addedNodes: nodes }];

module.exports = {
  loadDomChat, element, stickerImage, stickerRow, textRow, added,
  ITEM_LIST_SELECTOR, ROW_SELECTORS
};
