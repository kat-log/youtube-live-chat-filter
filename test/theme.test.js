// shared/theme.js（フェーズ8 / #15）のテスト。
//
// 直しているのは「ライトテーマの利用者が、起動直後に真っ黒な popup を見る」。
// 原因は **テーマを決めるのが Service Worker とのやり取りの後ろだった**ことなので、
// ここで固定するのは「いつ塗るか」——読み込みと同時か、応答を待ってからか。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadThemeModule, createLocalStorageMock } = require('./helpers/theme-harness');

describe('読み込みと同時に塗る（#15）', () => {
  test('storage の応答を待たずに、写しの値で塗る', () => {
    const cache = createLocalStorageMock({ initial: { 'ytcf.theme': 'dark' } });
    // storage.local は「ダーク」を返すが、await はまだ1つも解けていない
    const h = loadThemeModule({ storage: { theme: 'dark' }, localStorage: cache });

    // 評価が終わった時点で、もう塗り終わっている（ここが #15 の本体）
    assert.equal(h.theme(), 'dark');
  });

  test('写しが無ければライトで塗り、storage が返ってからダークに直す', async () => {
    const h = loadThemeModule({ storage: { theme: 'dark' }, localStorage: createLocalStorageMock() });

    // 写しが無い初回だけは、正が返るまでのあいだライトになる
    assert.equal(h.theme(), 'light');

    await h.settle();
    assert.equal(h.theme(), 'dark');
    assert.deepEqual(h.writes(), ['light', 'dark']);
    // 次に開いたときは1回で済むよう、写しを更新してある
    assert.equal(h.localStorage.__store['ytcf.theme'], 'dark');
  });

  test('保存されていなければライト（既定）', async () => {
    const h = loadThemeModule({ storage: {} });
    await h.settle();
    assert.equal(h.theme(), 'light');
  });

  test('写しがダークでも、正がライトならライトに直る', async () => {
    // 別のブラウザプロファイルで戻した、同期が遅れた、などのずれはここで解消する
    const cache = createLocalStorageMock({ initial: { 'ytcf.theme': 'dark' } });
    const h = loadThemeModule({ storage: { theme: 'light' }, localStorage: cache });

    assert.equal(h.theme(), 'dark');
    await h.settle();
    assert.equal(h.theme(), 'light');
    assert.equal(cache.__store['ytcf.theme'], 'light');
  });
});

describe('壊れた環境でも死なない', () => {
  test('localStorage が無くても塗れる', async () => {
    // Service Worker には無い。popup / options 以外から読まれたときの保険でもある
    const h = loadThemeModule({ storage: { theme: 'dark' }, localStorage: null });
    assert.equal(h.theme(), 'light');
    await h.settle();
    assert.equal(h.theme(), 'dark');
  });

  test('localStorage が例外を投げても塗れる', async () => {
    const h = loadThemeModule({ storage: { theme: 'dark' }, localStorage: createLocalStorageMock({ throws: true }) });
    assert.equal(h.theme(), 'light');
    await h.settle();
    assert.equal(h.theme(), 'dark');
  });

  test('storage が失敗したら、写しの値のまま残る（エラーは必ず出す）', async () => {
    const cache = createLocalStorageMock({ initial: { 'ytcf.theme': 'dark' } });
    const h = loadThemeModule({ rejectStorage: true, localStorage: cache });

    await h.settle();
    assert.equal(h.theme(), 'dark');
    // 根本原因F。debugMode に関係なくエラーは出す
    assert.equal(h.errors.length, 1);
  });
});

describe('applyTheme', () => {
  test('dark 以外は全部ライトに丸める', () => {
    const h = loadThemeModule();
    assert.equal(h.api.applyTheme('dark'), 'dark');
    assert.equal(h.api.applyTheme(undefined), 'light');
    assert.equal(h.api.applyTheme(null), 'light');
    assert.equal(h.api.applyTheme('DARK'), 'light');
    assert.equal(h.theme(), 'light');
  });

  test('塗るたびに写しも更新する（次に開いたときの一瞬のため）', () => {
    const h = loadThemeModule();
    h.api.applyTheme('dark');
    assert.equal(h.localStorage.__store['ytcf.theme'], 'dark');
    h.api.applyTheme('light');
    assert.equal(h.localStorage.__store['ytcf.theme'], 'light');
  });
});
