import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function readStorage(values, keys) {
  if (keys == null) return { ...values };
  if (typeof keys === 'string') return { [keys]: values[keys] };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]));
  }
  return { ...keys, ...values };
}

function removeStorage(values, keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
}

async function loadBackground(fetchImpl, syncValues = {}, localValues = {}, timer = setTimeout) {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const messageListeners = [];
  const context = vm.createContext({
    AbortController,
    console,
    fetch: fetchImpl,
    setTimeout: timer,
    clearTimeout,
    chrome: {
      storage: {
        sync: {
          get: async keys => readStorage(syncValues, keys),
          set: async values => Object.assign(syncValues, values),
          remove: async keys => removeStorage(syncValues, keys),
          setAccessLevel: async () => {},
        },
        local: {
          get: async keys => readStorage(localValues, keys),
          set: async values => Object.assign(localValues, values),
          setAccessLevel: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        id: 'test-extension',
        onMessage: { addListener: listener => messageListeners.push(listener) },
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
  context.__syncValues = syncValues;
  context.__localValues = localValues;
  context.__messageListeners = messageListeners;
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

test('empty translations are not cached', async () => {
  const localValues = { translationCache: [['old-empty', '']] };
  const context = await loadBackground(async () => {}, {}, localValues);
  await vm.runInContext('initPromise', context);

  const cached = vm.runInContext(
    `addToCache('empty', ''); translationCache.has('empty') || translationCache.has('old-empty')`,
    context,
  );

  assert.equal(cached, false);
});

test('legacy API key moves to local storage and is hidden from settings', async () => {
  const syncValues = { apiKey: 'legacy-key' };
  const localValues = {};
  const context = await loadBackground(async () => {}, syncValues, localValues);

  const settings = await vm.runInContext('getSettings()', context);

  assert.equal(settings.hasApiKey, true);
  assert.equal('apiKey' in settings, false);
  assert.equal(localValues.apiKey, 'legacy-key');
  assert.equal('apiKey' in syncValues, false);
});

test('options tab can set the API key while content scripts cannot read it', async () => {
  const localValues = {};
  const context = await loadBackground(async () => {}, {}, localValues);
  const listener = context.__messageListeners[0];
  const optionsSender = {
    id: 'test-extension',
    url: 'chrome-extension://test-extension/options.html',
    tab: { id: 12 },
  };

  const saved = await new Promise(resolve => {
    listener({ type: 'SET_API_KEY', apiKey: 'new-key' }, optionsSender, resolve);
  });
  const denied = await new Promise(resolve => {
    listener({ type: 'GET_API_KEY' }, {
      id: 'test-extension',
      url: 'https://example.com/',
      tab: { id: 12 },
    }, resolve);
  });

  assert.equal(saved.success, true);
  assert.equal(localValues.apiKey, 'new-key');
  assert.equal(denied.error, '无权读取 API Key');
});

test('long text is split without loss and uses only the local API key', async () => {
  const requests = [];
  const context = await loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ options, body });
    const content = body.messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  }, {}, { apiKey: 'local-key' });
  const text = 'x'.repeat(1199) + '😀' + 'y'.repeat(1300);
  context.__longText = text;
  const response = await vm.runInContext(
    `handleTranslateTexts({ texts: [__longText], targetLang: 'zh-CN', apiKey: 'untrusted-key' }, { tab: { id: 7 } })`,
    context,
  );
  assert.ok(requests.length > 1);
  for (const request of requests) {
    assert.equal(request.options.headers.Authorization, 'Bearer local-key');
    assert.ok(request.body.messages[1].content.length <= 2420);
  }
  assert.equal(response.translations[0].replaceAll('\n', ''), text);
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

test('numbered output retains continuation lines and literal brackets', async () => {
  const context = await loadBackground(async () => {});
  const results = vm.runInContext(`parseBatchResult(' [0] 第一行\\n第二行 [参考]\\n[1] 下一段', 2)`, context);
  assert.deepEqual([...results], ['第一行\n第二行 [参考]', '下一段']);
  assert.notEqual(vm.runInContext(`getCacheKey('Aa', 'zh-CN')`, context),
    vm.runInContext(`getCacheKey('BB', 'zh-CN')`, context));
});

test('missing or truncated entries are supplemented without retranslating completed entries', async () => {
  const requests = [];
  const context = await loadBackground(async (_url, options) => {
    requests.push(JSON.parse(options.body).messages[1].content);
    return { ok: true, json: async () => ({ choices: [{
      finish_reason: requests.length === 1 ? 'length' : 'stop',
      message: { content: requests.length === 1 ? '[0] 完整\n[1] 半句' : '[0] 补全' },
    }] }) };
  });
  const result = await vm.runInContext(`translateComplete(['First', 'Second'], 'zh-CN', 'key', undefined, 1)`, context);
  assert.deepEqual([...result], ['完整', '补全']);
  assert.deepEqual(requests, ['[0] First\n\n[1] Second', '[0] Second']);
});

test('permanent API errors do not retry and retain an actionable message', async () => {
  for (const status of [400, 401, 402, 403]) {
    let calls = 0;
    const context = await loadBackground(async () => { calls++; return { ok: false, status }; });
    await assert.rejects(vm.runInContext(`translateWithRetry(['Hello'], 'zh-CN', 'key', undefined, 1)`, context),
      error => error.retryable === false && (status !== 401 || error.message.includes('API Key')));
    assert.equal(calls, 1);
  }
});

test('rate limiting retries in the background', async () => {
  let calls = 0;
  const context = await loadBackground(async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 429 } : {
      ok: true, json: async () => ({ choices: [{ message: { content: '[0] 你好' } }] }),
    };
  }, {}, {}, (fn, ms) => setTimeout(fn, ms === 1000 ? 1 : ms));
  assert.deepEqual([...await vm.runInContext(`translateWithRetry(['Hello'], 'zh-CN', 'key', undefined, 1)`, context)], ['你好']);
  assert.equal(calls, 2);
});

test('the timeout remains active while reading the response body', async () => {
  const context = await loadBackground(async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    })),
  }), {}, {}, (fn, ms) => setTimeout(fn, ms === 45000 ? 5 : ms));
  await assert.rejects(vm.runInContext(`callDeepSeekAPI(['Hello'], 'zh-CN', 'key', undefined, new AbortController())`, context), /超时/);
});

test('forced translation bypasses cache and refreshes the cached result', async () => {
  let calls = 0;
  const context = await loadBackground(async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: `[0] 译文${++calls}` } }] }),
  }), {}, { apiKey: 'key' });
  const translate = force => vm.runInContext(`handleTranslateTexts({texts:['Hello'], bypassCache:${force}}, {tab:{id:1}})`, context);
  assert.equal((await translate(false)).translations[0], '译文1');
  assert.equal((await translate(false)).translations[0], '译文1');
  assert.equal((await translate(true)).translations[0], '译文2');
  assert.equal((await translate(false)).translations[0], '译文2');
  assert.equal(calls, 2);
});

test('invalid translation messages are rejected before fetching', async () => {
  const context = await loadBackground(() => assert.fail('must not fetch'), {}, { apiKey: 'key' });
  for (const texts of ['bad', [1], ['x'.repeat(100001)]]) {
    context.__texts = texts;
    const result = await vm.runInContext('handleTranslateTexts({texts:__texts}, {})', context);
    assert.equal(result.retryable, false);
  }
});
