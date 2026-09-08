// Service Worker を Node 上で実行するためのテストハーネス。
//
// service-worker.js は MV3 の Service Worker として書かれており、読み込みと同時に
// chrome API を触りにいく。そこで最小限の chrome モックを用意した vm コンテキストで
// スクリプトごと評価し、内部の関数と状態をテストから触れるように露出させる。
//
// 注意: これはあくまで chrome API のモックであり、実ブラウザの挙動（本物のquotaの
// 出方、Service Workerが終了するタイミング、メッセージパッシングの実挙動）までは
// 再現しない。検証できるのは Service Worker 側のロジックのみ。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createIndexedDBMock } = require('./indexeddb-mock');

const SW_PATH = path.join(__dirname, '..', '..', 'src', 'background', 'service-worker.js');

/**
 * chrome API のモックを作る。
 * @param {object}  [options]
 * @param {number}  [options.quotaBytes]     storage.local の容量上限（超えると set() が reject）
 * @param {object}  [options.tabs]           tabId をキーにしたタブ情報（chrome.tabs.get が返す）
 * @param {object[]}[options.contentScripts] getManifest() が返す content_scripts
 * @param {object[]}[options.queryTabs]      chrome.tabs.query() が返すタブ一覧
 * @param {Function}[options.onTabMessage]   tabs.sendMessage の応答を作る。
 *                                           throw すると「応答なし」を再現できる
 * @param {number}  [options.idbQuotaBytes]  IndexedDB の容量上限（超えると put が失敗）
 */
function createChromeMock({
  quotaBytes = Infinity,
  tabs = {},
  contentScripts = [],
  queryTabs = [],
  onTabMessage = () => undefined,
  idbQuotaBytes = Infinity
} = {}) {
  const store = {};
  const calls = {
    badge: [], executeScript: [], tabMessages: [], runtimeMessages: [], alarms: []
  };

  const usedBytes = () => Buffer.byteLength(JSON.stringify(store));

  const local = {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in store) out[key] = structuredClone(store[key]);
      return out;
    },
    async set(items) {
      const snapshot = structuredClone(store);
      Object.assign(store, structuredClone(items));
      if (usedBytes() > quotaBytes) {
        // 実際の storage と同じく、超過した書き込みは丸ごと巻き戻る
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, snapshot);
        throw new Error('Resource::kQuotaBytes quota exceeded');
      }
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
    },
    async getKeys() { return Object.keys(store); },
    async getBytesInUse() { return usedBytes(); }
  };

  const chrome = {
    storage: { local },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getManifest: () => ({ version: 'test', content_scripts: contentScripts }),
      onMessage: { addListener: fn => { chrome.__onMessage = fn; } },
      onInstalled: { addListener: fn => { chrome.__onInstalled = fn; } },
      onStartup: { addListener: () => {} },
      onSuspend: { addListener: () => {} },
      onSuspendCanceled: { addListener: () => {} },
      async sendMessage(message) { calls.runtimeMessages.push(message); }
    },
    // 番人（chrome.alarms）。実時間で1分待てないので、テストから
    // chrome.__fireAlarm() で叩く。作成・削除は calls.alarms に残す
    alarms: {
      create(name, info) { calls.alarms.push({ op: 'create', name, info }); },
      async clear(name) { calls.alarms.push({ op: 'clear', name }); return true; },
      onAlarm: { addListener: fn => { chrome.__onAlarm = fn; } }
    },
    tabs: {
      // #35 でリスナーを1本に決めた。2本目が足されたらここで気付けるよう、
      // 登録は配列で受ける
      onRemoved: { addListener: fn => { chrome.__onTabRemoved.push(fn); } },
      async query() { return structuredClone(queryTabs); },
      async get(tabId) {
        if (!(tabId in tabs)) throw new Error(`No tab with id: ${tabId}`);
        return tabs[tabId];
      },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message });
        return onTabMessage(tabId, message);
      }
    },
    scripting: {
      async executeScript(options) { calls.executeScript.push(options); return []; }
    },
    action: {
      setBadgeText: ({ text }) => calls.badge.push(text),
      setBadgeBackgroundColor: () => {}
    }
  };

  chrome.__onTabRemoved = [];
  /** 番人の alarm を1回発火させる（本物は1分周期） */
  chrome.__fireAlarm = (name = 'monitoring-watchdog') =>
    Promise.resolve(chrome.__onAlarm?.({ name }));
  /** タブが閉じられたことを通知する（登録されたリスナー全部に配る） */
  chrome.__closeTab = tabId => Promise.all(chrome.__onTabRemoved.map(fn => fn(tabId)));

  // コメント履歴の保存先（shared/store.js が開く IndexedDB）。
  // store という名前は storage.local のモックが先に使っているので idb と呼ぶ。
  // chrome に提げておくのは、loadServiceWorker(chrome) だけを呼ぶ既存のテストでも
  // 同じ IndexedDB が使われるようにするため
  const idb = createIndexedDBMock({ quotaBytes: idbQuotaBytes });
  chrome.__idb = idb;

  return { chrome, store, calls, idb };
}

