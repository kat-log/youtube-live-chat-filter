// popup.js を Node 上で評価するためのテストハーネス。
//
// popup.js は読み込みと同時に chrome.storage と document を触りにいくので、
// 最小限のモックを置いた vm コンテキストで評価し、内部の関数をテストから
// 呼べるように露出させる。
//
// 偽 document は「popup.html に実在する id しか引けない」作りにしてある
// （docs/audit-2026-09.md #T8）。null を黙って返すモックだと、id の綴り違いや
// HTML から消えた要素への参照が、テストを通ったまま本番でだけ壊れる。
//
// 注意: これは本物のDOMではない。CSS セレクタは解釈せず、レイアウトも
// イベント伝播も無い。ここで検証できるのは「どの要素に何を書いたか」だけ。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createIndexedDBMock } = require('./indexeddb-mock');

const POPUP_DIR = path.join(__dirname, '..', '..', 'src', 'popup');
const POPUP_PATH = path.join(POPUP_DIR, 'popup.js');
const POPUP_HTML_PATH = path.join(POPUP_DIR, 'popup.html');
// popup.html が popup.js より先に読み込む共有モジュール（再設計の決定7・決定2）。
// self.YTF / self.YTFStore に代入されるので、popup.js からは同じグローバル経由で見える。
// 順番も popup.html と同じにする（store.js は bucket の判定で YTF を使う）
const SHARED_PATH = path.join(__dirname, '..', '..', 'src', 'shared', 'comment.js');
const STORE_PATH = path.join(__dirname, '..', '..', 'src', 'shared', 'store.js');
// popup.html が <head> で読む（body の末尾ではない）。テーマを最初の描画より
// 前に塗るためで、順番も本物と同じくいちばん先にする（フェーズ8 / #15）
const THEME_PATH = path.join(__dirname, '..', '..', 'src', 'shared', 'theme.js');

/** popup.html に書かれている id を全部拾う。偽 document が引ける id の正はこれ */
function idsInPopupHtml() {
  const html = fs.readFileSync(POPUP_HTML_PATH, 'utf8');
  return new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]));
}

/**
 * `.class` / `#id` / `tag` だけを解釈する最小の照合。
 * popup.js が closest に渡すのはクラス1つだけなので、これで足りる
 */
function matchesSelector(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return el.tagName === selector.toUpperCase();
}

/**
 * 最小の偽要素。dom-chat-harness.js の element() と同じ流儀で、
 * 書き込まれた内容をそのまま持っておく。
 *
 * textContent / innerHTML は代入の履歴も残す。描画のテスト（フェーズ5）では
 * 「最後にどうなったか」だけでなく「何回書き直したか」も見たいため（#22）。
 */
