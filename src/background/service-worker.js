// グローバル状態管理
let monitoringState = {
  isMonitoring: false,
  liveChatId: null,
  pageToken: null,
  tabId: null,
  pollingInterval: null,
  processedMessageIds: new Set(),
  allCommentsMode: false,
  commentsHistory: []
};

// コメント履歴をストレージに保存
async function saveCommentsHistory() {
  try {
    await chrome.storage.local.set({
      commentsHistory: monitoringState.commentsHistory
    });
    console.log('[Background] Saved', monitoringState.commentsHistory.length, 'comments to storage');
  } catch (error) {
    console.error('[Background] Failed to save comments history:', error);
  }
}

// Service Worker起動時の初期化
async function initializeServiceWorker() {
  console.log('[Background] Initializing Service Worker');
  
  try {
    // ストレージから履歴を復元
    const result = await chrome.storage.local.get(['commentsHistory']);
    const existingHistory = result.commentsHistory || [];
    
    if (existingHistory.length > 0) {
      monitoringState.commentsHistory = existingHistory;
      console.log('[Background] Restored', existingHistory.length, 'comments from storage on startup');
    } else {
      console.log('[Background] No existing comments history found');
    }
  } catch (error) {
    console.error('[Background] Error initializing service worker:', error);
  }
}

// Service Worker起動時に初期化を実行
initializeServiceWorker();

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] YouTube Special Comments Filter installed');
  
  // ストレージから既存の履歴を復元
  const result = await chrome.storage.local.get(['commentsHistory']);
  const existingHistory = result.commentsHistory || [];
  monitoringState.commentsHistory = existingHistory;
  
  console.log('[Background] Restored', existingHistory.length, 'comments from storage on install');
  
  // インストール時に監視状態をリセット（履歴は保持）
  chrome.storage.local.set({
    monitoringState: {
      isMonitoring: false,
      liveChatId: null,
      tabId: null
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Background] Received message:', request.action);
  
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
  
  if (request.action === 'fetchLiveChatMessages') {
    fetchLiveChatMessages(request.liveChatId, request.pageToken)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  // 新しいアクションを追加
  if (request.action === 'startBackgroundMonitoring') {
    startBackgroundMonitoring(request.liveChatId, sender.tab.id)
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
  
  if (request.action === 'setAllCommentsMode') {
    setAllCommentsMode(request.enabled)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getAllCommentsModeState') {
    getAllCommentsModeState()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getCommentsHistory') {
    getCommentsHistory()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
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
    
    // 全コメントモードの状態を取得
    const modeResult = await chrome.storage.local.get(['allCommentsMode']);
    const allCommentsMode = modeResult.allCommentsMode || false;
    
    let filteredComments;
    if (allCommentsMode) {
      // 全コメントを取得
      filteredComments = data.items;
      console.log('[Background] All comments mode: returning', filteredComments.length, 'comments');
    } else {
      // 特別コメントのみをフィルタリング
      filteredComments = data.items.filter(item => {
        const authorDetails = item.authorDetails;
        return authorDetails.isChatModerator || 
               authorDetails.isChatSponsor || 
               authorDetails.isChatOwner;
      });
      console.log('[Background] Special comments mode: returning', filteredComments.length, 'special comments out of', data.items.length, 'total');
    }
    
    return {
      comments: filteredComments,
      nextPageToken: data.nextPageToken,
      pollingIntervalMillis: data.pollingIntervalMillis || 5000,
      allCommentsMode: allCommentsMode
    };
    
  } catch (error) {
    console.error('[Background] Error fetching live chat messages:', error);
    throw error;
  }
}

// Backgroundでの監視開始
async function startBackgroundMonitoring(liveChatId, tabId) {
  console.log('[Background] Starting background monitoring for liveChatId:', liveChatId);
  
  if (monitoringState.isMonitoring) {
    console.log('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }
  
  // 既存のコメント履歴を保持
  const existingHistory = monitoringState.commentsHistory || [];
  
  monitoringState = {
    isMonitoring: true,
    liveChatId: liveChatId,
    pageToken: null,
    tabId: tabId,
    pollingInterval: null,
    processedMessageIds: new Set(),
    allCommentsMode: monitoringState.allCommentsMode || false,
    commentsHistory: existingHistory
  };
  
  console.log('[Background] Monitoring state reset, processedMessageIds cleared, commentsHistory preserved:', existingHistory.length);
  
  // 状態を永続化
  await chrome.storage.local.set({
    monitoringState: {
      isMonitoring: true,
      liveChatId: liveChatId,
      tabId: tabId
    }
  });
  
  // 監視開始
  startPollingLoop();
  
  return { success: true };
}

// Backgroundでの監視停止
async function stopBackgroundMonitoring() {
  console.log('[Background] Stopping background monitoring');
  
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
  
  return { success: true };
}

// 監視状態を取得
async function getMonitoringState() {
  const result = await chrome.storage.local.get(['monitoringState']);
  const savedState = result.monitoringState || { isMonitoring: false };
  
  return {
    success: true,
    isMonitoring: monitoringState.isMonitoring || savedState.isMonitoring,
    liveChatId: monitoringState.liveChatId || savedState.liveChatId,
    tabId: monitoringState.tabId || savedState.tabId
  };
}

// ポーリングループ
function startPollingLoop() {
  if (!monitoringState.isMonitoring || !monitoringState.liveChatId) {
    return;
  }
  
  console.log('[Background] Polling for new messages...');
  
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
            console.log('[Background] Duplicate comment filtered:', messageId);
            return false;
          }
          monitoringState.processedMessageIds.add(messageId);
          console.log('[Background] New comment added:', messageId, comment.snippet.displayMessage.substring(0, 30));
          return true;
        });
        
        if (newComments.length > 0) {
          console.log('[Background] Found', newComments.length, 'new special comments');
          
          // コメント履歴に追加
          monitoringState.commentsHistory.push(...newComments);
          
          // 履歴サイズを制限（100件まで）
          if (monitoringState.commentsHistory.length > 100) {
            monitoringState.commentsHistory = monitoringState.commentsHistory.slice(-100);
          }
          
          // 履歴を永続化（即座にかつ定期的に）
          saveCommentsHistory();
          
          // popupに新しいコメントを通知
          chrome.runtime.sendMessage({
            action: 'newSpecialComments',
            comments: newComments
          }).catch(error => {
            console.log('[Background] No popup to notify:', error.message);
          });
          
          // content scriptにも通知（あれば）
          if (monitoringState.tabId) {
            chrome.tabs.sendMessage(monitoringState.tabId, {
              action: 'newSpecialComments',
              comments: newComments
            }).catch(error => {
              console.log('[Background] Content script not available:', error.message);
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
      console.error('[Background] Error in polling loop:', error);
      
      // エラー時は少し長めの間隔でリトライ
      if (monitoringState.isMonitoring) {
        monitoringState.pollingInterval = setTimeout(() => {
          startPollingLoop();
        }, 10000);
      }
    });
}

// サービスワーカーのライフサイクル管理
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] Extension startup');
  // 保存された状態を復元
  const result = await chrome.storage.local.get(['monitoringState']);
  const savedState = result.monitoringState;
  
  if (savedState && savedState.isMonitoring && savedState.liveChatId) {
    console.log('[Background] Restoring monitoring state');
    
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
      commentsHistory: commentsHistory
    };
    console.log('[Background] Restored', commentsHistory.length, 'comments from storage');
    startPollingLoop();
  }
});

