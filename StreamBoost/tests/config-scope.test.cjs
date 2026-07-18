'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const USERSCRIPT_PATH = path.join(__dirname, '..', 'StreamBoost.js');
const USERSCRIPT_SOURCE = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
const SETTINGS_STORAGE_KEY = 'streamboost.settings';

function exposeUserscriptTestHooks(source) {
  const closingPattern = /\n\}\)\(\);\s*$/;
  assert.match(source, closingPattern);
  return source.replace(
    closingPattern,
    '\n  globalThis.__STREAMBOOST_TEST_HOOKS__ = Object.freeze({ loadSettings, readLegacyRuntimeOverrides, updateRuntimeConfig });\n})();\n'
  );
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createSharedGmStore(initialSettings, options = {}) {
  const values = new Map();
  if (initialSettings !== undefined) {
    values.set(SETTINGS_STORAGE_KEY, cloneJson(initialSettings));
  }

  return {
    values,
    getValue(key, fallback) {
      if (options.getError) throw options.getError;
      return values.has(key) ? cloneJson(values.get(key)) : cloneJson(fallback);
    },
    setValue(key, value) {
      if (options.setError) throw options.setError;
      values.set(key, cloneJson(value));
    }
  };
}

function createLocalStorage(initialValues = {}, options = {}) {
  const values = new Map(Object.entries(initialValues).map(([key, value]) => [key, String(value)]));
  const stats = { reads: 0, writes: 0, removals: 0 };

  return {
    stats,
    values,
    storage: {
      getItem(key) {
        stats.reads += 1;
        if (options.readError) throw options.readError;
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        stats.writes += 1;
        if (options.writeError) throw options.writeError;
        values.set(key, String(value));
      },
      removeItem(key) {
        stats.removals += 1;
        if (options.writeError) throw options.writeError;
        values.delete(key);
      }
    }
  };
}

function createDocument(url, iframes = [], options = {}) {
  const listeners = new Map();
  const document = {
    URL: url.href,
    location: {
      href: url.href,
      hostname: url.hostname,
      origin: url.origin
    },
    documentElement: options.documentElementInitiallyMissing ? null : {},
    body: {},
    head: {},
    getElementById() {
      return null;
    },
    getElementsByTagName(tagName) {
      return String(tagName).toLowerCase() === 'iframe' ? iframes : [];
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    installDocumentElement() {
      document.documentElement = {};
      for (const callback of [...(listeners.get('readystatechange') || [])]) callback();
    }
  };
  return document;
}

function runUserscript({
  href,
  documentOverride,
  documentElementInitiallyMissing = false,
  exposeHooks = false,
  gmStore,
  iframes = [],
  localStorageMock = createLocalStorage(),
  navigator = {},
  confirmResult = true
}) {
  const url = new URL(href);
  const menus = [];
  const payloads = [];
  const alerts = [];
  const confirms = [];
  const consoleCalls = {
    info: [],
    log: [],
    warn: [],
    error: []
  };
  const document = documentOverride || createDocument(url, iframes, { documentElementInitiallyMissing });
  const observedTargets = [];
  const observers = [];

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target) {
      if (!target) throw new TypeError('MutationObserver target must be a Node');
      observedTargets.push(target);
    }

    disconnect() {}
  }

  const sandbox = {
    URL,
    alert(message) {
      alerts.push(String(message));
    },
    confirm(message) {
      confirms.push(String(message));
      return typeof confirmResult === 'function' ? confirmResult(String(message)) : confirmResult;
    },
    console: {
      info(...args) {
        consoleCalls.info.push(args);
      },
      log(...args) {
        consoleCalls.log.push(args);
      },
      warn(...args) {
        consoleCalls.warn.push(args);
      },
      error(...args) {
        consoleCalls.error.push(args);
      }
    },
    document,
    GM_addElement(_parent, tagName, attributes) {
      assert.equal(tagName, 'script');
      assert.equal(typeof attributes?.textContent, 'string');
      payloads.push(attributes.textContent);
      return {};
    },
    GM_getValue(key, fallback) {
      return gmStore.getValue(key, fallback);
    },
    GM_registerMenuCommand(label, callback) {
      menus.push({ label: String(label), callback });
      return menus.length;
    },
    GM_setValue(key, value) {
      gmStore.setValue(key, value);
    },
    localStorage: localStorageMock.storage,
    location: {
      href: url.href,
      hostname: url.hostname,
      origin: url.origin
    },
    MutationObserver,
    navigator
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(exposeHooks ? exposeUserscriptTestHooks(USERSCRIPT_SOURCE) : USERSCRIPT_SOURCE, context, {
    filename: USERSCRIPT_PATH
  });

  return {
    alerts,
    confirms,
    consoleCalls,
    context,
    document,
    localStorageMock,
    menus,
    observedTargets,
    observers,
    payloads
  };
}

