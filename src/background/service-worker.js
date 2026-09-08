// コメントの型と正規化は shared/comment.js に、履歴の保存は shared/store.js に
// 集約している（再設計の決定7と決定2）。importScripts は同期的に走るので、
// この直後から self.YTF / self.YTFStore を参照してよい。
// store.js は bucket の判定で YTF を使うので、comment.js より後に読むこと
importScripts('../shared/comment.js', '../shared/store.js');

// isCommentEnabled はここには無い。取り込みは全件で、役割・種別の絞り込みは
// 表示側（popup）の担当になった（再設計の決定1）
const {
  normalizeCommentFilters,
  isDisplayableKind,
  bucketOf,
  apiCommentKind,
  apiCommentRole,
  stripHtmlTags
} = self.YTF;

// コメント履歴の唯一の保存先（IndexedDB）。上限も枠の分け方もこの中にある
const store = self.YTFStore;
const { MAX_HISTORY_VIDEOS, AVATAR_LIMITS } = store;

// デバッグモードによる統一ログ関数
let debugMode = false;

// デバッグモード設定を取得
async function loadDebugMode() {
  try {
    const result = await chrome.storage.local.get(['debugMode']);
    debugMode = result.debugMode || false;
  } catch (error) {
    // ここだけは常に表示（設定読み込み失敗は重要）
    console.error('[Background] Failed to load debug mode:', error);
  }
}

// デバッグ用ログ関数
function debugLog(prefix, ...args) {
  if (debugMode) {
    console.log(prefix, ...args);
  }
}

function debugWarn(prefix, ...args) {
  if (debugMode) {
    console.warn(prefix, ...args);
  }
}

// エラーだけは debugMode に関係なく必ず出す。
// 「数時間使い込まないと出ない」種類の不具合を追うのに、既定でエラーが
// 消えているのがいちばん困る（既定構成では debugMode を ON にする手段も無かった）
function debugError(prefix, ...args) {
  console.error(prefix, ...args);
}

// 初期化時にデバッグモードを読み込み
loadDebugMode();

// エラー解決データベース
const ERROR_SOLUTIONS = {
  // APIキー関連エラー
  'API key not valid': {
    title: 'APIキーが無効です',
    message: 'YouTube Data API v3のAPIキーが正しくありません',
    solution: 'Google Cloud ConsoleでAPIキーを確認し、YouTube Data API v3が有効になっていることを確認してください',
    action: 'checkApiKey',
    severity: 'high'
  },
  'API key not found': {
    title: 'APIキーが設定されていません',
    message: 'YouTube Data API v3のAPIキーが設定されていません',
    solution: 'オプション画面を開いてAPIキーを設定してください',
    action: 'setApiKey',
    severity: 'high'
  },
  
  // YouTube API制限エラー
  'quotaExceeded': {
    title: 'API使用量制限に達しました',
    message: '1日のYouTube Data API使用量制限に達しました（1日10,000リクエスト制限）',
    solution: '明日の00:00（太平洋標準時）にリセットされます。今すぐ使いたい場合はGoogle Cloud Consoleで制限を増やしてください',
    action: 'waitOrUpgrade',
    severity: 'medium'
  },
  'exceeded your quota': {
    title: 'API使用量制限に達しました', 
    message: '1日のYouTube Data API使用量制限に達しました（1日10,000リクエスト制限）',
    solution: '明日の00:00（太平洋標準時）にリセットされます。今すぐ使いたい場合はGoogle Cloud Consoleで制限を増やしてください',
    action: 'waitOrUpgrade',
    severity: 'medium'
  },
  'rateLimitExceeded': {
    title: 'アクセス頻度制限です',
    message: 'APIへのアクセスが頻繁すぎます',
    solution: '1分待ってから再試行してください',
    action: 'waitAndRetry',
    severity: 'low'
  },
  
  // ライブストリーム関連エラー
  'liveChatDisabled': {
    title: 'ライブチャットが無効です',
    message: 'この配信はライブチャット機能が無効になっています',
    solution: '配信者がライブチャットを有効にするまでお待ちください',
    action: 'waitForChat',
    severity: 'medium'
  },
  'liveChatNotFound': {
    title: 'ライブチャットが見つかりません',
    message: 'ライブチャットが存在しないか、配信が終了している可能性があります',
    solution: 'ライブ配信中のページで再試行してください',
    action: 'checkLiveStatus',
    severity: 'medium'
  },
  'videoNotLive': {
    title: 'ライブ配信中ではありません',
    message: 'この動画は現在ライブ配信中ではありません',
    solution: 'ライブ配信中の動画でのみ使用できます',
    action: 'findLiveStream',
    severity: 'medium'
  },
  
  // ネットワーク・認証エラー
  'NetworkError': {
    title: 'ネットワークエラー',
    message: 'インターネット接続に問題があります',
    solution: 'インターネット接続を確認してから再試行してください',
    action: 'checkConnection',
    severity: 'high'
  },
  'Forbidden': {
    title: 'アクセス権限エラー',
    message: 'APIキーに適切な権限がありません',
    solution: 'Google Cloud ConsoleでAPIキーの権限とYouTube Data API v3の有効化を確認してください',
    action: 'checkPermissions',
    severity: 'high'
  }
};

// エラーメッセージ改善ユーティリティ（HTMLタグ除去は shared/comment.js の stripHtmlTags）
function improveErrorMessage(originalMessage) {
  const cleanMessage = stripHtmlTags(originalMessage);
  
  // よくあるYouTube API エラーの日本語化
  const errorMappings = {
    'exceeded your quota': 'API使用量制限に達しました',
    'quotaExceeded': 'API使用量制限に達しました', 
    'rateLimitExceeded': 'アクセス頻度制限に達しました',
    'API key not valid': 'APIキーが無効です',
    'Access denied': 'アクセスが拒否されました',
    'Forbidden': 'アクセス権限がありません',
    'Bad Request': 'リクエストが無効です',
    'liveChatDisabled': 'ライブチャットが無効です',
    'liveChatNotFound': 'ライブチャットが見つかりません',
    'videoNotLive': 'ライブ配信中ではありません'
  };
  
  // エラーメッセージから該当するパターンを検索
  for (const [pattern, japanese] of Object.entries(errorMappings)) {
    if (cleanMessage.toLowerCase().includes(pattern.toLowerCase())) {
      return japanese;
    }
  }
  
  return cleanMessage;
}

// エラー分析と解決策提案機能
function analyzeError(error) {
  // message を持たない値（文字列・null・prototype無しのオブジェクト）が
  // 投げられても、ここで例外を出さないこと。catch の中で落ちると
  // 呼び出し元の再スケジュールに到達せず、ポーリングが恒久停止する（#8）
  const rawErrorMessage = error?.message ?? String(error);
  const cleanErrorMessage = improveErrorMessage(rawErrorMessage);
  
  debugLog('[Background] Analyzing error:', rawErrorMessage);
  debugLog('[Background] Cleaned error:', cleanErrorMessage);
  
  // クリーンアップされたメッセージでパターンマッチング（大文字小文字を区別しない）
  for (const [pattern, solution] of Object.entries(ERROR_SOLUTIONS)) {
    const lowerPattern = pattern.toLowerCase();
    const lowerRawMessage = rawErrorMessage.toLowerCase();
    const lowerCleanMessage = cleanErrorMessage.toLowerCase();
    
    if (lowerRawMessage.includes(lowerPattern) || lowerCleanMessage.includes(lowerPattern)) {
      debugLog('[Background] Found matching error pattern:', pattern);
      return {
        ...solution,
        message: solution.message, // ERROR_SOLUTIONSで定義されたメッセージを使用
        originalError: rawErrorMessage,
        pattern: pattern
      };
    }
  }
  
  // マッチするパターンが見つからない場合のデフォルト
  return {
    title: '接続エラーが発生しました',
    message: cleanErrorMessage || 'サーバーとの通信に問題が発生しました',
    solution: 'インターネット接続を確認してから再試行してください。問題が続く場合は、APIキーの設定を確認してください',
    action: 'checkConnection',
    severity: 'medium',
    originalError: rawErrorMessage,
    pattern: 'unknown'
  };
}

// === コメント種別とフィルター =============================================
// 判定そのものは shared/comment.js にある（DOMモードとAPIモードで同じ答えを
// 返す必要があるため）。ここではファイル先頭で取り込んだものを使う。

// ログ用の本文プレビュー。displayMessage を持たない種別でも落ちないようにする
function commentPreview(comment) {
  const text = comment?.snippet?.displayMessage || comment?.message || '';
  return text.substring(0, 30);
}

// === セッション状態 ========================================================
// 「いま何を監視しているか」の正は、この session ただ1つ（決定6 = 根本原因A）。
// 以前は SW のメモリ・storage.local・popup・content script の4か所に別々の正があり、
// ズレるたびに突き合わせの分岐が1本ずつ増えていた（それが最大のバグ駆動力だった）。
//
// この節の約束ごと:
//  - 永続化の口は saveSession() / loadSession() の2つだけ。書くのは
//    PERSISTED_SESSION_KEYS の全部で、書き込み箇所ごとに形が変わることは無い
//    （以前は3キー版と5キー版が混在していた）
//  - 突き合わせは reconcile() 1つだけ。`||` のチェーンは書かない。
//    `||` は「明示的な false / null」を表現できず、片方に残った古い true が必ず勝つ
//  - 非同期処理の続きは、自分の epoch がまだ現役かを確かめてから状態に触る（#5）
//  - コメント履歴はここに持たない。正は IndexedDB（shared/store.js）
//  - 表示フィルターもここに持たない。正は storage.local で、読むのは popup（決定1）

