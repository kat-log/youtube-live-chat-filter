// デバッグモードによる統一ログ関数
let debugMode = false;

// デバッグモード設定を取得
async function loadDebugMode() {
  try {
    const result = await chrome.storage.local.get(['debugMode']);
    debugMode = result.debugMode || false;
  } catch (error) {
    console.error('[Popup] Failed to load debug mode:', error);
  }
}

// テーマ設定を取得して適用
async function loadTheme() {
  try {
    const { theme } = await chrome.storage.local.get(['theme']);
    document.documentElement.setAttribute('data-theme', theme || 'light');
  } catch (error) {
    console.error('[Popup] Failed to load theme:', error);
  }
}

// 生成中のコントローラ。ストレージ変更を再描画へ橋渡しするために保持する
let popupController = null;

// ストレージ変更時に表示設定をリアルタイム反映。
// ドロワー・オプション画面・別ウィンドウのどこで変えても、経路はここ1本に集約する
chrome.storage.onChanged.addListener((changes) => {
  if (changes.theme) {
    const newTheme = changes.theme.newValue || 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    const toggle = document.getElementById('dark-mode-toggle');
    if (toggle) toggle.checked = (newTheme === 'dark');
  }

  if (changes.timeHour12 || changes.timeShowSeconds) {
    popupController?.applyTimeSettings({
      hour12: changes.timeHour12?.newValue,
      showSeconds: changes.timeShowSeconds?.newValue
    });
  }
});

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

// フィルターの軸は「役割4種」＋「種別2種」。スーパーチャットやメンバー加入は
// 一般視聴者・メンバーのどちらからも飛んでくるので、役割とは別枠で数えて絞る
const FILTER_KEYS = ['owner', 'moderator', 'sponsor', 'normal', 'superchat', 'membership'];

const FILTER_PRESETS = {
    special: { owner: true,  moderator: true,  sponsor: false, normal: false, superchat: true,  membership: true  },
    all:     { owner: true,  moderator: true,  sponsor: true,  normal: true,  superchat: true,  membership: true  },
    none:    { owner: false, moderator: false, sponsor: false, normal: false, superchat: false, membership: false }
};

const ROLE_LABELS = {
    owner:     ['配信者',       'role-owner'],
    moderator: ['モデレーター', 'role-moderator'],
    member:    ['メンバー',     'role-sponsor'],
    normal:    ['一般',         'role-normal']
};

// APIのメッセージ種別 → 表示上の種別。ここに無いものはテキスト扱い
// （Service Worker 側で表示できない種別は既に落とされている）
const KIND_BY_API_TYPE = {
    textMessageEvent: 'text',
    superChatEvent: 'superchat',
    superStickerEvent: 'supersticker',
    newSponsorEvent: 'membership',
    memberMilestoneChatEvent: 'membership',
    membershipGiftingEvent: 'gift'
};

// 種別バッジ。役割バッジ（王冠など）とは別に、行の性格を1文字で示す
const KIND_ICONS = {
    superchat:    ['\u{1F4B0}', 'スーパーチャット'],
    supersticker: ['\u{1F4B0}', 'スーパーステッカー'],
    membership:   ['\u{2728}',  'メンバーシップ'],
    gift:         ['\u{1F381}', 'メンバーシップギフト']
};

// ステッカー画像の配信ホスト。dom-chat.js が組み立てるURLと同じものだけを通す
const STICKER_IMAGE_HOSTS = ['lh3.googleusercontent.com', 'yt3.ggpht.com'];

// 種別が付いているものは種別で、通常のコメントは役割で数える／絞る
function filterKeyOf(comment) {
    const kind = comment.kind || 'text';
    if (kind === 'superchat' || kind === 'supersticker') return 'superchat';
    if (kind === 'membership' || kind === 'gift') return 'membership';
    switch (comment.roleClass) {
        case 'role-owner':     return 'owner';
        case 'role-moderator': return 'moderator';
        case 'role-sponsor':   return 'sponsor';
        default:               return 'normal';
    }
}

class PopupController {
    constructor() {
        this.isMonitoring = false;
        this.comments = [];
        // DOMモードのアバターURL（発言者名 -> URL）。背景側から受け取る
        this.avatarsByAuthor = {};
        this.currentTab = null;
        this.currentVideoId = null;
        this.monitoringVideoId = null; // バックグラウンドが実際に監視中の動画ID
        this.serviceWorkerReady = false;
        this.initializationComplete = false;
        
        // 個別フィルターの状態
        this.commentFilters = { ...FILTER_PRESETS.all };
        
        // ユーザーフィルタリング用の状態
        this.selectedUser = null; // 絞り込み対象のユーザー名（null = 全ユーザー表示）

        // キーワード検索フィルタリング用の状態
        this.searchKeyword = '';
        this._searchDebounceTimer = null;

        // 取得モード
        this.chatMode = 'api';
        this.domModeNeedsReload = false;

        // 自動スクロール追従フラグ（ユーザーが意図的に上スクロールしていない限りtrue）
        this.autoScroll = true;

        // 時刻表示の設定。既定は従来どおり「24時間表記・秒あり」
        this.timeHour12 = false;
        this.timeShowSeconds = true;
        
        debugLog('[YouTube Special Comments] Popup controller starting...');
        this.initializeElements();
        this.attachEventListeners();
        
        // Service Worker準備確認後に初期化を開始
        this.initializeWithServiceWorkerCheck();
    }
    
    // Service Worker確認後の初期化プロセス
    async initializeWithServiceWorkerCheck() {
        try {
            debugLog('[YouTube Special Comments] 🚀 Starting comprehensive initialization process...');
            
            // Step 1: Service Worker準備確認
            this.showInitializationStatus('Step 1/3: Service Workerを確認中...');
            const workerReady = await this.waitForServiceWorker();
            
            if (workerReady) {
                debugLog('[YouTube Special Comments] ✅ Step 1 Complete: Service Worker ready');
            } else {
                debugWarn('[YouTube Special Comments] ⚠️ Step 1 Warning: Service Worker timeout, but continuing');
            }
            
            // Step 2: 基本設定の初期化
            this.showInitializationStatus('Step 2/3: 設定を読み込み中...');
            await this.completeBasicInitialization();
            debugLog('[YouTube Special Comments] ✅ Step 2 Complete: Basic initialization done');
            
            // Step 3: Content Script状態確認と通信テスト
            this.showInitializationStatus('Step 3/3: Content Script通信テスト...');
            const contentScriptReady = await this.checkContentScriptInjection();
            
            if (contentScriptReady) {
                debugLog('[YouTube Special Comments] ✅ Step 3 Complete: Content Script communication established');
                // Step 2で表示されていたエラーパネルをクリア
                this.hideDetailedError();
                this.elements.fixExtensionContainer.style.display = 'none';
                this.showInitializationStatus('初期化完了！');
                await this.delay(500); // 成功メッセージを少し表示
            } else {
                debugWarn('[YouTube Special Comments] ⚠️ Step 3 Warning: Content Script issues detected');
            }
            
            debugLog('[YouTube Special Comments] 🎉 Full initialization process completed');

            // 初期化完了後の最終状態同期：
            // content script が自律的に監視を開始した場合（再注入後の tryDomModeAutoStart）に
            // popup の isMonitoring フラグをバックグラウンドの実態と合わせる
            if (!this.isMonitoring) {
                const finalState = await this.getBackgroundMonitoringState();
                if (finalState.success && finalState.isMonitoring) {
                    this.isMonitoring = true;
                    if (finalState.chatMode) {
                        this.chatMode = finalState.chatMode;
                        this.updateChatModeUI();
                    }
                    this.updateMonitoringButtonStates();
                    this.updateStatus(this.chatMode === 'dom' ? '取得中（DOMモード）' : '取得中');
                }
            }

        } catch (error) {
            console.error('[YouTube Special Comments] ❌ Critical initialization error:', error);
            this.showInitializationStatus('初期化エラーが発生しました');
            
            // フォールバック: 基本的な初期化のみ実行
            await this.emergencyFallbackInitialization();
            
        } finally {
            this.hideInitializationStatus();
            this.initializationComplete = true;
            
            // 最終診断情報をログ出力
            this.logInitializationSummary();
        }
    }
    
    // 基本設定の初期化（Content Scriptチェックを除く）
    async completeBasicInitialization() {
        // 時刻設定は描画より先に確定させる（履歴復元が下の Promise.all 内で走るため、
        // 並列に混ぜると一瞬だけ旧形式で描かれてそのまま残る）
        await this.loadTimeSettings();

        // 初期状態設定
        this.updateMonitoringButtons(false);
        this.updateMonitoringButtonStates();
        
        // 非同期初期化タスクを並行実行
        await Promise.all([
            this.loadSavedApiKey(),
            this.loadCommentFilters(),
            this.loadChatMode(),
            loadTheme(),
            this.checkCurrentTab()
        ]);
        
        // メッセージリスナーを設定
        this.setupMessageListener();

        // DOMモード自動取得
        await this.tryDomAutoStart();
    }
    
    // 緊急時のフォールバック初期化
    async emergencyFallbackInitialization() {
        console.log('[YouTube Special Comments] 🆘 Running emergency fallback initialization');
        
        try {
            this.updateMonitoringButtons(false);
            this.updateMonitoringButtonStates();
            this.setupMessageListener();
            
            // 最低限のタブ情報を設定
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.currentTab = tab;
            
            console.log('[YouTube Special Comments] ✅ Emergency fallback completed');
        } catch (error) {
            console.error('[YouTube Special Comments] ❌ Emergency fallback also failed:', error);
            this.showError('拡張機能の初期化に失敗しました。ブラウザを再起動してください。');
        }
    }
    