// タブが閉じられたときの処理
chrome.tabs.onRemoved.addListener((tabId) => {
  if (monitoringState.tabId === tabId) {
    console.log('[Background] Tab closed, but continuing monitoring');
    // タブが閉じられても監視は継続
    monitoringState.tabId = null;
    // 履歴を保存
    saveCommentsHistory();
  }
});

// Service Worker停止前の処理
chrome.runtime.onSuspend.addListener(() => {
  console.log('[Background] Service Worker suspending, saving state');
  // 履歴を確実に保存
  saveCommentsHistory();
});

// 拡張機能停止時の処理
chrome.runtime.onSuspendCanceled.addListener(() => {
  console.log('[Background] Service Worker suspend canceled');
});

// Video IDからLive Chat IDを取得
async function getLiveChatIdFromVideo(videoId) {
  try {
    const result = await chrome.storage.local.get(['youtubeApiKey']);
    const apiKey = result.youtubeApiKey;
    
    if (!apiKey) {
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
      console.log('[Background] Video data:', { 
        id: video.id, 
        hasLiveStreamingDetails: !!video.liveStreamingDetails,
        liveStreamingDetails: video.liveStreamingDetails
      });
      
      const liveStreamingDetails = video.liveStreamingDetails;
      if (liveStreamingDetails && liveStreamingDetails.activeLiveChatId) {
        console.log('[Background] Live chat ID found via API:', liveStreamingDetails.activeLiveChatId);
        return { liveChatId: liveStreamingDetails.activeLiveChatId };
      } else {
        console.log('[Background] Video is not currently live streaming or has no active live chat');
      }
    } else {
      console.log('[Background] No video data found for ID:', videoId);
    }
    
    return { liveChatId: null };
    
  } catch (error) {
    console.error('[Background] Error getting live chat ID from video:', error);
    throw error;
  }
}

// 全コメントモードを設定
async function setAllCommentsMode(enabled) {
  console.log('[Background] Setting all comments mode:', enabled);
  
  await chrome.storage.local.set({ allCommentsMode: enabled });
  monitoringState.allCommentsMode = enabled;
  
  return { success: true, allCommentsMode: enabled };
}

// 全コメントモードの状態を取得
async function getAllCommentsModeState() {
  const result = await chrome.storage.local.get(['allCommentsMode']);
  const allCommentsMode = result.allCommentsMode || false;
  
  return { success: true, allCommentsMode: allCommentsMode };
}

// コメント履歴を取得
async function getCommentsHistory() {
  console.log('[Background] getCommentsHistory called');
  
  try {
    // 常にストレージから最新の履歴を取得
    const result = await chrome.storage.local.get(['commentsHistory']);
    const storageHistory = result.commentsHistory || [];
    
    // メモリの履歴と比較
    const memoryCount = monitoringState.commentsHistory.length;
    const storageCount = storageHistory.length;
    
    console.log('[Background] History comparison - Memory:', memoryCount, 'Storage:', storageCount);
    
    // より多くのコメントを持つ方を使用
    let finalHistory;
    if (storageCount >= memoryCount) {
      finalHistory = storageHistory;
      monitoringState.commentsHistory = storageHistory; // メモリも同期
      console.log('[Background] Using storage history:', storageCount, 'comments');
    } else {
      finalHistory = monitoringState.commentsHistory;
      // メモリの方が新しい場合、ストレージも更新
      chrome.storage.local.set({ commentsHistory: finalHistory }).catch(error => {
        console.error('[Background] Error updating storage:', error);
      });
      console.log('[Background] Using memory history:', memoryCount, 'comments');
    }
    
    return { success: true, comments: finalHistory };
    
  } catch (error) {
    console.error('[Background] Error getting comments history:', error);
    // エラー時はメモリの履歴を返す
    return { success: true, comments: monitoringState.commentsHistory };
  }
}