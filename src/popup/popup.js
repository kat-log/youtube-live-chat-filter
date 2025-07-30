class PopupController {
    constructor() {
        this.isMonitoring = false;
        this.comments = [];
        this.currentTab = null;
        this.currentVideoId = null;
        this.monitoringVideoId = null;
        
        this.initializeElements();
        this.attachEventListeners();
        this.loadSavedApiKey();
        this.loadAllCommentsModeState();
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
            allCommentsToggle: document.getElementById('all-comments-toggle'),
            commentsTitle: document.getElementById('comments-title'),
            commentsList: document.getElementById('comments-list'),
            noComments: document.getElementById('no-comments'),
            commentCount: document.getElementById('comment-count'),
            loading: document.getElementById('loading'),
            errorMessage: document.getElementById('error-message'),
            monitoringVideoId: document.getElementById('monitoring-video-id'),
            currentVideoId: document.getElementById('current-video-id'),
            switchToCurrentBtn: document.getElementById('switch-to-current')
        };
    }
    
    attachEventListeners() {
        this.elements.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
        this.elements.startMonitoringBtn.addEventListener('click', () => this.startMonitoring());
        this.elements.stopMonitoringBtn.addEventListener('click', () => this.stopMonitoring());
        this.elements.clearCommentsBtn.addEventListener('click', () => this.clearComments());
        this.elements.allCommentsToggle.addEventListener('change', () => this.toggleAllCommentsMode());
        this.elements.switchToCurrentBtn.addEventListener('click', () => this.switchToCurrentTab());
        
        this.elements.apiKeyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveApiKey();
            }
        });
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            console.log('[Popup] Received message:', request.action, 'with', request.comments?.length || 0, 'comments');
            if (request.action === 'newSpecialComments') {
                this.addNewComments(request.comments);
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
                this.monitoringVideoId = monitoringState.currentVideoId;
                this.updateMonitoringButtonStates();
                
                if (this.isMonitoring) {
                    this.updateStatus('監視中 (バックグラウンド)');
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
        
        // 監視中かつ同じVideo IDの場合は監視中の履歴を優先
        let targetVideoId = currentVideoId;
        if (this.isMonitoring && this.monitoringVideoId) {
            if (currentVideoId === this.monitoringVideoId) {
                console.log('[YouTube Special Comments] Loading history for currently monitored video:', this.monitoringVideoId);
                targetVideoId = this.monitoringVideoId;
            } else {
                console.log('[YouTube Special Comments] Loading history for different video:', currentVideoId, '(monitoring:', this.monitoringVideoId + ')');
            }
        }
        
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
        
        // フォールバック1: 監視中で別のVideo IDの場合、監視中Video IDから取得を試行
        if (!historyLoaded && this.isMonitoring && this.monitoringVideoId && currentVideoId !== this.monitoringVideoId) {
            console.log('[YouTube Special Comments] === Fallback 1: Loading monitoring video history ===');
            try {
                const fallbackResponse = await chrome.runtime.sendMessage({
                    action: 'getCommentsHistory',
                    videoId: this.monitoringVideoId
                });
                
                if (fallbackResponse?.success && fallbackResponse.comments && fallbackResponse.comments.length > 0) {
                    const formattedComments = this.formatHistoryComments(fallbackResponse.comments);
                    this.comments = formattedComments;
                    this.renderComments();
                    console.log('[YouTube Special Comments] Fallback 1 successful: loaded', formattedComments.length, 'comments from monitoring video');
                    historyLoaded = true;
                }
            } catch (error) {
                console.error('[YouTube Special Comments] Fallback 1 failed:', error);
            }
        }
        
        // フォールバック2: Content scriptから直接コメントを取得
        if (!historyLoaded) {
            console.log('[YouTube Special Comments] === Fallback 2: Getting comments from content script ===');
            try {
                const contentResponse = await chrome.tabs.sendMessage(this.currentTab.id, {
                    action: 'getSpecialComments'
                });
                
                if (contentResponse?.comments && contentResponse.comments.length > 0) {
                    const formattedComments = this.formatHistoryComments(contentResponse.comments);
                    this.comments = formattedComments;
                    this.renderComments();
                    console.log('[YouTube Special Comments] Fallback 2 successful: loaded', formattedComments.length, 'comments from content script');
                    historyLoaded = true;
                }
            } catch (error) {
                console.error('[YouTube Special Comments] Fallback 2 failed:', error);
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
        
        try {
            // まずcontent scriptが応答するかテスト
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
                this.updateStatus('監視中 (バックグラウンド)');
                this.showError('');
            } else {
                this.showError('監視を開始できませんでした。ライブチャットが見つからない可能性があります。');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Start monitoring error:', error);
            if (error.message.includes('Could not establish connection')) {
                this.showError('ページを再読み込みしてみてください。（Content scriptが読み込まれていません...）');
            } else {
                this.showError('監視の開始に失敗しました: ' + error.message);
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
                this.showError('監視を停止できませんでした');
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
                this.showError('監視の停止に失敗しました: ' + error.message);
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
        console.log('[Popup] Rendering', this.comments.length, 'comments');
        
        this.elements.commentCount.textContent = `${this.comments.length}件`;
        
        if (this.comments.length === 0) {
            console.log('[Popup] No comments to display, showing placeholder');
            this.elements.noComments.style.display = 'block';
            this.elements.commentsList.style.display = 'none';
            return;
        }
        
        console.log('[Popup] Displaying comments list');
        this.elements.noComments.style.display = 'none';
        this.elements.commentsList.style.display = 'block';
        
        const reversedComments = [...this.comments].reverse();
        
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
        
        if (status.includes('監視中')) {
            this.elements.statusIndicator.className = 'status-indicator status-online';
        } else {
            this.elements.statusIndicator.className = 'status-indicator status-offline';
        }
    }
    
    updateMonitoringButtons(hasApiKey) {
        const isYouTubePage = this.currentTab && this.currentTab.url && this.currentTab.url.includes('youtube.com/watch');
        
        this.elements.startMonitoringBtn.disabled = !hasApiKey || !isYouTubePage;
        this.elements.stopMonitoringBtn.disabled = !hasApiKey || !isYouTubePage;
    }
    
    updateMonitoringButtonStates() {
        this.elements.startMonitoringBtn.disabled = this.isMonitoring;
        this.elements.stopMonitoringBtn.disabled = !this.isMonitoring;
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
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    async loadAllCommentsModeState() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getAllCommentsModeState' });
            if (response && response.success) {
                this.elements.allCommentsToggle.checked = response.allCommentsMode;
                this.updateCommentsTitle(response.allCommentsMode);
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading all comments mode state:', error);
        }
    }
    
    async toggleAllCommentsMode() {
        const enabled = this.elements.allCommentsToggle.checked;
        console.log('[YouTube Special Comments] Toggling all comments mode:', enabled);
        
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'setAllCommentsMode',
                enabled: enabled
            });
            
            if (response && response.success) {
                this.updateCommentsTitle(enabled);
                // コメントをクリアして新しいモードで再取得
                this.clearComments();
                this.showMessage('モードを切り替えました。新しいコメントが表示されます。', 'success');
            } else {
                console.error('[YouTube Special Comments] Failed to toggle all comments mode');
                // トグルを元に戻す
                this.elements.allCommentsToggle.checked = !enabled;
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Error toggling all comments mode:', error);
            // トグルを元に戻す
            this.elements.allCommentsToggle.checked = !enabled;
        }
    }
    
    updateCommentsTitle(allCommentsMode) {
        if (allCommentsMode) {
            this.elements.commentsTitle.textContent = '全コメント履歴';
        } else {
            this.elements.commentsTitle.textContent = '特別コメント履歴';
        }
    }
    
    updateVideoIdDisplay() {
        console.log('[YouTube Special Comments] Updating video ID display:', {
            currentVideoId: this.currentVideoId,
            monitoringVideoId: this.monitoringVideoId,
            isMonitoring: this.isMonitoring
        });
        
        // 現在のタブのVideo IDを表示
        if (this.currentVideoId) {
            this.elements.currentVideoId.textContent = this.currentVideoId;
        } else {
            this.elements.currentVideoId.textContent = '未検出';
        }
        
        // 監視中のVideo IDを表示
        if (this.monitoringVideoId) {
            this.elements.monitoringVideoId.textContent = this.monitoringVideoId;
        } else {
            this.elements.monitoringVideoId.textContent = '未設定';
        }
        
        // 切り替えボタンの表示/非表示を制御
        if (this.currentVideoId && this.monitoringVideoId && 
            this.currentVideoId !== this.monitoringVideoId) {
            this.elements.switchToCurrentBtn.style.display = 'block';
            console.log('[YouTube Special Comments] Switch button shown - different videos');
        } else {
            this.elements.switchToCurrentBtn.style.display = 'none';
            if (this.currentVideoId === this.monitoringVideoId) {
                console.log('[YouTube Special Comments] Switch button hidden - same video');
            } else {
                console.log('[YouTube Special Comments] Switch button hidden - missing video ID');
            }
        }
    }
    
    async switchToCurrentTab() {
        if (!this.currentVideoId) {
            this.showError('現在のタブのVideo IDが検出されていません');
            return;
        }
        
        console.log('[YouTube Special Comments] Switching to current tab video:', this.currentVideoId);
        this.showLoading(true);
        
        try {
            // 現在の監視を停止
            if (this.isMonitoring) {
                await chrome.tabs.sendMessage(this.currentTab.id, {
                    action: 'stopMonitoring'
                });
            }
            
            // 新しいVideo IDで監視を開始
            const response = await chrome.tabs.sendMessage(this.currentTab.id, {
                action: 'startMonitoring'
            });
            
            console.log('[YouTube Special Comments] Switch response:', response);
            
            if (response && response.success) {
                this.monitoringVideoId = this.currentVideoId;
                this.isMonitoring = true;
                this.updateMonitoringButtonStates();
                this.updateStatus('監視中 (バックグラウンド)');
                this.updateVideoIdDisplay();
                
                // 新しいVideo IDのコメント履歴をロード
                await this.loadExistingComments();
                
                this.showError('');
                this.showMessage('現在のタブに切り替えました', 'success');
            } else {
                this.showError('切り替えに失敗しました。ライブチャットが見つからない可能性があります。');
            }
        } catch (error) {
            console.error('[YouTube Special Comments] Switch error:', error);
            if (error.message.includes('Could not establish connection')) {
                this.showError('ページを再読み込みしてみてください。（Content scriptが読み込まれていません...）');
            } else {
                this.showError('切り替えに失敗しました: ' + error.message);
            }
        } finally {
            this.showLoading(false);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new PopupController();
});