// 二重注入防止と、注入先フレームの限定。
//
// service-worker からの明示注入は allFrames なので、host_permissions に合致する
// フレーム全部（watch のトップフレームを含む）に届く。そこにライブチャットのDOMは
// 無いため、そのまま走らせると attachObserver が終わらない再試行に入る（#1）。
// manifest の自動注入は live_chat* 限定なので、ここで同じ条件を課しておけば揃う。
//
// パスが違うフレームでは __domChatInitialized を立てない。次に注入されたときも
// この条件で弾かれるだけなので害は無く、SPA遷移でチャットのフレームになった場合に
// 取りこぼさない
if (window.__domChatInitialized || !location.pathname.startsWith('/live_chat')) { /* noop */ } else {
window.__domChatInitialized = true;

// IDの作り方は shared/comment.js に集約している（再設計の決定7）。
// manifest の js 配列で、このファイルより先に読み込まれる
const { commentKeyOf, commentIdFor, legacyCommentIdFor, isEmojiLabel } = self.YTF;

// 送信済みのID。上限に達したら古い方から捨てる（全消しにすると、直後の
// 再スキャンで全件を送り直すことになる）
const seenIds = new Set();
const MAX_SEEN_IDS = 2000;

// 要素→ID。同じ要素には常に同じIDを振り、再スキャンで重複を作らないようにする
const idByElement = new WeakMap();
// 同一内容・同一時刻のコメントを区別するための連番（キーごとの出現回数）
const occurrenceByKey = new Map();
const MAX_OCCURRENCE_KEYS = 5000;

// 上限を超えたぶんを古い方から捨てる。Map / Set の反復は挿入順なので、
// 先頭から必要数だけ delete すれば FIFO になる。
// 全消しにしてはいけない（#29）: occurrenceByKey を空にすると連番が 0 に戻り、
// 同じ人が同じ分に同じ本文を投げていた場合、クリア後の1件目が既出のIDと
// 同じ値になって「重複」として消える
function trimOldest(collection, max) {
  if (collection.size <= max) return;
  for (const key of collection.keys()) {
    if (collection.size <= max) break;
    collection.delete(key);
  }
}

// === YouTube の DOM に依存する文字列は、ぜんぶこのブロック ==================
//
// 以前は19個が本文のあちこちに直書きされていた。YouTube 側が DOM を変えると
// このファイルは無言で0件になるので（#2）、直す場所を探すところから始まらないよう
// 1か所に集めてある。**ここ以外に生の文字列を書かないこと。**
//
// テストのハーネス（test/helpers/dom-chat-harness.js）は「知らないセレクタを
// 引かれたら例外」にしてある。セレクタを足したらハーネスの許可リストにも足すこと
// （黙って null を返すモックだと、綴りの取り違えがテストを素通りする）。

// 監視対象のチャット行。スーパーチャットやメンバーシップのイベントは
// テキストコメントとは別のタグで流れてくるため、タグ名から種別を引く
const KIND_BY_TAG = {
  'yt-live-chat-text-message-renderer': 'text',
  'yt-live-chat-paid-message-renderer': 'superchat',
  'yt-live-chat-paid-sticker-renderer': 'supersticker',
  'yt-live-chat-membership-item-renderer': 'membership',
  'yt-live-chat-sponsorships-gift-purchase-announcement-renderer': 'gift'
};

const SELECTORS = {
  // チャット行の入れ物と、それを抱えている祖先。
  // 祖先は #items が差し替わったことに気付くために監視する（#2）
  itemList: 'yt-live-chat-item-list-renderer #items',
  itemListHost: 'yt-live-chat-item-list-renderer',

  // 1行の中身
  authorName: '#author-name',
  timestamp: '#timestamp',
  message: '#message',
  // メンバーシップ: 新規加入は #header-subtext だけ、継続は #header-primary-text に入る
  membershipPrimaryText: '#header-primary-text',
  membershipSubtext: '#header-subtext',
  // ギフト購入の告知文
  giftPrimaryText: '#primary-text',
  stickerImage: '#sticker img',
  purchaseAmount: '#purchase-amount',
  purchaseAmountChip: '#purchase-amount-chip',
  authorPhoto: '#author-photo img',
  // 有料メッセージの行はアバターの器が違う
  authorPhotoFallback: 'img#img',
  // チャット側から popup を絞り込むときに、クリックを受け付ける範囲（名前とアイコン）
  authorClickTarget: '#author-name, #author-photo',
  moderatorBadge: 'yt-live-chat-author-badge-renderer[type="moderator"]',
  memberBadge: 'yt-live-chat-author-badge-renderer[type="member"]'
};

// 行に付く属性も YouTube 由来。roleOf が読む
const AUTHOR_TYPE_ATTR = 'author-type';

// チャット行そのものを指すセレクタ。クリックされた要素から行へ遡るのに使う。
// KIND_BY_TAG から組み立てるので、監視対象の行が増えればここも自動で追従する
const ROW_SELECTOR = Object.keys(KIND_BY_TAG).join(',');

function kindOf(node) {
  return KIND_BY_TAG[node.tagName?.toLowerCase()] || null;
}

// === ヘルス状態（このファイルが読めているかどうか）==========================
//
// 無言で止まる形は2つある。どちらも症状は「コメントが来ない」だけで、
// 静かな配信と見分けが付かない（根本原因F: 壊れても見えない）。
//
//  - #items を見失って observer が外れる（#2）
//  - セレクタが変わって、行は流れているのに1件も取り込めない ← いちばん危ない
//
// 状態が変わるたびに Service Worker へ片道で送り、popup まで出す。
const HEALTH = {
  SEARCHING: 'searching',    // #items を探している最中
  NO_CHAT: 'no-chat',        // 見つからないまま諦めた
  WATCHING: 'watching',      // 監視中。まだ1件も流れていない
  READING: 'reading',        // 監視中。取り込めている
  UNREADABLE: 'unreadable'   // 監視中だが、行はあるのに読み取れない
};

// 「行はあるのに読めない」が何件続いたら壊れたとみなすか。
// 本文の器を持たない行は普通にあるので、1〜2件では騒がない
const UNREADABLE_STREAK = 5;
// 全件スキャンで「既知のタグの行が1つも無い」と言い切るのに要る行数。
// お知らせ行だけが入っている状態と区別するため、少数では騒がない
const UNKNOWN_ROW_LIMIT = 5;

const health = {
  state: HEALTH.SEARCHING,
  rows: 0,          // 取り込みを試した行の数（既知のタグを持つもの）
  extracted: 0,     // うち取り込めた数
  unreadable: 0,    // うち読み取れなかった数
  streak: 0,        // 連続で読み取れていない数
  reattached: 0,    // observer を張り直した回数（#2 が起きた回数）
  changedAt: Date.now()
};

// 状態が変わったときだけ送る。行ごとに送ると、その通信自体が流量になる
function setHealthState(state) {
  if (health.state === state) return;
  health.state = state;
  health.changedAt = Date.now();
  sendToBackground({ action: 'domChatHealth', health: { ...health } });
}

function noteExtracted() {
  health.extracted++;
  health.streak = 0;
  setHealthState(HEALTH.READING);
}

function noteUnreadable() {
  health.unreadable++;
  health.streak++;
  if (health.streak >= UNREADABLE_STREAK) setHealthState(HEALTH.UNREADABLE);
}

// 監視開始前のコメントも拾えるよう、既にDOMにある分を全件送り直す。
// 送信済みかどうかは background 側がIDで弾くため、force でも重複はしない。
function doInitialSweep(force = false) {
  const itemList = document.querySelector(SELECTORS.itemList);
  if (!itemList) return;
  const rows = [];
  // 「行はあるのに、既知のタグが1つも無い」= 行のタグ名ごと変わった疑い。
  // 新着（handleMutations）からは判定できない —— そこへ来る未知のタグは
  // お知らせ行など普通に混ざるため、全件を数えられるここでだけ見る
  let totalRows = 0;
  let knownRows = 0;
  for (const node of itemList.children) {
    totalRows++;
    const kind = kindOf(node);
    if (!kind) continue;
    knownRows++;

    // 過去分は投稿時刻が「今」ではないので、DOMのタイムスタンプがあればそれを使う。
    // 画像（ステッカー・アバター）はチャットを開いた直後だとまだ読み込まれて
    // いないことがあるので、新着と同じく生えるまで待つ
    rows.push(pendingRow(node, kind, { useDomTimestamp: true, force }));
  }
  if (knownRows === 0 && totalRows >= UNKNOWN_ROW_LIMIT) setHealthState(HEALTH.UNREADABLE);
  queueRows(rows);
}

// #items はフレームの読み込み直後にはまだ無いことがあるので待つ。ただし無限には
// 待たない。上限が無いと、チャットが現れないフレームで500msごとの querySelector が
// セッションが終わるまで回り続ける（#1）
const ATTACH_MAX_RETRIES = 60; // 500ms x 60 = 30秒

function attachObserver(retriesLeft = ATTACH_MAX_RETRIES) {
  if (!ensureObserving()) {
    if (retriesLeft <= 0) {
      console.warn('[DomChat] チャットの #items が見つからないため監視を諦めた:', location.href);
      setHealthState(HEALTH.NO_CHAT);
      return;
    }
    setTimeout(() => attachObserver(retriesLeft - 1), 500);
    return;
  }

  doInitialSweep();
}

// === 監視の張り直し（#2）==================================================
//
// 一度張った observer は、YouTube が #items を作り直すと外れたままになる。
// 「上位のチャット ↔ チャット」の切り替えやチャットのリロードで実際に起き、
// 症状は「コメントが来なくなる」だけで静かな配信と見分けが付かない。
//
// 直し方は2つあり得た。
//
//   (a) 番人（Service Worker の chrome.alarms、3分の沈黙）から注入し直す
//   (b) このファイル自身が気付いて張り直す
//
// **(a) だけでは直らない。** 再注入は window.__domChatInitialized のガードで
// 何もせずに終わるので、外れた observer は外れたまま残る。効くのは一緒に来る
// requestInitialSweep の全件スキャンだけで、3分ごとの取りこぼし回収にしかならない。
//
// なので本体は (b)。#items を抱えている祖先を監視し、差し替えられたら張り直す。
// 番人から来る requestInitialSweep でも張り直しを確かめて、祖先ごと差し替えられた
// 場合の受け皿にしてある（3分後に効く保険で、両方入れても毎分の張り直しにはならない
// —— ensureObserving は「差し替わっていなければ何もしない」ため）。
let itemsObserver = null;
let observedItemList = null;
let hostObserver = null;
let observedHost = null;

/** いま監視している #items がまだDOMに繋がっているか */
function isObservedListAttached() {
  return !!observedItemList && document.contains(observedItemList);
}

/**
 * #items を観測し直す。差し替わっていなければ何もしない。
 * @returns {boolean} 観測できているか（#items が見つからなければ false）
 */
function ensureObserving() {
  const itemList = document.querySelector(SELECTORS.itemList);

  if (!itemList) {
    // 見失った。次に見つかったときに「差し替わった」と分かるよう控えを捨てる
    if (itemsObserver) {
      itemsObserver.disconnect();
      itemsObserver = null;
      observedItemList = null;
      setHealthState(HEALTH.SEARCHING);
    }
    return false;
  }

  if (itemList !== observedItemList) {
    // 古い方を必ず切る。切らずに張り足すと、差し替えのたびに購読が増える
    if (itemsObserver) {
      itemsObserver.disconnect();
      health.reattached++;
    }
    itemsObserver = new MutationObserver(handleMutations);
    itemsObserver.observe(itemList, { childList: true });
    observedItemList = itemList;
    // 張り直したら読み取りの連続失敗は数え直す（別のDOMになったため）
    health.streak = 0;
    setHealthState(health.extracted > 0 ? HEALTH.READING : HEALTH.WATCHING);
  }

  observeHost();
  return true;
}

/**
 * #items の差し替えに気付くための、祖先側の監視。
 *
 * #items は祖先の直下とは限らない（間にスクローラが挟まる）ので subtree が要る。
 * そのぶん行が増えるたびに呼ばれるが、コールバックは
 * 「いま見ている #items がまだ繋がっているか」を確かめるだけにしてある
 */
function observeHost() {
  const host = document.querySelector(SELECTORS.itemListHost);
  if (!host || host === observedHost) return;
  hostObserver?.disconnect();
  hostObserver = new MutationObserver(handleHostMutations);
  hostObserver.observe(host, { childList: true, subtree: true });
  observedHost = host;
}

function handleHostMutations() {
  if (isObservedListAttached()) return;
  // 張り直した直後は、外れていた間に流れた行が入っている。
  // 既出は seenIds で落ちるので、増えるのは取りこぼしぶんだけ
  if (ensureObserving()) doInitialSweep();
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'requestInitialSweep') {
    // 番人からの再スキャン。祖先ごと差し替えられていた場合はここで張り直る
    ensureObserving();
    doInitialSweep(request.force === true);
    return;
  }
  // Service Worker が終了して控えを失ったときの問い合わせ。正はこちらが持っている
  if (request.action === 'getDomChatHealth') {
    sendResponse({ health: { ...health } });
  }
});

