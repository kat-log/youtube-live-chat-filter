// ESLint のフラット設定。
//
// 目的は「機械的に防げるものだけを機械に任せる」こと（再設計の決定5）。
// 整形（Prettier など）は入れない。既存コードの見た目を一括で書き換えると
// 以降のフェーズの差分が読めなくなるため。
//
// 地雷: sourceType は script のままにすること。両 content script は
// 二重注入ガードの `if (...) { } else { ... }` ブロックで包まれており、
// テストハーネスは Annex B の関数巻き上げで内部関数に到達している。
// module にすると巻き上げが消え、テストが原因不明の TypeError で全滅する
// （docs/audit-2026-09.md「実装時に踏んではいけない地雷」）。
// 同じ理由で、このプロジェクトの src/ に 'use strict' を足してもいけない。

// ここで globals パッケージを使わないのは、実行時どころか開発時の依存も
// 増やさずに済むから。必要なものは片手で数えられる程度しかない。
const ES_TIMERS = {
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly'
};

// content script / popup / options が触るブラウザのグローバル
const BROWSER_GLOBALS = {
  ...ES_TIMERS,
  chrome: 'readonly',
  window: 'readonly',
  // shared/comment.js が代入する self.YTF を、この3環境すべてから読む（決定7）
  self: 'readonly',
  document: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  Node: 'readonly',
  Element: 'readonly',
  HTMLElement: 'readonly',
  Image: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  FileReader: 'readonly',
  structuredClone: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  localStorage: 'readonly',
  matchMedia: 'readonly',
  getComputedStyle: 'readonly',
  btoa: 'readonly',
  atob: 'readonly'
};

// shared/ は3環境すべてから読まれる。どこでも在るものしか使えないので、
// globals もその共通部分に絞ってある（ここで document を使うと
// Service Worker で落ちる）。
// indexedDB / IDBKeyRange は store.js（決定2）が、chrome は storage.local からの
// 移行が使う。どれも Service Worker・content script・popup のどこにでも在る
const SHARED_GLOBALS = {
  ...ES_TIMERS,
  self: 'readonly',
  console: 'readonly',
  chrome: 'readonly',
  indexedDB: 'readonly',
  IDBKeyRange: 'readonly'
};

// shared/theme.js だけは例外で、拡張機能のページ2枚（popup / options）からしか
// 読まれない。document と localStorage を使うので Service Worker からは読めず、
// そのぶん SHARED_GLOBALS では足りない（このファイルを importScripts しないこと）
const SHARED_PAGE_GLOBALS = {
  ...SHARED_GLOBALS,
  document: 'readonly',
  localStorage: 'readonly'
};

// Service Worker（MV3）が触るグローバル。window も document も無い
const WORKER_GLOBALS = {
  ...ES_TIMERS,
  chrome: 'readonly',
  self: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  importScripts: 'readonly',
  caches: 'readonly',
  indexedDB: 'readonly',
  crypto: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  btoa: 'readonly',
  atob: 'readonly'
};

// テストとこの設定ファイル自身（CommonJS で動く Node 側）
const NODE_GLOBALS = {
  ...ES_TIMERS,
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  globalThis: 'readonly',
  structuredClone: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly'
};

// 最低限の2つ（決定5）。#38 の死にコードと #10 の欠落キーは、この2つで拾える
const RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_'
  }]
};

module.exports = [
  {
    ignores: ['node_modules/**', 'promotion/**']
  },
  {
    files: ['src/shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: SHARED_GLOBALS
    },
    rules: RULES
  },
  {
    // ページ2枚だけが読む shared（上の設定を後から上書きする。順番を変えないこと）
    files: ['src/shared/theme.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: SHARED_PAGE_GLOBALS
    },
    rules: RULES
  },
  {
    files: ['src/background/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: WORKER_GLOBALS
    },
    rules: RULES
  },
  {
    files: ['src/content/**/*.js', 'src/popup/**/*.js', 'src/options/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: BROWSER_GLOBALS
    },
    rules: RULES
  },
  {
    files: ['test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS
    },
    rules: RULES
  }
];
