// コメント履歴の保存（src/shared/store.js）に対する回帰テスト。
//
// ここで守りたいのは、根本原因C（履歴を毎回まるごと書き直す）が戻ってこないこと、
// そして決定3（保持枠を2つに分ける）が「一般コメントは特別コメントを
// 押し出さない」という約束として成立していること。
//
// 移行（storage.local -> IndexedDB）は片道でロールバックできないため、
// 「書けたのを確かめてから消す」も併せて固定する。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadStore } = require('./helpers/store-harness');

/** DOMモードのコメント1件。role で保持枠が決まる（owner/moderator は primary） */
const comment = (id, role = 'normal', extra = {}) => ({
  id: String(id),
  role,
  displayName: `ユーザー${id}`,
  message: `コメント${id}`,
  publishedAt: '2026-09-07T00:00:00.000Z',
  ...extra
});

/** comments ストアへの put だけを、キーの配列で取り出す */
const commentPuts = idb => idb.calls.puts
  .filter(put => put.store === 'comments')
  .map(put => put.key);

describe('追記', () => {
  test('追記は新しいレコードへの put だけで、既存レコードを書き直さない', async () => {
    // 旧実装は500msごとに配列全体を set() し直していた（#21 = 根本原因C）。
    // 賑わった配信では毎秒 0.8MiB の書き込みが数時間続く
    const { store, idb } = loadStore();

    await store.append('V', [comment(1), comment(2), comment(3)]);
    const afterFirst = commentPuts(idb);
    await store.append('V', [comment(4)]);
    const added = commentPuts(idb).slice(afterFirst.length);

    assert.deepEqual(afterFirst, ['V:1', 'V:2', 'V:3']);
    assert.deepEqual(added, ['V:4'], '追記1件で既存レコードまで書き直している');
  });

  test('保持枠はコメントの正準形から決まる（判定は store 側に無い）', async () => {
    const { store } = loadStore();

    await store.append('V', [
      comment(1, 'normal'),
      comment(2, 'owner'),
      comment(3, 'member'),
      comment(4, 'normal', { kind: 'superchat', amountText: '¥1,000' })
    ]);

    const counts = await store.count('V');
    assert.equal(counts.primary, 2, '配信者とスパチャが primary に入っていない');
    assert.equal(counts.bulk, 2, 'メンバーと一般は bulk');
    assert.deepEqual(
      [...(await store.read('V', { bucket: 'primary' })).map(c => c.id)], ['2', '4']);
  });

  test('新しい方から limit 件を読み、古い順に返す', async () => {
    const { store } = loadStore();
    await store.append('V', Array.from({ length: 10 }, (_, i) => comment(i)));

    const latest = await store.read('V', { limit: 3 });
    assert.deepEqual([...latest.map(c => c.id)], ['7', '8', '9']);

    // before は排他。フェーズ5 の「スクロールで古い分を追加読み」の足場
    const older = await store.read('V', { limit: 3, before: latest[0].seq });
    assert.deepEqual([...older.map(c => c.id)], ['4', '5', '6']);
  });
});

