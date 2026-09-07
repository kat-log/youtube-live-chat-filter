// IndexedDB の最小の偽実装。
//
// fake-indexeddb は入れない（実行時どころか開発時の依存も増やさない方針）。
// src/shared/store.js が使うのは open / transaction / objectStore /
// put / get / getAll / delete / openCursor / index の9つだけなので、
// service-worker-harness.js の storage モックと同じ流儀で自前で足りる。
//
// 注意: これは本物の IndexedDB ではない。再現しているのは
// 「キーの並び順」「インデックス経由のカーソル」「トランザクションが
// 中断すると書き込みが丸ごと巻き戻る」の3つだけ。
// バージョン変更の競合や、複数タブからの同時アクセスは再現しない。
//
// コールバックはすべて非同期に発火させる（マイクロタスク）。同期で呼ぶと、
// store.js が request を受け取ってから onsuccess を代入するまでの間に
// 発火してしまい、カーソルが1歩も進まなくなる。

const QUOTA_MESSAGE = 'QuotaExceededError: the storage quota has been exceeded';

/** IndexedDB のキー比較。number < string < array の順で、配列は要素ごとに比べる */
function typeRank(key) {
  if (Array.isArray(key)) return 2;
  if (typeof key === 'string') return 1;
  return 0;
}

function compareKeys(a, b) {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;

  if (rankA === 2) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const result = compareKeys(a[i], b[i]);
      if (result !== 0) return result;
    }
    // 短い方（[videoId] のような前方一致）が先
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
  }

  if (a === b) return 0;
  return a < b ? -1 : 1;
}

