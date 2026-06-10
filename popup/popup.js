// popup.js — Gemini Live Caption Settings

document.addEventListener('DOMContentLoaded', async () => {
  // ==================== DOM ELEMENTS ====================
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleIcon = document.getElementById('toggleIcon');
  const toggleLabel = document.getElementById('toggleLabel');
  const statusBadge = document.getElementById('statusBadge');
  const apiKeyInput = document.getElementById('apiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const targetLanguageSelect = document.getElementById('targetLanguage');
  const fontSizeControl = document.getElementById('fontSizeControl');
  const bgOpacitySlider = document.getElementById('bgOpacity');
  const opacityValue = document.getElementById('opacityValue');

  // ==================== LOAD SETTINGS ====================
  const settings = await chrome.storage.local.get([
    'apiKey', 'targetLanguage', 'fontSize', 'bgOpacity'
  ]);

  if (settings.apiKey) apiKeyInput.value = settings.apiKey;
  if (settings.targetLanguage) targetLanguageSelect.value = settings.targetLanguage;
  if (settings.fontSize) {
    fontSizeControl.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === settings.fontSize);
    });
  }
  if (settings.bgOpacity !== undefined) {
    const pct = Math.round(settings.bgOpacity * 100);
    bgOpacitySlider.value = pct;
    opacityValue.textContent = `${pct}%`;
  }

  // ==================== GET CURRENT STATUS ====================
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    updateUI(status.state);
  } catch (e) {
    updateUI('idle');
  }

  // ==================== TOGGLE CAPTURE ====================
  toggleBtn.addEventListener('click', async () => {
    // Check API key first
    if (!apiKeyInput.value.trim()) {
      apiKeyInput.focus();
      apiKeyInput.style.borderColor = '#FF4444';
      setTimeout(() => { apiKeyInput.style.borderColor = ''; }, 2000);
      return;
    }

    toggleBtn.disabled = true;
    toggleLabel.textContent = 'Starting...';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');

      const response = await chrome.runtime.sendMessage({
        type: 'TOGGLE_CAPTURE',
        tabId: tab.id,
      });

      if (response.success) {
        updateUI(response.state);
      } else {
        console.error('Toggle failed:', response.error);
        updateUI('idle');
        // Show error briefly
        toggleLabel.textContent = response.error || 'Error';
        setTimeout(() => updateUI('idle'), 3000);
      }
    } catch (err) {
      console.error('Toggle error:', err);
      updateUI('idle');
    } finally {
      toggleBtn.disabled = false;
    }
  });

  // ==================== UI STATE ====================
  function updateUI(state) {
    const statusDot = statusBadge.querySelector('.status-dot');
    const statusText = statusBadge.querySelector('.status-text');

    toggleBtn.disabled = false;

    if (state === 'capturing') {
      toggleBtn.classList.add('active');
      toggleIcon.textContent = '⏹';
      toggleLabel.textContent = 'Stop Caption';
      statusDot.className = 'status-dot active';
      statusText.textContent = 'Capturing';
    } else if (state === 'starting') {
      toggleBtn.disabled = true;
      toggleIcon.textContent = '⏳';
      toggleLabel.textContent = 'Starting...';
      statusDot.className = 'status-dot starting';
      statusText.textContent = 'Starting';
    } else {
      toggleBtn.classList.remove('active');
      toggleIcon.textContent = '▶';
      toggleLabel.textContent = 'Start Caption';
      statusDot.className = 'status-dot';
      statusText.textContent = 'Ready';
    }
  }

  // ==================== API KEY TOGGLE ====================
  toggleApiKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleApiKeyBtn.textContent = isPassword ? '🙈' : '👁';
  });

  // ==================== SETTINGS AUTO-SAVE ====================
  function saveSettings(partial) {
    chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: partial,
    }).catch(() => {});
  }

  apiKeyInput.addEventListener('change', () => {
    saveSettings({ apiKey: apiKeyInput.value.trim() });
  });

  targetLanguageSelect.addEventListener('change', () => {
    saveSettings({ targetLanguage: targetLanguageSelect.value });
  });

  fontSizeControl.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    fontSizeControl.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveSettings({ fontSize: btn.dataset.value });
  });

  bgOpacitySlider.addEventListener('input', () => {
    const pct = bgOpacitySlider.value;
    opacityValue.textContent = `${pct}%`;
  });

  bgOpacitySlider.addEventListener('change', () => {
    saveSettings({ bgOpacity: parseInt(bgOpacitySlider.value) / 100 });
  });
});
