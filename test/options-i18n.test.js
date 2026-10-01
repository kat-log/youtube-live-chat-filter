// 設定画面（options）の英語対応と、表示言語の手動切替（docs/i18n-plan.md の段階4）のテスト。
//
// 既存の options のテストは chrome.i18n のモックが ja で動いている。ここでは
//   - options.html に直接書いた英語が、en の messages.json と食い違っていないこと
//   - en / ja で開いたときの表示（data-i18n* と、JS が書く文言の両方）
//   - API接続テストのエラーの対訳（shared/i18n.js の API_ERROR_KEYS）
//   - 言語セレクトで uiLanguage が保存され、この画面の文言がその場で変わること
// を見る。

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadOptions, i18nElementsInOptionsHtml } = require('./helpers/options-harness');
const { LOCALES_DIR } = require('./helpers/i18n-mock');

const OPTIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'options', 'options.html'), 'utf8');
const messagesOf = locale => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
const EN = messagesOf('en');
const JA = messagesOf('ja');

const EN_URL = 'chrome-extension://test-extension-id/_locales/en/messages.json';

/** options を開いて、言語の適用と設定の読み込みが終わるまで待つ */
async function openOptions(options = {}) {
  const h = loadOptions(options);
  const c = new h.OptionsController();
  await c.ready;
  return { h, c, el: id => h.document.peek(id), byKey: key => h.document.byI18nKey(key) };
}

/** 言語の適用の列が空になるまで待つ（切り替えのたびに伸びる） */
async function settleLanguage(c) {
  let queue;
  do {
    queue = c.languageQueue;
    await queue;
  } while (queue !== c.languageQueue);
}

