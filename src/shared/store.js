// コメント履歴の保存を1か所に集めたモジュール（再設計の決定2・決定3）。
//
// これまで履歴は storage.local に「動画1本ぶんの配列」として置かれ、
// 500ms ごとに全件を set() し直していた。賑わった配信では毎秒 0.8MiB の
// 書き込みが数時間続く（docs/audit-2026-09.md #21 = 根本原因C）。
// IndexedDB へ移し、追記は1レコードの put だけで済むようにする。
//
// 【触るときの注意】
// - このファイルは二重注入ガードで包まないこと。代入先は self（window ではない。
//   Service Worker に window は無い）。中身を即時実行関数で包んでいるのは、
//   importScripts が service-worker.js と同じスコープを共有するため
//   （トップレベルに const を置くと名前がぶつかる）
// - shared/comment.js より後に読むこと。枠（bucket）の判定は YTF.bucketOf が正で、
//   ここには書き直さない
// - 実行時の依存は増やさない。ビルドも不要のまま（素のスクリプトとして読む）
//
// 読み込み方:
//   Service Worker : importScripts('../shared/store.js')
//   popup          : <script src="../shared/store.js"> を comment.js の後に置く
//
// なぜ self.YTF に相乗りせず self.YTFStore にしたか:
//   comment.js は global.YTF = { ... } と丸ごと代入する。相乗りするには
//   Object.assign に変えたうえで「comment.js が先」という順序に依存させることになり、
//   順序を間違えると片方が黙って消える。名前空間を分ければ順序の間違いは
//   その場で ReferenceError になる。読み込む環境も違う（store.js は
//   content script では要らない）ので、分けたほうが依存が見える。

