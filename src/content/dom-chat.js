// 二重注入防止
if (window.__domChatInitialized) { /* noop */ } else {
window.__domChatInitialized = true;

const seenIds = new Set();

// 要素→ID。同じ要素には常に同じIDを振り、再スキャンで重複を作らないようにする
const idByElement = new WeakMap();
// 同一内容・同一時刻のコメントを区別するための連番（キーごとの出現回数）
const occurrenceByKey = new Map();

// 監視対象のチャット行。スーパーチャットやメンバーシップのイベントは
// テキストコメントとは別のタグで流れてくるため、タグ名から種別を引く
const KIND_BY_TAG = {
  'yt-live-chat-text-message-renderer': 'text',
  'yt-live-chat-paid-message-renderer': 'superchat',
  'yt-live-chat-paid-sticker-renderer': 'supersticker',
  'yt-live-chat-membership-item-renderer': 'membership',
  'yt-live-chat-sponsorships-gift-purchase-announcement-renderer': 'gift'
};

function kindOf(node) {
  return KIND_BY_TAG[node.tagName?.toLowerCase()] || null;
}

// 監視開始前のコメントも拾えるよう、既にDOMにある分を全件送り直す。
// 送信済みかどうかは background 側がIDで弾くため、force でも重複はしない。
function doInitialSweep(force = false) {
  const itemList = document.querySelector('yt-live-chat-item-list-renderer #items');
  if (!itemList) return;
  const existingMessages = [];
  for (const node of itemList.children) {
    const kind = kindOf(node);
    if (!kind) continue;
    // 過去分は投稿時刻が「今」ではないので、DOMのタイムスタンプがあればそれを使う
    const msg = extractMessage(node, kind, true);
    if (msg && (force || !seenIds.has(msg.id))) {
      seenIds.add(msg.id);
      existingMessages.push(msg);
    }
  }
  if (existingMessages.length > 0) sendMessages(existingMessages);
}

function attachObserver() {
  const itemList = document.querySelector('yt-live-chat-item-list-renderer #items');
  if (!itemList) { setTimeout(attachObserver, 500); return; }

  doInitialSweep();
  new MutationObserver(handleMutations).observe(itemList, { childList: true });
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'requestInitialSweep') doInitialSweep(request.force === true);
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
        waitForStickerImage(node, new Date());
        continue;
      }

      const msg = takeMessage(node, kind);
      if (msg) messages.push(msg);
    }
  }
  if (messages.length > 0) sendMessages(messages);
}

// 新着1件を取り込む。既に送った行なら null を返す
function takeMessage(node, kind, receivedAt = null) {
  const msg = extractMessage(node, kind, false, receivedAt);
  if (!msg || seenIds.has(msg.id)) return null;
  if (seenIds.size > 2000) seenIds.clear();
  seenIds.add(msg.id);
  return msg;
}

// ステッカーの画像が生えるのを待って取り込む。待っている間に投稿時刻が
// ずれないよう、受信時刻は行を見つけた時点のものを持ち回る。
// 生えてこなくても打ち切って取り込む（画像なしで従来どおりの表示になる）
const STICKER_IMAGE_POLL_MS = 100;
const STICKER_IMAGE_MAX_POLLS = 15; // 最長で約1.5秒

function waitForStickerImage(node, receivedAt, remaining = STICKER_IMAGE_MAX_POLLS) {
  if (remaining > 0 && !isStickerImageReady(node)) {
    setTimeout(() => waitForStickerImage(node, receivedAt, remaining - 1), STICKER_IMAGE_POLL_MS);
    return;
  }
  const msg = takeMessage(node, 'supersticker', receivedAt);
  if (msg) sendMessages([msg]);
}

