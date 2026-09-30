// chrome.i18n の偽物。各ハーネスの chrome モックに `i18n: createI18nMock()` で差す。
//
// **本物の src/_locales/<locale>/messages.json を読む**。既存テストの日本語の
// アサーションが、文言を messages.json へ移したあともそのまま通るようにするため
// （既定の locale が 'ja' なのはそのため）。英語の表示を見たいテストは
// createI18nMock({ locale: 'en' }) を渡す。
//
// 組み立ての規則は shared/i18n.js の formatMessage とは**別に**ここで書いてある。
// 同じ実装を借りると、上書き辞書の組み立てが Chrome とずれても気付けない
// （test/i18n.test.js が両者を全キーで突き合わせる）。
//
// Chrome の規則:
//   - 見つからないキーは空文字列（undefined ではない）
//   - キーは大文字小文字を区別しない
//   - 本文の $NAME$ → placeholders[name].content、その中の $1〜$9 → substitutions
//   - $$ → $
//   - 指定言語に無いキーは default_locale（en）から引く

const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', '..', 'src', '_locales');
const DEFAULT_LOCALE = 'en';

/** locale -> Map(小文字のキー -> エントリ)。テストのたびに読み直さない */
const cache = new Map();

function loadMessages(locale) {
  if (!cache.has(locale)) {
    const file = path.join(LOCALES_DIR, locale, 'messages.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(locale, new Map(Object.entries(raw).map(([key, entry]) => [key.toLowerCase(), entry])));
  }
  return cache.get(locale);
}

function build(entry, substitutions) {
  const subs = substitutions === undefined || substitutions === null ? []
    : (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
  const placeholders = {};
  for (const [name, value] of Object.entries(entry.placeholders || {})) {
    placeholders[name.toLowerCase()] = String(value.content);
  }
  let out = '';
  const text = entry.message;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$') { out += text[i]; continue; }
    if (text[i + 1] === '$') { out += '$'; i++; continue; }
    const end = text.indexOf('$', i + 1);
    const name = end > i ? text.slice(i + 1, end) : '';
    if (end > i && /^[A-Za-z0-9_@]+$/.test(name)) {
      const content = placeholders[name.toLowerCase()] ?? '';
      out += content.replace(/\$(\d)/g, (_m, n) => subs[Number(n) - 1] ?? '');
      i = end;
      continue;
    }
    out += '$';
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {string} [options.locale] 'ja'（既定）| 'en'
 * @param {string} [options.uiLanguage] getUILanguage() の返り値（既定は locale）
 */
function createI18nMock({ locale = 'ja', uiLanguage = locale } = {}) {
  return {
    getMessage(key, substitutions) {
      const lower = String(key).toLowerCase();
      const entry = loadMessages(locale).get(lower) || loadMessages(DEFAULT_LOCALE).get(lower);
      return entry ? build(entry, substitutions) : '';
    },
    getUILanguage() { return uiLanguage; }
  };
}

module.exports = { createI18nMock, formatChromeMessage: build, LOCALES_DIR, DEFAULT_LOCALE };
