// デバッグモードによる統一ログ関数
let debugMode = false;

// デバッグモード設定を取得
async function loadDebugMode() {
  try {
    const result = await chrome.storage.local.get(['debugMode']);
    debugMode = result.debugMode || false;
  } catch (error) {
    // ここだけは常に表示（設定読み込み失敗は重要）
    console.error('[Background] Failed to load debug mode:', error);
  }
}

// デバッグ用ログ関数
function debugLog(prefix, ...args) {
  if (debugMode) {
    console.log(prefix, ...args);
  }
}

function debugWarn(prefix, ...args) {
  if (debugMode) {
    console.warn(prefix, ...args);
  }
}

function debugError(prefix, ...args) {
  if (debugMode) {
    console.error(prefix, ...args);
  }
}

// 初期化時にデバッグモードを読み込み
loadDebugMode();

// エラー解決データベース
const ERROR_SOLUTIONS = {
  // APIキー関連エラー
  'API key not valid': {
    title: 'APIキーが無効です',
    message: 'YouTube Data API v3のAPIキーが正しくありません',
    solution: 'Google Cloud ConsoleでAPIキーを確認し、YouTube Data API v3が有効になっていることを確認してください',
    action: 'checkApiKey',
    severity: 'high'
  },
  'API key not found': {
    title: 'APIキーが設定されていません',
    message: 'YouTube Data API v3のAPIキーが設定されていません',
    solution: 'オプション画面を開いてAPIキーを設定してください',
    action: 'setApiKey',
    severity: 'high'
  },
  
  // YouTube API制限エラー
  'quotaExceeded': {
    title: 'API使用量制限に達しました',
    message: '1日のYouTube Data API使用量制限に達しました（1日10,000リクエスト制限）',
    solution: '明日の00:00（太平洋標準時）にリセットされます。今すぐ使いたい場合はGoogle Cloud Consoleで制限を増やしてください',
    action: 'waitOrUpgrade',
    severity: 'medium'
  },
  'exceeded your quota': {
    title: 'API使用量制限に達しました', 
    message: '1日のYouTube Data API使用量制限に達しました（1日10,000リクエスト制限）',
    solution: '明日の00:00（太平洋標準時）にリセットされます。今すぐ使いたい場合はGoogle Cloud Consoleで制限を増やしてください',
    action: 'waitOrUpgrade',
    severity: 'medium'
  },
  'rateLimitExceeded': {
    title: 'アクセス頻度制限です',
    message: 'APIへのアクセスが頻繁すぎます',
    solution: '1分待ってから再試行してください',
    action: 'waitAndRetry',
    severity: 'low'
  },
  
  // ライブストリーム関連エラー
  'liveChatDisabled': {
    title: 'ライブチャットが無効です',
    message: 'この配信はライブチャット機能が無効になっています',
    solution: '配信者がライブチャットを有効にするまでお待ちください',
    action: 'waitForChat',
    severity: 'medium'
  },
  'liveChatNotFound': {
    title: 'ライブチャットが見つかりません',
    message: 'ライブチャットが存在しないか、配信が終了している可能性があります',
    solution: 'ライブ配信中のページで再試行してください',
    action: 'checkLiveStatus',
    severity: 'medium'
  },
  'videoNotLive': {
    title: 'ライブ配信中ではありません',
    message: 'この動画は現在ライブ配信中ではありません',
    solution: 'ライブ配信中の動画でのみ使用できます',
    action: 'findLiveStream',
    severity: 'medium'
  },
  
  // ネットワーク・認証エラー
  'NetworkError': {
    title: 'ネットワークエラー',
    message: 'インターネット接続に問題があります',
    solution: 'インターネット接続を確認してから再試行してください',
    action: 'checkConnection',
    severity: 'high'
  },
  'Forbidden': {
    title: 'アクセス権限エラー',
    message: 'APIキーに適切な権限がありません',
    solution: 'Google Cloud ConsoleでAPIキーの権限とYouTube Data API v3の有効化を確認してください',
    action: 'checkPermissions',
    severity: 'high'
  }
};

// HTMLタグ除去とエラーメッセージ改善ユーティリティ
function stripHtmlTags(html) {
  if (!html) return '';
  // Service Workerではdocumentが使えないため、正規表現で処理
  return html.replace(/<[^>]*>/g, '').trim();
}

function improveErrorMessage(originalMessage) {
  const cleanMessage = stripHtmlTags(originalMessage);
  
  // よくあるYouTube API エラーの日本語化
  const errorMappings = {
    'exceeded your quota': 'API使用量制限に達しました',
    'quotaExceeded': 'API使用量制限に達しました', 
    'rateLimitExceeded': 'アクセス頻度制限に達しました',
    'API key not valid': 'APIキーが無効です',
    'Access denied': 'アクセスが拒否されました',
    'Forbidden': 'アクセス権限がありません',
    'Bad Request': 'リクエストが無効です',
    'liveChatDisabled': 'ライブチャットが無効です',
    'liveChatNotFound': 'ライブチャットが見つかりません',
    'videoNotLive': 'ライブ配信中ではありません'
  };
  
  // エラーメッセージから該当するパターンを検索
  for (const [pattern, japanese] of Object.entries(errorMappings)) {
    if (cleanMessage.toLowerCase().includes(pattern.toLowerCase())) {
      return japanese;
    }
  }
  
  return cleanMessage;
}

// エラー分析と解決策提案機能
function analyzeError(error) {
  const rawErrorMessage = error.message || error.toString();
  const cleanErrorMessage = improveErrorMessage(rawErrorMessage);
  
  debugLog('[Background] Analyzing error:', rawErrorMessage);
  debugLog('[Background] Cleaned error:', cleanErrorMessage);
  
  // クリーンアップされたメッセージでパターンマッチング（大文字小文字を区別しない）
  for (const [pattern, solution] of Object.entries(ERROR_SOLUTIONS)) {
    const lowerPattern = pattern.toLowerCase();
    const lowerRawMessage = rawErrorMessage.toLowerCase();
    const lowerCleanMessage = cleanErrorMessage.toLowerCase();
    
    if (lowerRawMessage.includes(lowerPattern) || lowerCleanMessage.includes(lowerPattern)) {
      debugLog('[Background] Found matching error pattern:', pattern);
      return {
        ...solution,
        message: solution.message, // ERROR_SOLUTIONSで定義されたメッセージを使用
        originalError: rawErrorMessage,
        pattern: pattern
      };
    }
  }
  
  // マッチするパターンが見つからない場合のデフォルト
  return {
    title: '接続エラーが発生しました',
    message: cleanErrorMessage || 'サーバーとの通信に問題が発生しました',
    solution: 'インターネット接続を確認してから再試行してください。問題が続く場合は、APIキーの設定を確認してください',
    action: 'checkConnection',
    severity: 'medium',
    originalError: rawErrorMessage,
    pattern: 'unknown'
  };
}

// グローバル状態管理
let monitoringState = {
  isMonitoring: false,
  liveChatId: null,
  pageToken: null,
  tabId: null,
  pollingInterval: null,
  processedMessageIds: new Set(),
  commentFilters: {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true
  },
  commentsHistory: [], // 現在監視中のVideo IDの履歴
  avatarsByAuthor: {},  // { [displayName]: アバターURL } DOMモード用
  currentVideoId: null,
  chatMode: null // 'api' | 'dom' — ストレージから復元するまで不定
};