/** API接続テストの fetch の応答 */
function apiResponse(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** APIキーを入れて API接続テストを押し、終わるまで待つ */
async function runApiTest({ c, el }) {
  el('api-key').value = 'AIza-test';
  await c.testApiConnection();
  return el('toast').textContent;
}

describe('options.html の既定文言', () => {
  test('data-i18n* を付けた要素に直接書いた文言は、en の messages.json と同じ', () => {
    // JS が走る前（と、走らなかったとき）に見えるのは HTML の文言
    const elements = i18nElementsInOptionsHtml();
    assert.ok(elements.length >= 40, `拾えた要素が少なすぎる: ${elements.length}`);
    for (const { attributes, text } of elements) {
      if (attributes['data-i18n']) {
        assert.equal(text, EN[attributes['data-i18n']].message, `data-i18n="${attributes['data-i18n']}"`);
      }
      for (const [binding, target] of [
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-aria-label', 'aria-label']
      ]) {
        const key = attributes[binding];
        if (key) assert.equal(attributes[target], EN[key].message, `${binding}="${key}"`);
      }
    }
  });

  test('JS が書くボタンの既定文言も en と同じ', () => {
    const textOf = id => OPTIONS_HTML.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))[1].trim();
    assert.equal(textOf('toggle-visibility'), EN.optShowKey.message);
    assert.equal(textOf('save-settings'), EN.optSave.message);
    assert.equal(textOf('test-api'), EN.optTestApi.message);
  });

  test('<html lang="en">（直接書いてある文言の言語）', () => {
    assert.match(OPTIONS_HTML, /<html lang="en">/);
  });

  test('JS が書き換える要素には data-i18n を付けない（applyTo が JS の文言を消すため）', () => {
    for (const id of ['toggle-visibility', 'save-settings', 'test-api', 'toast', 'ui-language']) {
      const tag = OPTIONS_HTML.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`))[0];
      assert.doesNotMatch(tag, /data-i18n/, id);
    }
  });

  test('言語セレクトは 自動 / English / 日本語 で、English と 日本語 は訳さない', () => {
    const select = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('<select id="ui-language"'), OPTIONS_HTML.indexOf('</select>'));
    const options = Array.from(select.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)</g), m => [m[1], m[2], m[3]]);
    assert.deepEqual(options.map(([value]) => value), ['auto', 'en', 'ja']);
    assert.match(options[0][1], /data-i18n="optLanguageAuto"/);
    assert.equal(options[1][2], 'English');
    assert.equal(options[2][2], '日本語');
    assert.doesNotMatch(options[1][1] + options[2][1], /data-i18n/);
  });
});

describe('en / ja で開いた表示', () => {
  test('en: 静的な文言・JS が書く文言・<html lang> が英語', async () => {
    const { h, el, byKey } = await openOptions({ locale: 'en' });
    assert.equal(byKey('optHeading').textContent, EN.optHeading.message);
    assert.equal(byKey('optPageTitle').textContent, EN.optPageTitle.message);
    assert.equal(byKey('optLanguageNote').textContent, EN.optLanguageNote.message);
    assert.equal(el('api-key').getAttribute('placeholder'), EN.apiKeyPlaceholder.message);
    assert.equal(el('toggle-visibility').textContent, 'Show');
    assert.equal(el('save-settings').textContent, 'Save settings');
    assert.equal(el('test-api').textContent, 'Test API connection');
    assert.equal(h.document.documentElement.lang, 'en');
    assert.equal(el('ui-language').value, 'auto');
    assert.deepEqual(h.fetched, [], 'auto なのに messages.json を読みに行っている');
  });

  test('ja: 従来と同じ日本語', async () => {
    const { h, el, byKey } = await openOptions({ locale: 'ja' });
    assert.equal(byKey('optHeading').textContent, 'YouTube特別コメントフィルター 設定');
    assert.equal(byKey('roleOwner').textContent, '配信者');
    assert.equal(el('toggle-visibility').textContent, '表示');
    assert.equal(el('save-settings').textContent, '設定を保存');
    assert.equal(el('test-api').textContent, 'API接続テスト');
    assert.equal(h.document.documentElement.lang, 'ja');
  });

  test('ja で開いたとき、data-i18n* の要素に英語が残らない', async () => {
    const { h } = await openOptions({ locale: 'ja' });
    for (const element of h.document.i18nElements) {
      const key = element.getAttribute('data-i18n');
      if (key) assert.equal(element.textContent, JA[key].message, key);
    }
  });

  test('APIキーの表示・非表示ボタンは、状態から文言を決める（en）', async () => {
    const { c, el } = await openOptions({ locale: 'en' });
    c.toggleApiKeyVisibility();
    assert.equal(el('api-key').type, 'text');
    assert.equal(el('toggle-visibility').textContent, 'Hide');
    c.toggleApiKeyVisibility();
    assert.equal(el('toggle-visibility').textContent, 'Show');
  });

  test('保存中・テスト中の文言も英語で、終われば戻る', async () => {
    let resolveSave;
    const h = loadOptions({ locale: 'en' });
    h.chrome.runtime.sendMessage = async message => {
      if (message.action === 'saveApiKey') return new Promise(resolve => { resolveSave = resolve; });
      return {};
    };
    const c = new h.OptionsController();
    await c.ready;
    const el = id => h.document.peek(id);

    el('api-key').value = 'AIza-test';
    const saving = c.saveSettings();
    assert.equal(el('save-settings').textContent, 'Saving...');
    resolveSave({ success: true });
    await saving;
    assert.equal(el('save-settings').textContent, 'Save settings');
    assert.equal(el('toast').textContent, 'Settings saved');
  });
});

describe('API接続テストのエラー（API_ERROR_KEYS）', () => {
  const invalidKey = apiResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });

  test('en: API の説明を英語の文言に置き換える', async () => {
    const opened = await openOptions({ locale: 'en', fetchApi: invalidKey });
    assert.equal(await runApiTest(opened), `API connection test failed: ${EN.apiErrKeyInvalid.message}`);
  });

  test('ja: 従来と同じ日本語', async () => {
    const opened = await openOptions({ locale: 'ja', fetchApi: invalidKey });
    assert.equal(await runApiTest(opened),
      'API接続テスト失敗: APIキーが無効です。Google Cloud ConsoleでAPIキーを確認してください');
  });

  test('対訳の無い説明は、タグを除いて API の英語のまま', async () => {
    const opened = await openOptions({
      locale: 'ja',
      fetchApi: apiResponse(500, { error: { message: 'Backend <b>Error</b>' } })
    });
    assert.equal(await runApiTest(opened), 'API接続テスト失敗: Backend Error');
  });

  test('quota は 「exceeded your quota」 の文言が先に当たる（表の順）', async () => {
    const opened = await openOptions({
      locale: 'en',
      fetchApi: apiResponse(403, { error: { message: 'The request cannot be completed because you have exceeded your quota (quotaExceeded).' } })
    });
    assert.equal(await runApiTest(opened), `API connection test failed: ${EN.apiErrQuotaExceeded.message}`);
  });

  test('説明が無ければ HTTP の状態、通信の失敗は network error', async () => {
    const opened = await openOptions({ locale: 'en', fetchApi: apiResponse(502, {}) });
    assert.equal(await runApiTest(opened), 'API connection test failed: HTTP 502');

    const offline = await openOptions({ locale: 'en', fetchApi: async () => { throw new TypeError('Failed to fetch'); } });
    assert.equal(await runApiTest(offline), 'API connection test failed: network error');
  });

  test('成功', async () => {
    const opened = await openOptions({ locale: 'en', fetchApi: apiResponse(200, { items: [] }) });
    assert.equal(await runApiTest(opened), 'API connection test succeeded');
    assert.equal(opened.el('test-api').textContent, 'Test API connection');
  });
});

describe('表示言語の手動切替', () => {
  test('保存された uiLanguage が、ブラウザの言語より優先される', async () => {
    const { h, el, byKey } = await openOptions({ locale: 'ja', storage: { uiLanguage: 'en' } });
    assert.equal(byKey('optHeading').textContent, EN.optHeading.message);
    assert.equal(el('save-settings').textContent, 'Save settings');
    assert.equal(el('ui-language').value, 'en');
    assert.equal(h.document.documentElement.lang, 'en');
    assert.deepEqual(h.fetched, [EN_URL]);
  });

  test('セレクトを切り替えると uiLanguage が保存され、この画面の文言がその場で変わる', async () => {
    const { h, c, el, byKey } = await openOptions({ locale: 'ja' });
    assert.equal(byKey('optHeading').textContent, JA.optHeading.message);

    // JS が書く文言が「いまの状態」で描き直されることも見る（表示中のキー）
    c.toggleApiKeyVisibility();
    assert.equal(el('toggle-visibility').textContent, '非表示');

    el('ui-language').value = 'en';
    el('ui-language').fire('change');
    await settleLanguage(c);

    assert.equal(h.chrome.__storage.uiLanguage, 'en');
    assert.deepEqual(h.chrome.__calls.storageWrites.at(-1), { uiLanguage: 'en' });
    assert.equal(byKey('optHeading').textContent, EN.optHeading.message);
    assert.equal(byKey('roleOwner').textContent, 'Streamer');
    assert.equal(el('api-key').getAttribute('placeholder'), EN.apiKeyPlaceholder.message);
    assert.equal(el('toggle-visibility').textContent, 'Hide');
    assert.equal(el('save-settings').textContent, 'Save settings');
    assert.equal(h.document.documentElement.lang, 'en');

    // 自動に戻すとブラウザの言語（ja）
    el('ui-language').value = 'auto';
    el('ui-language').fire('change');
    await settleLanguage(c);
    assert.equal(h.chrome.__storage.uiLanguage, 'auto');
    assert.equal(byKey('optHeading').textContent, JA.optHeading.message);
    assert.equal(el('toggle-visibility').textContent, '非表示');
    assert.equal(h.document.documentElement.lang, 'ja');
  });

  test('ブラウザが英語でも 日本語 を選べる', async () => {
    const { h, c, el, byKey } = await openOptions({ locale: 'en' });
    el('ui-language').value = 'ja';
    el('ui-language').fire('change');
    await settleLanguage(c);
    assert.equal(byKey('optHeading').textContent, JA.optHeading.message);
    assert.equal(el('test-api').textContent, 'API接続テスト');
    assert.equal(h.document.documentElement.lang, 'ja');
  });

  test('続けて切り替えても、最後に選んだ言語で終わる', async () => {
    const { c, el, byKey } = await openOptions({ locale: 'ja' });
    for (const value of ['en', 'ja', 'en']) {
      el('ui-language').value = value;
      el('ui-language').fire('change');
    }
    await settleLanguage(c);
    assert.equal(byKey('optHeading').textContent, EN.optHeading.message);
    assert.equal(el('ui-language').value, 'en');
  });

  test('別の options のタブで変えられても追従し、セレクトの位置も合わせる', async () => {
    const { h, c, el, byKey } = await openOptions({ locale: 'ja' });
    h.chrome.__storage.uiLanguage = 'en';
    h.chrome.__emitStorageChange({ uiLanguage: { newValue: 'en' } });
    await settleLanguage(c);
    assert.equal(byKey('optHeading').textContent, EN.optHeading.message);
    assert.equal(el('ui-language').value, 'en');
  });

  test('切り替えたあとのトーストは新しい言語で出る', async () => {
    const { c, el } = await openOptions({ locale: 'ja' });
    el('ui-language').value = 'en';
    el('ui-language').fire('change');
    await settleLanguage(c);
    el('api-key').value = '';
    await c.saveSettings();
    assert.equal(el('toast').textContent, 'Please enter an API key');
  });

  test('知らない値は保存しない（auto に丸める）', async () => {
    const { h, c, el } = await openOptions({ locale: 'ja' });
    el('ui-language').value = 'fr';
    el('ui-language').fire('change');
    await settleLanguage(c);
    assert.equal(h.chrome.__storage.uiLanguage, 'auto');
    assert.equal(el('ui-language').value, 'auto');
  });

  test('テーマなど言語以外の変更では描き直さない', async () => {
    const { h, c } = await openOptions({ locale: 'ja' });
    const before = c.languageQueue;
    h.chrome.__emitStorageChange({ theme: { newValue: 'dark' } });
    assert.equal(c.languageQueue, before);
  });
});
