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
// 注意: これは本物のDOMではない。CSS も :checked も無いので、
// 「見た目が正しいか」はここでは分からない（実ブラウザでしか確認できない）。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createFakeDocument } = require('./popup-harness');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const OPTIONS_PATH = path.join(SRC_DIR, 'options', 'options.js');
const OPTIONS_HTML_PATH = path.join(SRC_DIR, 'options', 'options.html');
// options.html の <script> の並び。theme.js は <head>、comment.js は body の末尾
const THEME_PATH = path.join(SRC_DIR, 'shared', 'theme.js');
const SHARED_PATH = path.join(SRC_DIR, 'shared', 'comment.js');

/** options.html に書かれている id を全部拾う。偽 document が引ける id の正はこれ */
function idsInOptionsHtml() {
  const html = fs.readFileSync(OPTIONS_HTML_PATH, 'utf8');
  return new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]));
}

/**
 * options.js が触る chrome API の最小モック。
 *
 * @param {object} [options]
 * @param {object} [options.storage]   storage.local の中身
 * @param {object} [options.responses] runtime.sendMessage の action -> 応答
 */
function createChromeMock({ storage = {}, responses = {} } = {}) {
  const calls = { runtimeMessages: [], storageWrites: [] };
  const storageListeners = [];

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
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
function loadOptions({ storage = {}, responses = {}, chrome = createChromeMock({ storage, responses }) } = {}) {
  const document = createFakeDocument({ ids: idsInOptionsHtml() });
  const timers = new Map();
  let nextTimerId = 1;

  const context = vm.createContext({
    console,
    setTimeout(fn) { timers.set(nextTimerId, fn); return nextTimerId++; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async () => { throw new Error('fetch はテストから使わない'); },
    chrome,
    document
  });
  context.self = context;

  const expose = ';globalThis.__options = { OptionsController };';

  vm.runInContext(fs.readFileSync(THEME_PATH, 'utf8'), context, { filename: THEME_PATH });
  vm.runInContext(fs.readFileSync(SHARED_PATH, 'utf8'), context, { filename: SHARED_PATH });
  vm.runInContext(fs.readFileSync(OPTIONS_PATH, 'utf8') + expose, context, { filename: OPTIONS_PATH });

  Object.assign(context.__options, {
    document,
    chrome,
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

module.exports = { loadOptions, createChromeMock, idsInOptionsHtml };