describe('保持枠ごとの上限', () => {
  test('bulk を上限まで積んでも primary は1件も減らない', async () => {
    // 決定3の核心。「上限を超えたか」ではなく「超えたときに何が残っているか」で見る。
    // bulk 側が実際に切り詰められたことまで確かめないと、
    // 単に上限へ届いていないだけのテストになる
    const { store } = loadStore();
    store.LIMITS.primary = 100;
    store.LIMITS.bulk = 10;

    await store.append('V', Array.from({ length: 5 }, (_, i) => comment(`p${i}`, 'owner')));
    await store.append('V', Array.from({ length: 40 }, (_, i) => comment(`b${i}`, 'normal')));

    const removed = await store.trim('V');

    assert.equal(removed.bulk, 30, 'bulk が切り詰められていない（上限に届いていない）');
    assert.equal(removed.primary, 0);

    const counts = await store.count('V');
    assert.equal(counts.primary, 5, '一般コメントが特別コメントを押し出している');
    assert.equal(counts.bulk, 10);

    // 残った bulk は新しい方
    const bulk = await store.read('V', { bucket: 'bulk' });
    assert.equal(bulk[0].id, 'b30', '古い方から消していない');
    assert.equal(bulk.at(-1).id, 'b39');

    const primary = await store.read('V', { bucket: 'primary' });
    assert.deepEqual([...primary.map(c => c.id)], ['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  test('primary も上限を超えれば古い方から消える', async () => {
    const { store } = loadStore();
    store.LIMITS.primary = 3;

    await store.append('V', Array.from({ length: 6 }, (_, i) => comment(`p${i}`, 'owner')));
    await store.trim('V');

    const primary = await store.read('V', { bucket: 'primary' });
    assert.deepEqual([...primary.map(c => c.id)], ['p3', 'p4', 'p5']);
  });
});

describe('履歴のクリア', () => {
  test('コメントとアバターを対で消し、動画の枠は残す', async () => {
    // 片方だけ消えると、参照されないアバターが永久に残る（#6 の消し忘れ1つ目）
    const { store } = loadStore();
    await store.append('V', [comment(1), comment(2)]);
    await store.putAvatars('V', { 常連さん: 'https://example.test/a.png' }, []);

    await store.clear('V');

    assert.deepEqual([...await store.read('V')], []);
    assert.deepEqual({ ...await store.readAvatars('V') }, {});
    assert.equal((await store.count('V')).total, 0);
    assert.deepEqual([...(await store.listVideos()).map(v => v.videoId)], ['V'],
      'クリアで動画の枠ごと消えている');
  });

  test('クリア後に積み直したコメントは、消したぶんと同じキーを使わない', async () => {
    const { store } = loadStore();
    await store.append('V', [comment(1)]);
    await store.clear('V');
    await store.append('V', [comment(2)]);

    const [restored] = await store.read('V');
    assert.equal(restored.id, '2');
    assert.equal(restored.seq, 2, 'クリア前の連番を再利用している');
  });

  test('dropVideo は動画ごと消す', async () => {
    const { store } = loadStore();
    await store.append('a', [comment(1)]);
    await store.append('b', [comment(2)]);

    await store.dropVideo('a');

    assert.deepEqual([...(await store.listVideos()).map(v => v.videoId)], ['b']);
  });
});

describe('storage.local からの移行', () => {
  const legacyStorage = () => ({
    commentsHistory_OLD: [
      comment(1, 'owner'),
      comment(2, 'normal')
    ],
    commentAvatars_OLD: { ユーザー1: 'https://example.test/a.png' },
    commentsHistoryMeta: { OLD: Date.parse('2026-08-01T00:00:00Z') },
    // 動画で分けていなかった頃のキー
    commentsHistory: [comment(99)],
    // 履歴と無関係な設定は残ること
    youtubeApiKey: 'KEEP'
  });

  test('旧形式の履歴とアバターが移り、旧キーは消える', async () => {
    const { store, local } = loadStore({ storage: legacyStorage() });

    await store.migrateFromLocal();

    assert.deepEqual([...(await store.read('OLD')).map(c => c.id)], ['1', '2']);
    // 旧形式は「発言者名 -> URL」で枠を持たないので bulk として入る
    // （その人が次に発言した時点で、primary なら枠ごと上書きされる）
    assert.deepEqual({ ...(await store.readAvatars('OLD')).ユーザー1 },
      { url: 'https://example.test/a.png', bucket: 'bulk' });
    assert.deepEqual(Object.keys(local), ['youtubeApiKey'], '旧キーが残っている');

    // 更新時刻は旧メタから引き継ぐ。ここを「いま」にすると保持の並べ替えが壊れる
    const [video] = await store.listVideos();
    assert.equal(video.updatedAt, Date.parse('2026-08-01T00:00:00Z'));
    assert.deepEqual({ ...video.counts }, { primary: 1, bulk: 1 });
  });

  test('書き込みに失敗したら旧データを消さない', async () => {
    // 移行は片道。消してから失敗すると、そのぶんは二度と戻らない
    const { store, local } = loadStore({ storage: legacyStorage(), quotaBytes: 10 });

    await store.migrateFromLocal();

    assert.ok('commentsHistory_OLD' in local, '書けていないのに旧データを消している');
    assert.deepEqual([...await store.read('OLD')], []);
  });

  test('2度走らせても履歴は二重にならない', async () => {
    // 「IndexedDB へは書けたが、旧キーを消す前に落ちた」あとの再起動を模す。
    // 同じ IndexedDB を共有したまま、旧キーが残った storage.local から移行させる
    const first = loadStore({ storage: legacyStorage() });
    await first.store.migrateFromLocal();

    const again = loadStore({ storage: legacyStorage(), idb: first.idb });
    await again.store.migrateFromLocal();

    assert.deepEqual([...(await again.store.read('OLD')).map(c => c.id)], ['1', '2']);
    assert.equal((await again.store.count('OLD')).total, 2, '移行が二重に積んでいる');
  });
});
