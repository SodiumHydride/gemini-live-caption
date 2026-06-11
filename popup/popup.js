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
  const audioGainSlider = document.getElementById('audioGain');
  const gainValue = document.getElementById('gainValue');
  const noiseGateSlider = document.getElementById('noiseGate');
  const gateValue = document.getElementById('gateValue');

  // ==================== LOAD SETTINGS ====================
  const settings = await chrome.storage.local.get([
    'apiKey', 'targetLanguage', 'fontSize', 'bgOpacity', 'audioGain', 'noiseGate'
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
  if (settings.audioGain !== undefined) {
    const val = Math.round(settings.audioGain * 10);
    audioGainSlider.value = val;
    gainValue.textContent = `${(val / 10).toFixed(1)}x`;
  }
  if (settings.noiseGate !== undefined) {
    const val = Math.round(settings.noiseGate * 1000);
    noiseGateSlider.value = val;
    gateValue.textContent = val === 0 ? 'Off' : `${(val / 1000).toFixed(3)}`;
  }

  // ==================== GET CURRENT STATUS ====================
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    updateUI(status.state);
  } catch (e) {
    updateUI('idle');
  }

  // ==================== PiP STATUS ====================
  const displayModeInfo = document.querySelector('.display-mode-info');

  async function updatePipStatus() {
    try {
      const data = await chrome.storage.session.get('pipWindowOpen');
      const isActive = !!data.pipWindowOpen;
      if (displayModeInfo) {
        displayModeInfo.classList.toggle('pip-active', isActive);
        // Update the second hint to reflect current state
        const sub = displayModeInfo.querySelector('.mode-hint-sub');
        if (sub) {
          sub.textContent = isActive
            ? 'PiP window is currently active'
            : 'PiP window stays visible when you switch tabs';
        }
      }
    } catch (e) {
      // storage.session may not be available in all contexts
    }
  }

  await updatePipStatus();

  // Listen for real-time PiP status changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.pipWindowOpen) {
      updatePipStatus();
    }
  });

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

  audioGainSlider.addEventListener('input', () => {
    const val = parseInt(audioGainSlider.value);
    gainValue.textContent = `${(val / 10).toFixed(1)}x`;
  });

  audioGainSlider.addEventListener('change', () => {
    saveSettings({ audioGain: parseInt(audioGainSlider.value) / 10 });
  });

  noiseGateSlider.addEventListener('input', () => {
    const val = parseInt(noiseGateSlider.value);
    gateValue.textContent = val === 0 ? 'Off' : `${(val / 1000).toFixed(3)}`;
  });

  noiseGateSlider.addEventListener('change', () => {
    saveSettings({ noiseGate: parseInt(noiseGateSlider.value) / 1000 });
  });

  // ==================== EXPORT DIAGNOSTIC LOGS ====================
  const exportLogsBtn = document.getElementById('exportLogs');
  if (exportLogsBtn) {
    exportLogsBtn.addEventListener('click', async () => {
      exportLogsBtn.disabled = true;
      exportLogsBtn.textContent = 'Exporting...';

      try {
        const response = await chrome.runtime.sendMessage({ type: 'EXPORT_LOGS' });
        if (response && response.entries && response.entries.length > 0) {
          // Format logs as readable text
          const lines = response.entries.map(e => {
            const ts = new Date(e.ts).toISOString();
            return `[${ts}] [${e.level.toUpperCase()}] ${e.msg}`;
          });
          const logText = lines.join('\n');

          // Copy to clipboard
          await navigator.clipboard.writeText(logText);
          exportLogsBtn.textContent = 'Copied!';
          setTimeout(() => {
            exportLogsBtn.textContent = 'Export Logs';
            exportLogsBtn.disabled = false;
          }, 2000);
        } else {
          exportLogsBtn.textContent = 'No logs';
          setTimeout(() => {
            exportLogsBtn.textContent = 'Export Logs';
            exportLogsBtn.disabled = false;
          }, 2000);
        }
      } catch (err) {
        console.error('Export logs failed:', err);
        exportLogsBtn.textContent = 'Failed';
        setTimeout(() => {
          exportLogsBtn.textContent = 'Export Logs';
          exportLogsBtn.disabled = false;
        }, 2000);
      }
    });
  }
});
