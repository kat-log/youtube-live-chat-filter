// HTMLタグ除去は shared/comment.js の正規表現版に統一している（#27）。
// 外部由来の文字列を innerHTML に通すと、切り離した要素でも <img> の
// 読み込みだけは走る。options.html で options.js より先に読み込んでいる
const { stripHtmlTags } = self.YTF;

// テーマの適用は shared/theme.js が正（#14 #15）。options.html の <head> から
// 読み込んでいるので、この画面もダークモードに追従する。
// 以前はこのページだけが仕組みの外にあり、**ダークモードのトグルを載せている
// ページ自身が永久にライトテーマ**だった
const { applyTheme } = self.YTFTheme;

// 表示文言は shared/i18n.js（docs/i18n-plan.md）。options.html に直接書いてある
// 文言は英語で、初期化の冒頭で applyTo() が data-i18n* を差し替える。
// 文言で分岐しないこと（状態はフラグで持ち、文言は描くときだけ引く）
const { t, LANGUAGE_KEY, normalizeLanguage, apiErrorText } = self.YTFi18n;

// テーマはこの画面からも popup からも変えられる。どちらで変えても
// 経路を1本にするため、自分の保存も含めて storage.onChanged で受ける
// （chrome.storage.onChanged は書いた本人のページにも飛ぶ）
chrome.storage.onChanged.addListener((changes) => {
    if (!changes.theme) return;
    const theme = applyTheme(changes.theme.newValue);
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.checked = (theme === 'dark');
});

class OptionsController {
    constructor() {
        // ボタンの文言を決める状態。文言（'保存中...' など）を読んで分岐しないために持つ
        this.saving = false;
        this.testing = false;
        // 言語の適用は1本の列で順に流す。続けて切り替えたとき、先に始めた読み込みが
        // あとから終わって古い言語で上書きするのを防ぐ
        this.languageQueue = Promise.resolve();

        this.initializeElements();
        this.attachEventListeners();
        // 文言を先に決めてから設定を読む（読み込みの失敗をトーストで出すときに、
        // 選ばれた言語で出すため）。テストはこの Promise を待つ
        this.ready = this.applyLanguage().then(() => this.loadSettings());
    }

    // API のエラーの説明を、こちらの文言に置き換える。
    // 対訳表は shared/i18n.js の API_ERROR_KEYS（popup の分類できないエラーと共有）。
    // 当たらなければ API の説明をタグだけ除いてそのまま出す（訳さない）
    improveErrorMessage(originalMessage) {
        const cleanMessage = stripHtmlTags(originalMessage);
        return apiErrorText(cleanMessage) ?? cleanMessage;
    }

    /**
     * 表示言語を決めて、options.html の data-i18n* と、JS が書く文言を描き直す。
     * 初期化のときと、uiLanguage が変わったとき（この画面のセレクト・別の options の
     * タブ）に呼ぶ。popup は開くたびに読むので、ここから知らせる必要は無い
     */
    applyLanguage() {
        this.languageQueue = this.languageQueue.then(async () => {
            const language = await self.YTFi18n.loadOverride();
            self.YTFi18n.applyTo(document);
            this.elements.languageSelect.value = language;
            this.renderDynamicText();
        });
        return this.languageQueue;
    }

    // JS が書く文言（data-i18n を付けていない要素）。いまの状態から描き直す
    renderDynamicText() {
        const { apiKeyInput, toggleVisibilityBtn, saveSettingsBtn, testApiBtn } = this.elements;
        // キーは t() の引数にそのまま書く（test/i18n.test.js が引かれているキーを拾うため）
        toggleVisibilityBtn.textContent = apiKeyInput.type === 'password' ? t('optShowKey') : t('optHideKey');
        saveSettingsBtn.textContent = this.saving ? t('optSaving') : t('optSave');
        testApiBtn.textContent = this.testing ? t('optTesting') : t('optTestApi');
    }
    
    initializeElements() {
        this.elements = {
            apiKeyInput: document.getElementById('api-key'),
            toggleVisibilityBtn: document.getElementById('toggle-visibility'),
            saveSettingsBtn: document.getElementById('save-settings'),
            testApiBtn: document.getElementById('test-api'),
            debugModeSwitch: document.getElementById('debug-mode'),
            autoStartSwitch: document.getElementById('auto-start'),
            themeToggle: document.getElementById('theme-toggle'),
            timeHour12Toggle: document.getElementById('time-hour12'),
            timeSecondsToggle: document.getElementById('time-seconds'),
            languageSelect: document.getElementById('ui-language'),
            toast: document.getElementById('toast')
        };
    }
    
