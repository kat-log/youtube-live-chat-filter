// 表示文言の引き当て（英語対応。docs/i18n-plan.md）。
//
// 文言の正は Chrome 標準の src/_locales/<lang>/messages.json ただ1つ。
// ふだんは chrome.i18n.getMessage() がブラウザの表示言語で引く。
// ストアの掲載名・短い説明も同じファイル（manifest の __MSG_extName__ など）から
// 言語別に出るので、独自の形式は作らない。
//
// 標準に無いのは「利用者が言語を選ぶ」ことだけ。chrome.i18n はブラウザの言語で
// 固定され上書きできないので、選ばれたときだけ**同じ messages.json を自前で読み**、
// Chrome と同じ規則で組み立てる（loadOverride / formatMessage）。
// manifest 由来の名前とツールバーのツールチップは、この上書きに追従しない（仕様上の制約）。
//
// 【触るときの注意】
// - shared/ の流儀どおり、二重注入ガードで包まない・代入先は self・即時実行関数で包む
// - HTML の中に __MSG_ は効かない（効くのは manifest と CSS だけ）。HTML は
//   data-i18n* 属性を付けて applyTo() で流し込む
// - CSS の __MSG_ は手動切替に追従しないので使わない
// - document に触るのは applyTo() だけ。ほかは Service Worker でも動く
(function () {
    // storage.local のキー。値は 'auto' | 'en' | 'ja'（未保存は 'auto'）
    const LANGUAGE_KEY = 'uiLanguage';
    const AUTO = 'auto';
    // _locales/ にある言語。先頭が manifest の default_locale と同じ既定
    const SUPPORTED_LANGUAGES = ['en', 'ja'];
    const DEFAULT_LANGUAGE = SUPPORTED_LANGUAGES[0];

    // data-i18n* 属性と、訳した文字列の書き込み先（null は textContent）
    const ATTRIBUTE_BINDINGS = [
        ['data-i18n', null],
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-aria-label', 'aria-label']
    ];

    // 手動で選ばれた言語の辞書。null ならブラウザの言語（chrome.i18n）に任せる。
    // キーは小文字にそろえて持つ（Chrome のメッセージ名は大文字小文字を区別しない）
    let override = null;

    function normalizeLanguage(language) {
        return SUPPORTED_LANGUAGES.includes(language) ? language : AUTO;
    }

    function toSubstitutions(substitutions) {
        if (substitutions === undefined || substitutions === null) return [];
        return (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
    }

    // messages.json の1件を Chrome と同じ規則で組み立てる。
    //   - 本文の $NAME$ は placeholders の name（大文字小文字を区別しない）の content に置き換える
    //   - content の中の $1〜$9 が substitutions の n 番目
    //   - $$ は $ そのもの
    function formatMessage(entry, substitutions) {
        if (!entry || typeof entry.message !== 'string') return '';
        const subs = toSubstitutions(substitutions);
        const placeholders = new Map(
            Object.entries(entry.placeholders || {}).map(([name, value]) => [name.toLowerCase(), value])
        );
        const fill = content => String(content).replace(/\$(\d)/g, (_m, n) => subs[Number(n) - 1] ?? '');
        return entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (match, name) => {
            if (match === '$$') return '$';
            const placeholder = placeholders.get(name.toLowerCase());
            return placeholder ? fill(placeholder.content) : '';
        });
    }

    function lowerCaseKeys(messages) {
        return new Map(Object.entries(messages || {}).map(([key, value]) => [key.toLowerCase(), value]));
    }

    /**
     * 文言を引く。見つからなければキー自身を返す（欠落が画面で目に見えるように）。
     * @param {string} key messages.json のキー
     * @param {string|number|Array} [substitutions] $1〜$9 に入る値
     */
    function t(key, substitutions) {
        if (override) {
            const text = formatMessage(override.messages.get(String(key).toLowerCase()), substitutions);
            if (text) return text;
        }
        let text = '';
        try {
            text = chrome.i18n.getMessage(key, toSubstitutions(substitutions));
        } catch (_error) {
            // i18n API の無い文脈（想定外）。キーを返して表示だけは続ける
        }
        return text || key;
    }

    /** いま表示に使っている言語（'en' | 'ja'）。<html lang> に入れる */
    function currentLanguage() {
        if (override) return override.language;
        let ui = '';
        try {
            ui = chrome.i18n.getUILanguage() || '';
        } catch (_error) {
            // 取れなければ既定
        }
        // Chrome は 'ja' や 'en-US' を返す。_locales に無い言語は default_locale に落ちる
        const base = ui.toLowerCase().split(/[-_]/)[0];
        return SUPPORTED_LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
    }

    /**
     * storage.local の uiLanguage を読み、手動で選ばれていれば辞書を読み込む。
     * 'auto'（未保存を含む）なら上書きを外して chrome.i18n に任せる。
     * @returns {Promise<string>} 読んだ設定値（'auto' | 'en' | 'ja'）
     */
    async function loadOverride() {
        let language = AUTO;
        try {
            const stored = await chrome.storage.local.get([LANGUAGE_KEY]);
            language = normalizeLanguage(stored[LANGUAGE_KEY]);
        } catch (error) {
            // エラーは debugMode に関係なく出す（根本原因F）
            console.error('[I18n] Failed to read language setting:', error);
        }

        if (language === AUTO) {
            override = null;
            return AUTO;
        }

        try {
            const response = await fetch(chrome.runtime.getURL(`_locales/${language}/messages.json`));
            override = { language, messages: lowerCaseKeys(await response.json()) };
        } catch (error) {
            // 読めなければブラウザの言語で出す。画面が空になるよりよい
            console.error('[I18n] Failed to load messages:', language, error);
            override = null;
        }
        return language;
    }

    // YouTube Data API が返す英語のエラーの説明 → こちらの文言。
    // 突き合わせは「説明に含まれるか」（大文字小文字を区別しない）で、上から順に見る
    // （'exceeded your quota' を 'quotaExceeded' より先に）。
    // 値は messages.json のキーを引く関数にしてある。キーを文字列のまま持つと
    // test/i18n.test.js の「誰も引かないキー」に見えなくなり、文言を固めて持つと
    // 手動の言語切替に追従しない。
    // 使うのは options の API接続テストと、popup の分類できないエラー（detail）。
    // Service Worker は文言を作らない（突き合わせは SW 自身の分類表が英語のまま行う）
    // ので、この表は読まない
    const API_ERROR_KEYS = Object.freeze([
        ['exceeded your quota', () => t('apiErrQuotaExceeded')],
        ['quotaExceeded', () => t('apiErrQuota')],
        ['API key not valid', () => t('apiErrKeyInvalid')],
        ['Access denied', () => t('apiErrAccessDenied')],
        ['Forbidden', () => t('apiErrForbidden')],
        ['Bad Request', () => t('apiErrBadRequest')],
        ['rateLimitExceeded', () => t('apiErrRateLimit')]
    ]);

    /**
     * API のエラーの説明を、こちらの文言に置き換える。対訳が無ければ null
     * （呼び出し側が API の説明をそのまま出す。こちらの文言ではないので訳さない）
     */
    function apiErrorText(message) {
        const lower = String(message ?? '').toLowerCase();
        for (const [pattern, text] of API_ERROR_KEYS) {
            if (lower.includes(pattern.toLowerCase())) return text();
        }
        return null;
    }

    /** data-i18n* の付いた要素に文言を流し込み、<html lang> をそろえる */
    function applyTo(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        for (const [attribute, target] of ATTRIBUTE_BINDINGS) {
            for (const element of root.querySelectorAll(`[${attribute}]`)) {
                const text = t(element.getAttribute(attribute));
                if (target) element.setAttribute(target, text);
                else element.textContent = text;
            }
        }
        if (root.documentElement) root.documentElement.lang = currentLanguage();
    }

    self.YTFi18n = {
        LANGUAGE_KEY,
        AUTO,
        SUPPORTED_LANGUAGES,
        DEFAULT_LANGUAGE,
        normalizeLanguage,
        formatMessage,
        t,
        currentLanguage,
        loadOverride,
        applyTo,
        API_ERROR_KEYS,
        apiErrorText
    };
})();
