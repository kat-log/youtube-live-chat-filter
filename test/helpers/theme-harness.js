// shared/theme.js を単体で評価するテストハーネス（フェーズ8で新設）。
//
// このファイルは popup と options の <head> から読まれ、**読み込みと同時に
// テーマを塗る**（#15）。だから「評価しただけで何が起きるか」を見たい。
//
// localStorage は差し替えられるようにしてある。写しが取れない環境
// （プライベートモード等で getItem/setItem が投げる）でも、
// ページが1行も動かなくなってはいけないため。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createElement } = require('./popup-harness');

const THEME_PATH = path.join(__dirname, '..', '..', 'src', 'shared', 'theme.js');

/** 最小の localStorage。throws: true で読み書きの両方が例外を投げる */
function createLocalStorageMock({ initial = {}, throws = false } = {}) {
  const store = { ...initial };
  return {
    getItem(key) {
      if (throws) throw new Error('localStorage is not available');
      return key in store ? store[key] : null;
    },
    setItem(key, value) {
      if (throws) throw new Error('localStorage is not available');
      store[key] = String(value);
    },
    __store: store
  };
}

/**
 * shared/theme.js を評価する。
 *
 * @param {object}  [options]
 * @param {object}  [options.storage]      chrome.storage.local の中身（正）
 * @param {object}  [options.localStorage] 差し替える写しの置き場。null で「無い」環境
 * @param {boolean} [options.rejectStorage] storage.local.get を失敗させる
 */
function loadThemeModule({ storage = {}, localStorage = createLocalStorageMock(), rejectStorage = false } = {}) {
  // setAttribute の履歴を残すための最小の owner（塗り直しの順番を見たい）
  const owner = { calls: { setAttribute: [] } };
  const documentElement = createElement('html', { ownerDocument: owner });
  const document = { documentElement };
  const errors = [];

  const chrome = {
    storage: {
      local: {
        get: async keys => {
          if (rejectStorage) throw new Error('storage unavailable');
          const out = {};
          for (const key of (Array.isArray(keys) ? keys : [keys])) {
            if (key in storage) out[key] = storage[key];
          }
          return out;
        }
      }
    }
  };

  const sandbox = {
    console: { ...console, error: (...args) => errors.push(args) },
    chrome,
    document
  };
  // localStorage を渡さないと、vm では未定義のグローバル（typeof で判定される側）になる
  if (localStorage) sandbox.localStorage = localStorage;

  const context = vm.createContext(sandbox);
  context.self = context;
  vm.runInContext(fs.readFileSync(THEME_PATH, 'utf8'), context, { filename: THEME_PATH });

  return {
    context,
    api: context.YTFTheme,
    localStorage,
    errors,
    /** いま html に立っている data-theme */
    theme: () => documentElement.getAttribute('data-theme'),
    /** data-theme に書かれた値の履歴（古い順）。塗り直しの順番を見る */
    writes: () => owner.calls.setAttribute.filter(c => c.name === 'data-theme').map(c => c.value),
    documentElement,
    /** 読み込み時に走った loadTheme() の解決を待つ */
    async settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
  };
}

module.exports = { loadThemeModule, createLocalStorageMock };