function handleMutations(mutations) {
  const rows = [];
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      const kind = kindOf(node);
      if (!kind) continue;
      // 画像が生えるのを待つことがあるので、受信時刻はここで控える
      rows.push(pendingRow(node, kind, { receivedAt: new Date() }));
    }
  }
  queueRows(rows);
}

// 1件取り込む。既に送った行なら null を返す（force のときは送り直す）
function takeMessage(node, kind, { receivedAt = null, useDomTimestamp = false, force = false } = {}) {
  // 取り込めたか読み取れなかったかは、この1か所で数える（重複判定より前）。
  // 既出で落ちたぶんまで「読み取れなかった」に混ぜると、再スキャンのたびに
  // セレクタが壊れたことになってしまう
  health.rows++;
  const msg = extractMessage(node, kind, useDomTimestamp, receivedAt);
  if (!msg) {
    noteUnreadable();
    return null;
  }
  noteExtracted();
  noteAvatar(node, msg);
  if (!force && seenIds.has(msg.id)) return null;
  seenIds.add(msg.id);
  trimOldest(seenIds, MAX_SEEN_IDS);
  return msg;
}

// === ステッカーの画像が生えるのを待つ待ち行列 ==============================
//
// 行がDOMに入った直後は、中の img がまだ無い（yt-img-shadow があとから作る）。
// ステッカーはその場で読むと画像URLもステッカー名（alt）も空になり、
// **名前は本文そのもの**なので、取り込みを待たせるだけの理由がある
// （IDも本文から作るため、あとから足すと別のコメントになってしまう）。
// 生えてこなくても打ち切って取り込む（画像なしで従来どおりの表示になる）。
// 待っている間に投稿時刻がずれないよう、受信時刻は行を見つけた時点のものを持ち回る。
//
// **アバターはここで待たない。** いつ生えるかは YouTube の都合（ビューポートに
// 入ってから読み込む）で上限が無く、待ち時間をいくつに決めても「待ちすぎ」か
// 「取りこぼし」のどちらかになる。取り込みから切り離して別便で追いかける
// （下の「アバターの拾い直し」）。
//
// 待ちは1本の列にまとめ、先頭から順に出す。行ごとに待たせると、あとから来た
// 行が待っている行を追い越し、popup の並びが前後する（popup は届いた順に積む）。
const PENDING_POLL_MS = 100;
const PENDING_MAX_POLLS = 15; // 最長で約1.5秒

