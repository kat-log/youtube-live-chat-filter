// ランディングページのライト／ダーク切り替え。拡張機能本体（src/）とは無関係。
//
// テーマの決め方:
//   - 利用者がボタンで選んだら localStorage の 'theme' に 'light' / 'dark' を置き、
//     <html data-theme="..."> で CSS に伝える
//   - 選んでいなければ data-theme を付けず、CSS の prefers-color-scheme（OS の設定）に任せる
//
// このファイルは <head> から defer なしで読む。body より先に data-theme を付けないと、
// 読み込み直後に一瞬だけ違うテーマが映る（拡張機能の shared/theme.js と同じ理由）。
// ボタンへの配線は DOM ができてから行う。
(function () {
  var KEY = 'theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readSaved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (_e) {
      return null; // プライベートウィンドウなどで storage が使えない
    }
  }

  function save(theme) {
    try {
      localStorage.setItem(KEY, theme);
    } catch (_e) {
      // 覚えられないだけで、このページ内の切り替えは効く
    }
  }

  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return media && media.matches ? 'dark' : 'light';
  }

  var saved = readSaved();
  if (saved) root.setAttribute('data-theme', saved);

  function syncButtons() {
    var now = current();
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      b.setAttribute('data-current', now);
      // 読み上げは「押すと何が起きるか」。文言はページの言語ごとに data 属性で持つ
      b.setAttribute('aria-label', b.getAttribute(now === 'dark' ? 'data-label-light' : 'data-label-dark'));
    }
  }

  function wire() {
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        save(next);
        syncButtons();
      });
    }
    syncButtons();
  }

  // 手動で選んでいないあいだに OS の設定が変わったら、アイコンだけ追従させる（色は CSS が追従する）
  if (media) {
    var onChange = function () { syncButtons(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
