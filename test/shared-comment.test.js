// shared/comment.js（コメントの正準形）のテスト。
//
// ここが3つの実行環境すべての唯一の変換口なので、
// 「取得モードが違っても同じ形になる」ことだけは機械的に固定しておく。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const SHARED_PATH = path.join(__dirname, '..', 'src', 'shared', 'comment.js');

/** 本番と同じく self へ代入させて読み込む（window ではない） */
function loadShared() {
  const context = vm.createContext({ console });
  context.self = context;
  vm.runInContext(fs.readFileSync(SHARED_PATH, 'utf8'), context, { filename: SHARED_PATH });
  return context.YTF;
}

const YTF = loadShared();

// vm コンテキストの中で作られたオブジェクトは prototype が違うので、
// 構造を比べる前に素の値へ落とす
const plain = value => JSON.parse(JSON.stringify(value));

describe('正準形への変換', () => {
  // 同じスーパーチャット1件を、3つの入口それぞれの形で用意する
  const apiItem = {
    id: 'api-1',
    snippet: {
      type: 'superChatEvent',
      publishedAt: '2026-09-07T13:02:00.000Z',
      superChatDetails: { userComment: 'おめでとう', amountDisplayString: '¥500' }
    },
    authorDetails: {
      displayName: 'にゃんこ',
      isChatModerator: true,
      profileImageUrl: 'https://yt3.ggpht.com/a=s64-c'
    }
  };

  const domMessage = {
    id: 'dom2_0000000100000002_0',
    kind: 'superchat',
    role: 'moderator',
    displayName: 'にゃんこ',
    message: 'おめでとう',
    amountText: '¥500',
    publishedAt: '2026-09-07T13:02:00.000Z',
    avatarUrl: 'https://yt3.ggpht.com/a=s64-c'
  };

  test('API item と DOM message が同じ正準形になる', () => {
    const fromApi = plain(YTF.normalizeComment(apiItem));
    const fromDom = plain(YTF.normalizeComment(domMessage));

    // 違ってよいのは ID だけ（発番の元が違う）
    delete fromApi.id;
    delete fromDom.id;
    assert.deepEqual(fromApi, fromDom);

    assert.equal(fromDom.kind, 'superchat');
    assert.equal(fromDom.role, 'moderator');
    assert.equal(fromDom.bucket, 'primary');
    assert.equal(fromDom.searchText, 'にゃんこ おめでとう ¥500');
    assert.equal(fromDom.v, YTF.SCHEMA_VERSION);
  });

  test('旧保存形式（kind 無し・旧ID）もそのまま読める', () => {
    // 更新前の dom-chat.js は、テキストコメントに kind を載せていなかった。
    // stickerUrl / amountText も無く、ID は dom_<hash>_<n> 形式
    const legacy = {
      id: 'dom_-1234567_0',
      role: 'normal',
      displayName: 'にゃんこ',
      message: 'こんばんは',
      publishedAt: '2026-09-07T13:02:00.000Z'
    };

    const comment = YTF.normalizeComment(legacy);

    assert.equal(comment.id, 'dom_-1234567_0', '保存済みのIDは作り直さない');
    assert.equal(comment.kind, 'text');
    assert.equal(comment.bucket, 'bulk');
    assert.equal(comment.amountText, null);
    assert.equal(comment.stickerUrl, null);
    assert.equal(comment.searchText, 'にゃんこ こんばんは');
  });

  test('IDを持たないコメントには、内容から決まるIDが振られる', () => {
    // 同じ1件を2度受け取っても同じ値になる（重複判定がIDだけで完結する）
    const raw = { displayName: 'にゃんこ', message: 'こんばんは', publishedAt: '2026-09-07T13:02:00.000Z' };

    const first = YTF.normalizeComment({ ...raw });
    const second = YTF.normalizeComment({ ...raw });
    const other = YTF.normalizeComment({ ...raw, message: 'こんばんはー' });

    assert.equal(first.id, second.id);
    assert.notEqual(first.id, other.id);
  });

  test('保持枠は流量で分かれる（決定3）', () => {
    const bucket = fields => YTF.bucketOf(fields);

    assert.equal(bucket({ kind: 'text', role: 'owner' }), 'primary');
    assert.equal(bucket({ kind: 'text', role: 'moderator' }), 'primary');
    assert.equal(bucket({ kind: 'superchat', role: 'normal' }), 'primary');
    assert.equal(bucket({ kind: 'membership', role: 'member' }), 'primary');
    // メンバーは製品の意味づけとしては特別だが、流量は一般と変わらない
    assert.equal(bucket({ kind: 'text', role: 'member' }), 'bulk');
    assert.equal(bucket({ kind: 'text', role: 'normal' }), 'bulk');
  });
});

