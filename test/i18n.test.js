// 英語対応（docs/i18n-plan.md）のテスト。
//
// 機械で防ぐものは3つ:
//   1. messages.json どうしのずれ（片方の言語にだけキーがある・placeholder の名前が違う）
//   2. ソースと messages.json のずれ（引いているのに無いキー・誰も引かないキー）
//   3. shared/i18n.js の上書き辞書（手動の言語切替）が、chrome.i18n と違う文字列を組み立てること

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { createI18nMock, formatChromeMessage, LOCALES_DIR, DEFAULT_LOCALE } = require('./helpers/i18n-mock');

const SRC = path.join(__dirname, '..', 'src');
const I18N_PATH = path.join(SRC, 'shared', 'i18n.js');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

const LOCALES = fs.readdirSync(LOCALES_DIR).sort();
const messagesOf = locale =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

/** src/ の下（_locales を除く）の .js / .html / .css と manifest.json */
function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_locales') out.push(...sourceFiles(full));
    } else if (/\.(js|html|css)$/.test(entry.name) || entry.name === 'manifest.json') {
      out.push(full);
    }
  }
  return out;
}

/** ソースが「このキーを引いている」と確実に言える書き方だけを拾う */
function referencedKeys() {
  const patterns = [
    /__MSG_([A-Za-z0-9_]+)__/g,
    /data-i18n(?:-title|-placeholder|-aria-label)?="([A-Za-z0-9_]+)"/g,
    /\bt\(\s*'([A-Za-z0-9_]+)'/g
  ];
  const refs = new Map();
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const [, key] of text.matchAll(pattern)) {
        if (!refs.has(key)) refs.set(key, path.relative(SRC, file));
      }
    }
  }
  return refs;
}

/** shared/i18n.js を評価する。fetch は _locales の実物を返す */
function loadI18n({ locale = 'ja', uiLanguage = locale, storage = {}, fetchFails = false } = {}) {
  const fetched = [];
  const context = vm.createContext({
    console: { ...console, error: () => {} },
    chrome: {
      i18n: createI18nMock({ locale, uiLanguage }),
      runtime: { getURL: file => `chrome-extension://test-extension-id/${file}` },
      storage: { local: { get: async () => structuredClone(storage) } }
    },
    async fetch(url) {
      fetched.push(url);
      if (fetchFails) throw new Error('offline');
      const file = url.replace('chrome-extension://test-extension-id/', '');
      const body = fs.readFileSync(path.join(SRC, file), 'utf8');
      return { json: async () => JSON.parse(body) };
    }
  });
  context.self = context;
  vm.runInContext(fs.readFileSync(I18N_PATH, 'utf8'), context, { filename: I18N_PATH });
  return { i18n: context.YTFi18n, fetched };
}

describe('messages.json どうし', () => {
  test('_locales には en と ja があり、default_locale は en', () => {
    assert.deepEqual(LOCALES, ['en', 'ja']);
    assert.equal(manifest.default_locale, DEFAULT_LOCALE);
  });

  test('全言語でキーの集合が同じ', () => {
    const [base, ...rest] = LOCALES.map(locale => Object.keys(messagesOf(locale)).sort());
    for (const [i, keys] of rest.entries()) {
      assert.deepEqual(keys, base, `${LOCALES[i + 1]} のキーが ${LOCALES[0]} とずれている`);
    }
  });

  test('キーの名前は Chrome が受け付ける形で、@@ で始めない', () => {
    for (const key of Object.keys(messagesOf(DEFAULT_LOCALE))) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `使えない文字を含むキー: ${key}`);
    }
  });

  test('どのエントリにも本文と description（使われる場所）がある', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(messagesOf(locale))) {
        assert.equal(typeof entry.message, 'string', `${locale}.${key} に message が無い`);
        assert.ok(entry.message.length > 0, `${locale}.${key} の message が空`);
        assert.ok(entry.description, `${locale}.${key} に description が無い`);
      }
    }
  });

  test('placeholder の名前と置換番号が全言語で同じ', () => {
    const shape = entry => Object.entries(entry.placeholders || {})
      .map(([name, value]) => `${name.toLowerCase()}=${value.content}`).sort();
    const base = messagesOf(DEFAULT_LOCALE);
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(messagesOf(locale))) {
        assert.deepEqual(shape(entry), shape(base[key]), `${locale}.${key} の placeholder がずれている`);
      }
    }
  });

  test('本文の $ は $NAME$（定義済みの placeholder）か $$ だけ', () => {
    // 本文に直接 $1 と書くと、Chrome と上書き辞書で結果が変わりうる。placeholders を経由させる
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(messagesOf(locale))) {
        const names = new Set(Object.keys(entry.placeholders || {}).map(name => name.toLowerCase()));
        const rest = entry.message.replace(/\$\$/g, '').replace(/\$([A-Za-z0-9_@]+)\$/g, (_m, name) => {
          assert.ok(names.has(name.toLowerCase()), `${locale}.${key} の $${name}$ が未定義`);
          return '';
        });
        assert.ok(!rest.includes('$'), `${locale}.${key} に裸の $ がある: ${entry.message}`);
      }
    }
  });

  test('ストアの上限: 名前は75文字、短い説明は132文字まで', () => {
    for (const locale of LOCALES) {
      const messages = messagesOf(locale);
      assert.ok(messages.extName.message.length <= 75, `${locale} の名前が長すぎる`);
      assert.ok(messages.extDescription.message.length <= 132,
        `${locale} の短い説明が132文字を超えている: ${messages.extDescription.message.length}`);
    }
  });
});

