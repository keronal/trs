// ============================================================
// TRS Background Service Worker
// 处理翻译请求队列、DeepSeek API 调用、缓存管理
// ============================================================

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';
const DEFAULT_MAX_CONCURRENT = 8;
const MAX_RETRIES = 2;
// 内容侧已改为连续优先级调度，挂起请求只占用一个并发槽（不会阻塞整条管线），
// 45s 足够覆盖正常慢请求，同时避免挂死槽位过久
const REQUEST_TIMEOUT = 45000;

// 翻译缓存：key = `${lang}:${text}`, value = translated text
const translationCache = new Map();
const CACHE_MAX_SIZE = 4000;
const CACHE_STORAGE_KEY = 'translationCache';
let cacheDirty = false;
let cacheSaveTimer = null;

// 请求队列管理
let activeRequests = 0;
let maxConcurrent = DEFAULT_MAX_CONCURRENT;
const pendingQueue = [];
// 每个标签页正在进行的请求；停止/重译时立即中断旧请求，释放并发槽。
const activeControllersByTab = new Map();

// 初始化时加载设置 + 恢复持久化缓存
(async function init() {
  const result = await chrome.storage.sync.get({ maxConcurrent: DEFAULT_MAX_CONCURRENT });
  maxConcurrent = result.maxConcurrent || DEFAULT_MAX_CONCURRENT;

  // 从 local storage 恢复缓存
  try {
    const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    if (stored[CACHE_STORAGE_KEY] && Array.isArray(stored[CACHE_STORAGE_KEY])) {
      for (const [key, value] of stored[CACHE_STORAGE_KEY]) {
        if (translationCache.size < CACHE_MAX_SIZE) {
          translationCache.set(key, value);
        }
      }
    }
  } catch (e) { /* 静默忽略 */ }
})();

// 缓存持久化（防抖写入，避免频繁 I/O）
function markCacheDirty() {
  cacheDirty = true;
  if (!cacheSaveTimer) {
    cacheSaveTimer = setTimeout(persistCache, 30000);
  }
}

async function persistCache() {
  cacheSaveTimer = null;
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    const entries = Array.from(translationCache.entries());
    const toSave = entries.slice(-CACHE_MAX_SIZE);
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: toSave });
  } catch (e) { /* 静默忽略 */ }
}

// 监听设置变更
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.maxConcurrent) {
    maxConcurrent = changes.maxConcurrent.newValue || DEFAULT_MAX_CONCURRENT;
    // 设置变更后尝试处理更多队列任务
    processQueue();
  }
});

// ============================================================
// 工具函数
// ============================================================

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

function getCacheKey(text, targetLang, model) {
  return `${model || 'deepseek-flash'}:${targetLang}:${hashText(text)}`;
}

function addToCache(key, translation) {
  if (translationCache.size >= CACHE_MAX_SIZE) {
    // 删除最旧的 20% 条目
    const keysToDelete = Math.floor(CACHE_MAX_SIZE * 0.2);
    const iter = translationCache.keys();
    for (let i = 0; i < keysToDelete; i++) {
      const entry = iter.next();
      if (!entry.done) translationCache.delete(entry.value);
    }
  }
  translationCache.set(key, translation);
  markCacheDirty();
}

// ============================================================
// DeepSeek API 调用
// ============================================================

async function callDeepSeekAPI(texts, targetLang, apiKey, model, controller) {
  const systemPrompt = getSystemPrompt(targetLang);
  const userContent = texts.map((t, i) => `[${i}] ${t}`).join('\n\n');

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'deepseek-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        // DeepSeek 当前模型默认开启 high 思考。网页翻译是直接转换任务，关闭思考可显著降低首字延迟。
        thinking: { type: 'disabled' },
        temperature: 0.1,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const rawOutput = data.choices?.[0]?.message?.content || '';

    // 解析返回的翻译结果
    return parseBatchResult(rawOutput, texts.length);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError' && !timedOut) {
      const cancelled = new Error('翻译请求已取消');
      cancelled.name = 'CancelledError';
      throw cancelled;
    }
    if (err.name === 'AbortError') {
      throw new Error('翻译请求超时，请检查网络或稍后重试');
    }
    throw err;
  }
}

