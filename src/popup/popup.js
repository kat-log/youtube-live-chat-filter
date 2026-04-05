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

class PopupController {
    constructor() {
        this.isMonitoring = false;
        this.comments = [];
        this.currentTab = null;
        this.currentVideoId = null;
        this.serviceWorkerReady = false;
        this.initializationComplete = false;
        
        // 個別フィルターの状態
        this.commentFilters = {
            owner: true,
            moderator: true,
            sponsor: true,
            normal: true
        };
        
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
        // 初期状態設定
        this.updateMonitoringButtons(false);
        this.updateMonitoringButtonStates();
        
        // 非同期初期化タスクを並行実行
        await Promise.all([
            this.loadSavedApiKey(),
            this.loadCommentFilters(),
            this.loadChatMode(),
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

        if (!this.currentTab || !this.currentTab.url.includes('youtube.com/watch')) {
            console.log('[YouTube Special Comments] Not a YouTube watch page, skipping content script check');
            return true;
        }
        
        console.log('[YouTube Special Comments] Checking content script injection status...');
        
        try {
            // Content Scriptとの通信をテスト（タイムアウト短め）
            const response = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 1500);
            
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
            console.log('[YouTube Special Comments] Requesting manual content script re-injection...');
            const reinjectResponse = await this.sendMessageWithRetry({
                action: 'reinjectContentScripts'
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
                action: 'reinjectContentScripts'
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
        
        // 個別フィルタートグル
        this.elements.ownerToggle.addEventListener('change', () => this.onFilterToggleChange('owner'));
        this.elements.moderatorToggle.addEventListener('change', () => this.onFilterToggleChange('moderator'));
        this.elements.sponsorToggle.addEventListener('change', () => this.onFilterToggleChange('sponsor'));
        this.elements.normalToggle.addEventListener('change', () => this.onFilterToggleChange('normal'));
        
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
        });
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
            console.log('[Popup] Received message:', request.action, 'with', request.comments?.length || 0, 'comments');
            if (request.action === 'newSpecialComments') {
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
            
            if (tab.url && tab.url.includes('youtube.com/watch')) {
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
        if (this.isMonitoring) return;
        if (this.chatMode !== 'dom') return;
        if (!this.currentTab || !this.currentTab.url.includes('youtube.com/watch')) return;

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
        if (!this.currentTab || !this.currentTab.url.includes('youtube.com/watch')) {
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
                    this.updateMonitoringButtonStates();
                    this.updateStatus('取得中（DOMモード）');
                    this.showError('');
                    this.hideDetailedError();
                    this.elements.fixExtensionContainer.style.display = 'none';
                } else {
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
        this.renderComments(true); // コメントクリア時はトップにスクロール
    }
    
    addNewComments(newComments) {
        console.log('[Popup] === addNewComments called ===');
        console.log('[Popup] Received', newComments.length, 'new comments');
        console.log('[Popup] Current comments count before adding:', this.comments.length);
        
        const formattedComments = newComments.map(comment => this.formatComment(comment));
        
        // 重複チェック：既存のコメントと同じタイムスタンプ・メッセージ・ユーザー名のものを除外
        const uniqueComments = formattedComments.filter(newComment => {
            return !this.comments.some(existingComment => 
                existingComment.message === newComment.message &&
                existingComment.displayName === newComment.displayName &&
                existingComment.timestamp === newComment.timestamp
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
        // DOM モード：authorDetails がなく role/displayName/message を持つ
        if (comment.role && comment.displayName && comment.message && !comment.authorDetails) {
            const map = {
                owner:     ['配信者',     'role-owner'],
                moderator: ['モデレーター', 'role-moderator'],
                member:    ['メンバー',    'role-sponsor']
            };
            const [role, roleClass] = map[comment.role] || ['一般', 'role-normal'];
            return {
                role,
                roleClass,
                displayName: comment.displayName,
                message: comment.message,
                timestamp: new Date(comment.publishedAt).toLocaleTimeString('ja-JP'),
                profileImageUrl: null
            };
        }

        const authorDetails = comment.authorDetails;
        const snippet = comment.snippet;

        let role = '';
        let roleClass = '';

        if (authorDetails.isChatOwner) {
            role = '配信者';
            roleClass = 'role-owner';
        } else if (authorDetails.isChatModerator) {
            role = 'モデレーター';
            roleClass = 'role-moderator';
        } else if (authorDetails.isChatSponsor) {
            role = 'メンバー';
            roleClass = 'role-sponsor';
        } else {
            // 一般コメント
            role = '一般';
            roleClass = 'role-normal';
        }
        
        return {
            role: role,
            roleClass: roleClass,
            displayName: authorDetails.displayName,
            message: snippet.displayMessage,
            timestamp: new Date(snippet.publishedAt).toLocaleTimeString('ja-JP'),
            profileImageUrl: authorDetails.profileImageUrl
        };
    }
    
    // スクロール位置が一番下かどうかを判定
    isAtBottom() {
        const element = this.elements.commentsList;
        const threshold = 5; // 5px以内の誤差を許容
        return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
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
        
        // 役割フィルターとユーザーフィルターの両方を適用
        const filteredComments = this.comments.filter(comment => {
            // 役割フィルター
            let roleMatch = false;
            switch (comment.roleClass) {
                case 'role-owner':
                    roleMatch = this.commentFilters.owner;
                    break;
                case 'role-moderator':
                    roleMatch = this.commentFilters.moderator;
                    break;
                case 'role-sponsor':
                    roleMatch = this.commentFilters.sponsor;
                    break;
                case 'role-normal':
                    roleMatch = this.commentFilters.normal;
                    break;
                default:
                    roleMatch = false;
            }
            
            // ユーザーフィルター
            const userMatch = !this.selectedUser || comment.displayName === this.selectedUser;
            
            // キーワード検索フィルター（大文字小文字を区別しない）
            let keywordMatch = true;
            if (this.searchKeyword.length > 0) {
                const kw = this.searchKeyword.toLowerCase();
                keywordMatch =
                    (comment.displayName || '').toLowerCase().includes(kw) ||
                    (comment.message || '').toLowerCase().includes(kw);
            }

            return roleMatch && userMatch && keywordMatch;
        });
        
        console.log('[Popup] Filtered comments:', filteredComments.length);
        
        // コメント数の集計
        const counts = {
            owner: this.comments.filter(c => c.roleClass === 'role-owner').length,
            moderator: this.comments.filter(c => c.roleClass === 'role-moderator').length,
            sponsor: this.comments.filter(c => c.roleClass === 'role-sponsor').length,
            normal: this.comments.filter(c => c.roleClass === 'role-normal').length
        };
        
        // コメント数表示を更新
        this.elements.totalCount.textContent = `${filteredComments.length}件`;
        this.updateSearchMatchCount(filteredComments.length);
        this.elements.ownerCount.textContent = `配信者: ${counts.owner}`;
        this.elements.moderatorCount.textContent = `モデレーター: ${counts.moderator}`;
        this.elements.sponsorCount.textContent = `メンバー: ${counts.sponsor}`;
        this.elements.normalCount.textContent = `一般: ${counts.normal}`;
        
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
            
            return `
                <div class="comment-item">
                    <div class="comment-header">
                        <span class="comment-role ${comment.roleClass}">${comment.role}</span>
                        <span class="${authorClass}" data-username="${this.escapeHtml(comment.displayName)}">${this.escapeHtml(comment.displayName)}</span>
                        <span class="comment-time">${comment.timestamp}</span>
                    </div>
                    <div class="comment-message">${this.escapeHtml(comment.message)}</div>
                </div>
            `;
        }).join('');
        
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
        const isYouTubePage = this.currentTab && this.currentTab.url && this.currentTab.url.includes('youtube.com/watch');
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
        this.elements.ownerToggle.checked = this.commentFilters.owner;
        this.elements.moderatorToggle.checked = this.commentFilters.moderator;
        this.elements.sponsorToggle.checked = this.commentFilters.sponsor;
        this.elements.normalToggle.checked = this.commentFilters.normal;
        
        this.updatePresetButtons();
        this.renderComments(false, true); // フィルターが変更されたら再描画（一番下にスクロール）
    }
    
    updatePresetButtons() {
        // すべてのプリセットボタンを非アクティブに
        this.elements.presetSpecial.classList.remove('btn-preset-active');
        this.elements.presetAll.classList.remove('btn-preset-active');
        this.elements.presetNone.classList.remove('btn-preset-active');
        
        // 現在の状態に応じてアクティブなプリセットを設定
        if (this.commentFilters.owner && this.commentFilters.moderator && 
            !this.commentFilters.sponsor && !this.commentFilters.normal) {
            this.elements.presetSpecial.classList.add('btn-preset-active');
        } else if (this.commentFilters.owner && this.commentFilters.moderator && 
                   this.commentFilters.sponsor && this.commentFilters.normal) {
            this.elements.presetAll.classList.add('btn-preset-active');
        } else if (!this.commentFilters.owner && !this.commentFilters.moderator && 
                   !this.commentFilters.sponsor && !this.commentFilters.normal) {
            this.elements.presetNone.classList.add('btn-preset-active');
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
    
    async applyPreset(presetType) {
        console.log('[YouTube Special Comments] Applying preset:', presetType);
        
        switch (presetType) {
            case 'special':
                this.commentFilters = {
                    owner: true,
                    moderator: true,
                    sponsor: false,
                    normal: false
                };
                break;
            case 'all':
                this.commentFilters = {
                    owner: true,
                    moderator: true,
                    sponsor: true,
                    normal: true
                };
                break;
            case 'none':
                this.commentFilters = {
                    owner: false,
                    moderator: false,
                    sponsor: false,
                    normal: false
                };
                break;
        }
        
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
    new PopupController();
});