class YouTubeLiveChatMonitor {
  constructor() {
    this.liveChatId = null;
    this.pageToken = null;
    this.pollingInterval = null;
    this.isMonitoring = false;
    this.specialComments = [];
    this.initRetryCount = 0;
    this.maxInitRetries = 10;
    this.currentVideoId = null;
    
    console.log('[YouTube Special Comments] Content script initialized');
    this.init();
  }
  
  init() {
    this.setupMessageListener();
    
    if (this.isYouTubeLivePage()) {
      console.log('[YouTube Special Comments] YouTube watch page detected');
      this.extractLiveChatId();
    } else {
      this.waitForYouTubeLive();
    }
    
    // YouTube SPAの画面遷移を監視
    this.observePageChanges();
    this.setupVisibilityMonitoring();
  }
  
  isYouTubeLivePage() {
    return window.location.href.includes('youtube.com/watch');
  }
  
  async extractLiveChatId() {
    console.log('[YouTube Special Comments] Starting live chat ID extraction via API');
    
    // 現在のVideo IDを更新
    this.currentVideoId = this.extractVideoId();
    console.log('[YouTube Special Comments] Current video ID:', this.currentVideoId);
    
    if (!this.currentVideoId) {
      console.warn('[YouTube Special Comments] No video ID found, cannot proceed');
      this.retryExtraction();
      return;
    }
    
    // API Lookup only - シンプルで確実な方法
    try {
      const apiSuccess = await this.getLiveChatIdFromVideoId(this.currentVideoId);
      if (apiSuccess && this.liveChatId) {
        console.log('[YouTube Special Comments] ✅ Live chat ID obtained:', this.liveChatId);
        return;
      } else {
        console.log('[YouTube Special Comments] ❌ No active live chat found for this video');
        this.retryExtraction();
      }
    } catch (error) {
      console.error('[YouTube Special Comments] ❌ API lookup failed:', error.message);
      this.retryExtraction();
    }
  }
  
  
  retryExtraction() {
    console.log('[YouTube Special Comments] Live chat ID not found, retrying in 2 seconds...');
    if (this.initRetryCount < this.maxInitRetries) {
      this.initRetryCount++;
      setTimeout(() => this.extractLiveChatId(), 2000);
    } else {
      console.warn('[YouTube Special Comments] ❌ Max retry attempts reached, live chat ID not found');
      console.warn('[YouTube Special Comments] This video may not be a live stream or may not have live chat enabled');
    }
  }
  
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      console.log('[Content Script] Received message:', request.action);
      
      if (request.action === 'startMonitoring') {
        this.startBackgroundMonitoring();
        sendResponse({ success: true });
      } else if (request.action === 'stopMonitoring') {
        this.stopBackgroundMonitoring();
        sendResponse({ success: true });
      } else if (request.action === 'getSpecialComments') {
        sendResponse({ 
          comments: this.specialComments,
          liveChatId: this.liveChatId,
          isMonitoring: this.isMonitoring,
          videoId: this.currentVideoId
        });
      } else if (request.action === 'newSpecialComments') {
        // background scriptからの新しいコメント通知
        this.addNewComments(request.comments);
      } else if (request.action === 'getLiveChatId') {
        // popupからlive chat IDを要求された場合
        if (!this.liveChatId) {
          this.extractLiveChatId();
        }
        sendResponse({ liveChatId: this.liveChatId });
      }
      return true;
    });
  }
  
  async startBackgroundMonitoring() {
    // APIキーの事前チェック
    try {
      const apiKeyResponse = await chrome.runtime.sendMessage({ action: 'getApiKey' });
      if (!apiKeyResponse || !apiKeyResponse.apiKey) {
        console.error('[Content Script] API key not configured');
        throw new Error('YouTube Data API key is not configured. Please set it in the extension options.');
      }
    } catch (error) {
      console.error('[Content Script] API key check failed:', error);
      throw error;
    }

    if (!this.liveChatId) {
      console.log('[Content Script] No live chat ID found, attempting API lookup...');
      const videoId = this.extractVideoId();
      if (videoId) {
        await this.getLiveChatIdFromVideoId(videoId);
      }
      
      if (!this.liveChatId) {
        console.warn('[Content Script] No live chat ID found - this video may not be a live stream');
        throw new Error('No active live chat found for this video. Please ensure this is a live stream with chat enabled.');
      }
    }
    
    console.log('[Content Script] Starting background monitoring with liveChatId:', this.liveChatId);
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'startBackgroundMonitoring',
        liveChatId: this.liveChatId,
        videoId: this.currentVideoId
      });
      
      if (response.success) {
        this.isMonitoring = true;
        console.log('[Content Script] Background monitoring started');
      } else {
        console.error('[Content Script] Failed to start background monitoring:', response.error);
        throw new Error(response.error || 'Failed to start monitoring');
      }
    } catch (error) {
      console.error('[Content Script] Error starting background monitoring:', error);
      throw error;
    }
  }
  
  async stopBackgroundMonitoring() {
    console.log('[Content Script] Stopping background monitoring');
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'stopBackgroundMonitoring'
      });
      
      if (response.success) {
        this.isMonitoring = false;
        console.log('[Content Script] Background monitoring stopped');
      } else {
        console.error('[Content Script] Failed to stop background monitoring:', response.error);
      }
    } catch (error) {
      console.error('[Content Script] Error stopping background monitoring:', error);
    }
  }
  
  // background scriptからのコメントを受け取る
  addNewComments(newComments) {
    console.log('[Content Script] Received', newComments.length, 'new comments from background');
    
    this.specialComments.push(...newComments);
    
    if (this.specialComments.length > 1000) {
      this.specialComments = this.specialComments.slice(-1000);
    }
    
    // popupに通知（開いている場合）
    this.notifyPopupOfNewComments(newComments);
  }
  
  notifyPopupOfNewComments(newComments) {
    chrome.runtime.sendMessage({
      action: 'newSpecialComments',
      comments: newComments
    }).catch(() => {
    });
  }
  
  formatComment(comment) {
    const authorDetails = comment.authorDetails;
    const snippet = comment.snippet;
    
    let role = '';
    if (authorDetails.isChatOwner) {
      role = '[配信者]';
    } else if (authorDetails.isChatModerator) {
      role = '[モデレーター]';
    } else if (authorDetails.isChatSponsor) {
      role = '[メンバー]';
    }
    
    return {
      role: role,
      displayName: authorDetails.displayName,
      message: snippet.displayMessage,
      timestamp: snippet.publishedAt,
      profileImageUrl: authorDetails.profileImageUrl
    };
  }
}