function createElement(tagName, { id = null, ownerDocument = null } = {}) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    id: id || '',
    // appendChild で足された子。DOM の childNodes とは違い、足した順の配列
    children: [],
    attributes: {},
    dataset: {},
    style: {},
    // レイアウトは持たないので、寸法は数値の既定値だけ置く。
    // 描画のあと popup.js が1回だけ読む（#22）ので、undefined だと NaN が伝わる
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    hidden: false,
    // addEventListener で登録されたハンドラ。type -> 関数の配列
    listeners: {},
    // textContent / innerHTML への代入の履歴（古い順）
    writes: { textContent: [], innerHTML: [] },
    classList: {
      // Set にせず配列で持つのは、add/remove の順序も見たいことがあるため
      _names: [],
      add(...names) { for (const n of names) if (!this._names.includes(n)) this._names.push(n); },
      remove(...names) { this._names = this._names.filter(n => !names.includes(n)); },
      toggle(name, force) {
        const on = force === undefined ? !this._names.includes(name) : force;
        if (on) this.add(name); else this.remove(name);
        return on;
      },
      contains(name) { return this._names.includes(name); },
      get value() { return this._names.join(' '); }
    },

    appendChild(child) {
      // DocumentFragment は「中身だけ」が移る。本物と同じく、足したあとの
      // fragment は空になる（popup.js が1回の appendChild で新着行を足すため）
      if (child.tagName === '#DOCUMENT-FRAGMENT') {
        for (const grandChild of child.children.slice()) el.appendChild(grandChild);
        child.children = [];
        return child;
      }
      child.parentNode?.removeChild(child);
      el.children.push(child);
      child.parentNode = el;
      ownerDocument?.calls.appendChild.push({ parent: el.id || el.tagName, child: child.tagName });
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter(c => c !== child);
      child.parentNode = null;
      return child;
    },
    remove() { el.parentNode?.removeChild(el); },
    /** 本物と同じく、自分を置き換えてDOMから外れる（画像の読み込み失敗で使う） */
    replaceWith(node) {
      const parent = el.parentNode;
      if (!parent) return;
      parent.children = parent.children.map(c => (c === el ? node : c));
      node.parentNode = parent;
      el.parentNode = null;
    },

    setAttribute(name, value) {
      el.attributes[name] = String(value);
      ownerDocument?.calls.setAttribute.push({ target: el.id || el.tagName, name, value: String(value) });
    },
    getAttribute(name) { return el.attributes[name] ?? null; },
    removeAttribute(name) { delete el.attributes[name]; },
    hasAttribute(name) { return name in el.attributes; },

    addEventListener(type, handler) { (el.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      el.listeners[type] = (el.listeners[type] || []).filter(h => h !== handler);
    },
    /** 登録済みのハンドラを呼ぶ（テストからのクリック相当。本物の伝播は無い） */
    fire(type, event = {}) {
      for (const handler of el.listeners[type] || []) handler({ type, target: el, ...event });
    },

    focus() { ownerDocument && (ownerDocument.activeElement = el); },
    blur() { if (ownerDocument?.activeElement === el) ownerDocument.activeElement = null; },
    scrollTo() {},
    scrollIntoView() {},

    // popup.js は CSS セレクタでは引かないが、行の中身を確かめたいことがあるので
    // 完全一致の対応表だけ持たせる（dom-chat-harness の element() と同じ割り切り）
    selectors: {},
    querySelector(selector) { return el.selectors[selector] || null; },
    // 対応表を先に引く（レイアウトを持たない要素のための逃げ道）。
    // 載っていなければ、appendChild が張った親子関係を自分からたどる。
    // イベント委譲（#22）が closest を使うので、ここは本物に寄せておく
    closest(selector) {
      if (el.selectors[selector]) return el.selectors[selector];
      for (let node = el; node; node = node.parentNode) {
        if (matchesSelector(node, selector)) return node;
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = el.selectors[selector];
      return found ? (Array.isArray(found) ? found : [found]) : [];
    }
  };

  let textContent = '';
  Object.defineProperty(el, 'textContent', {
    get: () => textContent,
    set: value => { textContent = String(value); el.writes.textContent.push(textContent); },
    enumerable: true
  });

  let innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHTML,
    set: value => {
      innerHTML = String(value);
      el.writes.innerHTML.push(innerHTML);
      // innerHTML の代入は子を作り直す。本物と同じく、それまでの子は消える
      el.children = [];
    },
    enumerable: true
  });

  return el;
}

/**
 * popup.html に実在する id しか引けない偽 document。
 *
 * @param {object}   [options]
 * @param {Set<string>|string[]} [options.ids] 引ける id。既定は popup.html の実物
 * @param {boolean}  [options.strictIds] false にすると、未知の id でも要素を作って返す。
 *                                       popup.html を変えている途中の実験用
 */
