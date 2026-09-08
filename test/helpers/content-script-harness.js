// content-script.js を Node 上で実行するためのテストハーネス。
//
// content-script.js は watch ページのトップフレームで動く content script で、
// 読み込みと同時に window / document / chrome を触りにいく。最小限のモックを
// 用意した vm コンテキストでスクリプトごと評価する。
//
// **内部の関数は露出させない（できない）。** 他のハーネスと違い、
// content-script.js の本体は `class YouTubeLiveChatMonitor` で、
// クラス宣言はブロックスコープに閉じる（Annex B の巻き上げが効くのは
// 関数宣言だけ）。二重注入ガードの `if (...) { } else { ... }` の中にあるので、
// スクリプトスコープからは見えない。したがってここで確かめられるのは
// **外から見える振る舞い**だけ ——
// chrome へ何を送るか / 何に応答するか / どのタイマーと監視を張るか。
// それで足りる: このファイルがやっていることは、ほぼ全部が外との通信である。
//
// 注意: これは本物のDOMでもブラウザでもない。querySelector は
// 「content-script.js が実際に引くセレクタ」しか受け付けず、知らないものは
// 例外にする（dom-chat ハーネスと同じ方針。#T1 / #T2）。
// setTimeout / setInterval は仮想時計に積むだけで、テストから進める。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const CS_PATH = path.join(__dirname, '..', '..', 'src', 'content', 'content-script.js');

// content-script.js が document から引くセレクタの全部（診断情報の収集で使う）。
// 増やしたらここにも足すこと。この手間は意図的で、
// 「モックが知らないセレクタ = テストが何も検証していない範囲」を可視化する
const KNOWN_SELECTORS = new Set([
  'meta[property="og:site_name"][content="YouTube"]',
  '#movie_player',
  'iframe[src*="live_chat"]',
  'meta[property="og:url"]'
]);
const KNOWN_SELECTOR_ALL = new Set(['video', 'script']);

// Service Worker からの既定の応答。テストは onRuntimeMessage で上書きできる
const DEFAULT_RESPONSES = {
  ping: { success: true, timestamp: 0 },
  getDebugMode: { debugMode: false },
  getChatMode: { chatMode: 'dom' },
  getAutoStart: { autoStart: true },
  getApiKey: { apiKey: null },
  getLiveChatIdFromVideo: { liveChatId: null },
  startDomMonitoring: { success: true },
  startBackgroundMonitoring: { success: true },
  stopBackgroundMonitoring: { success: true }
};

/**
 * content-script.js を評価して、テスト用の操作口とまとめて返す。
 *
 * @param {object}   [options]
 * @param {string}   [options.url]         注入先のURL（window.location.href）
 * @param {string}   [options.readyState]  'loading' にすると DOMContentLoaded 待ちになる
 * @param {Function} [options.onRuntimeMessage] chrome.runtime.sendMessage の応答を作る。
 *                   undefined を返すと DEFAULT_RESPONSES にフォールバックする。
 *                   'never' を返すと「応答が返らない Service Worker」を再現する
 * @param {object}   [options.elements]    document.querySelector が返す偽要素
 */
