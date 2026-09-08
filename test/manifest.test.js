// manifest.json の検証（#T11 の穴埋め）。
//
// manifest は「壊れても誰も落ちない」種類のファイルで、match パターンの誤りは
// 黙って出荷される。実際に #41（`/live*` が `/live_chat*` を飲み込み、
// ポップアウトのチャット窓で content-script.js と dom-chat.js が同居する）は
// この形で長く残っていた。ここで固定しておく。
//
// 権限は増やすときにも目に付くよう、一覧そのものを固定している（#40）。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

/** match パターンを scheme / host / path の3つに割る */
function parsePattern(pattern) {
  const parsed = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
  assert.ok(parsed, `match パターンとして読めない: ${pattern}`);
  return { scheme: parsed[1], host: parsed[2], path: parsed[3] };
}

/** `*.example.com` は example.com 自身にも当たる（Chrome の仕様） */
function hostMatches(pattern, hostname) {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === pattern;
}

/** パスの照合はクエリ文字列まで含める（`/watch*` が `/watch?v=...` に当たる） */
function pathMatches(pattern, target) {
  const source = pattern.split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(target.pathname + target.search);
}

function matches(pattern, url) {
  const { scheme, host, path: patternPath } = parsePattern(pattern);
  const target = new URL(url);
  if (scheme !== '*' && `${scheme}:` !== target.protocol) return false;
  return hostMatches(host, target.hostname) && pathMatches(patternPath, target);
}

const [watchEntry, chatEntry] = manifest.content_scripts;
const hits = (entry, url) => entry.matches.some(pattern => matches(pattern, url));

describe('manifest.json', () => {
  test('権限は実際に使うものだけ', () => {
    // activeTab: クリック時付与のパターンを使っていない（注入は host_permissions + scripting）
    // tabs: 用途は youtube.com のタブに対する query / get / reload / sendMessage だけで、
    //       host_permissions があれば tab.url まで読める。全タブのURLを読む権限は要らない
    assert.deepEqual(manifest.permissions,
      ['storage', 'unlimitedStorage', 'scripting', 'alarms']);
  });

  test('ホスト権限は https だけで、実際に叩く先に絞ってある', () => {
    assert.deepEqual(manifest.host_permissions,
      ['https://*.youtube.com/*', 'https://www.googleapis.com/youtube/v3/*']);
    for (const pattern of manifest.host_permissions) {
      assert.ok(pattern.startsWith('https://'), `平文HTTPも許している: ${pattern}`);
    }
  });

  test('watch 側の match が live_chat を飲み込まない（#41）', () => {
    // ポップアウトのチャット窓（トップレベルが /live_chat?is_popout=1&v=...）で
    // content-script.js と dom-chat.js が同居すると、ping の生存確認が誤判定する
    const popout = 'https://www.youtube.com/live_chat?is_popout=1&v=abc';
    assert.equal(hits(watchEntry, popout), false, 'watch 側が live_chat にも当たっている');
    assert.equal(hits(chatEntry, popout), true);
  });

  test('watch と live のページには watch 側だけが当たる', () => {
    for (const url of ['https://www.youtube.com/watch?v=abc',
                       'https://www.youtube.com/live/abc',
                       'https://m.youtube.com/watch?v=abc']) {
      assert.equal(hits(watchEntry, url), true, `当たっていない: ${url}`);
      assert.equal(hits(chatEntry, url), false, `チャット側まで当たっている: ${url}`);
    }
  });

  test('2つのエントリでスキームとサブドメインの扱いが揃っている（#41）', () => {
    const shape = entry => entry.matches.map(p => {
      const { scheme, host } = parsePattern(p);
      return `${scheme}://${host}`;
    });
    assert.deepEqual(new Set(shape(watchEntry)), new Set(['https://*.youtube.com']));
    assert.deepEqual(new Set(shape(chatEntry)), new Set(['https://*.youtube.com']));
  });

  test('dom-chat.js より先に shared/comment.js を読む（決定7）', () => {
    assert.deepEqual(chatEntry.js, ['shared/comment.js', 'content/dom-chat.js']);
  });

  test('description は docs/store-listing.md の「短い説明」と同一（ストアがこれを使う）', () => {
    // ストアのカードに出るのは manifest の description。掲載文の正は store-listing.md なので、
    // 片方だけ直すと「掲載文を直したのにストアの表示が変わらない」が起きる
    const listing = fs.readFileSync(path.join(__dirname, '..', 'docs', 'store-listing.md'), 'utf8');
    const block = listing.match(/## 短い説明[^\n]*\n[\s\S]*?```\n([\s\S]*?)\n```/);
    assert.ok(block, 'store-listing.md の「短い説明」のコードブロックが読めない');
    assert.equal(manifest.description, block[1]);
    assert.ok(manifest.description.length <= 132,
      `短い説明が132文字を超えている: ${manifest.description.length}`);
  });

  test('version は README の冒頭と揃っている（#44）', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const shown = readme.match(/\*\*バージョン:\*\* v(\d+\.\d+\.\d+)/);
    assert.ok(shown, 'README の冒頭にバージョンが見つからない');
    assert.equal(shown[1], manifest.version);
  });

  test('参照しているファイルが実在する', () => {
    const referenced = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      manifest.options_page,
      ...Object.values(manifest.action.default_icon),
      ...Object.values(manifest.icons),
      ...manifest.content_scripts.flatMap(entry => entry.js)
    ];
    for (const file of referenced) {
      assert.ok(fs.existsSync(path.join(SRC, file)), `manifest が無いファイルを指している: ${file}`);
    }
  });
});
