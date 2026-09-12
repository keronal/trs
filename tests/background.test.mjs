import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadBackground(fetchImpl, syncValues = {}) {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    AbortController,
    console,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    chrome: {
      storage: {
        sync: {
          get: async defaults => ({ ...defaults, ...syncValues }),
          set: async values => Object.assign(syncValues, values),
        },
        local: {
          get: async () => ({}),
          set: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
      },
      commands: { onCommand: { addListener: () => {} } },
      tabs: {
        get: async () => ({}),
        onRemoved: { addListener: () => {} },
        sendMessage: async () => {},
      },
    },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return context;
}

test('DeepSeek V4.1 Flash uses the current model name with thinking disabled', async () => {
  let request;
  const context = await loadBackground(async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '[0] 你好\n[1] 世界' } }] }),
    };
  });

  const translations = await vm.runInContext(
    `callDeepSeekAPI(['Hello', 'World'], 'zh-CN', 'test-key', undefined, new AbortController())`,
    context,
  );

  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.deepEqual([...translations], ['你好', '世界']);
});

test('legacy V4 Flash settings migrate to V4.1 Flash', async () => {
  const stored = { model: 'deepseek-v4-flash' };
  const context = await loadBackground(async () => {}, stored);

  const settings = await vm.runInContext('getSettings()', context);

  assert.equal(settings.model, 'deepseek-flash');
  assert.equal(stored.model, 'deepseek-flash');
});

test('translation cache is isolated by model', async () => {
  const context = await loadBackground(async () => {});
  const flashKey = vm.runInContext(
    `getCacheKey('Hello', 'zh-CN', 'deepseek-flash')`,
    context,
  );
  const proKey = vm.runInContext(
    `getCacheKey('Hello', 'zh-CN', 'deepseek-v4-pro')`,
    context,
  );

  assert.notEqual(flashKey, proKey);
});

test('cancelling a tab aborts its in-flight request without retrying', async () => {
  let calls = 0;
  const context = await loadBackground((_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });

  const pending = vm.runInContext(
    `translateWithRetry(['Hello'], 'zh-CN', 'test-key', 'deepseek-flash', 42, 2)`,
    context,
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  vm.runInContext('cancelTabRequests(42)', context);

  await assert.rejects(pending, error => error.name === 'CancelledError');
  assert.equal(calls, 1);
});

test('cancelling during retry backoff prevents the next request', async () => {
  let calls = 0;
  const context = await loadBackground(async () => {
    calls++;
    throw new Error('temporary failure');
  });

  const pending = vm.runInContext(
    `translateWithRetry(['Hello'], 'zh-CN', 'test-key', 'deepseek-flash', 84, 2)`,
    context,
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  vm.runInContext('cancelTabRequests(84)', context);

  await assert.rejects(pending, error => error.name === 'CancelledError');
  assert.equal(calls, 1);
});
