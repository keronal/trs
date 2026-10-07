import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('translations cannot become browser scroll anchors', async () => {
  const css = await readFile(new URL('../content.css', import.meta.url), 'utf8');
  const rule = css.match(/\.trs-translation\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(rule, /overflow-anchor:\s*none\s*!important/);
});

test('inactive pages do not start a mutation observer', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  let domReady;
  let observers = 0;
  const document = {
    readyState: 'loading',
    body: { classList: { add() {}, remove() {} } },
    head: { appendChild() {} },
    addEventListener(type, callback) {
      if (type === 'DOMContentLoaded') domReady = callback;
    },
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: () => null,
  };
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async () => ({
          autoTranslate: false,
          excludedDomains: [],
          hasApiKey: true,
        }),
      },
    },
    console,
    document,
    MutationObserver: class { constructor() { observers++; } },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    requestAnimationFrame: callback => callback(),
    setTimeout,
    clearTimeout,
    window: {
      addEventListener() {},
      location: { hostname: 'example.com' },
    },
  });

  vm.runInContext(source, context, { filename: 'content.js' });
  await domReady();

  assert.equal(observers, 0);
});

test('translation color follows the original while preserving readable contrast', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__trsTest = { applyAdaptiveColor };})();',
  );
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
    document: { readyState: 'loading', addEventListener() {} },
    MutationObserver: class {},
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    requestAnimationFrame: callback => callback(),
    setTimeout,
    clearTimeout,
    window: {
      addEventListener() {},
      location: { hostname: 'example.com' },
      getComputedStyle: element => ({
        backgroundColor: element.backgroundColor,
        color: element.color,
      }),
    },
  });
  vm.runInContext(instrumented, context, { filename: 'content.js' });

  function translatedAgainst(backgroundColor, originalColor) {
    const properties = {};
    const translation = {
      style: { setProperty: (name, value) => { properties[name] = value; } },
    };
    const background = { backgroundColor, color: originalColor, parentElement: null };
    const text = {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      color: originalColor,
      parentElement: background,
    };
    context.__trsTest.applyAdaptiveColor(translation, text);
    return properties['--trs-color'];
  }

  const parseColor = color => color.match(/\d+/g).map(Number);
  const luminance = color => {
    const [r, g, b] = color.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (first, second) => {
    const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (values[1] + 0.05) / (values[0] + 0.05);
  };

  assert.equal(translatedAgainst('rgb(250, 250, 250)', 'rgb(31, 41, 55)'), 'rgb(31,41,55)');
  assert.equal(translatedAgainst('rgb(18, 18, 18)', 'rgb(226, 232, 240)'), 'rgb(226,232,240)');

  const correctedOnLight = parseColor(translatedAgainst('rgb(250, 250, 250)', 'rgb(210, 210, 210)'));
  const correctedOnDark = parseColor(translatedAgainst('rgb(18, 18, 18)', 'rgb(40, 40, 40)'));
  assert.ok(contrast(correctedOnLight, [250, 250, 250]) >= 4.5);
  assert.ok(contrast(correctedOnDark, [18, 18, 18]) >= 4.5);
});

test('removing translations keeps the current reading anchor in place', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__trsTest = { removeAllTranslations };})();',
  );
  let anchorTop = 300;
  let scrollTop = 1000;
  const animationFrames = [];
  const body = {};
  const documentElement = {};
  const scroller = {};
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set(value) {
      anchorTop -= value - scrollTop;
      scrollTop = value;
    },
  });
  const anchor = {
    isConnected: true,
    parentElement: body,
    getBoundingClientRect: () => ({ top: anchorTop }),
  };
  const translation = {
    parentElement: anchor,
    getBoundingClientRect: () => ({ top: 280, bottom: 320 }),
    remove: () => { anchorTop -= 180; },
  };
  const document = {
    readyState: 'loading',
    addEventListener() {},
    body,
    documentElement,
    scrollingElement: scroller,
    querySelectorAll: () => [translation],
  };
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
    document,
    MutationObserver: class {},
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    requestAnimationFrame: callback => animationFrames.push(callback),
    setTimeout,
    clearTimeout,
    window: {
      addEventListener() {},
      getComputedStyle: () => ({ position: 'static', overflowY: 'visible' }),
      innerHeight: 800,
      innerWidth: 1200,
      location: { hostname: 'example.com' },
    },
  });
  vm.runInContext(instrumented, context, { filename: 'content.js' });

  context.__trsTest.removeAllTranslations();
  anchorTop -= 60; // 模拟 SPA 在下一帧再次计算列表高度。
  while (animationFrames.length) animationFrames.shift()();

  assert.equal(anchorTop, 300);
  assert.equal(scrollTop, 760);
});