(function (global) {

  const DB_NAME = 'ytChatFilter';
  const DB_VERSION = 1;
  const COMMENTS = 'comments';
  const AVATARS = 'avatars';
  const META = 'meta';

  // === 上限 ================================================================
  // 保持枠ごとに別々の上限を持つ（決定3）。枠が別なので、一般コメントが
  // いくら流れても特別コメント（primary）は押し出されない
  const LIMITS = { primary: 20000, bulk: 50000 };

  // 保持する動画の本数。storage.local 時代の MAX_HISTORY_VIDEOS を踏襲する
  const MAX_HISTORY_VIDEOS = 5;

  // popup へ一度に渡すコメント数の上限。#33（popup 10,000 と SW 2,000 の食い違い、
  // 復元経路には上限が無い）を、両者が同じ値を見ることで構造的に無くす。
  // 描画の作り直し（フェーズ5）までここを大きくしないこと。いまの popup は
  // 受け取った全件を innerHTML で描き直す（#22）
  const MAX_COMMENTS_TO_POPUP = 10000;

  // アバターURLは発言者ごとに1つだけ持つ。コメント件数に比例させると
  // 同じURLを何百回も保存することになる
  const MAX_AVATARS_PER_VIDEO = 500;

  // storage.local 時代のキー。移行が終われば読むところは無くなる
  const LEGACY_HISTORY_PREFIX = 'commentsHistory_';
  const LEGACY_AVATAR_PREFIX = 'commentAvatars_';
  const LEGACY_META_KEY = 'commentsHistoryMeta';
  const LEGACY_SINGLE_KEY = 'commentsHistory';

  // === IndexedDB の薄いラッパ ==============================================
  // await を挟むとトランザクションが閉じる、という話は「別の非同期処理を待った
  // 場合」のこと。同じトランザクションのリクエストを await するぶんには、
  // マイクロタスクが commit より先に回るので閉じない（Chrome / 仕様どおり）。
  // ここでは1つの op が1つのトランザクションで完結する形しか書かない。

  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(COMMENTS)) {
          const store = db.createObjectStore(COMMENTS, { keyPath: 'pk' });
          // 枠ごとの読み出しと切り詰めはこのインデックスだけで足りる
          store.createIndex('byVideoBucket', ['videoId', 'bucket', 'seq']);
          store.createIndex('byVideo', ['videoId', 'seq']);
        }
        if (!db.objectStoreNames.contains(AVATARS)) {
          db.createObjectStore(AVATARS, { keyPath: ['videoId', 'displayName'] });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'videoId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch(error => {
      // 失敗を握ったままにすると、以後ずっと同じ失敗を返し続ける
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  const requestResult = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const transactionDone = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });

  // openCursor の request は continue() のたびに onsuccess が再発火する。
  // Promise は1度しか解決しないので、進めるたびに張り直す
  function cursorStep(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // handler は同期であること（別の非同期処理を待つとトランザクションが閉じる）。
  // false を返すと打ち切る
  async function eachCursor(request, handler) {
    let cursor = await cursorStep(request);
    while (cursor) {
      if (handler(cursor) === false) return;
      cursor.continue();
      cursor = await cursorStep(request);
    }
  }

  // === レコードの形 ========================================================

  const emptyMeta = videoId => ({
    videoId,
    lastSeq: 0,
    counts: { primary: 0, bulk: 0 },
    updatedAt: 0
  });

  const totalOf = meta => (meta.counts.primary || 0) + (meta.counts.bulk || 0);

  // 枠の判定は shared/comment.js が正（決定3）。ここに書き直さない。
  // 取り込み時点の形（DOMモードのメッセージ / API item / 旧保存形式）はまちまちなので、
  // bucket が付いていなければ正準形に通してから引く。結果はレコードに焼き付けるので、
  // 1件につき1回しか通らない
  function bucketFor(comment) {
    if (comment.bucket === 'primary' || comment.bucket === 'bulk') return comment.bucket;
    return global.YTF.bucketOf(global.YTF.normalizeComment(comment));
  }

  // 保存レコードから、呼び出し側に返す形を作る。pk と videoId は
  // インデックスのための持ち物なので落とす（seq は範囲読みのカーソルに使う）
  function toComment(record) {
    const comment = { ...record };
    delete comment.pk;
    delete comment.videoId;
    return comment;
  }

  // 履歴の最終コメント時刻。DOMモードはトップレベル、APIモードは snippet 配下にある。
  // 移行時に updatedAt を埋めるために使う
  function latestTimestampOf(history) {
    for (let i = history.length - 1; i >= 0; i--) {
      const raw = history[i]?.publishedAt || history[i]?.snippet?.publishedAt;
      const time = raw ? new Date(raw).getTime() : 0;
      if (time) return time;
    }
    return 0;
  }

  // === 内部実装（移行の中からも呼ぶので ready() を待たない） =================

  async function appendInternal(videoId, comments) {
    if (!videoId || !comments || comments.length === 0) return { appended: 0 };

    const db = await openDatabase();
    const tx = db.transaction([COMMENTS, META], 'readwrite');
    const commentStore = tx.objectStore(COMMENTS);
    const metaStore = tx.objectStore(META);

    const meta = (await requestResult(metaStore.get(videoId))) || emptyMeta(videoId);
    let seq = meta.lastSeq || 0;

    for (const comment of comments) {
      seq += 1;
      const bucket = bucketFor(comment);
      meta.counts[bucket] = (meta.counts[bucket] || 0) + 1;
      // 追記は新しい pk への put だけ。既存レコードには一切触らない（#21）
      commentStore.put({ ...comment, pk: `${videoId}:${seq}`, videoId, seq, bucket });
    }

    meta.lastSeq = seq;
    meta.updatedAt = Date.now();
    metaStore.put(meta);

    await transactionDone(tx);
    return { appended: comments.length, lastSeq: seq };
  }

  async function readInternal(videoId, { bucket = null, limit = MAX_COMMENTS_TO_POPUP, before = null } = {}) {
    if (!videoId || limit <= 0) return [];

    const db = await openDatabase();
    const tx = db.transaction([COMMENTS], 'readonly');
    const index = tx.objectStore(COMMENTS).index(bucket ? 'byVideoBucket' : 'byVideo');

    const lower = bucket ? [videoId, bucket, -Infinity] : [videoId, -Infinity];
    const upper = bucket
      ? [videoId, bucket, before === null ? Infinity : before]
      : [videoId, before === null ? Infinity : before];
    // before は排他。「これより古いぶんをもう1ページ」の形で使う
    const range = IDBKeyRange.bound(lower, upper, false, before !== null);

    // 新しい方から limit 件だけ拾って、返すときに古い順へ戻す
    const collected = [];
    await eachCursor(index.openCursor(range, 'prev'), cursor => {
      collected.push(toComment(cursor.value));
      if (collected.length >= limit) return false;
    });

    collected.reverse();
    return collected;
  }

  async function countInternal(videoId) {
    if (!videoId) return { primary: 0, bulk: 0, total: 0 };
    const db = await openDatabase();
    const tx = db.transaction([META], 'readonly');
    const meta = await requestResult(tx.objectStore(META).get(videoId));
    if (!meta) return { primary: 0, bulk: 0, total: 0 };
    return {
      primary: meta.counts.primary || 0,
      bulk: meta.counts.bulk || 0,
      total: totalOf(meta)
    };
  }

  // dropMeta が true なら meta ごと消す（動画の履歴そのものを捨てる場合）
  async function removeVideo(videoId, { dropMeta }) {
    if (!videoId) return;
    const db = await openDatabase();
    const tx = db.transaction([COMMENTS, AVATARS, META], 'readwrite');

    const byVideo = tx.objectStore(COMMENTS).index('byVideo');
    const range = IDBKeyRange.bound([videoId, -Infinity], [videoId, Infinity]);
    await eachCursor(byVideo.openCursor(range), cursor => { cursor.delete(); });

    // アバターも対で消す。片方だけ残ると参照されないアバターが永久に居座る（#6）
    const avatarStore = tx.objectStore(AVATARS);
    await eachCursor(avatarStore.openCursor(avatarRange(videoId)), cursor => { cursor.delete(); });

    const metaStore = tx.objectStore(META);
    if (dropMeta) {
      metaStore.delete(videoId);
    } else {
      const meta = (await requestResult(metaStore.get(videoId))) || emptyMeta(videoId);
      // lastSeq は戻さない。クリア後に再スキャンで戻ってきたコメントに、
      // 消したぶんと同じ pk を振らないため
      meta.counts = { primary: 0, bulk: 0 };
      meta.updatedAt = Date.now();
      metaStore.put(meta);
    }

    await transactionDone(tx);
  }

  const avatarRange = videoId => IDBKeyRange.bound([videoId], [videoId, []]);

  // === 移行（storage.local -> IndexedDB） ==================================
  // 片道。ロールバックはできないので、旧データを消すのは
  // 「書けたことを読み直して確かめてから」に限る。
  //
  // 移行するのは Service Worker だけ。popup と同時に走らせると、
  // 同じ配列を2回 append して履歴が二重になる。だから自動では走らせず、
  // migrateFromLocal() を呼んだ環境だけが移行する

  let migrationPromise = null;

  const ready = () => migrationPromise || Promise.resolve();

  function migrateFromLocal() {
    if (!migrationPromise) migrationPromise = runMigration();
    return migrationPromise;
  }

  async function legacyKeys() {
    try {
      if (typeof chrome.storage.local.getKeys === 'function') {
        return await chrome.storage.local.getKeys();
      }
    } catch {
      // getKeys が使えない環境では全件読みにフォールバックする
    }
    return Object.keys(await chrome.storage.local.get());
  }

  async function runMigration() {
    let moved = 0;
    try {
      const keys = await legacyKeys();
      const historyKeys = keys.filter(key => key.startsWith(LEGACY_HISTORY_PREFIX));

      // 更に古い「動画で分けていなかった頃」のキー。参照されないまま容量を食う
      if (keys.includes(LEGACY_SINGLE_KEY)) {
        await chrome.storage.local.remove(LEGACY_SINGLE_KEY);
      }

      const legacyMeta = historyKeys.length
        ? (await chrome.storage.local.get([LEGACY_META_KEY]))[LEGACY_META_KEY] || {}
        : {};

      for (const historyKey of historyKeys) {
        const videoId = historyKey.slice(LEGACY_HISTORY_PREFIX.length);
        if (await migrateVideo(videoId, historyKey, legacyMeta[videoId])) moved += 1;
      }

      if (historyKeys.length && !(await remainingHistoryKeys()).length) {
        await chrome.storage.local.remove(LEGACY_META_KEY);
      }
    } catch (error) {
      // 移行に失敗しても旧キーは残っている。次回の起動でやり直せる
      console.error('[Store] Migration from storage.local failed:', error);
    }
    return { migratedVideos: moved };
  }

  async function remainingHistoryKeys() {
    return (await legacyKeys()).filter(key => key.startsWith(LEGACY_HISTORY_PREFIX));
  }

  async function migrateVideo(videoId, historyKey, legacyUpdatedAt) {
    const avatarKey = `${LEGACY_AVATAR_PREFIX}${videoId}`;
    const stored = await chrome.storage.local.get([historyKey, avatarKey]);
    const history = Array.isArray(stored[historyKey]) ? stored[historyKey] : [];
    const avatars = stored[avatarKey] || {};

    // 前回の移行が「書けたが消す前に落ちた」場合に備えて、既にあるIDは除く。
    // 何度走らせても同じ結果になるようにしておく
    let toAppend = history;
    const before = await countInternal(videoId);
    if (before.total > 0) {
      const known = new Set((await readInternal(videoId, { limit: Infinity })).map(c => c.id));
      toAppend = history.filter(comment => !comment?.id || !known.has(comment.id));
    }

    if (toAppend.length > 0) {
      await appendInternal(videoId, toAppend);
      // 書き込み成功の確認。ここを通ってからでないと旧データは消せない
      const after = await countInternal(videoId);
      if (after.total < before.total + toAppend.length) {
        console.error('[Store] Migration verification failed for', videoId,
          '- keeping storage.local data');
        return false;
      }
    }

    const names = Object.keys(avatars).slice(-MAX_AVATARS_PER_VIDEO);
    if (names.length > 0) {
      const delta = {};
      for (const name of names) delta[name] = avatars[name];
      await putAvatarsInternal(videoId, delta, []);
      const restored = await readAvatarsInternal(videoId);
      if (Object.keys(restored).length < names.length) {
        console.error('[Store] Avatar migration verification failed for', videoId);
        return false;
      }
    }

    // 移行済みの動画は updatedAt を旧メタから引き継ぐ。ここを Date.now() のままに
    // すると、全動画が「いま更新された」ことになって保持の並べ替えが壊れる
    await touchInternal(videoId, legacyUpdatedAt || latestTimestampOf(history) || Date.now());

    await chrome.storage.local.remove([historyKey, avatarKey]);
    return true;
  }

  async function touchInternal(videoId, updatedAt) {
    const db = await openDatabase();
    const tx = db.transaction([META], 'readwrite');
    const metaStore = tx.objectStore(META);
    const meta = (await requestResult(metaStore.get(videoId))) || emptyMeta(videoId);
    meta.updatedAt = updatedAt;
    metaStore.put(meta);
    await transactionDone(tx);
  }

  async function putAvatarsInternal(videoId, added, evicted) {
    const names = Object.keys(added || {});
    if (!videoId || (names.length === 0 && (!evicted || evicted.length === 0))) return;

    const db = await openDatabase();
    const tx = db.transaction([AVATARS], 'readwrite');
    const store = tx.objectStore(AVATARS);
    for (const displayName of names) {
      store.put({ videoId, displayName, url: added[displayName] });
    }
    for (const displayName of evicted || []) {
      store.delete([videoId, displayName]);
    }
    await transactionDone(tx);
  }

  async function readAvatarsInternal(videoId) {
    if (!videoId) return {};
    const db = await openDatabase();
    const tx = db.transaction([AVATARS], 'readonly');
    const records = await requestResult(tx.objectStore(AVATARS).getAll(avatarRange(videoId)));
    const map = {};
    for (const record of records) map[record.displayName] = record.url;
    return map;
  }

  // === 公開API =============================================================
  // 最小限に保つこと。ここが太ると、また保存の作法が場所ごとに分かれる

  /** 追記。新しい pk への put だけで済み、既存レコードは書き換えない */
  async function append(videoId, comments) {
    await ready();
    return appendInternal(videoId, comments);
  }

  /**
   * 新しい方から limit 件を読み、古い順に返す。
   * @param {string} videoId
   * @param {object} [options]
   * @param {'primary'|'bulk'|null} [options.bucket] 枠を絞る（null なら両方）
   * @param {number} [options.limit]
   * @param {number} [options.before] この seq より古いぶんだけ（ページング用）
   */
  async function read(videoId, options) {
    await ready();
    return readInternal(videoId, options);
  }

  /** 枠ごとの件数。数えるのではなく meta に持っている値を返す */
  async function count(videoId) {
    await ready();
    return countInternal(videoId);
  }

  /** 履歴のクリア。コメントとアバターを対で消す（#6）。動画の枠自体は残す */
  async function clear(videoId) {
    await ready();
    return removeVideo(videoId, { dropMeta: false });
  }

  /** 動画ごと捨てる。保持本数を超えた古い動画に使う */
  async function dropVideo(videoId) {
    await ready();
    return removeVideo(videoId, { dropMeta: true });
  }

  /** 枠ごとの上限を超えたぶんを、古い方から消す（決定3） */
  async function trim(videoId) {
    await ready();
    if (!videoId) return { primary: 0, bulk: 0 };

    const db = await openDatabase();
    const tx = db.transaction([COMMENTS, META], 'readwrite');
    const metaStore = tx.objectStore(META);
    const meta = await requestResult(metaStore.get(videoId));
    const removed = { primary: 0, bulk: 0 };

    if (!meta) {
      await transactionDone(tx);
      return removed;
    }

    const index = tx.objectStore(COMMENTS).index('byVideoBucket');

    for (const bucket of ['primary', 'bulk']) {
      let excess = (meta.counts[bucket] || 0) - LIMITS[bucket];
      if (excess <= 0) continue;

      // インデックスは [videoId, bucket, seq] の順。前から進めば古い方から当たる。
      // 枠が別なので、bulk をいくら削っても primary は1件も減らない
      const range = IDBKeyRange.bound([videoId, bucket, -Infinity], [videoId, bucket, Infinity]);
      await eachCursor(index.openCursor(range), cursor => {
        cursor.delete();
        removed[bucket] += 1;
        excess -= 1;
        if (excess <= 0) return false;
      });

      meta.counts[bucket] = (meta.counts[bucket] || 0) - removed[bucket];
    }

    if (removed.primary || removed.bulk) metaStore.put(meta);
    await transactionDone(tx);
    return removed;
  }

  /** 履歴を持っている動画の一覧。更新が新しい順 */
  async function listVideos() {
    await ready();
    const db = await openDatabase();
    const tx = db.transaction([META], 'readonly');
    const rows = await requestResult(tx.objectStore(META).getAll());
    return rows
      .map(meta => ({
        videoId: meta.videoId,
        lastSeq: meta.lastSeq || 0,
        counts: { primary: meta.counts.primary || 0, bulk: meta.counts.bulk || 0 },
        total: totalOf(meta),
        updatedAt: meta.updatedAt || 0
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 発言者ごとのアバター。added を足し、evicted を消す */
  async function putAvatars(videoId, added, evicted) {
    await ready();
    return putAvatarsInternal(videoId, added, evicted);
  }

  async function readAvatars(videoId) {
    await ready();
    return readAvatarsInternal(videoId);
  }

  global.YTFStore = {
    DB_NAME,
    DB_VERSION,
    LIMITS,
    MAX_HISTORY_VIDEOS,
    MAX_COMMENTS_TO_POPUP,
    MAX_AVATARS_PER_VIDEO,
    append,
    read,
    count,
    clear,
    trim,
    listVideos,
    dropVideo,
    putAvatars,
    readAvatars,
    migrateFromLocal,
    latestTimestampOf
  };

})(self);