// === ストレージ肥大化対策 ==================================================
// storage.local は unlimitedStorage 無しだと10MB上限で、超えるとset()がrejectする。
// 上限に達すると監視開始処理ごと巻き添えで失敗するため、保持量を抑えたうえで
// 書き込み失敗を必ずハンドリングする。
const HISTORY_KEY_PREFIX = 'commentsHistory_';
const HISTORY_META_KEY = 'commentsHistoryMeta'; // { [videoId]: 最終更新時刻(ms) }
const MAX_COMMENTS_PER_VIDEO = 2000;
const MAX_HISTORY_VIDEOS = 5;
// アバターURLは発言者ごとに1つだけ持つ。コメント件数に比例させると
// 同じURLを何百回も保存することになり、履歴の肥大化を招くため。
const AVATAR_KEY_PREFIX = 'commentAvatars_';
const MAX_AVATARS_PER_VIDEO = 500;
// 履歴から重複判定用IDへ引き継ぐ件数。processedMessageIds の上限（1000件で
// 半分に間引く）に合わせてあり、これより多く積んでもすぐ捨てられる
const MAX_RESTORED_PROCESSED_IDS = 500;

// 新着コメントからアバターURLを取り出してマップへ入れ、追加分だけを返す。
// URLはコメント側から落とすので、履歴の1件あたりのサイズは変わらない。
function collectAvatars(messages) {
  const delta = {};
  for (const msg of messages) {
    const url = msg.avatarUrl;
    delete msg.avatarUrl;
    if (!url || !msg.displayName) continue;
    if (monitoringState.avatarsByAuthor[msg.displayName] === url) continue;
    monitoringState.avatarsByAuthor[msg.displayName] = url;
    delta[msg.displayName] = url;
  }

  // 上限超過分は古い方（挿入順が先）から捨てる
  const names = Object.keys(monitoringState.avatarsByAuthor);
  if (names.length > MAX_AVATARS_PER_VIDEO) {
    for (const name of names.slice(0, names.length - MAX_AVATARS_PER_VIDEO)) {
      delete monitoringState.avatarsByAuthor[name];
    }
  }

  return delta;
}

async function loadAvatars(videoId) {
  if (!videoId) return {};
  try {
    const key = `${AVATAR_KEY_PREFIX}${videoId}`;
    const result = await chrome.storage.local.get([key]);
    return result[key] || {};
  } catch (error) {
    debugError('[Background] Failed to load avatars:', error);
    return {};
  }
}

function isQuotaError(error) {
  const message = (error?.message || String(error || '')).toLowerCase();
  return message.includes('quota') || message.includes('exceeded');
}

let lastQuotaNotifyAt = 0;

function notifyStorageQuotaError() {
  // 連続保存でエラー通知を撃ち続けないよう1分に1回に絞る
  if (Date.now() - lastQuotaNotifyAt < 60000) return;
  lastQuotaNotifyAt = Date.now();
  notifyPopupOfError({
    title: '保存領域の上限に達しました',
    message: 'コメント履歴の保存に失敗しています',
    solution: '古い履歴の自動削除を試みました。改善しない場合は履歴をクリアしてください',
    action: 'clearHistory',
    severity: 'medium',
    originalError: 'storage quota exceeded',
    pattern: 'storageQuota'
  });
}

// storage.local への書き込み。失敗しても例外を投げず結果を返す
// （呼び出し側の後続処理＝バッジ更新やスクリプト注入を止めないため）
async function safeStorageSet(items) {
  try {
    await chrome.storage.local.set(items);
    return { ok: true };
  } catch (error) {
    debugError('[Background] storage.set failed:', error);

    if (isQuotaError(error) && await emergencyCleanup()) {
      try {
        await chrome.storage.local.set(items);
        debugLog('[Background] storage.set recovered after emergency cleanup');
        return { ok: true, recovered: true };
      } catch (retryError) {
        debugError('[Background] storage.set failed again after cleanup:', retryError);
      }
    }

    if (isQuotaError(error)) notifyStorageQuotaError();
    return { ok: false, error };
  }
}

// 容量超過時の緊急退避：監視中の動画以外の履歴を捨て、手元の履歴も半分に切り詰める
async function emergencyCleanup() {
  try {
    const keys = await listHistoryKeys();
    const protectedKey = monitoringState.currentVideoId
      ? `${HISTORY_KEY_PREFIX}${monitoringState.currentVideoId}`
      : null;
    const keysToRemove = keys.filter(key => key !== protectedKey);

    if (keysToRemove.length > 0) {
      const avatarKeysToRemove = keysToRemove.map(
        key => `${AVATAR_KEY_PREFIX}${key.slice(HISTORY_KEY_PREFIX.length)}`);
      await chrome.storage.local.remove([...keysToRemove, ...avatarKeysToRemove]);
      debugLog('[Background] 🚨 Emergency cleanup removed', keysToRemove.length, 'histories');
    }

    if (monitoringState.commentsHistory.length > 500) {
      monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-500);
      debugLog('[Background] 🚨 Emergency cleanup trimmed in-memory history to 500');
      return true;
    }

    return keysToRemove.length > 0;
  } catch (error) {
    debugError('[Background] Emergency cleanup failed:', error);
    return false;
  }
}

// 履歴キーの一覧。getKeys()が使える環境では全件読み込みを避ける
async function listHistoryKeys() {
  try {
    if (typeof chrome.storage.local.getKeys === 'function') {
      const keys = await chrome.storage.local.getKeys();
      return keys.filter(key => key.startsWith(HISTORY_KEY_PREFIX));
    }
  } catch (error) {
    debugWarn('[Background] storage.getKeys() unavailable, falling back:', error.message);
  }
  const all = await chrome.storage.local.get();
  return Object.keys(all).filter(key => key.startsWith(HISTORY_KEY_PREFIX));
}

// 履歴の最終コメント時刻。DOMモードはトップレベル、APIモードはsnippet配下にある
function latestTimestampOf(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const raw = history[i]?.publishedAt || history[i]?.snippet?.publishedAt;
    const time = raw ? new Date(raw).getTime() : 0;
    if (time) return time;
  }
  return 0;
}

let lastMetaTouch = { videoId: null, at: 0 };

async function touchHistoryMeta(videoId) {
  // 保存のたびに読み書きすると無駄なので、同じ動画は1分に1回だけ更新する
  if (lastMetaTouch.videoId === videoId && Date.now() - lastMetaTouch.at < 60000) return;

  try {
    const result = await chrome.storage.local.get([HISTORY_META_KEY]);
    const meta = result[HISTORY_META_KEY] || {};
    meta[videoId] = Date.now();
    await chrome.storage.local.set({ [HISTORY_META_KEY]: meta });
    lastMetaTouch = { videoId, at: Date.now() };
  } catch (error) {
    debugError('[Background] Failed to update history meta:', error);
  }
}