function createFakeDocument({ ids = idsInPopupHtml(), strictIds = true } = {}) {
  const known = new Set(ids);
  const elements = new Map();

  const doc = {
    // 記録。誰が何を作り、どこに足し、どの属性を書いたか
    calls: {
      createElement: [], createDocumentFragment: [],
      appendChild: [], setAttribute: [], getElementById: []
    },
    listeners: {},
    activeElement: null,

    createElement(tagName) {
      doc.calls.createElement.push(String(tagName));
      return createElement(tagName, { ownerDocument: doc });
    },

    /** 新着行をまとめて1回で足すための入れ物（appendChild が中身だけ移す） */
    createDocumentFragment() {
      doc.calls.createDocumentFragment.push(true);
      return createElement('#document-fragment', { ownerDocument: doc });
    },

    getElementById(id) {
      doc.calls.getElementById.push(id);
      if (!known.has(id)) {
        if (strictIds) {
          throw new Error(`popup.html に id="${id}" は無い（綴り違いか、HTMLから消えた要素）`);
        }
        known.add(id);
      }
      if (!elements.has(id)) elements.set(id, createElement('div', { id, ownerDocument: doc }));
      return elements.get(id);
    },

    addEventListener(type, handler) { (doc.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      doc.listeners[type] = (doc.listeners[type] || []).filter(h => h !== handler);
    },
    /** DOMContentLoaded など、document に登録されたハンドラを呼ぶ */
    fire(type, event = {}) {
      for (const handler of doc.listeners[type] || []) handler({ type, target: doc, ...event });
    },

    /** getElementById 済みの要素を、テストから覗く用（引いていなければ作らない） */
    peek(id) { return elements.get(id) || null; },
    /** id を引かれた回数。配線の抜けを見つけるのに使う */
    requestedIds() { return doc.calls.getElementById; }
  };

  doc.documentElement = createElement('html', { ownerDocument: doc });
  doc.body = createElement('body', { ownerDocument: doc });
  return doc;
}

/**
 * chrome.runtime.connect が返すポートの偽物（フェーズ6b）。
 *
 * popup は SW との通信をこのポート1本に集約している。要求は
 * `{ requestId, payload }` で送られ、応答は同じ requestId を載せて返る。
 * 片道の通知（新着コメント等）は requestId を持たない。
 *
 * **既定では応答を返さない。** 本物の Service Worker が居ない状態を再現するためで、
 * これにより popup の初期化は最初の要求で止まったままになり、テストは
 * 組み立てられた DOM だけを見られる（ポート化の前は ping の待ちが同じ役をしていた）。
 * 応答が要るテストは loadPopup({ onRequest }) で作る。
 */
function createFakePort({ name, onRequest, calls }) {
  const listeners = { message: [], disconnect: [] };
  const port = {
    name,
    connected: true,
    /** popup から SW へ送られたもの（{ requestId, payload } の列） */
    posted: [],

    postMessage(message) {
      if (!port.connected) throw new Error('Attempting to use a disconnected port object');
      port.posted.push(message);
      calls.portRequests.push(message);
      if (!onRequest) return;
      const payload = onRequest(message.payload, message);
      if (payload === undefined) return;
      // 本物と同じく、応答は必ず非同期に返る
      Promise.resolve(payload).then(value =>
        port.__deliver({ requestId: message.requestId, payload: value }));
    },

    onMessage: { addListener: fn => listeners.message.push(fn) },
    onDisconnect: { addListener: fn => listeners.disconnect.push(fn) },
    /** popup 側から切る（本物の port.disconnect） */
    disconnect() { port.connected = false; },

    /** SW から popup へ流す（応答も片道の通知もここを通る） */
    __deliver(message) {
      for (const fn of listeners.message) fn(message);
    },
    /** SW 側が落ちた／拡張機能が再読み込みされた（popup の onDisconnect を撃つ） */
    __disconnect() {
      if (!port.connected) return;
      port.connected = false;
      for (const fn of listeners.disconnect) fn(port);
    }
  };
  return port;
}

/**
 * popup.js が触る chrome API の最小モック。
 *
 * 応答の作り込みは描画テスト（フェーズ5）の担当。ここでは
 * 「DOMContentLoaded を流しても API が undefined で落ちない」ところまでを用意する。
 *
 * @param {object}   [options]
 * @param {object}   [options.storage]   storage.local の中身
 * @param {Function} [options.onRequest] ポートに来た要求への応答を作る。
 *                                       undefined を返すと応答しない（既定）
 * @param {object[]} [options.queryTabs] tabs.query() が返すタブ一覧
 * @param {Function} [options.onConnect] connect が失敗する状況を作る（throw させる）
 */
function createChromeMock({
  storage = {}, onRequest = null, queryTabs = [], onConnect = null
} = {}) {
  const calls = { runtimeMessages: [], tabMessages: [], portRequests: [], ports: [] };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      getURL: relativePath => `chrome-extension://test-extension-id/${relativePath}`,
      openOptionsPage: () => {},
      // popup ↔ SW はポート1本（フェーズ6b）。sendMessage は残してあるが、
      // popup からは1回も呼ばれない（呼ばれたら calls.runtimeMessages に出る）
      async sendMessage(message) {
        calls.runtimeMessages.push(message);
        return undefined;
      },
      connect(info = {}) {
        if (onConnect) onConnect(info);
        const port = createFakePort({ name: info.name, onRequest, calls });
        calls.ports.push(port);
        return port;
      }
    },
    tabs: {
      async query() { return structuredClone(queryTabs); },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message });
        return undefined;
      },
      create: () => {},
      async reload() {}
    },
    storage: {
      local: {
        get: async keys => {
          if (keys === undefined || keys === null) return structuredClone(storage);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in storage) out[key] = structuredClone(storage[key]);
          return out;
        },
        set: async items => { Object.assign(storage, structuredClone(items)); },
        remove: async keys => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key];
        }
      },
      onChanged: { addListener() {} }
    },
    /** いま繋がっているポート（張り直されたら新しい方） */
    __port() { return calls.ports[calls.ports.length - 1] || null; },
    /** 張られたポートの本数。#32 の二重登録はここで見つかる */
    __portCount() { return calls.ports.length; },
    // SW から popup へのメッセージを流す（popup 側の受け口を叩く）
    __deliver(message) {
      chrome.__port()?.__deliver(message);
    },
    /** SW 側からポートを切る（拡張機能の再読み込み相当） */
    __disconnect() { chrome.__port()?.__disconnect(); },
    __calls: calls
  };

  return chrome;
}