function findMenu(run, labelPattern) {
  const matches = run.menus.filter(menu => labelPattern.test(menu.label));
  assert.equal(matches.length, 1, `expected one menu matching ${labelPattern}, got: ${run.menus.map(menu => menu.label).join(' | ')}`);
  return matches[0];
}

function parsePayloadSnapshot(payload) {
  const marker = '})(Object.freeze(';
  const start = payload.lastIndexOf(marker);
  assert.notEqual(start, -1, 'payload must call its entry point with an Object.freeze snapshot');

  const tail = payload.slice(start + marker.length).trim();
  assert.ok(tail.endsWith('));'), 'payload snapshot call must end with ));');
  return JSON.parse(tail.slice(0, -3));
}

test('origins A and B share GM runtime while conflicting or hostile localStorage is ignored at startup', () => {
  const gmStore = createSharedGmStore({
    schemaVersion: 1,
    globalEnabled: true,
    debugEnabled: true,
    disabledHostPatterns: [],
    runtime: {
      maxConcurrentPrefetches: 9,
      maxMemoryMb: 224,
      prefetchStrategy: 'fetch-only'
    }
  });
  const localA = createLocalStorage({
    HLS_BIGBUF_CONC_GLOBAL: 1,
    HLS_BIGBUF_MAX_MEM_MB: 16,
    HLS_BIGBUF_PREFETCH_STRATEGY: 'xhr-only'
  });
  const localB = createLocalStorage({
    HLS_BIGBUF_CONC_GLOBAL: 16,
    HLS_BIGBUF_MAX_MEM_MB: 512,
    HLS_BIGBUF_PREFETCH_STRATEGY: '</script><script>throw new Error("owned")</script>'
  }, {
    readError: new Error('website denied localStorage access')
  });

  const runA = runUserscript({
    href: 'https://a.example/watch',
    gmStore,
    localStorageMock: localA
  });
  const runB = runUserscript({
    href: 'https://b.example/player',
    gmStore,
    localStorageMock: localB
  });

  assert.notStrictEqual(localA.storage, localB.storage);
  assert.equal(runA.payloads.length, 1);
  assert.equal(runB.payloads.length, 1);

  const snapshotA = parsePayloadSnapshot(runA.payloads[0]);
  const snapshotB = parsePayloadSnapshot(runB.payloads[0]);
  assert.deepEqual(snapshotA, snapshotB);
  assert.equal(snapshotA.debugEnabled, true);
  assert.equal(snapshotA.maxConcurrentPrefetches, 9);
  assert.equal(snapshotA.maxMemoryMb, 224);
  assert.equal(snapshotA.prefetchStrategy, 'fetch-only');
  assert.equal(localA.stats.reads, 0);
  assert.equal(localB.stats.reads, 0);
});

