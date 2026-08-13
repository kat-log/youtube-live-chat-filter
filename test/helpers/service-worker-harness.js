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

const SW_PATH = path.join(__dirname, '..', '..', 'src', 'background', 'service-worker.js');

/**
 * chrome API のモックを作る。
 * @param {object}  [options]
 * @param {number}  [options.quotaBytes] storage.local の容量上限（超えると set() が reject）
 * @param {object}  [options.tabs]       tabId をキーにしたタブ情報（chrome.tabs.get が返す）
 */
function createChromeMock({ quotaBytes = Infinity, tabs = {} } = {}) {
  const store = {};
  const calls = { badge: [], executeScript: [], tabMessages: [], runtimeMessages: [] };

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
      getManifest: () => ({ version: 'test', content_scripts: [] }),
      onMessage: { addListener: fn => { chrome.__onMessage = fn; } },
      onInstalled: { addListener: fn => { chrome.__onInstalled = fn; } },
      onStartup: { addListener: () => {} },
      onSuspend: { addListener: () => {} },
      onSuspendCanceled: { addListener: () => {} },
      async sendMessage(message) { calls.runtimeMessages.push(message); }
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      async query() { return []; },
      async get(tabId) {
        if (!(tabId in tabs)) throw new Error(`No tab with id: ${tabId}`);
        return tabs[tabId];
      },
      async sendMessage(tabId, message) { calls.tabMessages.push({ tabId, message }); }
    },
    scripting: {
      async executeScript(options) { calls.executeScript.push(options); return []; }
    },
    action: {
      setBadgeText: ({ text }) => calls.badge.push(text),
      setBadgeBackgroundColor: () => {}
    }
  };

  return { chrome, store, calls };
}

/**
 * service-worker.js を評価し、内部の関数・状態を返す。
 * monitoringState は startDomMonitoring などで丸ごと再代入されるため、
 * 常に最新を見られるよう getter 経由で露出する。
 */
function loadServiceWorker(chrome) {
  const source = fs.readFileSync(SW_PATH, 'utf8');
  const expose = `
    ;globalThis.__sw = {
      get monitoringState() { return monitoringState; },
      setState: (patch) => Object.assign(monitoringState, patch),
      cleanupOldCommentHistories,
      handleDomChatMessages,
      startDomMonitoring,
      stopBackgroundMonitoring,
      saveCommentsHistory,
      getCommentsHistory,
      getDiagnosticsInfo,
      extractVideoIdFromUrl,
      latestTimestampOf,
      safeStorageSet,
      MAX_COMMENTS_PER_VIDEO,
      MAX_HISTORY_VIDEOS
    };`;

  const context = vm.createContext({
    chrome, console, setTimeout, clearTimeout, Date, structuredClone, URL,
    fetch: async () => { throw new Error('network access is not available in tests'); }
  });

  vm.runInContext(source + expose, context);
  return context.__sw;
}

/** 読み込み時に走る非同期の初期化（状態復元・クリーンアップ）が終わるまで待つ */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

/** DOMモードのコメント1件。publishedAt はトップレベル（APIモードは snippet 配下） */
const domComment = (index, timestamp = Date.now()) => ({
  id: `dom_${index}`,
  role: 'normal',
  displayName: `ユーザー${index}`,
  message: `テストコメント${index}`,
  publishedAt: new Date(timestamp).toISOString()
});

/** live_chat iframe から届くメッセージの sender を模す */
const senderFor = (tabId, videoId) => ({
  tab: { id: tabId, url: `https://www.youtube.com/watch?v=${videoId}` },
  url: `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`
});

module.exports = { createChromeMock, loadServiceWorker, settle, domComment, senderFor };
