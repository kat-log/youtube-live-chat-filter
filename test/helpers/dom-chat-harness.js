// dom-chat.js を Node 上で実行するためのテストハーネス。
//
// dom-chat.js は content script として書かれており、読み込みと同時に window と
// document を触りにいく。最小限のDOMモックを用意した vm コンテキストでスクリプトごと
// 評価し、内部の関数をテストから呼べるように露出させる。
//
// 注意: これは本物のDOMではない。querySelector はセレクタ文字列の完全一致でしか
// 引けないし、YouTube側のDOM変更を検知する力も無い。ここで検証できるのは
// 「どのタイミングで何を読むか」という dom-chat.js 側の段取りだけ。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const DOM_CHAT_PATH = path.join(__dirname, '..', '..', 'src', 'content', 'dom-chat.js');

/**
 * dom-chat.js を評価して、テスト用の操作口とまとめて返す。
 *
 * setTimeout は積むだけにして、テストから明示的に進める。実時間を待たずに
 * 「YouTubeがまだ画像を作っていない」状況を何度でも再現するため。
 *
 * @param {object}   [options]
 * @param {object[]} [options.rows] 読み込み時点で既にチャットにある行。
 *                                  attachObserver の全件スキャンが拾う
 */
function loadDomChat({ rows = [] } = {}) {
  const timers = [];
  const sent = [];

  const context = vm.createContext({
    window: {},
    Node: { TEXT_NODE: 3 },
    URL,
    console,
    // attachObserver をその場で張り付かせる。#items を返さないと
    // 500ms ごとの再試行タイマーがテスト対象のタイマーに混ざる
    document: { querySelector: () => ({ children: rows }) },
    MutationObserver: class { observe() {} },
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

  vm.runInContext(fs.readFileSync(DOM_CHAT_PATH, 'utf8'), context);

  return {
    domChat: context,
    // chrome.runtime.sendMessage で送られたコメントの一覧
    messages: () => sent.flatMap(payload => payload.messages || []),
    sendCount: () => sent.length,
    pendingTimers: () => timers.length,
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

/** セレクタ→要素の対応表だけを持つ最小の偽要素 */
function element(textContent = '', children = {}, attributes = {}) {
  return {
    textContent,
    children,
    attributes,
    // extractText() が絵文字画像を混ぜて本文を組み立てるために辿る
    childNodes: textContent ? [{ nodeType: 3, textContent }] : [],
    querySelector(selector) { return this.children[selector] || null; },
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

module.exports = { loadDomChat, element, stickerImage, stickerRow, textRow, added };
