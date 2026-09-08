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
const { commentKeyOf, commentIdFor, legacyCommentIdFor } = self.YTF;

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
  moderatorBadge: 'yt-live-chat-author-badge-renderer[type="moderator"]',
  memberBadge: 'yt-live-chat-author-badge-renderer[type="member"]'
};

// 行に付く属性も YouTube 由来。roleOf が読む
const AUTHOR_TYPE_ATTR = 'author-type';

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
  const existingMessages = [];
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
    // ステッカーはチャットを開いた直後だと画像がまだ読み込まれていないことがあるので、
    // 新着と同じく生えるまで待つ
    if (kind === 'supersticker' && !isStickerImageReady(node)) {
      waitForStickerImage(node, { useDomTimestamp: true, force });
      continue;
    }

    const msg = takeMessage(node, kind, { useDomTimestamp: true, force });
    if (msg) existingMessages.push(msg);
  }
  if (knownRows === 0 && totalRows >= UNKNOWN_ROW_LIMIT) setHealthState(HEALTH.UNREADABLE);
  if (existingMessages.length > 0) sendMessages(existingMessages);
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
  const messages = [];
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      const kind = kindOf(node);
      if (!kind) continue;

      // ステッカーの画像は行がDOMに入った直後にはまだ無い。yt-img-shadow が
      // あとから img を作るため、その場で読むと画像もステッカー名（alt）も空になる。
      // 生えるまで待ってから取り込む
      if (kind === 'supersticker' && !isStickerImageReady(node)) {
        waitForStickerImage(node, { receivedAt: new Date() });
        continue;
      }

      const msg = takeMessage(node, kind);
      if (msg) messages.push(msg);
    }
  }
  if (messages.length > 0) sendMessages(messages);
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
  if (!force && seenIds.has(msg.id)) return null;
  seenIds.add(msg.id);
  trimOldest(seenIds, MAX_SEEN_IDS);
  return msg;
}

// ステッカーの画像が生えるのを待って取り込む。待っている間に投稿時刻が
// ずれないよう、受信時刻は行を見つけた時点のものを持ち回る。
// 生えてこなくても打ち切って取り込む（画像なしで従来どおりの表示になる）
const STICKER_IMAGE_POLL_MS = 100;
const STICKER_IMAGE_MAX_POLLS = 15; // 最長で約1.5秒

function waitForStickerImage(node, options, remaining = STICKER_IMAGE_MAX_POLLS) {
  if (remaining > 0 && !isStickerImageReady(node)) {
    setTimeout(() => waitForStickerImage(node, options, remaining - 1), STICKER_IMAGE_POLL_MS);
    return;
  }
  const msg = takeMessage(node, 'supersticker', options);
  if (msg) sendMessages([msg]);
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

  return result;
}

// 本文・金額・イベント文言の取り出し
function extractDetail(el, kind) {
  const messageEl = el.querySelector(SELECTORS.message);
  const message = extractText(messageEl);

  if (kind === 'text') {
    // 本文の器そのものが無い＝想定外の形なので取り込まない（従来どおり）
    return messageEl ? { message, amountText: null, eventText: null } : null;
  }

  if (kind === 'superchat') {
    // 金額だけで本文なしのスパチャも普通にある
    return { message, amountText: extractAmount(el), eventText: null };
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
    return { message, amountText: null, eventText };
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
  const img = el.querySelector(SELECTORS.authorPhoto) ||
              el.querySelector(SELECTORS.authorPhotoFallback);
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

function textOf(el) {
  return el?.textContent?.trim() || '';
}

function extractText(el) {
  if (!el) return '';
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    else if (node.tagName === 'IMG') text += node.getAttribute('alt') || '';
    else text += node.textContent;
  }
  return text.trim();
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
  sendToBackground({ action: 'domChatMessages', messages });
}

attachObserver();
} // end guard
