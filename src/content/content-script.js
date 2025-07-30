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
    
    console.log('[YouTube Special Comments] Content script initializing...');
    this.init();
  }
  
  init() {
    console.log('[YouTube Special Comments] Checking if page is YouTube Live...');
    this.setupMessageListener();
    
    if (this.isYouTubeLivePage()) {
      console.log('[YouTube Special Comments] YouTube Live page detected');
      this.extractLiveChatId();
    } else {
      console.log('[YouTube Special Comments] Not a YouTube Live page, waiting for navigation...');
      this.waitForYouTubeLive();
    }
    
    // YouTube SPAの画面遷移を監視
    this.observePageChanges();
  }
  
  isYouTubeLivePage() {
    const isWatchPage = window.location.href.includes('youtube.com/watch');
    const hasLiveChat = document.querySelector('yt-live-chat-renderer') !== null;
    const hasLiveChatFrame = document.querySelector('iframe[src*="live_chat"]') !== null;
    
    console.log('[YouTube Special Comments] Page check:', {
      isWatchPage,
      hasLiveChat,
      hasLiveChatFrame,
      url: window.location.href
    });
    
    return isWatchPage && (hasLiveChat || hasLiveChatFrame);
  }
  
  extractLiveChatId() {
    console.log('[YouTube Special Comments] Attempting to extract live chat ID...');
    
    // 現在のVideo IDを更新
    this.currentVideoId = this.extractVideoId();
    console.log('[YouTube Special Comments] Current video ID:', this.currentVideoId);
    
    // Method 1: Check yt-live-chat-renderer element
    const liveChatRenderer = document.querySelector('yt-live-chat-renderer');
    if (liveChatRenderer) {
      console.log('[YouTube Special Comments] Found yt-live-chat-renderer element');
      const continuation = liveChatRenderer.getAttribute('continuation');
      if (continuation) {
        try {
          const decoded = atob(continuation);
          const match = decoded.match(/"liveChatId":"([^"]+)"/);
          if (match) {
            this.liveChatId = match[1];
            console.log('[YouTube Special Comments] Live chat ID found via continuation:', this.liveChatId);
            return;
          }
        } catch (e) {
          console.warn('[YouTube Special Comments] Failed to decode continuation:', e);
        }
      }
    }
    
    // Method 2: Check iframe src
    const liveChatFrame = document.querySelector('iframe[src*="live_chat"]');
    if (liveChatFrame) {
      console.log('[YouTube Special Comments] Found live chat iframe');
      const src = liveChatFrame.src;
      const match = src.match(/v=([^&]+)/);
      if (match) {
        // Video IDからlive chat IDを推測（通常は同じ）
        const videoId = match[1];
        console.log('[YouTube Special Comments] Video ID found:', videoId);
        // 実際のlive chat IDを取得するため、別の方法を試す
      }
    }
    
    // Method 3: Check script elements
    const scriptElements = document.querySelectorAll('script');
    for (const script of scriptElements) {
      const content = script.textContent || script.innerText;
      if (content.includes('liveChatId')) {
        const match = content.match(/"liveChatId":"([^"]+)"/);
        if (match) {
          this.liveChatId = match[1];
          console.log('[YouTube Special Comments] Live chat ID found in script:', this.liveChatId);
          return;
        }
      }
    }
    
    // Method 4: Check window.ytInitialData
    if (window.ytInitialData) {
      try {
        const liveChatRenderer = this.findLiveChatInYtData(window.ytInitialData);
        if (liveChatRenderer && liveChatRenderer.liveChatId) {
          this.liveChatId = liveChatRenderer.liveChatId;
          console.log('[YouTube Special Comments] Live chat ID found in ytInitialData:', this.liveChatId);
          return;
        }
      } catch (e) {
        console.warn('[YouTube Special Comments] Error parsing ytInitialData:', e);
      }
    }
    
    // Method 5: Extract video ID and get live chat ID via API
    const videoId = this.extractVideoId();
    if (videoId) {
      console.log('[YouTube Special Comments] Video ID found:', videoId);
      this.getLiveChatIdFromVideoId(videoId);
      return;
    }
    
    console.log('[YouTube Special Comments] Live chat ID not found, retrying in 2 seconds...');
    if (this.initRetryCount < this.maxInitRetries) {
      this.initRetryCount++;
      setTimeout(() => this.extractLiveChatId(), 2000);
    } else {
      console.warn('[YouTube Special Comments] Max retry attempts reached, live chat ID not found');
    }
  }
  
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
    if (!this.liveChatId) {
      console.warn('[Content Script] No live chat ID found, attempting API lookup...');
      const videoId = this.extractVideoId();
      if (videoId) {
        await this.getLiveChatIdFromVideoId(videoId);
      }
      
      if (!this.liveChatId) {
        console.warn('[Content Script] Still no live chat ID found - this may not be a live stream');
        return;
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
      }
    } catch (error) {
      console.error('[Content Script] Error starting background monitoring:', error);
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
    
    if (this.specialComments.length > 100) {
      this.specialComments = this.specialComments.slice(-100);
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
  console.log('[YouTube Special Comments] Waiting for YouTube Live page...');
  const checkInterval = setInterval(() => {
    if (this.isYouTubeLivePage()) {
      console.log('[YouTube Special Comments] YouTube Live page detected after waiting');
      clearInterval(checkInterval);
      this.extractLiveChatId();
    }
  }, 1000);
  
  // 30秒後にタイムアウト
  setTimeout(() => {
    clearInterval(checkInterval);
    console.log('[YouTube Special Comments] Timeout waiting for YouTube Live page');
  }, 30000);
};

YouTubeLiveChatMonitor.prototype.observePageChanges = function() {
  // YouTubeのSPA画面遷移を監視
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log('[YouTube Special Comments] Page navigation detected:', lastUrl);
      
      // 監視を停止
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

YouTubeLiveChatMonitor.prototype.findLiveChatInYtData = function(data) {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  
  for (const key in data) {
    if (key === 'liveChatRenderer' && data[key].liveChatId) {
      return data[key];
    }
    
    if (typeof data[key] === 'object') {
      const result = this.findLiveChatInYtData(data[key]);
      if (result) {
        return result;
      }
    }
  }
  
  return null;
};

YouTubeLiveChatMonitor.prototype.extractVideoId = function() {
  console.log('[YouTube Special Comments] Extracting video ID from URL:', window.location.href);
  
  // Method 1: URLからvideo IDを抽出
  const url = window.location.href;
  const urlMatch = url.match(/[?&]v=([^&]+)/);
  if (urlMatch) {
    const videoId = urlMatch[1];
    console.log('[YouTube Special Comments] Video ID found in URL:', videoId);
    return videoId;
  }
  
  // Method 2: URLのパスからvideo IDを抽出（/watch/video_id形式）
  const pathMatch = url.match(/\/watch\/([^/?]+)/);
  if (pathMatch) {
    const videoId = pathMatch[1];
    console.log('[YouTube Special Comments] Video ID found in path:', videoId);
    return videoId;
  }
  
  // Method 3: ytInitialDataからvideo IDを抽出
  if (window.ytInitialData) {
    try {
      const videoDetails = this.findVideoDetailsInYtData(window.ytInitialData);
      if (videoDetails && videoDetails.videoId) {
        console.log('[YouTube Special Comments] Video ID found in ytInitialData:', videoDetails.videoId);
        return videoDetails.videoId;
      }
    } catch (e) {
      console.warn('[YouTube Special Comments] Error extracting video ID from ytInitialData:', e);
    }
  }
  
  // Method 4: meta tagからvideo IDを抽出
  const metaTag = document.querySelector('meta[property="og:url"]');
  if (metaTag) {
    const metaUrl = metaTag.getAttribute('content');
    const metaMatch = metaUrl.match(/[?&]v=([^&]+)/);
    if (metaMatch) {
      console.log('[YouTube Special Comments] Video ID found in meta tag:', metaMatch[1]);
      return metaMatch[1];
    }
  }
  
  console.log('[YouTube Special Comments] No video ID found');
  return null;
};

YouTubeLiveChatMonitor.prototype.findVideoDetailsInYtData = function(data) {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  
  if (data.videoDetails && data.videoDetails.videoId) {
    return data.videoDetails;
  }
  
  for (const key in data) {
    if (typeof data[key] === 'object') {
      const result = this.findVideoDetailsInYtData(data[key]);
      if (result) {
        return result;
      }
    }
  }
  
  return null;
};

YouTubeLiveChatMonitor.prototype.getLiveChatIdFromVideoId = async function(videoId) {
  console.log('[YouTube Special Comments] Getting live chat ID from video ID:', videoId);
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getLiveChatIdFromVideo',
      videoId: videoId
    });
    
    if (response && response.liveChatId) {
      this.liveChatId = response.liveChatId;
      console.log('[YouTube Special Comments] Live chat ID obtained from API:', this.liveChatId);
    } else {
      console.log('[YouTube Special Comments] No live chat found for this video');
    }
  } catch (error) {
    console.error('[YouTube Special Comments] Error getting live chat ID from API:', error);
  }
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