function loadContentScript({
  url = 'https://www.youtube.com/watch?v=VIDEO123',
  readyState = 'complete',
  onRuntimeMessage = () => undefined,
  elements = {}
} = {}) {
  const sent = [];
  const beacons = [];
  const messageListeners = [];
  const windowListeners = {};
  const documentListeners = {};
  const observations = [];
  const disconnections = [];

  // 仮想時計。実時間で2秒も30秒も待たないため、積むだけにして advance() で進める
  let now = 0;
  let timerSeq = 0;
  const timers = new Map();
  const schedule = (fn, delay = 0, repeat = null) => {
    const id = ++timerSeq;
    timers.set(id, { fn, at: now + delay, repeat });
    return id;
  };
  const cancel = id => timers.delete(id);

  class RecordingMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
    }
    observe(target, options) { observations.push({ observer: this, target, options }); }
    disconnect() { this.disconnected = true; disconnections.push(this); }
  }

  const location = { href: url };
  const metaOgUrl = {
    getAttribute: name => (name === 'content' ? url : null)
  };

  const context = vm.createContext({
    window: {
      location,
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); }
    },
    document: {
      readyState,
      addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
      querySelector(selector) {
        if (!KNOWN_SELECTORS.has(selector)) {
          throw new Error(
            `ハーネスが知らないセレクタを引かれた: ${JSON.stringify(selector)}\n` +
            'content-script.js が使うセレクタを変えたなら、' +
            'content-script-harness.js の KNOWN_SELECTORS にも足すこと'
          );
        }
        if (selector === 'meta[property="og:url"]') return elements[selector] ?? metaOgUrl;
        return elements[selector] ?? null;
      },
      querySelectorAll(selector) {
        if (!KNOWN_SELECTOR_ALL.has(selector)) {
          throw new Error(
            `ハーネスが知らないセレクタを引かれた（All）: ${JSON.stringify(selector)}`
          );
        }
        return elements[`all:${selector}`] ?? [];
      },
      // SPA遷移の監視をやめた（#24）ので、本来ここは引かれない。
      // 引かれたら「document.body を購読し直した」と分かるよう、印を返す
      body: { __isDocumentBody: true }
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      language: 'ja',
      sendBeacon: (target, body) => { beacons.push({ target, body }); return true; }
    },
    console,
    MutationObserver: RecordingMutationObserver,
    setTimeout: (fn, delay) => schedule(fn, delay),
    clearTimeout: cancel,
    setInterval: (fn, delay) => schedule(fn, delay, delay),
    clearInterval: cancel,
    chrome: {
      runtime: {
        id: 'test-extension-id',
        lastError: null,
        getURL: file => `chrome-extension://test-extension-id/${file}`,
        onMessage: { addListener: fn => messageListeners.push(fn) },
        // 本番の chrome.runtime.sendMessage はコールバックを渡せば
        // コールバック形式、渡さなければ Promise を返す。両方が使われている
        sendMessage(message, callback) {
          sent.push(message);
          const override = onRuntimeMessage(message);
          if (override === 'never') return callback ? undefined : new Promise(() => {});
          const response = override !== undefined
            ? override
            : DEFAULT_RESPONSES[message?.action];
          if (callback) {
            // 応答はマイクロタスクではなくタスクとして返す（本物と同じく非同期）
            schedule(() => callback(response), 0);
            return undefined;
          }
          return Promise.resolve(response);
        }
      }
    }
  });
  context.self = context;

  vm.runInContext(fs.readFileSync(CS_PATH, 'utf8'), context, { filename: CS_PATH });

  /** 積まれたタイマーとマイクロタスクを、時計を ms 進めながら消化する */
  async function advance(ms = 0) {
    const until = now + ms;
    let guard = 0;
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      if (++guard > 1000) throw new Error('タイマーが尽きない（再試行が止まっていない）');
      const [id, timer] = due[0];
      now = Math.max(now, timer.at);
      if (timer.repeat === null) timers.delete(id);
      else timer.at = now + timer.repeat;
      timer.fn();
    }
    now = until;
    await new Promise(resolve => setImmediate(resolve));
  }

  return {
    context,
    chrome: context.chrome,
    location,
    /** chrome.runtime.sendMessage で送ったもの（古い順） */
    sent: () => sent,
    actions: () => sent.map(m => m?.action),
    /** navigator.sendBeacon で撃ったもの（#31。直したあとは空のまま） */
    beacons: () => beacons,
    /** 登録された onMessage リスナーの本数（二重登録の検知） */
    listenerCount: () => messageListeners.length,
    /**
     * Service Worker / popup から content script へメッセージを流す。
     * 返り値はリスナーの戻り値（true ならチャネルを開いたまま = 非同期応答の宣言）と、
     * 同期的に返された応答。応答が非同期に来る場合は response() で待つ
     */
    deliver(request, sender = {}) {
      let response;
      let responded = false;
      let keepOpen = false;
      for (const fn of messageListeners) {
        const value = fn(request, sender, payload => { response = payload; responded = true; });
        if (value === true) keepOpen = true;
      }
      return {
        keepOpen,
        get responded() { return responded; },
        get response() { return response; }
      };
    },
    /** window.addEventListener で張られたリスナー（beforeunload など） */
    windowListeners: type => windowListeners[type] ?? [],
    fireWindowEvent(type, event = {}) {
      for (const fn of windowListeners[type] ?? []) fn(event);
    },
    fireDocumentEvent(type, event = {}) {
      for (const fn of documentListeners[type] ?? []) fn(event);
    },
    /** MutationObserver.observe() の記録: { observer, target, options } */
    observations: () => observations,
    disconnections: () => disconnections,
    /** SPA遷移。本物の history.pushState と同じく href だけが変わる */
    navigateTo(nextUrl) { location.href = nextUrl; },
    pendingTimers: () => timers.size,
    advance
  };
}

module.exports = { loadContentScript, KNOWN_SELECTORS };