test('explicit legacy import is allowlisted and the configuration save path updates global runtime only', () => {
  const gmStore = createSharedGmStore({
    schemaVersion: 1,
    globalEnabled: true,
    debugEnabled: true,
    disabledHostPatterns: ['blocked.example'],
    runtime: {
      maxMemoryMb: 224
    }
  });
  const localStorageMock = createLocalStorage({
    HLS_BIGBUF_ENABLE: '0',
    HLS_BIGBUF_DEBUG: '0',
    HLS_BIGBUF_BLOCKLIST: '["*.example"]',
    HLS_BIGBUF_CONC_GLOBAL: '14',
    HLS_BIGBUF_PREFETCH: '0'
  });
  const controller = runUserscript({
    href: 'https://a.example/watch',
    exposeHooks: true,
    gmStore,
    localStorageMock
  });

  assert.equal(localStorageMock.stats.reads, 0);
  const hooks = controller.context.__STREAMBOOST_TEST_HOOKS__;
  const legacy = cloneJson(hooks.readLegacyRuntimeOverrides());
  assert.deepEqual(legacy, {
    maxConcurrentPrefetches: 14,
    prefetchEnabled: false
  });
  assert.equal(localStorageMock.stats.reads, 12);

  const current = cloneJson(hooks.loadSettings());
  hooks.updateRuntimeConfig({ ...current.runtime, ...legacy });

  const saved = gmStore.values.get(SETTINGS_STORAGE_KEY);
  assert.equal(saved.globalEnabled, true);
  assert.equal(saved.debugEnabled, true);
  assert.deepEqual(saved.disabledHostPatterns, ['blocked.example']);
  assert.equal(saved.runtime.maxConcurrentPrefetches, 14);
  assert.equal(saved.runtime.prefetchEnabled, false);
  assert.equal(saved.runtime.maxMemoryMb, 224);

  const otherOrigin = runUserscript({
    href: 'https://b.example/player',
    gmStore
  });
  const snapshot = parsePayloadSnapshot(otherOrigin.payloads[0]);
  assert.equal(snapshot.maxConcurrentPrefetches, 14);
  assert.equal(snapshot.prefetchEnabled, false);
});

test('the global master menu disables injection across origins through the shared GM store', () => {
  const gmStore = createSharedGmStore();
  const controller = runUserscript({
    href: 'https://a.example/watch',
    gmStore
  });

  findMenu(controller, /全局状态/).callback();

  assert.equal(gmStore.values.get(SETTINGS_STORAGE_KEY).globalEnabled, false);
  assert.equal(controller.alerts.length, 1);
  assert.match(controller.alerts[0], /已停用全局/);

  const runA = runUserscript({
    href: 'https://a.example/another-page',
    gmStore
  });
  const runB = runUserscript({
    href: 'https://b.example/player',
    gmStore
  });
  assert.equal(runA.payloads.length, 0);
  assert.equal(runB.payloads.length, 0);
});

test('stale page menu callbacks patch the latest GM record without reverting unrelated settings', () => {
  const gmStore = createSharedGmStore();
  const runA = runUserscript({
    href: 'https://a.example/watch',
    gmStore
  });
  const staleRunB = runUserscript({
    href: 'https://b.example/player',
    gmStore
  });

  findMenu(runA, /全局状态/).callback();
  findMenu(staleRunB, /Debug 日志/).callback();
  findMenu(staleRunB, /停用当前(?:域名|主机名)/).callback();

  const saved = gmStore.values.get(SETTINGS_STORAGE_KEY);
  assert.equal(saved.globalEnabled, false);
  assert.equal(saved.debugEnabled, true);
  assert.deepEqual(saved.disabledHostPatterns, ['b.example']);
});

