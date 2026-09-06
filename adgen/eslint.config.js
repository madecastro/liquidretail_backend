// Deliberately a ONE-RULE config. Mirrors liquidretail_backend/eslint.config.js
// exactly (same reasoning, same globals, same rule) — this file is a fork of
// that repo and should not invent a second lint philosophy.
//
// `no-undef` is the only rule enabled because it is the only check that would
// have caught the class of bug this config exists for: a bare identifier that
// is read but never bound. This repo's scripts/verify*.js harnesses are
// regex-over-source and cannot see an unbound identifier; `node --check` sees
// only syntax. A ReferenceError is a runtime error, so a missing import ships
// green and crashes in production — exactly what happened here:
// src/services/quoteRotationService.js threw
// `Cannot find module './reviewAdapters/helpers'` in production (9 occurrences
// in logs) after an over-deleted directory removed the target. That specific
// failure is a require()-resolution problem, which scripts/verifyRequireGraph.js
// catches directly — but the SAME missing-import shape without a require()
// (e.g. a helper renamed and one call site missed) would only ever be a
// ReferenceError at runtime, which is precisely what no-undef catches
// statically, for free, on every commit.
//
// A style preset would bury that single signal under thousands of cosmetic
// findings in a repo with no lint history (109 service files, zero prior
// lint runs). Add rules deliberately, one at a time, each with a reason —
// same discipline the backend's config documents.

// Bindings the CommonJS module wrapper injects. An ESM file does NOT get
// these — require/module/exports/__dirname/__filename are genuinely unbound
// in a .mjs, and reading one is exactly the ReferenceError no-undef exists to
// catch. Kept OUT of esmGlobals rather than folded into one shared globals
// object — the backend's config found a real gap this way (see the .mjs
// block below) and this file preserves the same split so the same class of
// mistake can't reappear here even though adgen has no .mjs files yet.
const commonjsWrapperGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly'
};

// Everything else is a real property of the Node global object, present in
// both module systems.
const esmGlobals = {
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

const nodeGlobals = { ...commonjsWrapperGlobals, ...esmGlobals };

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.claude/**',
      // Gitignored local scratch, not repo source — mirrors the backend's
      // reasoning exactly (a Chrome/chrome-headless-shell download cache and
      // throwaway spikes accumulate real errors unrelated to any change and
      // would keep `npm run lint` red for reasons nobody touched). Neither
      // directory exists in this repo today; kept as a preventive ignore
      // since this repo also drives Puppeteer/Remotion, which is exactly
      // what populated them in the backend.
      '.cache/**',
      '.drafts/**',
      // src/remotion/** is a separate bundler + JSX toolchain, same as the
      // backend's top-level remotion/** exclusion — mixes .jsx (not matched
      // by the '**/*.js' block below anyway) with .js files that assume a
      // bundler-provided environment this config does not model.
      'src/remotion/**',
      '**/*.min.js',
      // mongosh scripts — `db`, `print`, `printjson`, `ObjectId` are shell
      // globals that never run under Node. None exist in this repo today;
      // kept for the same reason as .cache//.drafts/ above.
      '**/*.mongo.js'
    ]
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    linterOptions: {
      // Off deliberately, same reasoning as the backend: this config enables
      // exactly one rule, so an eslint-disable written for some other rule
      // would read as "unused" — noise from a narrow rule set, not a signal.
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    // ESM harnesses, if any are ever added under scripts/ (runVerifySuite.js
    // globs verify*.mjs too). Split into its own block rather than widening
    // the .js block's `files` — the backend's config learned this the hard
    // way: adding '**/*.mjs' to the CommonJS block parses every .mjs file as
    // CommonJS and every one errors out on `import`.
    //
    // globals is esmGlobals, NOT nodeGlobals — using nodeGlobals here would
    // silently re-admit require/module/exports/__dirname/__filename as valid
    // globals inside a .mjs. Those are genuinely unbound in ESM, so a
    // harness reading one would pass clean instead of erroring — the exact
    // bug class this whole config exists to catch, just moved one file
    // extension over. See the backend's eslint.config.js for the verified
    // repro (0 problems under the wrong globals, 5 no-undef errors under
    // this shape).
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: esmGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'no-undef': 'error'
    }
  }
  // No puppeteerHostFiles / browser-eval-globals block. The backend adds one
  // for files whose page.evaluate()/evaluateOnNewDocument() callbacks are
  // serialised and run IN THE BROWSER, where document/window/navigator are
  // legitimately defined. adgen's own puppeteer callers (src/services/
  // renderer.js, src/services/remotionRenderService.js — grepped 2026-08-24)
  // do not use page.evaluate at all, so there is currently no file that needs
  // this block. If one starts using page.evaluate, add the same block back
  // (see liquidretail_backend/eslint.config.js) rather than widening
  // nodeGlobals — the whole point of the split above is that document/window
  // stay unbound (and therefore no-undef-caught) everywhere else.
];
