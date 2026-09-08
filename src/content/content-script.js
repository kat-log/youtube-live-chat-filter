// 二重注入防止
// このファイルはmanifestの自動注入に加えて、service-workerのreinjectContentScripts()
// からも注入される。トップレベルのlet/class宣言は同じisolated worldに残るため、
// ガードなしで再注入するとSyntaxErrorになりスクリプト全体が評価されない
if (window.__ytSpecialCommentsInitialized) { /* noop */ } else {
window.__ytSpecialCommentsInitialized = true;

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

// エラーだけは debugMode に関係なく必ず出す。
// 「数時間使い込まないと出ない」種類の不具合を追うのに、既定でエラーが
// 消えているのがいちばん困る（既定構成では debugMode を ON にする手段も無かった）
function debugError(prefix, ...args) {
  console.error(prefix, ...args);
}

// 同じタブの live_chat フレームに居る dom-chat.js 宛ての action。
// このスクリプトは宛先ではないので、横から答えない（下の理由を参照）
const DOM_CHAT_ACTIONS = new Set(['getDomChatHealth', 'requestInitialSweep']);

class YouTubeLiveChatMonitor {
  constructor() {
    // ポーリングそのものは Service Worker がやる。ここが持つのは
    // 「この画面はどの配信か」と「その配信のチャットIDは何か」だけ
    // （pageToken と pollingInterval はAPIモードの残骸で、フェーズ9で消した）
    this.liveChatId = null;
    this.isMonitoring = false;
    this.initRetryCount = 0;
    this.maxInitRetries = 10;
    this.currentVideoId = null;
    this.serviceWorkerReady = false;
    
    // デバッグモード設定を読み込み
    loadDebugMode();
    
    debugLog('[YouTube Special Comments] Content script initialized');
    
    // メッセージリスナーだけは待たずに登録する。
    // Service Worker起動待ちの間にpopupからpingが来ると「未注入」と誤判定され、
    // 不要なContent Script再注入を招くため
    this.setupMessageListener();
    
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
    // setupMessageListener()はconstructorで済ませている

    if (this.isYouTubeLivePage()) {
      debugLog('[YouTube Special Comments] YouTube watch page detected');
      this.startForCurrentPage();
      return;
    }

    // watch ページでなければ、ここは何もしない。
    //
    // 以前は setInterval で毎秒 URL を見張り（waitForYouTubeLive）、さらに
    // MutationObserver で document.body 全体を購読していた（#24）。どちらも
    // 「location.href という文字列が変わったか」を知るためだけの仕掛けで、
    // YouTube の watch ページでは再生時間・視聴回数・関連動画が絶え間なく動くため、
    // 拡張機能がやっていることの中で最も高価な処理になっていた。
    //
    // SPA遷移の検知は Service Worker の chrome.tabs.onUpdated に移した。
    // ページ側の負荷はゼロで、遷移は pageNavigated で知らされる
    debugLog('[YouTube Special Comments] Not a watch page; waiting for pageNavigated');
  }

  // Service Worker が SPA遷移を見つけたときの受け口（#24）。
  // セッションを畳むのは SW 側（session の正はあちら）。ここは自分の控えを捨てて、
  // 新しい動画で組み立て直すだけ
  handlePageNavigated(videoId) {
    debugLog('[YouTube Special Comments] Page navigation detected:', videoId);

    this.liveChatId = null;
    this.currentVideoId = null;
    this.initRetryCount = 0;
    this.isMonitoring = false;

    if (!this.isYouTubeLivePage()) return;

    // URL は既に新しい方に変わっている（onUpdated は遷移の後に来る）ので、
    // 以前のように1秒待つ必要は無い。この先で見るのは videoId だけで、
    // ページのDOMは見ない（APIモードの liveChatId も Service Worker 経由で引く）
    this.startForCurrentPage();
  }

  // この画面でやることは取得元のモードで違う。**先にモードを聞いてから動く。**
  //
  // - APIモード: liveChatId を引いてから自動開始する（APIキーが要る）
  // - DOMモード（既定）: liveChatId は使わない。dom-chat.js が DOM を読むので、
  //   自動開始の要求だけを出す
  //
  // 以前はモードを見ずに両方を撃っていた。DOMモードでは liveChatId の取得が
  // 必ず「APIキーが無い」で終わるだけの往復になり、しかも失敗として
  // 2秒おきに10回まで繰り返していた（インストール直後は APIキーが未設定なので、
  // 既定の構成で毎回そうなる）
  async startForCurrentPage() {
    const chatMode = await this.resolveChatMode();

    if (chatMode === 'api') {
      await this.extractLiveChatId();
      return;
    }

    await this.tryDomModeAutoStart(chatMode);
  }
  
  isYouTubeLivePage() {
    return window.location.href.includes('youtube.com/watch') || window.location.href.includes('youtube.com/live/');
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
        await this.tryAutoStart();
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
      const action = request?.action;
      debugLog('[Content Script] Received message:', action);

      // 以下は同期で応答する分岐。**応答したら true を返さないこと**（#30）。
      // true は「あとで応答する」の宣言なので、同期で済ませたあとに返すと
      // 応答チャネルが開いたまま残り、送信側の await が永久に解けないことがある。
      // このスクリプトは watch ページのトップフレームに居て、
      // dom-chat.js 宛ての tabs.sendMessage もここへ配られるので実際に起きる

      // Content Script生存確認用のping
      if (action === 'ping') {
        sendResponse({
          success: true,
          timestamp: Date.now(),
          url: window.location.href,
          videoId: this.extractVideoId(),
          serviceWorkerReady: this.serviceWorkerReady,
          liveChatId: this.liveChatId
        });
        return false;
      }

      if (action === 'stopMonitoring') {
        this.stopBackgroundMonitoring();
        sendResponse({ success: true });
        return false;
      }

      if (action === 'getLiveChatId') {
        // popupからlive chat IDを要求された場合
        if (!this.liveChatId) {
          this.extractLiveChatId();
        }
        sendResponse({ liveChatId: this.liveChatId });
        return false;
      }

      // Service Worker が SPA遷移を見つけた（#24）
      if (action === 'pageNavigated') {
        this.handlePageNavigated(request.videoId ?? null);
        sendResponse({ success: true });
        return false;
      }

      // ここから下だけが非同期に応答する。true はこの分岐のためにある
      if (action === 'startMonitoring') {
        if (request.chatMode === 'dom') {
          chrome.runtime.sendMessage(
            { action: 'startDomMonitoring', videoId: this.currentVideoId },
            r => sendResponse(r)
          );
        } else {
          this.startBackgroundMonitoring()
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ success: false, error: e.message }));
        }
        return true;
      }

      // ここから先は「このフレーム宛てではない」もの。
      //
      // tabs.sendMessage はタブの**全フレーム**に配られ、応答は最初に返した1つが勝つ。
      // watch ページでは、このスクリプト（トップフレーム）と dom-chat.js
      // （live_chat の iframe）が同じタブに居るので、dom-chat.js 宛ての要求に
      // ここが即答すると**本来の宛先の応答を追い越して**しまう。
      // 実ブラウザで確認済み: 追い越されると Service Worker は
      // 「読み取り状態は不明」を受け取り、popup の表示が消える。
      //
      // 応答しないまま false を返すのは #30 とは別で、害が無い。
      // true（あとで応答する）と違って応答チャネルを開いたままにしないので、
      // 他のフレームが答えればそれが返り、誰も答えなければ送信側は
      // その場でエラーを受け取る（永久に待たされることはない）
      if (DOM_CHAT_ACTIONS.has(action)) return false;

      // 本当に知らない action には必ず応答する（#30）。応答しないまま
      // return true で黙ると、送信側は待ち続けるか
      //「The message port closed before a response was received」を受け取り、
      // それを一時障害とみなしてリトライを空振りする
      sendResponse({ success: false, error: `unknown action: ${action}` });
      return false;
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
  
}

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
  
  // Method 2.5: URLのパスからvideo IDを抽出（/live/video_id形式）
  const liveMatch = url.match(/\/live\/([^/?]+)/);
  if (liveMatch) {
    return liveMatch[1];
  }
  
  // Method 3: meta tagからvideo IDを抽出
  const metaTag = document.querySelector('meta[property="og:url"]');
  if (metaTag) {
    const metaUrl = metaTag.getAttribute('content');
    const metaMatch = metaUrl.match(/[?&]v=([^&]+)/);
    if (metaMatch) {
      return metaMatch[1];
    }
    const metaLiveMatch = metaUrl.match(/\/live\/([^/?]+)/);
    if (metaLiveMatch) {
      return metaLiveMatch[1];
    }
  }
  
  return null;
};