/**
 * popup.js を評価して、中身をテストから触れるようにする。
 *
 * 読み込みだけでは PopupController は作られない（DOMContentLoaded で生成される）。
 * 描画まで見たいときは document.fire('DOMContentLoaded') を呼ぶか、
 * context.__popup.PopupController を直接 new する。
 *
 * setTimeout は dom-chat ハーネスと同じく「積むだけ」にしてある。実時間で回すと
 * 描画の遅延（検索のデバウンス・成功／エラー表示の自動消去・requestAnimationFrame の
 * 代わり）がそのぶん待たされ、テストが遅くなるうえ順番も見えなくなるため。
 * テストからは tick() で1つずつ進める。
 *
 * 初期化は、ポートへの最初の要求（getCommentFilters）で止まったままになる ——
 * 偽ポートは既定で応答を返さないため（createFakePort の但し書き）。
 * フェーズ6b より前は「Service Worker への ping を8回投げる待ち」が同じ役をしていた。
 *
 * @param {object}   [options]
 * @param {object}   [options.document] 差し替える偽 document（既定は createFakeDocument()）
 * @param {object}   [options.chrome]   差し替える chrome モック（既定は createChromeMock()）
 * @param {object}   [options.storage]  chrome.storage.local が返す中身
 * @param {Function} [options.onRequest] ポートに来た要求への応答を作る
 * @param {number}   [options.maxCommentsToPopup] メモリ上限を小さくする
 *   （10,000件を積まずに切り詰めの挙動を見るため。store 側の LIMITS と同じ流儀）
 */
