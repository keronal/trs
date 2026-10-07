// ============================================================
// TRS Options Script
// 设置页面逻辑、存储管理、导航切换
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // ============================================================
  // DOM 元素
  // ============================================================
  const apiKeyInput = document.getElementById('apiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const targetLangSelect = document.getElementById('targetLang');
  const modelSelect = document.getElementById('model');
  const autoTranslateToggle = document.getElementById('autoTranslate');
  const fontSizeSelect = document.getElementById('fontSize');
  const maxConcurrentSelect = document.getElementById('maxConcurrent');
  const excludedDomainsTextarea = document.getElementById('excludedDomains');
  const clearCacheBtn = document.getElementById('clearCache');

  // 快捷键
  const shortcutKeyEl = document.getElementById('shortcutKey');
  const changeShortcutBtn = document.getElementById('changeShortcut');

  // 导航
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.section');

  // 默认设置由 background.js 统一管理（通过 GET_SETTINGS 消息获取）
  // 修改默认值请更新 background.js 的 DEFAULT_SETTINGS

  let currentSettings = {};

  // ============================================================
  // 初始化
  // ============================================================
  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (!response.error) {
        currentSettings = response;
        const keyResponse = await chrome.runtime.sendMessage({ type: 'GET_API_KEY' });
        if (keyResponse.error) throw new Error(keyResponse.error);
        currentSettings.apiKey = keyResponse.apiKey || '';
      }
    } catch (e) {
      // background 不可用时回退到直接读取 storage
      const [stored, local] = await Promise.all([
        chrome.storage.sync.get(null),
        chrome.storage.local.get('apiKey'),
      ]);
      currentSettings = { ...stored, apiKey: local.apiKey || '' };
    }
    populateForm();
  }

  function populateForm() {
    apiKeyInput.value = currentSettings.apiKey || '';
    targetLangSelect.value = currentSettings.targetLang || 'zh-CN';
    modelSelect.value = currentSettings.model || 'deepseek-flash';
    autoTranslateToggle.checked = currentSettings.autoTranslate || false;

    fontSizeSelect.value = currentSettings.fontSize || '0.92em';
    maxConcurrentSelect.value = String(currentSettings.maxConcurrent || 8);
    // 旧版本存储的值（如 5/7）不在新选项中时，回退到默认值
    if (maxConcurrentSelect.selectedIndex === -1) {
      maxConcurrentSelect.value = '8';
    }

    const domains = currentSettings.excludedDomains || [];
    excludedDomainsTextarea.value = Array.isArray(domains) ? domains.join('\n') : '';
  }

  // ============================================================
  // 保存设置
  // ============================================================
  async function saveSettings(partial) {
    try {
      if (Object.hasOwn(partial, 'apiKey')) {
        const response = await chrome.runtime.sendMessage({ type: 'SET_API_KEY', apiKey: partial.apiKey });
        if (response?.error) throw new Error(response.error);
      } else {
        await chrome.storage.sync.set(partial);
      }
      Object.assign(currentSettings, partial);
      showToast('设置已保存 ✓', 'success');
      notifyAllTabs(partial);
    } catch (e) {
      showToast('设置保存失败，请重试', 'error');
    }
  }

  async function notifyAllTabs(partialSettings) {
    try {
      const { apiKey, ...safeSettings } = partialSettings;
      if (apiKey !== undefined) safeSettings.hasApiKey = Boolean(apiKey);
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'UPDATE_SETTINGS',
            settings: safeSettings,
          }).catch(() => {}); // 忽略未加载 content script 的页面
        }
      }
    } catch (e) {
      // 静默处理
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  // API Key 显示/隐藏
  toggleApiKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleApiKeyBtn.textContent = isPassword ? '🙈' : '👁️';
  });

  // API Key 自动保存（失焦时）
  apiKeyInput.addEventListener('blur', () => {
    const value = apiKeyInput.value.trim();
    if (value !== currentSettings.apiKey) {
      saveSettings({ apiKey: value });
    }
  });

  // API Key 回车保存
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      apiKeyInput.blur();
    }
  });

  // 目标语言
  targetLangSelect.addEventListener('change', () => {
    saveSettings({ targetLang: targetLangSelect.value });
  });

  // 翻译模型
  modelSelect.addEventListener('change', () => {
    saveSettings({ model: modelSelect.value });
  });

  // 自动翻译
  autoTranslateToggle.addEventListener('change', () => {
    saveSettings({ autoTranslate: autoTranslateToggle.checked });
  });

  // 译文字号
  fontSizeSelect.addEventListener('change', () => {
    saveSettings({ fontSize: fontSizeSelect.value });
  });

  // 最大并发
  maxConcurrentSelect.addEventListener('change', () => {
    saveSettings({ maxConcurrent: parseInt(maxConcurrentSelect.value, 10) });
  });

  // 排除域名
  let excludedDomainsDebounce = null;
  excludedDomainsTextarea.addEventListener('input', () => {
    if (excludedDomainsDebounce) clearTimeout(excludedDomainsDebounce);
    excludedDomainsDebounce = setTimeout(() => {
      const domains = excludedDomainsTextarea.value
        .split('\n')
        .map(d => d.trim())
        .filter(d => d.length > 0);
      saveSettings({ excludedDomains: domains });
    }, 800);
  });

  // 清除缓存
  clearCacheBtn.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      if (response?.error) throw new Error(response.error);
      showToast('翻译缓存已清除 ✓', 'success');
    } catch (e) {
      showToast('清除缓存失败，请重试', 'error');
    }
  });

  // ============================================================
  // 快捷键
  // ============================================================

  async function loadShortcut() {
    try {
      const commands = await chrome.commands.getAll();
      const toggleCmd = commands.find(cmd => cmd.name === 'toggle-translation');
      if (toggleCmd && toggleCmd.shortcut) {
        shortcutKeyEl.textContent = toggleCmd.shortcut;
      } else {
        shortcutKeyEl.textContent = '未设置';
      }
    } catch (e) {
      shortcutKeyEl.textContent = 'Alt+A';
    }
  }

  changeShortcutBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // ============================================================
  // 导航切换
  // ============================================================

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = item.dataset.section;

      // 更新导航状态
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      // 更新内容区
      sections.forEach(s => s.classList.remove('active'));
      const targetSection = document.getElementById(sectionId);
      if (targetSection) {
        targetSection.classList.add('active');
      }

      // 更新 URL hash
      window.location.hash = sectionId;
    });
  });

  // 初始加载时根据 hash 跳转
  function handleHash() {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
      const navItem = document.querySelector(`.nav-item[data-section="${hash}"]`);
      if (navItem) navItem.click();
    }
  }

  window.addEventListener('hashchange', handleHash);

  // ============================================================
  // Toast 消息
  // ============================================================

  function showToast(message, type = '') {
    // 移除旧 toast
    const oldToast = document.querySelector('.toast');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ============================================================
  // 启动
  // ============================================================

  loadSettings().then(() => {
    handleHash();
    loadShortcut();
  });
});