test('wildcard removal patches the latest GM record after confirmation without rolling back concurrent changes', () => {
  const gmStore = createSharedGmStore({
    schemaVersion: 1,
    globalEnabled: true,
    debugEnabled: false,
    disabledHostPatterns: ['*.example'],
    runtime: {
      maxConcurrentPrefetches: 4
    }
  });
  const controller = runUserscript({
    href: 'https://video.example/watch',
    gmStore,
    confirmResult() {
      gmStore.setValue(SETTINGS_STORAGE_KEY, {
        schemaVersion: 1,
        globalEnabled: false,
        debugEnabled: true,
        disabledHostPatterns: ['*.example', 'video.example', 'new.example'],
        runtime: {
          maxConcurrentPrefetches: 11
        }
      });
      return true;
    }
  });

  findMenu(controller, /移除当前主机名停用规则/).callback();

  const saved = gmStore.values.get(SETTINGS_STORAGE_KEY);
  assert.equal(saved.globalEnabled, false);
  assert.equal(saved.debugEnabled, true);
  assert.equal(saved.runtime.maxConcurrentPrefetches, 11);
  assert.deepEqual(saved.disabledHostPatterns, ['video.example', 'new.example']);
  assert.match(controller.alerts.at(-1), /仍被其他新规则停用/);
  assert.match(controller.alerts.at(-1), /全局开关仍处于停用状态/);
});

test('a domain disable rule blocks only the matching host', () => {
  const gmStore = createSharedGmStore();
  const controller = runUserscript({
    href: 'https://a.example/watch',
    gmStore
  });

  findMenu(controller, /停用当前(?:域名|主机名)/).callback();

  const saved = gmStore.values.get(SETTINGS_STORAGE_KEY);
  assert.equal(saved.globalEnabled, true);
  assert.deepEqual(saved.disabledHostPatterns, ['a.example']);

  const runA = runUserscript({
    href: 'https://a.example/another-page',
    gmStore
  });
  const runB = runUserscript({
    href: 'https://b.example/player',
    gmStore
  });
  assert.equal(runA.payloads.length, 0);
  assert.equal(runB.payloads.length, 1);
});

test('an IPv6 hostname rule persists and applies across ports', () => {
  const gmStore = createSharedGmStore();
  const controller = runUserscript({
    href: 'https://[::1]:8443/watch',
    gmStore
  });

  findMenu(controller, /停用当前(?:域名|主机名)/).callback();

  const saved = gmStore.values.get(SETTINGS_STORAGE_KEY);
  assert.deepEqual(saved.disabledHostPatterns, ['[::1]']);
  const sameHostDifferentPort = runUserscript({
    href: 'https://[::1]:9443/player',
    gmStore
  });
  assert.equal(sameHostDifferentPort.payloads.length, 0);
});

test('an inherited about:blank frame uses its parent hostname for the disable policy', () => {
  const gmStore = createSharedGmStore({
    schemaVersion: 1,
    globalEnabled: true,
    disabledHostPatterns: ['a.example']
  });
  const inheritedFrame = {
    contentDocument: createDocument(new URL('about:blank')),
    addEventListener() {}
  };
  const run = runUserscript({
    href: 'https://a.example/watch',
    gmStore,
    iframes: [inheritedFrame]
  });

  assert.equal(run.payloads.length, 0);
});

test('document-start waits for documentElement before injecting and observing iframes', () => {
  const gmStore = createSharedGmStore();
  const run = runUserscript({
    href: 'https://a.example/watch',
    documentElementInitiallyMissing: true,
    gmStore
  });

  assert.equal(run.payloads.length, 0);
  assert.equal(run.observedTargets.length, 0);
  run.document.installDocumentElement();
  assert.equal(run.payloads.length, 1);
  assert.deepEqual(run.observedTargets, [run.document.documentElement]);
});