    // 初期化サマリーをログ出力
    logInitializationSummary() {
        const summary = {
            timestamp: new Date().toISOString(),
            serviceWorkerReady: this.serviceWorkerReady,
            initializationComplete: this.initializationComplete,
            currentTab: this.currentTab ? {
                id: this.currentTab.id,
                url: this.currentTab.url,
                isYouTube: this.currentTab.url.includes('youtube.com')
            } : null,
            apiKeyLoaded: !!this.elements.apiKeyInput.value,
            filterSettings: this.commentFilters
        };
        
        console.log('[YouTube Special Comments] 📋 Initialization Summary:', summary);
    }
    
    // Service Worker準備状態確認
    async waitForServiceWorker(maxAttempts = 8, delayMs = 300) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[YouTube Special Comments] Service worker check attempt ${attempt}/${maxAttempts}`);
                
                const response = await this.sendMessageWithTimeout({
                    action: 'ping'
                }, 2000);
                
                if (response && response.success) {
                    console.log('[YouTube Special Comments] ✅ Service worker ping successful');
                    this.serviceWorkerReady = true;
                    return true;
                }
            } catch (error) {
                console.log(`[YouTube Special Comments] Service worker ping failed (attempt ${attempt}):`, error.message);
                
                if (attempt < maxAttempts) {
                    // 短い間隔で再試行
                    await this.delay(delayMs);
                }
            }
        }
        
        console.warn('[YouTube Special Comments] Service worker readiness check timeout');
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
    
    
    // Content Script注入状態の確認
    async checkContentScriptInjection() {
        // 既に監視中であればcontent scriptは動作している
        if (this.isMonitoring) {
            console.log('[YouTube Special Comments] Already monitoring, skipping content script check');
            return true;
        }

        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        if (!isYouTubePage) {
            console.log('[YouTube Special Comments] Not a YouTube watch or live page, skipping content script check');
            return true;
        }
        
        console.log('[YouTube Special Comments] Checking content script injection status...');
        
        try {
            // Content Scriptとの通信をテスト
            // 短すぎるとページ読み込み直後の初期化中を「未注入」と誤判定し、
            // 不要な再注入を招くため3秒待つ
            const response = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 3000);
            
            if (response) {
                console.log('[YouTube Special Comments] ✅ Content script is properly injected');
                return true;
            } else {
                throw new Error('No response from content script');
            }
        } catch (error) {
            console.log('[YouTube Special Comments] Content script not detected (expected on first use):', error.message);
            
            // 自動回復を試行
            return await this.attemptContentScriptRecovery();
        }
    }
    
    // Content Script回復試行
    async attemptContentScriptRecovery() {
        console.log('[YouTube Special Comments] 🔄 Attempting content script recovery...');
        this.showInitializationStatus('Content Scriptを修復中...');
        
        try {
            // 1. Service Workerから最後の注入結果を確認
            const injectionResult = await this.sendMessageWithRetry({
                action: 'getLastInjectionResult'
            }, 2);
            
            console.log('[YouTube Special Comments] Last injection result:', injectionResult);
            
            // 2. 手動でContent Script再注入を要求
            // 対象は現在のタブのみ。全タブに注入すると、正常に動いている
            // 他のYouTubeタブにまで不要な注入を行うことになる
            console.log('[YouTube Special Comments] Requesting manual content script re-injection...');
            const reinjectResponse = await this.sendMessageWithRetry({
                action: 'reinjectContentScripts',
                tabId: this.currentTab?.id
            }, 2);
            
            if (reinjectResponse && reinjectResponse.success) {
                console.log('[YouTube Special Comments] ✅ Content script re-injection requested successfully');

                // 3. 再注入後の確認（待機時間を延長: 2秒→3秒）
                await this.delay(3000);

                // pingリトライ（最大3回、1秒間隔）
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const verified = await this.verifyContentScriptAfterRecovery();
                    if (verified) return true;
                    if (attempt < 3) {
                        console.log(`[YouTube Special Comments] Ping attempt ${attempt} failed, retrying in 1s...`);
                        await this.delay(1000);
                    }
                }

                // 3回試みても応答なし → リロードボタン表示
                this.showContentScriptError();
                return false;
            } else {
                throw new Error('Re-injection request failed');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] ❌ Content script recovery failed:', error);
            this.showContentScriptError();
            return false;
        }
    }
    
    // 回復後のContent Script確認
    async verifyContentScriptAfterRecovery() {
        console.log('[YouTube Special Comments] Verifying content script after recovery...');
        
        try {
            const response = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 2000);
            
            if (response) {
                console.log('[YouTube Special Comments] ✅ Content script recovery successful!');
                this.hideInitializationStatus();
                this.hideDetailedError();
                this.elements.fixExtensionContainer.style.display = 'none';
                return true;
            } else {
                throw new Error('Still no response after recovery');
            }
        } catch (error) {
            console.warn('[YouTube Special Comments] ⚠️ Content script still not responding after recovery');
            // showContentScriptError()は呼び出し元(attemptContentScriptRecovery)で制御
            return false;
        }
    }
    
    // Content Script問題の表示
    showContentScriptError() {
        this.showError('初回インストール後はページのリロードが必要です。以下のボタンで再読み込みしてください。');

        // ボタンをリロードとして設定
        const btn = this.elements.fixExtensionBtn;
        btn.textContent = 'ページを再読み込み';
        btn.dataset.action = 'reload';
        this.elements.fixExtensionContainer.style.display = 'block';

        // 詳細なエラー情報を表示
        this.showDetailedError({
            title: '初回インストール後のリロードが必要です',
            message: 'インストール直後は既存のタブにContent Scriptが読み込まれていません',
            solution: '「ページを再読み込み」ボタンで現在のタブを更新すると解決します。2回目以降は自動的に動作します。',
            action: 'reload',
            severity: 'high'
        });
    }
    
    // 拡張機能修復機能
    async fixExtension() {
        console.log('[YouTube Special Comments] 🔧 Starting extension repair process...');
        this.elements.fixExtensionBtn.disabled = true;
        this.elements.fixExtensionBtn.textContent = '修復中...';
        this.showInitializationStatus('拡張機能を修復中...');
        
        try {
            // Step 1: Content Script再注入を要求
            console.log('[YouTube Special Comments] Step 1: Requesting content script re-injection');
            this.showInitializationStatus('Content Scriptを再注入中...');
            
            const reinjectResponse = await this.sendMessageWithRetry({
                action: 'reinjectContentScripts',
                tabId: this.currentTab?.id
            }, 3);
            
            if (!reinjectResponse || !reinjectResponse.success) {
                throw new Error('Content script re-injection failed');
            }
            
            // Step 2: 注入完了を待機
            console.log('[YouTube Special Comments] Step 2: Waiting for injection to complete');
            this.showInitializationStatus('注入完了を待機中...');
            await this.delay(3000); // 注入処理の完了を待つ
            
            // Step 3: Content Script通信テスト
            console.log('[YouTube Special Comments] Step 3: Testing content script communication');
            this.showInitializationStatus('通信をテスト中...');
            
            const testResponse = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 3000);
            
            if (testResponse && testResponse.success) {
                console.log('[YouTube Special Comments] ✅ Extension repair successful!');
                this.showInitializationStatus('修復完了！');
                
                // 成功時の処理
                this.hideDetailedError();
                this.showError('');
                this.elements.fixExtensionContainer.style.display = 'none';
                this.showMessage('拡張機能を修復しました！', 'success');
                
                // 初期化プロセスを完了
                await this.delay(1000);
                
            } else {
                throw new Error('Content script still not responding after repair');
            }
            
        } catch (error) {
            console.error('[YouTube Special Comments] ❌ Extension repair failed:', error);
            this.showInitializationStatus('修復失敗');
            
            // 失敗時のフォールバック: タブ再読み込みを提案
            this.showDetailedError({
                title: '修復失敗',
                message: '自動修復に失敗しました',
                solution: 'このタブを手動で再読み込みしてください。Ctrl+F5 または Cmd+R を押してください。',
                action: 'reload',
                severity: 'high'
            });
            
            // タブ再読み込み用のボタンテキストを変更
            this.elements.fixExtensionBtn.textContent = 'タブを再読み込み';
            this.elements.fixExtensionBtn.disabled = false;
            this.elements.fixExtensionBtn.onclick = () => this.reloadCurrentTab();
            
        } finally {
            await this.delay(1000);
            this.hideInitializationStatus();
            
            // 通常の修復ボタン状態に戻す
            if (this.elements.fixExtensionBtn.textContent === '修復中...') {
                this.elements.fixExtensionBtn.textContent = '修復';
                this.elements.fixExtensionBtn.disabled = false;
            }
        }
    }
    
    // タブ再読み込み機能
    async reloadCurrentTab() {
        console.log('[YouTube Special Comments] Reloading current tab...');
        
        try {
            await chrome.tabs.reload(this.currentTab.id);
            console.log('[YouTube Special Comments] Tab reload initiated');
            
            // ポップアップを閉じる（タブ再読み込み後にユーザーが再度開く）
            window.close();
        } catch (error) {
            console.error('[YouTube Special Comments] Failed to reload tab:', error);
            this.showError('タブの再読み込みに失敗しました。手動でページを更新してください。');
        }
    }
    
    // タイムアウト付きタブメッセージ送信（より短いタイムアウト）
    async sendTabMessageWithTimeout(tabId, message, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Tab message timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            
            chrome.tabs.sendMessage(tabId, message, (response) => {
                clearTimeout(timeout);
                
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
    }
    
    // 初期化状態表示
    showInitializationStatus(message) {
        // 既存のローディング表示を使用
        this.showLoading(true);
        
        // カスタムステータスメッセージがあれば表示
        const statusElement = document.getElementById('initialization-status');
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.style.display = 'block';
        }
    }
    
    // 初期化状態表示を隠す
    hideInitializationStatus() {
        this.showLoading(false);
        
        const statusElement = document.getElementById('initialization-status');
        if (statusElement) {
            statusElement.style.display = 'none';
        }
    }
    
    initializeElements() {
        this.elements = {
            statusIndicator: document.getElementById('status-indicator'),
            apiKeyInput: document.getElementById('api-key-input'),
            saveApiKeyBtn: document.getElementById('save-api-key'),
            startMonitoringBtn: document.getElementById('start-monitoring'),
            stopMonitoringBtn: document.getElementById('stop-monitoring'),
            clearCommentsBtn: document.getElementById('clear-comments'),
            fixExtensionBtn: document.getElementById('fix-extension'),
            fixExtensionContainer: document.getElementById('fix-extension-container'),
            
            // 個別フィルタートグル
            ownerToggle: document.getElementById('owner-toggle'),
            moderatorToggle: document.getElementById('moderator-toggle'),
            sponsorToggle: document.getElementById('sponsor-toggle'),
            normalToggle: document.getElementById('normal-toggle'),
            superchatToggle: document.getElementById('superchat-toggle'),
            membershipToggle: document.getElementById('membership-toggle'),
            
            // プリセットボタン
            presetSpecial: document.getElementById('preset-special'),
            presetAll: document.getElementById('preset-all'),
            presetNone: document.getElementById('preset-none'),
            
            commentsTitle: document.getElementById('comments-title'),
            commentsList: document.getElementById('comments-list'),
            noComments: document.getElementById('no-comments'),
            
            // コメント数表示
            totalCount: document.getElementById('total-count'),
            ownerCount: document.getElementById('owner-count'),
            moderatorCount: document.getElementById('moderator-count'),
            sponsorCount: document.getElementById('sponsor-count'),
            normalCount: document.getElementById('normal-count'),
            superchatCount: document.getElementById('superchat-count'),
            membershipCount: document.getElementById('membership-count'),
            
            loading: document.getElementById('loading'),
            errorMessage: document.getElementById('error-message'),
            successMessage: document.getElementById('success-overlay'),
            errorOverlay: document.getElementById('error-overlay'),
            currentVideoId: document.getElementById('current-video-id'),
            
            // 詳細エラー表示要素
            errorDetails: document.getElementById('error-details'),
            errorTitle: document.getElementById('error-title'),
            errorDescription: document.getElementById('error-description'),
            errorSolution: document.getElementById('error-solution'),
            retryButton: document.getElementById('retry-button'),
            optionsButton: document.getElementById('options-button'),
            
            // ユーザーフィルター関連要素
            userFilterStatus: document.getElementById('user-filter-status'),
            filteredUsername: document.getElementById('filtered-username'),
            clearUserFilterBtn: document.getElementById('clear-user-filter'),
            searchFilterBar: document.getElementById('search-filter-bar'),
            searchKeywordInput: document.getElementById('search-keyword-input'),
            clearSearchBtn: document.getElementById('clear-search-btn'),
            searchMatchCount: document.getElementById('search-match-count'),

            // モード選択
            chatModeToggle: document.getElementById('chat-mode-toggle'),
            modeSelectWrapper: document.getElementById('mode-select-wrapper'),
            domModeHelp: document.getElementById('dom-mode-help'),
            apiKeySection: document.getElementById('api-key-section'),
            domModeReloadNotice: document.getElementById('dom-mode-reload-notice'),
            reloadPageForDomBtn: document.getElementById('reload-page-for-dom')
        };
    }
    
    attachEventListeners() {
        this.elements.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
        this.elements.startMonitoringBtn.addEventListener('click', () => this.startMonitoring());
        this.elements.stopMonitoringBtn.addEventListener('click', () => this.stopMonitoring());
        this.elements.clearCommentsBtn.addEventListener('click', () => this.clearComments());
        this.elements.fixExtensionBtn.addEventListener('click', () => {
            if (this.elements.fixExtensionBtn.dataset.action === 'reload') {
                this.reloadCurrentTab();
            } else {
                this.fixExtension();
            }
        });
        
        // 個別フィルタートグルと、コメント数バッジクリックによる直接フィルター
        for (const key of FILTER_KEYS) {
            this.elements[key + 'Toggle'].addEventListener('change', () => this.onFilterToggleChange(key));
            const badge = this.elements[key + 'Count'];
            badge.addEventListener('click', () => this.toggleBadgeFilter(key));
            // role="button" を持たせた span なので、Enter/Space の既定動作は自前で補う
            badge.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                this.toggleBadgeFilter(key);
            });
        }
        
        // プリセットボタン
        this.elements.presetSpecial.addEventListener('click', () => this.applyPreset('special'));
        this.elements.presetAll.addEventListener('click', () => this.applyPreset('all'));
        this.elements.presetNone.addEventListener('click', () => this.applyPreset('none'));
        
        this.elements.apiKeyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveApiKey();
            }
        });
        
        // エラー詳細のボタンイベント
        this.elements.retryButton.addEventListener('click', () => this.handleRetry());
        this.elements.optionsButton.addEventListener('click', () => this.openOptionsPage());
        
        // ユーザーフィルター関連のイベント
        this.elements.clearUserFilterBtn.addEventListener('click', () => this.clearUserFilter());

        // キーワード検索関連のイベント
        this.elements.searchKeywordInput.addEventListener('input', () => this.onSearchInput());
        this.elements.clearSearchBtn.addEventListener('click', () => this.clearSearch());

        // モード切替
        this.elements.chatModeToggle.addEventListener('change', () => this.onChatModeChange());

        // DOMモード リロードボタン
        if (this.elements.reloadPageForDomBtn) {
            this.elements.reloadPageForDomBtn.addEventListener('click', () => this.reloadPageForDom());
        }

        // コメントリストのスクロールイベント（自動追従フラグの更新）
        this.elements.commentsList.addEventListener('scroll', () => {
            this.autoScroll = this.isAtBottom();
            this.updateScrolledToBottom();
        });
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
            console.log('[Popup] Received message:', request.action, 'with', request.comments?.length || 0, 'comments');
            if (request.action === 'newSpecialComments') {
                // formatComment がアバターを引けるよう、コメントより先に取り込む
                Object.assign(this.avatarsByAuthor, request.avatars || {});
                this.addNewComments(request.comments);
            } else if (request.action === 'monitoringAutoStopped') {
                this.handleAutoStop(request.reason);
            } else if (request.action === 'showDetailedError') {
                // DOMモードではAPIキー関連エラーを表示しない
                if (this.chatMode === 'dom' && request.errorInfo?.action === 'setApiKey') {
                    return;
                }
                this.showDetailedError(request.errorInfo);
            }
        });
    }
    
    async loadChatMode() {
        try {
            const result = await chrome.storage.local.get(['chatMode', 'domModeNeedsReload']);
            this.chatMode = result.chatMode || 'dom';
            this.domModeNeedsReload = result.domModeNeedsReload || false;
            this.updateChatModeUI();
            this.updateMonitoringButtonStates();
            // DOMモードで開いた場合はAPIキー関連エラーを消去
            if (this.chatMode === 'dom') {
                this.hideDetailedError();
                this.showError('');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading chat mode:', error);
        }
    }

    updateChatModeUI() {
        if (this.elements.chatModeToggle) {
            this.elements.chatModeToggle.value = this.chatMode;
        }
        const isDom = this.chatMode === 'dom';
        if (this.elements.domModeHelp) {
            this.elements.domModeHelp.style.display = isDom ? 'block' : 'none';
        }
        if (this.elements.apiKeySection) {
            this.elements.apiKeySection.style.display = isDom ? 'none' : 'block';
        }
        if (this.elements.domModeReloadNotice) {
            this.elements.domModeReloadNotice.style.display = (isDom && this.domModeNeedsReload) ? 'flex' : 'none';
        }
    }

    async onChatModeChange() {
        if (this.isMonitoring) {
            this.showMessage('取得中はモードを切り替えられません。取得を停止してから変更してください。', 'error');
            // トグルを元の値に戻す
            this.elements.chatModeToggle.value = this.chatMode;
            return;
        }
        this.chatMode = this.elements.chatModeToggle.value;
        await chrome.storage.local.set({ chatMode: this.chatMode });
        if (this.chatMode === 'dom') {
            this.hideDetailedError();
            this.showError('');
        }
        this.updateChatModeUI();
        this.updateMonitoringButtonStates();
    }

    async reloadPageForDom() {
        await chrome.storage.local.set({ domModeNeedsReload: false });
        this.domModeNeedsReload = false;
        if (this.currentTab) {
            chrome.tabs.reload(this.currentTab.id);
        }
    }

    async loadSavedApiKey() {
        try {
            const response = await this.sendMessageWithRetry({ action: 'getApiKey' }, 3);
            if (response && response.apiKey) {
                this.elements.apiKeyInput.value = response.apiKey;
                this.updateMonitoringButtons(true);
                console.log('[YouTube Special Comments] ✅ API key loaded successfully');
            } else {
                console.log('[YouTube Special Comments] No API key found in storage');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading API key:', error);
            this.showError('APIキーの読み込みに失敗しました。ページを再読み込みしてください。');
        }
    }
    
    async saveApiKey() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        if (!apiKey) {
            this.showMessage('APIキーを入力してください', 'error');
            return;
        }
        
        this.showLoading(true);
        
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveApiKey',
                apiKey: apiKey
            });
            
            if (response.success) {
                this.showError('');
                this.updateMonitoringButtons(true);
                this.showMessage('APIキーが保存されました', 'success');
            }
        } catch (error) {
            this.showError('APIキーの保存に失敗しました: ' + error.message);
        } finally {
            this.showLoading(false);
        }
    }
    
    async checkCurrentTab() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.currentTab = tab;
            
            console.log('[YouTube Special Comments] Current tab:', tab.url);
            
            const isYouTubePage = tab.url && (tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/live/'));
            if (isYouTubePage) {
                this.updateStatus('YouTube ページ');
                await this.loadExistingComments();
            } else {
                this.updateStatus('YouTube以外のページ');
                this.updateMonitoringButtons(false);
            }
        } catch (error) {
            console.error('Error checking current tab:', error);
            this.updateStatus('エラー');
        }
    }
    
    async loadExistingComments() {
        try {
            console.log('[YouTube Special Comments] === Starting comment history restoration ===');
            
            // Step 1: 現在のVideo IDを取得
            const currentVideoId = await this.getCurrentVideoId();
            this.currentVideoId = currentVideoId;
            console.log('[YouTube Special Comments] Current video ID:', currentVideoId);
            
            // Step 2: Background scriptから監視状態を取得
            const monitoringState = await this.getBackgroundMonitoringState();
            console.log('[YouTube Special Comments] Background monitoring state:', monitoringState);
            
            // Step 3: 監視状態を更新
            if (monitoringState.success) {
                this.isMonitoring = monitoringState.isMonitoring;
                // バックグラウンドが実際に監視している動画ID（現在のタブと一致しない場合がある）
                this.monitoringVideoId = monitoringState.currentVideoId || null;
                // chatMode は監視中の場合のみバックグラウンドと同期する
                // （非監視時は chrome.storage.local の値を優先する）
                if (monitoringState.isMonitoring && monitoringState.chatMode) {
                    this.chatMode = monitoringState.chatMode;
                    this.updateChatModeUI();
                }
                this.updateMonitoringButtonStates();

                if (this.isMonitoring) {
                    this.updateStatus(this.chatMode === 'dom' ? '取得中（DOMモード）' : '取得中');
                } else {
                    this.updateStatus('停止済み');
                }
            }
            
            // Step 4: Video ID表示を更新
            this.updateVideoIdDisplay();
            
            // Step 5: コメント履歴を復元
            await this.restoreCommentHistory(currentVideoId);
            
            // Step 6: Content scriptの状態をチェック（監視していない場合のみ）
            if (!this.isMonitoring) {
                await this.checkContentScriptStatus();
            }
            
            console.log('[YouTube Special Comments] === Comment history restoration completed ===');
            
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading existing comments:', error);
            this.showError('コメント履歴の読み込みに失敗しました。');
            this.updateStatus('エラー');
        }
    }
    
    async getCurrentVideoId() {
        // Content scriptから取得を試行
        try {
            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'getSpecialComments'
            }, 2);
            
            if (response && response.videoId) {
                console.log('[YouTube Special Comments] Video ID from content script:', response.videoId);
                return response.videoId;
            }
        } catch (contentError) {
            console.log('[YouTube Special Comments] Content script not available:', contentError);
        }
        
        // URLから抽出
        if (this.currentTab.url) {
            const urlMatch = this.currentTab.url.match(/[?&]v=([^&]+)/);
            if (urlMatch) {
                console.log('[YouTube Special Comments] Video ID from URL:', urlMatch[1]);
                return urlMatch[1];
            }
            const liveMatch = this.currentTab.url.match(/\/live\/([^/?]+)/);
            if (liveMatch) {
                console.log('[YouTube Special Comments] Video ID from URL (live):', liveMatch[1]);
                return liveMatch[1];
            }
        }
        
        console.log('[YouTube Special Comments] Could not extract video ID');
        return null;
    }
    
    async getBackgroundMonitoringState() {
        try {
            const response = await this.sendMessageWithRetry({
                action: 'getMonitoringState'
            }, 2);
            
            return response || { success: false };
        } catch (error) {
            console.log('[YouTube Special Comments] Error getting monitoring state:', error.message);
            return { success: false };
        }
    }
    
    async restoreCommentHistory(currentVideoId) {
        if (!currentVideoId) {
            console.log('[YouTube Special Comments] No video ID available, clearing comments');
            this.comments = [];
            this.renderComments();
            return;
        }
        
        let targetVideoId = currentVideoId;
        
        // プライマリ取得を試行
        let historyLoaded = false;
        try {
            const historyResponse = await this.sendMessageWithRetry({
                action: 'getCommentsHistory',
                videoId: targetVideoId
            }, 2);
            
            console.log('[YouTube Special Comments] History response for', targetVideoId + ':', {
                success: historyResponse?.success,
                commentsCount: historyResponse?.comments?.length || 0
            });
            
            if (historyResponse?.success && historyResponse.comments && historyResponse.comments.length > 0) {
                Object.assign(this.avatarsByAuthor, historyResponse.avatars || {});
                const formattedComments = this.formatHistoryComments(historyResponse.comments);
                this.comments = formattedComments;
                this.renderComments();
                console.log('[YouTube Special Comments] Successfully restored', formattedComments.length, 'comments');
                historyLoaded = true;
            }
        } catch (error) {
            console.log('[YouTube Special Comments] Primary history loading failed:', error.message);
        }
        
        // フォールバック1: Content scriptから直接コメントを取得
        if (!historyLoaded) {
            console.log('[YouTube Special Comments] === Fallback 1: Getting comments from content script ===');
            try {
                const contentResponse = await this.sendTabMessageWithRetry(this.currentTab.id, {
                    action: 'getSpecialComments'
                }, 2);
                
                if (contentResponse?.comments && contentResponse.comments.length > 0) {
                    const formattedComments = this.formatHistoryComments(contentResponse.comments);
                    this.comments = formattedComments;
                    this.renderComments();
                    console.log('[YouTube Special Comments] Fallback 1 successful: loaded', formattedComments.length, 'comments from content script');
                    historyLoaded = true;
                }
            } catch (error) {
                console.log('[YouTube Special Comments] Fallback 1: content script not ready, continuing with empty state');
            }
        }
        
        // 最終フォールバック: 空の状態で表示
        if (!historyLoaded) {
            console.log('[YouTube Special Comments] === All fallbacks failed, starting with empty comments ===');
            this.comments = [];
            this.renderComments();
            
            // 空の状態でも監視中であることを示すメッセージを表示
            if (this.isMonitoring) {
                console.log('[YouTube Special Comments] Monitoring is active but no history found - new comments will appear');
            }
        }
    }
    
    formatHistoryComments(rawComments) {
        return rawComments.map((comment, index) => {
            try {
                return this.formatComment(comment);
            } catch (error) {
                console.error(`[YouTube Special Comments] Error formatting comment ${index}:`, error);
                return null;
            }
        }).filter(comment => comment !== null);
    }
    
    async checkContentScriptStatus() {
        try {
            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'getSpecialComments'
            }, 2);
            
            if (response && response.liveChatId) {
                this.updateStatus('ライブチャット検出済み');
            } else {
                this.updateStatus('ライブチャット未検出');
            }
        } catch (contentError) {
            console.log('[YouTube Special Comments] Content script not available');
            this.updateStatus('ライブチャット未検出');
        }
    }
    
    async tryDomAutoStart() {
        // 「取得中」なのにバックグラウンドが別の動画（または不明な動画）を掴んだままだと
        // 現在のタブのコメントが永久に届かないため、その場合は開始し直す
        const isStaleSession = this.isMonitoring && this.monitoringVideoId !== this.currentVideoId;
        if (isStaleSession) {
            debugLog('[YouTube Special Comments] Stale monitoring session detected:',
                this.monitoringVideoId, '->', this.currentVideoId);
            this.isMonitoring = false;
        }
        if (this.isMonitoring) return;
        if (this.chatMode !== 'dom') return;
        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        if (!isYouTubePage) return;

        try {
            const response = await this.sendMessageWithRetry({ action: 'getAutoStart' }, 2);
            if (!response?.autoStart) return;

            debugLog('[YouTube Special Comments] DOM mode auto-start: starting monitoring');
            await this.startMonitoring(true); // suppressErrors: 初期化フローのStep 3でエラーハンドリングするため
        } catch (error) {
            debugLog('[YouTube Special Comments] DOM mode auto-start failed silently:', error.message);
        }
    }

    async startMonitoring(suppressErrors = false) {
        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        if (!isYouTubePage) {
            if (!suppressErrors) this.showError('YouTubeのライブ配信ページで使用してください');
            return;
        }
        
        console.log('[YouTube Special Comments] Starting monitoring...');
        this.showLoading(true);
        this.showError(''); // エラーメッセージをクリア
        
        try {
            if (this.chatMode === 'dom') {
                // DOM モード：APIキーチェック不要、直接 background へ委譲
                const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                    action: 'startMonitoring',
                    chatMode: 'dom'
                }, 3);

                console.log('[YouTube Special Comments] Start DOM monitoring response:', response);

                if (response && response.success) {
                    this.isMonitoring = true;
                    this.monitoringVideoId = this.currentVideoId;
                    this.updateMonitoringButtonStates();
                    this.updateStatus('取得中（DOMモード）');
                    this.showError('');
                    this.hideDetailedError();
                    this.elements.fixExtensionContainer.style.display = 'none';
                } else if (!suppressErrors) {
                    this.showError('DOMモードでの取得開始に失敗しました。');
                }
                return;
            }

            // APIキーの存在確認
            const apiKeyResponse = await this.sendMessageWithRetry({ action: 'getApiKey' }, 2);
            if (!apiKeyResponse || !apiKeyResponse.apiKey) {
                this.showError('YouTube Data APIキーが設定されていません。オプション画面で設定してください。');
                return;
            }

            // content scriptが応答するかテスト
            const testResponse = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'getSpecialComments'
            }, 3);

            console.log('[YouTube Special Comments] Content script test response:', testResponse);

            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'startMonitoring'
            }, 3);
            
            console.log('[YouTube Special Comments] Start monitoring response:', response);
            
            if (response && response.success) {
                this.isMonitoring = true;
                this.monitoringVideoId = this.currentVideoId;
                this.updateMonitoringButtonStates();
                this.updateStatus('取得中');
                this.showError('');
                this.hideDetailedError();
                this.elements.fixExtensionContainer.style.display = 'none';
            } else {
                this.showError('取得を開始できませんでした。ライブチャットが見つからない可能性があります。');
            }
        } catch (error) {
            if (suppressErrors || error.message.includes('Could not establish connection')) {
                console.log('[YouTube Special Comments] Start monitoring: content script not ready (expected on first use):', error.message);
            } else {
                console.error('[YouTube Special Comments] Start monitoring error:', error);
            }

            if (!suppressErrors) {
                // エラーメッセージの改善
                if (error.message.includes('Could not establish connection')) {
                    this.showContentScriptError();
                } else if (error.message.includes('API key')) {
                    this.showError('APIキーが設定されていません。オプション画面で設定してください。');
                } else if (error.message.includes('No active live chat')) {
                    this.showError('このビデオはライブ配信ではないか、チャットが無効になっています。');
                } else if (error.message.includes('quota')) {
                    this.showError('YouTube API の使用量制限に達しました。しばらく待ってから再試行してください。');
                } else {
                    this.showError(`取得の開始に失敗しました: ${error.message}`);
                }
            }
        } finally {
            this.showLoading(false);
        }
    }
    
    async stopMonitoring() {
        console.log('[YouTube Special Comments] Stopping monitoring...');
        this.showLoading(true);
        
        try {
            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'stopMonitoring'
            }, 3);
            
            console.log('[YouTube Special Comments] Stop monitoring response:', response);
            
            if (response && response.success) {
                this.isMonitoring = false;
                this.updateMonitoringButtonStates();
                this.updateStatus('停止済み');
                this.showError('');
            } else {
                this.showError('取得を停止できませんでした');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Stop monitoring error:', error);
            if (error.message.includes('Could not establish connection')) {
                this.showError('ページを再読み込みしてみてください。（Content scriptが読み込まれていません...）');
                // 強制的に停止状態にする
                this.isMonitoring = false;
                this.updateMonitoringButtonStates();
                this.updateStatus('停止済み');
            } else {
                this.showError('取得の停止に失敗しました: ' + error.message);
            }
        } finally {
            this.showLoading(false);
        }
    }
    
    async clearComments() {
        try {
            await this.sendMessageWithRetry({
                action: 'clearCommentsHistory',
                videoId: this.currentVideoId
            }, 2);
        } catch (e) {
            console.warn('[Popup] Failed to clear storage history:', e);
        }
        // content script のキャッシュもクリア
        try {
            await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'clearSpecialComments'
            }, 1);
        } catch (e) {
            // content script が存在しない場合は無視
        }
        this.comments = [];
        this.avatarsByAuthor = {};
        this.renderComments(true); // コメントクリア時はトップにスクロール
    }
    
    addNewComments(newComments) {
        console.log('[Popup] === addNewComments called ===');
        console.log('[Popup] Received', newComments.length, 'new comments');
        console.log('[Popup] Current comments count before adding:', this.comments.length);
        
        const formattedComments = newComments.map(comment => this.formatComment(comment));
        
        // 重複チェック：既存のコメントと同じタイムスタンプ・メッセージ・ユーザー名のものを除外。
        // 本文なしのスパチャは金額しか差が無く、全件スキャンで拾う過去分の時刻は
        // 分単位なので、金額とイベント文言も見ないと別々の投げ銭が1件に潰れる
        const uniqueComments = formattedComments.filter(newComment => {
            return !this.comments.some(existingComment =>
                existingComment.message === newComment.message &&
                existingComment.displayName === newComment.displayName &&
                existingComment.publishedAt === newComment.publishedAt &&
                existingComment.amountText === newComment.amountText &&
                existingComment.eventText === newComment.eventText
            );
        });
        
        console.log('[Popup] Adding', uniqueComments.length, 'unique comments out of', formattedComments.length, 'total');
        
        this.comments.push(...uniqueComments);
        
        if (this.comments.length > 10000) {
            this.comments = this.comments.slice(-10000);
            console.log('[Popup] Trimmed comments to 10000, current count:', this.comments.length);
        }
        
        console.log('[Popup] Final comments count after adding:', this.comments.length);
        this.renderComments();
    }
    
    formatComment(comment) {
        // DOM モードのコメントは authorDetails を持たない。
        // スパチャやメンバー加入は本文が空のことがあるので、本文の有無では判定しない
        if (!comment.authorDetails) {
            const [role, roleClass] = ROLE_LABELS[comment.role] || ROLE_LABELS.normal;
            return {
                kind: comment.kind || 'text',
                role,
                roleClass,
                displayName: comment.displayName || '',
                message: comment.message || '',
                amountText: comment.amountText || null,
                eventText: comment.eventText || null,
                // スーパーステッカーの画像URL。DOMモードでしか付かない
                stickerUrl: comment.stickerUrl || null,
                // 整形は描画時に行う。ここで文字列に固めると表示形式の切り替えが
                // 既存コメントに効かなくなる
                publishedAt: comment.publishedAt,
                // 新着はコメントに同梱、履歴は発言者マップから引く
                profileImageUrl: comment.avatarUrl || this.avatarsByAuthor[comment.displayName] || null
            };
        }

        const authorDetails = comment.authorDetails;
        const snippet = comment.snippet || {};

        let roleKey = 'normal';
        if (authorDetails.isChatOwner) {
            roleKey = 'owner';
        } else if (authorDetails.isChatModerator) {
            roleKey = 'moderator';
        } else if (authorDetails.isChatSponsor) {
            roleKey = 'member';
        }
        const [role, roleClass] = ROLE_LABELS[roleKey];

        const kind = KIND_BY_API_TYPE[snippet.type] || 'text';
        const { message, amountText, eventText } = this.formatApiDetail(kind, snippet);

        return {
            kind,
            role: role,
            roleClass: roleClass,
            displayName: authorDetails.displayName,
            message,
            amountText,
            eventText,
            publishedAt: snippet.publishedAt,
            profileImageUrl: authorDetails.profileImageUrl
        };
    }

    // APIの snippet から本文・金額・イベント文言を取り出す。
    // 種別ごとに詳細の入れ物が違い、displayMessage が無いものもある
    formatApiDetail(kind, snippet) {
        const fallback = snippet.displayMessage || '';

        if (kind === 'superchat') {
            const details = snippet.superChatDetails || {};
            return {
                message: details.userComment || '',
                amountText: details.amountDisplayString || null,
                eventText: null
            };
        }

        if (kind === 'supersticker') {
            const details = snippet.superStickerDetails || {};
            return {
                message: details.superStickerMetadata?.altText || fallback,
                amountText: details.amountDisplayString || null,
                eventText: 'スーパーステッカー'
            };
        }

        if (kind === 'membership') {
            const milestone = snippet.memberMilestoneChatDetails;
            const newSponsor = snippet.newSponsorDetails;
            if (milestone) {
                const level = milestone.memberLevelName ? ` · ${milestone.memberLevelName}` : '';
                return {
                    message: milestone.userComment || '',
                    amountText: null,
                    eventText: `${milestone.memberMonth}か月連続のメンバー${level}`
                };
            }
            const level = newSponsor?.memberLevelName ? ` · ${newSponsor.memberLevelName}` : '';
            const label = newSponsor?.isUpgrade ? 'メンバーシップをアップグレード' : '新規メンバー';
            return { message: '', amountText: null, eventText: `${label}${level}` };
        }

        if (kind === 'gift') {
            const details = snippet.membershipGiftingDetails;
            const level = details?.giftMembershipsLevelName ? ` · ${details.giftMembershipsLevelName}` : '';
            const count = details?.giftMembershipsCount;
            return {
                message: '',
                amountText: null,
                eventText: count ? `メンバーシップギフト ${count}個${level}` : 'メンバーシップギフト'
            };
        }

        return { message: fallback, amountText: null, eventText: null };
    }
    
    // スクロール位置が一番下かどうかを判定
    isAtBottom() {
        const element = this.elements.commentsList;
        const threshold = 5; // 5px以内の誤差を許容
        return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
    }

    // コメントエリアの下部フェードグラデーション表示を更新
    updateScrolledToBottom() {
        const commentsArea = this.elements.commentsList.closest('.comments-area');
        if (commentsArea) {
            const el = this.elements.commentsList;
            const hasScroll = el.scrollHeight > el.clientHeight;
            if (!hasScroll || this.isAtBottom()) {
                commentsArea.classList.add('scrolled-to-bottom');
            } else {
                commentsArea.classList.remove('scrolled-to-bottom');
            }
        }
    }

    // 画像URLは外部由来なので https のみ通す（javascript:/data: を弾く）
    safeAvatarUrl(url) {
        return typeof url === 'string' && url.startsWith('https://') ? url : null;
    }

    // アバター1つぶんのHTML。URLが無い／読み込めない場合は頭文字にフォールバックする
    avatarHtml(comment) {
        // サロゲートペア（絵文字など）を1文字として扱う
        const initial = Array.from(comment.displayName || '?')[0] || '?';
        const fallback = `<span class="comment-avatar comment-avatar--fallback" aria-hidden="true">${this.escapeHtml(initial)}</span>`;
        const url = this.safeAvatarUrl(comment.profileImageUrl);
        if (!url) return fallback;
        return `<img class="comment-avatar" src="${this.escapeHtml(url)}" alt="" `
             + `loading="lazy" decoding="async" width="24" height="24" `
             + `data-initial="${this.escapeHtml(initial)}">`;
    }

    // ステッカー画像のURL。https に加えて配信ホストも確認する
    // （本文と違い img の src に流し込むので、素性の知れないURLは載せない）
    safeStickerUrl(url) {
        const safe = this.safeAvatarUrl(url);
        if (!safe) return null;
        try {
            return STICKER_IMAGE_HOSTS.includes(new URL(safe).hostname) ? safe : null;
        } catch {
            return null;
        }
    }

    // スーパーステッカーの画像。中身はアニメーションWebPで、img に貼るだけで再生される。
    // URLが無い／読み込めない場合も、ステッカー名は本文として別に出ているので情報は消えない
    stickerHtml(comment) {
        if (comment.kind !== 'supersticker') return '';
        const url = this.safeStickerUrl(comment.stickerUrl);
        if (!url) return '';
        return `<img class="comment-sticker" src="${this.escapeHtml(url)}" alt="" `
             + `loading="lazy" decoding="async" width="96" height="96">`;
    }

    // 時刻表示の設定を読み込む。未設定時は従来の見た目（24時間・秒あり）を維持する
    async loadTimeSettings() {
        try {
            const { timeHour12, timeShowSeconds } =
                await chrome.storage.local.get(['timeHour12', 'timeShowSeconds']);
            this.timeHour12 = timeHour12 === true;
            this.timeShowSeconds = timeShowSeconds !== false;
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading time settings:', error);
        }
        this.syncTimeToggleUI();
    }

    // ストレージ変更から呼ばれる。渡された値だけ更新して全件を描き直す
    applyTimeSettings({ hour12, showSeconds } = {}) {
        if (hour12 !== undefined) this.timeHour12 = (hour12 === true);
        if (showSeconds !== undefined) this.timeShowSeconds = (showSeconds !== false);
        this.syncTimeToggleUI();
        this.renderComments();
    }

    // ドロワーのトグル表示を現在値に合わせる（オプション画面側で変えた場合の追従）
    syncTimeToggleUI() {
        const hour12Toggle = document.getElementById('time-hour12-toggle');
        const secondsToggle = document.getElementById('time-seconds-toggle');
        if (hour12Toggle) hour12Toggle.checked = this.timeHour12;
        if (secondsToggle) secondsToggle.checked = this.timeShowSeconds;
    }

    // toLocaleTimeString('ja-JP', {hour12:true}) は「午後10:34」になりAM/PMにならない。
    // ロケール実装差にも左右されるので自前で組む
    formatTimestamp(raw) {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return '';

        const pad = n => String(n).padStart(2, '0');
        const hours24 = date.getHours();

        let text = this.timeHour12
            ? `${hours24 % 12 || 12}:${pad(date.getMinutes())}`
            : `${pad(hours24)}:${pad(date.getMinutes())}`;

        if (this.timeShowSeconds) text += `:${pad(date.getSeconds())}`;
        if (this.timeHour12) text += hours24 < 12 ? ' AM' : ' PM';

        return text;
    }

    // 一覧の役割バッジ。文字ではなくアイコンで出し、意味は title/aria-label で補う。
    // 一般コメントはバッジ無し（特別コメントだけが目に留まるようにする）
    roleBadgeHtml(comment) {
        const icons = {
            'role-owner':     '\u{1F451}',
            'role-moderator': '\u{1F527}',
            'role-sponsor':   '\u{2B50}'
        };
        const icon = icons[comment.roleClass];
        if (!icon) return '';

        const label = this.escapeHtml(comment.role);
        return `<span class="comment-role comment-role--icon ${comment.roleClass}" `
             + `title="${label}" role="img" aria-label="${label}">${icon}</span>`;
    }

    // 種別バッジ。スパチャ・メンバーイベントだけに付き、通常のコメントには出ない
    kindBadgeHtml(comment) {
        const entry = KIND_ICONS[comment.kind];
        if (!entry) return '';

        const [icon, label] = entry;
        return `<span class="comment-kind comment-kind--icon" `
             + `title="${label}" role="img" aria-label="${label}">${icon}</span>`;
    }

    // スパチャの金額。DOMモードは表示文字列、APIモードは amountDisplayString をそのまま出す
    amountHtml(comment) {
        if (!comment.amountText) return '';
        return `<span class="comment-amount">${this.escapeHtml(comment.amountText)}</span>`;
    }

    // 「新規メンバー」「◯か月連続のメンバー」など、本文とは別に出す一行
    eventTextHtml(comment) {
        if (!comment.eventText) return '';
        return `<div class="comment-event">${this.escapeHtml(comment.eventText)}</div>`;
    }

    renderComments(forceScrollToTop = false, forceScrollToBottom = false) {
        console.log('[Popup] === renderComments called ===');
        console.log('[Popup] Total comments:', this.comments.length);
        console.log('[Popup] Filter state:', this.commentFilters);
        console.log('[Popup] Selected user:', this.selectedUser);
        console.log('[Popup] Force scroll to top:', forceScrollToTop);
        console.log('[Popup] Force scroll to bottom:', forceScrollToBottom);
        
        // スクロール位置を保存
        const previousScrollTop = this.elements.commentsList.scrollTop;
        
        // 役割・種別フィルターとユーザーフィルターの両方を適用
        const filteredComments = this.comments.filter(comment => {
            const roleMatch = this.commentFilters[filterKeyOf(comment)] === true;
            
            // ユーザーフィルター
            const userMatch = !this.selectedUser || comment.displayName === this.selectedUser;
            
            // キーワード検索フィルター（大文字小文字を区別しない）
            let keywordMatch = true;
            if (this.searchKeyword.length > 0) {
                const kw = this.searchKeyword.toLowerCase();
                keywordMatch =
                    (comment.displayName || '').toLowerCase().includes(kw) ||
                    (comment.message || '').toLowerCase().includes(kw) ||
                    (comment.eventText || '').toLowerCase().includes(kw);
            }

            return roleMatch && userMatch && keywordMatch;
        });
        
        console.log('[Popup] Filtered comments:', filteredComments.length);
        
        // コメント数の集計
        const counts = Object.fromEntries(FILTER_KEYS.map(key => [key, 0]));
        for (const comment of this.comments) counts[filterKeyOf(comment)]++;

        // コメント数表示を更新
        this.elements.totalCount.textContent = `${filteredComments.length}件`;
        this.updateSearchMatchCount(filteredComments.length);
        this.elements.ownerCount.textContent = `配信者: ${counts.owner}`;
        this.elements.moderatorCount.textContent = `モデレーター: ${counts.moderator}`;
        this.elements.sponsorCount.textContent = `メンバー: ${counts.sponsor}`;
        this.elements.normalCount.textContent = `一般: ${counts.normal}`;
        this.elements.superchatCount.textContent = `スパチャ: ${counts.superchat}`;
        this.elements.membershipCount.textContent = `加入・ギフト: ${counts.membership}`;

        // フィルター状態に応じてバッジのアクティブ・非アクティブ表示を切り替え
        for (const key of FILTER_KEYS) {
            const element = this.elements[key + 'Count'];
            if (!element) continue;
            const enabled = !!this.commentFilters[key];
            element.classList.toggle('filter-inactive', !enabled);
            // バッジ単体でも状態を確かめられるように、見た目に加えて文言でも示す
            element.title = enabled ? 'クリックで非表示にする（現在: 表示中）'
                                    : 'クリックで表示する（現在: 非表示）';
            element.setAttribute('aria-pressed', String(enabled));
        }
        
        if (filteredComments.length === 0) {
            console.log('[Popup] No filtered comments to display, showing placeholder');
            this.elements.noComments.style.display = 'block';
            this.elements.commentsList.style.display = 'none';
            return;
        }
        
        console.log('[Popup] Displaying filtered comments list');
        this.elements.noComments.style.display = 'none';
        this.elements.commentsList.style.display = 'block';
        
        const commentsToDisplay = filteredComments;
        
        this.elements.commentsList.innerHTML = commentsToDisplay.map(comment => {
            const isSelected = this.selectedUser === comment.displayName;
            const authorClass = isSelected ? 'comment-author selected' : 'comment-author';
            
            // 金額だけのスパチャやギフト告知は本文が無いので、空の行を作らない
            const messageHtml = comment.message
                ? `<div class="comment-message">${this.escapeHtml(comment.message)}</div>`
                : '';
            const kindClass = comment.kind && comment.kind !== 'text' ? ` kind-${comment.kind}` : '';

            return `
                <div class="comment-item${kindClass}">
                    <div class="comment-header">
                        ${this.avatarHtml(comment)}
                        ${this.roleBadgeHtml(comment)}
                        ${this.kindBadgeHtml(comment)}
                        <span class="${authorClass}" data-username="${this.escapeHtml(comment.displayName)}">${this.escapeHtml(comment.displayName)}</span>
                        ${this.amountHtml(comment)}
                        <span class="comment-time">${this.formatTimestamp(comment.publishedAt)}</span>
                    </div>
                    ${this.eventTextHtml(comment)}
                    ${this.stickerHtml(comment)}
                    ${messageHtml}
                </div>
            `;
        }).join('');
        
        // 画像が404などで読めなかったら頭文字表示に差し替える
        // （MV3のCSPはインラインの onerror= を禁止するのでJSから張る）
        this.elements.commentsList.querySelectorAll('img.comment-avatar').forEach(img => {
            img.addEventListener('error', () => {
                const span = document.createElement('span');
                span.className = 'comment-avatar comment-avatar--fallback';
                span.setAttribute('aria-hidden', 'true');
                span.textContent = img.dataset.initial || '?';
                img.replaceWith(span);
            }, { once: true });
        });

        // ステッカー画像が読めなかったら取り除く。ステッカー名の行はそのまま残る
        this.elements.commentsList.querySelectorAll('img.comment-sticker').forEach(img => {
            img.addEventListener('error', () => img.remove(), { once: true });
        });

        // ユーザー名のクリックイベントを追加
        this.elements.commentsList.querySelectorAll('.comment-author').forEach(element => {
            element.addEventListener('click', (e) => {
                const username = e.target.getAttribute('data-username');
                if (username) {
                    if (this.selectedUser === username) {
                        // 既に選択済みのユーザーをクリックした場合は絞り込み解除
                        this.clearUserFilter();
                    } else {
                        // 新しいユーザーで絞り込み
                        this.filterByUser(username);
                    }
                }
            });
        });
        
        // スクロール位置の制御
        if (forceScrollToTop) {
            // フィルター変更やクリア時は強制的にトップへ
            this.elements.commentsList.scrollTop = 0;
            console.log('[Popup] Scrolled to top (forced)');
        } else if (forceScrollToBottom) {
            // ユーザーフィルター時は強制的にボトムへ
            this.elements.commentsList.scrollTop = this.elements.commentsList.scrollHeight;
            console.log('[Popup] Scrolled to bottom (forced)');
        } else if (!forceScrollToTop && this.autoScroll) {
            // 自動追従モードの場合は新しいコメント表示後も一番下を維持
            this.elements.commentsList.scrollTop = this.elements.commentsList.scrollHeight;
            console.log('[Popup] Scrolled to bottom (auto-follow)');
        } else {
            // ユーザーが上にスクロール中は位置を維持
            this.elements.commentsList.scrollTop = previousScrollTop;
            console.log('[Popup] Maintained scroll position');
        }
        // スクロール後に autoScroll フラグを再同期
        this.autoScroll = this.isAtBottom();
        this.updateScrolledToBottom();
        
        console.log('[Popup] Comments rendered successfully, scroll position:', this.elements.commentsList.scrollTop);
    }
    
    updateStatus(status) {
        this.elements.statusIndicator.textContent = status;
        
        if (status.includes('取得中')) {
            this.elements.statusIndicator.className = 'status-indicator status-online';
        } else {
            this.elements.statusIndicator.className = 'status-indicator status-offline';
        }
    }
    
    updateMonitoringButtons(hasApiKey) {
        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        // DOMモードはAPIキー不要
        const effectiveHasApiKey = this.chatMode === 'dom' ? true : hasApiKey;

        // 監視開始ボタンの状態とツールチップ
        if (!effectiveHasApiKey) {
            this.elements.startMonitoringBtn.disabled = true;
            this.elements.startMonitoringBtn.title = 'APIキーを入力してください';
        } else if (!isYouTubePage) {
            this.elements.startMonitoringBtn.disabled = true;
            this.elements.startMonitoringBtn.title = 'YouTubeのライブ配信ページで使用してください';
        } else {
            this.elements.startMonitoringBtn.disabled = false;
            this.elements.startMonitoringBtn.title = '';
        }
        
        // 監視停止ボタンは監視状態のみで制御（APIキーやページに関係なく）
        // この関数は監視状態以外の条件で呼ばれるため、停止ボタンはここでは触らない
    }
    
    updateMonitoringButtonStates() {
        // モードセレクターのロック
        if (this.elements.modeSelectWrapper) {
            this.elements.modeSelectWrapper.classList.toggle('monitoring', this.isMonitoring);
        }

        // 監視開始ボタン
        if (this.isMonitoring) {
            this.elements.startMonitoringBtn.disabled = true;
            this.elements.startMonitoringBtn.title = '取得中です';
        } else {
            // 監視していない場合は通常のボタン状態ロジックを適用
            if (this.chatMode === 'dom') {
                // DOMモードはAPIキー不要
                this.updateMonitoringButtons(true);
            } else {
                // まずAPIキーを確認
                this.sendMessageWithRetry({ action: 'getApiKey' }, 1).then(response => {
                    const hasApiKey = response && response.apiKey;
                    this.updateMonitoringButtons(hasApiKey);
                }).catch(() => {
                    this.updateMonitoringButtons(false);
                });
            }
        }
        
        // 監視停止ボタン
        if (this.isMonitoring) {
            this.elements.stopMonitoringBtn.disabled = false;
            this.elements.stopMonitoringBtn.title = '';
        } else {
            this.elements.stopMonitoringBtn.disabled = true;
            this.elements.stopMonitoringBtn.title = '取得停止中です';
        }
    }
    
    showLoading(show) {
        this.elements.loading.style.display = show ? 'flex' : 'none';
    }
    
    showError(message) {
        if (message) {
            this.elements.errorMessage.textContent = message;
            this.elements.errorMessage.style.display = 'block';
        } else {
            this.elements.errorMessage.style.display = 'none';
        }
    }
    
    showMessage(message, type = 'info') {
        console.log(`${type}: ${message}`);
        
        if (type === 'success') {
            this.elements.successMessage.textContent = message;
            this.elements.successMessage.style.display = 'flex';
            this.elements.successMessage.style.animation = 'slideInFromTop 0.3s ease-out';
            
            // 2秒後に自動的に非表示
            setTimeout(() => {
                this.elements.successMessage.style.animation = 'fadeOutUp 0.3s ease-out';
                setTimeout(() => {
                    this.elements.successMessage.style.display = 'none';
                    this.elements.successMessage.style.animation = '';
                }, 300);
            }, 2000);
        } else if (type === 'error') {
            this.elements.errorOverlay.textContent = message;
            this.elements.errorOverlay.style.display = 'flex';
            this.elements.errorOverlay.style.animation = 'slideInFromTop 0.3s ease-out';
            
            // 3秒後に自動的に非表示（エラーメッセージは少し長めに表示）
            setTimeout(() => {
                this.elements.errorOverlay.style.animation = 'fadeOutUp 0.3s ease-out';
                setTimeout(() => {
                    this.elements.errorOverlay.style.display = 'none';
                    this.elements.errorOverlay.style.animation = '';
                }, 300);
            }, 3000);
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    async loadCommentFilters() {
        try {
            const response = await this.sendMessageWithRetry({ action: 'getCommentFilters' }, 2);
            if (response && response.success) {
                this.commentFilters = response.filters;
                this.updateFilterUI();
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading comment filters:', error);
            // デフォルト値を使用
            this.updateFilterUI();
        }
    }
    
    updateFilterUI() {
        for (const key of FILTER_KEYS) {
            this.elements[key + 'Toggle'].checked = this.commentFilters[key] === true;
        }

        this.updatePresetButtons();
        this.renderComments(false, true); // フィルターが変更されたら再描画（一番下にスクロール）
    }
    
    updatePresetButtons() {
        const buttons = {
            special: this.elements.presetSpecial,
            all: this.elements.presetAll,
            none: this.elements.presetNone
        };

        // 現在の状態と一致するプリセットだけをアクティブにする
        for (const [name, button] of Object.entries(buttons)) {
            const matches = FILTER_KEYS.every(
                key => this.commentFilters[key] === FILTER_PRESETS[name][key]
            );
            button.classList.toggle('btn-preset-active', matches);
        }
    }
    
    async onFilterToggleChange(filterType) {
        this.commentFilters[filterType] = this.elements[filterType + 'Toggle'].checked;
        
        console.log('[YouTube Special Comments] Filter changed:', filterType, '=', this.commentFilters[filterType]);
        
        try {
            await this.sendMessageWithRetry({
                action: 'setCommentFilters',
                filters: this.commentFilters
            }, 2);
            
            this.updatePresetButtons();
            this.renderComments(false, true); // フィルターが変更されたら再描画（一番下にスクロール）
            
        } catch (error) {
            console.error('[YouTube Special Comments] Error saving comment filters:', error);
        }
    }

    async toggleBadgeFilter(filterType) {
        console.log('[YouTube Special Comments] Badge clicked:', filterType);
        
        // 該当のカテゴリのみが現在有効であるか判定 (他はすべて無効)
        const isOnlyActive = this.commentFilters[filterType] && 
            Object.keys(this.commentFilters).every(key => key === filterType || !this.commentFilters[key]);
        
        if (isOnlyActive) {
            // 既にそのカテゴリのみのフィルターが有効な状態でクリックされた場合は、フィルター解除（すべて有効）にする
            this.commentFilters = { ...FILTER_PRESETS.all };
        } else {
            // それ以外の場合は、クリックされたカテゴリのみを有効にし、他を無効にする
            this.commentFilters = { ...FILTER_PRESETS.none };
            this.commentFilters[filterType] = true;
        }

        try {
            await this.sendMessageWithRetry({
                action: 'setCommentFilters',
                filters: this.commentFilters
            }, 2);
            
            this.updateFilterUI();
            
        } catch (error) {
            console.error('[YouTube Special Comments] Error toggling badge filter:', error);
        }
    }
    
    async applyPreset(presetType) {
        console.log('[YouTube Special Comments] Applying preset:', presetType);
        
        if (!FILTER_PRESETS[presetType]) return;
        this.commentFilters = { ...FILTER_PRESETS[presetType] };
        
        try {
            await this.sendMessageWithRetry({
                action: 'setCommentFilters',
                filters: this.commentFilters
            }, 2);
            
            this.updateFilterUI();
            
        } catch (error) {
            console.error('[YouTube Special Comments] Error applying preset:', error);
        }
    }
    
    updateVideoIdDisplay() {
        console.log('[YouTube Special Comments] Updating video ID display:', {
            currentVideoId: this.currentVideoId,
            isMonitoring: this.isMonitoring
        });
        
        // 現在のタブのVideo IDを表示
        if (this.currentVideoId) {
            this.elements.currentVideoId.textContent = this.currentVideoId;
        } else {
            this.elements.currentVideoId.textContent = '未検出';
        }
    }
    
    handleAutoStop(reason) {
        console.log('[Popup] Monitoring auto-stopped:', reason);
        
        // 監視状態を更新
        this.isMonitoring = false;
        this.updateMonitoringButtonStates();
        this.updateStatus('自動停止');
        
        // 自動停止の通知を表示
        this.showAutoStopNotification(reason);
    }
    
    showAutoStopNotification(reason) {
        // 既存のエラーメッセージをクリア
        this.showError('');
        
        // 自動停止メッセージを表示
        const message = `取得が自動停止されました: ${reason}`;
        this.showMessage(message, 'info');
        
        // エラーメッセージエリアを一時的に情報表示に使用
        const errorElement = this.elements.errorMessage;
        errorElement.textContent = `ℹ️ ${message}`;
        errorElement.style.display = 'block';
        errorElement.style.backgroundColor = '#e3f2fd';
        errorElement.style.borderColor = '#1976d2';
        errorElement.style.color = '#1976d2';
        
        // 5秒後に自動的に非表示
        setTimeout(() => {
            errorElement.style.display = 'none';
            errorElement.style.backgroundColor = '';
            errorElement.style.borderColor = '';
            errorElement.style.color = '';
        }, 5000);
    }
    
    // HTMLタグ除去ユーティリティ関数
    stripHtmlTags(html) {
        if (!html) return '';
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.textContent || div.innerText || '';
    }
    
    showDetailedError(errorInfo) {
        console.log('[Popup] Showing detailed error:', errorInfo);
        
        // 通常のエラーメッセージを隠す
        this.elements.errorMessage.style.display = 'none';
        
        // HTMLタグを除去してから表示
        const cleanTitle = this.stripHtmlTags(errorInfo.title || 'エラーが発生しました');
        const cleanMessage = this.stripHtmlTags(errorInfo.message || errorInfo.originalError || '');
        const cleanSolution = this.stripHtmlTags(errorInfo.solution || '設定を確認してください');
        
        // 詳細エラー情報を表示
        this.elements.errorTitle.textContent = cleanTitle;
        this.elements.errorDescription.textContent = cleanMessage;
        this.elements.errorSolution.textContent = cleanSolution;
        
        // 重要度に応じたスタイル設定
        this.elements.errorDetails.className = `error-details severity-${errorInfo.severity || 'medium'}`;
        
        // アクションボタンの表示制御
        this.updateErrorActionButtons(errorInfo.action);
        
        // 詳細エラー表示を表示
        this.elements.errorDetails.style.display = 'block';
        
        // 自動的に非表示にしない（ユーザーが解決するまで表示継続）
    }
    
    hideDetailedError() {
        this.elements.errorDetails.style.display = 'none';
    }
    
    updateErrorActionButtons(action) {
        // デフォルトでは両方のボタンを表示
        this.elements.retryButton.style.display = 'inline-block';
        this.elements.optionsButton.style.display = 'inline-block';
        
        // アクションに応じてボタンをカスタマイズ
        switch (action) {
            case 'setApiKey':
            case 'checkApiKey':
                this.elements.optionsButton.textContent = 'APIキー設定';
                this.elements.retryButton.textContent = '再試行';
                break;
            case 'waitAndRetry':
                this.elements.retryButton.textContent = '1分後に再試行';
                this.elements.optionsButton.style.display = 'none';
                break;
            case 'waitOrUpgrade':
                this.elements.retryButton.textContent = '明日再試行';
                this.elements.optionsButton.textContent = 'Cloud Console';
                this.elements.optionsButton.onclick = () => {
                    window.open('https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas', '_blank');
                };
                break;
            case 'checkConnection':
                this.elements.retryButton.textContent = '接続確認';
                this.elements.optionsButton.style.display = 'none';
                break;
            case 'reload':
                this.elements.retryButton.textContent = 'ページ再読込';
                this.elements.optionsButton.style.display = 'none';
                break;
            case 'waitForChat':
            case 'findLiveStream':
                this.elements.retryButton.textContent = '再確認';
                this.elements.optionsButton.style.display = 'none';
                break;
            default:
                this.elements.retryButton.textContent = '再試行';
                this.elements.optionsButton.textContent = '設定画面';
        }
    }
    
    handleRetry() {
        console.log('[Popup] Retry button clicked');
        this.hideDetailedError();
        
        // 取得開始を再試行
        if (!this.isMonitoring) {
            this.startMonitoring();
        }
    }
    
    openOptionsPage() {
        console.log('[Popup] Opening options page');
        chrome.runtime.openOptionsPage();
    }
    
    // リトライ機能付きメッセージ送信（Popupバージョン）
    async sendMessageWithRetry(message, maxRetries = 3, baseDelay = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[YouTube Special Comments] [Popup] Sending message attempt ${attempt}/${maxRetries}:`, message.action);
                
                const response = await this.sendMessageWithTimeout(message, 5000);
                console.log(`[YouTube Special Comments] [Popup] ✅ Message successful on attempt ${attempt}`);
                return response;
                
            } catch (error) {
                console.warn(`[YouTube Special Comments] [Popup] Message failed on attempt ${attempt}:`, error.message);
                
                // Extension context invalidated の場合は特別処理
                if (error.message.includes('Extension context invalidated')) {
                    console.error('[YouTube Special Comments] [Popup] 🔄 Extension context invalidated - attempting recovery');
                    
                    // Service Worker再接続を試行
                    await this.delay(1000);
                    const recovered = await this.waitForServiceWorker(5);
                    
                    if (!recovered && attempt === maxRetries) {
                        this.showError('拡張機能の接続が失われました。ページを再読み込みしてください。');
                        throw new Error('Extension context invalidated and recovery failed. Please reload the page.');
                    }
                    continue;
                }
                
                // "Could not establish connection" の場合も再接続試行
                if (error.message.includes('Could not establish connection')) {
                    console.warn('[YouTube Special Comments] [Popup] 🔄 Connection lost - attempting recovery');
                    
                    if (attempt === 1) {
                        this.showInitializationStatus('拡張機能に再接続中...');
                    }
                    
                    await this.delay(1000);
                    const recovered = await this.waitForServiceWorker(3);
                    
                    if (recovered) {
                        console.log('[YouTube Special Comments] [Popup] ✅ Connection recovered');
                        this.hideInitializationStatus();
                    }
                }
                
                if (attempt === maxRetries) {
                    // 最終的にエラーになった場合、ユーザーフレンドリーなメッセージを表示
                    if (error.message.includes('Could not establish connection')) {
                        this.showError('ページを再読み込みしてから再試行してください。');
                    }
                    throw error;
                }
                
                // 指数バックオフで待機
                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.log(`[YouTube Special Comments] [Popup] Waiting ${delay}ms before retry...`);
                await this.delay(delay);
            }
        }
    }
    
    // ユーザーフィルタリング機能
    filterByUser(username) {
        console.log('[YouTube Special Comments] Filtering by user:', username);
        this.selectedUser = username;
        this.updateUserFilterStatus();
        this.renderComments(false, true); // ユーザーフィルター適用時は一番下にスクロール
    }
    
    clearUserFilter() {
        console.log('[YouTube Special Comments] Clearing user filter');
        this.selectedUser = null;
        this.updateUserFilterStatus();
        this.renderComments(false, true); // ユーザーフィルタークリア時は一番下にスクロール
    }

    onSearchInput() {
        const value = this.elements.searchKeywordInput.value;
        this.searchKeyword = value;
        this.elements.clearSearchBtn.style.display = value.length > 0 ? 'inline-block' : 'none';
        const wrapper = this.elements.searchKeywordInput.closest('.search-input-wrapper');
        wrapper.classList.toggle('is-active', value.length > 0);
        clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => this.renderComments(false, false), 150);
    }

    clearSearch() {
        this.searchKeyword = '';
        this.elements.searchKeywordInput.value = '';
        this.elements.clearSearchBtn.style.display = 'none';
        this.elements.searchMatchCount.style.display = 'none';
        this.elements.searchKeywordInput.closest('.search-input-wrapper').classList.remove('is-active');
        this.renderComments(false, false);
    }

    updateSearchMatchCount(matchCount) {
        if (this.searchKeyword.length > 0) {
            this.elements.searchMatchCount.textContent = `${matchCount}件一致`;
            this.elements.searchMatchCount.style.display = 'inline-block';
        } else {
            this.elements.searchMatchCount.style.display = 'none';
        }
    }
    
    updateUserFilterStatus() {
        if (this.selectedUser) {
            // まずユーザー名をセットしてからステータスバーを表示（ちらつき防止）
            this.elements.filteredUsername.textContent = this.selectedUser;
            
            // レイアウト計算完了後に表示状態を変更
            requestAnimationFrame(() => {
                this.elements.userFilterStatus.style.display = 'flex';
            });
        } else {
            this.elements.userFilterStatus.style.display = 'none';
        }
    }
    
    // リトライ機能付きタブメッセージ送信
    async sendTabMessageWithRetry(tabId, message, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[YouTube Special Comments] [Popup] Sending tab message attempt ${attempt}/${maxRetries}:`, message.action);
                
                const response = await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, message, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    });
                });
                
                console.log(`[YouTube Special Comments] [Popup] ✅ Tab message successful on attempt ${attempt}`);
                return response;
                
            } catch (error) {
                console.log(`[YouTube Special Comments] [Popup] Tab message failed on attempt ${attempt}:`, error.message);
                
                // Content Scriptが準備できていない可能性
                if (error.message.includes('Could not establish connection')) {
                    console.log('[YouTube Special Comments] [Popup] Content script not ready, waiting...');
                    await this.delay(1000 * attempt); // 段階的に遅延を増加
                }
                
                if (attempt === maxRetries) {
                    throw error;
                }
            }
        }
    }
    
}

document.addEventListener('DOMContentLoaded', () => {
    popupController = new PopupController();
    initDrawer();
});

function initDrawer() {
    const drawer   = document.getElementById('settings-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const gearBtn  = document.getElementById('settings-toggle-btn');

    if (!drawer || !backdrop || !gearBtn) return;

    function openDrawer() {
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        backdrop.classList.add('visible');
        gearBtn.classList.add('active');
    }

    function closeDrawer() {
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        backdrop.classList.remove('visible');
        gearBtn.classList.remove('active');
    }

    gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });

    backdrop.addEventListener('click', closeDrawer);

    drawer.addEventListener('click', (e) => e.stopPropagation());

    // ドロワー内 時刻表示トグル。
    // 描画への反映は書き込まない（storage.onChanged 側が拾って再描画する）
    const timeHour12Toggle = document.getElementById('time-hour12-toggle');
    if (timeHour12Toggle) {
        timeHour12Toggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ timeHour12: timeHour12Toggle.checked });
        });
    }

    const timeSecondsToggle = document.getElementById('time-seconds-toggle');
    if (timeSecondsToggle) {
        timeSecondsToggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ timeShowSeconds: timeSecondsToggle.checked });
        });
    }

    // ドロワー内ダークモードトグル
    const darkToggle = document.getElementById('dark-mode-toggle');
    if (darkToggle) {
        chrome.storage.local.get(['theme']).then(({ theme }) => {
            darkToggle.checked = ((theme || 'light') === 'dark');
        });
        darkToggle.addEventListener('change', async () => {
            const theme = darkToggle.checked ? 'dark' : 'light';
            await chrome.storage.local.set({ theme });
            document.documentElement.setAttribute('data-theme', theme);
        });
    }
}