const pendingRows = [];
let pendingPollScheduled = false;

// 打ち切りは回数と経過時間の両方で見る。背面タブのタイマーは間引かれる
// （1秒に1回、5分を超えると1分に1回）ので、回数だけだと打ち切りがそのぶん
// 後ろへ延びる。時間でも見ておけば、間引かれた1回で追い付ける
function pendingRow(node, kind, options) {
  return {
    node, kind, options,
    polls: PENDING_MAX_POLLS,
    deadline: Date.now() + PENDING_MAX_POLLS * PENDING_POLL_MS
  };
}

function isPendingRowExpired(row) {
  return row.polls <= 0 || Date.now() >= row.deadline;
}

// 行に要る画像が揃っているか。待つのはステッカーだけ（アバターは待たない）
function isRowReady({ node, kind }) {
  return kind !== 'supersticker' || isStickerImageReady(node);
}

function queueRows(rows) {
  for (const row of rows) pendingRows.push(row);
  flushPendingRows();
}

// 揃った行を先頭から順に取り込んで送る。まだ待っている行に当たったらそこで止める
// （後ろの行に追い越させない）
function flushPendingRows() {
  const messages = [];
  while (pendingRows.length > 0) {
    const row = pendingRows[0];
    if (!isRowReady(row) && !isPendingRowExpired(row)) break;
    pendingRows.shift();
    const msg = takeMessage(row.node, row.kind, row.options);
    if (msg) messages.push(msg);
  }
  if (messages.length > 0) sendMessages(messages);
  // 行が動いたこの瞬間は、ひとつ前の行のアバターが生えている頃合いでもある。
  // タイマー任せにしないぶん、背面タブでタイマーが間引かれても追い付ける
  harvestAvatars();
  schedulePendingPoll();
}

