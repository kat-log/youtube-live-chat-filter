// デバッグモードによる統一ログ関数
let debugMode = false;

// デバッグモード設定を取得
async function loadDebugMode() {
  try {
    const result = await chrome.storage.local.get(['debugMode']);
    debugMode = result.debugMode || false;
  } catch (error) {
    debugError('[Popup] Failed to load debug mode:', error);
  }
}

// テーマの適用は shared/theme.js が正（#15）。popup.html の <head> から
// 読み込んでいるので、**この popup.js が走り出す時点でもう塗り終わっている**。
// 以前はここに loadTheme() を持ち、completeBasicInitialization の Promise.all
// （Service Worker の起床待ちの後ろ）で呼んでいたため、ライトテーマの利用者は
// コールドスタート時に最悪十数秒のあいだ真っ黒な popup を見せられていた
const { applyTheme } = self.YTFTheme;

// 生成中のコントローラ。ストレージ変更を再描画へ橋渡しするために保持する
let popupController = null;

// ストレージ変更時に表示設定をリアルタイム反映。
// ドロワー・オプション画面・別ウィンドウのどこで変えても、経路はここ1本に集約する
chrome.storage.onChanged.addListener((changes) => {
  if (changes.theme) {
    const newTheme = applyTheme(changes.theme.newValue);
    const toggle = document.getElementById('dark-mode-toggle');
    if (toggle) toggle.checked = (newTheme === 'dark');
  }

  if (changes.timeHour12 || changes.timeShowSeconds) {
    popupController?.applyTimeSettings({
      hour12: changes.timeHour12?.newValue,
      showSeconds: changes.timeShowSeconds?.newValue
    });
  }
});

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

// コメントの型・正規化・検索用の文字列は shared/comment.js が正（再設計の決定7）。
// popup.html で popup.js より先に読み込んでいる。
//
// フィルターの軸は「役割4種」＋「種別2種」。スーパーチャットやメンバー加入は
// 一般視聴者・メンバーのどちらからも飛んでくるので、役割とは別枠で数えて絞る
const {
    FILTER_KEYS,
    filterKeyOf,
    isCommentEnabled,
    normalizeComment,
    normalizeForSearch,
    searchTextOf,
    stripHtmlTags
} = self.YTF;

const FILTER_PRESETS = {
    special: { owner: true,  moderator: true,  sponsor: false, normal: false, superchat: true,  membership: true  },
    all:     { owner: true,  moderator: true,  sponsor: true,  normal: true,  superchat: true,  membership: true  },
    none:    { owner: false, moderator: false, sponsor: false, normal: false, superchat: false, membership: false }
};

// popup がメモリに載せるコメントの上限。Service Worker が1回に渡してくる件数と
// 同じ値を shared/store.js から引く（#33）。以前は popup が 10,000、SW が 2,000 と
// 5倍食い違っていて、popup を開き直すと差分が黙って消えていた。
// 起動時に載せるのは primary だけで、bulk は必要になってからこの枠の残りに読む（決定4）
const MAX_COMMENTS_IN_MEMORY = self.YTFStore.MAX_COMMENTS_TO_POPUP;

// 保存の入口は shared/store.js が正（決定2）。popup が直接引くのは
// bulk 枠（メンバー・一般）だけで、それ以外は Service Worker 越しに読む。
// 移行（storage.local -> IndexedDB）は migrateFromLocal() を呼んだ環境だけが
// 走る作りなので、popup からは絶対に呼ばないこと。Service Worker と同時に
// 走らせると同じ履歴が二重に積まれる（フェーズ3の制約）
const store = self.YTFStore;

// bulk 枠に入る保持枠のフィルターキー（決定3）。この2つだけは
// メモリに載っていないことがあるので、件数の出し方が他と違う
const BULK_FILTER_KEYS = ['sponsor', 'normal'];

// 下端判定の許容誤差（px）
const SCROLL_BOTTOM_THRESHOLD = 5;

const ROLE_LABELS = {
    owner:     ['配信者',       'role-owner'],
    moderator: ['モデレーター', 'role-moderator'],
    member:    ['メンバー',     'role-sponsor'],
    normal:    ['一般',         'role-normal']
};

// 種別バッジ。役割バッジ（王冠など）とは別に、行の性格を1文字で示す
const KIND_ICONS = {
    superchat:    ['\u{1F4B0}', 'スーパーチャット'],
    supersticker: ['\u{1F4B0}', 'スーパーステッカー'],
    membership:   ['\u{2728}',  'メンバーシップ'],
    gift:         ['\u{1F381}', 'メンバーシップギフト']
};

// 画像の配信ホスト。https の前方一致だけだと、外部由来のURLを img の src に
// 載せる以上「任意のHTTPS先へリクエストが飛ぶ」構造が残る（#26）。
// 先頭が '.' のエントリは下位ドメインをまとめて許可する。
//
// アバターは YouTube 側がホスト名を増やす（yt3 -> yt4 など）ことがあり、
// 完全一致で列挙すると増えた日に全員のアバターが黙って消える。
// ステッカーは dom-chat.js が組み立てるURLと1対1なので完全一致のままにする
const AVATAR_IMAGE_HOSTS = ['.ggpht.com', '.googleusercontent.com'];
const STICKER_IMAGE_HOSTS = ['lh3.googleusercontent.com', 'yt3.ggpht.com'];

// DOMモードで「チャットを読み取れているか」（フェーズ7）。
// dom-chat.js が持っている状態の語と1対1で対応させる。
//
// 読めているときは点だけを出し、読めていないときだけ文言も出す。
// いちばん危ないのは「セレクタが変わって無言で0件になる」形で、
// これまでは静かな配信と見分ける手段が利用者側に無かった（根本原因F）
const CHAT_HEALTH_VIEW = {
    watching: {
        level: 'ok', text: '',
        title: 'ライブチャットを監視しています（まだコメントが流れていません）'
    },
    reading: {
        level: 'ok', text: '',
        title: 'ライブチャットを読み取れています'
    },
    searching: {
        level: 'warn', text: 'チャットを探しています',
        title: 'ライブチャットの一覧をまだ見つけられていません'
    },
    'no-chat': {
        level: 'error', text: 'チャットが見つかりません',
        title: 'ライブチャットの一覧が見つかりませんでした。ページを再読み込みしてください'
    },
    unreadable: {
        level: 'error', text: 'チャットを読み取れません',
        title: 'チャットの行はありますが、内容を読み取れていません。' +
               'YouTube側のDOM変更で拡張機能が対応できていない可能性があります'
    }
};

class PopupController {
    constructor() {
        this.isMonitoring = false;
        this.comments = [];
        // this.comments に入っているコメントのID。重複判定はこれだけを見る（#3）
        this.commentIds = new Set();
        // 描画済みの行。id -> { element, author, displayName }。
        // 1コメントにつき1回だけ作り、以後は hidden を切り替えるだけにする（#22）
        this.rows = new Map();
        // 区切り線を消す「最後に見えている行」。:last-child は hidden を見ない
        this.lastVisibleRow = null;
        // bulk 枠（メンバー・一般）をメモリへ読みにいったか（決定4）
        this.bulkLoaded = false;
        // 保存されているのに、まだメモリへ載せていない bulk の件数。
        // 0 でない間は「メンバー」「一般」の件数を数字で出せない
        this.unloadedBulk = 0;
        // DOMモードのアバターURL（発言者名 -> URL）。背景側から受け取る
        this.avatarsByAuthor = {};
        this.currentTab = null;
        this.currentVideoId = null;
        // Service Worker との唯一の通信路（フェーズ6b）。requestBackground の
        // 応答待ちは requestId をキーに pendingRequests が持つ
        this.port = null;
        this.pendingRequests = new Map();
        this.lastRequestId = 0;
        this.reconnecting = false;
        this.initializationComplete = false;
        
        // 個別フィルターの状態
        this.commentFilters = { ...FILTER_PRESETS.all };
        
        // ユーザーフィルタリング用の状態
        this.selectedUser = null; // 絞り込み対象のユーザー名（null = 全ユーザー表示）

        // キーワード検索フィルタリング用の状態。
        // 入力そのまま（表示用）と、正規化済みの比較用を分けて持つ
        this.searchKeyword = '';
        this.searchQuery = '';
        this._searchDebounceTimer = null;

        // 取得モード
        this.chatMode = 'api';
        this.domModeNeedsReload = false;

        // 自動スクロール追従フラグ（ユーザーが意図的に上スクロールしていない限りtrue）
        this.autoScroll = true;

        // 時刻表示の設定。既定は従来どおり「24時間表記・秒あり」
        this.timeHour12 = false;
        this.timeShowSeconds = true;
        
        debugLog('[YouTube Special Comments] Popup controller starting...');
        this.initializeElements();
        this.attachEventListeners();
        // チャットの読み取り状態は、DOMモードで監視しているときだけ出す。
        // 初期状態を markup 任せにせず、ここで明示的に消しておく
        this.updateChatHealth(null);

        // Service Worker へのポートは、他の何よりも先に張る（フェーズ6b）。
        // 繋がった時点から新着が届くので、以前あった「ping を8回投げて
        // Service Worker の起床を待つ」段取り（旧 waitForServiceWorker）は要らない
        this.connectToBackground();

        this.runInitialization();
    }

    // 初期化プロセス
    async runInitialization() {
        try {
            debugLog('[YouTube Special Comments] 🚀 Starting comprehensive initialization process...');

            // Step 1: 基本設定の初期化
            this.showInitializationStatus('Step 1/2: 設定を読み込み中...');
            await this.completeBasicInitialization();
            debugLog('[YouTube Special Comments] ✅ Step 1 Complete: Basic initialization done');

            // Step 2: Content Script状態確認と通信テスト
            this.showInitializationStatus('Step 2/2: Content Script通信テスト...');
            const contentScriptReady = await this.checkContentScriptInjection();
            
            if (contentScriptReady) {
                debugLog('[YouTube Special Comments] ✅ Step 2 Complete: Content Script communication established');
                // Step 1で表示されていたエラーパネルをクリア
                this.hideDetailedError();
                this.elements.fixExtensionContainer.style.display = 'none';
                this.showInitializationStatus('初期化完了！');
                await this.delay(500); // 成功メッセージを少し表示
            } else {
                debugWarn('[YouTube Special Comments] ⚠️ Step 2 Warning: Content Script issues detected');
            }
            
            debugLog('[YouTube Special Comments] 🎉 Full initialization process completed');

            // 初期化完了後の最終状態同期：
            // content script が自律的に監視を開始した場合（再注入後の tryDomModeAutoStart）に
            // popup の isMonitoring フラグをバックグラウンドの実態と合わせる
            if (!this.isMonitoring) {
                const finalState = await this.getBackgroundMonitoringState();
                if (finalState.success && finalState.isMonitoring) {
                    this.isMonitoring = true;
                    if (finalState.chatMode) {
                        this.chatMode = finalState.chatMode;
                        this.updateChatModeUI();
                    }
                    this.updateMonitoringButtonStates();
                    this.updateStatus(this.chatMode === 'dom' ? '取得中（DOMモード）' : '取得中');
                }
            }

        } catch (error) {
            debugError('[YouTube Special Comments] ❌ Critical initialization error:', error);
            this.showInitializationStatus('初期化エラーが発生しました');
            
            // フォールバック: 基本的な初期化のみ実行
            await this.emergencyFallbackInitialization();
            
        } finally {
            this.hideInitializationStatus();
            this.initializationComplete = true;

            // チャットを読み取れているか（フェーズ7）。以後の変化は通知で届く。
            // 待たないのは、ここで止まると初期化の完了そのものが遅れるため
            this.refreshChatHealth();

            // 最終診断情報をログ出力
            this.logInitializationSummary();
        }
    }
    
    // 基本設定の初期化（Content Scriptチェックを除く）
    async completeBasicInitialization() {
        // 時刻設定は描画より先に確定させる（履歴復元が下の Promise.all 内で走るため、
        // 並列に混ぜると一瞬だけ旧形式で描かれてそのまま残る）
        await this.loadTimeSettings();

        // フィルターの状態も先に確定させる。bulk 枠を読むかどうかがこれで決まるので
        // （決定4）、履歴復元と並列にすると、順番次第で要らない bulk を読み込む
        await this.loadCommentFilters();

        // 初期状態設定
        this.updateMonitoringButtons(false);
        this.updateMonitoringButtonStates();
        
        // 非同期初期化タスクを並行実行。
        // テーマはここに混ぜない（#15）。この関数は Service Worker との
        // やり取りの後ろに並んでいるので、塗るのがそのぶん遅れる
        await Promise.all([
            this.loadSavedApiKey(),
            this.loadChatMode(),
            this.checkCurrentTab()
        ]);
        
        // DOMモード自動取得
        await this.tryDomAutoStart();
    }
    
