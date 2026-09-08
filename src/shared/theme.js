// テーマの適用と読み込み。**popup と options の両方から読む唯一の置き場**。
//
// 同じ shared/ でも comment.js（3環境）や store.js（Service Worker と popup）とは
// 読まれる先が違い、**これは拡張機能のページ2枚だけ**が読む。
// document と localStorage を触るので、Service Worker から importScripts してはいけない
// （eslint.config.js もこのファイルだけ別のグローバルで見ている）。
//
// 正は chrome.storage.local の `theme` ただ1つ。localStorage はその写しで、
// 「ページを開いた瞬間」に同期で読める場所が他に無いから置いている（#15）。
// chrome.storage は非同期なので、応答を待ってから塗ると、待っているあいだ
// CSS の既定（popup.css は :root がダーク）が見える —— ライトテーマの利用者が
// 起動直後に真っ黒な popup を見ていたのはこれが理由。
// このファイルは **<head> から読み込む**こと。最初の描画より前に属性を立てるため。
(function () {
    // 保存されていないときの既定。popup / options の両方がこの値を前提にしている
    const DEFAULT_THEME = 'light';
    // localStorage 上の写しの置き場。storage.local の 'theme' とは別物
    const CACHE_KEY = 'ytcf.theme';

    function normalizeTheme(theme) {
        return theme === 'dark' ? 'dark' : DEFAULT_THEME;
    }

    // localStorage はブラウザの設定によっては読み書きで例外を投げる。
    // 写しが取れないだけで済ませたいので、必ず握りつぶす（正は storage.local）
    function readCache() {
        try {
            if (typeof localStorage === 'undefined') return null;
            return localStorage.getItem(CACHE_KEY);
        } catch (_error) {
            return null;
        }
    }

    function writeCache(theme) {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(CACHE_KEY, theme);
        } catch (_error) {
            // 書けなくても実害は「次に開いたときの一瞬」だけ
        }
    }

    /** data-theme を立てて、写しも更新する。テーマを変える経路はここ1本 */
    function applyTheme(theme) {
        const normalized = normalizeTheme(theme);
        document.documentElement.setAttribute('data-theme', normalized);
        writeCache(normalized);
        return normalized;
    }

    /** storage を待たずに写しから塗る（#15）。待てるのは最初の描画までではない */
    function applyCachedTheme() {
        return applyTheme(readCache());
    }

    /** 正（storage.local）から読み直して塗る。写しのずれはここで直る */
    async function loadTheme() {
        try {
            const { theme } = await chrome.storage.local.get(['theme']);
            return applyTheme(theme);
        } catch (error) {
            // エラーは debugMode に関係なく出す（根本原因F）
            console.error('[Theme] Failed to load theme:', error);
            return null;
        }
    }

    self.YTFTheme = { DEFAULT_THEME, CACHE_KEY, normalizeTheme, applyTheme, applyCachedTheme, loadTheme };

    // 読み込みと同時に塗る。<head> から読むので、この2行が最初の描画より前に走る
    applyCachedTheme();
    loadTheme();
})();