// 永続化するキー。Set やタイマーIDは保存できないので、runtime だけの持ち物は
// ここに入れない。どれも復帰時に作り直せる（既読マークとアバターは IndexedDB から、
// ポーリングのタイマーは番人が張り直す）
const PERSISTED_SESSION_KEYS = [
  'epoch', 'isMonitoring', 'chatMode', 'videoId', 'tabId', 'liveChatId', 'pageToken', 'startedAt'
];

function emptySession() {
  return {
    epoch: 0,            // 世代番号。beginSession のたびに +1
    isMonitoring: false,
    chatMode: null,      // 'dom' | 'api'
    videoId: null,
    tabId: null,
    liveChatId: null,    // APIモードのみ
    pageToken: null,     // APIモードのみ。永続化する（#36）
    startedAt: 0,
    // --- ここから下は永続化しない ---
    pollingTimer: null,     // 次回ポーリングの setTimeout ID
    pollingInFlight: false, // fetch が飛んでいる最中か（二重起動の判定に使う）
    processedMessageIds: new Set(),
    // { 発言者名: { url, bucket } }。枠を持たせているので、一般視聴者の
    // アバターがいくら流れても配信者やモデレーターのぶんは落ちない
    avatarsByAuthor: {}
  };
}

let session = emptySession();

// 新しい世代を始める。epoch を進めるのはここだけで、走っている非同期処理は
// これを見て「自分はもう古い」と分かる（#5）
function beginSession(next = {}) {
  stopPolling();
  session = { ...emptySession(), ...next, epoch: session.epoch + 1, startedAt: Date.now() };
  return session.epoch;
}

// 永続化。部分集合は書かない（書き込み箇所ごとに形が違うのをやめる）
async function saveSession() {
  const snapshot = {};
  for (const key of PERSISTED_SESSION_KEYS) snapshot[key] = session[key];
  return safeStorageSet({ monitoringState: snapshot });
}

// storage から読んだ状態を、いまの形に揃える。
// 旧バージョンが書いた部分集合（3キー版・5キー版）もここで吸収する
function loadSession(saved) {
  const base = emptySession();
  if (!saved || !saved.isMonitoring) return base;
  return {
    ...base,
    epoch: typeof saved.epoch === 'number' ? saved.epoch : 0,
    isMonitoring: true,
    // 旧バージョンの保存には chatMode が無いため、liveChatId の有無で推定する
    chatMode: saved.chatMode || (saved.liveChatId ? 'api' : 'dom'),
    videoId: saved.videoId || null,
    tabId: saved.tabId ?? null,
    liveChatId: saved.liveChatId || null,
    pageToken: saved.pageToken || null,
    // 旧バージョンの保存には開始時刻が無い。復元した時点を開始とみなす
    // （番人が「何分コメントが来ていないか」を測るのに使う）
    startedAt: saved.startedAt || Date.now()
  };
}

// (tabId, videoId) が指す配信と、いまのセッションの関係を1語で返す。
// 突き合わせはここだけ。以前は5か所に別々の分岐があった（根本原因A）
//   'idle'    監視していない
//   'same'    同じタブの同じ動画。そのまま続けてよい
//   'changed' 同じタブで動画が変わった。張り直す
//   'other'   別のタブの話。このセッションとは関係が無い
//
// videoId が null（URLが読めない等）のときは判断を保留して 'same' を返す。
// 逆に、セッション側の videoId が無く観測側が分かっているときは 'changed' —
// 動画IDの無いセッションにコメントを積んでも保存先が無く、黙って捨てられるため
function reconcile(tabId, videoId) {
  if (!session.isMonitoring) return 'idle';
  if (tabId !== null && session.tabId !== null && session.tabId !== tabId) return 'other';
  if (videoId && session.videoId !== videoId) return 'changed';
  return 'same';
}

// 同じ動画なら、いま持っている既読マークとアバターをそのまま引き継ぐ。
// 違う動画なら、その動画の保存済みぶんから読み直す。
// beginSession は中身を作り直すので、必ずその前に呼ぶこと
async function carryOverFor(videoId) {
  const sameVideo = Boolean(videoId) && videoId === session.videoId;
  return {
    processedMessageIds: sameVideo ? session.processedMessageIds : await loadProcessedIds(videoId),
    avatarsByAuthor: sameVideo ? session.avatarsByAuthor : await loadAvatars(videoId)
  };
}

// === コメント履歴の保存 ====================================================
// 実体は shared/store.js（IndexedDB）にある（再設計の決定2）。
// 以前はここで storage.local に「動画1本ぶんの配列」を持ち、500ms ごとに
// 全件を書き直していた（#21 = 根本原因C）。いまは追記だけを積んで流す。
//
// storage.local に残るのは設定と監視状態（どれも数百バイト）だけになったので、
// 容量超過は事実上 IndexedDB 側でしか起きない（#7 の後始末は下の appendBatch）。

// 履歴から重複判定用IDへ引き継ぐ件数。processedMessageIds の上限（1000件で
// 半分に間引く）に合わせてあり、これより多く積んでもすぐ捨てられる
const MAX_RESTORED_PROCESSED_IDS = 500;

// 新着コメントからアバターURLを取り出してマップへ入れる。
// 保存に要る差分（persist）と、popup へ送る差分（notify）、
// 上限超過で落とした名前（evicted）を返す。
// URLはコメント側から落とすので、履歴の1件あたりのサイズは変わらない。
//
// マップの値は { url, bucket } で、コメントと同じ保持枠を持たせている（決定3）。
// 全件取り込み（決定1）にすると一般視聴者のアバターだけで上限に届くため、
// 枠が1つだと配信者やモデレーターのアバターが挿入順の古い方から落ちていた。
// 枠を分けたので、bulk がいくら入れ替わっても primary は1件も落ちない —
// 1バッチの中だけで上限を超えた場合も、Service Worker の復帰直後
// （保存済みレコードが枠を持つようになった）も守れる
function collectAvatars(messages) {
  const persist = {};
  const notify = {};
  for (const msg of messages) {
    const url = msg.avatarUrl;
    delete msg.avatarUrl;
    if (!url || !msg.displayName) continue;

    const known = session.avatarsByAuthor[msg.displayName];
    // 枠は上げるだけで下げない。一度スパチャを投げた人のアバターは、
    // その後の通常コメントで bulk に落とさない（過去のスパチャの行に出るため）
    const bucket = msg.bucket === 'primary' || known?.bucket === 'primary' ? 'primary' : 'bulk';
    // 同じ枠の中では、発言のたびに末尾へ入れ直して古い順の間引きから遠ざける
    if (known !== undefined) delete session.avatarsByAuthor[msg.displayName];
    session.avatarsByAuthor[msg.displayName] = { url, bucket };

    if (known?.url === url && known?.bucket === bucket) continue;
    persist[msg.displayName] = { url, bucket };
    // popup へ送るのは「表示に要るもの」＝URLが変わったぶんだけ。
    // 枠だけが変わった場合は送らない（popup は枠を見ない）
    if (known?.url !== url) notify[msg.displayName] = url;
  }

  return { persist, notify, evicted: evictAvatars(persist, notify) };
}

// 保持枠ごとの上限を超えたぶんを、古い方（挿入順が先）から落とす。
// 枠ごとに数えるので、bulk の流量で primary が押し出されることは無い
function evictAvatars(persist, notify) {
  const evicted = [];
  const counts = { primary: 0, bulk: 0 };
  const names = Object.keys(session.avatarsByAuthor);
  // 新しい方から数え、枠の上限を超えた古い方を捨てる
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i];
    const bucket = session.avatarsByAuthor[name].bucket === 'primary' ? 'primary' : 'bulk';
    counts[bucket] += 1;
    if (counts[bucket] <= AVATAR_LIMITS[bucket]) continue;
    delete session.avatarsByAuthor[name];
    delete persist[name];
    delete notify[name];
    evicted.push(name);
  }
  return evicted;
}

// popup へ渡すのは「発言者名 -> URL」のまま。枠は保存と間引きのための持ち物で、
// 表示には要らない（メッセージを太らせない）
function avatarUrlsOf(map) {
  const urls = {};
  for (const [displayName, entry] of Object.entries(map)) urls[displayName] = entry.url;
  return urls;
}

// 保存済み履歴の直近のIDを重複判定用に読む。履歴そのものはメモリに載せない
async function loadProcessedIds(videoId) {
  const ids = new Set();
  if (!videoId) return ids;
  try {
    const recent = await store.read(videoId, { limit: MAX_RESTORED_PROCESSED_IDS });
    for (const comment of recent) if (comment?.id) ids.add(comment.id);
  } catch (error) {
    debugError('[Background] Failed to load processed ids:', error);
  }
  return ids;
}

async function loadAvatars(videoId) {
  if (!videoId) return {};
  try {
    return await store.readAvatars(videoId);
  } catch (error) {
    debugError('[Background] Failed to load avatars:', error);
    return {};
  }
}

// アバターの追加分と、上限で落ちた分を保存へ反映する。
// コメントと違い件数が少ないので、まとめずにそのつど書く
async function saveAvatars(videoId, persist, evicted) {
  if (!videoId) return;
  if (Object.keys(persist).length === 0 && evicted.length === 0) return;
  try {
    await store.putAvatars(videoId, persist, evicted);
  } catch (error) {
    debugError('[Background] Failed to save avatars:', error);
  }
}