// 取得元のモードの正は storage（SW の getChatMode が既定つきで返す）。
// **既定は DOMモードで、ここで 'api' に倒さないこと** —— APIキーを要求するのは
// APIモードだけであり、未設定の利用者を APIモード扱いにすると
// 「APIキーが無い」というエラーだけが出る
YouTubeLiveChatMonitor.prototype.resolveChatMode = async function() {
  try {
    const modeResponse = await this.sendMessageWithRetry({ action: 'getChatMode' }, 2);
    return modeResponse?.chatMode === 'api' ? 'api' : 'dom';
  } catch (error) {
    debugLog('[YouTube Special Comments] Chat mode lookup failed; assuming DOM mode:',
      error.message);
    return 'dom';
  }
};


YouTubeLiveChatMonitor.prototype.tryDomModeAutoStart = async function(knownChatMode = null) {
  if (this.isMonitoring) return;

  try {
    const chatMode = knownChatMode || await this.resolveChatMode();
    if (chatMode !== 'dom') return;

    const autoStartResponse = await this.sendMessageWithRetry(
      { action: 'getAutoStart' }, 2
    );
    if (!autoStartResponse?.autoStart) return;

    const videoId = this.extractVideoId();
    if (!videoId) return;

    debugLog('[YouTube Special Comments] DOM mode auto-start (background): starting monitoring');
    chrome.runtime.sendMessage({ action: 'startDomMonitoring', videoId });
  } catch (error) {
    debugLog('[YouTube Special Comments] DOM mode auto-start failed silently:', error.message);
  }
};


YouTubeLiveChatMonitor.prototype.tryAutoStart = async function() {
  if (this.isMonitoring) return; // 二重起動防止

  try {
    const autoStartResponse = await this.sendMessageWithRetry(
      { action: 'getAutoStart' }, 2
    );
    if (!autoStartResponse?.autoStart) return;

    const apiKeyResponse = await this.sendMessageWithRetry(
      { action: 'getApiKey' }, 2
    );
    if (!apiKeyResponse?.apiKey) {
      debugLog('[YouTube Special Comments] Auto-start skipped: API key not set');
      return;
    }

    debugLog('[YouTube Special Comments] Auto-start: starting monitoring');
    await this.startBackgroundMonitoring();
  } catch (error) {
    // サイレントに失敗（自動開始のエラーはユーザーに見せない）
    debugLog('[YouTube Special Comments] Auto-start failed silently:', error.message);
  }
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
} // end guard