test('the iframe observer scans nested frames inside dynamically added containers', () => {
  const gmStore = createSharedGmStore();
  const run = runUserscript({
    href: 'https://a.example/watch',
    gmStore
  });
  const nestedFrame = {
    tagName: 'IFRAME',
    contentDocument: createDocument(new URL('about:blank')),
    addEventListener() {}
  };
  const container = {
    tagName: 'DIV',
    querySelectorAll(selector) {
      return selector === 'iframe' ? [nestedFrame] : [];
    }
  };

  assert.equal(run.payloads.length, 1);
  assert.equal(run.observers.length, 1);
  run.observers[0].callback([{ addedNodes: [container] }]);
  assert.equal(run.payloads.length, 2);
});

test('repeated iframe load events do not inject the same document twice', () => {
  let loadHandler;
  const gmStore = createSharedGmStore();
  const frame = {
    contentDocument: createDocument(new URL('about:blank')),
    addEventListener(type, callback) {
      if (type === 'load') loadHandler = callback;
    }
  };
  const run = runUserscript({
    href: 'https://a.example/watch',
    gmStore,
    iframes: [frame]
  });

  assert.equal(run.payloads.length, 2);
  assert.equal(typeof loadHandler, 'function');
  loadHandler();
  assert.equal(run.payloads.length, 2);
});

test('an ordinary same-origin HTTPS iframe is injected only by its own userscript instance', () => {
  let loadHandler;
  const gmStore = createSharedGmStore();
  const frameDocument = createDocument(new URL('https://a.example/frame'));
  const frame = {
    contentDocument: frameDocument,
    addEventListener(type, callback) {
      if (type === 'load') loadHandler = callback;
    }
  };
  const parentRun = runUserscript({
    href: 'https://a.example/watch',
    gmStore,
    iframes: [frame]
  });

  assert.equal(parentRun.payloads.length, 1);
  loadHandler();
  assert.equal(parentRun.payloads.length, 1);

  const frameRun = runUserscript({
    href: 'https://a.example/frame',
    documentOverride: frameDocument,
    gmStore
  });
  assert.equal(frameRun.payloads.length, 1);
});

test('invalid GM settings are normalized before the payload snapshot is built', () => {
  const gmStore = createSharedGmStore({
    schemaVersion: 'not-a-version',
    globalEnabled: null,
    debugEnabled: 'not-a-boolean',
    disabledHostPatterns: [' *.OTHER.EXAMPLE. ', 'https://invalid.example/path', '*.other.example', ''],
    runtime: {
      prefetchAhead: 999,
      maxConcurrentPrefetches: -5,
      maxConcurrentPrefetchesPerOrigin: 'not-a-number',
      inflightReuseWaitMs: 1.6,
      forwardBufferSeconds: '',
      backBufferSeconds: -100,
      maxBufferSeconds: 99999,
      maxMemoryMb: 'Infinity',
      prefetchEnabled: '0',
      memoryCacheEnabled: 'yes',
      prefetchTimeoutMs: 100,
      prefetchStrategy: 'execute-arbitrary-code'
    }
  });

  const run = runUserscript({
    href: 'https://a.example/watch',
    gmStore
  });
  assert.equal(run.payloads.length, 1);

  const snapshot = parsePayloadSnapshot(run.payloads[0]);
  assert.deepEqual(snapshot, {
    debugEnabled: false,
    prefetchAhead: 60,
    maxConcurrentPrefetches: 1,
    maxConcurrentPrefetchesPerOrigin: 4,
    inflightReuseWaitMs: 2,
    forwardBufferSeconds: 600,
    backBufferSeconds: 0,
    maxBufferSeconds: 7200,
    maxMemoryMb: 128,
    prefetchEnabled: false,
    memoryCacheEnabled: false,
    prefetchTimeoutMs: 1000,
    prefetchStrategy: 'xhr-hls-fetch'
  });
});

