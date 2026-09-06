// popup.js を Node 上で評価するためのテストハーネス。
//
// popup.js は読み込みと同時に chrome.storage と document を触りにいくので、
// 最小限のモックを置いた vm コンテキストで評価し、内部の関数をテストから
// 呼べるように露出させる。PopupController は DOMContentLoaded でしか
// 生成されないため、ここでは組み立てられない。
//
// 注意: 画面まわり（描画・イベント配線）はここでは検証できない。触れるのは
// 検索キーワードの正規化のような、DOMに依存しない部分だけ。

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const POPUP_PATH = path.join(__dirname, '..', '..', 'src', 'popup', 'popup.js');

function loadPopup() {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    // 読み込み時に走るのは loadDebugMode() と onChanged の購読だけ
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {} }
      }
    },
    document: {
      addEventListener() {},
      getElementById: () => null,
      documentElement: { setAttribute() {} }
    }
  });

  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8'), context);
  return context;
}

module.exports = { loadPopup };