function schedulePendingPoll() {
  if (pendingPollScheduled || pendingRows.length === 0) return;
  pendingPollScheduled = true;
  setTimeout(() => {
    pendingPollScheduled = false;
    for (const row of pendingRows) row.polls--;
    flushPendingRows();
  }, PENDING_POLL_MS);
}

// === アバターの拾い直し ====================================================
//
// アバターの img は行と同時には生えない。yt-img-shadow がビューポートに入って
// から作るので、**いつ生えるかは YouTube の都合で上限が無い**。取り込みを
// それに待たせると、待ち時間をいくつに決めても「待ちすぎ（コメントが遅れる）」か
// 「取りこぼし（頭文字のまま）」のどちらかになる。実際 0.5秒 待っても半分は
// 間に合わなかった。
//
// そこで取り込みは待たせず、アバターだけを別便で追いかける。追いかける単位は
// **発言者**（保存も popup の表示も「発言者名 -> URL」のマップが正なので、
// 1人ぶん取れれば、その人の過去の行も表示側で埋まる）。
//
// 行がチャットから流れ去ったら諦める（その行からはもう取れない）。
// 生えないまま居座る行のために回数の上限も置く。どちらで諦めても、
// 同じ人が次に喋れば新しい行でまた追いかけ直す（取り込みは止めていないので、
// ここで諦めても消えるのは「その人の丸い画像」だけ）。
const MAX_PENDING_AVATARS = 200;  // 追いかけ中の発言者。行と一緒に消えるので溜まらない
const MAX_KNOWN_AVATARS = 500;    // 送り終えた発言者。store の bulk 枠に合わせる
const AVATAR_HARVEST_MS = 1000;
const AVATAR_HARVEST_ROUNDS = 30; // 見に行くのは1人あたり30回まで（約30秒）