function extractMessage(el, kind, useDomTimestamp = false, receivedAt = null) {
  const displayName = textOf(el.querySelector('#author-name'));
  if (!displayName) return null;

  // 本文の在り処は種別ごとに違う。読めない形なら取り込まない
  const detail = extractDetail(el, kind);
  if (!detail) return null;

  const avatarUrl = extractAvatarUrl(el);
  const role = roleOf(el, kind);

  const timestampText = textOf(el.querySelector('#timestamp'));
  const id = messageIdFor(el, kind, displayName, detail, timestampText);

  // 新着は受信時刻がそのまま投稿時刻。過去分だけDOMの時刻表示（分単位）で補う
  const domDate = useDomTimestamp ? parseTimestampText(timestampText) : null;
  const publishedAt = (domDate || receivedAt || new Date()).toISOString();

  const result = {
    id,
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
  const messageEl = el.querySelector('#message');
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
    const primary = textOf(el.querySelector('#header-primary-text'));
    const subtext = textOf(el.querySelector('#header-subtext'));
    const eventText = [primary, subtext].filter(Boolean).join(' · ');
    if (!eventText && !message) return null;
    return { message, amountText: null, eventText };
  }

  // gift:「◯◯さんがメンバーシップギフトを贈りました」の一文が本体
  const eventText = textOf(el.querySelector('#primary-text'));
  if (!eventText) return null;
  return { message: '', amountText: null, eventText };
}

// ステッカー画像は yt-img-shadow の中の img。行がDOMに入った直後は
// この img ごと存在しないので、読む前に生えているかを確かめる
function stickerImgOf(el) {
  return el.querySelector('#sticker img');
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
  const amount = textOf(el.querySelector('#purchase-amount') ||
                        el.querySelector('#purchase-amount-chip'));
  return amount && amount.length <= 24 ? amount : null;
}

// 発言者の役割。有料メッセージやメンバーイベントの行には author-type が
// 付かないことがあるので、バッジと種別からも補う
function roleOf(el, kind) {
  const authorType = el.getAttribute('author-type') || '';
  if (authorType === 'owner') return 'owner';
  if (authorType === 'moderator') return 'moderator';
  if (authorType === 'member') return 'member';

  if (el.querySelector('yt-live-chat-author-badge-renderer[type="moderator"]')) return 'moderator';
  if (el.querySelector('yt-live-chat-author-badge-renderer[type="member"]')) return 'member';
  // 加入・ギフトのイベントは発言者が必ずメンバー
  if (kind === 'membership' || kind === 'gift') return 'member';
  return 'normal';
}

// IDは「同じコメントなら再スキャンでもリロード後でも同じ値」であることが条件。
// 位置ではなく内容＋出現回数から作るので、DOMの間引きで値がずれない。
function messageIdFor(el, kind, displayName, detail, timestampText) {
  const cached = idByElement.get(el);
  if (cached) return cached;

  // テキストコメントのキーは旧版と同じ形のまま保つ。拡張機能を更新しても
  // 同じコメントには同じIDが振られ、保存済み履歴と重複しない
  let key = `${displayName}\u0000${detail.message}\u0000${timestampText}`;
  if (kind !== 'text') {
    // 本文なしのスパチャは金額しか違いが無いので、キーに混ぜて衝突を避ける
    key += `\u0000${kind}\u0000${detail.amountText || ''}\u0000${detail.eventText || ''}`;
  }

  // 整数ハッシュでID生成（btoa のマルチバイト問題を回避）
  const hash = key.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
  const occurrence = occurrenceByKey.get(key) || 0;
  occurrenceByKey.set(key, occurrence + 1);
  if (occurrenceByKey.size > 5000) occurrenceByKey.clear();

  const id = `dom_${hash}_${occurrence}`;
  idByElement.set(el, id);
  return id;
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

// アバター画像のURL。取れなくても null を返すだけでコメント取得は止めない
function extractAvatarUrl(el) {
  const img = el.querySelector('#author-photo img') || el.querySelector('img#img');
  const src = img?.getAttribute('src') || '';
  // YouTubeのDOM由来＝外部入力。javascript: や data: を弾く
  if (!src.startsWith('https://')) return null;
  // 末尾の "=s32-..." はサイズ指定。高DPI向けに2倍で要求する
  return src.replace(/=s\d+-/, '=s64-');
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

function sendMessages(messages, retries = 3) {
  try {
    chrome.runtime.sendMessage({ action: 'domChatMessages', messages }, () => {
      if (chrome.runtime.lastError && retries > 0) {
        setTimeout(() => sendMessages(messages, retries - 1), 1000);
      }
    });
  } catch (e) {
    // Extension context invalidated（拡張機能再読み込み直後）は無視
  }
}

attachObserver();
} // end guard