describe('ソースと messages.json', () => {
  test('ソースが引いているキーはすべて messages.json にある', () => {
    const known = new Set(Object.keys(messagesOf(DEFAULT_LOCALE)).map(key => key.toLowerCase()));
    for (const [key, file] of referencedKeys()) {
      assert.ok(known.has(key.toLowerCase()), `${file} が引いている ${key} が messages.json に無い`);
    }
  });

  test('誰も引かないキーを残さない', () => {
    // キーを文字列で組み立てて引くと、ここで「未使用」に見える。
    // 引くときは t('key') / data-i18n="key" / __MSG_key__ のどれかで、キーをそのまま書くこと
    const used = new Set(Array.from(referencedKeys().keys(), key => key.toLowerCase()));
    for (const key of Object.keys(messagesOf(DEFAULT_LOCALE))) {
      assert.ok(used.has(key.toLowerCase()), `誰も引いていないキー: ${key}`);
    }
  });
});

describe('shared/i18n.js', () => {
  test('手動切替なし（auto）なら chrome.i18n の言語で引く', async () => {
    const { i18n, fetched } = loadI18n({ locale: 'ja' });
    assert.equal(await i18n.loadOverride(), 'auto');
    assert.equal(i18n.t('extName'), messagesOf('ja').extName.message);
    assert.equal(i18n.currentLanguage(), 'ja');
    assert.deepEqual(fetched, [], 'auto で messages.json を読みに行っている');
  });

  test('手動で選ばれた言語は、ブラウザの言語より優先する', async () => {
    const { i18n, fetched } = loadI18n({ locale: 'ja', storage: { uiLanguage: 'en' } });
    assert.equal(await i18n.loadOverride(), 'en');
    assert.equal(i18n.t('extName'), messagesOf('en').extName.message);
    assert.equal(i18n.currentLanguage(), 'en');
    assert.deepEqual(fetched, ['chrome-extension://test-extension-id/_locales/en/messages.json']);
  });

  test('auto に戻せば上書きが外れる', async () => {
    const storage = { uiLanguage: 'en' };
    const { i18n } = loadI18n({ locale: 'ja', storage });
    await i18n.loadOverride();
    storage.uiLanguage = 'auto';
    await i18n.loadOverride();
    assert.equal(i18n.t('extName'), messagesOf('ja').extName.message);
  });

  test('知らない設定値は auto 扱い（_locales に無い言語を読みに行かない）', async () => {
    const { i18n, fetched } = loadI18n({ locale: 'ja', storage: { uiLanguage: 'fr' } });
    assert.equal(await i18n.loadOverride(), 'auto');
    assert.deepEqual(fetched, []);
  });

  test('messages.json が読めなければブラウザの言語で出す', async () => {
    const { i18n } = loadI18n({ locale: 'ja', storage: { uiLanguage: 'en' }, fetchFails: true });
    await i18n.loadOverride();
    assert.equal(i18n.t('extName'), messagesOf('ja').extName.message);
    assert.equal(i18n.currentLanguage(), 'ja');
  });

  test('見つからないキーはキー自身を返す（欠落が画面で見える）', async () => {
    const { i18n } = loadI18n({ locale: 'en', storage: { uiLanguage: 'ja' } });
    await i18n.loadOverride();
    assert.equal(i18n.t('noSuchKey'), 'noSuchKey');
  });

  test('キーの大文字小文字を区別しない（Chrome と同じ）', async () => {
    const { i18n } = loadI18n({ locale: 'ja', storage: { uiLanguage: 'en' } });
    await i18n.loadOverride();
    assert.equal(i18n.t('EXTNAME'), messagesOf('en').extName.message);
  });

  test('上書き辞書の組み立ては chrome.i18n と同じ結果になる（全キー）', async () => {
    for (const locale of LOCALES) {
      const { i18n } = loadI18n({ locale: 'other', storage: { uiLanguage: locale } });
      await i18n.loadOverride();
      const chrome = createI18nMock({ locale });
      for (const key of Object.keys(messagesOf(locale))) {
        const subs = ['A', 'B', 'C'];
        assert.equal(i18n.t(key, subs), chrome.getMessage(key, subs), `${locale}.${key}`);
      }
    }
  });

  test('placeholder・$$・置換の規則が Chrome と同じ', () => {
    const { i18n } = loadI18n();
    const cases = [
      [{ message: '$COUNT$ comments', placeholders: { count: { content: '$1' } } }, ['12']],
      [{ message: '$Name$: $count$ ($$)', placeholders: { NAME: { content: '$2' }, count: { content: '$1' } } }, ['3', 'x']],
      [{ message: 'fixed $SEP$ text', placeholders: { sep: { content: '·' } } }, undefined],
      [{ message: 'missing $GONE$ here' }, ['1']],
      [{ message: 'number $N$', placeholders: { n: { content: '$1' } } }, 42]
    ];
    for (const [entry, subs] of cases) {
      assert.equal(i18n.formatMessage(entry, subs), formatChromeMessage(entry, subs), entry.message);
    }
    assert.equal(i18n.formatMessage(cases[0][0], ['12']), '12 comments');
  });

  test('ブラウザの言語が _locales に無ければ default_locale（en）', () => {
    for (const [ui, expected] of [['ja', 'ja'], ['ja-JP', 'ja'], ['en-US', 'en'], ['ko', 'en'], ['', 'en']]) {
      const { i18n } = loadI18n({ locale: 'ja', uiLanguage: ui });
      assert.equal(i18n.currentLanguage(), expected, ui);
    }
  });

  test('applyTo は data-i18n* を流し込み、<html lang> をそろえる', async () => {
    const { i18n } = loadI18n({ locale: 'ja', storage: { uiLanguage: 'en' } });
    await i18n.loadOverride();

    const element = attrs => ({
      attrs: { ...attrs },
      textContent: 'before',
      getAttribute(name) { return this.attrs[name] ?? null; },
      setAttribute(name, value) { this.attrs[name] = value; }
    });
    const text = element({ 'data-i18n': 'extName' });
    const title = element({ 'data-i18n-title': 'extName' });
    const placeholder = element({ 'data-i18n-placeholder': 'extName' });
    const aria = element({ 'data-i18n-aria-label': 'extName' });
    const all = [text, title, placeholder, aria];
    const root = {
      documentElement: { lang: 'ja' },
      querySelectorAll(selector) {
        const name = selector.slice(1, -1);
        return all.filter(el => el.getAttribute(name) !== null);
      }
    };

    i18n.applyTo(root);
    const expected = messagesOf('en').extName.message;
    assert.equal(text.textContent, expected);
    assert.equal(title.attrs.title, expected);
    assert.equal(title.textContent, 'before', 'title 用の要素の本文まで書き換えている');
    assert.equal(placeholder.attrs.placeholder, expected);
    assert.equal(aria.attrs['aria-label'], expected);
    assert.equal(root.documentElement.lang, 'en');
  });

  test('popup と options は theme.js の次に <head> で読む', () => {
    for (const page of ['popup/popup.html', 'options/options.html']) {
      const html = fs.readFileSync(path.join(SRC, page), 'utf8');
      const head = html.slice(0, html.indexOf('</head>'));
      const theme = head.indexOf('<script src="../shared/theme.js">');
      const i18n = head.indexOf('<script src="../shared/i18n.js">');
      assert.ok(theme >= 0 && i18n > theme, `${page} の <head> で theme.js → i18n.js の順になっていない`);
    }
  });
});
