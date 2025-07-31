class OptionsController {
    constructor() {
        this.initializeElements();
        this.attachEventListeners();
        this.loadSettings();
    }
    
    // HTMLタグ除去ユーティリティ関数
    stripHtmlTags(html) {
        if (!html) return '';
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.textContent || div.innerText || '';
    }
    
    // エラーメッセージ改善関数
    improveErrorMessage(originalMessage) {
        const cleanMessage = this.stripHtmlTags(originalMessage);
        
        // よくあるYouTube API エラーの日本語化
        const errorMappings = {
            'exceeded your quota': 'API使用量制限に達しました。明日再試行するか、Google Cloud Consoleで制限を増やしてください',
            'quotaExceeded': 'API使用量制限に達しました',
            'API key not valid': 'APIキーが無効です。Google Cloud ConsoleでAPIキーを確認してください',
            'Access denied': 'アクセスが拒否されました。APIキーの権限を確認してください',
            'Forbidden': 'アクセス権限がありません。APIキーとYouTube Data API v3の有効化を確認してください',
            'Bad Request': 'リクエストが無効です。APIキーを確認してください',
            'rateLimitExceeded': 'アクセス頻度制限に達しました。しばらく待ってから再試行してください'
        };
        
        // エラーメッセージから該当するパターンを検索
        for (const [pattern, japanese] of Object.entries(errorMappings)) {
            if (cleanMessage.toLowerCase().includes(pattern.toLowerCase())) {
                return japanese;
            }
        }
        
        return cleanMessage;
    }
    
    initializeElements() {
        this.elements = {
            apiKeyInput: document.getElementById('api-key'),
            toggleVisibilityBtn: document.getElementById('toggle-visibility'),
            saveSettingsBtn: document.getElementById('save-settings'),
            testApiBtn: document.getElementById('test-api'),
            toast: document.getElementById('toast')
        };
    }
    
    attachEventListeners() {
        this.elements.toggleVisibilityBtn.addEventListener('click', () => this.toggleApiKeyVisibility());
        this.elements.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.elements.testApiBtn.addEventListener('click', () => this.testApiConnection());
        
        this.elements.apiKeyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveSettings();
            }
        });
        
        this.elements.apiKeyInput.addEventListener('input', () => {
            this.updateButtonStates();
        });
    }
    
    async loadSettings() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getApiKey' });
            if (response.apiKey) {
                this.elements.apiKeyInput.value = response.apiKey;
            }
            this.updateButtonStates();
        } catch (error) {
            console.error('Error loading settings:', error);
            this.showToast('設定の読み込みに失敗しました', 'error');
        }
    }
    
    async saveSettings() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showToast('APIキーを入力してください', 'error');
            this.elements.apiKeyInput.focus();
            return;
        }
        
        this.elements.saveSettingsBtn.disabled = true;
        this.elements.saveSettingsBtn.textContent = '保存中...';
        
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveApiKey',
                apiKey: apiKey
            });
            
            if (response.success) {
                this.showToast('設定が保存されました', 'success');
            } else {
                this.showToast('設定の保存に失敗しました', 'error');
            }
        } catch (error) {
            console.error('Error saving settings:', error);
            this.showToast('設定の保存に失敗しました: ' + error.message, 'error');
        } finally {
            this.elements.saveSettingsBtn.disabled = false;
            this.elements.saveSettingsBtn.textContent = '設定を保存';
            this.updateButtonStates();
        }
    }
    
    async testApiConnection() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showToast('APIキーを入力してください', 'error');
            this.elements.apiKeyInput.focus();
            return;
        }
        
        this.elements.testApiBtn.disabled = true;
        this.elements.testApiBtn.textContent = 'テスト中...';
        
        try {
            const testUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=test&type=video&key=${apiKey}`;
            
            const response = await fetch(testUrl);
            
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    this.showToast('API接続テスト成功', 'success');
                } else {
                    this.showToast('API接続テスト失敗: 予期しないレスポンス', 'error');
                }
            } else {
                const errorData = await response.json();
                const rawMessage = errorData.error?.message || `HTTP ${response.status}`;
                const cleanMessage = this.improveErrorMessage(rawMessage);
                this.showToast(`API接続テスト失敗: ${cleanMessage}`, 'error');
            }
        } catch (error) {
            console.error('Error testing API:', error);
            this.showToast('API接続テスト失敗: ネットワークエラー', 'error');
        } finally {
            this.elements.testApiBtn.disabled = false;
            this.elements.testApiBtn.textContent = 'API接続テスト';
        }
    }
    
    toggleApiKeyVisibility() {
        const input = this.elements.apiKeyInput;
        const button = this.elements.toggleVisibilityBtn;
        
        if (input.type === 'password') {
            input.type = 'text';
            button.textContent = '非表示';
        } else {
            input.type = 'password';
            button.textContent = '表示';
        }
    }
    
    updateButtonStates() {
        const hasApiKey = this.elements.apiKeyInput.value.trim().length > 0;
        this.elements.testApiBtn.disabled = !hasApiKey;
    }
    
    showToast(message, type = 'info') {
        const toast = this.elements.toast;
        toast.textContent = message;
        toast.className = `toast ${type}`;
        
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new OptionsController();
});