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
  currentVideoId: null,
  chatMode: null // 'api' | 'dom' — ストレージから復元するまで不定
};

// コメント履歴をストレージに保存（Video ID別）
async function saveCommentsHistory(videoId = null) {
  try {
    const targetVideoId = videoId || monitoringState.currentVideoId;
    if (!targetVideoId) {
      debugWarn('[Background] No video ID available for saving comments');
      return;
    }
    
    const commentsToSave = monitoringState.commentsHistory || [];
    const storageKey = `commentsHistory_${targetVideoId}`;
    
    debugLog('[Background] === Saving comments history ===');
    debugLog('[Background] Video ID:', targetVideoId);
    debugLog('[Background] Comments count:', commentsToSave.length);
    
    await chrome.storage.local.set({
      [storageKey]: commentsToSave
    });
    
    // 保存確認のため、すぐに読み取りテストを実行
    const verification = await chrome.storage.local.get([storageKey]);
    const savedCount = verification[storageKey]?.length || 0;
    
    debugLog('[Background] Saved and verified', savedCount, 'comments for video', targetVideoId);
    
    if (savedCount !== commentsToSave.length) {
      debugError('[Background] Save verification failed! Expected:', commentsToSave.length, 'Actual:', savedCount);
    }
    
  } catch (error) {
    debugError('[Background] Failed to save comments history:', error);
  }
}

// Service Worker起動時の初期化
async function initializeServiceWorker() {
  debugLog('[Background] Initializing Service Worker');
  
  try {
    // 古い履歴形式から新しい形式へのマイグレーション
    const oldResult = await chrome.storage.local.get(['commentsHistory']);
    if (oldResult.commentsHistory && oldResult.commentsHistory.length > 0) {
      debugLog('[Background] Found old format history, migration may be needed');
    }
    
    // 定期的なクリーンアップを実行
    cleanupOldCommentHistories();
    
  } catch (error) {
    debugError('[Background] Error initializing service worker:', error);
  }
}

// Service Worker起動時に初期化を実行
initializeServiceWorker();

// タブ監視機能を設定
setupTabMonitoring();

chrome.runtime.onInstalled.addListener(async (details) => {
  debugLog('[Background] YouTube Special Comments Filter installed/updated, reason:', details.reason);
  
  // 自動Content Script再注入を実行
  await reinjectContentScripts(details.reason);
  
  // ストレージから既存の履歴を復元
  const result = await chrome.storage.local.get(['commentsHistory']);
  const existingHistory = result.commentsHistory || [];
  monitoringState.commentsHistory = existingHistory;
  
  debugLog('[Background] Restored', existingHistory.length, 'comments from storage on install');
  
  // インストール時に監視状態をリセット（履歴は保持）
  chrome.storage.local.set({
    monitoringState: {
      isMonitoring: false,
      liveChatId: null,
      tabId: null
    }
  });
});

