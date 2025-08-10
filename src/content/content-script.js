// デバッグモードによる統一ログ関数
let debugMode = false;

// デバッグモード設定を取得
async function loadDebugMode() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getDebugMode' });
    debugMode = response.debugMode || false;
  } catch (error) {
    // 設定読み込み失敗は重要なのでデバッグモードに関係なく表示
    console.error('[Content Script] Failed to load debug mode:', error);
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
    this.serviceWorkerReady = false;
    this.initializationDelayMs = 2000; // Service Worker初期化待機時間
    
    // デバッグモード設定を読み込み
    loadDebugMode();
    
    debugLog('[YouTube Special Comments] Content script initialized');
    
    // Service Workerの初期化を待ってから開始
    this.waitForServiceWorkerAndInit();
  }
  
  // Service Worker初期化待機とContent Script初期化
  async waitForServiceWorkerAndInit() {
    debugLog('[YouTube Special Comments] Waiting for service worker initialization...');
    
    // 診断情報をログ出力
    this.logDiagnosticInfo();
    
    // Service Workerの準備を確認
    const isReady = await this.waitForServiceWorker();
    
    if (isReady) {
      debugLog('[YouTube Special Comments] ✅ Service Worker ready, proceeding with initialization');
    } else {
      debugWarn('[YouTube Special Comments] ⚠️ Service Worker not fully ready, but continuing...');
    }
    
    // 初期化を実行
    this.init();
  }
  
  // 診断情報をログ出力
  logDiagnosticInfo() {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      contentScript: {
        url: window.location.href,
        userAgent: navigator.userAgent,
        extensionId: chrome.runtime.id,
        documentState: document.readyState,
        videoIdFromURL: this.extractVideoId()
      },
      browser: {
        chromeVersion: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || 'unknown',
        platform: navigator.platform,
        language: navigator.language
      }
    };
    
    debugLog('[YouTube Special Comments] 🔍 Content Script Diagnostics:', diagnostics);
    
    // ページ固有の情報もログ
    const youtubeInfo = this.getYouTubePageInfo();
    if (youtubeInfo) {
      debugLog('[YouTube Special Comments] 📺 YouTube Page Info:', youtubeInfo);
    }
  }
  
  // YouTube ページ固有の診断情報を取得
  getYouTubePageInfo() {
    try {
      const info = {
        isWatchPage: this.isYouTubeLivePage(),
        hasYouTubeMetadata: !!document.querySelector('meta[property="og:site_name"][content="YouTube"]'),
        hasVideoPlayer: !!document.querySelector('#movie_player'),
        hasChatFrame: !!document.querySelector('iframe[src*="live_chat"]'),
        videoElements: document.querySelectorAll('video').length,
        scriptElements: document.querySelectorAll('script').length
      };
      
      // メタデータからビデオIDを取得試行
      const metaOgUrl = document.querySelector('meta[property="og:url"]');
      if (metaOgUrl) {
        const metaUrl = metaOgUrl.getAttribute('content');
        const videoIdMatch = metaUrl.match(/[?&]v=([^&]+)/);
        info.metaVideoId = videoIdMatch ? videoIdMatch[1] : null;
      }
      
      return info;
    } catch (error) {
      debugWarn('[YouTube Special Comments] Failed to gather YouTube page info:', error);
      return null;
    }
  }
  
  // Service Workerの準備状態を確認
  async waitForServiceWorker(maxAttempts = 10, delayMs = 500) {
    debugLog('[YouTube Special Comments] Checking service worker readiness...');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        debugLog(`[YouTube Special Comments] Service worker check attempt ${attempt}/${maxAttempts}`);
        
        // Service Workerにping送信
        const response = await this.sendMessageWithTimeout({
          action: 'ping'
        }, 3000);
        
        if (response) {
          debugLog('[YouTube Special Comments] ✅ Service worker is ready');
          this.serviceWorkerReady = true;
          return true;
        }
      } catch (error) {
        debugLog(`[YouTube Special Comments] Service worker not ready (attempt ${attempt}): ${error.message}`);
        
        if (attempt < maxAttempts) {
          // 指数バックオフでリトライ間隔を増加
          const waitTime = delayMs * Math.pow(1.5, attempt - 1);
          debugLog(`[YouTube Special Comments] Waiting ${waitTime}ms before next attempt...`);
          await this.delay(waitTime);
        }
      }
    }
    
    debugWarn('[YouTube Special Comments] ⚠️ Service worker readiness timeout, proceeding anyway');
    return false;
  }
  
  // タイムアウト付きメッセージ送信
  async sendMessageWithTimeout(message, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Message timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timeout);
        
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }
  
  // 遅延ユーティリティ
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  init() {
    this.setupMessageListener();
    
    if (this.isYouTubeLivePage()) {
      debugLog('[YouTube Special Comments] YouTube watch page detected');
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
    debugLog('[YouTube Special Comments] Starting live chat ID extraction via API');
    
    // 現在のVideo IDを更新
    this.currentVideoId = this.extractVideoId();
    debugLog('[YouTube Special Comments] Current video ID:', this.currentVideoId);
    
    if (!this.currentVideoId) {
      debugWarn('[YouTube Special Comments] No video ID found, cannot proceed');
      this.retryExtraction();
      return;
    }
    
    // API Lookup only - シンプルで確実な方法
    try {
      const apiSuccess = await this.getLiveChatIdFromVideoId(this.currentVideoId);
      if (apiSuccess && this.liveChatId) {
        debugLog('[YouTube Special Comments] ✅ Live chat ID obtained:', this.liveChatId);
        return;
      } else {
        debugLog('[YouTube Special Comments] ❌ No active live chat found for this video');
        this.retryExtraction();
      }
    } catch (error) {
      debugError('[YouTube Special Comments] ❌ API lookup failed:', error.message);
      this.retryExtraction();
    }
  }
  
  
  retryExtraction() {
    debugLog('[YouTube Special Comments] Live chat ID not found, retrying in 2 seconds...');
    if (this.initRetryCount < this.maxInitRetries) {
      this.initRetryCount++;
      setTimeout(() => this.extractLiveChatId(), 2000);
    } else {
      debugWarn('[YouTube Special Comments] ❌ Max retry attempts reached, live chat ID not found');
      debugWarn('[YouTube Special Comments] This video may not be a live stream or may not have live chat enabled');
    }
  }
  
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      debugLog('[Content Script] Received message:', request.action);
      
      // Content Script生存確認用のping
      if (request.action === 'ping') {
        sendResponse({ 
          success: true, 
          timestamp: Date.now(),
          url: window.location.href,
          videoId: this.extractVideoId(),
          serviceWorkerReady: this.serviceWorkerReady,
          liveChatId: this.liveChatId
        });
        return true;
      }
      
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
      const apiKeyResponse = await this.sendMessageWithRetry({ action: 'getApiKey' }, 2);
      if (!apiKeyResponse || !apiKeyResponse.apiKey) {
        debugError('[Content Script] API key not configured');
        throw new Error('YouTube Data API key is not configured. Please set it in the extension options.');
      }
    } catch (error) {
      debugError('[Content Script] API key check failed:', error);
      throw error;
    }

    if (!this.liveChatId) {
      debugLog('[Content Script] No live chat ID found, attempting API lookup...');
      const videoId = this.extractVideoId();
      if (videoId) {
        await this.getLiveChatIdFromVideoId(videoId);
      }
      
      if (!this.liveChatId) {
        debugWarn('[Content Script] No live chat ID found - this video may not be a live stream');
        throw new Error('No active live chat found for this video. Please ensure this is a live stream with chat enabled.');
      }
    }
    
    debugLog('[Content Script] Starting background monitoring with liveChatId:', this.liveChatId);
    
    try {
      const response = await this.sendMessageWithRetry({
        action: 'startBackgroundMonitoring',
        liveChatId: this.liveChatId,
        videoId: this.currentVideoId
      }, 3);
      
      if (response && response.success) {
        this.isMonitoring = true;
        debugLog('[Content Script] Background monitoring started');
      } else {
        debugError('[Content Script] Failed to start background monitoring:', response?.error || 'Unknown error');
        throw new Error(response?.error || 'Failed to start monitoring');
      }
    } catch (error) {
      debugError('[Content Script] Error starting background monitoring:', error);
      throw error;
    }
  }
  
  async stopBackgroundMonitoring() {
    debugLog('[Content Script] Stopping background monitoring');
    
    try {
      const response = await this.sendMessageWithRetry({
        action: 'stopBackgroundMonitoring'
      }, 3);
      
      if (response && response.success) {
        this.isMonitoring = false;
        debugLog('[Content Script] Background monitoring stopped');
      } else {
        debugError('[Content Script] Failed to stop background monitoring:', response?.error || 'Unknown error');
      }
    } catch (error) {
      debugError('[Content Script] Error stopping background monitoring:', error);
    }
  }
  
  // background scriptからのコメントを受け取る
  addNewComments(newComments) {
    debugLog('[Content Script] Received', newComments.length, 'new comments from background');
    
    this.specialComments.push(...newComments);
    
    if (this.specialComments.length > 10000) {
      this.specialComments = this.specialComments.slice(-10000);
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
      debugLog('[YouTube Special Comments] Page navigation detected');
      
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
    const response = await this.sendMessageWithRetry({
      action: 'getLiveChatIdFromVideo',
      videoId: videoId
    }, 3);
    
    if (response && response.liveChatId) {
      this.liveChatId = response.liveChatId;
      debugLog('[YouTube Special Comments] Live chat ID obtained:', this.liveChatId);
      return true;
    } else {
      return false;
    }
  } catch (error) {
    debugError('[YouTube Special Comments] API error:', error.message);
    return false;
  }
};

