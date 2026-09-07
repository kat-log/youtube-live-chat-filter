// src/shared/store.js を単体で評価するためのハーネス。
//
// store.js は3環境（Service Worker / popup）から読まれる素のスクリプトで、
// self.YTFStore に代入する。ここでは shared/comment.js -> shared/store.js の順に
// 同じ vm コンテキストへ評価し（本番の読み込み順の再現）、偽の IndexedDB と
// chrome.storage.local を差してから中身を返す。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createIndexedDBMock } = require('./indexeddb-mock');

const SHARED_DIR = path.join(__dirname, '..', '..', 'src', 'shared');
const COMMENT_PATH = path.join(SHARED_DIR, 'comment.js');
const STORE_PATH = path.join(SHARED_DIR, 'store.js');

/** chrome.storage.local の最小モック（移行元のデータを置く先） */
function createStorageMock(initial = {}) {
  const store = { ...initial };
  const local = {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in store) out[key] = structuredClone(store[key]);
      return out;
    },
    async set(items) { Object.assign(store, structuredClone(items)); },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
    },
    async getKeys() { return Object.keys(store); }
  };
  return { store, chrome: { storage: { local } } };
}

/**
 * @param {object} [options]
 * @param {object} [options.storage]    storage.local の初期値（旧形式の履歴など）
 * @param {number} [options.quotaBytes] IndexedDB の容量上限
 * @param {object} [options.idb]        既存の偽 IndexedDB（再起動を模すときに共有する）
 */
function loadStore({ storage = {}, quotaBytes = Infinity, idb = createIndexedDBMock({ quotaBytes }) } = {}) {
  const { store: localStore, chrome } = createStorageMock(storage);

  const context = vm.createContext({
    console, setTimeout, clearTimeout, structuredClone, Date,
    chrome,
    indexedDB: idb.indexedDB,
    IDBKeyRange: idb.IDBKeyRange
  });
  context.self = context;

  vm.runInContext(fs.readFileSync(COMMENT_PATH, 'utf8'), context, { filename: COMMENT_PATH });
  vm.runInContext(fs.readFileSync(STORE_PATH, 'utf8'), context, { filename: STORE_PATH });

  return { store: context.YTFStore, YTF: context.YTF, local: localStore, idb, context };
}

module.exports = { loadStore, createStorageMock };
