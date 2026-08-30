// 二重注入防止
if (window.__domChatInitialized) { /* noop */ } else {
window.__domChatInitialized = true;

const seenIds = new Set();

// 要素→ID。同じ要素には常に同じIDを振り、再スキャンで重複を作らないようにする
const idByElement = new WeakMap();
// 同一内容・同一時刻のコメントを区別するための連番（キーごとの出現回数）
const occurrenceByKey = new Map();

// 監視開始前のコメントも拾えるよう、既にDOMにある分を全件送り直す。
// 送信済みかどうかは background 側がIDで弾くため、force でも重複はしない。
function doInitialSweep(force = false) {
  const itemList = document.querySelector('yt-live-chat-item-list-renderer #items');
  if (!itemList) return;
  const existingMessages = [];
  for (const node of itemList.children) {
    if (node.tagName?.toLowerCase() === 'yt-live-chat-text-message-renderer') {
      // 過去分は投稿時刻が「今」ではないので、DOMのタイムスタンプがあればそれを使う
      const msg = extractMessage(node, true);
      if (msg && (force || !seenIds.has(msg.id))) {
        seenIds.add(msg.id);
        existingMessages.push(msg);
      }
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
      if (node.tagName?.toLowerCase() === 'yt-live-chat-text-message-renderer') {
        const msg = extractMessage(node);
        if (msg && !seenIds.has(msg.id)) {
          if (seenIds.size > 2000) seenIds.clear();
          seenIds.add(msg.id);
          messages.push(msg);
        }
      }
    }
  }
  if (messages.length > 0) sendMessages(messages);
}

function extractMessage(el, useDomTimestamp = false) {
  const authorEl = el.querySelector('#author-name');
  const messageEl = el.querySelector('#message');
  if (!authorEl || !messageEl) return null;

  const displayName = authorEl.textContent.trim();
  const message = extractText(messageEl);
  const avatarUrl = extractAvatarUrl(el);
  const authorType = el.getAttribute('author-type') || '';
  const role = authorType === 'owner' ? 'owner'
             : authorType === 'moderator' ? 'moderator'
             : authorType === 'member' ? 'member' : 'normal';

  const timestampText = el.querySelector('#timestamp')?.textContent?.trim() || '';
  const id = messageIdFor(el, displayName, message, timestampText);

  // 新着は受信時刻がそのまま投稿時刻。過去分だけDOMの時刻表示（分単位）で補う
  const domDate = useDomTimestamp ? parseTimestampText(timestampText) : null;
  const publishedAt = (domDate || new Date()).toISOString();

  return { id, role, displayName, message, publishedAt, avatarUrl };
}

// IDは「同じコメントなら再スキャンでもリロード後でも同じ値」であることが条件。
// 位置ではなく内容＋出現回数から作るので、DOMの間引きで値がずれない。
function messageIdFor(el, displayName, message, timestampText) {
  const cached = idByElement.get(el);
  if (cached) return cached;

  const key = `${displayName}\u0000${message}\u0000${timestampText}`;
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

function extractText(el) {
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