// リトライ機能付きメッセージ送信
YouTubeLiveChatMonitor.prototype.sendMessageWithRetry = async function(message, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      debugLog(`[YouTube Special Comments] Sending message attempt ${attempt}/${maxRetries}:`, message.action);
      
      const response = await this.sendMessageWithTimeout(message, 5000);
      debugLog(`[YouTube Special Comments] ✅ Message successful on attempt ${attempt}`);
      return response;
      
    } catch (error) {
      debugWarn(`[YouTube Special Comments] Message failed on attempt ${attempt}:`, error.message);
      
      // Extension context invalidated の場合は特別処理
      if (error.message.includes('Extension context invalidated')) {
        debugError('[YouTube Special Comments] 🔄 Extension context invalidated - attempting recovery');
        
        // Service Worker再接続を試行
        await this.delay(1000);
        const recovered = await this.waitForServiceWorker(5, 1000);
        
        if (!recovered && attempt === maxRetries) {
          throw new Error('Extension context invalidated and recovery failed. Please reload the page.');
        }
        continue;
      }
      
      // "Could not establish connection" の場合も再接続試行
      if (error.message.includes('Could not establish connection')) {
        debugWarn('[YouTube Special Comments] 🔄 Connection lost - attempting recovery');
        await this.delay(1000);
        await this.waitForServiceWorker(3, 1000);
      }
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // 指数バックオフで待機
      const delay = baseDelay * Math.pow(2, attempt - 1);
      debugLog(`[YouTube Special Comments] Waiting ${delay}ms before retry...`);
      await this.delay(delay);
    }
  }
};

// Page Visibility APIによる可視性監視
YouTubeLiveChatMonitor.prototype.setupVisibilityMonitoring = function() {
  // ページの可視性が変わった時の処理
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && this.isMonitoring) {
      debugLog('[YouTube Special Comments] Page became hidden, requesting auto-stop');
      // background scriptに自動停止を要求
      chrome.runtime.sendMessage({
        action: 'requestAutoStop',
        reason: 'ページが非表示になりました'
      }).catch(error => {
        debugLog('[YouTube Special Comments] Failed to request auto-stop:', error.message);
      });
    } else if (document.visibilityState === 'visible') {
      debugLog('[YouTube Special Comments] Page became visible');
      // ここで必要に応じて監視状態を確認・復元
    }
  });
  
  // ページアンロード時の処理
  window.addEventListener('beforeunload', () => {
    if (this.isMonitoring) {
      debugLog('[YouTube Special Comments] Page unloading, requesting auto-stop');
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
    debugLog('[YouTube Special Comments] DOM loaded, initializing...');
    new YouTubeLiveChatMonitor();
  });
} else {
  debugLog('[YouTube Special Comments] Document ready, initializing...');
  new YouTubeLiveChatMonitor();
}