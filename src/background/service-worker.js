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
    sponsor: false,
    normal: false
  },
  commentsHistory: [], // 現在監視中のVideo IDの履歴
  currentVideoId: null
};

// コメント履歴をストレージに保存（Video ID別）
async function saveCommentsHistory(videoId = null) {
  try {
    const targetVideoId = videoId || monitoringState.currentVideoId;
    if (!targetVideoId) {
      console.warn('[Background] No video ID available for saving comments');
      return;
    }
    
    const commentsToSave = monitoringState.commentsHistory || [];
    const storageKey = `commentsHistory_${targetVideoId}`;
    
    console.log('[Background] === Saving comments history ===');
    console.log('[Background] Video ID:', targetVideoId);
    console.log('[Background] Comments count:', commentsToSave.length);
    
    await chrome.storage.local.set({
      [storageKey]: commentsToSave
    });
    
    // 保存確認のため、すぐに読み取りテストを実行
    const verification = await chrome.storage.local.get([storageKey]);
    const savedCount = verification[storageKey]?.length || 0;
    
    console.log('[Background] Saved and verified', savedCount, 'comments for video', targetVideoId);
    
    if (savedCount !== commentsToSave.length) {
      console.error('[Background] Save verification failed! Expected:', commentsToSave.length, 'Actual:', savedCount);
    }
    
  } catch (error) {
    console.error('[Background] Failed to save comments history:', error);
  }
}

// Service Worker起動時の初期化
async function initializeServiceWorker() {
  console.log('[Background] Initializing Service Worker');
  
  try {
    // 古い履歴形式から新しい形式へのマイグレーション
    const oldResult = await chrome.storage.local.get(['commentsHistory']);
    if (oldResult.commentsHistory && oldResult.commentsHistory.length > 0) {
      console.log('[Background] Found old format history, migration may be needed');
    }
    
    // 定期的なクリーンアップを実行
    cleanupOldCommentHistories();
    
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
  
  if (request.action === 'getMonitoringVideoId') {
    sendResponse({ 
      success: true, 
      videoId: monitoringState.currentVideoId 
    });
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
      sponsor: false,
      normal: false
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
    
    console.log('[Background] Individual filters applied:', {
      owner: commentFilters.owner,
      moderator: commentFilters.moderator, 
      sponsor: commentFilters.sponsor,
      normal: commentFilters.normal
    });
    console.log('[Background] Returning', filteredComments.length, 'filtered comments out of', data.items.length, 'total');
    
    return {
      comments: filteredComments,
      nextPageToken: data.nextPageToken,
      pollingIntervalMillis: data.pollingIntervalMillis || 5000,
      commentFilters: commentFilters
    };
    
  } catch (error) {
    console.error('[Background] Error fetching live chat messages:', error);
    throw error;
  }
}

// Backgroundでの監視開始
async function startBackgroundMonitoring(liveChatId, tabId, videoId) {
  console.log('[Background] Starting background monitoring for liveChatId:', liveChatId, 'videoId:', videoId);
  
  if (monitoringState.isMonitoring) {
    console.log('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }
  
  // Video IDが変わった場合は新しい履歴を開始
  let existingHistory = [];
  if (videoId && videoId === monitoringState.currentVideoId) {
    // 同じVideo IDの場合は既存履歴を保持
    existingHistory = monitoringState.commentsHistory || [];
    console.log('[Background] Same video ID, preserving', existingHistory.length, 'existing comments');
  } else if (videoId) {
    // 新しいVideo IDの場合は履歴をロード
    try {
      const storageKey = `commentsHistory_${videoId}`;
      const result = await chrome.storage.local.get([storageKey]);
      existingHistory = result[storageKey] || [];
      console.log('[Background] Loaded', existingHistory.length, 'comments for video', videoId);
    } catch (error) {
      console.error('[Background] Failed to load existing history:', error);
    }
  }
  
  // 現在のフィルター設定を保持
  const currentFilters = monitoringState.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: false,
    normal: false
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
  
  console.log('[Background] Monitoring state reset for video:', videoId, 'with', existingHistory.length, 'existing comments');
  
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
  
  console.log('[Background] getMonitoringState - Memory:', {
    isMonitoring: monitoringState.isMonitoring,
    currentVideoId: monitoringState.currentVideoId,
    liveChatId: monitoringState.liveChatId,
    commentsCount: monitoringState.commentsHistory.length
  });
  console.log('[Background] getMonitoringState - Storage:', savedState);
  
  return {
    success: true,
    isMonitoring: monitoringState.isMonitoring || savedState.isMonitoring,
    liveChatId: monitoringState.liveChatId || savedState.liveChatId,
    tabId: monitoringState.tabId || savedState.tabId,
    currentVideoId: monitoringState.currentVideoId
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
      
      // API制限エラーの場合は長めの間隔でリトライ
      const retryDelay = error.message.includes('quota') || error.message.includes('limit') ? 60000 : 15000;
      
      // 監視中の場合のみリトライ
      if (monitoringState.isMonitoring) {
        console.log(`[Background] Retrying in ${retryDelay/1000} seconds...`);
        monitoringState.pollingInterval = setTimeout(() => {
          startPollingLoop();
        }, retryDelay);
      }
    });
}

// サービスワーカーのライフサイクル管理
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] Extension startup');
  // 保存された状態を復元
  const result = await chrome.storage.local.get(['monitoringState', 'commentFilters']);
  const savedState = result.monitoringState;
  const savedFilters = result.commentFilters || {
    owner: true,
    moderator: true,
    sponsor: false,
    normal: false
  };
  
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
      commentFilters: savedFilters,
      commentsHistory: commentsHistory
    };
    console.log('[Background] Restored', commentsHistory.length, 'comments from storage');
    console.log('[Background] Restored comment filters:', savedFilters);
    startPollingLoop();
  } else {
    // 監視していない場合でもフィルター設定は復元
    monitoringState.commentFilters = savedFilters;
    console.log('[Background] Restored comment filters:', savedFilters);
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

// コメントフィルターを設定
async function setCommentFilters(filters) {
  console.log('[Background] Setting comment filters:', filters);
  
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
    sponsor: false,
    normal: false
  };
  
  return { success: true, filters: commentFilters };
}

