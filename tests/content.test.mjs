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
