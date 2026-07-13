// ============================================================
// TRS Popup Script
// 弹窗交互逻辑、设置同步、翻译控制
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  // ============================================================
  // DOM 元素引用
  // ============================================================
  const btnTranslate = document.getElementById('btnTranslate');
  const btnTranslateText = document.getElementById('btnTranslateText');
  const btnRemove = document.getElementById('btnRemove');
  const btnRetranslate = document.getElementById('btnRetranslate');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const targetLang = document.getElementById('targetLang');
  const apiWarning = document.getElementById('apiWarning');
  const goToOptions = document.getElementById('goToOptions');
  const openOptions = document.getElementById('openOptions');

  // ============================================================
  // 状态
  // ============================================================
  let isPageActive = false;
  let isPageTranslating = false;
  let settings = {};

  // ============================================================
  // 初始化
  // ============================================================
  async function init() {
    // 加载设置
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!response.error) {
      settings = response;
      applySettings();
    }

    // 获取当前标签页翻译状态
    await refreshStatus();

    // 检查 API Key
    checkApiKey();
  }

  function applySettings() {
    if (settings.targetLang) {
      targetLang.value = settings.targetLang;
    }
  }

  async function refreshStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      const status = await sendToTab(tab.id, { type: 'GET_STATUS' });
      if (status) {
        isPageActive = status.isActive;
        isPageTranslating = status.isTranslating;
        updateUI();
      }
    } catch (e) {
      isPageActive = false;
      isPageTranslating = false;
      updateUI();
      showUnsupportedPage();
    }
  }

  function checkApiKey() {
    if (!settings.apiKey) {
      apiWarning.style.display = 'flex';
    } else {
      apiWarning.style.display = 'none';
    }
  }

  function showUnsupportedPage() {
    btnTranslate.disabled = true;
    btnTranslate.style.opacity = '0.5';
    btnTranslate.style.cursor = 'not-allowed';
    btnTranslateText.textContent = '此页面不支持翻译';
    statusText.textContent = '不支持（系统页面）';
    statusDot.className = 'status-dot error';
  }

  // ============================================================
  // UI 更新
  // ============================================================

  function updateUI() {
    if (isPageActive) {
      if (isPageTranslating) {
        setStatus('translating', '翻译中...');
        btnTranslateText.textContent = '停止翻译';
        btnTranslate.classList.add('running');
      } else {
        setStatus('active', '翻译已激活');
        btnTranslateText.textContent = '关闭翻译';
        btnTranslate.classList.add('running');
      }
    } else {
      setStatus('idle', '就绪');
      btnTranslateText.textContent = '翻译本页';
      btnTranslate.classList.remove('running');
    }
    btnTranslate.disabled = false;
    btnTranslate.style.opacity = '1';
    btnTranslate.style.cursor = 'pointer';
  }

  function setStatus(state, text) {
    statusDot.className = 'status-dot';
    if (state === 'active') statusDot.classList.add('active');
    if (state === 'translating') statusDot.classList.add('translating');
    if (state === 'error') statusDot.classList.add('error');
    statusText.textContent = text;
  }

  // ============================================================
  // 工具
  // ============================================================

  /** 安全发送消息到标签页，连接断开时静默忽略 */
  async function sendToTab(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      // 连接不存在（chrome:// 页面、页面未加载完成等），静默忽略
      return null;
    }
  }

  // ============================================================
  // 事件处理
  // ============================================================

  // 主按钮：翻译/关闭
  btnTranslate.addEventListener('click', async () => {
    if (!settings.apiKey) {
      apiWarning.style.display = 'flex';
      apiWarning.style.animation = 'none';
      apiWarning.offsetHeight;
      apiWarning.style.animation = 'shake 0.5s ease';
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if (isPageActive) {
      await sendToTab(tab.id, { type: 'STOP_TRANSLATION' });
      isPageActive = false;
      isPageTranslating = false;
    } else {
      await sendToTab(tab.id, {
        type: 'UPDATE_SETTINGS',
        settings: {
          targetLang: targetLang.value,
          translationStyle: 'below',
          apiKey: settings.apiKey,
        },
      });
      await sendToTab(tab.id, { type: 'START_TRANSLATION' });
      isPageActive = true;
      isPageTranslating = true;
      setStatus('translating', '翻译中...');
      btnTranslateText.textContent = '翻译中...';
      btnTranslate.classList.add('running');
      pollTranslationStatus(tab.id);
    }

    updateUI();
  });

  // 清除译文
  btnRemove.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await sendToTab(tab.id, { type: 'REMOVE_ALL_TRANSLATIONS' });
    isPageActive = false;
    isPageTranslating = false;
    updateUI();
  });

  // 重新翻译
  btnRetranslate.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if (!settings.apiKey) {
      apiWarning.style.display = 'flex';
      return;
    }

    await sendToTab(tab.id, {
      type: 'UPDATE_SETTINGS',
      settings: {
        targetLang: targetLang.value,
        translationStyle: 'below',
        apiKey: settings.apiKey,
      },
    });
    await sendToTab(tab.id, { type: 'RETRANSLATE_PAGE' });
    isPageActive = true;
    isPageTranslating = true;
    setStatus('translating', '重新翻译中...');
    updateUI();
    pollTranslationStatus(tab.id);
  });

  // 语言切换
  targetLang.addEventListener('change', async () => {
    await chrome.storage.sync.set({ targetLang: targetLang.value });
    settings.targetLang = targetLang.value;

    if (isPageActive) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await sendToTab(tab.id, {
          type: 'UPDATE_SETTINGS',
          settings: { targetLang: targetLang.value },
        });
        await sendToTab(tab.id, { type: 'RETRANSLATE_PAGE' });
        isPageTranslating = true;
        setStatus('translating', '切换语言，重新翻译...');
        pollTranslationStatus(tab.id);
      }
    }
  });

  // 导航到设置页
  goToOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // ============================================================
  // 轮询翻译状态
  // ============================================================

  let pollTimer = null;

  async function pollTranslationStatus(tabId) {
    // 清除之前的轮询
    if (pollTimer) clearInterval(pollTimer);

    let attempts = 0;
    const maxAttempts = 120;

    pollTimer = setInterval(async () => {
      attempts++;
      try {
        const status = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
        if (status) {
          isPageActive = status.isActive;
          isPageTranslating = status.isTranslating;

          if (!isPageTranslating || attempts >= maxAttempts) {
            clearInterval(pollTimer);
            pollTimer = null;
            updateUI();
          }
        } else {
          clearInterval(pollTimer);
          pollTimer = null;
          updateUI();
        }
      } catch (e) {
        // 连接断开（弹窗关闭、页面切换等），静默停止
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 1000);
  }

  // 弹窗关闭时清理定时器
  window.addEventListener('pagehide', () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  // ============================================================
  // 启动
  // ============================================================

  init();
});