test('captured payload is storage-agnostic and contains the resolved runtime snapshot', () => {
  const gmStore = createSharedGmStore({
    globalEnabled: true,
    debugEnabled: false,
    runtime: {
      prefetchAhead: 23,
      maxConcurrentPrefetches: 7
    }
  });
  const run = runUserscript({
    href: 'https://a.example/watch',
    gmStore
  });

  assert.equal(run.payloads.length, 1);
  const payload = run.payloads[0];
  assert.doesNotThrow(() => new vm.Script(payload));
  assert.doesNotMatch(payload, /\blocalStorage\b/);
  assert.doesNotMatch(payload, /\bGM(?:[_.]|[A-Z])/);

  const snapshot = parsePayloadSnapshot(payload);
  assert.equal(snapshot.prefetchAhead, 23);
  assert.equal(snapshot.maxConcurrentPrefetches, 7);
  assert.doesNotMatch(payload, /if \(window\.__HLS_BIGBUF_ACTIVE__ === ACTIVE_MARKER\) return;/);
  assert.match(payload, /const firstActivation = window\.__HLS_BIGBUF_ACTIVE__ !== ACTIVE_MARKER;/);
  assert.match(payload, /function takeOriginSlot\(origin\) \{\s+const cap = PREFETCH_CONC_PER_ORIGIN;/);
});

test('GM read failures and future schemas fail closed without overwriting stored settings', async t => {
  await t.test('GM_getValue failure', () => {
    const gmStore = createSharedGmStore(undefined, {
      getError: new Error('simulated GM read failure')
    });
    const localStorageMock = createLocalStorage({
      HLS_BIGBUF_ENABLE: '1',
      HLS_BIGBUF_CONC_GLOBAL: '16'
    });
    const run = runUserscript({
      href: 'https://a.example/watch',
      gmStore,
      localStorageMock
    });

    assert.equal(run.payloads.length, 0);
    assert.equal(localStorageMock.stats.reads, 0);
    assert.equal(run.consoleCalls.warn.length, 1);
    findMenu(run, /全局状态/).callback();
    assert.match(run.alerts.at(-1), /^更新失败：/);
  });

  await t.test('future schema', () => {
    const futureSettings = {
      schemaVersion: 99,
      globalEnabled: true,
      debugEnabled: true,
      disabledHostPatterns: [],
      runtime: { maxConcurrentPrefetches: 16 }
    };
    const gmStore = createSharedGmStore(futureSettings);
    const run = runUserscript({
      href: 'https://a.example/watch',
      gmStore
    });

    assert.equal(run.payloads.length, 0);
    findMenu(run, /全局状态/).callback();
    assert.match(run.alerts.at(-1), /^更新失败：/);
    assert.deepEqual(gmStore.values.get(SETTINGS_STORAGE_KEY), futureSettings);
  });
});

test('mutating menus report failure, never success, when GM_setValue throws', async t => {
  const menuCases = [
    { name: 'global master', pattern: /全局状态/ },
    { name: 'domain disable', pattern: /停用当前(?:域名|主机名)/ },
    { name: 'debug', pattern: /Debug 日志/ }
  ];

  for (const menuCase of menuCases) {
    await t.test(menuCase.name, () => {
      const gmStore = createSharedGmStore(undefined, {
        setError: new Error('simulated GM quota failure')
      });
      const run = runUserscript({
        href: 'https://a.example/watch',
        gmStore
      });

      findMenu(run, menuCase.pattern).callback();

      assert.equal(run.alerts.length, 1);
      assert.match(run.alerts[0], /^更新失败：/);
      assert.match(run.alerts[0], /simulated GM quota failure/);
      assert.doesNotMatch(run.alerts[0], /^已/);
      assert.equal(gmStore.values.has(SETTINGS_STORAGE_KEY), false);
    });
  }
});

test('missing navigator.deviceMemory defaults maxMemoryMb to 128', () => {
  const gmStore = createSharedGmStore();
  const run = runUserscript({
    href: 'https://a.example/watch',
    gmStore,
    navigator: {}
  });

  assert.equal(run.payloads.length, 1);
  assert.equal(parsePayloadSnapshot(run.payloads[0]).maxMemoryMb, 128);
});