function getSystemPrompt(targetLang) {
  const langNames = {
    'zh-CN': '简体中文',
    'zh-TW': '繁体中文',
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어',
    'fr': 'Français',
    'de': 'Deutsch',
    'es': 'Español',
    'ru': 'Русский',
    'pt': 'Português',
    'ar': 'العربية',
    'th': 'ไทย',
    'vi': 'Tiếng Việt',
  };
  const langName = langNames[targetLang] || targetLang;

  return `你是一个专业的翻译引擎。请将用户提供的每段文本翻译成${langName}。

重要规则：
1. 每段文本以 [数字] 开头，你必须严格按相同编号返回翻译结果
2. 返回格式必须是：每个翻译单独一行，以 [数字] 开头，后跟翻译内容
3. 保持原文的格式标记（如 HTML 标签）不变
4. 对于代码、数字、专有名词，保持原样不翻译
5. 翻译要准确、流畅、自然，符合${langName}的表达习惯
6. 如果某段文本已经是${langName}，则原样返回

示例输入：
[0] Hello, how are you?
[1] The weather is nice today.

示例输出：
[0] 你好，你怎么样？
[1] 今天天气不错。`;
}

function parseBatchResult(rawOutput, expectedCount) {
  const results = new Array(expectedCount).fill('');
  const lines = rawOutput.split('\n');

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) {
      const index = parseInt(match[1], 10);
      if (index >= 0 && index < expectedCount) {
        results[index] = match[2].trim();
      }
    }
  }

  // 对于没有匹配到的，尝试回退解析
  for (let i = 0; i < expectedCount; i++) {
    if (!results[i]) {
      // 尝试直接查找包含该序号的行
      const fallbackMatch = rawOutput.match(new RegExp(`\\[${i}\\][^\\[]*`, 's'));
      if (fallbackMatch) {
        const text = fallbackMatch[0].replace(/^\[\d+\]\s*/, '').trim();
        if (text) results[i] = text;
      }
    }
  }

  return results;
}

// ============================================================
// 带重试的翻译
// ============================================================

function trackController(tabId, controller) {
  if (tabId == null) return;
  let controllers = activeControllersByTab.get(tabId);
  if (!controllers) {
    controllers = new Set();
    activeControllersByTab.set(tabId, controllers);
  }
  controllers.add(controller);
}

function untrackController(tabId, controller) {
  if (tabId == null) return;
  const controllers = activeControllersByTab.get(tabId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) activeControllersByTab.delete(tabId);
}

function createCancelledError() {
  const error = new Error('翻译请求已取消');
  error.name = 'CancelledError';
  return error;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function translateWithRetry(texts, targetLang, apiKey, model, tabId, retries = MAX_RETRIES) {
  const cancelController = new AbortController();
  trackController(tabId, cancelController);

  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (cancelController.signal.aborted) throw createCancelledError();

      const requestController = new AbortController();
      const cancelRequest = () => requestController.abort();
      cancelController.signal.addEventListener('abort', cancelRequest, { once: true });

      try {
        return await callDeepSeekAPI(texts, targetLang, apiKey, model, requestController);
      } catch (err) {
        if (cancelController.signal.aborted || err.name === 'CancelledError') {
          throw createCancelledError();
        }
        if (attempt >= retries) throw err;
      } finally {
        cancelController.signal.removeEventListener('abort', cancelRequest);
      }

      await abortableDelay(Math.pow(2, attempt) * 1000, cancelController.signal);
    }
  } finally {
    untrackController(tabId, cancelController);
  }
}

function cancelTabRequests(tabId) {
  if (tabId == null) return;

  // 先移除尚未发出的任务。
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    const task = pendingQueue[i];
    if (task.tabId === tabId) {
      task.resolve(new Array(task.resultLength).fill(''));
      pendingQueue.splice(i, 1);
    }
  }

  // 再中断已发出的 fetch；其 finally 会归还并发槽并继续处理队列。
  const controllers = activeControllersByTab.get(tabId);
  if (controllers) {
    for (const controller of controllers) controller.abort();
    activeControllersByTab.delete(tabId);
  }
}

// ============================================================
// 请求队列处理
// ============================================================

async function processQueue() {
  while (pendingQueue.length > 0 && activeRequests < maxConcurrent) {
    const task = pendingQueue.shift();
    activeRequests++;
    processTask(task).finally(() => {
      activeRequests--;
      // 队列与在途全部清空时立即持久化缓存（service worker 随时可能被回收，
      // 30s 防抖会丢失最近写入的尾巴）
      if (activeRequests === 0 && pendingQueue.length === 0) {
        persistCache();
      }
      processQueue();
    });
  }
}