function isQuotaError(error) {
  const message = (error?.message || String(error || '')).toLowerCase();
  return message.includes('quota') || message.includes('exceeded');
}

let lastQuotaNotifyAt = 0;

function notifyStorageQuotaError() {
  // 連続保存でエラー通知を撃ち続けないよう1分に1回に絞る
  if (Date.now() - lastQuotaNotifyAt < 60000) return;
  lastQuotaNotifyAt = Date.now();
  notifyPopupOfError({
    title: '保存領域の上限に達しました',
    message: 'コメント履歴の保存に失敗しています',
    solution: '古い動画の履歴を自動削除しました。改善しない場合は履歴をクリアしてください',
    action: 'clearHistory',
    severity: 'medium',
    originalError: 'storage quota exceeded',
    pattern: 'storageQuota'
  });
}

// storage.local への書き込み。失敗しても例外を投げず結果を返す
// （呼び出し側の後続処理＝バッジ更新やスクリプト注入を止めないため）。
// 履歴が IndexedDB へ移った後、ここを通るのは設定と監視状態だけ。
// 容量超過からの復旧（旧 emergencyCleanup）は appendBatch が担う
async function safeStorageSet(items) {
  try {
    await chrome.storage.local.set(items);
    return { ok: true };
  } catch (error) {
    debugError('[Background] storage.set failed:', error);
    if (isQuotaError(error)) notifyStorageQuotaError();
    return { ok: false, error };
  }
}

// URLからVideo IDを抽出（watch / live / live_chat のいずれにも対応）
function extractVideoIdFromUrl(url) {
  if (!url) return null;
  const queryMatch = url.match(/[?&]v=([^&#]+)/);
  if (queryMatch) return queryMatch[1];
  const liveMatch = url.match(/youtube\.com\/live\/([^/?&#]+)/);
  if (liveMatch) return liveMatch[1];
  return null;
}

// 保存待ちのコメント。デバウンスして1回の append にまとめる
// （活発なチャットで毎バッチ書き込むと重いため）。
// 溜めるのは「まだ書いていないぶん」だけで、書き終えた履歴はここに残らない
let pendingSave = { videoId: null, comments: [] };
let pendingSaveTimer = null;
let saveChain = Promise.resolve();

// 監視中の動画以外の履歴を捨てて空きを作る。
// 旧 emergencyCleanup と違い、切り詰める対象（他の動画）と書き直す対象
// （新着のバッチ）が別なので、再試行に効く（#7 はここが同じ配列だった）
async function dropOtherVideoHistories(keepVideoId) {
  const videos = await store.listVideos();
  const targets = videos.filter(video => video.videoId !== keepVideoId);
  for (const video of targets) await store.dropVideo(video.videoId);
  if (targets.length > 0) {
    debugLog('[Background] 🚨 Dropped', targets.length, 'other histories to free space');
  }
  return targets.length > 0;
}

async function appendBatch(videoId, comments) {
  try {
    await store.append(videoId, comments);
  } catch (error) {
    if (isQuotaError(error)) {
      let recovered = false;
      try {
        recovered = await dropOtherVideoHistories(videoId) && !!(await store.append(videoId, comments));
      } catch (retryError) {
        debugError('[Background] Append failed again after cleanup:', retryError);
      }
      if (!recovered) {
        notifyStorageQuotaError();
        return;
      }
    } else {
      debugError('[Background] Failed to append comments:', error);
      return;
    }
  }

  try {
    await store.trim(videoId);
  } catch (error) {
    debugError('[Background] Failed to trim history:', error);
  }
}

// コメントを保存待ちに積む。実際の書き込みは flushCommentsHistory が行う
async function appendComments(videoId, comments) {
  if (!videoId || !comments || comments.length === 0) return;
  // 動画が変わったら、前の動画ぶんを先に書き切る（混ざると別動画の履歴に積まれる）
  if (pendingSave.videoId && pendingSave.videoId !== videoId) await flushCommentsHistory();
  pendingSave.videoId = videoId;
  pendingSave.comments.push(...comments);
  scheduleSaveCommentsHistory();
}

function scheduleSaveCommentsHistory(delayMs = 500) {
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    flushCommentsHistory();
  }, delayMs);
}

// 保存待ちを書き切る。書き込み中に呼ばれても順番が入れ替わらないよう、
// 1本の Promise の鎖に並べる
function flushCommentsHistory() {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }

  if (pendingSave.comments.length > 0) {
    const videoId = pendingSave.videoId;
    const batch = pendingSave.comments;
    pendingSave = { videoId, comments: [] };
    // 鎖が reject のまま残ると、以降の flush が全部失敗する。
    // appendBatch は握りつぶす作りだが、念のためここでも受け止める
    saveChain = saveChain
      .then(() => appendBatch(videoId, batch))
      .catch(error => debugError('[Background] Save chain error:', error));
  }

  return saveChain;
}

// === Service Worker 復帰時の状態復元 =========================================
// MV3のService Workerは約30秒のアイドルで終了し、メモリ上の session が失われる。
// 復帰後の最初のイベントでstorageから復元しないと、DOMモードでは
// handleDomChatMessagesのガードに阻まれて以降のコメントが永久に捨てられる。
let stateRestorePromise = null;

function ensureStateRestored() {
  if (!stateRestorePromise) {
    stateRestorePromise = restoreStateFromStorage();
  }
  return stateRestorePromise;
}

// 復元したセッションがもう有効でない理由を返す（有効ならnull）。
// ブラウザ終了などで isMonitoring:true のまま残った状態を引きずると、
// 別配信のコメントを古い動画の履歴に積んでしまう。
// 突き合わせそのものは reconcile が持つ。ここはタブを見に行くぶんだけ
async function staleSessionReason() {
  if (session.tabId === null) return 'タブ情報なし';

  let tab;
  try {
    tab = await chrome.tabs.get(session.tabId);
  } catch {
    return 'タブが存在しない';
  }

  // URLが読めないときは videoId が null になり、reconcile は判断を保留する
  const tabVideoId = extractVideoIdFromUrl(tab?.url);
  if (reconcile(session.tabId, tabVideoId) === 'changed') {
    return `動画が変わっている (${session.videoId} -> ${tabVideoId})`;
  }

  return null;
}

// セッションを畳む。メモリと storage.local を同時に「監視していない」へ揃える。
// 以前はメモリ側を消さないまま storage にだけ null を書いていたので、
// 停止のたびに両者がずれ、次の突き合わせで古い true が勝っていた（#35 の関連）
async function discardSession(reason) {
  debugLog('[Background] 🧹 Discarding monitoring session:', reason);
  beginSession();
  updateBadge(false);
  await stopWatchdog();
  await saveSession();
}

async function restoreStateFromStorage() {
  try {
    // 旧形式の履歴を読み落とさないよう、移行を待ってから状態を組み立てる
    // （migrateFromLocal は一度しか走らないので、2度目以降はただの待ち合わせ）
    await store.migrateFromLocal();
    const result = await chrome.storage.local.get(['monitoringState']);
    const saved = loadSession(result.monitoringState);

    if (!saved.isMonitoring) {
      debugLog('[Background] No active monitoring state to restore');
      return;
    }

    // 突き合わせは reconcile が見るので、まず復元してから判定する
    session = saved;

    const staleReason = await staleSessionReason();
    if (staleReason) {
      await discardSession(staleReason);
      return;
    }

    if (session.videoId) {
      // 保存済みのアバターは枠を持っている。復帰直後でも
      // 配信者やモデレーターのぶんが一般視聴者に押し出されない
      session.avatarsByAuthor = await loadAvatars(session.videoId);
      // 保存済みのIDを重複判定に反映（復帰直後の再送を弾く）。
      // 履歴そのものは読まない。必要なのは直近のIDだけ
      session.processedMessageIds = await loadProcessedIds(session.videoId);
    }

    debugLog('[Background] ♻️ Restored monitoring state after service worker wake-up:', {
      chatMode: session.chatMode,
      videoId: session.videoId,
      tabId: session.tabId,
      epoch: session.epoch
    });

    updateBadge(true);
    // 番人は Service Worker の外にいるので、終了して復帰したここでも張り直す
    startWatchdog();

    // APIモードはポーリングも止まっているので再開する
    if (session.chatMode === 'api' && session.liveChatId) {
      startPollingLoop();
    }
  } catch (error) {
    debugError('[Background] Failed to restore monitoring state:', error);
  }
}

// Service Worker起動時の初期化
async function initializeServiceWorker() {
  debugLog('[Background] Initializing Service Worker');
  
  try {
    // storage.local に残っている旧形式の履歴を IndexedDB へ移す（片道）。
    // 移行は Service Worker だけが行う。popup と同時に走らせると二重に積まれる
    await store.migrateFromLocal();

    // クリーンアップは監視中の動画を守るため、状態復元を待ってから実行する
    await ensureStateRestored();
    await cleanupOldCommentHistories();

  } catch (error) {
    debugError('[Background] Error initializing service worker:', error);
  }
}

// Service Worker起動時に初期化を実行
initializeServiceWorker();

// Service Workerが終了から復帰した直後に監視状態を復元する
ensureStateRestored();

chrome.runtime.onInstalled.addListener(async (details) => {
  debugLog('[Background] YouTube Special Comments Filter installed/updated, reason:', details.reason);
  
  // 自動Content Script再注入を実行
  await reinjectContentScripts(details.reason);
  
  // インストール時に監視状態をリセット（履歴は保持）。
  // 起動直後の ensureStateRestored() が古い状態を復元している可能性があるため、
  // メモリと storage を1回で揃える
  await discardSession('拡張機能のインストール／更新');

  // 旧バージョンで肥大化したストレージを更新時に整理する
  await cleanupOldCommentHistories();
});

// Content Scriptが生きているかをpingで確認する
async function isContentScriptAlive(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return !!response;
  } catch {
    return false;
  }
}

// Content Script自動再注入機能
// targetTabId を渡すとそのタブだけを対象にする（popupからの修復要求など）
async function reinjectContentScripts(reason, targetTabId = null) {
  debugLog('[Background] 🔄 Starting content script re-injection for reason:', reason,
           targetTabId !== null ? `(tab ${targetTabId} only)` : '(all matching tabs)');
  
  try {
    // manifest.jsonからcontent_scriptsを取得
    const manifest = chrome.runtime.getManifest();
    const contentScripts = manifest.content_scripts || [];
    
    if (contentScripts.length === 0) {
      debugWarn('[Background] No content scripts found in manifest');
      return;
    }
    
    let injectedTabsCount = 0;
    let totalTabsChecked = 0;
    
    for (const cs of contentScripts) {
      debugLog('[Background] Processing content script with matches:', cs.matches);
      
      // pingに応答するのはcontent-script.jsだけ。dom-chat.jsのエントリで
      // 生存確認すると、同じタブのcontent-script.jsが応答してしまい誤判定になる
      const canProbe = (cs.js || []).includes('content/content-script.js');
      
      // 対象URLにマッチするタブを取得
      let tabs = await chrome.tabs.query({ url: cs.matches });
      if (targetTabId !== null) {
        tabs = tabs.filter(tab => tab.id === targetTabId);
      }
      totalTabsChecked += tabs.length;
      
      debugLog('[Background] Found', tabs.length, 'tabs matching', cs.matches);
      
      for (const tab of tabs) {
        try {
          // chrome:// や chrome-extension:// URLはスキップ
          if (tab.url.match(/(chrome|chrome-extension|chrome-devtools):\/\//gi)) {
            debugLog('[Background] Skipping system tab:', tab.url);
            continue;
          }
          
          // タブの読み込み状態を確認
          if (tab.status !== 'complete') {
            debugLog('[Background] Skipping incomplete tab:', tab.url);
            continue;
          }
          
          // 既にContent Scriptが動いているタブへの再注入は不要。
          // 注入側のガードでSyntaxErrorにはならないが、無駄な注入を避ける
          if (canProbe && await isContentScriptAlive(tab.id)) {
            debugLog('[Background] Skipping tab with live content script:', tab.id);
            continue;
          }
          
          const target = {
            tabId: tab.id,
            allFrames: cs.all_frames || false
          };
          
          // JavaScriptファイルを注入
          if (cs.js && cs.js.length > 0) {
            debugLog('[Background] Injecting JS files into tab:', tab.id, 'URL:', tab.url);
            await chrome.scripting.executeScript({
              files: cs.js,
              target,
              injectImmediately: cs.run_at === 'document_start',
              world: cs.world || 'ISOLATED'
            });
            debugLog('[Background] ✅ Successfully injected JS files into tab:', tab.id);
          }
          
          // CSSファイルを注入
          if (cs.css && cs.css.length > 0) {
            debugLog('[Background] Injecting CSS files into tab:', tab.id);
            await chrome.scripting.insertCSS({
              files: cs.css,
              target,
              origin: cs.origin || 'AUTHOR'
            });
            debugLog('[Background] ✅ Successfully injected CSS files into tab:', tab.id);
          }
          
          injectedTabsCount++;
          
          // 小さな遅延を入れて負荷を分散
          await new Promise(resolve => setTimeout(resolve, 50));
          
        } catch (error) {
          debugWarn('[Background] ⚠️ Failed to inject into tab', tab.id, ':', error.message);
          
          // 権限エラーの場合はログに記録
          if (error.message.includes('Cannot access contents')) {
            debugLog('[Background] Permission denied for tab:', tab.url);
          }
        }
      }
    }
    
    debugLog('[Background] ✅ Content script re-injection completed');
    debugLog(`[Background] 📊 Stats: ${injectedTabsCount} successful injections out of ${totalTabsChecked} tabs`);
    
    // 注入結果をストレージに保存（診断用）
    await chrome.storage.local.set({
      lastInjectionResult: {
        timestamp: Date.now(),
        reason,
        injectedTabs: injectedTabsCount,
        totalTabs: totalTabsChecked,
        success: true
      }
    });
    
  } catch (error) {
    debugError('[Background] ❌ Content script re-injection failed:', error);
    
    // エラー情報をストレージに保存
    await chrome.storage.local.set({
      lastInjectionResult: {
        timestamp: Date.now(),
        reason,
        error: error.message,
        success: false
      }
    });
  }
}

// === popup との通信（ポート） ==============================================
// popup ↔ Service Worker は chrome.runtime.connect のポートで話す（フェーズ6b）。
// sendMessage との違いは4つあり、どれも「届いたかどうか分からない」前提で
// 足されていた仕掛けを不要にする。
//  - popup が開いているかどうかが onConnect / onDisconnect で分かる
//  - 送った順に届く（popup の差分描画はこれを前提にしている。フェーズ5）
//  - 「Receiving end does not exist」を握りつぶす必要が無い
//  - popup が開いている間は Service Worker が終了しない
//    （popup 側の ping 8回の待ち＝旧 waitForServiceWorker も要らなくなった）
//
// ポートは session に持たせない。永続化できないうえ、popup が開いているかは
// セッションの持ち物ではない（PERSISTED_SESSION_KEYS を増やさないこと）。
// content script との通信は sendMessage / tabs.sendMessage のまま。
// content script は connect の相手ではなく、区間も別（フェーズ7以降の話）
const POPUP_PORT_NAME = 'popup';
const popupPorts = new Set();

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== POPUP_PORT_NAME) return;
  popupPorts.add(port);
  debugLog('[Background] Popup connected. open popups:', popupPorts.size);

  port.onMessage.addListener(message => {
    const requestId = message?.requestId;
    const respond = payload => postToPort(port, { requestId, payload });
    // 知らない action でも必ず返す。返さないと popup の待ちが宙に浮く
    if (!dispatchRequest(message?.payload, port.sender, respond)) respond(undefined);
  });

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    debugLog('[Background] Popup disconnected. open popups:', popupPorts.size);
  });
});

