// コメントの型と正規化を1か所に集めたモジュール（再設計の決定7）。
//
// これまで「APIモードのコメント」と「DOMモードのコメント」は最後まで合流せず、
// Service Worker・popup・content script の3か所で別々に正規化されていた。
// 新機能のたびに2回実装が要り、片方だけ直すと片肺のバグになる
// （docs/audit-2026-09.md の根本原因E）。ここが唯一の変換口になる。
//
// 【触るときの注意】
// - このファイルは二重注入ガードで包まないこと。dom-chat.js より先に読まれる
//   別ファイルなので、ガードの中に入れると Service Worker と popup から見えなくなる
// - 代入先は self。window ではない（Service Worker に window は無い）
// - 全体を即時実行関数で包んでいるのは、読み込み方が環境ごとに違うため。
//   content script では dom-chat.js と、importScripts では service-worker.js と
//   同じスコープを共有するので、トップレベルに const を置くと名前がぶつかる
// - 実行時の依存は増やさない。ビルドも不要のまま（3環境から素のスクリプトとして読む）
//
// 読み込み方:
//   Service Worker : importScripts('../shared/comment.js')
//   content script : manifest の content_scripts[].js の先頭
//   popup / options: <script src="../shared/comment.js"> を先に置く

(function (global) {

  // === フィルター ==========================================================
  // 役割（配信者/モデレーター/メンバー/一般）とは別に、スーパーチャットと
  // メンバーシップのイベントを独立した軸として扱う。スパチャは一般視聴者も
  // 投げられるので、役割だけで絞ると取りこぼす。
  const DEFAULT_COMMENT_FILTERS = {
    owner: true,
    moderator: true,
    sponsor: true,
    normal: true,
    superchat: true,
    membership: true
  };

  // 表示・集計で回す順番。既定値の宣言順がそのまま正になる
  const FILTER_KEYS = Object.keys(DEFAULT_COMMENT_FILTERS);

  // 旧バージョンが保存したフィルターには superchat / membership が無い。
  // 欠けているキーは既定値で補い、想定外のキーは捨てる
  function normalizeCommentFilters(filters) {
    const normalized = { ...DEFAULT_COMMENT_FILTERS };
    if (filters && typeof filters === 'object') {
      for (const key of FILTER_KEYS) {
        if (typeof filters[key] === 'boolean') normalized[key] = filters[key];
      }
    }
    return normalized;
  }

  // 種別が付いているものは種別で、通常のコメントは役割で絞る
  function isCommentEnabled(kind, role, filters) {
    if (kind === 'superchat' || kind === 'supersticker') return filters.superchat;
    if (kind === 'membership' || kind === 'gift') return filters.membership;
    if (role === 'owner')     return filters.owner;
    if (role === 'moderator') return filters.moderator;
    if (role === 'member')    return filters.sponsor;
    return filters.normal;
  }

  // 正準形のコメント1件から、それが属するフィルターキーを引く。
  // 絞り込みと件数の集計はどちらもこれを通す（母集団が食い違わないように）
  function filterKeyOf(comment) {
    const kind = comment.kind || 'text';
    if (kind === 'superchat' || kind === 'supersticker') return 'superchat';
    if (kind === 'membership' || kind === 'gift') return 'membership';
    switch (comment.role) {
      case 'owner':     return 'owner';
      case 'moderator': return 'moderator';
      case 'member':    return 'sponsor';
      default:          return 'normal';
    }
  }

  // === 保持枠（決定3） =====================================================
  // 枠の判定は「役割」でも「種別」でもなく流量。メンバーは製品の意味づけとしては
  // 特別だが、大きな配信では一般と同じ流量になるので bulk に入れる。
  // 実際に枠を分けて保存するのは IndexedDB 移行（フェーズ3）からだが、
  // 正準形の一部なのでここで決める
  function bucketOf(comment) {
    const kind = comment.kind || 'text';
    if (kind !== 'text') return 'primary';
    if (comment.role === 'owner' || comment.role === 'moderator') return 'primary';
    return 'bulk';
  }

  // === APIモードの読み取り =================================================
  // APIのメッセージ種別 → 拡張機能側の kind。
  // ここに無いイベント（チャット終了・削除済み・ギフト受領など）は表示対象外
  const KIND_BY_API_TYPE = {
    textMessageEvent: 'text',
    superChatEvent: 'superchat',
    superStickerEvent: 'supersticker',
    newSponsorEvent: 'membership',
    memberMilestoneChatEvent: 'membership',
    membershipGiftingEvent: 'gift'
  };

  // 表示できない種別は null。type を持たない古い履歴はテキスト扱いにする
  function apiCommentKind(item) {
    const type = item?.snippet?.type;
    if (!type) return 'text';
    return KIND_BY_API_TYPE[type] || null;
  }

  function apiCommentRole(authorDetails) {
    if (authorDetails?.isChatOwner) return 'owner';
    if (authorDetails?.isChatModerator) return 'moderator';
    if (authorDetails?.isChatSponsor) return 'member';
    return 'normal';
  }

  // APIの snippet から本文・金額・イベント文言を取り出す。
  // 種別ごとに詳細の入れ物が違い、displayMessage が無いものもある
  function apiDetailOf(kind, snippet) {
    const fallback = snippet.displayMessage || '';

    if (kind === 'superchat') {
      const details = snippet.superChatDetails || {};
      return {
        message: details.userComment || '',
        amountText: details.amountDisplayString || null,
        eventText: null
      };
    }

    if (kind === 'supersticker') {
      const details = snippet.superStickerDetails || {};
      return {
        message: details.superStickerMetadata?.altText || fallback,
        amountText: details.amountDisplayString || null,
        eventText: 'スーパーステッカー'
      };
    }

    if (kind === 'membership') {
      const milestone = snippet.memberMilestoneChatDetails;
      const newSponsor = snippet.newSponsorDetails;
      if (milestone) {
        const level = milestone.memberLevelName ? ` · ${milestone.memberLevelName}` : '';
        return {
          message: milestone.userComment || '',
          amountText: null,
          eventText: `${milestone.memberMonth}か月連続のメンバー${level}`
        };
      }
      const level = newSponsor?.memberLevelName ? ` · ${newSponsor.memberLevelName}` : '';
      const label = newSponsor?.isUpgrade ? 'メンバーシップをアップグレード' : '新規メンバー';
      return { message: '', amountText: null, eventText: `${label}${level}` };
    }

    if (kind === 'gift') {
      const details = snippet.membershipGiftingDetails;
      const level = details?.giftMembershipsLevelName ? ` · ${details.giftMembershipsLevelName}` : '';
      const count = details?.giftMembershipsCount;
      return {
        message: '',
        amountText: null,
        eventText: count ? `メンバーシップギフト ${count}個${level}` : 'メンバーシップギフト'
      };
    }

    return { message: fallback, amountText: null, eventText: null };
  }

  // === 検索用の正規化 ======================================================
  // 目に見えないのに検索を外す文字。YouTubeのライブチャットからコメントを
  // コピーすると、先頭などにゼロ幅スペースや方向制御文字が紛れ込む。
  // 貼り付けた見た目は同じでも includes() が外れ、1件もヒットしなくなる
  // （入力欄が空に見えるのに0件になるのも、消し残ったこれが原因）
  const INVISIBLE_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

  // 検索キーワードとコメントを比べる前に文字種を揃える。
  // IMEで打つと「！」「１」「ｶﾅ」のような全角・半角の揺れが混ざり、
  // 見た目が同じでも includes() が外れる（前後の空白も同じ理由で落とす）。
  // 空白の連なりを1個に潰すのは、チャットから名前ごとコピーしたときに
  // 区切りの改行・全角空白の違いで外れないようにするため
  function normalizeForSearch(text) {
    return String(text ?? '')
      .normalize('NFKC')
      .replace(INVISIBLE_CHARS, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 検索対象の文字列を組み立てる。取り込み時に1度だけ呼ぶ（#23）。
  // 検索の1文字目で全件ぶんの NFKC 正規化が同期的に走るのを避けるため
  function buildSearchText(comment) {
    return normalizeForSearch(
      [comment.displayName, comment.message, comment.eventText, comment.amountText]
        .filter(Boolean).join('\n')
    );
  }

  // コメント1件ぶんの検索対象文字列。正準形は取り込み時に searchText を持つが、
  // 更新前に保存された履歴には無いので、そのときだけ遅延生成して持たせる
  function searchTextOf(comment) {
    if (typeof comment.searchText === 'string') return comment.searchText;
    if (comment._searchText === undefined) comment._searchText = buildSearchText(comment);
    return comment._searchText;
  }

  // === ID =================================================================
  // IDは「同じコメントなら再スキャンでもリロード後でも同じ値」であることが条件。
  // 位置ではなく内容＋出現回数から作るので、DOMの間引きで値がずれない。
  const SEP = '\u0000';

  function commentKeyOf(kind, displayName, detail, timestampText) {
    // テキストコメントのキーは旧版と同じ形のまま保つ。拡張機能を更新しても
    // キーが変わらないので、旧IDを再計算して突き合わせられる（legacyCommentIdFor）
    let key = `${displayName}${SEP}${detail.message || ''}${SEP}${timestampText || ''}`;
    if (kind !== 'text') {
      // 本文なしのスパチャは金額しか違いが無いので、キーに混ぜて衝突を避ける
      key += `${SEP}${kind}${SEP}${detail.amountText || ''}${SEP}${detail.eventText || ''}`;
    }
    return key;
  }

  // 旧版と同じ多項式ハッシュ（32bit）。旧IDの再計算にも使う
  function hashPoly32(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
  }

  // 系統の違うハッシュ（FNV-1a 32bit）。2本が同時に衝突しないとIDは衝突しないので、
  // 実質64bitぶんの空間になる
  function hashFnv32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0;
  }

  const hex32 = h => (h >>> 0).toString(16).padStart(8, '0');

  // 32bitハッシュは誕生日問題から約65,000通で衝突確率50%に達し、賑わった配信の
  // 数時間で到達しうる（#9）。衝突した2件目は重複として黙って消えるので、
  // 系統の違う2本を連結して衝突を実質ゼロにする
  function commentIdFor(key, occurrence) {
    return `dom2_${hex32(hashPoly32(key))}${hex32(hashFnv32(key))}_${occurrence}`;
  }

  // 旧形式のID。更新前に保存された履歴と突き合わせるためだけに使う。
  // これを残さないと、更新直後の全件スキャンで保存済みのコメントが
  // 「新しいID＝別のコメント」として二重に積まれる
  function legacyCommentIdFor(key, occurrence) {
    return `dom_${hashPoly32(key)}_${occurrence}`;
  }

  // IDを持たないコメント（IDが付く前に保存された履歴など）にも、
  // 内容から決まるIDを与える。同じ1件を2度受け取っても同じ値になるので、
  // 重複判定がIDだけで完結する
  function fallbackCommentId(fields) {
    const key = commentKeyOf(fields.kind, fields.displayName, fields, fields.publishedAt || '');
    return `gen_${hex32(hashPoly32(key))}${hex32(hashFnv32(key))}`;
  }

  // === 正準形 =============================================================
  // {
  //   v, id, bucket, kind, role, displayName, message,
  //   amountText, eventText, stickerUrl, avatarUrl, publishedAt, searchText
  // }
  const SCHEMA_VERSION = 1;

  // API item / DOMモードのメッセージ / 旧保存形式の3入力を正準形に変換する。
  // ここが唯一の変換口。取得モードの違いはこの関数から先へは漏れない
  function normalizeComment(raw) {
    const source = raw || {};
    // APIモードのコメントだけが authorDetails を持つ。スパチャやメンバー加入は
    // 本文が空のことがあるので、本文の有無では判定しない
    const fields = source.authorDetails ? fromApiItem(source) : fromDomMessage(source);

    const comment = {
      v: SCHEMA_VERSION,
      id: source.id || fallbackCommentId(fields),
      bucket: bucketOf(fields),
      kind: fields.kind,
      role: fields.role,
      displayName: fields.displayName,
      message: fields.message,
      amountText: fields.amountText,
      eventText: fields.eventText,
      stickerUrl: fields.stickerUrl,
      avatarUrl: fields.avatarUrl,
      publishedAt: fields.publishedAt,
      searchText: ''
    };
    comment.searchText = buildSearchText(comment);
    return comment;
  }

  function fromApiItem(item) {
    const snippet = item.snippet || {};
    // 表示できない種別（チャット終了・削除済みなど）もテキスト扱いで通す。
    // 取り込むかどうかを決めるのは apiCommentKind() を見る呼び出し側の責任
    const kind = apiCommentKind(item) || 'text';
    const detail = apiDetailOf(kind, snippet);
    return {
      kind,
      role: apiCommentRole(item.authorDetails),
      displayName: item.authorDetails?.displayName || '',
      message: detail.message,
      amountText: detail.amountText,
      eventText: detail.eventText,
      // APIモードにステッカー画像は無い（URLが返ってこない）
      stickerUrl: null,
      avatarUrl: item.authorDetails?.profileImageUrl || null,
      publishedAt: snippet.publishedAt || null
    };
  }

  function fromDomMessage(msg) {
    return {
      // kind が無いのは旧バージョンの dom-chat.js が送ったテキストコメント
      kind: msg.kind || 'text',
      role: msg.role || 'normal',
      displayName: msg.displayName || '',
      message: msg.message || '',
      amountText: msg.amountText || null,
      eventText: msg.eventText || null,
      stickerUrl: msg.stickerUrl || null,
      avatarUrl: msg.avatarUrl || null,
      publishedAt: msg.publishedAt || null
    };
  }

  // === HTML ===============================================================
  // Service Worker には document が無く、popup / options で document を使うと
  // 外部由来の文字列を innerHTML に通すことになる（#27）。3か所にあった実装を
  // 正規表現版に統一する。消費側はどこも textContent に入れるだけなので、
  // そもそも HTML のパースは要らない
  function stripHtmlTags(html) {
    if (!html) return '';
    return String(html).replace(/<[^>]*>/g, '').trim();
  }

  // 属性値に差し込む文字列のエスケープ。textContent → innerHTML で作る
  // escapeHtml はクォートを escape しないため、属性値に使うと外れる（#25）。
  // 描画そのものの作り直しはフェーズ5なので、それまでの暫定
  const ATTR_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeAttr(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ATTR_ESCAPES[ch]);
  }

  global.YTF = {
    SCHEMA_VERSION,
    DEFAULT_COMMENT_FILTERS,
    FILTER_KEYS,
    KIND_BY_API_TYPE,
    normalizeCommentFilters,
    isCommentEnabled,
    filterKeyOf,
    bucketOf,
    apiCommentKind,
    apiCommentRole,
    apiDetailOf,
    normalizeComment,
    normalizeForSearch,
    buildSearchText,
    searchTextOf,
    commentKeyOf,
    commentIdFor,
    legacyCommentIdFor,
    stripHtmlTags,
    escapeAttr
  };

})(self);