function loadPopup({
  document = createFakeDocument(),
  storage = {},
  onRequest = null,
  chrome = createChromeMock({ storage, onRequest }),
  maxCommentsToPopup = null
} = {}) {
  // popup は bulk 枠（メンバー・一般）を IndexedDB から直接読む（決定4）。
  // 偽 IndexedDB のタイマーはこの下の「積むだけ」ではなく Node の実時間で回る
  const idb = createIndexedDBMock();
  // id -> 関数。clearTimeout で消せるように Map で持つ
  const timers = new Map();
  let nextTimerId = 1;

  const context = vm.createContext({
    console,
    setTimeout(fn) { timers.set(nextTimerId, fn); return nextTimerId++; },
    // 本物は次の描画の直前に走る。ここでは setTimeout と同じ「積むだけ」にして、
    // テストから進められるようにしておく
    requestAnimationFrame(fn) { timers.set(nextTimerId, fn); return nextTimerId++; },
    cancelAnimationFrame(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { timers.set(nextTimerId, fn); return nextTimerId++; },
    clearInterval(id) { timers.delete(id); },
    URL,
    chrome,
    document,
    indexedDB: idb.indexedDB,
    IDBKeyRange: idb.IDBKeyRange
  });

  // popup.js の内部（クラスと唯一のインスタンス）をテストから触れるようにする。
  // どちらもトップレベルの let / class なので、グローバルの属性にはならない
  const expose = `
    ;globalThis.__popup = {
      PopupController,
      get controller() { return popupController; }
    };`;

  // popup.html の <script> の並びを、ハーネス側で再現する
  context.self = context;
  vm.runInContext(fs.readFileSync(THEME_PATH, 'utf8'), context, { filename: THEME_PATH });
  vm.runInContext(fs.readFileSync(SHARED_PATH, 'utf8'), context, { filename: SHARED_PATH });
  vm.runInContext(fs.readFileSync(STORE_PATH, 'utf8'), context, { filename: STORE_PATH });
  // popup.js は読み込み時に上限を束縛するので、差し替えるならこの順番でしかできない
  if (maxCommentsToPopup !== null) context.YTFStore.MAX_COMMENTS_TO_POPUP = maxCommentsToPopup;
  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8') + expose, context, { filename: POPUP_PATH });

  Object.assign(context.__popup, {
    idb,
    /** 積まれているタイマーの数 */
    pendingTimers: () => timers.size,
    /** 積まれているタイマーを1つ進める（進めた先で積まれた分は次の tick へ回る） */
    tick() {
      const [id, fn] = timers.entries().next().value || [];
      if (id === undefined) return false;
      timers.delete(id);
      fn();
      return true;
    }
  });

  return context;
}

/** 行の中からクラス名で1つ探す（偽DOMには本物のセレクタが無い） */
function findByClass(element, className) {
  for (const child of element.children || []) {
    if (child.classList?.contains(className)) return child;
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

/**
 * 一覧に出来ている行を、テストから読める形にほどく。
 *
 * フェーズ5 で描画が「innerHTML の全置換」から「1コメント1行を作って
 * hidden を切り替える」に変わったので、画面に出ているものを見るには
 * DOM をたどる必要がある。hidden の行も返す（作り直していないことを
 * 数えたいのはむしろそちら）。
 */
function readCommentRows(commentsList) {
  return commentsList.children.map(element => {
    const author = findByClass(element, 'comment-author');
    const message = findByClass(element, 'comment-message');
    const avatar = findByClass(element, 'comment-avatar');
    return {
      element,
      hidden: !!element.hidden,
      id: element.getAttribute('data-comment-id'),
      username: author ? author.getAttribute('data-username') : null,
      authorText: author ? author.textContent : null,
      author,
      avatar,
      message: message ? message.textContent : null,
      classes: element.classList._names.slice()
    };
  });
}

/** いま画面に出ている（hidden でない）行の発言者名 */
function visibleUsernames(commentsList) {
  return readCommentRows(commentsList).filter(row => !row.hidden).map(row => row.username);
}

module.exports = {
  loadPopup, createFakeDocument, createChromeMock, createElement, idsInPopupHtml,
  readCommentRows, visibleUsernames, findByClass
};
