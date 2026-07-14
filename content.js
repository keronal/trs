// ============================================================
// TRS Content Script
// 页面文本提取、译文注入、动态内容监听
// ============================================================

(function () {
  'use strict';

  // ============================================================
  // 状态管理
  // ============================================================

  let isTranslating = false;
  let isActive = false;
  let settings = {};
  let observer = null;
  let translatedElements = new WeakSet();
  const seenTexts = new Set(); // 跨批次文本去重，防止同一文本在不同元素中重复翻译
  const SEEN_TEXTS_MAX = 1500;  // 限制大小防止内存泄漏

  // 不应翻译的元素选择器
  const SKIP_SELECTORS = [
    'script', 'style', 'noscript', 'code', 'pre',
    'input', 'textarea', 'select', 'option',
    'svg', 'canvas', 'video', 'audio', 'img',
    '[translate="no"]', '[data-trs-ignore]',
    '.trs-translation', '.trs-original',
  ].join(',');

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
        sendResponse({ isActive, isTranslating });
        break;

      case 'REMOVE_ALL_TRANSLATIONS':
        removeAllTranslations();
        sendResponse({ success: true });
        break;

      case 'RETRANSLATE_PAGE':
        removeAllTranslations();
        startTranslation();
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

  // ============================================================
  // 翻译主逻辑
  // ============================================================

  async function startTranslation() {
    if (isActive) return;

    // 检查排除域名
    if (isDomainExcluded()) return;

    isActive = true;
    document.body.classList.add('trs-active');
    showToast('🌐 翻译已开启', 'on');

    // 开启 DOM 变化监听
    setupMutationObserver();

    await translateVisibleContent();
  }

  function stopTranslation() {
    isActive = false;
    isTranslating = false;

    // 断开 DOM 监听，避免翻译关闭后仍持续消耗资源
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    removeAllTranslations();
    showToast('🚫 翻译已关闭', 'off');
  }

  function removeAllTranslations() {
    const translations = document.querySelectorAll('.trs-translation');
    translations.forEach(el => el.remove());
    translatedElements = new WeakSet();
    seenTexts.clear();
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

  async function translateVisibleContent() {
    if (!isActive || isTranslating) return;
    if (!settings.apiKey) {
      console.warn('[TRS] 未配置 API Key，请右键扩展图标 → 选项 进行配置');
      return;
    }

    isTranslating = true;

    try {
      // 收集需要翻译的文本块（可视区域优先）
      const textBlocks = collectTranslatableTexts();

      if (textBlocks.length === 0) {
        isTranslating = false;
        return;
      }

      // 分批翻译：所有批次并行发送，由 background 的并发队列调度
      const BATCH_SIZE = 20;
      const batchPromises = [];

      for (let i = 0; i < textBlocks.length; i += BATCH_SIZE) {
        const batch = textBlocks.slice(i, i + BATCH_SIZE);
        batchPromises.push(translateBatch(batch));
      }

      await Promise.allSettled(batchPromises);
    } finally {
      isTranslating = false;
    }
  }

  async function translateBatch(batch) {
    if (!isActive) return;

    const texts = batch.map(b => b.text);

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
        return;
      }

      const translations = response.translations || [];

      // 注入译文（跳过与原文相同的无效翻译）
      batch.forEach((block, index) => {
        const translation = translations[index];
        if (translation && translation.trim()) {
          // 原文与译文相同时跳过（如用户名、仓库名等专有名词）
          if (translation.trim().toLowerCase() === block.text.toLowerCase()) return;
          injectTranslation(block.element, translation);
        }
      });
    } catch (err) {
      console.error('[TRS] 翻译请求失败:', err.message);
    }
  }

  // ============================================================
  // 文本收集
  // ============================================================

  function collectTranslatableTexts() {
    const blocks = [];
    const MAX_BLOCKS = 300;

    const elements = document.body.querySelectorAll(BLOCK_SELECTORS);

    for (const el of elements) {
      if (blocks.length >= MAX_BLOCKS) break;

      // 跳过应忽略的元素
      if (el.closest(SKIP_SELECTORS)) continue;
      if (el.matches(SKIP_SELECTORS)) continue;
      if (translatedElements.has(el)) continue;

      // 获取直接文本内容（不包括子元素中已被处理的内容）
      const text = getDirectText(el);
      if (!text || text.length < 2) continue;

      // 跳过纯数字、纯符号、纯空白
      if (/^[\d\s.,;:!?\-–—()（）《》【】\[\]"'`·•・…\s]+$/.test(text)) continue;

      // 跳过代码标识符风格文本（camelCase、snake_case、路径、用户名/仓库名等）
      if (isCodeLikeIdentifier(text)) continue;

      // 检查是否主要为非文本内容
      const textRatio = text.replace(/[\s\d.,;:!?\-–—()（）《》【】\[\]"'`·•・…]/g, '').length / text.length;
      if (textRatio < 0.3) continue;

      // 跨批次去重（相同文本只翻译一次）
      const normalized = text.trim().toLowerCase();
      if (seenTexts.has(normalized)) continue;
      // 限制 Set 大小，超出时清空一半（防止长时间浏览 SPA 页面内存泄漏）
      if (seenTexts.size >= SEEN_TEXTS_MAX) {
        const entries = Array.from(seenTexts);
        seenTexts.clear();
        entries.slice(-Math.floor(SEEN_TEXTS_MAX / 2)).forEach(e => seenTexts.add(e));
      }
      seenTexts.add(normalized);

      blocks.push({ element: el, text: text.trim() });
    }

    // 可视区域优先：视口内的块排在前面，其余按距视口距离排序
    const viewportHeight = window.innerHeight;
    for (const block of blocks) {
      const rect = block.element.getBoundingClientRect();
      block.inViewport = rect.bottom > 0 && rect.top < viewportHeight;
      block.distance = block.inViewport ? 0 : Math.abs(rect.top);
    }
    blocks.sort((a, b) => a.distance - b.distance);

    return blocks;
  }

  function getDirectText(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过译文元素
        if (node.classList && node.classList.contains('trs-translation')) continue;
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

  function isInlineElement(el) {
    const inlineDisplay = ['inline', 'inline-block', 'inline-flex', 'inline-table'];
    const style = window.getComputedStyle(el);
    return inlineDisplay.includes(style.display);
  }

  function containsBlockElement(el) {
    const blockTags = ['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR'];
    for (const child of el.children) {
      if (blockTags.includes(child.tagName)) return true;
      if (containsBlockElement(child)) return true;
    }
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
   * 获取元素背后实际可见的背景色（向上遍历直到找到非透明背景）
   */
  function getEffectiveBackground(el) {
    let current = el;
    while (current && current !== document.body.parentElement) {
      const bg = window.getComputedStyle(current).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        return bg;
      }
      current = current.parentElement;
    }
    return 'rgb(255, 255, 255)';
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
      if (!isActive || isTranslating) return;

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
        debounceTranslate();
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

  let debounceTimer = null;
  function debounceTranslate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      translateVisibleContent();
    }, 1500);
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