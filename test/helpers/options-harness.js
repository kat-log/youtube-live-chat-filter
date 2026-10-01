// options.js を Node 上で評価するためのテストハーネス（フェーズ8で新設）。
//
// 設定画面はこれまでテスト0件で、そのせいで #12（既定構成の利用者は
// デバッグモードを一生ONにできない）が見逃されていた（docs/audit-2026-09.md #T7）。
//
// 偽 document は popup-harness のものをそのまま借り、**引ける id の正だけを
// options.html の実物に差し替える**（そこに無い id を引かれたら例外）。
// chrome モックはこのファイル独自で、popup 側と違って
// **storage.local.set が onChanged を発火させる**（本物と同じ。テーマの
// 追従が「保存 → 通知 → 塗り直し」まで通ることを見たいため）。
//
// 表示言語（i18n 段階4）: options.html で data-i18n* を付けた要素は、偽 document の
// querySelectorAll('[data-i18n…]') で引けるようにしてある（shared/i18n.js の applyTo() が
// 使う唯一のセレクタ）。要素の textContent の初期値は HTML に直接書いてある文言。
// fetch は src/_locales の実物を返す（手動の言語切替で messages.json を読むため）。
//
// 注意: これは本物のDOMではない。CSS も :checked も無いので、
// 「見た目が正しいか」はここでは分からない（実ブラウザでしか確認できない）。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createFakeDocument } = require('./popup-harness');
const { createI18nMock } = require('./i18n-mock');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const OPTIONS_PATH = path.join(SRC_DIR, 'options', 'options.js');
const OPTIONS_HTML_PATH = path.join(SRC_DIR, 'options', 'options.html');
// options.html の <script> の並び。theme.js と i18n.js は <head>、comment.js は body の末尾
const THEME_PATH = path.join(SRC_DIR, 'shared', 'theme.js');
const I18N_PATH = path.join(SRC_DIR, 'shared', 'i18n.js');
const SHARED_PATH = path.join(SRC_DIR, 'shared', 'comment.js');

/** options.html に書かれている id を全部拾う。偽 document が引ける id の正はこれ */
function idsInOptionsHtml() {
  const html = fs.readFileSync(OPTIONS_HTML_PATH, 'utf8');
  return new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]));
}

const I18N_ATTRIBUTES = ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label'];

const decodeEntities = text => text
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * options.html の中で data-i18n* を付けた要素を拾う。
 * @returns {{ tag: string, id: string|null, attributes: object, text: string }[]}
 */
function i18nElementsInOptionsHtml() {
  const html = fs.readFileSync(OPTIONS_HTML_PATH, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*\bdata-i18n[^>]*)>/g)) {
    const [whole, tag, rest] = match;
    const attributes = {};
    for (const [, name, value] of rest.matchAll(/([a-z0-9-]+)="([^"]*)"/g)) attributes[name] = value;
    const start = match.index + whole.length;
    const text = decodeEntities(html.slice(start, html.indexOf('<', start)).replace(/\s+/g, ' ').trim());
    out.push({ tag, id: attributes.id ?? null, attributes, text });
  }
  return out;
}

/** 偽 document に data-i18n* の要素を載せ、属性セレクタ1つだけの querySelectorAll を足す */
function attachI18nElements(document) {
  const elements = i18nElementsInOptionsHtml().map(({ tag, id, attributes, text }) => {
    const el = id ? document.getElementById(id) : document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) el.attributes[name] = value;
    el.textContent = text;
    el.writes.textContent = [];
    return el;
  });
  document.querySelectorAll = selector => {
    const name = selector.match(/^\[([a-z0-9-]+)\]$/)?.[1];
    if (!name || !I18N_ATTRIBUTES.includes(name)) {
      throw new Error(`偽 document の querySelectorAll は data-i18n* の属性セレクタだけ: ${selector}`);
    }
    return elements.filter(el => el.getAttribute(name) !== null);
  };
  /** テストから: data-i18n* のキーで要素を引く（最初の1つ） */
  document.byI18nKey = key => elements.find(el => I18N_ATTRIBUTES.some(a => el.getAttribute(a) === key)) || null;
  document.i18nElements = elements;
  return elements;
}

/**
 * options.js が触る chrome API の最小モック。
 *
 * @param {object} [options]
 * @param {object} [options.storage]   storage.local の中身
 * @param {object} [options.responses] runtime.sendMessage の action -> 応答
 * @param {string} [options.locale]    chrome.i18n が引く言語（既定 'ja'）
 */
