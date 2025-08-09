class PopupController {
    constructor() {
        this.isMonitoring = false;
        this.comments = [];
        this.currentTab = null;
        this.currentVideoId = null;
        
        // 個別フィルターの状態
        this.commentFilters = {
            owner: true,
            moderator: true,
            sponsor: true,
            normal: true
        };
        
        this.initializeElements();
        this.attachEventListeners();
        // 初期状態ではAPIキーなし、監視停止状態として設定
        this.updateMonitoringButtons(false);
        this.updateMonitoringButtonStates(); // 監視状態に基づくボタン設定
        this.loadSavedApiKey();
        this.loadCommentFilters();
        this.checkCurrentTab();
        this.setupMessageListener();
    }
    
    initializeElements() {
        this.elements = {
            statusIndicator: document.getElementById('status-indicator'),
            apiKeyInput: document.getElementById('api-key-input'),
            saveApiKeyBtn: document.getElementById('save-api-key'),
            startMonitoringBtn: document.getElementById('start-monitoring'),
            stopMonitoringBtn: document.getElementById('stop-monitoring'),
            clearCommentsBtn: document.getElementById('clear-comments'),
            
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
            successMessage: document.getElementById('api-success-message'),
            currentVideoId: document.getElementById('current-video-id'),
            
            // 詳細エラー表示要素
            errorDetails: document.getElementById('error-details'),
            errorTitle: document.getElementById('error-title'),
            errorDescription: document.getElementById('error-description'),
            errorSolution: document.getElementById('error-solution'),
            retryButton: document.getElementById('retry-button'),
            optionsButton: document.getElementById('options-button')
        };
    }
    
    attachEventListeners() {
        this.elements.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
        this.elements.startMonitoringBtn.addEventListener('click', () => this.startMonitoring());
        this.elements.stopMonitoringBtn.addEventListener('click', () => this.stopMonitoring());
        this.elements.clearCommentsBtn.addEventListener('click', () => this.clearComments());
        
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
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
            console.log('[Popup] Received message:', request.action, 'with', request.comments?.length || 0, 'comments');
            if (request.action === 'newSpecialComments') {
                this.addNewComments(request.comments);
            } else if (request.action === 'monitoringAutoStopped') {
                this.handleAutoStop(request.reason);
            } else if (request.action === 'showDetailedError') {
                this.showDetailedError(request.errorInfo);
            }
        });
    }
    
    async loadSavedApiKey() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getApiKey' });
            if (response.apiKey) {
                this.elements.apiKeyInput.value = response.apiKey;
                this.updateMonitoringButtons(true);
            }
        } catch (error) {
            console.error('Error loading API key:', error);
        }
    }
    
    async saveApiKey() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        if (!apiKey) {
            this.showError('APIキーを入力してください');
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
                this.updateMonitoringButtonStates();
                
                if (this.isMonitoring) {
                    this.updateStatus('取得中 (バックグラウンド)');
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
            const response = await chrome.tabs.sendMessage(this.currentTab.id, {
                action: 'getSpecialComments'
            });
            
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
            const response = await chrome.runtime.sendMessage({
                action: 'getMonitoringState'
            });
            
            return response || { success: false };
        } catch (error) {
            console.error('[YouTube Special Comments] Error getting monitoring state:', error);
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
            const historyResponse = await chrome.runtime.sendMessage({
                action: 'getCommentsHistory',
                videoId: targetVideoId
            });
            
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
            console.error('[YouTube Special Comments] Primary history loading failed:', error);
        }
        
        // フォールバック1: Content scriptから直接コメントを取得
        if (!historyLoaded) {
            console.log('[YouTube Special Comments] === Fallback 1: Getting comments from content script ===');
            try {
                const contentResponse = await chrome.tabs.sendMessage(this.currentTab.id, {
                    action: 'getSpecialComments'
                });
                
                if (contentResponse?.comments && contentResponse.comments.length > 0) {
                    const formattedComments = this.formatHistoryComments(contentResponse.comments);
                    this.comments = formattedComments;
                    this.renderComments();
                    console.log('[YouTube Special Comments] Fallback 1 successful: loaded', formattedComments.length, 'comments from content script');
                    historyLoaded = true;
                }
            } catch (error) {
                console.error('[YouTube Special Comments] Fallback 1 failed:', error);
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
            const response = await chrome.tabs.sendMessage(this.currentTab.id, {
                action: 'getSpecialComments'
            });
            
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
    
    async startMonitoring() {
        if (!this.currentTab || !this.currentTab.url.includes('youtube.com/watch')) {
            this.showError('YouTubeのライブ配信ページで使用してください');
            return;
        }
        
        console.log('[YouTube Special Comments] Starting monitoring...');
        this.showLoading(true);
        this.showError(''); // エラーメッセージをクリア
        
        try {
            // APIキーの存在確認
            const apiKeyResponse = await chrome.runtime.sendMessage({ action: 'getApiKey' });
            if (!apiKeyResponse || !apiKeyResponse.apiKey) {
                this.showError('YouTube Data APIキーが設定されていません。オプション画面で設定してください。');
                return;
            }

            // content scriptが応答するかテスト
            const testResponse = await chrome.tabs.sendMessage(this.currentTab.id, {
                action: 'getSpecialComments'
            });
            
            console.log('[YouTube Special Comments] Content script test response:', testResponse);
            
            const response = await chrome.tabs.sendMessage(this.currentTab.id, {
                action: 'startMonitoring'
            });
            
            console.log('[YouTube Special Comments] Start monitoring response:', response);
            
            if (response && response.success) {
                this.isMonitoring = true;
                this.updateMonitoringButtonStates();
                this.updateStatus('取得中 (バックグラウンド)');
                this.showError('');
            } else {
                this.showError('取得を開始できませんでした。ライブチャットが見つからない可能性があります。');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Start monitoring error:', error);
            
            // エラーメッセージの改善
            if (error.message.includes('Could not establish connection')) {
                this.showError('ページを再読み込みしてから再試行してください。');
            } else if (error.message.includes('API key')) {
                this.showError('APIキーが設定されていません。オプション画面で設定してください。');
            } else if (error.message.includes('No active live chat')) {
                this.showError('このビデオはライブ配信ではないか、チャットが無効になっています。');
            } else if (error.message.includes('quota')) {
                this.showError('YouTube API の使用量制限に達しました。しばらく待ってから再試行してください。');
            } else {
                this.showError(`取得の開始に失敗しました: ${error.message}`);
            }
        } finally {
            this.showLoading(false);
        }
    }
    
    async stopMonitoring() {
        console.log('[YouTube Special Comments] Stopping monitoring...');
        this.showLoading(true);
        
        try {
            const response = await chrome.tabs.sendMessage(this.currentTab.id, {
                action: 'stopMonitoring'
            });
            
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
    
    clearComments() {
        this.comments = [];
        this.renderComments();
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
        
        if (this.comments.length > 100) {
            this.comments = this.comments.slice(-100);
            console.log('[Popup] Trimmed comments to 100, current count:', this.comments.length);
        }
        
        console.log('[Popup] Final comments count after adding:', this.comments.length);
        this.renderComments();
    }
    
    formatComment(comment) {
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
    
    renderComments() {
        console.log('[Popup] === renderComments called ===');
        console.log('[Popup] Total comments:', this.comments.length);
        console.log('[Popup] Filter state:', this.commentFilters);
        
        // フィルター適用
        const filteredComments = this.comments.filter(comment => {
            switch (comment.roleClass) {
                case 'role-owner':
                    return this.commentFilters.owner;
                case 'role-moderator':
                    return this.commentFilters.moderator;
                case 'role-sponsor':
                    return this.commentFilters.sponsor;
                case 'role-normal':
                    return this.commentFilters.normal;
                default:
                    return false;
            }
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
        
        const reversedComments = [...filteredComments].reverse();
        
        this.elements.commentsList.innerHTML = reversedComments.map(comment => `
            <div class="comment-item">
                <div class="comment-header">
                    <span class="comment-role ${comment.roleClass}">${comment.role}</span>
                    <span class="comment-author">${this.escapeHtml(comment.displayName)}</span>
                    <span class="comment-time">${comment.timestamp}</span>
                </div>
                <div class="comment-message">${this.escapeHtml(comment.message)}</div>
            </div>
        `).join('');
        
        this.elements.commentsList.scrollTop = 0;
        console.log('[Popup] Comments rendered successfully');
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
        
        // 監視開始ボタンの状態とツールチップ
        if (!hasApiKey) {
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
            // まずAPIキーを確認
            chrome.runtime.sendMessage({ action: 'getApiKey' }).then(response => {
                const hasApiKey = response && response.apiKey;
                this.updateMonitoringButtons(hasApiKey);
            }).catch(() => {
                this.updateMonitoringButtons(false);
            });
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
            this.elements.successMessage.style.display = 'block';
            
            // 2秒後に自動的に非表示
            setTimeout(() => {
                this.elements.successMessage.style.animation = 'fadeOut 0.3s ease-out';
                setTimeout(() => {
                    this.elements.successMessage.style.display = 'none';
                    this.elements.successMessage.style.animation = '';
                }, 300);
            }, 2000);
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    async loadCommentFilters() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getCommentFilters' });
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
        this.renderComments(); // フィルターが変更されたら再描画
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
            await chrome.runtime.sendMessage({
                action: 'setCommentFilters',
                filters: this.commentFilters
            });
            
            this.updatePresetButtons();
            this.renderComments(); // フィルターが変更されたら再描画
            
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
            await chrome.runtime.sendMessage({
                action: 'setCommentFilters',
                filters: this.commentFilters
            });
            
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
    
}

document.addEventListener('DOMContentLoaded', () => {
    new PopupController();
});