    // 緊急時のフォールバック初期化
    async emergencyFallbackInitialization() {
        debugLog('[YouTube Special Comments] 🆘 Running emergency fallback initialization');
        
        try {
            this.updateMonitoringButtons(false);
            this.updateMonitoringButtonStates();
            // 受け口はコンストラクタで張ったポート1本だけ。以前はここと
            // completeBasicInitialization の2か所で onMessage を登録していて、
            // 後者の途中で例外が出るとリスナーが2つになった（#32）。
            // connectToBackground は張り済みなら何もしないので、二重には成り得ない
            this.connectToBackground();

            // 最低限のタブ情報を設定
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.currentTab = tab;
            
            debugLog('[YouTube Special Comments] ✅ Emergency fallback completed');
        } catch (error) {
            debugError('[YouTube Special Comments] ❌ Emergency fallback also failed:', error);
            this.showError('拡張機能の初期化に失敗しました。ブラウザを再起動してください。');
        }
    }
    
    // 初期化サマリーをログ出力
    logInitializationSummary() {
        const summary = {
            timestamp: new Date().toISOString(),
            backgroundConnected: this.port !== null,
            initializationComplete: this.initializationComplete,
            currentTab: this.currentTab ? {
                id: this.currentTab.id,
                url: this.currentTab.url,
                // tabs 権限を外したので（#40）、url は host_permissions が当たる
                // タブ（= youtube.com）でしか読めない。他所のタブでは undefined になる
                isYouTube: this.currentTab.url?.includes('youtube.com') ?? false
            } : null,
            apiKeyLoaded: !!this.elements.apiKeyInput.value,
            filterSettings: this.commentFilters
        };
        
        debugLog('[YouTube Special Comments] 📋 Initialization Summary:', summary);
    }
    
    // === Service Worker との通信（ポート） ==================================
    // chrome.runtime.connect のポート1本で話す（フェーズ6b）。sendMessage と違い、
    //  - 繋がっている間は Service Worker が終了しない（起床を待つ ping が要らない）
    //  - 送った順に届く（新着の差分描画はこれを前提にしている。フェーズ5）
    //  - 切れたら onDisconnect で分かる（「届いたか分からない」が無くなる）
    // ので、以前あった waitForServiceWorker の8回 ping と、
    // タイムアウト＋指数バックオフの retry ヘルパーは丸ごと消えた。

    /**
     * ポートを張る。張り済みなら何もしない。
     * 二重に登録され得ないことが #32（リスナーの二重登録）の答えでもある
     */
    connectToBackground() {
        if (this.port) return this.port;

        const port = chrome.runtime.connect({ name: 'popup' });
        this.port = port;
        port.onMessage.addListener(message => this.handleBackgroundMessage(message));
        port.onDisconnect.addListener(() => this.handleBackgroundDisconnect(port));
        debugLog('[Popup] Connected to service worker');
        return port;
    }

    /**
     * Service Worker へ要求を送り、応答を待つ。
     * 処理側の失敗は { success: false, error } として返ってくる（投げない）。
     * 投げるのは「そもそも繋がらなかった」ときだけ
     */
    requestBackground(message) {
        let port;
        try {
            port = this.connectToBackground();
        } catch (error) {
            return Promise.reject(new Error(`拡張機能に接続できません: ${error.message}`));
        }

        const requestId = ++this.lastRequestId;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            try {
                port.postMessage({ requestId, payload: message });
            } catch (error) {
                this.pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }

    /** ポートから来たものを、要求への応答と片道の通知に振り分ける */
    handleBackgroundMessage(message) {
        if (message && typeof message.requestId === 'number') {
            const pending = this.pendingRequests.get(message.requestId);
            if (!pending) return; // 切断で既に落とした応答が遅れて来た
            this.pendingRequests.delete(message.requestId);
            pending.resolve(message.payload);
            return;
        }

        const request = message || {};
        debugLog('[Popup] Received message:', request.action, 'with', request.comments?.length || 0, 'comments');
        if (request.action === 'newSpecialComments') {
            // formatComment がアバターを引けるよう、コメントより先に取り込む
            Object.assign(this.avatarsByAuthor, request.avatars || {});
            this.addNewComments(request.comments);
        } else if (request.action === 'domChatHealth') {
            this.updateChatHealth(request.health);
        } else if (request.action === 'monitoringAutoStopped') {
            this.handleAutoStop(request.reason);
        } else if (request.action === 'showDetailedError') {
            // DOMモードではAPIキー関連エラーを表示しない
            if (this.chatMode === 'dom' && request.errorInfo?.action === 'setApiKey') {
                return;
            }
            this.showDetailedError(request.errorInfo);
        }
    }

    /**
     * ポートが切れた（拡張機能の再読み込みなど）。
     * 待っている要求はもう応答が来ないので握りつぶさずに落とし、張り直す
     */
    handleBackgroundDisconnect(port) {
        if (this.port !== port) return;
        this.port = null;
        debugWarn('[Popup] Service worker port disconnected');

        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        const error = new Error('Service Worker との接続が切れました');
        for (const entry of pending) entry.reject(error);

        // 張り直しは1回だけ。connect の中で同期的に切られる作りでも回り続けないよう、
        // 再入は弾く（次の要求のときにもう一度 connect される）
        if (this.reconnecting) return;
        this.reconnecting = true;
        try {
            this.connectToBackground();
        } catch (reconnectError) {
            debugWarn('[Popup] Failed to reconnect:', reconnectError.message);
            this.showError('拡張機能の接続が失われました。ポップアップを開き直してください。');
            return;
        } finally {
            this.reconnecting = false;
        }

        // 切れていた間に届かなかったぶんを取りに行く（取りこぼしを残さない）
        this.resyncAfterReconnect().catch(resyncError =>
            debugError('[Popup] Failed to resync after reconnect:', resyncError));
    }

    /**
     * 再接続の直後に、保存済みの履歴から差分を取り込む。
     * 既知の id は addNewComments の Set で落ちるので、
     * 足されるのは切れていた間に来たぶんだけ（描き方は新着と同じ差分追加）
     */
    async resyncAfterReconnect() {
        if (!this.currentVideoId) return;

        const response = await this.requestBackground({
            action: 'getCommentsHistory',
            videoId: this.currentVideoId,
            bucket: 'primary'
        });
        if (response?.success && response.comments?.length) {
            Object.assign(this.avatarsByAuthor, response.avatars || {});
            this.addNewComments(response.comments);
        }

        // 切れている間にチャットの読み取り状態が変わっていることもある
        this.refreshChatHealth();

        // bulk を載せていたなら、そちらも取り直す（載せていないなら要らない。決定4）
        if (!this.bulkLoaded) return;
        const room = MAX_COMMENTS_IN_MEMORY - this.comments.length;
        if (room <= 0) return;
        const bulk = await store.read(this.currentVideoId, { bucket: 'bulk', limit: room });
        if (this.mergeBulkComments(bulk) > 0) this.renderComments();
    }

    // 遅延ユーティリティ
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    
    // Content Script注入状態の確認
    async checkContentScriptInjection() {
        // 既に監視中であればcontent scriptは動作している
        if (this.isMonitoring) {
            debugLog('[YouTube Special Comments] Already monitoring, skipping content script check');
            return true;
        }

        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        if (!isYouTubePage) {
            debugLog('[YouTube Special Comments] Not a YouTube watch or live page, skipping content script check');
            return true;
        }
        
        debugLog('[YouTube Special Comments] Checking content script injection status...');
        
        try {
            // Content Scriptとの通信をテスト
            // 短すぎるとページ読み込み直後の初期化中を「未注入」と誤判定し、
            // 不要な再注入を招くため3秒待つ
            const response = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 3000);
            
            if (response) {
                debugLog('[YouTube Special Comments] ✅ Content script is properly injected');
                return true;
            } else {
                throw new Error('No response from content script');
            }
        } catch (error) {
            debugLog('[YouTube Special Comments] Content script not detected (expected on first use):', error.message);
            
            // 自動回復を試行
            return await this.attemptContentScriptRecovery();
        }
    }
    
