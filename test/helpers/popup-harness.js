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

const POPUP_DIR = path.join(__dirname, '..', '..', 'src', 'popup');
const POPUP_PATH = path.join(POPUP_DIR, 'popup.js');
const POPUP_HTML_PATH = path.join(POPUP_DIR, 'popup.html');

/** popup.html に書かれている id を全部拾う。偽 document が引ける id の正はこれ */
function idsInPopupHtml() {
  const html = fs.readFileSync(POPUP_HTML_PATH, 'utf8');
  return new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]));
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
    calls: { createElement: [], appendChild: [], setAttribute: [], getElementById: [] },
    listeners: {},
    activeElement: null,

    createElement(tagName) {
      doc.calls.createElement.push(String(tagName));
      return createElement(tagName, { ownerDocument: doc });
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
 * popup.js が触る chrome API の最小モック。
 *
 * 応答の作り込みは描画テスト（フェーズ5）の担当。ここでは
 * 「DOMContentLoaded を流しても API が undefined で落ちない」ところまでを用意する。
 *
 * @param {object}   [options]
 * @param {object}   [options.storage]  storage.local の中身
 * @param {Function} [options.onMessage] runtime.sendMessage への応答を作る
 * @param {object[]} [options.queryTabs] tabs.query() が返すタブ一覧
 */
function createChromeMock({ storage = {}, onMessage = () => undefined, queryTabs = [] } = {}) {
  const calls = { runtimeMessages: [], tabMessages: [] };
  const listeners = [];

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      getURL: relativePath => `chrome-extension://test-extension-id/${relativePath}`,
      openOptionsPage: () => {},
      async sendMessage(message) {
        calls.runtimeMessages.push(message);
        return onMessage(message);
      },
      onMessage: { addListener: fn => listeners.push(fn) }
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
    // SW から popup へのメッセージを流す（popup 側の受け口を叩く）
    __deliver(message) {
      for (const listener of listeners) listener(message, {}, () => {});
    },
    __calls: calls
  };

  return chrome;
}

/**
 * popup.js を評価して、中身をテストから触れるようにする。
 *
 * 読み込みだけでは PopupController は作られない（DOMContentLoaded で生成される）。
 * 描画まで見たいときは document.fire('DOMContentLoaded') を呼ぶ。
 *
 * @param {object} [options]
 * @param {object} [options.document] 差し替える偽 document（既定は createFakeDocument()）
 * @param {object} [options.chrome]   差し替える chrome モック（既定は createChromeMock()）
 * @param {object} [options.storage]  chrome.storage.local が返す中身
 */
function loadPopup({ document = createFakeDocument(), storage = {}, chrome = createChromeMock({ storage }) } = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    chrome,
    document
  });

  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8'), context);
  return context;
}

module.exports = {
  loadPopup, createFakeDocument, createChromeMock, createElement, idsInPopupHtml
};