function createChromeMock({ storage = {}, responses = {}, locale = 'ja' } = {}) {
  const calls = { runtimeMessages: [], storageWrites: [] };
  const storageListeners = [];

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: file => `chrome-extension://test-extension-id/${file}`,
      async sendMessage(message) {
        calls.runtimeMessages.push(message);
        return responses[message.action] ?? {};
      }
    },
    storage: {
      local: {
        get: async keys => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in storage) out[key] = structuredClone(storage[key]);
          return out;
        },
        set: async items => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: storage[key], newValue: value };
            storage[key] = structuredClone(value);
          }
          calls.storageWrites.push(structuredClone(items));
          // 本物と同じく、書いた本人のページにも通知が飛ぶ
          for (const fn of storageListeners) fn(changes, 'local');
        }
      },
      onChanged: { addListener: fn => storageListeners.push(fn) }
    },
    i18n: createI18nMock({ locale }),
    /** テストから storage の変更を流す（別のページで変えられた状況） */
    __emitStorageChange(changes) {
      for (const fn of storageListeners) fn(changes, 'local');
    },
    __storage: storage,
    __calls: calls
  };

  return chrome;
}

/**
 * options.js を評価して、中身をテストから触れるようにする。
 *
 * 読み込みだけでは OptionsController は作られない（DOMContentLoaded で生成される）。
 * `document.fire('DOMContentLoaded')` で作る。
 * setTimeout は popup ハーネスと同じく「積むだけ」（トーストの自動消去を実時間で待たない）。
 */
function loadOptions({
  storage = {},
  responses = {},
  locale = 'ja',
  fetchApi = async () => { throw new Error('API への fetch はテストで差し替える'); },
  chrome = createChromeMock({ storage, responses, locale })
} = {}) {
  const document = createFakeDocument({ ids: idsInOptionsHtml() });
  attachI18nElements(document);
  // input の type は HTML のまま持たせる（APIキー欄の表示・非表示が type を見て切り替える）
  const html = fs.readFileSync(OPTIONS_HTML_PATH, 'utf8');
  for (const [, id, type] of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*\btype="([^"]+)"/g)) {
    document.getElementById(id).type = type;
  }
  for (const [, type, id] of html.matchAll(/<input\b[^>]*\btype="([^"]+)"[^>]*\bid="([^"]+)"/g)) {
    document.getElementById(id).type = type;
  }
  const fetched = [];
  const timers = new Map();
  let nextTimerId = 1;

  const context = vm.createContext({
    console,
    setTimeout(fn) { timers.set(nextTimerId, fn); return nextTimerId++; },
    clearTimeout(id) { timers.delete(id); },
    // 拡張機能の中のファイル（_locales の messages.json）は実物を返す。
    // それ以外（API接続テストの googleapis）は fetchApi に任せる
    async fetch(url) {
      fetched.push(url);
      const prefix = 'chrome-extension://test-extension-id/';
      if (String(url).startsWith(prefix)) {
        const body = fs.readFileSync(path.join(SRC_DIR, String(url).slice(prefix.length)), 'utf8');
        return { ok: true, json: async () => JSON.parse(body) };
      }
      return fetchApi(url);
    },
    chrome,
    document
  });
  context.self = context;

  const expose = ';globalThis.__options = { OptionsController };';

  vm.runInContext(fs.readFileSync(THEME_PATH, 'utf8'), context, { filename: THEME_PATH });
  vm.runInContext(fs.readFileSync(I18N_PATH, 'utf8'), context, { filename: I18N_PATH });
  vm.runInContext(fs.readFileSync(SHARED_PATH, 'utf8'), context, { filename: SHARED_PATH });
  vm.runInContext(fs.readFileSync(OPTIONS_PATH, 'utf8') + expose, context, { filename: OPTIONS_PATH });

  Object.assign(context.__options, {
    document,
    chrome,
    fetched,
    /** 積まれているタイマーを1つ進める */
    tick() {
      const [id, fn] = timers.entries().next().value || [];
      if (id === undefined) return false;
      timers.delete(id);
      fn();
      return true;
    }
  });

  return context.__options;
}

module.exports = { loadOptions, createChromeMock, idsInOptionsHtml, i18nElementsInOptionsHtml };