// displayName -> { node, role, kind }。まだURLを取れていない発言者
const pendingAvatars = new Map();
// 送り終えた発言者。同じものを何度も送らないための控え
const knownAvatars = new Set();
let avatarHarvestScheduled = false;

// 取り込んだ行を追いかけ対象に入れる。URLがその場で取れているものは
// コメントに載って一緒に届くので、ここでは何もしない
function noteAvatar(node, msg) {
  if (!msg.displayName || msg.avatarUrl || knownAvatars.has(msg.displayName)) return;
  pendingAvatars.delete(msg.displayName); // 入れ直して新しい行のほうを見る
  pendingAvatars.set(msg.displayName, {
    node, role: msg.role, kind: msg.kind || 'text', rounds: AVATAR_HARVEST_ROUNDS
  });
  trimOldest(pendingAvatars, MAX_PENDING_AVATARS);
  scheduleAvatarHarvest();
}

// 追いかけ中の行をもう一度読む。生えていたら送り、流れ去っていたら諦める
function harvestAvatars() {
  if (pendingAvatars.size === 0) return;
  const found = [];
  for (const [displayName, entry] of pendingAvatars) {
    const avatarUrl = extractAvatarUrl(entry.node);
    if (avatarUrl) {
      pendingAvatars.delete(displayName);
      rememberAvatar(displayName);
      // 枠（primary / bulk）の判定は Service Worker の bucketOf が正なので、
      // その材料になる役割・種別だけを一緒に送る
      found.push({ displayName, avatarUrl, role: entry.role, kind: entry.kind });
      continue;
    }
    if (!document.contains(entry.node)) pendingAvatars.delete(displayName);
  }
  if (found.length > 0) sendAvatars(found);
  scheduleAvatarHarvest();
}

// 定期の見に行き。新しい行が来ないまま生えることもあるので、行の動きとは別に回す。
// 回数を数えるのはこちらだけ（行が流れるたびの拾い直しで数えると、
// チャットの流量で諦めの早さが変わってしまう）
function scheduleAvatarHarvest() {
  if (avatarHarvestScheduled || pendingAvatars.size === 0) return;
  avatarHarvestScheduled = true;
  setTimeout(() => {
    avatarHarvestScheduled = false;
    for (const [displayName, entry] of pendingAvatars) {
      if (--entry.rounds <= 0) pendingAvatars.delete(displayName);
    }
    harvestAvatars();
  }, AVATAR_HARVEST_MS);
}

function rememberAvatar(displayName) {
  knownAvatars.add(displayName);
  trimOldest(knownAvatars, MAX_KNOWN_AVATARS);
}

function extractMessage(el, kind, useDomTimestamp = false, receivedAt = null) {
  const displayName = textOf(el.querySelector(SELECTORS.authorName));
  if (!displayName) return null;

  // 本文の在り処は種別ごとに違う。読めない形なら取り込まない
  const detail = extractDetail(el, kind);
  if (!detail) return null;

  const avatarUrl = extractAvatarUrl(el);
  const role = roleOf(el, kind);

  const timestampText = textOf(el.querySelector(SELECTORS.timestamp));
  const { id, legacyId } = messageIdFor(el, kind, displayName, detail, timestampText);

  // 新着は受信時刻がそのまま投稿時刻。過去分だけDOMの時刻表示（分単位）で補う
  const domDate = useDomTimestamp ? parseTimestampText(timestampText) : null;
  const publishedAt = (domDate || receivedAt || new Date()).toISOString();

  const result = {
    id,
    // 更新前に保存された履歴と突き合わせるための旧形式のID。
    // background 側が重複判定に使ったあと捨てる（保存はされない）
    legacyId,
    role,
    displayName,
    message: detail.message,
    publishedAt,
    avatarUrl
  };

  // 種別の情報は通常のコメントには載せない。1件あたり数十バイトでも
  // 2000件×動画数ぶん積み上がり、ストレージ上限に当たると監視ごと止まる。
  // 受け取り側は kind が無いものをテキストコメントとして扱う
  if (kind !== 'text') {
    result.kind = kind;
    if (detail.amountText) result.amountText = detail.amountText;
    if (detail.eventText) result.eventText = detail.eventText;
    // ステッカーの画像URL。IDの元になるキーには混ぜない（混ぜると更新前後で
    // 同じステッカーに違うIDが振られ、保存済み履歴と重複する）
    if (detail.stickerUrl) result.stickerUrl = detail.stickerUrl;
  }

  // 絵文字の対応表（名前 → 画像URL）。通常のコメントにも付く（本文に混ざるのはこちらが主）。
  // 使われていない行には生やさない —— 1件あたりのバイト数が全件ぶん積み上がるため。
  // ステッカーと同じく、IDの元になるキーには混ぜない
  if (detail.emojis) result.emojis = detail.emojis;

  return result;
}