    // Content Script回復試行
    async attemptContentScriptRecovery() {
        debugLog('[YouTube Special Comments] 🔄 Attempting content script recovery...');
        this.showInitializationStatus('Content Scriptを修復中...');
        
        try {
            // 1. Service Workerから最後の注入結果を確認
            const injectionResult = await this.requestBackground({
                action: 'getLastInjectionResult'
            });
            
            debugLog('[YouTube Special Comments] Last injection result:', injectionResult);
            
            // 2. 手動でContent Script再注入を要求
            // 対象は現在のタブのみ。全タブに注入すると、正常に動いている
            // 他のYouTubeタブにまで不要な注入を行うことになる
            debugLog('[YouTube Special Comments] Requesting manual content script re-injection...');
            const reinjectResponse = await this.requestBackground({
                action: 'reinjectContentScripts',
                tabId: this.currentTab?.id
            });
            
            if (reinjectResponse && reinjectResponse.success) {
                debugLog('[YouTube Special Comments] ✅ Content script re-injection requested successfully');

                // 3. 再注入後の確認（待機時間を延長: 2秒→3秒）
                await this.delay(3000);

                // pingリトライ（最大3回、1秒間隔）
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const verified = await this.verifyContentScriptAfterRecovery();
                    if (verified) return true;
                    if (attempt < 3) {
                        debugLog(`[YouTube Special Comments] Ping attempt ${attempt} failed, retrying in 1s...`);
                        await this.delay(1000);
                    }
                }

                // 3回試みても応答なし → リロードボタン表示
                this.showContentScriptError();
                return false;
            } else {
                throw new Error('Re-injection request failed');
            }
        } catch (error) {
            debugError('[YouTube Special Comments] ❌ Content script recovery failed:', error);
            this.showContentScriptError();
            return false;
        }
    }
    
    // 回復後のContent Script確認
    async verifyContentScriptAfterRecovery() {
        debugLog('[YouTube Special Comments] Verifying content script after recovery...');
        
        try {
            const response = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 2000);
            
            if (response) {
                debugLog('[YouTube Special Comments] ✅ Content script recovery successful!');
                this.hideInitializationStatus();
                this.hideDetailedError();
                this.elements.fixExtensionContainer.style.display = 'none';
                return true;
            } else {
                throw new Error('Still no response after recovery');
            }
        } catch {
            debugWarn('[YouTube Special Comments] ⚠️ Content script still not responding after recovery');
            // showContentScriptError()は呼び出し元(attemptContentScriptRecovery)で制御
            return false;
        }
    }
    
    // Content Script問題の表示
    showContentScriptError() {
        this.showError('初回インストール後はページのリロードが必要です。以下のボタンで再読み込みしてください。');

        // ボタンをリロードとして設定
        const btn = this.elements.fixExtensionBtn;
        btn.textContent = 'ページを再読み込み';
        btn.dataset.action = 'reload';
        this.elements.fixExtensionContainer.style.display = 'block';

        // 詳細なエラー情報を表示
        this.showDetailedError({
            title: '初回インストール後のリロードが必要です',
            message: 'インストール直後は既存のタブにContent Scriptが読み込まれていません',
            solution: '「ページを再読み込み」ボタンで現在のタブを更新すると解決します。2回目以降は自動的に動作します。',
            action: 'reload',
            severity: 'high'
        });
    }
    
    // 拡張機能修復機能
    async fixExtension() {
        debugLog('[YouTube Special Comments] 🔧 Starting extension repair process...');
        this.elements.fixExtensionBtn.disabled = true;
        this.elements.fixExtensionBtn.textContent = '修復中...';
        this.showInitializationStatus('拡張機能を修復中...');
        
        try {
            // Step 1: Content Script再注入を要求
            debugLog('[YouTube Special Comments] Step 1: Requesting content script re-injection');
            this.showInitializationStatus('Content Scriptを再注入中...');
            
            const reinjectResponse = await this.requestBackground({
                action: 'reinjectContentScripts',
                tabId: this.currentTab?.id
            });
            
            if (!reinjectResponse || !reinjectResponse.success) {
                throw new Error('Content script re-injection failed');
            }
            
            // Step 2: 注入完了を待機
            debugLog('[YouTube Special Comments] Step 2: Waiting for injection to complete');
            this.showInitializationStatus('注入完了を待機中...');
            await this.delay(3000); // 注入処理の完了を待つ
            
            // Step 3: Content Script通信テスト
            debugLog('[YouTube Special Comments] Step 3: Testing content script communication');
            this.showInitializationStatus('通信をテスト中...');
            
            const testResponse = await this.sendTabMessageWithTimeout(this.currentTab.id, {
                action: 'ping'
            }, 3000);
            
            if (testResponse && testResponse.success) {
                debugLog('[YouTube Special Comments] ✅ Extension repair successful!');
                this.showInitializationStatus('修復完了！');
                
                // 成功時の処理
                this.hideDetailedError();
                this.showError('');
                this.elements.fixExtensionContainer.style.display = 'none';
                this.showMessage('拡張機能を修復しました！', 'success');
                
                // 初期化プロセスを完了
                await this.delay(1000);
                
            } else {
                throw new Error('Content script still not responding after repair');
            }
            
        } catch (error) {
            debugError('[YouTube Special Comments] ❌ Extension repair failed:', error);
            this.showInitializationStatus('修復失敗');
            
            // 失敗時のフォールバック: タブ再読み込みを提案
            this.showDetailedError({
                title: '修復失敗',
                message: '自動修復に失敗しました',
                solution: 'このタブを手動で再読み込みしてください。Ctrl+F5 または Cmd+R を押してください。',
                action: 'reload',
                severity: 'high'
            });
            
            // タブ再読み込み用のボタンテキストを変更。
            // 押されたときに何をするかは dataset.action で伝える（#16）。
            // onclick を代入すると attachEventListeners のリスナーと二重に発火し、
            // 修復とタブ再読み込みが同時に走っていた
            this.elements.fixExtensionBtn.textContent = 'タブを再読み込み';
            this.elements.fixExtensionBtn.disabled = false;
            this.elements.fixExtensionBtn.dataset.action = 'reload';

        } finally {
            await this.delay(1000);
            this.hideInitializationStatus();
            
            // 通常の修復ボタン状態に戻す。文言を戻すなら、押したときの
            // 行き先（dataset.action）も一緒に戻す（#16）
            if (this.elements.fixExtensionBtn.textContent === '修復中...') {
                this.elements.fixExtensionBtn.textContent = '修復';
                this.elements.fixExtensionBtn.disabled = false;
                delete this.elements.fixExtensionBtn.dataset.action;
            }
        }
    }
    
    // タブ再読み込み機能
    async reloadCurrentTab() {
        debugLog('[YouTube Special Comments] Reloading current tab...');
        
        try {
            await chrome.tabs.reload(this.currentTab.id);
            debugLog('[YouTube Special Comments] Tab reload initiated');
            
            // ポップアップを閉じる（タブ再読み込み後にユーザーが再度開く）
            window.close();
        } catch (error) {
            debugError('[YouTube Special Comments] Failed to reload tab:', error);
            this.showError('タブの再読み込みに失敗しました。手動でページを更新してください。');
        }
    }
    
    // タイムアウト付きタブメッセージ送信（より短いタイムアウト）
    async sendTabMessageWithTimeout(tabId, message, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Tab message timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            
            chrome.tabs.sendMessage(tabId, message, (response) => {
                clearTimeout(timeout);
                
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
    }
    
    // 初期化状態表示
    showInitializationStatus(message) {
        // 既存のローディング表示を使用
        this.showLoading(true);
        
        // カスタムステータスメッセージがあれば表示
        const statusElement = document.getElementById('initialization-status');
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.style.display = 'block';
        }
    }
    
    // 初期化状態表示を隠す
    hideInitializationStatus() {
        this.showLoading(false);
        
        const statusElement = document.getElementById('initialization-status');
        if (statusElement) {
            statusElement.style.display = 'none';
        }
    }
    
    initializeElements() {
        this.elements = {
            statusIndicator: document.getElementById('status-indicator'),
            apiKeyInput: document.getElementById('api-key-input'),
            saveApiKeyBtn: document.getElementById('save-api-key'),
            startMonitoringBtn: document.getElementById('start-monitoring'),
            stopMonitoringBtn: document.getElementById('stop-monitoring'),
            clearCommentsBtn: document.getElementById('clear-comments'),
            fixExtensionBtn: document.getElementById('fix-extension'),
            fixExtensionContainer: document.getElementById('fix-extension-container'),
            
            // 個別フィルタートグル
            ownerToggle: document.getElementById('owner-toggle'),
            moderatorToggle: document.getElementById('moderator-toggle'),
            sponsorToggle: document.getElementById('sponsor-toggle'),
            normalToggle: document.getElementById('normal-toggle'),
            superchatToggle: document.getElementById('superchat-toggle'),
            membershipToggle: document.getElementById('membership-toggle'),
            
            // プリセットボタン
            presetSpecial: document.getElementById('preset-special'),
            presetAll: document.getElementById('preset-all'),
            presetNone: document.getElementById('preset-none'),
            
            commentsList: document.getElementById('comments-list'),
            noComments: document.getElementById('no-comments'),
            
            // コメント数表示
            totalCount: document.getElementById('total-count'),
            ownerCount: document.getElementById('owner-count'),
            moderatorCount: document.getElementById('moderator-count'),
            sponsorCount: document.getElementById('sponsor-count'),
            normalCount: document.getElementById('normal-count'),
            superchatCount: document.getElementById('superchat-count'),
            membershipCount: document.getElementById('membership-count'),
            
            loading: document.getElementById('loading'),
            errorMessage: document.getElementById('error-message'),
            successMessage: document.getElementById('success-overlay'),
            errorOverlay: document.getElementById('error-overlay'),
            currentVideoId: document.getElementById('current-video-id'),

            // チャットの読み取り状態（フェーズ7）
            chatHealth: document.getElementById('chat-health'),
            chatHealthText: document.getElementById('chat-health-text'),
            
            // 詳細エラー表示要素
            errorDetails: document.getElementById('error-details'),
            errorTitle: document.getElementById('error-title'),
            errorDescription: document.getElementById('error-description'),
            errorSolution: document.getElementById('error-solution'),
            retryButton: document.getElementById('retry-button'),
            optionsButton: document.getElementById('options-button'),
            
            // ユーザーフィルター関連要素
            userFilterStatus: document.getElementById('user-filter-status'),
            filteredUsername: document.getElementById('filtered-username'),
            clearUserFilterBtn: document.getElementById('clear-user-filter'),
            searchKeywordInput: document.getElementById('search-keyword-input'),
            clearSearchBtn: document.getElementById('clear-search-btn'),
            searchMatchCount: document.getElementById('search-match-count'),

            // モード選択
            chatModeToggle: document.getElementById('chat-mode-toggle'),
            modeSelectWrapper: document.getElementById('mode-select-wrapper'),
            domModeHelp: document.getElementById('dom-mode-help'),
            apiKeySection: document.getElementById('api-key-section'),
            domModeReloadNotice: document.getElementById('dom-mode-reload-notice'),
            reloadPageForDomBtn: document.getElementById('reload-page-for-dom')
        };
    }
    
    attachEventListeners() {
        this.elements.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
        this.elements.startMonitoringBtn.addEventListener('click', () => this.startMonitoring());
        this.elements.stopMonitoringBtn.addEventListener('click', () => this.stopMonitoring());
        this.elements.clearCommentsBtn.addEventListener('click', () => this.clearComments());
        this.elements.fixExtensionBtn.addEventListener('click', () => {
            if (this.elements.fixExtensionBtn.dataset.action === 'reload') {
                this.reloadCurrentTab();
            } else {
                this.fixExtension();
            }
        });
        
        // 個別フィルタートグルと、コメント数バッジクリックによる直接フィルター
        for (const key of FILTER_KEYS) {
            this.elements[key + 'Toggle'].addEventListener('change', () => this.onFilterToggleChange(key));
            const badge = this.elements[key + 'Count'];
            badge.addEventListener('click', () => this.toggleBadgeFilter(key));
            // role="button" を持たせた span なので、Enter/Space の既定動作は自前で補う
            badge.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                this.toggleBadgeFilter(key);
            });
        }
        
        // プリセットボタン
        this.elements.presetSpecial.addEventListener('click', () => this.applyPreset('special'));
        this.elements.presetAll.addEventListener('click', () => this.applyPreset('all'));
        this.elements.presetNone.addEventListener('click', () => this.applyPreset('none'));
        
        this.elements.apiKeyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveApiKey();
            }
        });
        
        // エラー詳細のボタンイベント。押したときの行き先は dataset.action で
        // 切り替える（onclick を後から代入すると二重に発火する = #16）
        this.elements.retryButton.addEventListener('click', () => this.handleRetry());
        this.elements.optionsButton.addEventListener('click', () => {
            if (this.elements.optionsButton.dataset.action === 'quotaConsole') {
                this.openQuotaConsole();
            } else {
                this.openOptionsPage();
            }
        });
        
        // ユーザーフィルター関連のイベント
        this.elements.clearUserFilterBtn.addEventListener('click', () => this.clearUserFilter());

        // キーワード検索関連のイベント
        this.elements.searchKeywordInput.addEventListener('input', () => this.onSearchInput());
        // IMEの確定で input が飛ばない環境があり、変換前のかなのまま検索してしまう
        this.elements.searchKeywordInput.addEventListener('compositionend', () => this.onSearchInput());
        this.elements.clearSearchBtn.addEventListener('click', () => this.clearSearch());

        // モード切替
        this.elements.chatModeToggle.addEventListener('change', () => this.onChatModeChange());

        // DOMモード リロードボタン
        if (this.elements.reloadPageForDomBtn) {
            this.elements.reloadPageForDomBtn.addEventListener('click', () => this.reloadPageForDom());
        }

        // コメントリストのスクロールイベント（自動追従フラグの更新）
        this.elements.commentsList.addEventListener('scroll', () => {
            this.autoScroll = this.isAtBottom();
            this.updateScrolledToBottom();
        });

        // 行ごとではなく、一覧に1つだけリスナーを張る（#22）。
        // 以前は描画のたびに querySelectorAll 3回 + 最大3N個のクロージャを
        // 張り直していた。行は作り直さなくなったので、張り替えも要らない
        this.elements.commentsList.addEventListener('click', event => {
            this.onCommentsListClick(event);
        });
        // error はバブリングしないので、捕捉フェーズで受ける
        this.elements.commentsList.addEventListener('error', event => {
            this.onCommentsListError(event);
        }, true);
    }

    // 発言者名のクリックでユーザー絞り込みを切り替える
    onCommentsListClick(event) {
        const author = event.target?.closest?.('.comment-author');
        const username = author?.getAttribute('data-username');
        if (!username) return;

        if (this.selectedUser === username) {
            // 既に選択済みのユーザーをクリックした場合は絞り込み解除
            this.clearUserFilter();
        } else {
            // 新しいユーザーで絞り込み
            this.filterByUser(username);
        }
    }

    // 画像が404などで読めなかったときの後始末。
    // MV3のCSPはインラインの onerror= を禁止するのでJSから受ける
    onCommentsListError(event) {
        const image = event.target;
        if (!image?.classList) return;

        if (image.classList.contains('comment-avatar')) {
            // アバターは頭文字表示に差し替える
            image.replaceWith(
                this.avatarFallbackNode(image.getAttribute('data-initial') || '?'));
        } else if (image.classList.contains('comment-sticker')) {
            // ステッカーは取り除く。ステッカー名の行はそのまま残る
            image.remove();
        }
    }
    
    async loadChatMode() {
        try {
            const result = await chrome.storage.local.get(['chatMode', 'domModeNeedsReload']);
            this.chatMode = result.chatMode || 'dom';
            this.domModeNeedsReload = result.domModeNeedsReload || false;
            this.updateChatModeUI();
            this.updateMonitoringButtonStates();
            // DOMモードで開いた場合はAPIキー関連エラーを消去
            if (this.chatMode === 'dom') {
                this.hideDetailedError();
                this.showError('');
            }
        } catch (error) {
            debugError('[YouTube Special Comments] Error loading chat mode:', error);
        }
    }

    updateChatModeUI() {
        if (this.elements.chatModeToggle) {
            this.elements.chatModeToggle.value = this.chatMode;
        }
        const isDom = this.chatMode === 'dom';
        if (this.elements.domModeHelp) {
            this.elements.domModeHelp.style.display = isDom ? 'block' : 'none';
        }
        if (this.elements.apiKeySection) {
            this.elements.apiKeySection.style.display = isDom ? 'none' : 'block';
        }
        if (this.elements.domModeReloadNotice) {
            this.elements.domModeReloadNotice.style.display = (isDom && this.domModeNeedsReload) ? 'flex' : 'none';
        }
    }

    async onChatModeChange() {
        if (this.isMonitoring) {
            this.showMessage('取得中はモードを切り替えられません。取得を停止してから変更してください。', 'error');
            // トグルを元の値に戻す
            this.elements.chatModeToggle.value = this.chatMode;
            return;
        }
        this.chatMode = this.elements.chatModeToggle.value;
        await chrome.storage.local.set({ chatMode: this.chatMode });
        if (this.chatMode === 'dom') {
            this.hideDetailedError();
            this.showError('');
        }
        this.updateChatModeUI();
        this.updateMonitoringButtonStates();
    }

    async reloadPageForDom() {
        await chrome.storage.local.set({ domModeNeedsReload: false });
        this.domModeNeedsReload = false;
        if (this.currentTab) {
            chrome.tabs.reload(this.currentTab.id);
        }
    }

    async loadSavedApiKey() {
        try {
            const response = await this.requestBackground({ action: 'getApiKey' });
            if (response && response.apiKey) {
                this.elements.apiKeyInput.value = response.apiKey;
                this.updateMonitoringButtons(true);
                debugLog('[YouTube Special Comments] ✅ API key loaded successfully');
            } else {
                debugLog('[YouTube Special Comments] No API key found in storage');
            }
        } catch (error) {
            debugError('[YouTube Special Comments] Error loading API key:', error);
            this.showError('APIキーの読み込みに失敗しました。ページを再読み込みしてください。');
        }
    }
    
    async saveApiKey() {
        const apiKey = this.elements.apiKeyInput.value.trim();
        if (!apiKey) {
            this.showMessage('APIキーを入力してください', 'error');
            return;
        }
        
        this.showLoading(true);
        
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveApiKey',
                apiKey: apiKey
            });
            
            if (response.success) {
                this.showError('');
                this.updateMonitoringButtons(true);
                this.showMessage('APIキーが保存されました', 'success');
            }
        } catch (error) {
            this.showError('APIキーの保存に失敗しました: ' + error.message);
        } finally {
            this.showLoading(false);
        }
    }
    
    async checkCurrentTab() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.currentTab = tab;
            
            debugLog('[YouTube Special Comments] Current tab:', tab.url);
            
            const isYouTubePage = tab.url && (tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/live/'));
            if (isYouTubePage) {
                this.updateStatus('YouTube ページ');
                await this.loadExistingComments();
            } else {
                this.updateStatus('YouTube以外のページ');
                this.updateMonitoringButtons(false);
            }
        } catch (error) {
            debugError('Error checking current tab:', error);
            this.updateStatus('エラー');
        }
    }
    
    async loadExistingComments() {
        try {
            debugLog('[YouTube Special Comments] === Starting comment history restoration ===');
            
            // Step 1: 現在のVideo IDを取得
            const currentVideoId = await this.getCurrentVideoId();
            this.currentVideoId = currentVideoId;
            debugLog('[YouTube Special Comments] Current video ID:', currentVideoId);
            
            // Step 2: Background scriptから監視状態を取得
            const monitoringState = await this.getBackgroundMonitoringState();
            debugLog('[YouTube Special Comments] Background monitoring state:', monitoringState);
            
            // Step 3: 監視状態を更新
            if (monitoringState.success) {
                this.isMonitoring = monitoringState.isMonitoring;
                // chatMode は監視中の場合のみバックグラウンドと同期する
                // （非監視時は chrome.storage.local の値を優先する）
                if (monitoringState.isMonitoring && monitoringState.chatMode) {
                    this.chatMode = monitoringState.chatMode;
                    this.updateChatModeUI();
                }
                this.updateMonitoringButtonStates();

                if (this.isMonitoring) {
                    this.updateStatus(this.chatMode === 'dom' ? '取得中（DOMモード）' : '取得中');
                } else {
                    this.updateStatus('停止済み');
                }
            }
            
            // Step 4: Video ID表示を更新
            this.updateVideoIdDisplay();
            
            // Step 5: コメント履歴を復元
            await this.restoreCommentHistory(currentVideoId);
            
            // Step 6: Content scriptの状態をチェック（監視していない場合のみ）
            if (!this.isMonitoring) {
                await this.checkContentScriptStatus();
            }
            
            debugLog('[YouTube Special Comments] === Comment history restoration completed ===');
            
        } catch (error) {
            debugError('[YouTube Special Comments] Error loading existing comments:', error);
            this.showError('コメント履歴の読み込みに失敗しました。');
            this.updateStatus('エラー');
        }
    }
    
    async getCurrentVideoId() {
        // Content scriptから取得を試行（ping は生存確認と現在地の両方を返す）
        try {
            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'ping'
            }, 2);
            
            if (response && response.videoId) {
                debugLog('[YouTube Special Comments] Video ID from content script:', response.videoId);
                return response.videoId;
            }
        } catch (contentError) {
            debugLog('[YouTube Special Comments] Content script not available:', contentError);
        }
        
        // URLから抽出
        if (this.currentTab.url) {
            const urlMatch = this.currentTab.url.match(/[?&]v=([^&]+)/);
            if (urlMatch) {
                debugLog('[YouTube Special Comments] Video ID from URL:', urlMatch[1]);
                return urlMatch[1];
            }
            const liveMatch = this.currentTab.url.match(/\/live\/([^/?]+)/);
            if (liveMatch) {
                debugLog('[YouTube Special Comments] Video ID from URL (live):', liveMatch[1]);
                return liveMatch[1];
            }
        }
        
        debugLog('[YouTube Special Comments] Could not extract video ID');
        return null;
    }
    
    async getBackgroundMonitoringState() {
        try {
            const response = await this.requestBackground({
                action: 'getMonitoringState'
            });
            
            return response || { success: false };
        } catch (error) {
            debugLog('[YouTube Special Comments] Error getting monitoring state:', error.message);
            return { success: false };
        }
    }
    
    async restoreCommentHistory(currentVideoId) {
        // 動画が変わったら bulk の状態も引き継がない
        this.bulkLoaded = false;
        this.unloadedBulk = 0;

        if (!currentVideoId) {
            debugLog('[YouTube Special Comments] No video ID available, clearing comments');
            this.setComments([]);
            this.renderComments();
            return;
        }
        
        let targetVideoId = currentVideoId;
        
        // プライマリ取得を試行。読むのは primary 枠だけで、
        // メンバー・一般（bulk）は必要になってから popup が直接 IndexedDB から引く（決定4）
        let historyLoaded = false;
        try {
            const historyResponse = await this.requestBackground({
                action: 'getCommentsHistory',
                videoId: targetVideoId,
                bucket: 'primary'
            });
            
            debugLog('[YouTube Special Comments] History response for', targetVideoId + ':', {
                success: historyResponse?.success,
                commentsCount: historyResponse?.comments?.length || 0
            });
            
            if (historyResponse?.success && historyResponse.comments && historyResponse.comments.length > 0) {
                Object.assign(this.avatarsByAuthor, historyResponse.avatars || {});
                const formattedComments = this.formatHistoryComments(historyResponse.comments);
                this.setComments(formattedComments);
                // 保存済みの bulk 件数を控えてから、要るときだけ読む
                await this.loadBulkCount(targetVideoId);
                await this.renderWithBulk();
                debugLog('[YouTube Special Comments] Successfully restored', formattedComments.length, 'comments');
                historyLoaded = true;
            }
        } catch (error) {
            debugLog('[YouTube Special Comments] Primary history loading failed:', error.message);
        }
        
        // 以前はここに「content script が抱えている控えから読む」フォールバックが
        // あった。その控え（specialComments）はAPIモードの残骸で、フェーズ9 で
        // 消している。履歴の正は IndexedDB ただ1つ（決定2）

        // 最終フォールバック: 空の状態で表示
        if (!historyLoaded) {
            debugLog('[YouTube Special Comments] === All fallbacks failed, starting with empty comments ===');
            this.setComments([]);
            this.renderComments();
            
            // 空の状態でも監視中であることを示すメッセージを表示
            if (this.isMonitoring) {
                debugLog('[YouTube Special Comments] Monitoring is active but no history found - new comments will appear');
            }
        }
    }
    
    formatHistoryComments(rawComments) {
        return rawComments.map((comment, index) => {
            try {
                return this.formatComment(comment);
            } catch (error) {
                debugError(`[YouTube Special Comments] Error formatting comment ${index}:`, error);
                return null;
            }
        }).filter(comment => comment !== null);
    }
    
    async checkContentScriptStatus() {
        try {
            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'ping'
            }, 2);
            
            if (response && response.liveChatId) {
                this.updateStatus('ライブチャット検出済み');
            } else {
                this.updateStatus('ライブチャット未検出');
            }
        } catch {
            debugLog('[YouTube Special Comments] Content script not available');
            this.updateStatus('ライブチャット未検出');
        }
    }
    
    async tryDomAutoStart() {
        // 「取得中」なのにバックグラウンドが別の動画（や別のタブ）を掴んだままだと、
        // 現在のタブのコメントが永久に届かないため、その場合は開始し直す。
        //
        // 突き合わせは Service Worker の reconcile ただ1つに任せる（根本原因A）。
        // 以前はここだけ popup のローカル状態（監視中の動画IDの控え）で判断していて、
        // 突き合わせ分岐の5本目として残っていた。ポートで SW に聞けるようになったので、
        // 控えごと消した（別タブの配信を掴んでいる場合も、これで拾える）
        if (this.isMonitoring) {
            const verdict = await this.requestBackground({
                action: 'reconcileSession',
                tabId: this.currentTab?.id ?? null,
                videoId: this.currentVideoId
            });
            if (verdict?.state && verdict.state !== 'same') {
                debugLog('[YouTube Special Comments] Stale monitoring session detected:', verdict.state);
                this.isMonitoring = false;
            }
        }
        if (this.isMonitoring) return;
        if (this.chatMode !== 'dom') return;
        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        if (!isYouTubePage) return;

        try {
            const response = await this.requestBackground({ action: 'getAutoStart' });
            if (!response?.autoStart) return;

            debugLog('[YouTube Special Comments] DOM mode auto-start: starting monitoring');
            await this.startMonitoring(true); // suppressErrors: 初期化フローのStep 3でエラーハンドリングするため
        } catch (error) {
            debugLog('[YouTube Special Comments] DOM mode auto-start failed silently:', error.message);
        }
    }

    async startMonitoring(suppressErrors = false) {
        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        if (!isYouTubePage) {
            if (!suppressErrors) this.showError('YouTubeのライブ配信ページで使用してください');
            return;
        }
        
        debugLog('[YouTube Special Comments] Starting monitoring...');
        this.showLoading(true);
        this.showError(''); // エラーメッセージをクリア
        
        try {
            if (this.chatMode === 'dom') {
                // DOM モード：APIキーチェック不要、直接 background へ委譲
                const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                    action: 'startMonitoring',
                    chatMode: 'dom'
                }, 3);

                debugLog('[YouTube Special Comments] Start DOM monitoring response:', response);

                if (response && response.success) {
                    this.isMonitoring = true;
                    this.updateMonitoringButtonStates();
                    this.updateStatus('取得中（DOMモード）');
                    this.showError('');
                    this.hideDetailedError();
                    this.elements.fixExtensionContainer.style.display = 'none';
                    this.refreshChatHealth();
                } else if (!suppressErrors) {
                    this.showError('DOMモードでの取得開始に失敗しました。');
                }
                return;
            }

            // APIキーの存在確認
            const apiKeyResponse = await this.requestBackground({ action: 'getApiKey' });
            if (!apiKeyResponse || !apiKeyResponse.apiKey) {
                this.showError('YouTube Data APIキーが設定されていません。オプション画面で設定してください。');
                return;
            }

            // content scriptが応答するかテスト
            const testResponse = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'ping'
            }, 3);

            debugLog('[YouTube Special Comments] Content script test response:', testResponse);

            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'startMonitoring'
            }, 3);
            
            debugLog('[YouTube Special Comments] Start monitoring response:', response);
            
            if (response && response.success) {
                this.isMonitoring = true;
                this.updateMonitoringButtonStates();
                this.updateStatus('取得中');
                this.showError('');
                this.hideDetailedError();
                this.elements.fixExtensionContainer.style.display = 'none';
            } else {
                this.showError('取得を開始できませんでした。ライブチャットが見つからない可能性があります。');
            }
        } catch (error) {
            if (suppressErrors || error.message.includes('Could not establish connection')) {
                debugLog('[YouTube Special Comments] Start monitoring: content script not ready (expected on first use):', error.message);
            } else {
                debugError('[YouTube Special Comments] Start monitoring error:', error);
            }

            if (!suppressErrors) {
                // エラーメッセージの改善
                if (error.message.includes('Could not establish connection')) {
                    this.showContentScriptError();
                } else if (error.message.includes('API key')) {
                    this.showError('APIキーが設定されていません。オプション画面で設定してください。');
                } else if (error.message.includes('No active live chat')) {
                    this.showError('このビデオはライブ配信ではないか、チャットが無効になっています。');
                } else if (error.message.includes('quota')) {
                    this.showError('YouTube API の使用量制限に達しました。しばらく待ってから再試行してください。');
                } else {
                    this.showError(`取得の開始に失敗しました: ${error.message}`);
                }
            }
        } finally {
            this.showLoading(false);
        }
    }
    
    async stopMonitoring() {
        debugLog('[YouTube Special Comments] Stopping monitoring...');
        this.showLoading(true);
        
        try {
            const response = await this.sendTabMessageWithRetry(this.currentTab.id, {
                action: 'stopMonitoring'
            }, 3);
            
            debugLog('[YouTube Special Comments] Stop monitoring response:', response);
            
            if (response && response.success) {
                this.isMonitoring = false;
                this.updateMonitoringButtonStates();
                this.updateStatus('停止済み');
                this.updateChatHealth(null);
                this.showError('');
            } else {
                this.showError('取得を停止できませんでした');
            }
        } catch (error) {
            debugError('[YouTube Special Comments] Stop monitoring error:', error);
            if (error.message.includes('Could not establish connection')) {
                this.showError('ページを再読み込みしてみてください。（Content scriptが読み込まれていません...）');
                // 強制的に停止状態にする
                this.isMonitoring = false;
                this.updateMonitoringButtonStates();
                this.updateStatus('停止済み');
                this.updateChatHealth(null);
            } else {
                this.showError('取得の停止に失敗しました: ' + error.message);
            }
        } finally {
            this.showLoading(false);
        }
    }
    
    async clearComments() {
        try {
            await this.requestBackground({
                action: 'clearCommentsHistory',
                videoId: this.currentVideoId
            });
        } catch (e) {
            debugWarn('[Popup] Failed to clear storage history:', e);
        }
        this.setComments([]);
        this.avatarsByAuthor = {};
        this.bulkLoaded = false;
        this.unloadedBulk = 0;
        this.renderComments(true); // コメントクリア時はトップにスクロール
    }
    
    // this.comments と this.commentIds は必ずここを通して入れ替える。
    // 片方だけ書き換えると、重複判定が黙って効かなくなる。
    // 上限もここで見る。追記経路にしか上限が無かったので、履歴の復元だけは
    // 無制限に載っていた（#33）
    setComments(comments) {
        this.comments = comments.length > MAX_COMMENTS_IN_MEMORY
            ? comments.slice(-MAX_COMMENTS_IN_MEMORY)
            : comments;
        this.commentIds = new Set(this.comments.map(comment => comment.id));
        // 母集団そのものが入れ替わったので、行も作り直す
        this.rebuildCommentRows();
    }

    addNewComments(newComments) {
        const formattedComments = newComments.map(comment => this.formatComment(comment));
        
        // 重複チェックは id だけを見る（#3）。以前は本文・発言者・時刻など5フィールドの
        // 一致で代用していたが、DOMモードの過去分は時刻が分単位なので、
        // 同じ人が同じ分に同じ本文を投げると2件目が消えていた（「8888」などの連投）。
        // 全件走査（O(N x M)）でもあったのが、Set の一致判定1回になる
        const uniqueComments = formattedComments.filter(newComment => {
            if (this.commentIds.has(newComment.id)) return false;
            this.commentIds.add(newComment.id);
            return true;
        });
        
        this.comments.push(...uniqueComments);
        // 新着は「新しい行だけ」を作って1回で足す。既存の行には触らない（#22）
        this.appendCommentRows(uniqueComments);
        this.trimCommentsToLimit();

        debugLog('[Popup] Added', uniqueComments.length, 'of', formattedComments.length,
            'new comments (total', this.comments.length + ')');
        this.renderComments();
    }

    // 上限を超えたぶんを古い方から落とす。行も一緒に落として、
    // メモリから消えたコメントの DOM が残らないようにする
    trimCommentsToLimit() {
        const excess = this.comments.length - MAX_COMMENTS_IN_MEMORY;
        if (excess <= 0) return;

        // 切り詰めで落ちたぶんのIDも一緒に落とす（残っていると、
        // 一度消えたコメントが二度と入らなくなる）
        const dropped = this.comments.splice(0, excess);
        for (const comment of dropped) {
            this.commentIds.delete(comment.id);
            const row = this.rows.get(comment.id);
            if (!row) continue;
            row.element.remove();
            this.rows.delete(comment.id);
        }
        debugLog('[Popup] Trimmed comments to', MAX_COMMENTS_IN_MEMORY);
    }
    
    // 取り込み口はここ1つ。APIモードとDOMモードの違いは normalizeComment が
    // 吸収するので、この先に取得モードの分岐は無い（根本原因E）。
    // 足すのは表示のためのフィールドだけ
    formatComment(comment) {
        const normalized = normalizeComment(comment);
        const [roleLabel, roleClass] = ROLE_LABELS[normalized.role] || ROLE_LABELS.normal;

        return {
            ...normalized,
            // 保存時に振られる通し番号。正準形には無い（保存の都合の値）が、
            // あとから読んだ bulk を並びに差し込むのに要る（決定4）ので持ち越す。
            // 保存を経ていない新着では undefined になり、いちばん新しい扱いになる
            seq: comment.seq,
            // 表示用の役割ラベルとクラス。絞り込みと集計が見るのは
            // 正準形の role（'owner' などのキー）のほう
            roleLabel,
            roleClass,
            // 新着はコメントに同梱、履歴は発言者マップから引く
            profileImageUrl: normalized.avatarUrl || this.avatarsByAuthor[normalized.displayName] || null
        };
    }

    
    // スクロール位置が一番下かどうかを判定
    isAtBottom() {
        const element = this.elements.commentsList;
        const threshold = 5; // 5px以内の誤差を許容
        return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
    }

    // コメントエリアの下部フェードグラデーション表示を更新
    updateScrolledToBottom() {
        const commentsArea = this.elements.commentsList.closest('.comments-area');
        if (commentsArea) {
            const el = this.elements.commentsList;
            const hasScroll = el.scrollHeight > el.clientHeight;
            if (!hasScroll || this.isAtBottom()) {
                commentsArea.classList.add('scrolled-to-bottom');
            } else {
                commentsArea.classList.remove('scrolled-to-bottom');
            }
        }
    }

    // 画像URLは外部由来（YouTubeのDOM／APIの応答）なので、https と配信ホストの
    // 両方を見る。https の前方一致だけでは任意のHTTPS先へ img のリクエストが飛ぶ（#26）
    safeImageUrl(url, allowedHosts) {
        if (typeof url !== 'string' || !url.startsWith('https://')) return null;
        let hostname;
        try {
            hostname = new URL(url).hostname;
        } catch {
            return null;
        }
        const allowed = allowedHosts.some(
            host => host.startsWith('.') ? hostname.endsWith(host) : hostname === host);
        return allowed ? url : null;
    }

    safeAvatarUrl(url) {
        return this.safeImageUrl(url, AVATAR_IMAGE_HOSTS);
    }

    safeStickerUrl(url) {
        return this.safeImageUrl(url, STICKER_IMAGE_HOSTS);
    }

    // 要素を1つ作る小道具。文字列HTMLを組まないので、
    // 属性のエスケープ漏れ（#25）という種類の欠陥がそもそも成立しない
    createNode(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.classList.add(...className.split(' '));
        // 空文字の代入は「書き込み」として記録に残るだけで意味が無い
        if (text) node.textContent = text;
        return node;
    }

    // アバター1つぶん。URLが無い／読み込めない場合は頭文字にフォールバックする
    avatarNode(comment) {
        // サロゲートペア（絵文字など）を1文字として扱う
        const initial = Array.from(comment.displayName || '?')[0] || '?';
        const url = this.safeAvatarUrl(comment.profileImageUrl);
        if (!url) return this.avatarFallbackNode(initial);

        const img = this.createNode('img', 'comment-avatar');
        img.setAttribute('src', url);
        img.setAttribute('alt', '');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('width', '24');
        img.setAttribute('height', '24');
        // 読み込みに失敗したときの差し替え先。委譲したリスナーがここを読む
        img.setAttribute('data-initial', initial);
        return img;
    }

    avatarFallbackNode(initial) {
        const span = this.createNode('span', 'comment-avatar comment-avatar--fallback', initial);
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    // スーパーステッカーの画像。中身はアニメーションWebPで、img に貼るだけで再生される。
    // URLが無い／読み込めない場合も、ステッカー名は本文として別に出ているので情報は消えない
    stickerNode(comment) {
        if (comment.kind !== 'supersticker') return null;
        const url = this.safeStickerUrl(comment.stickerUrl);
        if (!url) return null;

        const img = this.createNode('img', 'comment-sticker');
        img.setAttribute('src', url);
        img.setAttribute('alt', '');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('width', '96');
        img.setAttribute('height', '96');
        return img;
    }

    // 時刻表示の設定を読み込む。未設定時は従来の見た目（24時間・秒あり）を維持する
    async loadTimeSettings() {
        try {
            const { timeHour12, timeShowSeconds } =
                await chrome.storage.local.get(['timeHour12', 'timeShowSeconds']);
            this.timeHour12 = timeHour12 === true;
            this.timeShowSeconds = timeShowSeconds !== false;
        } catch (error) {
            debugError('[YouTube Special Comments] Error loading time settings:', error);
        }
        this.syncTimeToggleUI();
    }

    // ストレージ変更から呼ばれる。渡された値だけ更新して全件を描き直す
    applyTimeSettings({ hour12, showSeconds } = {}) {
        if (hour12 !== undefined) this.timeHour12 = (hour12 === true);
        if (showSeconds !== undefined) this.timeShowSeconds = (showSeconds !== false);
        this.syncTimeToggleUI();
        // 時刻は行を作るときに焼き付けている。表記が変わったときだけは、
        // 行そのものを作り直さないと古い表記が残る
        this.rebuildCommentRows();
        this.renderComments();
    }

    // ドロワーのトグル表示を現在値に合わせる（オプション画面側で変えた場合の追従）
    syncTimeToggleUI() {
        const hour12Toggle = document.getElementById('time-hour12-toggle');
        const secondsToggle = document.getElementById('time-seconds-toggle');
        if (hour12Toggle) hour12Toggle.checked = this.timeHour12;
        if (secondsToggle) secondsToggle.checked = this.timeShowSeconds;
    }

    // toLocaleTimeString('ja-JP', {hour12:true}) は「午後10:34」になりAM/PMにならない。
    // ロケール実装差にも左右されるので自前で組む
    formatTimestamp(raw) {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return '';

        const pad = n => String(n).padStart(2, '0');
        const hours24 = date.getHours();

        let text = this.timeHour12
            ? `${hours24 % 12 || 12}:${pad(date.getMinutes())}`
            : `${pad(hours24)}:${pad(date.getMinutes())}`;

        if (this.timeShowSeconds) text += `:${pad(date.getSeconds())}`;
        if (this.timeHour12) text += hours24 < 12 ? ' AM' : ' PM';

        return text;
    }

    // 一覧の役割バッジ。文字ではなくアイコンで出し、意味は title/aria-label で補う。
    // 一般コメントはバッジ無し（特別コメントだけが目に留まるようにする）
    roleBadgeNode(comment) {
        const icons = {
            'role-owner':     '\u{1F451}',
            'role-moderator': '\u{1F527}',
            'role-sponsor':   '\u{2B50}'
        };
        const icon = icons[comment.roleClass];
        if (!icon) return null;

        const span = this.createNode(
            'span', `comment-role comment-role--icon ${comment.roleClass}`, icon);
        span.setAttribute('title', comment.roleLabel);
        span.setAttribute('role', 'img');
        span.setAttribute('aria-label', comment.roleLabel);
        return span;
    }

    // 種別バッジ。スパチャ・メンバーイベントだけに付き、通常のコメントには出ない
    kindBadgeNode(comment) {
        const entry = KIND_ICONS[comment.kind];
        if (!entry) return null;

        const [icon, label] = entry;
        const span = this.createNode('span', 'comment-kind comment-kind--icon', icon);
        span.setAttribute('title', label);
        span.setAttribute('role', 'img');
        span.setAttribute('aria-label', label);
        return span;
    }

    // 1行ぶんの要素を組み立てる。ここで作った要素は、フィルターや検索を
    // 切り替えても作り直さない（hidden を切り替えるだけ）。
    // DOM の構造とクラス名は文字列組み立て時代と同じ — popup.css:1005-1008 の
    // :has() が構造に依存しているので、入れ替えたり増やしたりしないこと
    createCommentRow(comment) {
        const kindClass = comment.kind && comment.kind !== 'text' ? ` kind-${comment.kind}` : '';
        const row = this.createNode('div', `comment-item${kindClass}`);
        // 委譲したリスナーから、どの行かを引くための目印
        row.setAttribute('data-comment-id', comment.id);

        const header = this.createNode('div', 'comment-header');
        header.appendChild(this.avatarNode(comment));

        const roleBadge = this.roleBadgeNode(comment);
        if (roleBadge) header.appendChild(roleBadge);

        const kindBadge = this.kindBadgeNode(comment);
        if (kindBadge) header.appendChild(kindBadge);

        const author = this.createNode('span', 'comment-author', comment.displayName);
        author.setAttribute('data-username', comment.displayName);
        header.appendChild(author);

        // スパチャの金額。DOMモードは表示文字列、APIモードは amountDisplayString
        if (comment.amountText) {
            header.appendChild(this.createNode('span', 'comment-amount', comment.amountText));
        }

        header.appendChild(
            this.createNode('span', 'comment-time', this.formatTimestamp(comment.publishedAt)));
        row.appendChild(header);

        // 「新規メンバー」「◯か月連続のメンバー」など、本文とは別に出す一行
        if (comment.eventText) {
            row.appendChild(this.createNode('div', 'comment-event', comment.eventText));
        }

        const sticker = this.stickerNode(comment);
        if (sticker) row.appendChild(sticker);

        // 金額だけのスパチャやギフト告知は本文が無いので、空の行を作らない
        if (comment.message) {
            row.appendChild(this.createNode('div', 'comment-message', comment.message));
        }

        return { element: row, author, displayName: comment.displayName };
    }

    // === bulk 枠の遅延読み込み（決定4） =====================================
    // 起動時にメモリへ載せるのは primary（配信者・モデレーター・スパチャ・
    // メンバーシップ）だけにする。メンバーと一般は流量が桁違いで、
    // 全件取り込み（決定1）のあとは数万件になりうるため。
    //
    // bulk を読むのは「表示に要るとき」だけ。トグルがONになった、検索が始まった、
    // ユーザー絞り込みが掛かった、のいずれか。検索が取得済み全件に効くという
    // 約束は、検索を needsBulk() に含めることで維持している。
    //
    // Service Worker 越しではなく popup が直接 IndexedDB を読むのは、
    // メッセージで渡すと数万件を構造化クローンで往復させることになるから。
    // 移行だけは絶対に走らせない（store.migrateFromLocal を呼ばない）。
    // Service Worker と同時に走らせると履歴が二重に積まれる

    /** いま表示するのに bulk 枠が要るか */
    needsBulk() {
        return this.commentFilters.sponsor === true
            || this.commentFilters.normal === true
            || this.searchQuery.length > 0
            || this.selectedUser !== null;
    }

    /** これから読みにいく必要があるか（要るのに、まだ載っていない） */
    shouldLoadBulk() {
        return !this.bulkLoaded
            && this.unloadedBulk > 0
            && !!this.currentVideoId
            && this.needsBulk();
    }

    /** 保存されている bulk の件数を控える。読み込みはまだしない */
    async loadBulkCount(videoId) {
        this.bulkLoaded = false;
        this.unloadedBulk = 0;
        if (!videoId) return;
        try {
            const counts = await store.count(videoId);
            this.unloadedBulk = counts.bulk || 0;
        } catch (error) {
            debugError('[Popup] Failed to count bulk comments:', error);
        }
    }

    /**
     * 必要なら bulk 枠を IndexedDB から読んでメモリへ載せる。
     * 読んだら true を返す（呼び出し側は描き直す）
     */
    async ensureBulkLoaded() {
        if (!this.shouldLoadBulk()) return false;

        // メモリの上限（#33）は primary と bulk で共有する。
        // primary を先に確保してあるので、bulk は残り枠に新しい方から入る
        const room = MAX_COMMENTS_IN_MEMORY - this.comments.length;
        if (room <= 0) return false;

        this.bulkLoaded = true;
        try {
            const bulk = await store.read(this.currentVideoId, { bucket: 'bulk', limit: room });
            const loaded = this.mergeBulkComments(bulk);
            // 残っているぶんは「載せきれなかった件数」。0 でない間、
            // メンバー・一般のバッジは数字を出さない
            this.unloadedBulk = Math.max(0, this.unloadedBulk - loaded);
            debugLog('[Popup] Loaded', loaded, 'bulk comments (', this.unloadedBulk, 'left)');
            return true;
        } catch (error) {
            debugError('[Popup] Failed to load bulk comments:', error);
            this.bulkLoaded = false;
            return false;
        }
    }

    /** 読んだ bulk を this.comments へ差し込む。並びは保存順（seq）に揃える */
    mergeBulkComments(bulk) {
        const fresh = bulk
            .filter(comment => comment?.id && !this.commentIds.has(comment.id))
            .map(comment => this.formatComment(comment));
        if (!fresh.length) return 0;

        // seq は保存時に振られる通し番号。持たないもの（popup を開いている間に
        // 届いた新着）はいちばん新しいので末尾に置く。sort は安定なので、
        // 同じ順位のものは元の並びのまま残る
        const order = comment => (typeof comment.seq === 'number' ? comment.seq : Infinity);
        this.setComments(this.comments.concat(fresh).sort((a, b) => order(a) - order(b)));
        return fresh.length;
    }

    /** bulk が要るなら読んでから描く。トグル・検索・ユーザー絞り込みの入口はこれを通す */
    async renderWithBulk(forceScrollToTop = false, forceScrollToBottom = false) {
        // 読むものが無いときは await を1つも挟まない。async 関数は最初の await まで
        // 同期で走るので、この分岐があるかどうかで描画が1フレーム遅れるかが変わる
        if (this.shouldLoadBulk()) await this.ensureBulkLoaded();
        this.renderComments(forceScrollToTop, forceScrollToBottom);
    }

    // === 一覧の描画 =========================================================
    // 行は1コメントにつき1回だけ作る（#22 = 根本原因D）。以前は新着1件ごとに
    // innerHTML を全置換していたので、1描画ごとに約4N要素の破棄と再生成・
    // 最大3N個のリスナー登録・強制同期レイアウト3回が走っていた
    // （N=10,000 で 300〜800ms）。ここでやるのは数えることと、
    // hidden の切り替えと、スクロール位置の復元だけ。

    /** 行を作り直す。母集団そのものが入れ替わったときだけ通る */
    rebuildCommentRows() {
        this.rows.clear();
        this.lastVisibleRow = null;
        // 空文字の代入はHTMLのパースを伴わない。絞り込みが0件のときに
        // 古いDOMが最大1万ノード残っていたのが #11 で、その置き場をここに一本化した
        this.elements.commentsList.innerHTML = '';
        this.appendCommentRows(this.comments);
    }

    /** 新しい行だけを作り、DocumentFragment にまとめて1回だけ足す */
    appendCommentRows(comments) {
        if (!comments.length) return;

        const fragment = document.createDocumentFragment();
        for (const comment of comments) {
            // 同じIDの行を2つ作らない。作ってしまうと、片方が this.rows に
            // 載らないまま DOM に残り、二度と隠せなくなる
            if (this.rows.has(comment.id)) continue;
            const row = this.createCommentRow(comment);
            this.rows.set(comment.id, row);
            fragment.appendChild(row.element);
        }
        this.elements.commentsList.appendChild(fragment);
    }

    renderComments(forceScrollToTop = false, forceScrollToBottom = false) {
        const list = this.elements.commentsList;
        // レイアウトの読み取りは、ここと行を出し入れしたあとの1回だけにする（#22）。
        // 以前は3か所で scrollTop / scrollHeight を読み書きしていた
        const previousScrollTop = list.scrollTop;

        // 母集団は1つだけにする（#18）。以前は合計が「絞り込み後」、内訳が
        // 「this.comments 全件」で、並べて出しているのに数え方が違っていた。
        // ここで作る scoped が唯一の母集団で、内訳もそこから数える。
        //
        // 役割・種別のトグルだけは scoped から引く（バッジ自身がそのトグルなので、
        // 切った枠の件数が 0 になってしまうと、ONに戻す判断ができなくなる）。
        // 表示中の枠ぶんの内訳を足すと、必ず合計値に一致する
        const scoped = this.comments.filter(comment => {
            // ユーザーフィルター
            const userMatch = !this.selectedUser || comment.displayName === this.selectedUser;

            // キーワード検索フィルター。対象は画面に見えている範囲ではなく
            // this.comments（取得済みの全件）で、スクロール位置とは無関係
            const keywordMatch = !this.searchQuery ||
                searchTextOf(comment).includes(this.searchQuery);

            return userMatch && keywordMatch;
        });

        // コメント数の集計。絞り込みと同じ母集団・同じ軸（filterKeyOf）で数える
        const counts = Object.fromEntries(FILTER_KEYS.map(key => [key, 0]));
        for (const comment of scoped) counts[filterKeyOf(comment)]++;

        // 役割・種別の絞り込み。取り込みは全件になったので（決定1）、
        // トグルをONに戻せば過去分もここから出てくる。
        // 行はもう出来ているので、決めるのは「どれを見せるか」だけ
        const visibleIds = new Set();
        for (const comment of scoped) {
            if (isCommentEnabled(comment.kind, comment.role, this.commentFilters)) {
                visibleIds.add(comment.id);
            }
        }

        this.updateCountBadges(counts, visibleIds.size);
        this.syncRowVisibility(visibleIds);

        // 0件でも早期 return しない。以前はここで抜けていたので、古いDOMが
        // 残ったまま display:none になり、スクロール状態も前のまま固まっていた（#11）
        const isEmpty = visibleIds.size === 0;
        if (isEmpty) this.updateEmptyStateMessage();
        this.elements.noComments.style.display = isEmpty ? 'block' : 'none';
        list.style.display = isEmpty ? 'none' : 'block';

        this.syncScrollPosition(previousScrollTop, forceScrollToTop, forceScrollToBottom);
    }

    // 件数バッジ。メンバー・一般だけは bulk 枠（決定3）で、メモリに載っていない
    // ことがある。数えられないものを 0 と出すと「そもそも無い」という嘘になるので、
    // そのときは ? を出して title に未読み込みの件数を書く
    updateCountBadges(counts, visibleCount) {
        const unknownBulk = this.unloadedBulk > 0;

        this.elements.totalCount.textContent = `${visibleCount}件`;
        this.updateSearchMatchCount(visibleCount);
        this.elements.ownerCount.textContent = `配信者: ${counts.owner}`;
        this.elements.moderatorCount.textContent = `モデレーター: ${counts.moderator}`;
        this.elements.sponsorCount.textContent = `メンバー: ${unknownBulk ? '?' : counts.sponsor}`;
        this.elements.normalCount.textContent = `一般: ${unknownBulk ? '?' : counts.normal}`;
        this.elements.superchatCount.textContent = `スパチャ: ${counts.superchat}`;
        this.elements.membershipCount.textContent = `加入・ギフト: ${counts.membership}`;

        // フィルター状態に応じてバッジのアクティブ・非アクティブ表示を切り替え
        for (const key of FILTER_KEYS) {
            const element = this.elements[key + 'Count'];
            if (!element) continue;
            const enabled = !!this.commentFilters[key];
            element.classList.toggle('filter-inactive', !enabled);
            // バッジ単体でも状態を確かめられるように、見た目に加えて文言でも示す
            if (unknownBulk && BULK_FILTER_KEYS.includes(key)) {
                element.title = `クリックで読み込んで表示する（未読み込み${this.unloadedBulk}件）`;
            } else {
                element.title = enabled ? 'クリックで非表示にする（現在: 表示中）'
                                        : 'クリックで表示する（現在: 非表示）';
            }
            element.setAttribute('aria-pressed', String(enabled));
        }
    }

    // 表示・非表示の切り替え。行は作り直さない（決定4・#22）
    syncRowVisibility(visibleIds) {
        let lastVisible = null;

        for (const [id, row] of this.rows) {
            const hidden = !visibleIds.has(id);
            // 同じ値でも書けばスタイルの再計算が走るので、変わったときだけ書く
            if (!!row.element.hidden !== hidden) row.element.hidden = hidden;

            const selected = this.selectedUser !== null && row.displayName === this.selectedUser;
            if (row.author.classList.contains('selected') !== selected) {
                row.author.classList.toggle('selected', selected);
            }

            if (!hidden) lastVisible = row;
        }

        // 区切り線を消すのは「最後に見えている行」。CSS の :last-child は
        // hidden を見ないので、末尾が隠れていると線が1本余る
        if (this.lastVisibleRow !== lastVisible) {
            this.lastVisibleRow?.element.classList.remove('comment-item--last');
            lastVisible?.element.classList.add('comment-item--last');
            this.lastVisibleRow = lastVisible;
        }
    }

    // 行の出し入れが終わったあとに1回だけレイアウトを読み、
    // 「下端にいるか」はそこから計算で出す（読み直さない。#22）
    syncScrollPosition(previousScrollTop, forceScrollToTop, forceScrollToBottom) {
        const list = this.elements.commentsList;
        const scrollHeight = list.scrollHeight;
        const clientHeight = list.clientHeight;

        let target;
        if (forceScrollToTop) {
            // フィルター変更やクリア時は強制的にトップへ
            target = 0;
        } else if (forceScrollToBottom || this.autoScroll) {
            // ユーザーフィルター時と自動追従モードは一番下を維持
            target = scrollHeight;
        } else {
            // ユーザーが上にスクロール中は位置を維持
            target = previousScrollTop;
        }
        list.scrollTop = target;

        // scrollTop への代入は scrollHeight - clientHeight で頭打ちになるので、
        // 下端判定は代入した値のまま計算できる（読み直すと同期レイアウトが増える）
        const atBottom = target + clientHeight >= scrollHeight - SCROLL_BOTTOM_THRESHOLD;
        this.autoScroll = atBottom;

        const commentsArea = list.closest('.comments-area');
        if (commentsArea) {
            const hasScroll = scrollHeight > clientHeight;
            commentsArea.classList.toggle('scrolled-to-bottom', !hasScroll || atBottom);
        }
    }

    /**
     * チャットの読み取り状態を出す（フェーズ7）。
     * health が null なら何も出さない（APIモード・停止中・状態が分からないとき）
     */
    updateChatHealth(health) {
        const chip = this.elements.chatHealth;
        const view = this.chatMode === 'dom' && health ? CHAT_HEALTH_VIEW[health.state] : null;

        if (!view) {
            chip.style.display = 'none';
            return;
        }

        chip.style.display = '';
        chip.className = `chat-health chat-health--${view.level}`;
        chip.title = view.title;
        this.elements.chatHealthText.textContent = view.text;
    }

    /**
     * いまの読み取り状態を Service Worker に聞く。
     * 以後の変化は片道の通知（domChatHealth）で届くので、聞くのは節目だけでよい
     */
    async refreshChatHealth() {
        if (this.chatMode !== 'dom' || !this.isMonitoring) {
            this.updateChatHealth(null);
            return;
        }
        try {
            const response = await this.requestBackground({ action: 'getDomChatHealth' });
            this.updateChatHealth(response?.health || null);
        } catch (error) {
            debugLog('[Popup] Could not read chat health:', error.message);
        }
    }

    updateStatus(status) {
        this.elements.statusIndicator.textContent = status;
        
        if (status.includes('取得中')) {
            this.elements.statusIndicator.className = 'status-indicator status-online';
        } else {
            this.elements.statusIndicator.className = 'status-indicator status-offline';
        }
    }
    
    updateMonitoringButtons(hasApiKey) {
        const isYouTubePage = this.currentTab && this.currentTab.url && 
            (this.currentTab.url.includes('youtube.com/watch') || this.currentTab.url.includes('youtube.com/live/'));
        // DOMモードはAPIキー不要
        const effectiveHasApiKey = this.chatMode === 'dom' ? true : hasApiKey;

        // 監視開始ボタンの状態とツールチップ
        if (!effectiveHasApiKey) {
            this.elements.startMonitoringBtn.disabled = true;
            this.elements.startMonitoringBtn.title = 'APIキーを入力してください';
        } else if (!isYouTubePage) {
            this.elements.startMonitoringBtn.disabled = true;
            this.elements.startMonitoringBtn.title = 'YouTubeのライブ配信ページで使用してください';
        } else {
            this.elements.startMonitoringBtn.disabled = false;
            this.elements.startMonitoringBtn.title = '';
        }
        
        // 監視停止ボタンは監視状態のみで制御（APIキーやページに関係なく）
        // この関数は監視状態以外の条件で呼ばれるため、停止ボタンはここでは触らない
    }
    
    updateMonitoringButtonStates() {
        // モードセレクターのロック
        if (this.elements.modeSelectWrapper) {
            this.elements.modeSelectWrapper.classList.toggle('monitoring', this.isMonitoring);
        }

        // 監視開始ボタン
        if (this.isMonitoring) {
            this.elements.startMonitoringBtn.disabled = true;
            this.elements.startMonitoringBtn.title = '取得中です';
        } else {
            // 監視していない場合は通常のボタン状態ロジックを適用
            if (this.chatMode === 'dom') {
                // DOMモードはAPIキー不要
                this.updateMonitoringButtons(true);
            } else {
                // まずAPIキーを確認
                this.requestBackground({ action: 'getApiKey' }).then(response => {
                    const hasApiKey = response && response.apiKey;
                    this.updateMonitoringButtons(hasApiKey);
                }).catch(() => {
                    this.updateMonitoringButtons(false);
                });
            }
        }
        
        // 監視停止ボタン
        if (this.isMonitoring) {
            this.elements.stopMonitoringBtn.disabled = false;
            this.elements.stopMonitoringBtn.title = '';
        } else {
            this.elements.stopMonitoringBtn.disabled = true;
            this.elements.stopMonitoringBtn.title = '取得停止中です';
        }
    }
    
    showLoading(show) {
        this.elements.loading.style.display = show ? 'flex' : 'none';
    }
    
    showError(message) {
        if (message) {
            this.elements.errorMessage.textContent = message;
            this.elements.errorMessage.style.display = 'block';
        } else {
            this.elements.errorMessage.style.display = 'none';
        }
    }
    
    showMessage(message, type = 'info') {
        debugLog(`${type}: ${message}`);
        
        if (type === 'success') {
            this.elements.successMessage.textContent = message;
            this.elements.successMessage.style.display = 'flex';
            this.elements.successMessage.style.animation = 'slideInFromTop 0.3s ease-out';
            
            // 2秒後に自動的に非表示
            setTimeout(() => {
                this.elements.successMessage.style.animation = 'fadeOutUp 0.3s ease-out';
                setTimeout(() => {
                    this.elements.successMessage.style.display = 'none';
                    this.elements.successMessage.style.animation = '';
                }, 300);
            }, 2000);
        } else if (type === 'error') {
            this.elements.errorOverlay.textContent = message;
            this.elements.errorOverlay.style.display = 'flex';
            this.elements.errorOverlay.style.animation = 'slideInFromTop 0.3s ease-out';
            
            // 3秒後に自動的に非表示（エラーメッセージは少し長めに表示）
            setTimeout(() => {
                this.elements.errorOverlay.style.animation = 'fadeOutUp 0.3s ease-out';
                setTimeout(() => {
                    this.elements.errorOverlay.style.display = 'none';
                    this.elements.errorOverlay.style.animation = '';
                }, 300);
            }, 3000);
        }
    }
    
    async loadCommentFilters() {
        try {
            const response = await this.requestBackground({ action: 'getCommentFilters' });
            if (response && response.success) {
                this.commentFilters = response.filters;
                this.updateFilterUI();
            }
        } catch (error) {
            debugError('[YouTube Special Comments] Error loading comment filters:', error);
            // デフォルト値を使用
            this.updateFilterUI();
        }
    }
    
    updateFilterUI() {
        for (const key of FILTER_KEYS) {
            this.elements[key + 'Toggle'].checked = this.commentFilters[key] === true;
        }

        this.updatePresetButtons();
        // トグルの内容によっては bulk 枠を読む必要が出る（決定4）。
        // await しない経路なので、失敗はここで拾って出す
        this.renderWithBulk(false, true).catch(error =>
            debugError('[Popup] Failed to render after filter change:', error));
    }
    
    updatePresetButtons() {
        const buttons = {
            special: this.elements.presetSpecial,
            all: this.elements.presetAll,
            none: this.elements.presetNone
        };

        // 現在の状態と一致するプリセットだけをアクティブにする
        for (const [name, button] of Object.entries(buttons)) {
            const matches = FILTER_KEYS.every(
                key => this.commentFilters[key] === FILTER_PRESETS[name][key]
            );
            button.classList.toggle('btn-preset-active', matches);
        }
    }
    
    async onFilterToggleChange(filterType) {
        this.commentFilters[filterType] = this.elements[filterType + 'Toggle'].checked;
        
        debugLog('[YouTube Special Comments] Filter changed:', filterType, '=', this.commentFilters[filterType]);
        
        try {
            await this.requestBackground({
                action: 'setCommentFilters',
                filters: this.commentFilters
            });
            
            this.updatePresetButtons();
            await this.renderWithBulk(false, true);
            
        } catch (error) {
            debugError('[YouTube Special Comments] Error saving comment filters:', error);
        }
    }

    async toggleBadgeFilter(filterType) {
        debugLog('[YouTube Special Comments] Badge clicked:', filterType);
        
        // 該当のカテゴリのみが現在有効であるか判定 (他はすべて無効)
        const isOnlyActive = this.commentFilters[filterType] && 
            Object.keys(this.commentFilters).every(key => key === filterType || !this.commentFilters[key]);
        
        if (isOnlyActive) {
            // 既にそのカテゴリのみのフィルターが有効な状態でクリックされた場合は、フィルター解除（すべて有効）にする
            this.commentFilters = { ...FILTER_PRESETS.all };
        } else {
            // それ以外の場合は、クリックされたカテゴリのみを有効にし、他を無効にする
            this.commentFilters = { ...FILTER_PRESETS.none };
            this.commentFilters[filterType] = true;
        }

        try {
            await this.requestBackground({
                action: 'setCommentFilters',
                filters: this.commentFilters
            });
            
            this.updateFilterUI();
            
        } catch (error) {
            debugError('[YouTube Special Comments] Error toggling badge filter:', error);
        }
    }
    
    async applyPreset(presetType) {
        debugLog('[YouTube Special Comments] Applying preset:', presetType);
        
        if (!FILTER_PRESETS[presetType]) return;
        this.commentFilters = { ...FILTER_PRESETS[presetType] };
        
        try {
            await this.requestBackground({
                action: 'setCommentFilters',
                filters: this.commentFilters
            });
            
            this.updateFilterUI();
            
        } catch (error) {
            debugError('[YouTube Special Comments] Error applying preset:', error);
        }
    }
    
    updateVideoIdDisplay() {
        debugLog('[YouTube Special Comments] Updating video ID display:', {
            currentVideoId: this.currentVideoId,
            isMonitoring: this.isMonitoring
        });
        
        // 現在のタブのVideo IDを表示
        if (this.currentVideoId) {
            this.elements.currentVideoId.textContent = this.currentVideoId;
        } else {
            this.elements.currentVideoId.textContent = '未検出';
        }
    }
    
    handleAutoStop(reason) {
        debugLog('[Popup] Monitoring auto-stopped:', reason);
        
        // 監視状態を更新
        this.isMonitoring = false;
        this.updateMonitoringButtonStates();
        this.updateStatus('自動停止');
        this.updateChatHealth(null);
        
        // 自動停止の通知を表示
        this.showAutoStopNotification(reason);
    }
    
    showAutoStopNotification(reason) {
        // 既存のエラーメッセージをクリア
        this.showError('');
        
        // 自動停止メッセージを表示
        const message = `取得が自動停止されました: ${reason}`;
        this.showMessage(message, 'info');
        
        // エラーメッセージエリアを一時的に情報表示に使用
        const errorElement = this.elements.errorMessage;
        errorElement.textContent = `ℹ️ ${message}`;
        errorElement.style.display = 'block';
        errorElement.style.backgroundColor = '#e3f2fd';
        errorElement.style.borderColor = '#1976d2';
        errorElement.style.color = '#1976d2';
        
        // 5秒後に自動的に非表示
        setTimeout(() => {
            errorElement.style.display = 'none';
            errorElement.style.backgroundColor = '';
            errorElement.style.borderColor = '';
            errorElement.style.color = '';
        }, 5000);
    }
    
    showDetailedError(errorInfo) {
        debugLog('[Popup] Showing detailed error:', errorInfo);
        
        // 通常のエラーメッセージを隠す
        this.elements.errorMessage.style.display = 'none';
        
        // HTMLタグを除去してから表示
        const cleanTitle = stripHtmlTags(errorInfo.title || 'エラーが発生しました');
        const cleanMessage = stripHtmlTags(errorInfo.message || errorInfo.originalError || '');
        const cleanSolution = stripHtmlTags(errorInfo.solution || '設定を確認してください');
        
        // 詳細エラー情報を表示
        this.elements.errorTitle.textContent = cleanTitle;
        this.elements.errorDescription.textContent = cleanMessage;
        this.elements.errorSolution.textContent = cleanSolution;
        
        // 重要度に応じたスタイル設定
        this.elements.errorDetails.className = `error-details severity-${errorInfo.severity || 'medium'}`;
        
        // アクションボタンの表示制御
        this.updateErrorActionButtons(errorInfo.action);
        
        // 詳細エラー表示を表示
        this.elements.errorDetails.style.display = 'block';
        
        // 自動的に非表示にしない（ユーザーが解決するまで表示継続）
    }
    
    hideDetailedError() {
        this.elements.errorDetails.style.display = 'none';
    }
    
    /**
     * エラー詳細の2つのボタンを、いまのエラーに合わせて作り直す。
     *
     * **文言は、押したときに実際に起きることだけを名乗る**（#17）。
     * 以前は「1分後に再試行」「明日再試行」「接続確認」「再確認」と出し分けていたが、
     * handleRetry() は常に「エラーを閉じて取得を開始し直す」だけで、
     * 5種類のうち4つは嘘だった。popup は閉じれば死ぬので「1分待ってから押す」
     * を代行することもできない。**待ち時間の情報は solution の文（SW の
     * ERROR_SOLUTIONS が持っている）に残っている**ので、ボタンからは落として、
     * 実際にできる2つ——取得のやり直しと、タブの再読み込み——だけを名乗らせる。
     *
     * 押したときの行き先は dataset.action で伝える。`onclick` を代入すると
     * attachEventListeners が張ったリスナーと二重に発火し、しかも
     * **元に戻らない**（quota エラーを一度踏むと、以後「設定画面」を押すたびに
     * Cloud Console と設定画面の両方が開いていた = #16）
     */
    updateErrorActionButtons(action) {
        // デフォルトでは両方のボタンを表示
        this.elements.retryButton.style.display = 'inline-block';
        this.elements.optionsButton.style.display = 'inline-block';

        // 行き先も文言も、毎回ここで全部書き直す（前のエラーの設定を残さない）
        this.elements.retryButton.textContent = '再試行';
        this.elements.retryButton.dataset.action = 'retry';
        this.elements.optionsButton.textContent = '設定画面';
        this.elements.optionsButton.dataset.action = 'options';

        // アクションに応じてボタンをカスタマイズ
        switch (action) {
            case 'setApiKey':
            case 'checkApiKey':
                this.elements.optionsButton.textContent = 'APIキー設定';
                break;
            case 'waitAndRetry':
                this.elements.optionsButton.style.display = 'none';
                break;
            case 'waitOrUpgrade':
                this.elements.optionsButton.textContent = 'Cloud Console';
                this.elements.optionsButton.dataset.action = 'quotaConsole';
                break;
            case 'checkConnection':
                this.elements.optionsButton.style.display = 'none';
                break;
            case 'reload':
                // これだけは文言どおりに動かせる（タブを再読み込みする）
                this.elements.retryButton.textContent = 'ページ再読込';
                this.elements.retryButton.dataset.action = 'reload';
                this.elements.optionsButton.style.display = 'none';
                break;
            case 'waitForChat':
            case 'findLiveStream':
                this.elements.optionsButton.style.display = 'none';
                break;
            default:
                break;
        }
    }

    handleRetry() {
        debugLog('[Popup] Retry button clicked');
        this.hideDetailedError();

        // 文言が「ページ再読込」のときは、そのとおりタブを読み込み直す（#17）
        if (this.elements.retryButton.dataset.action === 'reload') {
            this.reloadCurrentTab();
            return;
        }

        // 取得開始を再試行
        if (!this.isMonitoring) {
            this.startMonitoring();
        }
    }

    /** quota エラーのときだけ出る「Cloud Console」の行き先（#16） */
    openQuotaConsole() {
        window.open('https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas', '_blank');
    }
    
    openOptionsPage() {
        debugLog('[Popup] Opening options page');
        chrome.runtime.openOptionsPage();
    }
    
    // ユーザーフィルタリング機能
    filterByUser(username) {
        debugLog('[YouTube Special Comments] Filtering by user:', username);
        this.selectedUser = username;
        this.updateUserFilterStatus();
        // 絞り込んだ相手の発言は bulk 枠にもある。ユーザー絞り込みだけ
        // primary しか見ないと、同じ人の一般コメントが黙って抜け落ちる
        this.renderWithBulk(false, true) // ユーザーフィルター適用時は一番下にスクロール
            .catch(error => debugError('[Popup] Failed to render for user filter:', error));
    }
    
    clearUserFilter() {
        debugLog('[YouTube Special Comments] Clearing user filter');
        this.selectedUser = null;
        this.updateUserFilterStatus();
        this.renderComments(false, true); // ユーザーフィルタークリア時は一番下にスクロール
    }

    onSearchInput() {
        const value = this.elements.searchKeywordInput.value;
        this.searchKeyword = value;
        this.searchQuery = normalizeForSearch(value);
        // 見た目が空でも消し残ったゼロ幅文字だけが入っていることがあるので、
        // 「検索中」の見せ方は入力そのままではなく正規化後の有無で決める
        const isSearching = this.searchQuery.length > 0;
        this.elements.clearSearchBtn.style.display = isSearching ? 'inline-block' : 'none';
        const wrapper = this.elements.searchKeywordInput.closest('.search-input-wrapper');
        wrapper.classList.toggle('is-active', isSearching);
        clearTimeout(this._searchDebounceTimer);
        // 検索は取得済み全件に効く（それがこの拡張機能の売り）。bulk 枠を
        // メモリに載せていなければ、ここで読んでから描く
        this._searchDebounceTimer = setTimeout(() => {
            if (isSearching && this.shouldLoadBulk()) {
                this.elements.searchMatchCount.textContent = '検索中…';
                this.elements.searchMatchCount.style.display = 'inline-block';
            }
            this.renderWithBulk(false, false).catch(error =>
                debugError('[Popup] Failed to render search results:', error));
        }, 150);
    }

    clearSearch() {
        this.searchKeyword = '';
        this.searchQuery = '';
        this.elements.searchKeywordInput.value = '';
        this.elements.clearSearchBtn.style.display = 'none';
        this.elements.searchMatchCount.style.display = 'none';
        this.elements.searchKeywordInput.closest('.search-input-wrapper').classList.remove('is-active');
        this.renderComments(false, false);
    }

    updateSearchMatchCount(matchCount) {
        if (this.searchQuery.length > 0) {
            this.elements.searchMatchCount.textContent = `${matchCount}件一致`;
            this.elements.searchMatchCount.style.display = 'inline-block';
        } else {
            this.elements.searchMatchCount.style.display = 'none';
        }
    }

    // 0件のときに理由まで出す。「まだコメントがありません」だけだと、
    // 検索が全件に効いているのか、そもそも取得できていないのかが見分けられない
    updateEmptyStateMessage() {
        // 「取得済み」はメモリに載っているぶんだけではない。
        // まだ読んでいない bulk も取り込み済みなので足して数える（決定1・決定4）
        const total = this.comments.length + this.unloadedBulk;

        if (total === 0) {
            this.elements.noComments.textContent = 'まだコメントがありません';
            return;
        }

        if (this.searchQuery) {
            // キーワードだけなら当たるのに0件なら、消しているのは役割・ユーザーの絞り込み
            const keywordHits = this.comments
                .filter(comment => searchTextOf(comment).includes(this.searchQuery)).length;
            // 検索した範囲は正直に書く。上限や読み込み失敗で全件を見られていないのに
            // 「すべてを検索」と出すと、0件の理由がまた見分けられなくなる
            const scope = this.unloadedBulk > 0
                ? `${this.comments.length}件を検索・${this.unloadedBulk}件は未読み込み`
                : `取得済み${total}件すべてを検索`;
            this.elements.noComments.textContent = keywordHits > 0
                ? `「${this.searchKeyword.trim()}」に一致する${keywordHits}件は、いまのフィルターで非表示です`
                : `「${this.searchKeyword.trim()}」に一致するコメントはありません（${scope}）`;
            return;
        }

        this.elements.noComments.textContent =
            `表示できるコメントがありません（取得済み${total}件はフィルターで非表示です）`;
    }
    
    updateUserFilterStatus() {
        if (this.selectedUser) {
            // まずユーザー名をセットしてからステータスバーを表示（ちらつき防止）
            this.elements.filteredUsername.textContent = this.selectedUser;
            
            // レイアウト計算完了後に表示状態を変更
            requestAnimationFrame(() => {
                this.elements.userFilterStatus.style.display = 'flex';
            });
        } else {
            this.elements.userFilterStatus.style.display = 'none';
        }
    }
    
    // リトライ機能付きタブメッセージ送信
    async sendTabMessageWithRetry(tabId, message, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                debugLog(`[YouTube Special Comments] [Popup] Sending tab message attempt ${attempt}/${maxRetries}:`, message.action);
                
                const response = await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, message, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    });
                });
                
                debugLog(`[YouTube Special Comments] [Popup] ✅ Tab message successful on attempt ${attempt}`);
                return response;
                
            } catch (error) {
                debugLog(`[YouTube Special Comments] [Popup] Tab message failed on attempt ${attempt}:`, error.message);
                
                // Content Scriptが準備できていない可能性
                if (error.message.includes('Could not establish connection')) {
                    debugLog('[YouTube Special Comments] [Popup] Content script not ready, waiting...');
                    await this.delay(1000 * attempt); // 段階的に遅延を増加
                }
                
                if (attempt === maxRetries) {
                    throw error;
                }
            }
        }
    }
    
}

