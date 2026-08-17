// ============================================================
// TRS Content Script
// 页面文本提取、译文注入、动态内容监听
//
// 调度模型（v2）：连续优先级队列
// - 所有待译文本登记到 registry（按文本去重，同文多元素共享一次 API 调用）
// - 队列按「距视口距离」动态排序，出队时取最近的一批
// - 无波次屏障：一批返回立即补下一批，慢请求只占一个并发槽
// - MutationObserver 不再被翻译状态门控，新内容随时入队
// - 滚动触发补充收集，覆盖 300 块上限之外的静态长页面
// ============================================================

(function () {
  'use strict';

  // ============================================================
  // 状态管理
  // ============================================================

  let isActive = false;
  let runId = 0;               // 每次 start/stop 递增，使在途结果失效
  let settings = {};
  let observer = null;
  let translatedElements = new WeakSet();

  // 文本登记表：normalizedText -> entry
  // entry = { key, text, elements:Set<Element>, retries, done, translation, queued, inFlight, distance }
  const registry = new Map();
  const queue = [];            // 待翻译 entry 引用数组（唯一文本）
  let inFlight = 0;

  const BATCH_SIZE = 8;
  const MAX_BLOCKS_PER_SCAN = 300;   // 单次全页扫描收集上限
  const QUEUE_MAX = 600;             // 队列长度上限，防止无限滚动页内存膨胀
  const REGISTRY_MAX = 4000;         // 登记表上限，超出时清理已脱离 DOM 的条目
  const RETRY_LIMIT = 1;             // 内容侧失败重排次数（background 另有重试）

  // 不应翻译的元素选择器
  const SKIP_SELECTORS = [
    'script', 'style', 'noscript', 'code', 'pre',
    'input', 'textarea', 'select', 'option',
    'svg', 'canvas', 'video', 'audio', 'img',
    '[translate="no"]', '[data-trs-ignore]',
    '.trs-translation', '.trs-original',
    // 导航/页脚等站点 UI 框架：不是正文，翻译它们浪费 API 槽位
    'nav', 'footer',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  ].join(',');

  // x.com / Twitter 上不应翻译的元素
  // 用户名、时间戳、社交上下文、分析数据等都是 UI 标注，不是自然语言内容
  const XCOM_SKIP_SELECTORS = [
    '[data-testid="User-Name"]',
    '[data-testid="socialContext"]',
    '[data-testid="app-text-transition-container"]',
    'time',
    '[role="link"]',
    '[aria-hidden="true"]',
  ].join(',');

  // 是否为 x.com / twitter.com
  const isXDomain = /(^|\.)(x\.com|twitter\.com)$/i.test(window.location.hostname);

  // 应翻译的块级元素
  const BLOCK_SELECTORS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'td', 'th', 'dt', 'dd', 'figcaption',
    'blockquote', 'summary', 'legend', 'label',
    'a', 'span', 'div', 'section', 'article',
    'button', 'em', 'strong', 'b', 'i',
  ].join(',');

  // ============================================================
  // 初始化
  // ============================================================

  async function init() {
    // 加载设置
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (!response.error) {
        settings = response;
      }
    } catch (e) {
      // 使用默认设置
      settings = {
        targetLang: 'zh-CN',
        translationStyle: 'below',
        fontSize: '0.92em',
      };
    }

    // 检查当前域名是否在排除列表中
    if (isDomainExcluded()) {
      return;
    }

    // 检查是否应自动翻译
    if (settings.autoTranslate) {
      startTranslation();
    }

    // 设置 DOM 监听
    setupMutationObserver();

    // 滚动监听：静态长页面滚入未翻译区域时补充收集
    setupScrollListener();

    // 注入动态样式元素
    injectDynamicStyle();
  }

  function injectDynamicStyle() {
    let styleEl = document.getElementById('trs-dynamic-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'trs-dynamic-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = generateDynamicCSS();
  }

  /**
   * 检查当前域名是否在用户排除列表中
   */
  function isDomainExcluded() {
    const hostname = window.location.hostname.toLowerCase();
    const excluded = (settings.excludedDomains || []).map(d => String(d).toLowerCase().trim()).filter(Boolean);
    return excluded.some(d => hostname === d || hostname.endsWith('.' + d));
  }

  // ============================================================
  // 消息处理
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'START_TRANSLATION':
        startTranslation();
        sendResponse({ success: true });
        break;

      case 'STOP_TRANSLATION':
        stopTranslation();
        sendResponse({ success: true });
        break;

      case 'TOGGLE_TRANSLATION':
        if (isActive) {
          stopTranslation();
        } else {
          startTranslation();
        }
        sendResponse({ success: true, isActive });
        break;

      case 'GET_STATUS':
        sendResponse({ isActive, isTranslating: getIsTranslating() });
        break;

      case 'REMOVE_ALL_TRANSLATIONS':
        stopTranslation();
        sendResponse({ success: true });
        break;

      case 'RETRANSLATE_PAGE':
        retranslatePage();
        sendResponse({ success: true });
        break;

      case 'UPDATE_SETTINGS':
        settings = { ...settings, ...message.settings };
        if (isActive) {
          updateTranslationStyles();
        }
        sendResponse({ success: true });
        break;
    }
  });

  function getIsTranslating() {
    return isActive && (inFlight > 0 || queue.length > 0);
  }

  // ============================================================
  // 翻译主逻辑：连续优先级调度
  // ============================================================

  async function startTranslation() {
    if (isActive) return;

    // 检查排除域名
    if (isDomainExcluded()) return;

    if (!settings.apiKey) {
      console.warn('[TRS] 未配置 API Key，请右键扩展图标 → 选项 进行配置');
      return;
    }

    isActive = true;
    runId++;
    registry.clear();
    queue.length = 0;
    document.body.classList.add('trs-active');
    showToast('🌐 翻译已开启', 'on');

    // 开启 DOM 变化监听
    setupMutationObserver();

    // 立即收集 + 调度
    refresh(true);
  }

  /**
   * 重新翻译：清空译文与登记表后重跑，保证重新走 API（而非命中旧缓存）
   */
  function retranslatePage() {
    runId++; // 在途结果作废
    registry.clear();
    queue.length = 0;
    removeAllTranslations();
    if (isActive) {
      refresh(true);
    } else {
      startTranslation();
    }
  }

  function stopTranslation() {
    if (!isActive && queue.length === 0 && inFlight === 0) return;
    isActive = false;
    runId++; // 在途结果全部作废
    registry.clear();
    queue.length = 0;

    // 断开 DOM 监听，避免翻译关闭后仍持续消耗资源
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    removeAllTranslations();
    showToast('🚫 翻译已关闭', 'off');
  }

  function removeAllTranslations() {
    const translations = document.querySelectorAll('.trs-translation');
    translations.forEach(el => el.remove());
    translatedElements = new WeakSet();
    document.body.classList.remove('trs-active');
  }

  function updateTranslationStyles() {
    let styleEl = document.getElementById('trs-dynamic-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'trs-dynamic-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = generateDynamicCSS();
  }

  /**
   * 收集未处理文本块并按距视口距离排序（最近优先）。
   * 相同文本只在 registry 中登记一次；新出现的同文元素挂到既有 entry 上。
   * @param {boolean} immediate 为 true 时跳过节流立即执行
   */
  function refresh(immediate) {
    if (!isActive) return;

    if (!immediate) {
      if (refreshTimer) return; // 已排队，等待统一执行
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh(true);
      }, 250);
      return;
    }

    try {
      const candidates = collectFromRoot(document.body, MAX_BLOCKS_PER_SCAN);
      enqueue(candidates);
      pump();
    } catch (e) {
      console.error('[TRS] 收集失败:', e);
    }
  }

  let refreshTimer = null;

  function enqueue(candidates) {
    for (const entry of candidates) {
      if (entry.done || entry.queued || entry.inFlight) continue;
      if (queue.length >= QUEUE_MAX) {
        // 队列已满：丢弃最远的（会随滚动/变化重新收集）
        continue;
      }
      entry.queued = true;
      queue.push(entry);
    }
    pruneRegistry();
  }

  /**
   * 持续泵送：只要有空闲并发槽且队列非空，就取距离视口最近的一批发送。
   * 一批返回立即补下一批，不存在等待整波的屏障。
   */
  function pump() {
    if (!isActive) return;

    const maxConcurrent = Math.min(Math.max(settings.maxConcurrent || 6, 1), 10);

    while (inFlight < maxConcurrent && queue.length > 0) {
      // 出队前刷新距离（用户可能已滚动），按「距离 + 失败惩罚」排序
      for (const entry of queue) {
        refreshEntryDistance(entry);
      }
      queue.sort((a, b) => (a.distance + a.retries * 5000) - (b.distance + b.retries * 5000));

      const batch = queue.splice(0, BATCH_SIZE);
      for (const entry of batch) {
        entry.queued = false;
        entry.inFlight = true;
      }

      const myRunId = runId;
      inFlight++;
      translateBatch(batch).finally(() => {
        inFlight--;
        if (myRunId === runId) {
          pump();
          maybeIdleCollect();
        }
      });
    }
  }

  /**
   * 队列与在途都空时：再做一次全页收集。
   * 覆盖单页超过 300 块的静态长页面（按 300 一茬滚动推进）。
   */
  function maybeIdleCollect() {
    if (!isActive || queue.length > 0 || inFlight > 0) return;
    const candidates = collectFromRoot(document.body, MAX_BLOCKS_PER_SCAN);
    if (candidates.length > 0) {
      enqueue(candidates);
      pump();
    }
  }

  function refreshEntryDistance(entry) {
    if (entry.elements.size === 0) {
      entry.distance = Infinity;
      return;
    }
    let minDistance = Infinity;
    for (const el of entry.elements) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const viewportCenter = window.innerHeight / 2;
      const dist = Math.abs(center - viewportCenter);
      if (dist < minDistance) minDistance = dist;
    }
    entry.distance = minDistance;
  }

  async function translateBatch(entries) {
    const texts = entries.map(e => e.text);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXTS',
        texts,
        targetLang: settings.targetLang,
        apiKey: settings.apiKey,
        model: settings.model,
      });

      if (!isActive) return; // 等待期间可能已关闭翻译

      if (response.error) {
        console.error('[TRS] 翻译错误:', response.error);
        requeueFailed(entries);
        return;
      }

      const translations = response.translations || [];

      entries.forEach((entry, index) => {
        const translation = (translations[index] || '').trim();
        entry.inFlight = false;

        if (!translation) {
          // 空译文按失败处理
          requeueFailedEntry(entry);
          return;
        }

        // 原文与译文相同时跳过注入（如用户名、仓库名等专有名词）
        if (translation.toLowerCase() === entry.text.toLowerCase()) {
          for (const el of entry.elements) translatedElements.add(el);
          entry.done = true;
          entry.translation = '';
          return;
        }

        entry.done = true;
        entry.translation = translation;
        injectEntryTranslation(entry);
      });
    } catch (err) {
      console.error('[TRS] 翻译请求失败:', err.message);
      requeueFailed(entries);
    }
  }

  /**
   * 为登记条目注入译文。
   * 关键规则：同文嵌套元素（如 <div>原文</div> 内含 <span>原文</span>）只注入最外层，
   * 并移除内层已存在的重复译文——否则同一句话会显示两三遍。
   * 互不嵌套的同文元素（如页面里多个 "Read more" 按钮）各自注入一次。
   */
  function injectEntryTranslation(entry) {
    const translation = entry.translation;
    const connected = [...entry.elements].filter(el => el.isConnected);

    // 先找被同文祖先覆盖的元素
    const coveredByAncestor = new Set();
    for (const el of connected) {
      for (const other of connected) {
        if (other !== el && other.contains(el)) {
          coveredByAncestor.add(el);
          break;
        }
      }
    }

    // 清除被覆盖层残留的译文
    for (const el of coveredByAncestor) {
      const existing = el.querySelector(':scope > .trs-translation');
      if (existing) existing.remove();
    }

    // 只注入最外层元素
    for (const el of connected) {
      if (!translation) break;
      if (coveredByAncestor.has(el)) {
        translatedElements.add(el); // 已被祖先译文覆盖，标记即可
        continue;
      }
      injectTranslation(el, translation);
      translatedElements.add(el);
    }
  }

  function requeueFailed(entries) {
    for (const entry of entries) requeueFailedEntry(entry);
  }

  function requeueFailedEntry(entry) {
    entry.inFlight = false;
    if (!isActive) return;
    if (entry.retries < RETRY_LIMIT) {
      entry.retries++;
      if (!entry.queued && queue.length < QUEUE_MAX) {
        entry.queued = true;
        queue.push(entry);
      }
    } else {
      // 超过重试上限：标记完成避免反复重试，用户重新翻译页面可恢复
      entry.done = true;
      entry.translation = '';
    }
  }

  // ============================================================
  // 文本收集
  // ============================================================

  /**
   * 从指定根元素收集可翻译文本块。
   * 返回需要入队的 entry 列表（未翻译、未排队、未在途）。
   */
  function collectFromRoot(root, maxBlocks) {
    const candidates = [];
    const touchedDone = new Set();

    const elements = root.querySelectorAll(BLOCK_SELECTORS);

    // x.com 上收集所有 tweetText 容器，用于跳过其子元素
    const tweetTextContainers = isXDomain
      ? new Set(document.querySelectorAll('[data-testid="tweetText"]'))
      : null;

    for (const el of elements) {
      if (candidates.length >= maxBlocks) break;

      // 跳过应忽略的元素
      if (el.closest(SKIP_SELECTORS)) continue;
      if (el.matches(SKIP_SELECTORS)) continue;
      if (translatedElements.has(el)) continue;

      // x.com 特殊处理：跳过 UI 标注元素（用户名、时间戳、社交上下文等）
      if (isXDomain) {
        if (el.matches(XCOM_SKIP_SELECTORS)) continue;
        if (el.closest(XCOM_SKIP_SELECTORS)) continue;

        // 如果当前元素在 tweetText 容器内部但不是容器本身，跳过
        // 因为我们会在 tweetText 容器级别统一翻译完整推文
        if (tweetTextContainers && !tweetTextContainers.has(el)) {
          const parentTweet = el.closest('[data-testid="tweetText"]');
          if (parentTweet) continue;
        }
      }

      // 跳过零尺寸/隐藏元素（站内隐藏抽屉、菜单、隐藏 toast 等）
      if (isEffectivelyHidden(el)) continue;

      // 获取直接文本内容（不包括子元素中已被处理的内容）
      const text = getDirectText(el);
      if (!text || text.length < 2) continue;

      // 跳过纯数字、纯符号、纯空白
      if (/^[\d\s.,;:!?\-–—()（）《》【】\[\]"'`·•・…\s]+$/.test(text)) continue;

      // 跳过代码标识符风格文本（camelCase、snake_case、路径、用户名/仓库名等）
      if (isCodeLikeIdentifier(text)) continue;

      // x.com：跳过 X 自带翻译功能的提示条（"Translated from …"、"从…翻译而来"、"显示原文" 等），
      // 这些是 UI 标注，不是推文内容，翻译后只会造成重复显示
      if (isXDomain && isXTranslateNotice(text)) continue;

      // 检查是否主要为非文本内容
      const textRatio = text.replace(/[\s\d.,;:!?\-–—()（）《》【】\[\]"'`·•・…]/g, '').length / text.length;
      if (textRatio < 0.3) continue;

      // 登记到 registry：相同文本共享一次 API 调用
      const normalized = text.trim().toLowerCase();
      let entry = registry.get(normalized);
      if (!entry) {
        entry = {
          key: normalized,
          text: text.trim(),
          elements: new Set(),
          retries: 0,
          done: false,
          translation: '',
          queued: false,
          inFlight: false,
          distance: Infinity,
        };
        registry.set(normalized, entry);
      }

      entry.elements.add(el);

      if (entry.done) {
        // 已有译文：新出现的同文元素直接注入，无需 API
        if (entry.translation) {
          touchedDone.add(entry); // 延迟到扫描结束后统一注入（嵌套去重需要全集）
        } else {
          translatedElements.add(el); // 原文=译文，无需注入
        }
        continue;
      }

      if (!entry.queued && !entry.inFlight && !candidates.includes(entry)) {
        candidates.push(entry);
      }
    }

    // 处理本次扫描中新出现的、已有译文的同文元素
    for (const entry of touchedDone) {
      injectEntryTranslation(entry);
    }

    // 可视区域优先排序（入队顺序决定初始次序，出队时还会按实时距离重排）
    for (const entry of candidates) {
      refreshEntryDistance(entry);
    }
    candidates.sort((a, b) => a.distance - b.distance);

    return candidates;
  }

  const styleCache = new WeakMap();

  /**
   * 判断元素是否实际不可见（display:none / visibility:hidden / 零尺寸）。
   * 零尺寸检查同时覆盖祖先 display:none 的情况（此时 rect 为 0）。
   */
  function isEffectivelyHidden(el) {
    let cached = styleCache.get(el);
    if (!cached) {
      const style = window.getComputedStyle(el);
      cached = { display: style.display, visibility: style.visibility };
      styleCache.set(el, cached);
    }
    if (cached.display === 'none' || cached.visibility === 'hidden') return true;

    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  }

  function getDirectText(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过译文元素
        if (node.classList && node.classList.contains('trs-translation')) continue;
        // 空子元素直接跳过：没有任何文本就不贡献内容，避免触发昂贵的样式计算
        if (!node.textContent || !node.textContent.trim()) continue;
        // 如果是内联元素且不包含子块级元素，则收集其文本
        if (isInlineElement(node) && !containsBlockElement(node)) {
          text += node.textContent || '';
        } else {
          // 块级子元素作为分隔符
          text += ' ';
        }
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // 缓存样式/结构判断结果（WeakMap 不阻止 GC）
  // X 等 SPA 滚动时会反复重扫 DOM，避免每次触发昂贵的 getComputedStyle
  const inlineCache = new WeakMap();
  const blockCache = new WeakMap();

  function isInlineElement(el) {
    if (inlineCache.has(el)) return inlineCache.get(el);
    const inlineDisplay = ['inline', 'inline-block', 'inline-flex', 'inline-table'];
    const style = window.getComputedStyle(el);
    const result = inlineDisplay.includes(style.display);
    inlineCache.set(el, result);
    return result;
  }

  function containsBlockElement(el) {
    if (blockCache.has(el)) return blockCache.get(el);
    const blockTags = ['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR'];
    let found = false;
    for (const child of el.children) {
      if (blockTags.includes(child.tagName)) { found = true; break; }
      if (containsBlockElement(child)) { found = true; break; }
    }
    blockCache.set(el, found);
    return found;
  }

  /**
   * 登记表瘦身：条目过多时清理所有元素都已脱离 DOM 的条目。
   */
  function pruneRegistry() {
    if (registry.size < REGISTRY_MAX) return;
    for (const [key, entry] of registry) {
      let anyConnected = false;
      for (const el of entry.elements) {
        if (el.isConnected) { anyConnected = true; break; }
      }
      if (!anyConnected) registry.delete(key);
    }
  }

  /**
   * 检测文本是否为 X 自带翻译功能的提示条 UI 标注
   */
  function isXTranslateNotice(text) {
    // "Translated from Chinese" / "Translated from 简体中文" 等
    if (/^translated from\b/i.test(text)) return true;

    // "从中文翻译而来" / "翻译自日语" 等短句
    if (text.length < 40 && /^(从|由).{0,15}(翻译|译自)/.test(text)) return true;

    // "显示原文" / "查看原文" / "Show original" 等按钮文案
    if (/^(显示原文|查看原文|show original|view original)$/i.test(text)) return true;

    return false;
  }

  /**
   * 检测文本是否看起来像代码标识符（用户名、仓库名、路径等）
   * 这些文本翻译后通常和原文一样，没必要浪费 API 调用
   */
  function isCodeLikeIdentifier(text) {
    // 包含路径分隔符：user/repo、a/b/c
    if (/^[\w.\-]+(\/[\w.\-]+)+$/.test(text)) return true;

    // camelCase 或 PascalCase（连续大写+小写）
    if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(text)) return true;
    if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(text)) return true;

    // snake_case 或 kebab-case
    if (/^[a-z]+(?:[_\-][a-z]+)+$/.test(text)) return true;

    // 全大写缩写（如 API、HTML、CSS）
    if (/^[A-Z_]{2,}$/.test(text)) return true;

    // 包含 @ 的文本（如 @username、@提及）
    if (/^@\w+$/.test(text)) return true;

    // 版本号（如 v1.0.0、1.2.3）
    if (/^v?\d+\.\d+(?:\.\d+)*$/.test(text)) return true;

    // Hashtag（如 #AI、#MachineLearning、#hello_world），这些是标签不是自然语言
    if (/^#[\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+$/.test(text)) return true;

    // 纯英文+数字+符号，无空格，不含中/日/韩/阿等文字
    if (/^[a-zA-Z\d.\-/_@#$%^&*()[\]{}<>|~`!+=:;,"'?]+$/.test(text) && text.length < 3) return true;

    return false;
  }

  // ============================================================
  // 译文注入（作为子元素追加，不破坏 DOM 结构）
  // ============================================================

  function injectTranslation(element, translation) {
    if (!translation || !translation.trim()) return;

    // 避免重复注入
    const existing = element.querySelector(':scope > .trs-translation');
    if (existing) {
      existing.textContent = translation.trim();
      return;
    }

    const translationEl = document.createElement('span');
    translationEl.className = 'trs-translation';
    translationEl.setAttribute('data-trs-ignore', '');
    translationEl.textContent = translation.trim();

    // 自适应颜色：检测父元素实际背景亮度
    applyAdaptiveColor(translationEl, element);

    // 自动检测是否为块级上下文（长文本也另起一行显示）
    if (shouldUseBlockStyle(element, translation)) {
      translationEl.classList.add('trs-block');
    }

    // 统一追加为元素的最后一个子节点
    element.appendChild(translationEl);

    translatedElements.add(element);
  }

  /**
   * 解析 RGB 字符串为 [r, g, b] 数组
   */
  function parseRGB(rgbStr) {
    const match = rgbStr.match(/[\d.]+/g);
    if (!match || match.length < 3) return [0, 0, 0];
    return match.slice(0, 3).map(Number);
  }

  /**
   * 根据原文字颜色自动生成柔和的译文颜色
   * 思路：取原文字颜色与中灰混合，暗的变亮、亮的变暗，同时降低饱和度
   */
  function applyAdaptiveColor(translationEl, parentEl) {
    const originalColor = window.getComputedStyle(parentEl).color;
    const [r, g, b] = parseRGB(originalColor);

    // 与中灰色混合（60% 原色 + 40% 灰色 = 自然柔化）
    const mix = (c) => Math.round(c * 0.6 + 128 * 0.4);
    const mr = mix(r), mg = mix(g), mb = mix(b);

    const mutedColor = `rgb(${mr},${mg},${mb})`;
    const mutedAlpha = `rgba(${mr},${mg},${mb},0.35)`;

    translationEl.style.setProperty('--trs-color', mutedColor);
    translationEl.style.setProperty('--trs-border-color', mutedColor);
    translationEl.style.setProperty('--trs-border-alpha', mutedAlpha);
  }

  /**
   * 判断译文是否应另起一段（块级）显示
   * 规则：传统文本块标签一律块级；其他元素若译文较长且自身按块级布局渲染，
   * 也另起一段（长句跟在原文后面可读性差）
   */
  function shouldUseBlockStyle(element, translation) {
    const display = window.getComputedStyle(element).display;

    // 元素自身是 flex/grid 容器时，块级译文会成为并排项目，退化为行内
    if (display === 'flex' || display === 'inline-flex' ||
        display === 'grid' || display === 'inline-grid') {
      return false;
    }

    // 传统文本块标签
    if (isBlockLevelElement(element)) return true;

    // 长译文 + 元素按块级布局渲染 → 另起一段更易读
    const LONG_TEXT_THRESHOLD = 40;
    if (translation.length >= LONG_TEXT_THRESHOLD &&
        (display === 'block' || display === 'list-item' || display === 'table-cell')) {
      return true;
    }

    return false;
  }

  /**
   * 判断元素在布局上是否为文本块级上下文
   * 注意：不包含 DIV/SECTION 等通用容器，且排除 flex/grid 子元素
   */
  function isBlockLevelElement(el) {
    const textBlockTags = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'BLOCKQUOTE', 'FIGCAPTION', 'LI', 'DD', 'DT',
    ]);
    if (!textBlockTags.has(el.tagName)) return false;

    // 如果父容器是 flex/grid，块级译文会破坏布局，退化为行内
    const parent = el.parentElement;
    if (parent) {
      const parentDisplay = window.getComputedStyle(parent).display;
      if (parentDisplay === 'flex' || parentDisplay === 'inline-flex' ||
          parentDisplay === 'grid' || parentDisplay === 'inline-grid') {
        return false;
      }
    }

    return true;
  }

  // ============================================================
  // DOM 变化监听
  // ============================================================

  function setupMutationObserver() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      if (!isActive) return;

      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 跳过译文自身或已标记忽略的元素
              if (node.hasAttribute && node.hasAttribute('data-trs-ignore')) continue;
              if (node.classList && node.classList.contains('trs-translation')) continue;

              if (node.querySelector && node.querySelector(BLOCK_SELECTORS)) {
                hasNewContent = true;
                break;
              }
              if (node.matches && node.matches(BLOCK_SELECTORS)) {
                hasNewContent = true;
                break;
              }
            }
          }
        }
        if (hasNewContent) break;
      }

      if (hasNewContent) {
        // 不设长防抖：新内容立即进入优先级队列，调度器会按距离排序
        refresh(false);
      }
    });

    // document.body 可能尚未就绪（如 XML 页面、某些 iframe 等边缘场景）
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    } else {
      // body 尚不可用，等待 DOM 就绪后重试
      const tryObserve = () => {
        if (document.body) {
          observer.observe(document.body, {
            childList: true,
            subtree: true,
          });
        }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryObserve, { once: true });
      }
      // readyState 为 'interactive' 或 'complete' 但仍无 body 的情况（极罕见），不再重试
    }
  }

  // ============================================================
  // 滚动监听：静态长页面滚入未翻译区域时补充收集
  // ============================================================

  let scrollTimer = null;

  function setupScrollListener() {
    window.addEventListener('scroll', () => {
      if (!isActive) return;
      // 队列充实时不打扰（新滚入的内容已在队列里，出队时会优先）
      if (queue.length + inFlight * BATCH_SIZE >= 60) return;
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        if (isActive) refresh(true);
      }, 400);
    }, { passive: true });
  }

  // ============================================================
  // Toast 提示
  // ============================================================

  function showToast(message, type) {
    // 移除旧 toast
    const old = document.querySelector('.trs-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.className = `trs-toast trs-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // 入场动画后自动消失
    requestAnimationFrame(() => {
      toast.classList.add('trs-toast-visible');
      setTimeout(() => {
        toast.classList.remove('trs-toast-visible');
        setTimeout(() => toast.remove(), 300);
      }, 1800);
    });
  }

  // ============================================================
  // 动态样式
  // ============================================================

  function generateDynamicCSS() {
    const size = settings.fontSize || '0.92em';
    return `
      .trs-translation {
        font-size: ${size} !important;
      }
    `;
  }

  // ============================================================
  // 启动
  // ============================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