// Content Script自動再注入機能
async function reinjectContentScripts(reason) {
  debugLog('[Background] 🔄 Starting content script re-injection for reason:', reason);
  
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
      
      // 対象URLにマッチするタブを取得
      const tabs = await chrome.tabs.query({ url: cs.matches });
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
    reinjectContentScripts('manual')
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
        const storageKey = `commentsHistory_${videoId}`;
        await chrome.storage.local.remove(storageKey);
      }
      if (!request.videoId || request.videoId === monitoringState.currentVideoId) {
        monitoringState.commentsHistory = [];
      }
      sendResponse({ success: true });
    })().catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getMonitoringVideoId') {
    sendResponse({ 
      success: true, 
      videoId: monitoringState.currentVideoId 
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
    handleDomChatMessages(request.messages);
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
      const storageKey = `commentsHistory_${videoId}`;
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
    currentVideoId: videoId
  };
  
  debugLog('[Background] Monitoring state reset for video:', videoId, 'with', existingHistory.length, 'existing comments');
  
  // 状態を永続化
  await chrome.storage.local.set({
    monitoringState: {
      isMonitoring: true,
      liveChatId: liveChatId,
      tabId: tabId,
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

  monitoringState.isMonitoring = false;

  if (monitoringState.pollingInterval) {
    clearTimeout(monitoringState.pollingInterval);
    monitoringState.pollingInterval = null;
  }
  
  // 履歴を保存
  await saveCommentsHistory();
  
  // 状態を永続化
  await chrome.storage.local.set({
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
          
          // 履歴サイズを制限（10000件まで）
          if (monitoringState.commentsHistory.length > 10000) {
            monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-10000);
          }
          
          // 履歴を永続化（即座にかつ定期的に）
          saveCommentsHistory();
          
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

  if (monitoringState.isMonitoring) {
    debugLog('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }

  // Video ID が同じ場合は既存履歴を保持
  let existingHistory = [];
  if (videoId && videoId === monitoringState.currentVideoId) {
    existingHistory = monitoringState.commentsHistory || [];
  } else if (videoId) {
    try {
      const storageKey = `commentsHistory_${videoId}`;
      const result = await chrome.storage.local.get([storageKey]);
      existingHistory = result[storageKey] || [];
    } catch (error) {
      debugError('[Background] Failed to load existing history:', error);
    }
  }

  const currentFilters = monitoringState.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true
  };

  monitoringState = {
    isMonitoring: true,
    liveChatId: null,
    pageToken: null,
    tabId: tabId,
    pollingInterval: null,
    processedMessageIds: new Set(),
    commentFilters: currentFilters,
    commentsHistory: existingHistory,
    currentVideoId: videoId,
    chatMode: 'dom'
  };

  await chrome.storage.local.set({
    monitoringState: {
      isMonitoring: true,
      liveChatId: null,
      tabId: tabId,
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

  return { success: true };
}

// DOM モードのメッセージ処理
function handleDomChatMessages(messages) {
  if (!monitoringState.isMonitoring || monitoringState.chatMode !== 'dom') return;

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

  monitoringState.commentsHistory.push(...newMessages);
  if (monitoringState.commentsHistory.length > 10000)
    monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-10000);
  if (monitoringState.processedMessageIds.size > 1000) {
    const arr = Array.from(monitoringState.processedMessageIds);
    monitoringState.processedMessageIds = new Set(arr.slice(-500));
  }

  saveCommentsHistory();

  chrome.runtime.sendMessage({ action: 'newSpecialComments', comments: newMessages }).catch(() => {});
  if (monitoringState.tabId) {
    chrome.tabs.sendMessage(monitoringState.tabId, {
      action: 'newSpecialComments',
      comments: newMessages
    }).catch(() => {});
  }
}

// サービスワーカーのライフサイクル管理
chrome.runtime.onStartup.addListener(async () => {
  debugLog('[Background] Extension startup');
  // 保存された状態を復元
  const result = await chrome.storage.local.get(['monitoringState', 'commentFilters']);
  const savedState = result.monitoringState;
  const savedFilters = result.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true
  };
  
  if (savedState && savedState.isMonitoring && savedState.liveChatId) {
    debugLog('[Background] Restoring monitoring state');
    
    // コメント履歴も復元
    const historyResult = await chrome.storage.local.get(['commentsHistory']);
    const commentsHistory = historyResult.commentsHistory || [];
    
    monitoringState = {
      isMonitoring: true,
      liveChatId: savedState.liveChatId,
      pageToken: null,
      tabId: savedState.tabId,
      pollingInterval: null,
      processedMessageIds: new Set(),
      commentFilters: savedFilters,
      commentsHistory: commentsHistory
    };
    debugLog('[Background] Restored', commentsHistory.length, 'comments from storage');
    debugLog('[Background] Restored comment filters:', savedFilters);
    updateBadge(true);
    startPollingLoop();
  } else {
    // 監視していない場合でもフィルター設定は復元
    monitoringState.commentFilters = savedFilters;
    debugLog('[Background] Restored comment filters:', savedFilters);
  }
});

// タブが閉じられたときの処理
chrome.tabs.onRemoved.addListener((tabId) => {
  if (monitoringState.tabId === tabId) {
    debugLog('[Background] Tab closed, but continuing monitoring');
    // タブが閉じられても監視は継続
    monitoringState.tabId = null;
    // 履歴を保存
    saveCommentsHistory();
  }
});

// Service Worker停止前の処理
chrome.runtime.onSuspend.addListener(() => {
  debugLog('[Background] Service Worker suspending, saving state');
  // 履歴を確実に保存
  saveCommentsHistory();
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
    
    // 全てのストレージキーを取得
    const allData = await chrome.storage.local.get();
    const historyKeys = Object.keys(allData).filter(key => key.startsWith('commentsHistory_'));
    
    debugLog('[Background] Found', historyKeys.length, 'comment history entries');
    
    // 現在の日付から7日前を計算
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    // 最大10個のVideo IDまで保持（最新のものから）
    const maxEntries = 10;
    
    if (historyKeys.length > maxEntries) {
      // 最新のものを保持し、古いものを削除
      const sortedKeys = historyKeys.sort((a, b) => {
        const aHistory = allData[a] || [];
        const bHistory = allData[b] || [];
        
        // 最新のコメントのタイムスタンプで比較
        const aLatest = aHistory.length > 0 ? new Date(aHistory[aHistory.length - 1].snippet?.publishedAt || 0).getTime() : 0;
        const bLatest = bHistory.length > 0 ? new Date(bHistory[bHistory.length - 1].snippet?.publishedAt || 0).getTime() : 0;
        
        return bLatest - aLatest; // 降順
      });
      
      const keysToRemove = sortedKeys.slice(maxEntries);
      
      for (const key of keysToRemove) {
        await chrome.storage.local.remove(key);
        debugLog('[Background] Removed old history:', key);
      }
      
      debugLog('[Background] Cleanup completed, removed', keysToRemove.length, 'old histories');
    } else {
      debugLog('[Background] No cleanup needed, within limit');
    }
    
  } catch (error) {
    debugError('[Background] Error during cleanup:', error);
  }
}

// コメント履歴を取得（Video ID別）
async function getCommentsHistory(videoId = null) {
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
    return { success: true, comments: [] };
  }
  
  try {
    const storageKey = `commentsHistory_${targetVideoId}`;
    
    // 現在監視中のVideo IDの場合は、メモリを優先してストレージをフォールバックとする
    if (targetVideoId === monitoringState.currentVideoId && monitoringState.isMonitoring) {
      debugLog('[Background] === Currently monitored video - using memory first ===');
      
      const memoryComments = monitoringState.commentsHistory || [];
      debugLog('[Background] Memory has', memoryComments.length, 'comments');
      
      if (memoryComments.length > 0) {
        // メモリにコメントがある場合はそれを使用し、ストレージも同期
        await saveCommentsHistory(targetVideoId);
        debugLog('[Background] Returning', memoryComments.length, 'comments from memory');
        return { success: true, comments: memoryComments };
      } else {
        // メモリが空の場合はストレージから復元を試行
        debugLog('[Background] Memory empty, checking storage for recovery');
        const result = await chrome.storage.local.get([storageKey]);
        const storageHistory = result[storageKey] || [];
        
        if (storageHistory.length > 0) {
          // ストレージから復元してメモリにも保存
          monitoringState.commentsHistory = storageHistory;
          debugLog('[Background] Recovered', storageHistory.length, 'comments from storage to memory');
          return { success: true, comments: storageHistory };
        } else {
          debugLog('[Background] No comments found in memory or storage for monitored video');
          return { success: true, comments: [] };
        }
      }
    } else {
      // 別のVideo IDまたは監視停止中の場合は、ストレージから取得
      debugLog('[Background] === Non-monitored video or monitoring stopped - using storage ===');
      const result = await chrome.storage.local.get([storageKey]);
      const history = result[storageKey] || [];
      debugLog('[Background] Retrieved', history.length, 'comments for video', targetVideoId, 'from storage');
      return { success: true, comments: history };
    }
    
  } catch (error) {
    debugError('[Background] Error getting comments history:', error);
    return { success: true, comments: [] };
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
    
    // ストレージ使用量確認
    try {
      const storageData = await chrome.storage.local.get();
      const historyKeys = Object.keys(storageData).filter(key => key.startsWith('commentsHistory_'));
      diagnostics.storage.historyEntriesCount = historyKeys.length;
      
      let totalComments = 0;
      for (const key of historyKeys) {
        const comments = storageData[key] || [];
        totalComments += comments.length;
      }
      diagnostics.storage.totalStoredComments = totalComments;
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