/** popup が開いているか。ポートがあるかどうかがそのまま答えになる */
function isPopupOpen() {
  return popupPorts.size > 0;
}

// 送る直前に閉じられることはある（利用者が popup を閉じた瞬間）。
// そのときだけは黙って外す ——「開いていないかもしれない」を握りつぶすのとは違う
function postToPort(port, message) {
  try {
    port.postMessage(message);
  } catch (error) {
    debugLog('[Background] Popup port closed while posting:', error?.message ?? String(error));
    popupPorts.delete(port);
  }
}

/** 開いている popup へ片道で流す。開いていなければ何も起きない */
function notifyPopup(message) {
  for (const port of popupPorts) postToPort(port, message);
}

// === dom-chat.js のヘルス（フェーズ7）=======================================
//
// DOMモードの壊れ方は「無言で0件になる」で、静かな配信と区別が付かない
// （根本原因F）。dom-chat.js が持っている状態をここで受けて popup まで出す。
//
// session には持たせない。永続化できないうえ、「いま読めているか」は
// セッションの持ち物ではない（PERSISTED_SESSION_KEYS を増やさないこと）。
// Service Worker が終了すると控えは消えるが、正は content script 側にあるので
// 聞き直せる（getDomChatHealth）
let domChatHealth = null;

async function recordDomChatHealth(health, sender) {
  await ensureStateRestored();

  // 監視していないタブからの報告は捨てる。manifest の自動注入で、
  // dom-chat.js は見ていない配信の live_chat にも乗っている
  const tabId = sender?.tab?.id ?? null;
  const mine = session.isMonitoring && session.chatMode === 'dom' &&
               (tabId === null || session.tabId === null || tabId === session.tabId);
  if (!mine) return { success: true };

  rememberDomChatFrame(sender);

  domChatHealth = { ...health, videoId: session.videoId, receivedAt: Date.now() };
  notifyPopup({ action: 'domChatHealth', health: domChatHealth });
  return { success: true };
}

// dom-chat.js が居るフレーム。report のたびに更新する。
//
// tabs.sendMessage はタブの**全フレーム**に配られ、応答は最初に返した1つが勝つ。
// watch ページのトップフレームには content-script.js が居て、#30 を直したいまは
// 知らない action にも即座に応答するので、フレームを指定しないと
// 「unknown action」がヘルスの応答を追い越す。宛先が分かっているなら指定する。
// 永続化はしない（session の持ち物ではない）。Service Worker が終了して
// 失われたら、宛先なしで聞き直す ——「誰も答えない」より「別の誰かが答える」ほうが
// 復帰は早く、答えが違えば health を持たない応答として捨てられる
let domChatFrame = null;

function rememberDomChatFrame(sender) {
  const tabId = sender?.tab?.id ?? null;
  const frameId = sender?.frameId ?? null;
  if (tabId === null || frameId === null) return;
  domChatFrame = { tabId, frameId };
}