describe('ID の作り方', () => {
  const key = YTF.commentKeyOf('text', 'にゃんこ', { message: '8888' }, '23:02');

  test('同じ内容の連投は occurrence だけが違う', () => {
    assert.notEqual(YTF.commentIdFor(key, 0), YTF.commentIdFor(key, 1));
    assert.equal(YTF.commentIdFor(key, 0), YTF.commentIdFor(key, 0));
  });

  test('旧形式のIDが、更新前の実装と1文字も違わない', () => {
    // ここがずれると、更新した瞬間に保存済み履歴と突き合わせられなくなり、
    // 全件スキャンで履歴が丸ごと二重になる。更新前の実装をそのまま書き写して比べる
    const legacyIdOf = (kind, displayName, detail, timestampText) => {
      let k = `${displayName}\u0000${detail.message}\u0000${timestampText}`;
      if (kind !== 'text') {
        k += `\u0000${kind}\u0000${detail.amountText || ''}\u0000${detail.eventText || ''}`;
      }
      const hash = k.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
      return `dom_${hash}_0`;
    };

    const cases = [
      ['text', 'にゃんこ', { message: '8888' }, '23:02'],
      ['text', '@viewer', { message: '' }, ''],
      ['superchat', 'にゃんこ', { message: '', amountText: '¥500' }, '23:02'],
      ['membership', '@fan', { message: 'ありがとう', eventText: '新規メンバー' }, '10:53 PM']
    ];

    for (const [kind, name, detail, ts] of cases) {
      const key = YTF.commentKeyOf(kind, name, detail, ts);
      assert.equal(YTF.legacyCommentIdFor(key, 0), legacyIdOf(kind, name, detail, ts),
        `${kind} / ${name} のキーの作り方が変わっている`);
    }
  });

  test('旧形式のIDも同じキーから計算できる', () => {
    // 更新前に保存された履歴と突き合わせるために必要（#9 の移行）
    assert.match(YTF.legacyCommentIdFor(key, 0), /^dom_-?\d+_0$/);
    assert.notEqual(YTF.legacyCommentIdFor(key, 0), YTF.commentIdFor(key, 0));
  });

  test('32bit ハッシュが衝突するキーでも、IDは衝突しない', () => {
    // 旧IDは 32bit の多項式ハッシュ1本。約65,000通で衝突確率50%に達する（#9）。
    // 実際にぶつかる2つのキーを総当たりで見つけ、新形式では別IDになることを見る
    const hash32 = str => {
      let h = 0;
      for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
      return h;
    };

    const seen = new Map();
    let collision = null;
    for (let i = 0; i < 300000 && !collision; i++) {
      const candidate = `u${i}\u0000m${i}\u000023:02`;
      const h = hash32(candidate);
      const previous = seen.get(h);
      if (previous !== undefined) collision = [previous, candidate];
      else seen.set(h, candidate);
    }

    assert.ok(collision, '32bit ハッシュの衝突が見つかること自体が #9 の前提');
    const [a, b] = collision;
    assert.equal(YTF.legacyCommentIdFor(a, 0), YTF.legacyCommentIdFor(b, 0), '旧形式では衝突する');
    assert.notEqual(YTF.commentIdFor(a, 0), YTF.commentIdFor(b, 0), '新形式では衝突しない');
  });
});

describe('HTML の扱い', () => {
  test('stripHtmlTags はタグを落とすだけ（パースしない）', () => {
    assert.equal(YTF.stripHtmlTags('<b>quota</b> exceeded'), 'quota exceeded');
    assert.equal(YTF.stripHtmlTags('<img src="https://example.test/x.png"> 失敗'), '失敗');
    assert.equal(YTF.stripHtmlTags(''), '');
    assert.equal(YTF.stripHtmlTags(null), '');
  });

  test('escapeAttr はクォートも escape する（#25 の暫定対処）', () => {
    assert.equal(
      YTF.escapeAttr('" onerror="alert(1)'),
      '&quot; onerror=&quot;alert(1)'
    );
    assert.equal(YTF.escapeAttr("it's <b>"), 'it&#39;s &lt;b&gt;');
  });
});