class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(key) {
    if (this.lower !== undefined) {
      const compared = compareKeys(key, this.lower);
      if (compared < 0 || (compared === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const compared = compareKeys(key, this.upper);
      if (compared > 0 || (compared === 0 && this.upperOpen)) return false;
    }
    return true;
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
  static lowerBound(lower, open = false) { return new FakeKeyRange(lower, undefined, open, false); }
  static upperBound(upper, open = false) { return new FakeKeyRange(undefined, upper, false, open); }
  static only(key) { return new FakeKeyRange(key, key, false, false); }
}

const keyOf = (record, keyPath) => Array.isArray(keyPath)
  ? keyPath.map(path => record[path])
  : record[keyPath];

const serialize = key => JSON.stringify(key);

/**
 * @param {object} [options]
 * @param {number} [options.quotaBytes] これを超える put は QuotaExceededError で失敗し、
 *                                      トランザクションごと巻き戻る
 */
function createIndexedDBMock({ quotaBytes = Infinity } = {}) {
  let quota = quotaBytes;
  // databases[name] = { version, stores: { storeName: { keyPath, indexes, records: Map } } }
  const databases = new Map();
  const calls = { puts: [], deletes: [], transactions: [] };

  const fire = (target, handlerName, event = {}) => {
    Promise.resolve().then(() => {
      const handler = target[handlerName];
      if (typeof handler === 'function') handler({ target, ...event });
    });
  };

  const usedBytes = () => {
    let total = 0;
    for (const db of databases.values()) {
      for (const store of Object.values(db.stores)) {
        for (const record of store.records.values()) total += JSON.stringify(record).length;
      }
    }
    return total;
  };

  function createRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }

  function succeed(request, result) {
    request.result = result;
    fire(request, 'onsuccess');
    return request;
  }

  class FakeTransaction {
    constructor(db, storeNames, mode) {
      this.db = db;
      this.mode = mode;
      this.error = null;
      this.finished = false;
      this.pending = 0;
      this.names = Array.isArray(storeNames) ? storeNames : [storeNames];
      // 中断したときに丸ごと戻せるよう、開始時点の中身を控えておく
      this.snapshot = new Map(this.names.map(
        name => [name, new Map(db.stores[name].records)]));
      calls.transactions.push({ names: this.names, mode });
      this.scheduleComplete();
    }

    objectStore(name) {
      if (!this.names.includes(name)) throw new Error(`store ${name} is not in this transaction`);
      return new FakeObjectStore(this, this.db.stores[name]);
    }

    // 本物は「保留中のリクエストが無くなり、制御がイベントループに戻ったら」commit する。
    // マイクロタスクで await を繋いでいる間は閉じないよう、マクロタスクで判定する
    scheduleComplete() {
      setTimeout(() => {
        if (this.finished) return;
        if (this.pending > 0) { this.scheduleComplete(); return; }
        this.finished = true;
        fire(this, 'oncomplete');
      }, 0);
    }

    abort(error) {
      if (this.finished) return;
      this.finished = true;
      this.error = error;
      for (const [name, records] of this.snapshot) {
        this.db.stores[name].records = records;
      }
      fire(this, 'onabort');
    }
  }

  class FakeCursor {
    constructor(store, entries, index) {
      this.store = store;
      this.entries = entries;
      this.index = index;
      this.request = null;
    }

    load() {
      const entry = this.entries[this.index];
      this.key = entry.key;
      this.primaryKey = entry.primaryKey;
      this.value = structuredClone(entry.value);
      return this;
    }

    continue() {
      this.index += 1;
      const request = this.request;
      if (this.index >= this.entries.length) {
        succeed(request, null);
      } else {
        succeed(request, this.load());
      }
    }

    delete() {
      this.store.records.delete(serialize(this.primaryKey));
      calls.deletes.push({ store: this.store.name, key: this.primaryKey });
      return succeed(createRequest(), undefined);
    }
  }

  class FakeIndex {
    constructor(transaction, store, name) {
      this.transaction = transaction;
      this.store = store;
      this.keyPath = store.indexes[name];
      if (!this.keyPath) throw new Error(`unknown index: ${name}`);
    }

    entries(range, direction) {
      return collectEntries(this.store, this.keyPath, range, direction);
    }

    openCursor(range = null, direction = 'next') {
      return openCursorOn(this.transaction, this.store, this.entries(range, direction));
    }

    getAll(range = null) {
      const request = createRequest();
      const values = this.entries(range, 'next').map(entry => structuredClone(entry.value));
      this.transaction.pending += 1;
      Promise.resolve().then(() => { this.transaction.pending -= 1; });
      return succeed(request, values);
    }
  }

  function collectEntries(store, keyPath, range, direction) {
    const entries = [];
    for (const record of store.records.values()) {
      const key = keyOf(record, keyPath);
      if (key === undefined) continue;
      if (range && !range.includes(key)) continue;
      entries.push({ key, primaryKey: keyOf(record, store.keyPath), value: record });
    }
    entries.sort((a, b) => compareKeys(a.key, b.key));
    if (direction === 'prev') entries.reverse();
    return entries;
  }

  function openCursorOn(transaction, store, entries) {
    const request = createRequest();
    transaction.pending += 1;
    Promise.resolve().then(() => { transaction.pending -= 1; });
    if (entries.length === 0) return succeed(request, null);
    const cursor = new FakeCursor(store, entries, 0);
    cursor.request = request;
    return succeed(request, cursor.load());
  }

  class FakeObjectStore {
    constructor(transaction, store) {
      this.transaction = transaction;
      this.store = store;
      this.keyPath = store.keyPath;
    }

    index(name) { return new FakeIndex(this.transaction, this.store, name); }

    put(value) {
      const request = createRequest();
      const key = keyOf(value, this.keyPath);
      const clone = structuredClone(value);
      this.store.records.set(serialize(key), clone);
      calls.puts.push({ store: this.store.name, key });

      if (usedBytes() > quota) {
        this.store.records.delete(serialize(key));
        const error = new Error(QUOTA_MESSAGE);
        error.name = 'QuotaExceededError';
        request.error = error;
        fire(request, 'onerror');
        this.transaction.abort(error);
        return request;
      }

      this.transaction.pending += 1;
      Promise.resolve().then(() => { this.transaction.pending -= 1; });
      return succeed(request, key);
    }

    get(key) {
      const request = createRequest();
      this.transaction.pending += 1;
      Promise.resolve().then(() => { this.transaction.pending -= 1; });
      const record = this.store.records.get(serialize(key));
      return succeed(request, record ? structuredClone(record) : undefined);
    }

    getAll(range = null) {
      const request = createRequest();
      this.transaction.pending += 1;
      Promise.resolve().then(() => { this.transaction.pending -= 1; });
      const values = collectEntries(this.store, this.keyPath, range, 'next')
        .map(entry => structuredClone(entry.value));
      return succeed(request, values);
    }

    delete(key) {
      const request = createRequest();
      this.store.records.delete(serialize(key));
      calls.deletes.push({ store: this.store.name, key });
      this.transaction.pending += 1;
      Promise.resolve().then(() => { this.transaction.pending -= 1; });
      return succeed(request, undefined);
    }

    openCursor(range = null, direction = 'next') {
      return openCursorOn(this.transaction, this.store,
        collectEntries(this.store, this.keyPath, range, direction));
    }
  }

  class FakeDatabase {
    constructor(record) {
      this.record = record;
      this.stores = record.stores;
      this.objectStoreNames = {
        contains: name => Object.prototype.hasOwnProperty.call(record.stores, name)
      };
    }

    createObjectStore(name, { keyPath }) {
      const store = { name, keyPath, indexes: {}, records: new Map() };
      this.stores[name] = store;
      return {
        createIndex(indexName, indexKeyPath) { store.indexes[indexName] = indexKeyPath; }
      };
    }

    transaction(storeNames, mode = 'readonly') {
      return new FakeTransaction(this, storeNames, mode);
    }

    close() {}
  }

  const indexedDB = {
    open(name, version = 1) {
      const request = createRequest();
      if (!databases.has(name)) databases.set(name, { version: 0, stores: {} });
      const record = databases.get(name);
      const db = new FakeDatabase(record);
      request.result = db;

      Promise.resolve().then(() => {
        if (record.version < version) {
          record.version = version;
          if (typeof request.onupgradeneeded === 'function') {
            request.onupgradeneeded({ target: request, oldVersion: 0, newVersion: version });
          }
        }
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      });

      return request;
    },

    deleteDatabase(name) {
      databases.delete(name);
      return succeed(createRequest(), undefined);
    }
  };

  return {
    indexedDB,
    IDBKeyRange: FakeKeyRange,
    calls,
    /** いま使っているバイト数（容量上限を後から決めるときの目安） */
    usedBytes,
    /** 容量上限を後から変える。「途中で一杯になった」を作るのに使う */
    setQuotaBytes(bytes) { quota = bytes; },
    /** 中身をそのまま覗く（テストの検証用） */
    dump(dbName = 'ytChatFilter') {
      const record = databases.get(dbName);
      if (!record) return {};
      const out = {};
      for (const [name, store] of Object.entries(record.stores)) {
        out[name] = Array.from(store.records.values());
      }
      return out;
    }
  };
}

module.exports = { createIndexedDBMock, compareKeys };