document.addEventListener('DOMContentLoaded', () => {
    popupController = new PopupController();
    initDrawer();
});

function initDrawer() {
    const drawer   = document.getElementById('settings-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const gearBtn  = document.getElementById('settings-toggle-btn');

    if (!drawer || !backdrop || !gearBtn) return;

    // 閉じているドロワーは max-height: 0 + overflow: hidden で「切り取られている」だけで、
    // 中のボタンやトグルは生きている。フィルターのチェックボックスがキーボードで
    // 掴めるようになった（#13）ぶん、閉じたまま Tab を押すと**見えない9個の
    // トグルに順番にフォーカスが入る**ので、閉じているあいだは inert にして
    // タブ順から丸ごと外す（読み上げからも外れるので aria-hidden と食い違わない）
    drawer.inert = true;

    function openDrawer() {
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        drawer.inert = false;
        backdrop.classList.add('visible');
        gearBtn.classList.add('active');
    }

    function closeDrawer() {
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.inert = true;
        backdrop.classList.remove('visible');
        gearBtn.classList.remove('active');
    }

    gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });

    backdrop.addEventListener('click', closeDrawer);

    drawer.addEventListener('click', (e) => e.stopPropagation());

    // Esc で閉じる。inert にするとフォーカスは中に居られなくなるので、
    // 開けた本人（歯車ボタン）へ返す（返さないと body に飛んで Tab が先頭に戻る）
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !drawer.classList.contains('open')) return;
        closeDrawer();
        gearBtn.focus();
    });

    // ドロワー内 時刻表示トグル。
    // 描画への反映は書き込まない（storage.onChanged 側が拾って再描画する）
    const timeHour12Toggle = document.getElementById('time-hour12-toggle');
    if (timeHour12Toggle) {
        timeHour12Toggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ timeHour12: timeHour12Toggle.checked });
        });
    }

    const timeSecondsToggle = document.getElementById('time-seconds-toggle');
    if (timeSecondsToggle) {
        timeSecondsToggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ timeShowSeconds: timeSecondsToggle.checked });
        });
    }

    // ドロワー内ダークモードトグル
    const darkToggle = document.getElementById('dark-mode-toggle');
    if (darkToggle) {
        chrome.storage.local.get(['theme']).then(({ theme }) => {
            darkToggle.checked = ((theme || 'light') === 'dark');
        });
        darkToggle.addEventListener('change', async () => {
            // 塗るのが先、保存が後。storage.onChanged は非同期に返ってくるので、
            // 待ってから塗ると切り替えが一拍遅れて見える
            const theme = applyTheme(darkToggle.checked ? 'dark' : 'light');
            await chrome.storage.local.set({ theme });
        });
    }
}