async function processTask(task) {
  const { texts, indexMap, resultLength, targetLang, apiKey, model, resolve, reject, tabId } = task;

  // 检查标签页是否仍然存在，避免为已关闭的页面浪费 API 调用
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
    } catch (e) {
      // 标签页已关闭，跳过翻译
      resolve(new Array(resultLength).fill(''));
      return;
    }
  }

  try {
    // 检查缓存
    const uncachedTexts = [];
    const uncachedIndices = [];
    const results = new Array(resultLength).fill('');

    texts.forEach((text, i) => {
      const cacheKey = getCacheKey(text, targetLang, model);
      const cached = translationCache.get(cacheKey);
      if (cached !== undefined) {
        results[indexMap[i]] = cached;
      } else {
        uncachedTexts.push(text);
        uncachedIndices.push(indexMap[i]);
      }
    });

    if (uncachedTexts.length > 0) {
      const translated = await translateWithRetry(uncachedTexts, targetLang, apiKey, model, tabId);

      translated.forEach((trans, j) => {
        const originalIndex = uncachedIndices[j];
        const originalText = uncachedTexts[j];
        results[originalIndex] = trans;
        const cacheKey = getCacheKey(originalText, targetLang, model);
        addToCache(cacheKey, trans);
      });
    }

    // 队列清空时立即持久化缓存（service worker 随时可能被回收，30s 防抖会丢失尾巴）
    resolve(results);
  } catch (err) {
    if (err.name === 'CancelledError') {
      resolve(new Array(resultLength).fill(''));
      return;
    }
    reject(err);
  }
}

// ============================================================
// 消息处理
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_TEXTS') {
    handleTranslateTexts(message, sender).then(sendResponse).catch(err => {
      console.error('[TRS Background] API error:', err.message);
      sendResponse({ error: '翻译服务暂时不可用，请稍后重试' });
    });
    return true; // 异步响应
  }

  if (message.type === 'GET_SETTINGS') {
    getSettings().then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    translationCache.clear();
    cacheDirty = true;
    persistCache();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'CANCEL_TRANSLATIONS') {
    cancelTabRequests(sender.tab?.id);
    sendResponse({ success: true });
    return false;
  }
});

async function handleTranslateTexts(message, sender) {
  const { texts, targetLang, apiKey, model } = message;

  if (!texts || !texts.length) {
    return { translations: [] };
  }

  if (!apiKey) {
    return { error: '请先在设置中配置 DeepSeek API Key' };
  }

  // 过滤空文本和过长文本（空文本不发送，减少 token 与响应延迟）
  const items = [];
  texts.forEach((t, i) => {
    const trimmed = (t || '').trim();
    if (!trimmed) return;
    items.push({
      text: trimmed.length > 2000 ? trimmed.substring(0, 2000) : trimmed,
      index: i,
    });
  });

  if (items.length === 0) {
    return { translations: texts.map(() => '') };
  }

  return new Promise((resolve, reject) => {
    pendingQueue.push({
      texts: items.map(x => x.text),
      indexMap: items.map(x => x.index),
      resultLength: texts.length,
      targetLang: targetLang || 'zh-CN',
      apiKey,
      model: model || 'deepseek-flash',
      resolve: (results) => resolve({ translations: results }),
      reject: (err) => reject(err),
      tabId: sender.tab?.id,
    });
    processQueue();
  });
}

// ============================================================
// 设置管理
// ============================================================

const DEFAULT_SETTINGS = {
  apiKey: '',
  targetLang: 'zh-CN',
  model: 'deepseek-flash',
  translationStyle: 'below',
  fontSize: '0.92em',
  autoTranslate: false,
  maxConcurrent: 8,
  excludedDomains: [],
};

// 旧模型名迁移映射
const MODEL_MIGRATION = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

async function getSettings() {
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...result };
  // 迁移旧模型名
  if (MODEL_MIGRATION[settings.model]) {
    settings.model = MODEL_MIGRATION[settings.model];
    chrome.storage.sync.set({ model: settings.model });
  }
  return settings;
}

// 初始化：确保默认设置存在，迁移旧模型名
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...current };
  if (MODEL_MIGRATION[merged.model]) {
    merged.model = MODEL_MIGRATION[merged.model];
  }
  await chrome.storage.sync.set(merged);
});

// ============================================================
// 快捷键
// ============================================================

chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command === 'toggle-translation' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATION' }).catch(() => {});
  }
});

// ============================================================
// 标签页关闭时取消该页的待处理翻译请求
// ============================================================

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTabRequests(tabId);
});
