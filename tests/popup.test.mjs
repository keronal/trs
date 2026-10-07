import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadPopup(sendToPage) {
  const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
  const elements = new Map();
  let ready;
  const context = vm.createContext({
    document: {
      addEventListener: (_type, callback) => { ready = callback; },
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, {
          style: {}, classList: { add() {}, remove() {} }, listeners: {},
          addEventListener(type, callback) { this.listeners[type] = callback; },
        });
        return elements.get(id);
      },
    },
    chrome: {
      runtime: { sendMessage: async () => ({ hasApiKey: true, targetLang: 'zh-CN' }) },
      storage: { onChanged: { addListener() {} }, sync: { set: async () => {} } },
      tabs: { query: async () => [{ id: 1 }], sendMessage: (_id, message) => sendToPage(message) },
    },
    window: { addEventListener() {} },
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(source, context);
  await ready();
  await new Promise(resolve => setImmediate(resolve));
  return elements;
}

test('an unreachable page disables translation controls instead of claiming readiness', async () => {
  const elements = await loadPopup(async () => { throw new Error('no receiver'); });
  assert.equal(elements.get('btnTranslate').disabled, true);
  assert.equal(elements.get('btnRetranslate').disabled, true);
  assert.match(elements.get('btnTranslateText').textContent, /不支持/);
});

test('a refused start uses page status and reports the exclusion reason', async () => {
  let error = '';
  const elements = await loadPopup(async message => {
    if (message.type === 'START_TRANSLATION') {
      error = '此网站已在排除列表中';
      return { success: false, isActive: false, error };
    }
    return { isActive: false, isTranslating: false, error };
  });
  await elements.get('btnTranslate').listeners.click();
  assert.equal(elements.get('btnTranslateText').textContent, '翻译本页');
  assert.equal(elements.get('statusText').textContent, error);
});