// 古いコメント履歴をクリーンアップ
async function cleanupOldCommentHistories() {
  try {
    console.log('[Background] Starting comments history cleanup');
    
    // 全てのストレージキーを取得
    const allData = await chrome.storage.local.get();
    const historyKeys = Object.keys(allData).filter(key => key.startsWith('commentsHistory_'));
    
    console.log('[Background] Found', historyKeys.length, 'comment history entries');
    
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
        console.log('[Background] Removed old history:', key);
      }
      
      console.log('[Background] Cleanup completed, removed', keysToRemove.length, 'old histories');
    } else {
      console.log('[Background] No cleanup needed, within limit');
    }
    
  } catch (error) {
    console.error('[Background] Error during cleanup:', error);
  }
}

// コメント履歴を取得（Video ID別）
async function getCommentsHistory(videoId = null) {
  const targetVideoId = videoId || monitoringState.currentVideoId;
  console.log('[Background] === getCommentsHistory called ===');
  console.log('[Background] Target video ID:', targetVideoId);
  console.log('[Background] Current monitoring state:', {
    isMonitoring: monitoringState.isMonitoring,
    currentVideoId: monitoringState.currentVideoId,
    memoryCommentsCount: monitoringState.commentsHistory.length
  });
  
  if (!targetVideoId) {
    console.log('[Background] No video ID provided, returning empty history');
    return { success: true, comments: [] };
  }
  
  try {
    const storageKey = `commentsHistory_${targetVideoId}`;
    
    // 現在監視中のVideo IDの場合は、メモリを優先してストレージをフォールバックとする
    if (targetVideoId === monitoringState.currentVideoId && monitoringState.isMonitoring) {
      console.log('[Background] === Currently monitored video - using memory first ===');
      
      const memoryComments = monitoringState.commentsHistory || [];
      console.log('[Background] Memory has', memoryComments.length, 'comments');
      
      if (memoryComments.length > 0) {
        // メモリにコメントがある場合はそれを使用し、ストレージも同期
        await saveCommentsHistory(targetVideoId);
        console.log('[Background] Returning', memoryComments.length, 'comments from memory');
        return { success: true, comments: memoryComments };
      } else {
        // メモリが空の場合はストレージから復元を試行
        console.log('[Background] Memory empty, checking storage for recovery');
        const result = await chrome.storage.local.get([storageKey]);
        const storageHistory = result[storageKey] || [];
        
        if (storageHistory.length > 0) {
          // ストレージから復元してメモリにも保存
          monitoringState.commentsHistory = storageHistory;
          console.log('[Background] Recovered', storageHistory.length, 'comments from storage to memory');
          return { success: true, comments: storageHistory };
        } else {
          console.log('[Background] No comments found in memory or storage for monitored video');
          return { success: true, comments: [] };
        }
      }
    } else {
      // 別のVideo IDまたは監視停止中の場合は、ストレージから取得
      console.log('[Background] === Non-monitored video or monitoring stopped - using storage ===');
      const result = await chrome.storage.local.get([storageKey]);
      const history = result[storageKey] || [];
      console.log('[Background] Retrieved', history.length, 'comments for video', targetVideoId, 'from storage');
      return { success: true, comments: history };
    }
    
  } catch (error) {
    console.error('[Background] Error getting comments history:', error);
    return { success: true, comments: [] };
  }
}