/**
 * service-worker.js を評価し、内部の関数・状態を返す。
 * session は beginSession のたびに丸ごと再代入されるため、
 * 常に最新を見られるよう getter 経由で露出する。
 * monitoringState は旧名の別名（中身は同じ session を指す）。
 */
function loadServiceWorker(chrome, idb = chrome.__idb || createIndexedDBMock()) {
  const source = fs.readFileSync(SW_PATH, 'utf8');
  const expose = `
    ;globalThis.__sw = {
      get session() { return session; },
      // 旧名。フェーズ6a で単一の session に畳んだが、
      // 「getter 経由で常に最新を見る」という露出の仕方は変えていない
      get monitoringState() { return session; },
      setState: (patch) => Object.assign(session, patch),
      // 世代を進めずに（＝epoch を変えずに）状態を差し替えると、
      // 世代の確認をすり抜けるテストを書いてしまう。世代ごと作る口も置く
      beginSession: (patch) => beginSession(patch),
      reconcile,
      loadSession,
      saveSession,
      runWatchdog,
      isPollingAlive,
      startPollingLoop,
      startBackgroundMonitoring,
      enqueueDomChatMessages,
      cleanupOldCommentHistories,
      reinjectContentScripts,
      handleDomChatMessages,
      startDomMonitoring,
      stopBackgroundMonitoring,
      getCommentsHistory,
      extractVideoIdFromUrl,
      safeStorageSet,
      commentPreview,
      flushCommentsHistory,
      readCommentsForPopup,
      fetchLiveChatMessages,
      // APIモードの取得を差し替える口。コンテキストの fetch は既定で
      // 「ネットワークは使えない」を投げるので、テスト側から items を差し込む
      setFetch: (fn) => { globalThis.fetch = fn; },
      // 履歴の保存は shared/store.js が正。テストからも同じ口を通す（決定2）
      store: self.YTFStore,
      latestTimestampOf: self.YTFStore.latestTimestampOf,
      // 型と正規化は shared/comment.js が正。Service Worker のスコープからではなく
      // そちら経由で露出する（決定7で移した先を、テストからも1か所で見るため）
      normalizeCommentFilters: self.YTF.normalizeCommentFilters,
      isCommentEnabled: self.YTF.isCommentEnabled,
      apiCommentKind: self.YTF.apiCommentKind,
      DEFAULT_COMMENT_FILTERS: self.YTF.DEFAULT_COMMENT_FILTERS,
      YTF: self.YTF,
      MAX_HISTORY_VIDEOS,
      AVATAR_LIMITS
    };`;

  const context = vm.createContext({
    chrome, console, setTimeout, clearTimeout, Date, structuredClone, URL,
    indexedDB: idb.indexedDB,
    IDBKeyRange: idb.IDBKeyRange,
    fetch: async () => { throw new Error('network access is not available in tests'); }
  });

  // Service Worker のグローバルは self で参照できる。shared/comment.js が
  // self.YTF に代入するので、コンテキスト自身を self として見せる
  context.self = context;
  // importScripts は同期。本番と同じく「同じスコープに評価する」形で再現する
  context.importScripts = (...paths) => {
    for (const relativePath of paths) {
      const file = path.resolve(path.dirname(SW_PATH), relativePath);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
  };

  vm.runInContext(source + expose, context, { filename: SW_PATH });
  context.__sw.idb = idb;
  return context.__sw;
}

/** 読み込み時に走る非同期の初期化（状態復元・クリーンアップ）が終わるまで待つ */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

/**
 * DOMモードのコメント1件。publishedAt はトップレベル（APIモードは snippet 配下）
 * @param {object} [extra] role や avatarUrl など、個別に上書きしたいフィールド
 */
const domComment = (index, timestamp = Date.now(), extra = {}) => ({
  id: `dom_${index}`,
  role: 'normal',
  displayName: `ユーザー${index}`,
  message: `テストコメント${index}`,
  publishedAt: new Date(timestamp).toISOString(),
  ...extra
});

/** live_chat iframe から届くメッセージの sender を模す */
const senderFor = (tabId, videoId) => ({
  tab: { id: tabId, url: `https://www.youtube.com/watch?v=${videoId}` },
  url: `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`
});

module.exports = { createChromeMock, loadServiceWorker, settle, domComment, senderFor };
