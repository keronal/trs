// ============================================================
// TRS Background Service Worker
// 处理翻译请求队列、DeepSeek API 调用、缓存管理
// ============================================================

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_MAX_CONCURRENT = 6;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 30000;

// 翻译缓存：key = `${lang}:${text}`, value = translated text
const translationCache = new Map();
const CACHE_MAX_SIZE = 2000;
const CACHE_STORAGE_KEY = 'translationCache';
let cacheDirty = false;
let cacheSaveTimer = null;

// 请求队列管理
let activeRequests = 0;
let maxConcurrent = DEFAULT_MAX_CONCURRENT;
const pendingQueue = [];

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

function getCacheKey(text, targetLang) {
  return `${targetLang}:${hashText(text)}`;
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

async function callDeepSeekAPI(texts, targetLang, apiKey, model) {
  const systemPrompt = getSystemPrompt(targetLang);
  const userContent = texts.map((t, i) => `[${i}] ${t}`).join('\n\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 8192,
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

async function translateWithRetry(texts, targetLang, apiKey, model, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const results = await callDeepSeekAPI(texts, targetLang, apiKey, model);
      return results;
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
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
      processQueue();
    });
  }
}

async function processTask(task) {
  const { texts, targetLang, apiKey, model, resolve, reject, tabId } = task;

  // 检查标签页是否仍然存在，避免为已关闭的页面浪费 API 调用
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
    } catch (e) {
      // 标签页已关闭，跳过翻译
      resolve(texts.map(() => ''));
      return;
    }
  }

  try {
    // 检查缓存
    const uncachedTexts = [];
    const uncachedIndices = [];
    const results = new Array(texts.length).fill('');

    texts.forEach((text, i) => {
      const cacheKey = getCacheKey(text, targetLang);
      const cached = translationCache.get(cacheKey);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        uncachedTexts.push(text);
        uncachedIndices.push(i);
      }
    });

    if (uncachedTexts.length > 0) {
      const translated = await translateWithRetry(uncachedTexts, targetLang, apiKey, model);

      translated.forEach((trans, j) => {
        const originalIndex = uncachedIndices[j];
        const originalText = uncachedTexts[j];
        results[originalIndex] = trans;
        const cacheKey = getCacheKey(originalText, targetLang);
        addToCache(cacheKey, trans);
      });
    }

    resolve(results);
  } catch (err) {
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
});

async function handleTranslateTexts(message, sender) {
  const { texts, targetLang, apiKey, model } = message;

  if (!texts || !texts.length) {
    return { translations: [] };
  }

  if (!apiKey) {
    return { error: '请先在设置中配置 DeepSeek API Key' };
  }

  // 过滤空文本和过长文本
  const validTexts = texts.map(t => {
    const trimmed = (t || '').trim();
    return trimmed.length > 2000 ? trimmed.substring(0, 2000) : trimmed;
  });

  if (validTexts.every(t => !t)) {
    return { translations: validTexts.map(() => '') };
  }

  return new Promise((resolve, reject) => {
    pendingQueue.push({
      texts: validTexts,
      targetLang: targetLang || 'zh-CN',
      apiKey,
      model: model || 'deepseek-v4-flash',
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
  model: 'deepseek-v4-flash',
  translationStyle: 'below',
  fontSize: '0.92em',
  autoTranslate: false,
  maxConcurrent: 6,
  excludedDomains: [],
};

// 旧模型名迁移映射
const MODEL_MIGRATION = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
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
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    if (pendingQueue[i].tabId === tabId) {
      pendingQueue[i].resolve([]);
      pendingQueue.splice(i, 1);
    }
  }
});
