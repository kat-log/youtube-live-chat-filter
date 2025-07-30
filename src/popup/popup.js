class PopupController {
    constructor() {
        this.isMonitoring = false;
        this.comments = [];
        this.currentTab = null;
        
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
            errorMessage: document.getElementById('error-message')
        };
    }
    
    attachEventListeners() {
        this.elements.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
        this.elements.startMonitoringBtn.addEventListener('click', () => this.startMonitoring());
        this.elements.stopMonitoringBtn.addEventListener('click', () => this.stopMonitoring());
        this.elements.clearCommentsBtn.addEventListener('click', () => this.clearComments());
        this.elements.allCommentsToggle.addEventListener('change', () => this.toggleAllCommentsMode());
        
        this.elements.apiKeyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveApiKey();
            }
        });
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
            console.log('[YouTube Special Comments] Loading existing comments and monitoring state...');
            
            // background scriptから監視状態を取得
            const backgroundResponse = await chrome.runtime.sendMessage({
                action: 'getMonitoringState'
            });
            
            console.log('[YouTube Special Comments] Background monitoring state:', backgroundResponse);
            
            if (backgroundResponse && backgroundResponse.success) {
                this.isMonitoring = backgroundResponse.isMonitoring;
                this.updateMonitoringButtonStates();
                
                if (backgroundResponse.isMonitoring) {
                    this.updateStatus('監視中 (バックグラウンド)');
                }
            }
            
            // background scriptからコメント履歴を取得
            const historyResponse = await chrome.runtime.sendMessage({
                action: 'getCommentsHistory'
            });
            
            console.log('[YouTube Special Comments] Comments history response:', historyResponse);
            
            if (historyResponse && historyResponse.success && historyResponse.comments) {
                // 履歴からコメントを復元
                console.log('[YouTube Special Comments] Raw history data length:', historyResponse.comments.length);
                
                const formattedComments = historyResponse.comments.map((comment, index) => {
                    try {
                        const formatted = this.formatComment(comment);
                        console.log(`[YouTube Special Comments] Formatted comment ${index}:`, {
                            role: formatted.role,
                            author: formatted.displayName,
                            message: formatted.message ? formatted.message.substring(0, 30) + '...' : 'undefined'
                        });
                        return formatted;
                    } catch (error) {
                        console.error(`[YouTube Special Comments] Error formatting comment ${index}:`, error, comment);
                        return null;
                    }
                }).filter(comment => comment !== null);
                
                this.comments = formattedComments;
                this.renderComments();
                console.log('[YouTube Special Comments] Successfully loaded', formattedComments.length, 'formatted comments from history');
            } else {
                console.log('[YouTube Special Comments] No history data available:', historyResponse);
            }
            
            // content scriptからライブチャット状態を取得
            try {
                const response = await chrome.tabs.sendMessage(this.currentTab.id, {
                    action: 'getSpecialComments'
                });
                
                console.log('[YouTube Special Comments] Response from content script:', response);
                
                if (response && response.liveChatId) {
                    if (!this.isMonitoring) {
                        this.updateStatus('ライブチャット検出済み');
                    }
                } else {
                    if (!this.isMonitoring) {
                        this.updateStatus('ライブチャット未検出');
                    }
                }
            } catch (contentError) {
                console.log('[YouTube Special Comments] Content script not available:', contentError);
                if (!this.isMonitoring) {
                    this.updateStatus('ライブチャット未検出');
                }
            }
            
        } catch (error) {
            console.error('[YouTube Special Comments] Error loading existing comments:', error);
            this.showError('コメント履歴の読み込みに失敗しました。');
            this.updateStatus('エラー');
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
                this.showError('Content scriptが読み込まれていません。ページを再読み込みしてください。');
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
                this.showError('Content scriptとの通信に失敗しました。');
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
        }
        
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
        this.elements.commentCount.textContent = `${this.comments.length}件`;
        
        if (this.comments.length === 0) {
            this.elements.noComments.style.display = 'block';
            this.elements.commentsList.style.display = 'none';
            return;
        }
        
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
}

document.addEventListener('DOMContentLoaded', () => {
    new PopupController();
});