// 打ち切りは要らなくなった（#30 を直したので、応答チャネルを開いたまま
// 黙る content script はもう居ない）。宛先のフレームが消えていれば
// tabs.sendMessage はその場で reject する
function askTabForHealth(tabId) {
  const message = { action: 'getDomChatHealth' };
  return domChatFrame?.tabId === tabId
    ? chrome.tabs.sendMessage(tabId, message, { frameId: domChatFrame.frameId })
    : chrome.tabs.sendMessage(tabId, message);
}

// popup からの問い合わせ。Service Worker が終了して控えを失っていても答えられるよう、
// まずタブの dom-chat.js に聞く（生きていれば必ずいまの値を返す）
async function getDomChatHealth() {
  await ensureStateRestored();

  if (!session.isMonitoring || session.chatMode !== 'dom') return { success: true, health: null };

  if (session.tabId !== null) {
    try {
      const reply = await askTabForHealth(session.tabId);
      if (reply?.health) {
        domChatHealth = { ...reply.health, videoId: session.videoId, receivedAt: Date.now() };
      }
    } catch (error) {
      debugLog('[Background] dom-chat.js did not answer the health check:',
        error?.message ?? String(error));
    }
  }

  // 別の配信のときの控えは出さない（前の配信の「読めています」が居座る）
  if (domChatHealth?.videoId !== session.videoId) return { success: true, health: null };
  return { success: true, health: domChatHealth };
}

// popup（ポート）と content script（sendMessage）の両方から来る要求を1か所で捌く。
// 応答は必ず Promise で返し、扱わない action には undefined を返す
function handleRequest(request, sender) {
  const action = request?.action;
  debugLog('[Background] Received message:', action);

  // Service Worker生存確認用のping（content script が使う。
  // popup はポートが繋がること自体が生存確認なので、もう投げない）
  if (action === 'ping') {
    return Promise.resolve({ success: true, timestamp: Date.now() });
  }

  // 手動Content Script再注入
  if (action === 'reinjectContentScripts') {
    return reinjectContentScripts('manual', request.tabId ?? null).then(() => ({ success: true }));
  }

  // 最後の注入結果を取得
  if (action === 'getLastInjectionResult') {
    return chrome.storage.local.get(['lastInjectionResult'])
      .then(result => result.lastInjectionResult || null);
  }

  if (action === 'getApiKey') {
    return chrome.storage.local.get(['youtubeApiKey'])
      .then(result => ({ apiKey: result.youtubeApiKey }));
  }

  if (action === 'saveApiKey') {
    return chrome.storage.local.set({ youtubeApiKey: request.apiKey })
      .then(() => ({ success: true }));
  }

  if (action === 'getDebugMode') {
    return chrome.storage.local.get(['debugMode'])
      .then(result => ({ debugMode: result.debugMode || false }));
  }

  if (action === 'saveDebugMode') {
    return chrome.storage.local.set({ debugMode: request.debugMode }).then(() => {
      debugMode = request.debugMode; // グローバル変数も更新
      return { success: true };
    });
  }

  if (action === 'getChatMode') {
    return chrome.storage.local.get(['chatMode'])
      .then(result => ({ chatMode: result.chatMode || 'dom' }));
  }

  if (action === 'getAutoStart') {
    return chrome.storage.local.get(['autoStart'])
      .then(result => ({ autoStart: result.autoStart ?? true }));
  }

  if (action === 'saveAutoStart') {
    return chrome.storage.local.set({ autoStart: request.autoStart })
      .then(() => ({ success: true }));
  }

  if (action === 'startBackgroundMonitoring') {
    return startBackgroundMonitoring(
      request.liveChatId, sender?.tab?.id ?? request.tabId ?? null, request.videoId);
  }

  if (action === 'stopBackgroundMonitoring') {
    return stopBackgroundMonitoring();
  }

  if (action === 'getMonitoringState') {
    return getMonitoringState();
  }

  // (tabId, videoId) といまのセッションの関係を1語で返す。突き合わせの正は
  // reconcile ただ1つで、popup も自前で比べずにこれを聞く（根本原因A）
  if (action === 'reconcileSession') {
    return ensureStateRestored().then(() => ({
      success: true,
      state: reconcile(request.tabId ?? null, request.videoId ?? null)
    }));
  }

  // dom-chat.js が「いま読めているか」を知らせてくる（フェーズ7）。
  // 状態が変わったときだけ来る片道の報告で、popup へそのまま流す
  if (action === 'domChatHealth') {
    return recordDomChatHealth(request.health, sender);
  }

  // popup からの問い合わせ（popup を開いた時点の状態を出すため）
  if (action === 'getDomChatHealth') {
    return getDomChatHealth();
  }

  if (action === 'getLiveChatIdFromVideo') {
    return getLiveChatIdFromVideo(request.videoId);
  }

  if (action === 'setCommentFilters') {
    return setCommentFilters(request.filters);
  }

  if (action === 'getCommentFilters') {
    return getCommentFilters();
  }

  if (action === 'getCommentsHistory') {
    return getCommentsHistory(request.videoId, request.bucket);
  }

  if (action === 'clearCommentsHistory') {
    return clearCommentsHistory(request.videoId);
  }

  if (action === 'startDomMonitoring') {
    return startDomMonitoring(sender?.tab?.id || request.tabId, request.videoId);
  }

  if (action === 'domChatMessages') {
    // 1本の鎖に並べる。応答は即返して処理を切り離すので、
    // ここで直列化しないとバッチ同士が互いの状態更新を踏む（#5）
    enqueueDomChatMessages(request.messages, sender);
    return Promise.resolve({ success: true });
  }

  return undefined;
}

// handleRequest の応答を呼び出し側へ渡す。扱ったなら true。
// 失敗は例外にせず { success: false, error } に畳む（呼び出し側は
// 「応答が来ない」と「処理が失敗した」を区別しなくてよい）
function dispatchRequest(request, sender, respond) {
  let result;
  try {
    result = handleRequest(request, sender);
  } catch (error) {
    respond({ success: false, error: error?.message ?? String(error) });
    return true;
  }
  if (result === undefined) return false;
  result.then(respond, error => respond({ success: false, error: error?.message ?? String(error) }));
  return true;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) =>
  dispatchRequest(request, sender, sendResponse));

// 履歴の消去。保存待ちと既読マークを対で落とす（#6）
async function clearCommentsHistory(requestedVideoId) {
  const videoId = requestedVideoId || session.videoId;
  if (videoId) {
    // 保存待ちを先に捨てる。残したままだと、クリアの直後に
    // 「消したはずのコメント」が書き戻される
    if (pendingSave.videoId === videoId) pendingSave.comments = [];
    // コメントとアバターは store.clear が対で消す（#6 の消し忘れ1つ目）
    await store.clear(videoId);
  }
  if (!requestedVideoId || requestedVideoId === session.videoId) {
    // 既読マークを消さないと、クリア後に再スキャンさせても全件が
    // 「重複」で弾かれ、コメントが1件も戻らない（#6 の本体）。
    // アバターも一緒に落とす（残っていると、消えた発言者のURLが居座る）
    session.processedMessageIds = new Set();
    session.avatarsByAuthor = {};
  }
  return { success: true };
}