// 本文・金額・イベント文言の取り出し
function extractDetail(el, kind) {
  const messageEl = el.querySelector(SELECTORS.message);
  // 本文と、そこに混ざっていた絵文字（名前 → 画像URL）
  const { text: message, emojis } = extractMessageContent(messageEl);

  if (kind === 'text') {
    // 本文の器そのものが無い＝想定外の形なので取り込まない（従来どおり）
    return messageEl ? { message, emojis, amountText: null, eventText: null } : null;
  }

  if (kind === 'superchat') {
    // 金額だけで本文なしのスパチャも普通にある
    return { message, emojis, amountText: extractAmount(el), eventText: null };
  }

  if (kind === 'supersticker') {
    // ステッカーは画像のみ。alt にステッカー名が入る
    const img = stickerImgOf(el);
    const alt = img?.getAttribute('alt')?.trim() || '';
    return {
      message: alt,
      amountText: extractAmount(el),
      eventText: 'スーパーステッカー',
      stickerUrl: extractStickerUrl(img)
    };
  }

  if (kind === 'membership') {
    // 新規加入は #header-subtext だけ、継続（マイルストーン）は #header-primary-text に
    // 「◯か月連続」が入り、本人のコメントが #message に付くことがある
    const primary = textOf(el.querySelector(SELECTORS.membershipPrimaryText));
    const subtext = textOf(el.querySelector(SELECTORS.membershipSubtext));
    const eventText = [primary, subtext].filter(Boolean).join(' · ');
    if (!eventText && !message) return null;
    return { message, emojis, amountText: null, eventText };
  }

  // gift:「◯◯さんがメンバーシップギフトを贈りました」の一文が本体
  const eventText = textOf(el.querySelector(SELECTORS.giftPrimaryText));
  if (!eventText) return null;
  return { message: '', amountText: null, eventText };
}

// ステッカー画像は yt-img-shadow の中の img。行がDOMに入った直後は
// この img ごと存在しないので、読む前に生えているかを確かめる
function stickerImgOf(el) {
  return el.querySelector(SELECTORS.stickerImage);
}

function isStickerImageReady(el) {
  return !!stickerImgOf(el)?.getAttribute('src');
}

// ステッカー画像のURL。表示は96pxなので、高DPIでも滲まないよう2倍で要求する。
// 中身はアニメーションWebPなので、受け取り側は img に貼るだけで動く。
// src はプロトコル相対（//lh3...）で入っているため、絶対URLに解決される
// .src から取る（getAttribute だと https チェックで弾かれる）
const STICKER_IMAGE_HOSTS = ['lh3.googleusercontent.com', 'yt3.ggpht.com'];
const STICKER_IMAGE_SIZE = '=s192-rwa';

