// Deliberately a ONE-RULE config.
//
// `no-undef` is the only thing here because it is the only check that would
// have caught the class of bug this config was added for: a bare identifier
// that is read but never bound. The ~90 scripts/verify*.js harnesses are
// regex-over-source and cannot see an unbound identifier; `node --check` sees
// only syntax. A ReferenceError is a runtime error, so it ships green and
// crashes in production.
//
// A style preset would bury that single signal under thousands of cosmetic
// findings in a repo with no lint history. Add rules deliberately, one at a
// time, each with a reason.

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  MessageChannel: 'readonly',
  MessagePort: 'readonly',
  BroadcastChannel: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  crypto: 'readonly'
};

// Callbacks handed to page.evaluate/evaluateOnNewDocument are serialised and
// run in the BROWSER, so document/window/navigator are legitimately defined
// there even though the file itself is Node. Listed per-file rather than
// globally so a stray `document` in a plain Node module is still an error.
const puppeteerHostFiles = [
  'services/renderService.js',
  'services/reviewHeadlessCapture.js',
  'services/headlessScrapeService.js',
  'services/headlessBrowserClient.js'
];

const browserEvalGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  getComputedStyle: 'readonly',
  location: 'readonly'
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'basecheck/**',
      '.claude/**',
      'remotion/**',        // separate bundler + JSX toolchain
      'frontend/**',
      'public/**',
      '**/*.min.js',
      // mongosh scripts — `db`, `print`, `printjson`, `ObjectId` are shell
      // globals, and these never run under Node.
      '**/*.mongo.js'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    linterOptions: {
      // Off deliberately. This config enables exactly one rule, so every
      // pre-existing `eslint-disable` for some other rule reads as "unused" —
      // 20+ warnings that are an artefact of the narrow rule set, not a signal.
      // Turn this on if/when the rule set grows.
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    files: puppeteerHostFiles,
    languageOptions: { globals: browserEvalGlobals }
  }
];
