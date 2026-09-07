// popup がコメントを取り込むところのテスト。
//
// 描画そのものはまだ見ない（フェーズ5）。ここで固定するのは
// 「取り込み口が1つになっているか」と「重複判定が id を見ているか」の2点。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadPopup } = require('./helpers/popup-harness');

// popup.js は vm コンテキストの中で動くので、そこで作られた配列やオブジェクトは
// Node 側のものと prototype が違う。deepEqual は素通りしないため、
// 構造を比べるときはいったん素の値に落とす
const plain = value => JSON.parse(JSON.stringify(value));

/**
 * PopupController を1つ作る。
 *
 * 初期化（Service Worker への ping と待ち）は非同期で走り出すが、ハーネスの
 * setTimeout は積むだけなので最初の待ちで止まる。同期的に組み上がった
 * this.comments まわりだけをここで見る。
 */
function controller() {
  const popup = loadPopup();
  return new popup.__popup.PopupController();
}

/** DOMモードのコメント1件（dom-chat.js が送ってくる形） */
const domMessage = (id, extra = {}) => ({
  id,
  role: 'moderator',
  displayName: 'にゃんこ',
  message: '8888',
  publishedAt: '2026-09-07T13:02:00.000Z',
  ...extra
});

describe('popup の重複判定', () => {
  test('同じ分に同じ本文を連投しても、IDが違えば2件とも残る', () => {
    // DOMモードの過去分は時刻が分単位（秒は0に丸められる）。以前は本文・発言者・
    // 時刻など5フィールドの一致で重複を判定していたので、モデレーターの
    // 「8888」「www」のような短い連投は2件目が黙って消えていた（#3）。
    //
    // 2件を別々のバッチで送るのが肝。旧実装の突き合わせ先は「取り込み済みの
    // this.comments」だけだったので、1バッチにまとめると素通りしてしまう
    const c = controller();

    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_0')]);
    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_1')]);

    assert.equal(c.comments.length, 2);
    assert.deepEqual(plain(c.comments.map(x => x.message)), ['8888', '8888']);
  });

  test('同じIDが再送されたら1件しか残らない', () => {
    // 全件スキャン（requestInitialSweep）で同じコメントが何度も届く
    const c = controller();

    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_0')]);
    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_0')]);
    // 同じバッチの中に重複があっても弾く
    c.addNewComments([
      domMessage('dom2_ccccccccdddddddd_0'),
      domMessage('dom2_ccccccccdddddddd_0')
    ]);

    assert.equal(c.comments.length, 2);
  });

  test('IDの集合は、履歴の入れ替えと切り詰めでもコメント本体とずれない', () => {
    // ずれると、一度消えたコメントが二度と入らない（あるいは重複が素通りする）
    const c = controller();

    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_0')]);
    assert.equal(c.commentIds.size, 1);

    // 履歴の復元は丸ごと入れ替える
    c.setComments([]);
    assert.equal(c.commentIds.size, 0);

    // 入れ替えたあとなら、同じIDでもまた入る
    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_0')]);
    assert.equal(c.comments.length, 1);
    assert.equal(c.commentIds.size, 1);
  });
});

describe('popup の取り込み口', () => {
  test('APIモードとDOMモードのコメントが同じ形になる', () => {
    const c = controller();

    c.addNewComments([
      domMessage('dom2_aaaaaaaabbbbbbbb_0', { kind: 'superchat', amountText: '¥500', message: 'おめでとう' }),
      {
        id: 'api-1',
        authorDetails: {
          displayName: 'にゃんこ',
          isChatModerator: true,
          profileImageUrl: 'https://yt3.ggpht.com/a=s64-c'
        },
        snippet: {
          type: 'superChatEvent',
          publishedAt: '2026-09-07T13:02:00.000Z',
          superChatDetails: { userComment: 'おめでとう', amountDisplayString: '¥500' }
        }
      }
    ]);

    const [fromDom, fromApi] = c.comments;
    // ID・アバターURL以外は完全に一致する（取得モードの違いはここまで来ない）
    const shape = comment => {
      const rest = plain(comment);
      for (const key of ['id', 'avatarUrl', 'profileImageUrl']) delete rest[key];
      return rest;
    };
    assert.deepEqual(shape(fromDom), shape(fromApi));
    assert.equal(fromApi.kind, 'superchat');
    assert.equal(fromApi.roleLabel, 'モデレーター');
    assert.equal(fromApi.roleClass, 'role-moderator');
  });

  test('取り込んだ時点で searchText が入っている', () => {
    // 検索の1文字目で全件ぶんの正規化が同期的に走るのを避ける（#23）
    const c = controller();
    c.addNewComments([domMessage('dom2_aaaaaaaabbbbbbbb_0', { message: 'ＡＢＣ' })]);

    // 発言者名と本文をつないでから正規化する（改行は空白1個に潰れる）
    assert.equal(c.comments[0].searchText, 'にゃんこ abc');
  });
});