function extractStickerUrl(img) {
  if (!img?.src) return null;
  let url;
  try {
    url = new URL(img.src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!STICKER_IMAGE_HOSTS.includes(url.hostname)) return null;
  // パスは「/<ID>=s40-rp」の形。ID部分に = は入らないので、最初の = 以降を捨てて付け直す
  return `${url.origin}${url.pathname.split('=')[0]}${STICKER_IMAGE_SIZE}`;
}

// 絵文字の画像URL。表示は24pxなので、ステッカーと同じ考えで2倍を要求する。
//
// メンバー限定絵文字はチャンネルの画像置き場（*.ggpht.com / *.googleusercontent.com）、
// YouTube標準の絵文字は youtube.com の静的ファイル。後者はサイズ指定を受け付けないので
// パスをそのまま使う。ホストはアバターと同じく末尾一致で見る（yt3 / yt4 のような
// 番号違いが実際にある）
const EMOJI_IMAGE_HOST_SUFFIXES = ['.ggpht.com', '.googleusercontent.com'];
const EMOJI_STATIC_HOST = 'www.youtube.com';
const EMOJI_IMAGE_SIZE = '=w48-h48-c-k-nd';

// 通さなかったホストを1回だけ知らせる。ここで落ちると画面には名前の文字が出るだけで、
// 「YouTubeが別の置き場に移した」のか「絵文字ではない画像だった」のか見分けが付かない
const warnedEmojiHosts = new Set();

function extractEmojiUrl(img) {
  if (!img?.src) return null;
  let url;
  try {
    url = new URL(img.src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  if (url.hostname === EMOJI_STATIC_HOST) {
    // 静的ファイルの置き場だけを通す（/s/gaming/emoji/... など）
    return url.pathname.startsWith('/s/') ? `${url.origin}${url.pathname}` : null;
  }
  if (EMOJI_IMAGE_HOST_SUFFIXES.some(suffix => url.hostname.endsWith(suffix))) {
    // ステッカーと同じ「/<ID>=<サイズ>」の形
    return `${url.origin}${url.pathname.split('=')[0]}${EMOJI_IMAGE_SIZE}`;
  }

  if (!warnedEmojiHosts.has(url.hostname)) {
    warnedEmojiHosts.add(url.hostname);
    console.warn('[YouTube Special Comments] 未知の絵文字の配信元:', url.hostname);
  }
  return null;
}

// 「¥500」「$5.00」などの金額表記。DOM変更で別物を拾ったときのために長さで足切りする
function extractAmount(el) {
  const amount = textOf(el.querySelector(SELECTORS.purchaseAmount) ||
                        el.querySelector(SELECTORS.purchaseAmountChip));
  return amount && amount.length <= 24 ? amount : null;
}

// 発言者の役割。有料メッセージやメンバーイベントの行には author-type が
// 付かないことがあるので、バッジと種別からも補う
function roleOf(el, kind) {
  const authorType = el.getAttribute(AUTHOR_TYPE_ATTR) || '';
  if (authorType === 'owner') return 'owner';
  if (authorType === 'moderator') return 'moderator';
  if (authorType === 'member') return 'member';

  if (el.querySelector(SELECTORS.moderatorBadge)) return 'moderator';
  if (el.querySelector(SELECTORS.memberBadge)) return 'member';
  // 加入・ギフトのイベントは発言者が必ずメンバー
  if (kind === 'membership' || kind === 'gift') return 'member';
  return 'normal';
}

// IDは「同じコメントなら再スキャンでもリロード後でも同じ値」であることが条件。
// 位置ではなく内容＋出現回数から作るので、DOMの間引きで値がずれない。
// 新旧2つのIDを返す。旧形式は、更新前に保存された履歴との突き合わせにだけ使う
function messageIdFor(el, kind, displayName, detail, timestampText) {
  const cached = idByElement.get(el);
  if (cached) return cached;

  // キーの作り方は旧版と同じ（shared/comment.js に移した）。形が同じなので
  // 旧形式のIDをそのまま計算し直せる
  const key = commentKeyOf(kind, displayName, detail, timestampText);

  const occurrence = occurrenceByKey.get(key) || 0;
  // 同じキーを引くたびに末尾へ入れ直す。挿入順のままだと、連投され続けている
  // キーが「いちばん古い」ままになり、まだ現役なのに間引かれてしまう
  occurrenceByKey.delete(key);
  occurrenceByKey.set(key, occurrence + 1);
  trimOldest(occurrenceByKey, MAX_OCCURRENCE_KEYS);

  const ids = {
    id: commentIdFor(key, occurrence),
    legacyId: legacyCommentIdFor(key, occurrence)
  };
  idByElement.set(el, ids);
  return ids;
}

// ライブチャットの時刻表示（「22:53」「10:53 PM」「午後10:53」）を Date にする。
// 表示OFFなどで読めない形式は null を返し、呼び出し側で現在時刻にフォールバックする
function parseTimestampText(text) {
  if (!text) return null;
  const m = text.match(/^(?:(午前|午後)\s*)?(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!m) return null;

  let hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (minutes > 59) return null;

  const marker = m[1] || m[4];
  if (marker) {
    if (hours < 1 || hours > 12) return null;
    const isPm = marker === '午後' || marker.toUpperCase() === 'PM';
    hours = (hours % 12) + (isPm ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }

  const now = new Date();
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  // 未来の時刻になったら日跨ぎ配信の前日分とみなす
  if (date.getTime() > now.getTime() + 60 * 1000) date.setDate(date.getDate() - 1);
  return date;
}

// アバター画像のURL。取れなくても null を返すだけでコメント取得は止めない。
//
// src はプロトコル相対（//lh3...）で入っていることがあるので、絶対URLに解決済みの
// .src から取る（getAttribute だと属性値そのままなので https チェックで弾かれ、
// アバターだけが黙って落ちる）。ステッカー側は同じ罠を先に回避していたのに、
// こちらに反映されていなかった（#28）
function extractAvatarUrl(el) {
  const img = avatarImgOf(el);
  if (!img?.src) return null;
  // YouTubeのDOM由来＝外部入力。javascript: や data: を弾く
  // （配信ホストの確認は popup 側の AVATAR_IMAGE_HOSTS が担当する。#26）
  let url;
  try {
    url = new URL(img.src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // 末尾の "=s32-..." はサイズ指定。高DPI向けに2倍で要求する
  return url.href.replace(/=s\d+-/, '=s64-');
}

// アバターの img。有料メッセージの行は器が違うので id だけで拾い直すが、
// そちらは行の中の別の画像（ステッカー）にも当たる。ステッカーの img を
// アバターとして返すと、スパチャの行に自分の投げたステッカーが顔として並ぶので外す
function avatarImgOf(el) {
  const img = el.querySelector(SELECTORS.authorPhoto);
  if (img) return img;
  const fallback = el.querySelector(SELECTORS.authorPhotoFallback);
  return fallback && fallback !== stickerImgOf(el) ? fallback : null;
}

function textOf(el) {
  return el?.textContent?.trim() || '';
}

// 本文（#message）の中身。文字とインライン画像が混ざっているので、
// 表示に使う文字列と、画像として出せる絵文字を1回の走査で取り出す。
//
// 絵文字は img で入っていて、文字としては alt しか残らない。
// メンバー限定絵文字・YouTube標準の絵文字の alt は名前（「2BROOtojya」
// 「eyes-pink-heart-shape」「:_hearts:」など、形はまちまち）なので、そのまま出すと
// 本文に名前が並ぶ。画像URLを別に持たせて、表示側で画像に戻す。
// Unicode の絵文字も img で来るが、alt が絵文字そのものなので対応表には載せない
// （見分け方は shared/comment.js の isEmojiLabel()）
function extractMessageContent(el) {
  if (!el) return { text: '', emojis: null };
  let text = '';
  // 名前は外から来る文字列なので、素のオブジェクトに直接代入しない
  // （'__proto__' が来ると代入がプロトタイプへ流れる）
  const emojis = new Map();
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
      continue;
    }
    if (node.tagName !== 'IMG') {
      text += node.textContent;
      continue;
    }
    // 本文の文字列は従来どおり alt をそのまま足す。ここに手を入れるとIDが変わる
    const alt = node.getAttribute('alt') || '';
    text += alt;
    if (!isEmojiLabel(alt) || emojis.has(alt)) continue;
    const url = extractEmojiUrl(node);
    if (url) emojis.set(alt, url);
  }
  return {
    text: text.trim(),
    emojis: emojis.size > 0 ? Object.fromEntries(emojis) : null
  };
}

// Service Worker への片道の送信。コメントもヘルスもここを通る
function sendToBackground(payload, retries = 3) {
  try {
    chrome.runtime.sendMessage(payload, () => {
      if (chrome.runtime.lastError && retries > 0) {
        setTimeout(() => sendToBackground(payload, retries - 1), 1000);
      }
    });
  } catch {
    // Extension context invalidated（拡張機能再読み込み直後）は無視
  }
}

function sendMessages(messages) {
  // コメントに載って届いたぶんは、追いかけ対象から外す
  for (const msg of messages) {
    if (!msg.avatarUrl || !msg.displayName) continue;
    pendingAvatars.delete(msg.displayName);
    rememberAvatar(msg.displayName);
  }
  sendToBackground({ action: 'domChatMessages', messages });
}

// あとから生えたアバターだけの便。コメントとは別便で、遅れて届いても
// popup が発言者ごとに行を埋め直す
function sendAvatars(avatars) {
  sendToBackground({ action: 'domChatAvatars', avatars });
}

// === YouTube 側のクリックで popup を絞り込む ================================
//
// チャットの名前・アイコンの**素のクリックは YouTube 自身が使っている**
// （「ブロック」「報告」のメニューが開く）。奪うと本体の機能が壊れるので、
// こちらが受け取るのは修飾キー付きのクリックだけにして、そのときだけ
// YouTube へ渡さない（捕捉フェーズで止める）。
//
// 送るのは「誰を選んだか」1つだけ。popup を開くのも、絞り込みを当てるのも
// Service Worker と popup の側の仕事（ツールバーの popup は、ページを
// クリックした時点でもう閉じているため、ここから直接は触れない）
const USER_FILTER_MODIFIER = 'altKey';

function onAuthorClick(event) {
  // 素のクリックには触れない。YouTube のメニューはこれまで通り開く
  if (!event[USER_FILTER_MODIFIER]) return;
  const target = event.target?.closest?.(SELECTORS.authorClickTarget);
  if (!target) return;
  const row = target.closest(ROW_SELECTOR);
  if (!row) return;

  // 表示名は取り込みと同じ経路（#author-name のテキスト）で読む。
  // ここだけ別の読み方をすると、popup 側の突き合わせ（displayName の一致）が
  // 無言で外れて「0件」になる
  const displayName = textOf(row.querySelector(SELECTORS.authorName));
  if (!displayName) return;

  event.preventDefault();
  event.stopPropagation();
  sendToBackground({ action: 'openUserFilter', displayName });
}

document.addEventListener('click', onAuthorClick, true);

attachObserver();
} // end guard