async function loadContentForChecks() {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  let listener;
  let mutationCallback;
  const observed = [];
  const body = {
    nodeType: 1, isConnected: true, matches: () => false,
    querySelectorAll: () => [], appendChild() {},
  };
  const document = {
    readyState: 'loading', addEventListener() {}, body, documentElement: {},
    head: { appendChild() {} }, getElementById: () => ({ textContent: '' }),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ classList: { add() {}, remove() {} } }),
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  const context = vm.createContext({
    chrome: { runtime: {
      onMessage: { addListener: callback => { listener = callback; } },
      sendMessage: async () => ({ success: true }),
    } },
    console, document,
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe(...args) { observed.push(args); } disconnect() {}
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, NodeFilter: { SHOW_ELEMENT: 1 },
    requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
    window: {
      location: { hostname: 'example.com' }, innerHeight: 800, innerWidth: 1200,
      getComputedStyle: element => element.computedStyle,
    },
  });
  vm.runInContext(source.replace(/\}\)\(\);\s*$/,
    `globalThis.__trsTest = { collectFromRoot, isInlineElement, containsBlockElement,
      isEffectivelyHidden, setupMutationObserver, startTranslation, translateBatch,
      configure(value) { settings = value; },
      get state() { return { isActive, runId, bypassCache, lastError }; }
    };})();`), context);
  return { context, api: context.__trsTest, document, observed,
    mutate: records => mutationCallback(records),
    message: message => new Promise(resolve => listener(message, {}, resolve)),
  };
}

test('language and model changes restart active translation; explicit retranslation bypasses cache', async () => {
  const { api, message } = await loadContentForChecks();
  api.configure({ hasApiKey: true, targetLang: 'zh-CN', model: 'flash' });
  await api.startTranslation();
  const originalRun = api.state.runId;
  await message({ type: 'UPDATE_SETTINGS', settings: { targetLang: 'ja' } });
  assert.ok(api.state.runId > originalRun);
  assert.equal(api.state.isActive, true);
  assert.equal(api.state.bypassCache, false);
  const languageRun = api.state.runId;
  await message({ type: 'UPDATE_SETTINGS', settings: { model: 'pro' } });
  assert.ok(api.state.runId > languageRun);
  await message({ type: 'RETRANSLATE_PAGE' });
  assert.equal(api.state.bypassCache, true);
  await message({ type: 'UPDATE_SETTINGS', settings: { excludedDomains: ['example.com'] } });
  assert.equal(api.state.isActive, false);
  const denied = await message({ type: 'START_TRANSLATION' });
  assert.equal(denied.success, false);
  assert.match(denied.error, /排除/);
});

test('DOM changes invalidate visibility, inline and block structure caches', async () => {
  const { api, mutate, observed, document } = await loadContentForChecks();
  api.configure({ hasApiKey: true });
  await api.startTranslation();
  const element = {
    nodeType: 1, isConnected: true, closest: () => null, children: [],
    computedStyle: { display: 'none', visibility: 'hidden' },
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  assert.equal(api.isEffectivelyHidden(element), true);
  assert.equal(api.isInlineElement(element), false);
  assert.equal(api.containsBlockElement(element), false);
  element.computedStyle = { display: 'inline', visibility: 'visible' };
  element.children = [{ tagName: 'DIV' }];
  mutate([{ type: 'attributes', target: element }]);
  assert.equal(api.isEffectivelyHidden(element), false);
  assert.equal(api.isInlineElement(element), true);
  assert.equal(api.containsBlockElement(element), true);
  assert.ok(observed.some(([root, options]) => root === document.documentElement && options.attributes));
});

test('case-distinct text is collected separately, avoiding snapshot mismatches', async () => {
  const { api, document } = await loadContentForChecks();
  const elements = ['Apple', 'apple'].map(text => ({
    nodeType: 1, isConnected: true, matches: selector => selector.startsWith('p,'),
    closest: () => null, computedStyle: { display: 'block', visibility: 'visible' },
    childNodes: [{ nodeType: 3, textContent: text }],
    getBoundingClientRect: () => ({ width: 100, height: 20, top: 200 }),
  }));
  document.createTreeWalker = () => {
    let index = 0;
    return { nextNode: () => elements[index++] || null };
  };
  assert.deepEqual(Array.from(api.collectFromRoot(document.body, 300), entry => entry.text), ['Apple', 'apple']);
});

test('permanent background errors stop scheduling and remain visible in status', async () => {
  const { api, context, message } = await loadContentForChecks();
  api.configure({ hasApiKey: true });
  await api.startTranslation();
  let calls = 0;
  context.chrome.runtime.sendMessage = async message => {
    if (message.type === 'TRANSLATE_TEXTS') { calls++; return { error: 'API Key 无效', retryable: false }; }
    return { success: true };
  };
  await api.translateBatch([{ text: 'Hello' }], api.state.runId);
  const status = await message({ type: 'GET_STATUS' });
  assert.equal(status.isActive, false);
  assert.equal(status.isTranslating, false);
  assert.equal(status.error, 'API Key 无效');
  assert.equal(calls, 1);
});

test('stopping while retranslation awaits cancellation prevents a delayed restart', async () => {
  const { api, context, message } = await loadContentForChecks();
  api.configure({ hasApiKey: true });
  await api.startTranslation();
  let release;
  let calls = 0;
  context.chrome.runtime.sendMessage = async () => {
    if (++calls === 1) await new Promise(resolve => { release = resolve; });
    return { success: true };
  };
  const retranslation = message({ type: 'RETRANSLATE_PAGE' });
  await message({ type: 'STOP_TRANSLATION' });
  release();
  await retranslation;
  assert.equal(api.state.isActive, false);
});