    attachEventListeners() {
        this.elements.toggleVisibilityBtn.addEventListener('click', () => this.toggleApiKeyVisibility());
        this.elements.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.elements.testApiBtn.addEventListener('click', () => this.testApiConnection());
        this.elements.debugModeSwitch.addEventListener('change', () => this.saveDebugMode());
        this.elements.autoStartSwitch.addEventListener('change', () => this.saveAutoStart());
        this.elements.themeToggle.addEventListener('change', () => this.saveTheme());
        this.elements.timeHour12Toggle.addEventListener('change', () => this.saveTimeFormat());
        this.elements.timeSecondsToggle.addEventListener('change', () => this.saveTimeFormat());
        this.elements.languageSelect.addEventListener('change', () => this.saveLanguage());

        // 表示言語は、この画面のセレクトでも別の options のタブでも変わりうる。
        // テーマと同じく、自分の保存も含めて storage.onChanged の1本で描き直す
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local' && changes[LANGUAGE_KEY]) this.applyLanguage();
        });
        
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
            const [apiResponse, debugResponse, autoStartResponse, themeResult] = await Promise.all([
                chrome.runtime.sendMessage({ action: 'getApiKey' }),
                chrome.runtime.sendMessage({ action: 'getDebugMode' }),
                chrome.runtime.sendMessage({ action: 'getAutoStart' }),
                chrome.storage.local.get(['theme', 'timeHour12', 'timeShowSeconds'])
            ]);

            if (apiResponse.apiKey) {
                this.elements.apiKeyInput.value = apiResponse.apiKey;
            }

            if (debugResponse.debugMode !== undefined) {
                this.elements.debugModeSwitch.checked = debugResponse.debugMode;
            }

            if (autoStartResponse && autoStartResponse.autoStart !== undefined) {
                this.elements.autoStartSwitch.checked = autoStartResponse.autoStart;
            }

            this.elements.themeToggle.checked = (themeResult.theme === 'dark');

            // 未設定時は従来の見た目（24時間表記・秒あり）に合わせる
            this.elements.timeHour12Toggle.checked = (themeResult.timeHour12 === true);
            this.elements.timeSecondsToggle.checked = (themeResult.timeShowSeconds !== false);

            this.updateButtonStates();
        } catch (error) {
            console.error('Error loading settings:', error);
            this.showToast(t('optLoadFailed'), 'error');
        }
    }
    
    async saveSettings() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showToast(t('optApiKeyRequired'), 'error');
            this.elements.apiKeyInput.focus();
            return;
        }
        
        this.elements.saveSettingsBtn.disabled = true;
        this.saving = true;
        this.renderDynamicText();
        
        try {
            const apiResponse = await chrome.runtime.sendMessage({
                action: 'saveApiKey',
                apiKey: apiKey
            });
            
            if (apiResponse.success) {
                this.showToast(t('optSaved'), 'success');
            } else {
                this.showToast(t('optSaveFailed'), 'error');
            }
        } catch (error) {
            console.error('Error saving settings:', error);
            this.showToast(t('optSaveFailedDetail', error.message), 'error');
        } finally {
            this.elements.saveSettingsBtn.disabled = false;
            this.saving = false;
            this.renderDynamicText();
            this.updateButtonStates();
        }
    }
    
    // デバッグモードはAPIキーと無関係に保存する。
    // saveSettings() に相乗りしていたころは、APIキー未設定（DOMモードの既定構成）だと
    // 早期 return に当たって一生ONにできなかった
    async saveDebugMode() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveDebugMode',
                debugMode: this.elements.debugModeSwitch.checked
            });
            if (!response || !response.success) {
                this.showToast(t('optDebugSaveFailed'), 'error');
            }
        } catch (error) {
            console.error('Error saving debug mode setting:', error);
            this.showToast(t('optDebugSaveFailed'), 'error');
        }
    }

    async saveAutoStart() {
        try {
            await chrome.runtime.sendMessage({
                action: 'saveAutoStart',
                autoStart: this.elements.autoStartSwitch.checked
            });
        } catch (error) {
            console.error('Error saving auto-start setting:', error);
        }
    }

    async saveTimeFormat() {
        try {
            // ポップアップ側は chrome.storage.onChanged を見て再描画する
            await chrome.storage.local.set({
                timeHour12: this.elements.timeHour12Toggle.checked,
                timeShowSeconds: this.elements.timeSecondsToggle.checked
            });
        } catch (error) {
            console.error('Error saving time format setting:', error);
        }
    }

    async saveTheme() {
        try {
            // 塗るのが先、保存が後。storage.onChanged は非同期に返ってくるので、
            // 待ってから塗ると切り替えが一拍遅れて見える
            const theme = applyTheme(this.elements.themeToggle.checked ? 'dark' : 'light');
            await chrome.storage.local.set({ theme });
        } catch (error) {
            console.error('Error saving theme setting:', error);
        }
    }

    // 表示言語（'auto' | 'en' | 'ja'）。描き直しは storage.onChanged から
    async saveLanguage() {
        try {
            await chrome.storage.local.set({
                [LANGUAGE_KEY]: normalizeLanguage(this.elements.languageSelect.value)
            });
        } catch (error) {
            console.error('Error saving language setting:', error);
        }
    }

    async testApiConnection() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showToast(t('optApiKeyRequired'), 'error');
            this.elements.apiKeyInput.focus();
            return;
        }
        
        this.elements.testApiBtn.disabled = true;
        this.testing = true;
        this.renderDynamicText();
        
        try {
            // キーの有効性が分かればよいので、search.list（100 units）ではなく
            // videos.list（1 unit）を叩く。IDは実在の動画である必要すら無く、
            // キーが有効なら 200、無効なら 400/403 が返る
            const testUrl = `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${apiKey}`;
            
            const response = await fetch(testUrl);
            
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    this.showToast(t('optApiTestSucceeded'), 'success');
                } else {
                    this.showToast(t('optApiTestFailed', t('optApiTestUnexpected')), 'error');
                }
            } else {
                const errorData = await response.json();
                const rawMessage = errorData.error?.message || `HTTP ${response.status}`;
                const cleanMessage = this.improveErrorMessage(rawMessage);
                this.showToast(t('optApiTestFailed', cleanMessage), 'error');
            }
        } catch (error) {
            console.error('Error testing API:', error);
            this.showToast(t('optApiTestFailed', t('optApiTestNetwork')), 'error');
        } finally {
            this.elements.testApiBtn.disabled = false;
            this.testing = false;
            this.renderDynamicText();
        }
    }
    
    toggleApiKeyVisibility() {
        const input = this.elements.apiKeyInput;
        input.type = input.type === 'password' ? 'text' : 'password';
        this.renderDynamicText();
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