// 新しいメソッドを追加
YouTubeLiveChatMonitor.prototype.waitForYouTubeLive = function() {
  const checkInterval = setInterval(() => {
    if (this.isYouTubeLivePage()) {
      clearInterval(checkInterval);
      this.extractLiveChatId();
    }
  }, 1000);
  
  // 30秒後にタイムアウト
  setTimeout(() => {
    clearInterval(checkInterval);
  }, 30000);
};

YouTubeLiveChatMonitor.prototype.observePageChanges = function() {
  // YouTubeのSPA画面遷移を監視
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log('[YouTube Special Comments] Page navigation detected');
      
      // 監視を停止してリセット
      this.stopBackgroundMonitoring();
      this.liveChatId = null;
      this.currentVideoId = null;
      this.initRetryCount = 0;
      
      // 新しいページをチェック
      setTimeout(() => {
        if (this.isYouTubeLivePage()) {
          this.extractLiveChatId();
        }
      }, 1000);
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
};


YouTubeLiveChatMonitor.prototype.extractVideoId = function() {
  const url = window.location.href;
  
  // Method 1: URLからvideo IDを抽出
  const urlMatch = url.match(/[?&]v=([^&]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  
  // Method 2: URLのパスからvideo IDを抽出（/watch/video_id形式）
  const pathMatch = url.match(/\/watch\/([^/?]+)/);
  if (pathMatch) {
    return pathMatch[1];
  }
  
  // Method 3: meta tagからvideo IDを抽出
  const metaTag = document.querySelector('meta[property="og:url"]');
  if (metaTag) {
    const metaUrl = metaTag.getAttribute('content');
    const metaMatch = metaUrl.match(/[?&]v=([^&]+)/);
    if (metaMatch) {
      return metaMatch[1];
    }
  }
  
  return null;
};


YouTubeLiveChatMonitor.prototype.getLiveChatIdFromVideoId = async function(videoId) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getLiveChatIdFromVideo',
      videoId: videoId
    });
    
    if (response && response.liveChatId) {
      this.liveChatId = response.liveChatId;
      console.log('[YouTube Special Comments] Live chat ID obtained:', this.liveChatId);
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error('[YouTube Special Comments] API error:', error.message);
    return false;
  }
};

// Page Visibility APIによる可視性監視
YouTubeLiveChatMonitor.prototype.setupVisibilityMonitoring = function() {
  // ページの可視性が変わった時の処理
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && this.isMonitoring) {
      console.log('[YouTube Special Comments] Page became hidden, requesting auto-stop');
      // background scriptに自動停止を要求
      chrome.runtime.sendMessage({
        action: 'requestAutoStop',
        reason: 'ページが非表示になりました'
      }).catch(error => {
        console.log('[YouTube Special Comments] Failed to request auto-stop:', error.message);
      });
    } else if (document.visibilityState === 'visible') {
      console.log('[YouTube Special Comments] Page became visible');
      // ここで必要に応じて監視状態を確認・復元
    }
  });
  
  // ページアンロード時の処理
  window.addEventListener('beforeunload', () => {
    if (this.isMonitoring) {
      console.log('[YouTube Special Comments] Page unloading, requesting auto-stop');
      // 同期的に停止要求を送信
      navigator.sendBeacon(
        chrome.runtime.getURL(''), 
        JSON.stringify({
          action: 'requestAutoStop',
          reason: 'ページが閉じられました'
        })
      );
    }
  });
};

// 初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[YouTube Special Comments] DOM loaded, initializing...');
    new YouTubeLiveChatMonitor();
  });
} else {
  console.log('[YouTube Special Comments] Document ready, initializing...');
  new YouTubeLiveChatMonitor();
}