// URLからVideo IDを抽出（watch / live / live_chat のいずれにも対応）
function extractVideoIdFromUrl(url) {
  if (!url) return null;
  const queryMatch = url.match(/[?&]v=([^&#]+)/);
  if (queryMatch) return queryMatch[1];
  const liveMatch = url.match(/youtube\.com\/live\/([^/?&#]+)/);
  if (liveMatch) return liveMatch[1];
  return null;
}

// コメント履歴をストレージに保存（Video ID別）
async function saveCommentsHistory(videoId = null) {
  const targetVideoId = videoId || monitoringState.currentVideoId;
  if (!targetVideoId) {
    debugWarn('[Background] No video ID available for saving comments');
    return;
  }

  if (monitoringState.commentsHistory.length > MAX_COMMENTS_PER_VIDEO) {
    monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-MAX_COMMENTS_PER_VIDEO);
  }

  const commentsToSave = monitoringState.commentsHistory || [];
  const storageKey = `${HISTORY_KEY_PREFIX}${targetVideoId}`;

  // 空配列を書くと中身の無い履歴キーが残り、保持枠を無駄に消費する
  if (commentsToSave.length === 0) {
    debugLog('[Background] Nothing to save for video', targetVideoId);
    return;
  }

  const result = await safeStorageSet({ [storageKey]: commentsToSave });
  if (!result.ok) {
    debugError('[Background] Failed to save comments history for', targetVideoId);
    return;
  }

  // アバターは履歴とは別キー。書き込みに失敗してもコメント本体は残す
  const avatars = monitoringState.avatarsByAuthor || {};
  if (Object.keys(avatars).length > 0) {
    await safeStorageSet({ [`${AVATAR_KEY_PREFIX}${targetVideoId}`]: avatars });
  }

  await touchHistoryMeta(targetVideoId);
  debugLog('[Background] Saved', commentsToSave.length, 'comments for video', targetVideoId);
}

// 保存のデバウンス（活発なチャットで毎バッチ書き込むと重いため）
let pendingSaveTimer = null;

function scheduleSaveCommentsHistory(delayMs = 500) {
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    saveCommentsHistory();
  }, delayMs);
}

function flushCommentsHistory() {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  return saveCommentsHistory();
}

// === Service Worker 復帰時の状態復元 =========================================
// MV3のService Workerは約30秒のアイドルで終了し、メモリ上のmonitoringStateが失われる。
// 復帰後の最初のイベントでstorageから復元しないと、DOMモードでは
// handleDomChatMessagesのガードに阻まれて以降のコメントが永久に捨てられる。
let stateRestorePromise = null;

function ensureStateRestored() {
  if (!stateRestorePromise) {
    stateRestorePromise = restoreStateFromStorage();
  }
  return stateRestorePromise;
}

// 保存済みセッションがもう有効でない理由を返す（有効ならnull）。
// ブラウザ終了などでisMonitoring:trueのまま残った状態を引きずると、
// 別配信のコメントを古い動画の履歴に積んでしまう。
async function getStaleSessionReason(saved) {
  if (saved.tabId === null || saved.tabId === undefined) return 'タブ情報なし';

  let tab;
  try {
    tab = await chrome.tabs.get(saved.tabId);
  } catch (error) {
    return 'タブが存在しない';
  }

  if (!tab?.url) return null; // URLが読めないときは判断を保留して継続

  if (saved.videoId) {
    const currentVideoId = extractVideoIdFromUrl(tab.url);
    if (currentVideoId && currentVideoId !== saved.videoId) {
      return `動画が変わっている (${saved.videoId} -> ${currentVideoId})`;
    }
  }

  return null;
}

async function discardStaleSession(reason) {
  debugLog('[Background] 🧹 Discarding stale monitoring session:', reason);
  monitoringState.isMonitoring = false;
  monitoringState.liveChatId = null;
  monitoringState.tabId = null;
  updateBadge(false);
  await safeStorageSet({
    monitoringState: { isMonitoring: false, liveChatId: null, tabId: null }
  });
}

async function restoreStateFromStorage() {
  try {
    const result = await chrome.storage.local.get(['monitoringState', 'commentFilters']);
    const saved = result.monitoringState;

    if (result.commentFilters) {
      monitoringState.commentFilters = result.commentFilters;
    }

    if (!saved || !saved.isMonitoring) {
      debugLog('[Background] No active monitoring state to restore');
      return;
    }

    const staleReason = await getStaleSessionReason(saved);
    if (staleReason) {
      await discardStaleSession(staleReason);
      return;
    }

    monitoringState.isMonitoring = true;
    monitoringState.liveChatId = saved.liveChatId || null;
    monitoringState.tabId = saved.tabId ?? null;
    monitoringState.currentVideoId = saved.videoId || null;
    // 旧バージョンが保存した状態にはchatModeが無いため、liveChatIdの有無で推定する
    monitoringState.chatMode = saved.chatMode || (saved.liveChatId ? 'api' : 'dom');

    if (monitoringState.currentVideoId) {
      const storageKey = `${HISTORY_KEY_PREFIX}${monitoringState.currentVideoId}`;
      const historyResult = await chrome.storage.local.get([storageKey]);
      monitoringState.commentsHistory = historyResult[storageKey] || [];
      monitoringState.avatarsByAuthor = await loadAvatars(monitoringState.currentVideoId);

      // 復元した履歴のIDを重複判定に反映（復帰直後の再送を弾く）
      for (const comment of monitoringState.commentsHistory.slice(-MAX_RESTORED_PROCESSED_IDS)) {
        if (comment?.id) monitoringState.processedMessageIds.add(comment.id);
      }
    }

    debugLog('[Background] ♻️ Restored monitoring state after service worker wake-up:', {
      chatMode: monitoringState.chatMode,
      videoId: monitoringState.currentVideoId,
      tabId: monitoringState.tabId,
      comments: monitoringState.commentsHistory.length
    });

    updateBadge(true);

    // APIモードはポーリングも止まっているので再開する
    if (monitoringState.chatMode === 'api' && monitoringState.liveChatId) {
      startPollingLoop();
    }
  } catch (error) {
    debugError('[Background] Failed to restore monitoring state:', error);
  }
}

// Service Worker起動時の初期化
async function initializeServiceWorker() {
  debugLog('[Background] Initializing Service Worker');
  
  try {
    // 旧バージョンが使っていた単一キーの履歴は参照されないまま容量を食うので削除する
    const oldResult = await chrome.storage.local.get(['commentsHistory']);
    if (oldResult.commentsHistory) {
      debugLog('[Background] Removing legacy commentsHistory key');
      await chrome.storage.local.remove('commentsHistory');
    }

    // クリーンアップは監視中の動画を守るため、状態復元を待ってから実行する
    await ensureStateRestored();
    await cleanupOldCommentHistories();

  } catch (error) {
    debugError('[Background] Error initializing service worker:', error);
  }
}

// Service Worker起動時に初期化を実行
initializeServiceWorker();

// Service Workerが終了から復帰した直後に監視状態を復元する
ensureStateRestored();

// タブ監視機能を設定
setupTabMonitoring();

chrome.runtime.onInstalled.addListener(async (details) => {
  debugLog('[Background] YouTube Special Comments Filter installed/updated, reason:', details.reason);
  
  // 自動Content Script再注入を実行
  await reinjectContentScripts(details.reason);
  
  // インストール時に監視状態をリセット（履歴は保持）
  // 起動直後のensureStateRestored()が古い状態を復元している可能性があるため、
  // メモリ側も併せてリセットする
  monitoringState.isMonitoring = false;
  monitoringState.liveChatId = null;
  monitoringState.tabId = null;
  monitoringState.commentsHistory = [];
  monitoringState.avatarsByAuthor = {};
  // currentVideoIdも消しておかないと、空になった履歴が保存され
  // ストレージ上の履歴を上書きしてしまう
  monitoringState.currentVideoId = null;
  updateBadge(false);

  await safeStorageSet({
    monitoringState: {
      isMonitoring: false,
      liveChatId: null,
      tabId: null
    }
  });

  // 旧バージョンで肥大化したストレージを更新時に整理する
  await cleanupOldCommentHistories();
});

// Content Scriptが生きているかをpingで確認する
async function isContentScriptAlive(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return !!response;
  } catch (e) {
    return false;
  }
}

// Content Script自動再注入機能
// targetTabId を渡すとそのタブだけを対象にする（popupからの修復要求など）
async function reinjectContentScripts(reason, targetTabId = null) {
  debugLog('[Background] 🔄 Starting content script re-injection for reason:', reason,
           targetTabId !== null ? `(tab ${targetTabId} only)` : '(all matching tabs)');
  
  try {
    // manifest.jsonからcontent_scriptsを取得
    const manifest = chrome.runtime.getManifest();
    const contentScripts = manifest.content_scripts || [];
    
    if (contentScripts.length === 0) {
      debugWarn('[Background] No content scripts found in manifest');
      return;
    }
    
    let injectedTabsCount = 0;
    let totalTabsChecked = 0;
    
    for (const cs of contentScripts) {
      debugLog('[Background] Processing content script with matches:', cs.matches);
      
      // pingに応答するのはcontent-script.jsだけ。dom-chat.jsのエントリで
      // 生存確認すると、同じタブのcontent-script.jsが応答してしまい誤判定になる
      const canProbe = (cs.js || []).includes('content/content-script.js');
      
      // 対象URLにマッチするタブを取得
      let tabs = await chrome.tabs.query({ url: cs.matches });
      if (targetTabId !== null) {
        tabs = tabs.filter(tab => tab.id === targetTabId);
      }
      totalTabsChecked += tabs.length;
      
      debugLog('[Background] Found', tabs.length, 'tabs matching', cs.matches);
      
      for (const tab of tabs) {
        try {
          // chrome:// や chrome-extension:// URLはスキップ
          if (tab.url.match(/(chrome|chrome-extension|chrome-devtools):\/\//gi)) {
            debugLog('[Background] Skipping system tab:', tab.url);
            continue;
          }
          
          // タブの読み込み状態を確認
          if (tab.status !== 'complete') {
            debugLog('[Background] Skipping incomplete tab:', tab.url);
            continue;
          }
          
          // 既にContent Scriptが動いているタブへの再注入は不要。
          // 注入側のガードでSyntaxErrorにはならないが、無駄な注入を避ける
          if (canProbe && await isContentScriptAlive(tab.id)) {
            debugLog('[Background] Skipping tab with live content script:', tab.id);
            continue;
          }
          
          const target = {
            tabId: tab.id,
            allFrames: cs.all_frames || false
          };
          
          // JavaScriptファイルを注入
          if (cs.js && cs.js.length > 0) {
            debugLog('[Background] Injecting JS files into tab:', tab.id, 'URL:', tab.url);
            await chrome.scripting.executeScript({
              files: cs.js,
              target,
              injectImmediately: cs.run_at === 'document_start',
              world: cs.world || 'ISOLATED'
            });
            debugLog('[Background] ✅ Successfully injected JS files into tab:', tab.id);
          }
          
          // CSSファイルを注入
          if (cs.css && cs.css.length > 0) {
            debugLog('[Background] Injecting CSS files into tab:', tab.id);
            await chrome.scripting.insertCSS({
              files: cs.css,
              target,
              origin: cs.origin || 'AUTHOR'
            });
            debugLog('[Background] ✅ Successfully injected CSS files into tab:', tab.id);
          }
          
          injectedTabsCount++;
          
          // 小さな遅延を入れて負荷を分散
          await new Promise(resolve => setTimeout(resolve, 50));
          
        } catch (error) {
          debugWarn('[Background] ⚠️ Failed to inject into tab', tab.id, ':', error.message);
          
          // 権限エラーの場合はログに記録
          if (error.message.includes('Cannot access contents')) {
            debugLog('[Background] Permission denied for tab:', tab.url);
          }
        }
      }
    }
    
    debugLog('[Background] ✅ Content script re-injection completed');
    debugLog(`[Background] 📊 Stats: ${injectedTabsCount} successful injections out of ${totalTabsChecked} tabs`);
    
    // 注入結果をストレージに保存（診断用）
    await chrome.storage.local.set({
      lastInjectionResult: {
        timestamp: Date.now(),
        reason,
        injectedTabs: injectedTabsCount,
        totalTabs: totalTabsChecked,
        success: true
      }
    });
    
  } catch (error) {
    debugError('[Background] ❌ Content script re-injection failed:', error);
    
    // エラー情報をストレージに保存
    await chrome.storage.local.set({
      lastInjectionResult: {
        timestamp: Date.now(),
        reason,
        error: error.message,
        success: false
      }
    });
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  debugLog('[Background] Received message:', request.action);
  
  // Service Worker生存確認用のping
  if (request.action === 'ping') {
    sendResponse({ success: true, timestamp: Date.now() });
    return true;
  }
  
  // 診断情報を取得
  if (request.action === 'getDiagnostics') {
    getDiagnosticsInfo()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  // 手動Content Script再注入
  if (request.action === 'reinjectContentScripts') {
    reinjectContentScripts('manual', request.tabId ?? null)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  // 最後の注入結果を取得
  if (request.action === 'getLastInjectionResult') {
    chrome.storage.local.get(['lastInjectionResult'], (result) => {
      sendResponse(result.lastInjectionResult || null);
    });
    return true;
  }
  
  if (request.action === 'getApiKey') {
    chrome.storage.local.get(['youtubeApiKey'], (result) => {
      sendResponse({ apiKey: result.youtubeApiKey });
    });
    return true;
  }
  
  if (request.action === 'saveApiKey') {
    chrome.storage.local.set({ youtubeApiKey: request.apiKey }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (request.action === 'getDebugMode') {
    chrome.storage.local.get(['debugMode'], (result) => {
      sendResponse({ debugMode: result.debugMode || false });
    });
    return true;
  }
  
  if (request.action === 'saveDebugMode') {
    chrome.storage.local.set({ debugMode: request.debugMode }, () => {
      debugMode = request.debugMode; // グローバル変数も更新
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (request.action === 'getChatMode') {
    chrome.storage.local.get(['chatMode'], (result) => {
      sendResponse({ chatMode: result.chatMode || 'dom' });
    });
    return true;
  }

  if (request.action === 'getAutoStart') {
    chrome.storage.local.get(['autoStart'], (result) => {
      sendResponse({ autoStart: result.autoStart ?? true });
    });
    return true;
  }

  if (request.action === 'saveAutoStart') {
    chrome.storage.local.set({ autoStart: request.autoStart }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'fetchLiveChatMessages') {
    fetchLiveChatMessages(request.liveChatId, request.pageToken)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  // 新しいアクションを追加
  if (request.action === 'startBackgroundMonitoring') {
    startBackgroundMonitoring(request.liveChatId, sender.tab.id, request.videoId)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'stopBackgroundMonitoring') {
    stopBackgroundMonitoring()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getMonitoringState') {
    getMonitoringState()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  // popupからの新しいコメント通知をリレー
  if (request.action === 'newSpecialComments') {
    // すべてのpopupに通知を送信
    chrome.runtime.sendMessage(request).catch(() => {
      // popupが開いていない場合はエラーを無視
    });
    return true;
  }
  
  if (request.action === 'getLiveChatIdFromVideo') {
    getLiveChatIdFromVideo(request.videoId)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'setCommentFilters') {
    setCommentFilters(request.filters)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getCommentFilters') {
    getCommentFilters()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getCommentsHistory') {
    getCommentsHistory(request.videoId)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'clearCommentsHistory') {
    (async () => {
      const videoId = request.videoId || monitoringState.currentVideoId;
      if (videoId) {
        await chrome.storage.local.remove(`${HISTORY_KEY_PREFIX}${videoId}`);
        const metaResult = await chrome.storage.local.get([HISTORY_META_KEY]);
        const meta = metaResult[HISTORY_META_KEY] || {};
        if (videoId in meta) {
          delete meta[videoId];
          await safeStorageSet({ [HISTORY_META_KEY]: meta });
        }
        if (lastMetaTouch.videoId === videoId) lastMetaTouch = { videoId: null, at: 0 };
      }
      if (!request.videoId || request.videoId === monitoringState.currentVideoId) {
        monitoringState.commentsHistory = [];
      }
      sendResponse({ success: true });
    })().catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getMonitoringVideoId') {
    ensureStateRestored().then(() => {
      sendResponse({
        success: true,
        videoId: monitoringState.currentVideoId
      });
    });
    return true;
  }
  
  if (request.action === 'requestAutoStop') {
    autoStopMonitoring(request.reason || 'Content scriptからの要求')
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'startDomMonitoring') {
    startDomMonitoring(sender.tab?.id || request.tabId, request.videoId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === 'domChatMessages') {
    handleDomChatMessages(request.messages, sender)
      .catch(error => debugError('[Background] Error handling DOM chat messages:', error));
    sendResponse({ success: true });
    return true;
  }
});

async function fetchLiveChatMessages(liveChatId, pageToken = null) {
  try {
    const result = await chrome.storage.local.get(['youtubeApiKey']);
    const apiKey = result.youtubeApiKey;
    
    if (!apiKey) {
      throw new Error('API key not found. Please set your YouTube Data API key in the extension settings.');
    }
    
    const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
    url.searchParams.append('liveChatId', liveChatId);
    url.searchParams.append('part', 'snippet,authorDetails');
    url.searchParams.append('key', apiKey);
    
    if (pageToken) {
      url.searchParams.append('pageToken', pageToken);
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`YouTube API Error: ${errorData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    
    // コメントフィルターの状態を取得
    const filtersResult = await chrome.storage.local.get(['commentFilters']);
    const commentFilters = filtersResult.commentFilters || {
      owner: true,
      moderator: true,
      sponsor: true,
      normal: true
    };
    
    // 個別フィルターに基づいてコメントをフィルタリング
    const filteredComments = data.items.filter(item => {
      const authorDetails = item.authorDetails;
      
      if (authorDetails.isChatOwner) {
        return commentFilters.owner;
      } else if (authorDetails.isChatModerator) {
        return commentFilters.moderator;
      } else if (authorDetails.isChatSponsor) {
        return commentFilters.sponsor;
      } else {
        // 一般コメント
        return commentFilters.normal;
      }
    });
    
    debugLog('[Background] Individual filters applied:', {
      owner: commentFilters.owner,
      moderator: commentFilters.moderator, 
      sponsor: commentFilters.sponsor,
      normal: commentFilters.normal
    });
    debugLog('[Background] Returning', filteredComments.length, 'filtered comments out of', data.items.length, 'total');
    
    return {
      comments: filteredComments,
      nextPageToken: data.nextPageToken,
      pollingIntervalMillis: data.pollingIntervalMillis || 5000,
      commentFilters: commentFilters
    };
    
  } catch (error) {
    debugError('[Background] Error fetching live chat messages:', error);
    throw error;
  }
}

// アイコンバッジ更新
function updateBadge(isMonitoring) {
  if (isMonitoring) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00AA00' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Backgroundでの監視開始
async function startBackgroundMonitoring(liveChatId, tabId, videoId) {
  debugLog('[Background] Starting background monitoring for liveChatId:', liveChatId, 'videoId:', videoId);

  await ensureStateRestored();

  if (monitoringState.isMonitoring) {
    debugLog('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }
  
  // Video IDが変わった場合は新しい履歴を開始
  let existingHistory = [];
  if (videoId && videoId === monitoringState.currentVideoId) {
    // 同じVideo IDの場合は既存履歴を保持
    existingHistory = monitoringState.commentsHistory || [];
    debugLog('[Background] Same video ID, preserving', existingHistory.length, 'existing comments');
  } else if (videoId) {
    // 新しいVideo IDの場合は履歴をロード
    try {
      const storageKey = `${HISTORY_KEY_PREFIX}${videoId}`;
      const result = await chrome.storage.local.get([storageKey]);
      existingHistory = result[storageKey] || [];
      debugLog('[Background] Loaded', existingHistory.length, 'comments for video', videoId);
    } catch (error) {
      debugError('[Background] Failed to load existing history:', error);
    }
  }
  
  // 現在のフィルター設定を保持
  const currentFilters = monitoringState.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true
  };
  
  monitoringState = {
    isMonitoring: true,
    liveChatId: liveChatId,
    pageToken: null,
    tabId: tabId,
    pollingInterval: null,
    processedMessageIds: new Set(),
    commentFilters: currentFilters,
    commentsHistory: existingHistory,
    currentVideoId: videoId,
    chatMode: 'api'
  };

  debugLog('[Background] Monitoring state reset for video:', videoId, 'with', existingHistory.length, 'existing comments');

  // 状態を永続化（Service Worker終了後の復元に必要な情報をすべて含める）
  await safeStorageSet({
    monitoringState: {
      isMonitoring: true,
      liveChatId: liveChatId,
      tabId: tabId,
      videoId: videoId,
      chatMode: 'api'
    }
  });

  // 監視開始
  updateBadge(true);
  startPollingLoop();

  return { success: true };
}

// Backgroundでの監視停止
async function stopBackgroundMonitoring() {
  debugLog('[Background] Stopping background monitoring');

  await ensureStateRestored();

  monitoringState.isMonitoring = false;

  if (monitoringState.pollingInterval) {
    clearTimeout(monitoringState.pollingInterval);
    monitoringState.pollingInterval = null;
  }

  // 履歴を保存
  await flushCommentsHistory();

  // 状態を永続化
  await safeStorageSet({
    monitoringState: {
      isMonitoring: false,
      liveChatId: null,
      tabId: null
    }
  });

  updateBadge(false);

  return { success: true };
}

// 監視状態を取得
async function getMonitoringState() {
  await ensureStateRestored();

  const result = await chrome.storage.local.get(['monitoringState']);
  const savedState = result.monitoringState || { isMonitoring: false };
  
  debugLog('[Background] getMonitoringState - Memory:', {
    isMonitoring: monitoringState.isMonitoring,
    currentVideoId: monitoringState.currentVideoId,
    liveChatId: monitoringState.liveChatId,
    commentsCount: monitoringState.commentsHistory.length
  });
  debugLog('[Background] getMonitoringState - Storage:', savedState);
  
  return {
    success: true,
    isMonitoring: monitoringState.isMonitoring || savedState.isMonitoring,
    liveChatId: monitoringState.liveChatId || savedState.liveChatId,
    tabId: monitoringState.tabId || savedState.tabId,
    currentVideoId: monitoringState.currentVideoId,
    chatMode: monitoringState.chatMode || savedState.chatMode || null
  };
}

// ポーリングループ
function startPollingLoop() {
  if (!monitoringState.isMonitoring || !monitoringState.liveChatId) {
    return;
  }
  
  debugLog('[Background] Polling for new messages...');
  
  fetchLiveChatMessages(monitoringState.liveChatId, monitoringState.pageToken)
    .then(response => {
      if (!monitoringState.isMonitoring) {
        return; // 監視が停止された場合
      }
      
      if (response.comments && response.comments.length > 0) {
        // 重複をフィルタリング
        const newComments = response.comments.filter(comment => {
          const messageId = comment.id;
          if (monitoringState.processedMessageIds.has(messageId)) {
            debugLog('[Background] Duplicate comment filtered:', messageId);
            return false;
          }
          monitoringState.processedMessageIds.add(messageId);
          debugLog('[Background] New comment added:', messageId, comment.snippet.displayMessage.substring(0, 30));
          return true;
        });
        
        if (newComments.length > 0) {
          debugLog('[Background] Found', newComments.length, 'new special comments');
          
          // コメント履歴に追加
          monitoringState.commentsHistory.push(...newComments);
          
          // 履歴サイズを制限
          if (monitoringState.commentsHistory.length > MAX_COMMENTS_PER_VIDEO) {
            monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-MAX_COMMENTS_PER_VIDEO);
          }
          
          // 履歴を永続化（即座にかつ定期的に）
          scheduleSaveCommentsHistory();
          
          // popupに新しいコメントを通知
          chrome.runtime.sendMessage({
            action: 'newSpecialComments',
            comments: newComments
          }).catch(error => {
            debugLog('[Background] No popup to notify:', error.message);
          });
          
          // content scriptにも通知（あれば）
          if (monitoringState.tabId) {
            chrome.tabs.sendMessage(monitoringState.tabId, {
              action: 'newSpecialComments',
              comments: newComments
            }).catch(error => {
              debugLog('[Background] Content script not available:', error.message);
            });
          }
        }
      }
      
      monitoringState.pageToken = response.nextPageToken;
      
      // Setのサイズ制限（メモリ使用量制限）
      if (monitoringState.processedMessageIds.size > 1000) {
        const idsArray = Array.from(monitoringState.processedMessageIds);
        monitoringState.processedMessageIds = new Set(idsArray.slice(-500));
      }
      
      // 次のポーリングをスケジュール
      const pollingDelay = response.pollingIntervalMillis || 5000;
      monitoringState.pollingInterval = setTimeout(() => {
        startPollingLoop();
      }, pollingDelay);
      
    })
    .catch(error => {
      debugError('[Background] Error in polling loop:', error);
      
      // エラー分析と解決策提案
      const errorAnalysis = analyzeError(error);
      debugLog('[Background] Error analysis:', errorAnalysis);
      
      // リアルタイムでポップアップにエラー通知
      notifyPopupOfError(errorAnalysis);
      
      // API制限エラーの場合は長めの間隔でリトライ
      const retryDelay = error.message.includes('quota') || error.message.includes('limit') ? 60000 : 15000;
      
      // 監視中の場合のみリトライ
      if (monitoringState.isMonitoring) {
        debugLog(`[Background] Retrying in ${retryDelay/1000} seconds...`);
        monitoringState.pollingInterval = setTimeout(() => {
          startPollingLoop();
        }, retryDelay);
      }
    });
}

// DOM モードでの監視開始
async function startDomMonitoring(tabId, videoId) {
  debugLog('[Background] Starting DOM monitoring for videoId:', videoId, 'tabId:', tabId);

  await ensureStateRestored();

  // 同じ動画を同じタブで既にDOM監視中なら、状態とバッファを壊さずに継続する
  // （content script と popup の自動開始が競合しても取りこぼさないため）
  if (monitoringState.isMonitoring &&
      monitoringState.chatMode === 'dom' &&
      monitoringState.currentVideoId === videoId &&
      monitoringState.tabId === tabId) {
    debugLog('[Background] DOM monitoring already active for this video, reusing session');
    chrome.tabs.sendMessage(tabId, { action: 'requestInitialSweep', force: true }).catch(() => {});
    return { success: true };
  }

  if (monitoringState.isMonitoring) {
    debugLog('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }

  // Video ID が同じ場合は既存履歴を保持
  let existingHistory = [];
  let existingAvatars = {};
  if (videoId && videoId === monitoringState.currentVideoId) {
    existingHistory = monitoringState.commentsHistory || [];
    existingAvatars = monitoringState.avatarsByAuthor || {};
  } else if (videoId) {
    try {
      const storageKey = `${HISTORY_KEY_PREFIX}${videoId}`;
      const result = await chrome.storage.local.get([storageKey]);
      existingHistory = result[storageKey] || [];
    } catch (error) {
      debugError('[Background] Failed to load existing history:', error);
    }
    existingAvatars = await loadAvatars(videoId);
  }

  const currentFilters = monitoringState.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true
  };

  // 開始直後の全件スキャンには既に履歴にあるコメントも含まれるため、
  // 復元した履歴のIDを既読として引き継ぐ（restoreStateと同じ扱い）
  const processedMessageIds = new Set();
  for (const comment of existingHistory.slice(-MAX_RESTORED_PROCESSED_IDS)) {
    if (comment?.id) processedMessageIds.add(comment.id);
  }

  monitoringState = {
    isMonitoring: true,
    liveChatId: null,
    pageToken: null,
    tabId: tabId,
    pollingInterval: null,
    processedMessageIds,
    commentFilters: currentFilters,
    commentsHistory: existingHistory,
    avatarsByAuthor: existingAvatars,
    currentVideoId: videoId,
    chatMode: 'dom'
  };

  // 書き込みに失敗しても、以降のバッジ更新とdom-chat.js注入は必ず実行する
  // （ここで例外を投げると監視が始まらず「コメントが1件も来ない」状態になる）
  await safeStorageSet({
    monitoringState: {
      isMonitoring: true,
      liveChatId: null,
      tabId: tabId,
      videoId: videoId,
      chatMode: 'dom'
    }
  });

  updateBadge(true);

  // SPA遷移後はmanifestの自動注入が走らないため、明示的に注入する
  // window.__domChatInitialized ガードにより二重注入は無害
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ['content/dom-chat.js']
    });
    debugLog('[Background] dom-chat.js injected into tab:', tabId);
  } catch (e) {
    debugLog('[Background] dom-chat.js injection skipped:', e.message);
  }

  // 注入済みガードで再実行がスキップされた場合でも初期スキャンを確実に実行。
  // force を付けるのは、開始前に流れたコメントを dom-chat.js が送信済み扱いで
  // 抱えているため。全件送り直させ、既出分はここの processedMessageIds で弾く
  chrome.tabs.sendMessage(tabId, { action: 'requestInitialSweep', force: true }).catch(() => {});

  return { success: true };
}

// DOM モードのメッセージ処理
async function handleDomChatMessages(messages, sender = null) {
  // Service Worker終了から復帰した直後はmonitoringStateが初期値に戻っているため、
  // ガード判定の前に必ずstorageからの復元を待つ
  await ensureStateRestored();

  // 同じタブなのに監視対象の動画IDが食い違う場合は、復元した状態が古い。
  // そのまま処理すると別動画の履歴にコメントを積んでしまうのでセッションを張り直す
  const senderTabId = sender?.tab?.id ?? null;
  const senderVideoId = extractVideoIdFromUrl(sender?.url) ||
                        extractVideoIdFromUrl(sender?.tab?.url);

  if (monitoringState.isMonitoring &&
      monitoringState.chatMode === 'dom' &&
      senderVideoId && senderTabId !== null &&
      monitoringState.tabId === senderTabId &&
      monitoringState.currentVideoId !== senderVideoId) {
    debugLog('[Background] ♻️ Video changed under active DOM session:',
      monitoringState.currentVideoId, '->', senderVideoId);
    await startDomMonitoring(senderTabId, senderVideoId);
  }

  if (!monitoringState.isMonitoring || monitoringState.chatMode !== 'dom') {
    debugLog('[Background] Dropping DOM messages - not monitoring in DOM mode', {
      isMonitoring: monitoringState.isMonitoring,
      chatMode: monitoringState.chatMode
    });
    return;
  }

  const filters = monitoringState.commentFilters;
  const newMessages = messages.filter(msg => {
    if (monitoringState.processedMessageIds.has(msg.id)) return false;
    monitoringState.processedMessageIds.add(msg.id);
    if (msg.role === 'owner')     return filters.owner;
    if (msg.role === 'moderator') return filters.moderator;
    if (msg.role === 'member')    return filters.sponsor;
    return filters.normal;
  });

  if (!newMessages.length) return;

  // コメント本体に載せず、発言者ごとのマップへ移す
  const avatarDelta = collectAvatars(newMessages);

  monitoringState.commentsHistory.push(...newMessages);
  if (monitoringState.commentsHistory.length > MAX_COMMENTS_PER_VIDEO)
    monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-MAX_COMMENTS_PER_VIDEO);
  if (monitoringState.processedMessageIds.size > 1000) {
    const arr = Array.from(monitoringState.processedMessageIds);
    monitoringState.processedMessageIds = new Set(arr.slice(-500));
  }

  scheduleSaveCommentsHistory();

  chrome.runtime.sendMessage({
    action: 'newSpecialComments',
    comments: newMessages,
    avatars: avatarDelta
  }).catch(() => {});
  if (monitoringState.tabId) {
    chrome.tabs.sendMessage(monitoringState.tabId, {
      action: 'newSpecialComments',
      comments: newMessages,
      avatars: avatarDelta
    }).catch(() => {});
  }
}

// サービスワーカーのライフサイクル管理
chrome.runtime.onStartup.addListener(async () => {
  debugLog('[Background] Extension startup');
  // DOMモード（liveChatIdがnull）も含めて共通の復元処理に任せる
  await ensureStateRestored();
});

// タブが閉じられたときの処理
chrome.tabs.onRemoved.addListener((tabId) => {
  if (monitoringState.tabId === tabId) {
    debugLog('[Background] Tab closed, but continuing monitoring');
    // タブが閉じられても監視は継続
    monitoringState.tabId = null;
    // 履歴を保存
    flushCommentsHistory();
  }
});

// Service Worker停止前の処理
chrome.runtime.onSuspend.addListener(() => {
  debugLog('[Background] Service Worker suspending, saving state');
  // 履歴を確実に保存（デバウンス待ちの分も含めて即時書き込む）
  flushCommentsHistory();
});

// 拡張機能停止時の処理
chrome.runtime.onSuspendCanceled.addListener(() => {
  debugLog('[Background] Service Worker suspend canceled');
});

// Video IDからLive Chat IDを取得
async function getLiveChatIdFromVideo(videoId) {
  try {
    const result = await chrome.storage.local.get(['youtubeApiKey', 'chatMode']);
    const apiKey = result.youtubeApiKey;

    // DOMモードではAPIキー不要なのでスキップ
    if (!apiKey) {
      if (result.chatMode === 'dom' || monitoringState.chatMode === 'dom') {
        debugLog('[Background] DOM mode: skipping API key check for getLiveChatIdFromVideo');
        return { liveChatId: null };
      }
      throw new Error('API key not found');
    }
    
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.append('part', 'liveStreamingDetails');
    url.searchParams.append('id', videoId);
    url.searchParams.append('key', apiKey);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`YouTube API Error: ${errorData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.items && data.items.length > 0) {
      const video = data.items[0];
      debugLog('[Background] Video data:', { 
        id: video.id, 
        hasLiveStreamingDetails: !!video.liveStreamingDetails,
        liveStreamingDetails: video.liveStreamingDetails
      });
      
      const liveStreamingDetails = video.liveStreamingDetails;
      if (liveStreamingDetails && liveStreamingDetails.activeLiveChatId) {
        debugLog('[Background] Live chat ID found via API:', liveStreamingDetails.activeLiveChatId);
        return { liveChatId: liveStreamingDetails.activeLiveChatId };
      } else {
        debugLog('[Background] Video is not currently live streaming or has no active live chat');
      }
    } else {
      debugLog('[Background] No video data found for ID:', videoId);
    }
    
    return { liveChatId: null };
    
  } catch (error) {
    debugError('[Background] Error getting live chat ID from video:', error);
    
    // エラー分析して詳細情報をポップアップに送信
    const errorAnalysis = analyzeError(error);
    notifyPopupOfError(errorAnalysis);
    
    throw error;
  }
}

// ポップアップにエラー詳細を通知する機能
async function notifyPopupOfError(errorAnalysis) {
  try {
    await chrome.runtime.sendMessage({
      action: 'showDetailedError',
      errorInfo: errorAnalysis
    });
    debugLog('[Background] Error details sent to popup');
  } catch (error) {
    debugLog('[Background] Could not notify popup of error (popup not open)');
  }
}

// コメントフィルターを設定
async function setCommentFilters(filters) {
  debugLog('[Background] Setting comment filters:', filters);
  
  await chrome.storage.local.set({ commentFilters: filters });
  monitoringState.commentFilters = filters;
  
  return { success: true, filters: filters };
}

// コメントフィルターの状態を取得
async function getCommentFilters() {
  const result = await chrome.storage.local.get(['commentFilters']);
  const commentFilters = result.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true
  };
  
  return { success: true, filters: commentFilters };
}

// 古いコメント履歴をクリーンアップ
async function cleanupOldCommentHistories() {
  try {
    debugLog('[Background] Starting comments history cleanup');

    const historyKeys = await listHistoryKeys();
    const metaResult = await chrome.storage.local.get([HISTORY_META_KEY]);
    const meta = metaResult[HISTORY_META_KEY] || {};
    let metaChanged = false;

    debugLog('[Background] Found', historyKeys.length, 'comment history entries');

    // メタ情報が無いキー（旧バージョンが作った履歴）だけ実体を読んで補完し、
    // ついでに上限を超えている配列を切り詰める
    for (const key of historyKeys) {
      const videoId = key.slice(HISTORY_KEY_PREFIX.length);
      if (videoId in meta) continue;

      const stored = await chrome.storage.local.get([key]);
      const history = stored[key] || [];
      meta[videoId] = latestTimestampOf(history);
      metaChanged = true;

      if (history.length > MAX_COMMENTS_PER_VIDEO) {
        debugLog('[Background] Trimming oversized history:', key, history.length, '->', MAX_COMMENTS_PER_VIDEO);
        await safeStorageSet({ [key]: history.slice(-MAX_COMMENTS_PER_VIDEO) });
      }
    }

    // 実体が無くなったメタを掃除
    for (const videoId of Object.keys(meta)) {
      if (!historyKeys.includes(`${HISTORY_KEY_PREFIX}${videoId}`)) {
        delete meta[videoId];
        metaChanged = true;
      }
    }

    // 新しい順に MAX_HISTORY_VIDEOS 件だけ残す。
    // 監視中の動画はタイムスタンプに関わらず必ず保護する
    const protectedVideoId = monitoringState.currentVideoId;
    const sortedKeys = historyKeys.slice().sort((a, b) => {
      const aVideoId = a.slice(HISTORY_KEY_PREFIX.length);
      const bVideoId = b.slice(HISTORY_KEY_PREFIX.length);
      if (aVideoId === protectedVideoId) return -1;
      if (bVideoId === protectedVideoId) return 1;
      return (meta[bVideoId] || 0) - (meta[aVideoId] || 0);
    });

    const keysToRemove = sortedKeys.slice(MAX_HISTORY_VIDEOS);

    if (keysToRemove.length > 0) {
      // 履歴とアバターは対で消さないと、参照されないアバターだけが残り続ける
      const avatarKeysToRemove = keysToRemove.map(
        key => `${AVATAR_KEY_PREFIX}${key.slice(HISTORY_KEY_PREFIX.length)}`);
      await chrome.storage.local.remove([...keysToRemove, ...avatarKeysToRemove]);
      for (const key of keysToRemove) {
        delete meta[key.slice(HISTORY_KEY_PREFIX.length)];
        debugLog('[Background] Removed old history:', key);
      }
      metaChanged = true;
      debugLog('[Background] Cleanup completed, removed', keysToRemove.length, 'old histories');
    } else {
      debugLog('[Background] No cleanup needed, within limit');
    }

    if (metaChanged) {
      await safeStorageSet({ [HISTORY_META_KEY]: meta });
    }

  } catch (error) {
    debugError('[Background] Error during cleanup:', error);
  }
}

// コメント履歴を取得（Video ID別）
async function getCommentsHistory(videoId = null) {
  await ensureStateRestored();
  // デバウンス中の未保存分をストレージへ反映してから読み出す
  await flushCommentsHistory();

  const targetVideoId = videoId || monitoringState.currentVideoId;
  debugLog('[Background] === getCommentsHistory called ===');
  debugLog('[Background] Target video ID:', targetVideoId);
  debugLog('[Background] Current monitoring state:', {
    isMonitoring: monitoringState.isMonitoring,
    currentVideoId: monitoringState.currentVideoId,
    memoryCommentsCount: monitoringState.commentsHistory.length
  });
  
  if (!targetVideoId) {
    debugLog('[Background] No video ID provided, returning empty history');
    return { success: true, comments: [], avatars: {} };
  }
  
  try {
    const storageKey = `${HISTORY_KEY_PREFIX}${targetVideoId}`;
    
    // 現在監視中のVideo IDの場合は、メモリを優先してストレージをフォールバックとする
    if (targetVideoId === monitoringState.currentVideoId && monitoringState.isMonitoring) {
      debugLog('[Background] === Currently monitored video - using memory first ===');
      
      const memoryComments = monitoringState.commentsHistory || [];
      debugLog('[Background] Memory has', memoryComments.length, 'comments');
      
      if (memoryComments.length > 0) {
        // 直前のflushCommentsHistory()でストレージ同期済みなので、そのまま返す
        debugLog('[Background] Returning', memoryComments.length, 'comments from memory');
        return { success: true, comments: memoryComments, avatars: monitoringState.avatarsByAuthor };
      } else {
        // メモリが空の場合はストレージから復元を試行
        debugLog('[Background] Memory empty, checking storage for recovery');
        const result = await chrome.storage.local.get([storageKey]);
        const storageHistory = result[storageKey] || [];
        
        if (storageHistory.length > 0) {
          // ストレージから復元してメモリにも保存
          monitoringState.commentsHistory = storageHistory;
          debugLog('[Background] Recovered', storageHistory.length, 'comments from storage to memory');
          return { success: true, comments: storageHistory, avatars: monitoringState.avatarsByAuthor };
        } else {
          debugLog('[Background] No comments found in memory or storage for monitored video');
          return { success: true, comments: [], avatars: monitoringState.avatarsByAuthor };
        }
      }
    } else {
      // 別のVideo IDまたは監視停止中の場合は、ストレージから取得
      debugLog('[Background] === Non-monitored video or monitoring stopped - using storage ===');
      const result = await chrome.storage.local.get([storageKey]);
      const history = result[storageKey] || [];
      debugLog('[Background] Retrieved', history.length, 'comments for video', targetVideoId, 'from storage');
      return { success: true, comments: history, avatars: await loadAvatars(targetVideoId) };
    }
    
  } catch (error) {
    debugError('[Background] Error getting comments history:', error);
    return { success: true, comments: [], avatars: {} };
  }
}

// タブ監視機能の設定
function setupTabMonitoring() {
  debugLog('[Background] Setting up tab monitoring for auto-stop');
  
  // タブが閉じられた時
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (monitoringState.isMonitoring && monitoringState.tabId === tabId) {
      debugLog('[Background] YouTube tab was closed, auto-stopping monitoring');
      await autoStopMonitoring('YouTubeタブが閉じられました');
    }
  });
}

// 自動監視停止機能
async function autoStopMonitoring(reason) {
  debugLog('[Background] Auto-stopping monitoring:', reason);
  
  try {
    // 通常の監視停止処理を実行
    await stopBackgroundMonitoring();
    
    // 自動停止の理由をログに記録
    debugLog('[Background] Monitoring auto-stopped:', reason);
    
    // ポップアップが開いている場合に通知
    try {
      await chrome.runtime.sendMessage({
        action: 'monitoringAutoStopped',
        reason: reason
      });
    } catch (error) {
      // ポップアップが開いていない場合はエラーを無視
    }
    
    return { success: true, reason: reason };
  } catch (error) {
    debugError('[Background] Error during auto-stop:', error);
    return { success: false, error: error.message };
  }
}

// 診断情報取得機能
async function getDiagnosticsInfo() {
  debugLog('[Background] Generating diagnostics information');

  await ensureStateRestored();

  try {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      serviceWorker: {
        isActive: true,
        startTime: Date.now(),
        version: chrome.runtime.getManifest().version
      },
      monitoring: {
        isMonitoring: monitoringState.isMonitoring,
        liveChatId: monitoringState.liveChatId ? 'present' : 'missing',
        currentVideoId: monitoringState.currentVideoId || 'none',
        commentsCount: monitoringState.commentsHistory.length,
        tabId: monitoringState.tabId || 'none'
      },
      storage: {
        hasApiKey: false,
        commentFiltersCount: Object.keys(monitoringState.commentFilters).length
      },
      performance: {
        processedMessagesCount: monitoringState.processedMessageIds.size
      }
    };
    
    // APIキーの存在確認
    try {
      const storageResult = await chrome.storage.local.get(['youtubeApiKey']);
      diagnostics.storage.hasApiKey = !!(storageResult.youtubeApiKey);
    } catch (error) {
      debugError('[Background] Error checking API key:', error);
      diagnostics.storage.hasApiKey = 'error';
    }
    
    // ストレージ使用量確認（全件読み込みは重いのでバイト数とキー数だけ見る）
    try {
      const historyKeys = await listHistoryKeys();
      diagnostics.storage.historyEntriesCount = historyKeys.length;
      diagnostics.storage.bytesInUse = await chrome.storage.local.getBytesInUse(null);
    } catch (error) {
      debugError('[Background] Error checking storage:', error);
      diagnostics.storage.historyEntriesCount = 'error';
    }
    
    debugLog('[Background] Diagnostics generated:', diagnostics);
    return { success: true, diagnostics };
    
  } catch (error) {
    debugError('[Background] Error generating diagnostics:', error);
    return { 
      success: false, 
      error: error.message,
      basicInfo: {
        timestamp: new Date().toISOString(),
        serviceWorkerActive: true,
        monitoringState: monitoringState.isMonitoring
      }
    };
  }
}