async function fetchLiveChatMessages(liveChatId, pageToken = null) {
  try {
    const result = await chrome.storage.local.get(['youtubeApiKey']);
    const apiKey = result.youtubeApiKey;
    
    if (!apiKey) {
      throw new Error('API key not found. Please set your YouTube Data API key in the extension settings.');
    }
    
    const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
    url.searchParams.append('liveChatId', liveChatId);
    url.searchParams.append('part', 'snippet,authorDetails');
    url.searchParams.append('key', apiKey);
    
    if (pageToken) {
      url.searchParams.append('pageToken', pageToken);
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`YouTube API Error: ${errorData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    
    // 落とすのは表示できない種別（チャット終了・削除済みなど）だけ。
    // 役割・種別の絞り込みはここではやらない（決定1）。取り込み時に捨てると
    // 保存されないので、あとからトグルをONにしても過去分が戻らない（#4）
    const comments = [];
    for (const item of data.items) {
      const kind = apiCommentKind(item);
      if (!kind) continue;
      // 保持枠は取り込み口で焼き付ける（決定3）。付けずに渡すと store 側が
      // 1件ずつ正準形に通し直すことになり、全件取り込みの流量では無駄が大きい。
      // 枠の判定そのものは bucketOf が正で、ここには書き写さない
      item.bucket = bucketOf({ kind, role: apiCommentRole(item.authorDetails) });
      comments.push(item);
    }

    debugLog('[Background] Returning', comments.length, 'displayable comments out of', data.items.length, 'total');

    return {
      comments: comments,
      nextPageToken: data.nextPageToken,
      pollingIntervalMillis: data.pollingIntervalMillis || 5000
    };
    
  } catch (error) {
    debugError('[Background] Error fetching live chat messages:', error);
    throw error;
  }
}

// アイコンバッジ更新
function updateBadge(isMonitoring) {
  if (isMonitoring) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00AA00' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Backgroundでの監視開始（APIモード）
async function startBackgroundMonitoring(liveChatId, tabId, videoId) {
  debugLog('[Background] Starting background monitoring for liveChatId:', liveChatId, 'videoId:', videoId);

  await ensureStateRestored();

  // 履歴は動画ごとに IndexedDB にあるので、開始時に読み込み直す必要は無い。
  // 引き継ぐのは「どこまで取り込んだか」と、発言者ごとのアバターだけ。
  // セッションを畳む前に確保しておく
  const carried = await carryOverFor(videoId);

  if (session.isMonitoring) {
    debugLog('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }

  // 状態は1つ（決定6）。DOMモードと同じ形で作るので、
  // APIモードにだけ avatarsByAuthor が無い（#10）ような片肺は起こりようがない
  beginSession({
    isMonitoring: true,
    chatMode: 'api',
    videoId,
    tabId,
    liveChatId,
    ...carried
  });

  debugLog('[Background] Monitoring state reset for video:', videoId, 'epoch:', session.epoch);

  // 状態を永続化（Service Worker終了後の復元に必要な情報をすべて含める）
  await saveSession();

  // 監視開始
  updateBadge(true);
  startWatchdog();
  startPollingLoop();

  return { success: true };
}

// Backgroundでの監視停止
async function stopBackgroundMonitoring() {
  debugLog('[Background] Stopping background monitoring');

  await ensureStateRestored();

  session.isMonitoring = false;
  stopPolling();

  // 履歴を保存
  await flushCommentsHistory();

  // メモリも storage も「監視していない」で揃える。
  // 以前はメモリ側に古い tabId / videoId / chatMode が残り続けていた
  beginSession();
  await saveSession();
  await stopWatchdog();
  // 「読めています」の控えが、停止後も居座らないようにする
  domChatHealth = null;

  updateBadge(false);

  return { success: true };
}

// 監視状態を取得。正は session ただ1つなので、storage と突き合わせる
// `||` チェーン（片方に残った古い true が必ず勝つ）はもう無い
async function getMonitoringState() {
  await ensureStateRestored();

  debugLog('[Background] getMonitoringState:', {
    isMonitoring: session.isMonitoring,
    videoId: session.videoId,
    chatMode: session.chatMode,
    epoch: session.epoch
  });

  return {
    success: true,
    isMonitoring: session.isMonitoring,
    liveChatId: session.liveChatId,
    tabId: session.tabId,
    videoId: session.videoId,
    chatMode: session.chatMode
  };
}

// === APIモードのポーリング ==================================================
// タイマーは session が持つ。走っている fetch の続きは、自分の epoch が
// まだ現役かを確かめてから状態に触る（#5）

function stopPolling() {
  if (session.pollingTimer) {
    clearTimeout(session.pollingTimer);
    session.pollingTimer = null;
  }
}

// 「動いているべきなのに動いていない」を番人が判断するための目印
function isPollingAlive() {
  return session.pollingInFlight || session.pollingTimer !== null;
}

function scheduleNextPoll(delayMs) {
  stopPolling();
  session.pollingTimer = setTimeout(() => {
    session.pollingTimer = null;
    startPollingLoop();
  }, delayMs);
}

function startPollingLoop() {
  if (!session.isMonitoring || !session.liveChatId) {
    return;
  }
  // 走っている fetch があるのに重ねて呼ぶと、ループが二重になって quota も倍になる。
  // 停止と再開が競合したときに実際に起きていた（#5）
  if (session.pollingInFlight) {
    debugLog('[Background] Polling already in flight, skipping duplicate start');
    return;
  }
  stopPolling();

  debugLog('[Background] Polling for new messages...');

  // この世代の仕事であることを、続きの中で確かめる。
  // videoId も先に控える（続きが走る頃には別の動画になっているかもしれない）
  const epoch = session.epoch;
  const videoId = session.videoId;
  session.pollingInFlight = true;

  fetchLiveChatMessages(session.liveChatId, session.pageToken)
    .then(response => onPollSuccess(epoch, videoId, response))
    .catch(error => onPollError(epoch, error));
}

async function onPollSuccess(epoch, videoId, response) {
  // 自分の世代がもう現役でないなら、状態には一切触らない（#5）。
  // pollingInFlight も新しい世代のものなので戻さない
  if (epoch !== session.epoch) {
    debugLog('[Background] Dropping poll result from old epoch', epoch, '->', session.epoch);
    return;
  }
  session.pollingInFlight = false;
  if (!session.isMonitoring) return;

  if (response.comments && response.comments.length > 0) {
    // 重複をフィルタリング
    const newComments = response.comments.filter(comment => {
      const messageId = comment.id;
      if (session.processedMessageIds.has(messageId)) {
        debugLog('[Background] Duplicate comment filtered:', messageId);
        return false;
      }
      session.processedMessageIds.add(messageId);
      debugLog('[Background] New comment added:', messageId, commentPreview(comment));
      return true;
    });

    if (newComments.length > 0) {
      debugLog('[Background] Found', newComments.length, 'new special comments');

      // 履歴へ追記（保存の実体は IndexedDB。上限は保持枠ごとに store が見る）
      appendComments(videoId, newComments);

      // popupに新しいコメントを通知（ポート。開いていなければ何も起きない）。
      // content script には送らない —— 控えを持つのをやめたので配る先が無い
      notifyPopup({
        action: 'newSpecialComments',
        comments: newComments
      });
    }
  }

  // pageToken は永続化する（#36）。Service Worker が終了しても続きから読める。
  // nextPageToken を返さないレスポンスで undefined を焼き付けると、
  // 次の起動でAPIの既定ウィンドウを取り直すことになるので、そのときは据え置く
  if (response.nextPageToken && response.nextPageToken !== session.pageToken) {
    session.pageToken = response.nextPageToken;
    await saveSession();
    if (epoch !== session.epoch || !session.isMonitoring) return;
  }

  // Setのサイズ制限（メモリ使用量制限）
  if (session.processedMessageIds.size > 1000) {
    const idsArray = Array.from(session.processedMessageIds);
    session.processedMessageIds = new Set(idsArray.slice(-500));
  }

  // 次のポーリングをスケジュール
  scheduleNextPoll(response.pollingIntervalMillis || 5000);
}

function onPollError(epoch, error) {
  if (epoch !== session.epoch) return;
  session.pollingInFlight = false;

  debugError('[Background] Error in polling loop:', error);

  // catch の中で例外を出すと、この下の再スケジュールに到達せず、
  // ポーリングが恒久的に止まる（#8）。message を持たない値が投げられても
  // 落ちないよう、ここから先は素の文字列として扱う
  const message = (error?.message ?? String(error)).toLowerCase();

  // エラー分析と解決策提案（analyzeError も message 無しに耐える）
  const errorAnalysis = analyzeError(error);
  debugLog('[Background] Error analysis:', errorAnalysis);

  // リアルタイムでポップアップにエラー通知
  notifyPopupOfError(errorAnalysis);

  // API制限エラーの場合は長めの間隔でリトライ。
  // 60秒待ちは Service Worker のアイドル上限（約30秒）を超えるので、
  // このタイマーは消えることがある。消えても番人が1分周期で拾い直す（#37）
  const retryDelay = message.includes('quota') || message.includes('limit') ? 60000 : 15000;

  // 監視中の場合のみリトライ
  if (!session.isMonitoring) return;
  debugLog(`[Background] Retrying in ${retryDelay / 1000} seconds...`);
  scheduleNextPoll(retryDelay);
}

// SPA遷移後はmanifestの自動注入が走らないため、明示的に注入する。
// チャットはiframeの中なので allFrames が要るが、そのぶんチャットと無関係な
// フレームにも届く。どのフレームで動くかの判断は dom-chat.js 側の
// location.pathname のガードに任せている（#1）。
// window.__domChatInitialized ガードにより二重注入は無害
async function injectDomChat(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      // shared/comment.js が先。dom-chat.js は self.YTF を読み込み時に参照する
      files: ['shared/comment.js', 'content/dom-chat.js']
    });
    debugLog('[Background] dom-chat.js injected into tab:', tabId);
  } catch (e) {
    debugLog('[Background] dom-chat.js injection skipped:', e?.message);
  }
}

// 注入済みガードで再実行がスキップされた場合でも初期スキャンを確実に実行。
// force を付けるのは、開始前に流れたコメントを dom-chat.js が送信済み扱いで
// 抱えているため。全件送り直させ、既出分は processedMessageIds で弾く
function requestInitialSweep(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'requestInitialSweep', force: true }).catch(() => {});
}

// DOM モードでの監視開始
async function startDomMonitoring(tabId, videoId) {
  debugLog('[Background] Starting DOM monitoring for videoId:', videoId, 'tabId:', tabId);

  await ensureStateRestored();

  // 同じ動画を同じタブで既にDOM監視中なら、状態とバッファを壊さずに継続する
  // （content script と popup の自動開始が競合しても取りこぼさないため）
  if (session.chatMode === 'dom' && reconcile(tabId, videoId) === 'same') {
    debugLog('[Background] DOM monitoring already active for this video, reusing session');
    requestInitialSweep(tabId);
    return { success: true };
  }

  // 引き継ぐものは、セッションを畳む前に確保しておく
  const carried = await carryOverFor(videoId);

  if (session.isMonitoring) {
    debugLog('[Background] Already monitoring, stopping previous session');
    await stopBackgroundMonitoring();
  }

  beginSession({
    isMonitoring: true,
    chatMode: 'dom',
    videoId,
    tabId,
    ...carried
  });

  // 書き込みに失敗しても、以降のバッジ更新とdom-chat.js注入は必ず実行する
  // （ここで例外を投げると監視が始まらず「コメントが1件も来ない」状態になる）
  await saveSession();

  updateBadge(true);
  startWatchdog();

  await injectDomChat(tabId);
  requestInitialSweep(tabId);

  return { success: true };
}

// DOM モードのメッセージ処理。
// onMessage は sendResponse を即返して処理を切り離すので、バッチは放っておくと
// 直列化されない。バッチAが startDomMonitoring の中にいる間にバッチBが入ると、
// Bは古いセッションに書き込み、そのあとAが状態を作り直して消える（#5）。
// 入口で1本の鎖に並べ、さらに epoch で世代を確かめる
let domBatchChain = Promise.resolve();

function enqueueDomChatMessages(messages, sender) {
  domBatchChain = domBatchChain
    .then(() => handleDomChatMessages(messages, sender))
    .catch(error => debugError('[Background] Error handling DOM chat messages:', error));
  return domBatchChain;
}

async function handleDomChatMessages(messages, sender = null) {
  // Service Worker終了から復帰した直後はセッションが初期値に戻っているため、
  // ガード判定の前に必ずstorageからの復元を待つ
  await ensureStateRestored();

  const senderTabId = sender?.tab?.id ?? null;
  const senderVideoId = extractVideoIdFromUrl(sender?.url) ||
                        extractVideoIdFromUrl(sender?.tab?.url);

  // 送り主のフレーム＝dom-chat.js の居場所。ヘルスを聞き返す宛先に使う
  rememberDomChatFrame(sender);

  // 同じタブなのに監視対象の動画IDが食い違う場合は、復元した状態が古い。
  // そのまま処理すると別動画の履歴にコメントを積んでしまうのでセッションを張り直す
  if (session.chatMode === 'dom' && reconcile(senderTabId, senderVideoId) === 'changed') {
    debugLog('[Background] ♻️ Video changed under active DOM session:',
      session.videoId, '->', senderVideoId);
    await startDomMonitoring(senderTabId, senderVideoId);
  }

  if (!session.isMonitoring || session.chatMode !== 'dom') {
    debugLog('[Background] Dropping DOM messages - not monitoring in DOM mode', {
      isMonitoring: session.isMonitoring,
      chatMode: session.chatMode
    });
    return;
  }

  // 張り直したあとで、もう一度だけ突き合わせる。
  // ここで 'same' でないのは「別のタブのライブチャット」で、
  // 監視中の動画の履歴に混ぜてはいけない
  const verdict = reconcile(senderTabId, senderVideoId);
  if (verdict !== 'same') {
    debugLog('[Background] Dropping DOM messages from', verdict, 'tab:', senderTabId);
    return;
  }

  // ここから先はこの世代の仕事。await をまたいでも、控えた videoId に積む
  const epoch = session.epoch;
  const videoId = session.videoId;

  const newMessages = messages.filter(msg => {
    // 更新前に保存された履歴のIDは旧形式。dom-chat.js が両方を載せてくるので、
    // どちらかで既出なら取り込まない（更新直後の全件スキャンで二重に積まないため）
    const legacyId = msg.legacyId;
    delete msg.legacyId; // 保存はしない。突き合わせにしか使わない
    if (session.processedMessageIds.has(msg.id)) return false;
    if (legacyId && session.processedMessageIds.has(legacyId)) return false;
    // 落とすのは表示できない種別だけ。役割・種別の絞り込みは popup が持つ（決定1）
    if (!isDisplayableKind(msg.kind)) return false;
    // 既読にするのは「保存すると決めたあと」（#4）。捨てるコメントまで既読に
    // していたので、あとからトグルをONにして全件スキャンし直しても、
    // ここで弾かれて二度と拾えなかった
    session.processedMessageIds.add(msg.id);
    // 保持枠を焼き付けてから渡す（決定3）。判定は bucketOf が正
    msg.bucket = bucketOf(msg);
    return true;
  });

  if (!newMessages.length) return;

  // コメント本体に載せず、発言者ごとのマップへ移す
  const { persist, notify, evicted } = collectAvatars(newMessages);
  await saveAvatars(videoId, persist, evicted);

  if (session.processedMessageIds.size > 1000) {
    const arr = Array.from(session.processedMessageIds);
    session.processedMessageIds = new Set(arr.slice(-500));
  }

  await appendComments(videoId, newMessages);

  // 世代が変わっていたら、この先の通知はもう別の配信の画面に混ざる。
  // 保存だけは（控えた videoId に対して）済ませてある
  if (epoch !== session.epoch) {
    debugLog('[Background] Session changed while saving; skipping notify for epoch', epoch);
    return;
  }

  notifyPopup({
    action: 'newSpecialComments',
    comments: newMessages,
    avatars: notify
  });
}

// サービスワーカーのライフサイクル管理
chrome.runtime.onStartup.addListener(async () => {
  debugLog('[Background] Extension startup');
  // DOMモード（liveChatIdがnull）も含めて共通の復元処理に任せる
  await ensureStateRestored();
});

// タブが閉じられたときの処理。
//
// 以前はリスナーが2本あり、片方は「監視を自動停止する」、もう片方は
// 「タブが閉じられても監視は継続」と正反対のことをしていた（#35）。
// **止める**方を採った。理由は3つ:
//  - DOMモードのコメントはそのタブの live_chat から届く。タブが無ければ
//    以後1件も来ない。「継続」はバッジだけ ON のまま何も起きない状態を作る
//  - タブを失ったセッションは、次に Service Worker が復帰した時点で
//    staleSessionReason の「タブ情報なし」で破棄される。「継続」は
//    Service Worker が生きている間しか続かず、挙動が説明できない
//  - APIモードは続けられるが、見ていない配信のために quota を使い続ける
// 履歴は停止処理の中で flush されるので、閉じる直前のコメントは失われない
chrome.tabs.onRemoved.addListener(tabId => {
  handleTabRemoved(tabId).catch(error =>
    debugError('[Background] Error handling tab removal:', error));
});

async function handleTabRemoved(tabId) {
  await ensureStateRestored();
  if (!session.isMonitoring || session.tabId !== tabId) return;
  debugLog('[Background] YouTube tab was closed, auto-stopping monitoring');
  await autoStopMonitoring('YouTubeタブが閉じられました');
}

// YouTube の SPA 遷移を拾う（#24）。
//
// 以前は content script が document.body 全体を MutationObserver で購読して
// location.href の変化を見ていた。watch ページの DOM は再生時間・視聴回数・
// 関連動画と絶え間なく動くので、拡張機能がやっていることの中で
// いちばん高価な処理だった。ここなら**ページ側の負荷はゼロ**で同じ判定ができる。
//
// changeInfo.url が届くのは host_permissions を持つタブ（= youtube.com）だけ。
// 権限を絞っても（#40）この経路は保たれる
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  handleTabUpdated(tabId, changeInfo.url).catch(error =>
    debugError('[Background] Error handling tab update:', error));
});

async function handleTabUpdated(tabId, url) {
  await ensureStateRestored();

  const videoId = extractVideoIdFromUrl(url);

  // 監視中のタブが別の配信へ動いたら、セッションはここで畳む。
  // 突き合わせは reconcile ただ1つに任せる（根本原因A）。
  // 'changed' は「同じタブで動画IDが変わった」の意味で、URLから動画IDが
  // 読めないとき（トップページなど）は videoId が null になり 'same' に落ちる
  if (reconcile(tabId, videoId) === 'changed') {
    debugLog('[Background] Video changed by SPA navigation:', session.videoId, '->', videoId);
    // autoStopMonitoring ではなく stopBackgroundMonitoring を使う。
    // 遷移は「停止」ではなく「切り替え」で、この直後に content script が
    // 新しい動画で開始し直す。popup へ「自動停止しました」と流すと、
    // すぐ再開するのに停止の通知だけが残る（畳み方は同じで、
    // 保存待ちの flush も含む）
    await stopBackgroundMonitoring();
  }

  // content script は自分では遷移に気付けない。ここから知らせる。
  // 応答は待たない（片道）。dom-chat.js が居るフレームにも配られるが、
  // 知らない action として黙って落ちる
  chrome.tabs.sendMessage(tabId, { action: 'pageNavigated', videoId }).catch(() => {});
}

// === 番人（chrome.alarms、1分周期） =========================================
// MV3 の Service Worker は約30秒アイドルで終了し、setTimeout はSWごと消える（#37）。
// APIモードの quota リトライ（60秒待ち）はこの上限を超えるため、一度 quota を
// 踏むと popup を開き直すまでポーリングが再開しなかった。
// alarms は Service Worker の外にあるので、終了していても起こしてくれる。
// リリース済みの拡張機能では alarm の最小周期は1分。これより短くはできない
const WATCHDOG_ALARM = 'monitoring-watchdog';
const WATCHDOG_PERIOD_MINUTES = 1;

// DOMモードで「コメントが来ていない」と判断するまでの時間。
// 静かな配信で無駄に再注入しない程度に長く、YouTube が #items を作り直して
// MutationObserver が外れた（#2）ことに気付ける程度に短く
const DOM_SILENCE_LIMIT_MS = 3 * 60 * 1000;

// 立て直しの間隔。静かな配信では沈黙が続くので、これが無いと
// 1分ごとに注入し直すことになる
let lastDomRecoveryAt = 0;

function startWatchdog() {
  try {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
  } catch (error) {
    debugError('[Background] Failed to create watchdog alarm:', error);
  }
}

async function stopWatchdog() {
  try {
    await chrome.alarms.clear(WATCHDOG_ALARM);
  } catch (error) {
    debugError('[Background] Failed to clear watchdog alarm:', error);
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name !== WATCHDOG_ALARM) return;
  runWatchdog().catch(error => debugError('[Background] Watchdog failed:', error));
});

// 最後にコメントを保存した時刻。IndexedDB の meta が持っているので、
// Service Worker が終了しても残る（メモリに持つと、番人に起こされるたびに
// 「たったいま始まった」ことになって沈黙を測れない）
async function lastCommentAt() {
  try {
    const videos = await store.listVideos();
    const meta = videos.find(video => video.videoId === session.videoId);
    if (meta?.updatedAt) return meta.updatedAt;
  } catch (error) {
    debugError('[Background] Watchdog could not read last comment time:', error);
  }
  return session.startedAt || Date.now();
}

async function runWatchdog() {
  // 終了から復帰した直後ならここで状態が戻り、APIモードのポーリングも再開する
  await ensureStateRestored();

  if (!session.isMonitoring) {
    await stopWatchdog();
    return;
  }

  if (session.chatMode === 'api') {
    // 「動いているべきなのにタイマーが無い」なら再開する（#8 #37）
    if (isPollingAlive()) return;
    debugLog('[Background] 🐕 Polling timer is gone - restarting');
    startPollingLoop();
    return;
  }

  if (session.chatMode === 'dom') {
    // DOMモードは dom-chat.js が送ってくる。届かなくなったら注入し直して
    // 全件スキャンさせる（MutationObserver が外れたケース = #2）
    const silentFor = Date.now() - await lastCommentAt();
    if (silentFor < DOM_SILENCE_LIMIT_MS || session.tabId === null) return;
    if (Date.now() - lastDomRecoveryAt < DOM_SILENCE_LIMIT_MS) return;
    lastDomRecoveryAt = Date.now();
    debugLog('[Background] 🐕 No comments for', Math.round(silentFor / 1000),
      's - re-injecting dom-chat.js');
    await injectDomChat(session.tabId);
    requestInitialSweep(session.tabId);
  }
}

// Video IDからLive Chat IDを取得
async function getLiveChatIdFromVideo(videoId) {
  try {
    const result = await chrome.storage.local.get(['youtubeApiKey', 'chatMode']);
    const apiKey = result.youtubeApiKey;

    // DOMモードではAPIキー不要なのでスキップ
    if (!apiKey) {
      if (result.chatMode === 'dom' || session.chatMode === 'dom') {
        debugLog('[Background] DOM mode: skipping API key check for getLiveChatIdFromVideo');
        return { liveChatId: null };
      }
      throw new Error('API key not found');
    }
    
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.append('part', 'liveStreamingDetails');
    url.searchParams.append('id', videoId);
    url.searchParams.append('key', apiKey);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`YouTube API Error: ${errorData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.items && data.items.length > 0) {
      const video = data.items[0];
      debugLog('[Background] Video data:', { 
        id: video.id, 
        hasLiveStreamingDetails: !!video.liveStreamingDetails,
        liveStreamingDetails: video.liveStreamingDetails
      });
      
      const liveStreamingDetails = video.liveStreamingDetails;
      if (liveStreamingDetails && liveStreamingDetails.activeLiveChatId) {
        debugLog('[Background] Live chat ID found via API:', liveStreamingDetails.activeLiveChatId);
        return { liveChatId: liveStreamingDetails.activeLiveChatId };
      } else {
        debugLog('[Background] Video is not currently live streaming or has no active live chat');
      }
    } else {
      debugLog('[Background] No video data found for ID:', videoId);
    }
    
    return { liveChatId: null };
    
  } catch (error) {
    debugError('[Background] Error getting live chat ID from video:', error);
    
    // エラー分析して詳細情報をポップアップに送信
    const errorAnalysis = analyzeError(error);
    notifyPopupOfError(errorAnalysis);
    
    throw error;
  }
}

// ポップアップにエラー詳細を通知する機能。
// ポートなので「開いていない」は例外ではなく、送り先が0本というだけ
function notifyPopupOfError(errorAnalysis) {
  if (!isPopupOpen()) {
    debugLog('[Background] No popup open; error details not shown');
    return;
  }
  notifyPopup({
    action: 'showDetailedError',
    errorInfo: errorAnalysis
  });
  debugLog('[Background] Error details sent to popup');
}

// コメントフィルターを設定
async function setCommentFilters(filters) {
  debugLog('[Background] Setting comment filters:', filters);
  
  const normalized = normalizeCommentFilters(filters);
  // 正は storage.local ただ1つ。読むのは popup（決定1で SW 側の読み手が消えた）。
  // セッションに写しを持つと、また「同じことの正が2か所」に戻る
  await chrome.storage.local.set({ commentFilters: normalized });

  return { success: true, filters: normalized };
}

// コメントフィルターの状態を取得
async function getCommentFilters() {
  const result = await chrome.storage.local.get(['commentFilters']);
  const commentFilters = normalizeCommentFilters(result.commentFilters);
  
  return { success: true, filters: commentFilters };
}

// 古いコメント履歴をクリーンアップ
async function cleanupOldCommentHistories() {
  try {
    debugLog('[Background] Starting comments history cleanup');

    // 監視中の動画を守るには currentVideoId が要る。復元より先に走ると
    // 「いま見ている配信の履歴」を消してしまうので、必ず待ってから始める
    await ensureStateRestored();

    const videos = await store.listVideos();  // 更新が新しい順
    debugLog('[Background] Found', videos.length, 'comment histories');

    // 監視中の動画は更新時刻に関わらず必ず保護する
    const protectedVideoId = session.videoId;
    const ordered = videos.slice().sort((a, b) => {
      if (a.videoId === protectedVideoId) return -1;
      if (b.videoId === protectedVideoId) return 1;
      return b.updatedAt - a.updatedAt;
    });

    // 新しい順に MAX_HISTORY_VIDEOS 件だけ残す。
    // コメント・アバター・メタは store.dropVideo が対で消すので、
    // 片方だけ残る（#6 の形の）取りこぼしが起きようがない
    for (const video of ordered.slice(MAX_HISTORY_VIDEOS)) {
      await store.dropVideo(video.videoId);
      debugLog('[Background] Removed old history:', video.videoId);
    }

    // 残したぶんは保持枠の上限に収める（旧データを移行した直後など、
    // 追記を経ずに上限を超えていることがある）
    for (const video of ordered.slice(0, MAX_HISTORY_VIDEOS)) {
      const removed = await store.trim(video.videoId);
      if (removed.primary || removed.bulk) {
        debugLog('[Background] Trimmed oversized history:', video.videoId, removed);
      }
    }

    debugLog('[Background] Cleanup completed');
  } catch (error) {
    debugError('[Background] Error during cleanup:', error);
  }
}

// popup へ渡すコメントを読む。
// 特別コメント（primary）を先に確保してから、残りの枠を bulk の直近で埋める。
// popup 側の上限に当たっても特別コメントは押し出されない（決定3）。
//
// bucket に 'primary' を渡すと primary だけを返す。popup の既定はこちらで、
// メンバー・一般（bulk）は popup が必要になったとき IndexedDB から直接引く（決定4）。
// 数万件をメッセージの構造化クローンで往復させないため
async function readCommentsForPopup(videoId, bucket = null) {
  // 上限は shared/store.js が正（popup も同じ値を見る）。ここで束縛せず毎回引く
  const limit = store.MAX_COMMENTS_TO_POPUP;
  const primary = await store.read(videoId, { bucket: 'primary', limit });
  if (bucket === 'primary') return primary;

  const room = limit - primary.length;
  const bulk = room > 0 ? await store.read(videoId, { bucket: 'bulk', limit: room }) : [];
  return primary.concat(bulk).sort((a, b) => a.seq - b.seq);
}

// コメント履歴を取得（Video ID別）
async function getCommentsHistory(videoId = null, bucket = null) {
  await ensureStateRestored();
  // デバウンス中の未保存分を反映してから読み出す
  await flushCommentsHistory();

  const targetVideoId = videoId || session.videoId;
  debugLog('[Background] getCommentsHistory for', targetVideoId);

  if (!targetVideoId) {
    debugLog('[Background] No video ID provided, returning empty history');
    return { success: true, comments: [], avatars: {} };
  }

  try {
    const comments = await readCommentsForPopup(targetVideoId, bucket);
    // 監視中の動画のアバターはメモリのマップが最新（保存待ちを含む）
    // 監視中の動画のアバターはメモリのマップが最新（保存待ちを含む）。
    // popup へ渡すのは URL だけで、保持枠は SW と IndexedDB の中の持ち物
    const avatars = avatarUrlsOf(targetVideoId === session.videoId
      ? session.avatarsByAuthor
      : await store.readAvatars(targetVideoId));

    debugLog('[Background] Retrieved', comments.length, 'comments for video', targetVideoId);
    return { success: true, comments, avatars };
  } catch (error) {
    debugError('[Background] Error getting comments history:', error);
    return { success: true, comments: [], avatars: {} };
  }
}

// 自動監視停止機能
async function autoStopMonitoring(reason) {
  debugLog('[Background] Auto-stopping monitoring:', reason);
  
  try {
    // 通常の監視停止処理を実行
    await stopBackgroundMonitoring();
    
    // 自動停止の理由をログに記録
    debugLog('[Background] Monitoring auto-stopped:', reason);
    
    // ポップアップが開いている場合に通知（開いていなければ送り先が無いだけ）
    notifyPopup({
      action: 'monitoringAutoStopped',
      reason: reason
    });
    
    return { success: true, reason: reason };
  } catch (error) {
    debugError('[Background] Error during auto-stop:', error);
    return { success: false, error: error.message };
  }
}
