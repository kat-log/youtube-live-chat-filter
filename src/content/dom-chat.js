// 二重注入防止
if (window.__domChatInitialized) { /* noop */ } else {
window.__domChatInitialized = true;

const seenIds = new Set();

function attachObserver() {
  const itemList = document.querySelector('yt-live-chat-item-list-renderer #items');
  if (!itemList) { setTimeout(attachObserver, 500); return; }
  new MutationObserver(handleMutations).observe(itemList, { childList: true });
}

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

function extractMessage(el) {
  const authorEl = el.querySelector('#author-name');
  const messageEl = el.querySelector('#message');
  if (!authorEl || !messageEl) return null;

  const displayName = authorEl.textContent.trim();
  const message = extractText(messageEl);
  const authorType = el.getAttribute('author-type') || '';
  const role = authorType === 'owner' ? 'owner'
             : authorType === 'moderator' ? 'moderator'
             : authorType === 'member' ? 'member' : 'normal';

  // 整数ハッシュで ID 生成（btoa のマルチバイト問題を回避）
  const raw = displayName + message;
  const hash = raw.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
  const pos = Array.from(el.parentNode?.children || []).indexOf(el);
  const id = `dom_${hash}_${pos}`;

  return { id, role, displayName, message, publishedAt: new Date().toISOString() };
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
  chrome.runtime.sendMessage({ action: 'domChatMessages', messages }, () => {
    if (chrome.runtime.lastError && retries > 0) {
      setTimeout(() => sendMessages(messages, retries - 1), 1000);
    }
  });
}

attachObserver();
} // end guard
