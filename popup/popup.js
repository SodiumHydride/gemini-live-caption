// popup.js — Gemini Live Caption Settings

// Target languages supported by gemini-3.5-live-translate-preview (70+).
// BCP-47 codes per https://ai.google.dev/gemini-api/docs/live-api/live-translate
const LANGUAGES = [
  { code: 'af', en: 'Afrikaans', native: 'Afrikaans' },
  { code: 'ak', en: 'Akan', native: 'Akan' },
  { code: 'sq', en: 'Albanian', native: 'Shqip' },
  { code: 'am', en: 'Amharic', native: 'አማርኛ' },
  { code: 'ar', en: 'Arabic', native: 'العربية' },
  { code: 'hy', en: 'Armenian', native: 'Հայերեն' },
  { code: 'az', en: 'Azerbaijani', native: 'Azərbaycan' },
  { code: 'eu', en: 'Basque', native: 'Euskara' },
  { code: 'be', en: 'Belarusian', native: 'Беларуская' },
  { code: 'bn', en: 'Bengali', native: 'বাংলা' },
  { code: 'bg', en: 'Bulgarian', native: 'Български' },
  { code: 'my', en: 'Burmese', native: 'မြန်မာ' },
  { code: 'ca', en: 'Catalan', native: 'Català' },
  { code: 'zh-Hans', en: 'Chinese (Simplified)', native: '中文（简体）' },
  { code: 'zh-Hant', en: 'Chinese (Traditional)', native: '中文（繁體）' },
  { code: 'hr', en: 'Croatian', native: 'Hrvatski' },
  { code: 'cs', en: 'Czech', native: 'Čeština' },
  { code: 'da', en: 'Danish', native: 'Dansk' },
  { code: 'nl', en: 'Dutch', native: 'Nederlands' },
  { code: 'en', en: 'English', native: 'English' },
  { code: 'et', en: 'Estonian', native: 'Eesti' },
  { code: 'fil', en: 'Filipino', native: 'Filipino' },
  { code: 'fi', en: 'Finnish', native: 'Suomi' },
  { code: 'fr', en: 'French', native: 'Français' },
  { code: 'gl', en: 'Galician', native: 'Galego' },
  { code: 'ka', en: 'Georgian', native: 'ქართული' },
  { code: 'de', en: 'German', native: 'Deutsch' },
  { code: 'el', en: 'Greek', native: 'Ελληνικά' },
  { code: 'gu', en: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'ha', en: 'Hausa', native: 'Hausa' },
  { code: 'he', en: 'Hebrew', native: 'עברית' },
  { code: 'hi', en: 'Hindi', native: 'हिन्दी' },
  { code: 'hu', en: 'Hungarian', native: 'Magyar' },
  { code: 'is', en: 'Icelandic', native: 'Íslenska' },
  { code: 'id', en: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'it', en: 'Italian', native: 'Italiano' },
  { code: 'ja', en: 'Japanese', native: '日本語' },
  { code: 'jv', en: 'Javanese', native: 'Basa Jawa' },
  { code: 'kn', en: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'kk', en: 'Kazakh', native: 'Қазақ' },
  { code: 'km', en: 'Khmer', native: 'ខ្មែរ' },
  { code: 'rw', en: 'Kinyarwanda', native: 'Kinyarwanda' },
  { code: 'ko', en: 'Korean', native: '한국어' },
  { code: 'lo', en: 'Lao', native: 'ລາວ' },
  { code: 'lv', en: 'Latvian', native: 'Latviešu' },
  { code: 'lt', en: 'Lithuanian', native: 'Lietuvių' },
  { code: 'mk', en: 'Macedonian', native: 'Македонски' },
  { code: 'ms', en: 'Malay', native: 'Bahasa Melayu' },
  { code: 'ml', en: 'Malayalam', native: 'മലയാളം' },
  { code: 'mr', en: 'Marathi', native: 'मराठी' },
  { code: 'mn', en: 'Mongolian', native: 'Монгол' },
  { code: 'ne', en: 'Nepali', native: 'नेपाली' },
  { code: 'no', en: 'Norwegian', native: 'Norsk' },
  { code: 'fa', en: 'Persian', native: 'فارسی' },
  { code: 'pl', en: 'Polish', native: 'Polski' },
  { code: 'pt-BR', en: 'Portuguese (Brazil)', native: 'Português (BR)' },
  { code: 'pt-PT', en: 'Portuguese (Portugal)', native: 'Português (PT)' },
  { code: 'pa', en: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ro', en: 'Romanian', native: 'Română' },
  { code: 'ru', en: 'Russian', native: 'Русский' },
  { code: 'sr', en: 'Serbian', native: 'Српски' },
  { code: 'sd', en: 'Sindhi', native: 'سنڌي' },
  { code: 'si', en: 'Sinhala', native: 'සිංහල' },
  { code: 'sk', en: 'Slovak', native: 'Slovenčina' },
  { code: 'sl', en: 'Slovenian', native: 'Slovenščina' },
  { code: 'es', en: 'Spanish', native: 'Español' },
  { code: 'su', en: 'Sundanese', native: 'Basa Sunda' },
  { code: 'sw', en: 'Swahili', native: 'Kiswahili' },
  { code: 'sv', en: 'Swedish', native: 'Svenska' },
  { code: 'ta', en: 'Tamil', native: 'தமிழ்' },
  { code: 'te', en: 'Telugu', native: 'తెలుగు' },
  { code: 'th', en: 'Thai', native: 'ไทย' },
  { code: 'tr', en: 'Turkish', native: 'Türkçe' },
  { code: 'uk', en: 'Ukrainian', native: 'Українська' },
  { code: 'ur', en: 'Urdu', native: 'اردو' },
  { code: 'uz', en: 'Uzbek', native: 'Oʻzbek' },
  { code: 'vi', en: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'zu', en: 'Zulu', native: 'isiZulu' },
];

// Quick-access languages shown in a "Common" group at the top of the picker.
const POPULAR_LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt-BR', 'ar', 'hi'];

function populateLanguages(selectEl) {
  if (!selectEl) return;
  const byCode = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));
  const makeOption = (l) => {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.native === l.en ? l.en : `${l.native} (${l.en})`;
    return o;
  };
  const common = document.createElement('optgroup');
  common.label = window.I18N ? I18N.t('lang_common') : '★ Common';
  for (const code of POPULAR_LANGUAGES) {
    if (byCode[code]) common.appendChild(makeOption(byCode[code]));
  }
  const all = document.createElement('optgroup');
  all.label = window.I18N ? I18N.t('lang_all') : 'All languages (70+)';
  for (const l of LANGUAGES) all.appendChild(makeOption(l));
  selectEl.replaceChildren(common, all);
}

// Populate the UI language picker from I18N.SUPPORTED. Display each option in
// its own script (e.g. 简体中文, 日本語) so users can find their language
// regardless of the current UI language.
function populateUiLanguages(selectEl) {
  if (!selectEl || !window.I18N) return;
  const labels = I18N.LABELS || {};
  selectEl.replaceChildren(...I18N.SUPPORTED.map(code => {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = labels[code] || code;
    return o;
  }));
}

document.addEventListener('DOMContentLoaded', async () => {
  // ==================== I18N INIT ====================
  // Resolve language (saved override or browser default) and apply all
  // data-i18n placeholders in the DOM before any user-visible text renders.
  if (window.I18N) {
    await I18N.init();
    I18N.apply(document);
  }
  // Helper that falls back to the literal text when I18N is unavailable.
  const tr = (key, fallback) => (window.I18N ? I18N.t(key) : fallback);

  // ==================== DOM ELEMENTS ====================
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleIcon = document.getElementById('toggleIcon');
  const toggleLabel = document.getElementById('toggleLabel');
  const statusBadge = document.getElementById('statusBadge');
  const apiKeyInput = document.getElementById('apiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const targetLanguageSelect = document.getElementById('targetLanguage');
  const uiLanguageSelect = document.getElementById('uiLanguage');
  const fontSizeControl = document.getElementById('fontSizeControl');
  const bgOpacitySlider = document.getElementById('bgOpacity');
  const opacityValue = document.getElementById('opacityValue');
  const audioGainSlider = document.getElementById('audioGain');
  const gainValue = document.getElementById('gainValue');
  const noiseGateSlider = document.getElementById('noiseGate');
  const gateValue = document.getElementById('gateValue');

  // ==================== DISCLAIMER (first use) ====================
  const disclaimerEl = document.getElementById('disclaimer');
  const acceptBtn = document.getElementById('acceptDisclaimer');
  const { disclaimerAccepted } = await chrome.storage.local.get('disclaimerAccepted');
  if (!disclaimerAccepted && disclaimerEl) {
    disclaimerEl.style.display = '';
  }
  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      chrome.storage.local.set({ disclaimerAccepted: true });
      if (disclaimerEl) disclaimerEl.style.display = 'none';
      // Clear the "!" badge that may have been set by service worker
      chrome.runtime.sendMessage({ type: 'DISCLAIMER_ACCEPTED' }).catch(() => {});
    });
  }
  // Also clear badge on popup open if already accepted (covers the badge from a previous shortcut attempt)
  if (disclaimerAccepted) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }

  // ==================== POPULATE LANGUAGES ====================
  // Build the language pickers before loading settings so the saved values
  // can select the correct options.
  populateLanguages(targetLanguageSelect);
  populateUiLanguages(uiLanguageSelect);
  if (uiLanguageSelect && window.I18N) uiLanguageSelect.value = I18N.getLang();

  // ==================== LOAD SETTINGS ====================
  const settings = await chrome.storage.local.get([
    'apiKey', 'targetLanguage', 'fontSize', 'maxLines', 'bgOpacity', 'audioGain', 'noiseGate', 'captionPosition', 'textColor', 'bilingualMode'
  ]);

  if (settings.apiKey) apiKeyInput.value = settings.apiKey;
  if (settings.targetLanguage) targetLanguageSelect.value = settings.targetLanguage;
  if (settings.fontSize) {
    fontSizeControl.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === settings.fontSize);
    });
  }
  if (settings.maxLines) {
    const maxLinesControl = document.getElementById('maxLinesControl');
    if (maxLinesControl) {
      maxLinesControl.querySelectorAll('.seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === String(settings.maxLines));
      });
    }
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
    gateValue.textContent = val === 0 ? tr('noise_gate_off', 'Off') : `${(val / 1000).toFixed(3)}`;
  }
  if (settings.bilingualMode) {
    const bilingualCheckbox = document.getElementById('bilingualMode');
    if (bilingualCheckbox) bilingualCheckbox.checked = true;
  }
  if (settings.captionPosition) {
    const posControl = document.getElementById('positionControl');
    if (posControl) {
      posControl.querySelectorAll('.pos-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === settings.captionPosition);
      });
    }
  }
  if (settings.textColor) {
    const colorControl = document.getElementById('textColorControl');
    if (colorControl) {
      colorControl.querySelectorAll('.color-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === settings.textColor);
      });
    }
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
            ? tr('display_mode_pip_active', 'PiP window is currently active')
            : tr('display_mode_hint_sub', 'PiP window stays visible when you switch tabs');
        }
      }
    } catch (e) {
      // storage.session may not be available in all contexts
    }
  }

  await updatePipStatus();

  // Listen for real-time PiP status changes and capture state (keyboard shortcut toggle)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.pipWindowOpen) {
      updatePipStatus();
    }
    if (area === 'session' && changes.captureState) {
      updateUI(changes.captureState.newValue);
    }
  });

  // ==================== TOGGLE CAPTURE ====================
  toggleBtn.addEventListener('click', async () => {
    // Check disclaimer acceptance first
    const { disclaimerAccepted } = await chrome.storage.local.get('disclaimerAccepted');
    if (!disclaimerAccepted) {
      if (disclaimerEl) {
        disclaimerEl.style.display = '';
        disclaimerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        disclaimerEl.classList.remove('pulse');
        disclaimerEl.offsetHeight; // force reflow
        disclaimerEl.classList.add('pulse');
      }
      return;
    }

    // Check API key — guide the user toward getting one if missing
    if (!apiKeyInput.value.trim()) {
      apiKeyInput.focus();
      apiKeyInput.style.borderColor = '#FF4444';
      const prevLabel = toggleLabel.textContent;
      const hint = tr('toggle_need_key', 'Paste your API key first');
      toggleLabel.textContent = hint;
      setTimeout(() => {
        apiKeyInput.style.borderColor = '';
        // Only restore if no other state change overwrote our hint
        if (toggleLabel.textContent === hint) {
          toggleLabel.textContent = prevLabel;
        }
      }, 2000);
      return;
    }

    toggleBtn.disabled = true;
    toggleLabel.textContent = tr('toggle_starting', 'Starting...');

    // Explicitly save API key before toggling (change event may not have fired)
    saveSettings({ apiKey: apiKeyInput.value.trim() });

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
      toggleLabel.textContent = tr('toggle_stop', 'Stop Caption');
      statusDot.className = 'status-dot active';
      statusText.textContent = tr('status_capturing', 'Capturing');
    } else if (state === 'starting') {
      toggleBtn.disabled = true;
      toggleIcon.textContent = '⏳';
      toggleLabel.textContent = tr('toggle_starting', 'Starting...');
      statusDot.className = 'status-dot starting';
      statusText.textContent = tr('status_starting', 'Starting');
    } else {
      toggleBtn.classList.remove('active');
      toggleIcon.textContent = '▶';
      toggleLabel.textContent = tr('toggle_start', 'Start Caption');
      statusDot.className = 'status-dot';
      statusText.textContent = tr('status_ready', 'Ready');
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

  const maxLinesControl = document.getElementById('maxLinesControl');
  if (maxLinesControl) {
    maxLinesControl.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      maxLinesControl.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings({ maxLines: parseInt(btn.dataset.value) });
    });
  }

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
    gateValue.textContent = val === 0 ? tr('noise_gate_off', 'Off') : `${(val / 1000).toFixed(3)}`;
  });

  noiseGateSlider.addEventListener('change', () => {
    saveSettings({ noiseGate: parseInt(noiseGateSlider.value) / 1000 });
  });

  // ==================== POSITION PRESET ====================
  const positionControl = document.getElementById('positionControl');
  if (positionControl) {
    positionControl.addEventListener('click', (e) => {
      const btn = e.target.closest('.pos-btn');
      if (!btn) return;
      positionControl.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chrome.runtime.sendMessage({
        type: 'SET_POSITION',
        preset: btn.dataset.value,
      }).catch(() => {});
    });
  }

  // ==================== TEXT COLOR ====================
  const textColorControl = document.getElementById('textColorControl');
  if (textColorControl) {
    textColorControl.addEventListener('click', (e) => {
      const btn = e.target.closest('.color-btn');
      if (!btn) return;
      textColorControl.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chrome.runtime.sendMessage({
        type: 'SET_TEXT_COLOR',
        color: btn.dataset.value,
      }).catch(() => {});
    });
  }

  // ==================== BILINGUAL MODE ====================
  const bilingualCheckbox = document.getElementById('bilingualMode');
  if (bilingualCheckbox) {
    bilingualCheckbox.addEventListener('change', () => {
      saveSettings({ bilingualMode: bilingualCheckbox.checked });
    });
  }

  // ==================== EXPORT SUBTITLES ====================
  // Common helper for download buttons: temporarily flash a status label,
  // then restore the resting label after `restoreMs`.
  function flashStatus(btn, statusKey, statusFallback, restingKey, restingFallback, restoreMs = 2000) {
    btn.textContent = tr(statusKey, statusFallback);
    setTimeout(() => {
      btn.textContent = tr(restingKey, restingFallback);
      btn.disabled = false;
    }, restoreMs);
  }

  const exportCaptionsBtn = document.getElementById('exportCaptions');
  if (exportCaptionsBtn) {
    exportCaptionsBtn.addEventListener('click', async () => {
      exportCaptionsBtn.disabled = true;
      exportCaptionsBtn.textContent = tr('export_loading', 'Exporting...');

      try {
        const response = await chrome.runtime.sendMessage({ type: 'EXPORT_CAPTIONS' });
        if (response && response.srt && response.srt.length > 0) {
          // Download SRT file
          const blob = new Blob([response.srt], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `gemini-caption-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.srt`;
          a.click();
          URL.revokeObjectURL(url);
          flashStatus(exportCaptionsBtn, 'export_done', 'Downloaded!', 'export_subtitles', 'Export Subtitles (SRT)');
        } else {
          flashStatus(exportCaptionsBtn, 'export_empty_subtitles', 'No subtitles', 'export_subtitles', 'Export Subtitles (SRT)');
        }
      } catch (err) {
        console.error('Export captions failed:', err);
        flashStatus(exportCaptionsBtn, 'export_failed', 'Failed', 'export_subtitles', 'Export Subtitles (SRT)');
      }
    });
  }

  // ==================== EXPORT DIAGNOSTIC LOGS ====================
  const exportLogsBtn = document.getElementById('exportLogs');
  if (exportLogsBtn) {
    exportLogsBtn.addEventListener('click', async () => {
      exportLogsBtn.disabled = true;
      exportLogsBtn.textContent = tr('export_loading', 'Exporting...');

      try {
        const response = await chrome.runtime.sendMessage({ type: 'EXPORT_LOGS' });
        if (response && response.entries && response.entries.length > 0) {
          // Format logs as readable text
          const lines = response.entries.map(e => {
            const ts = new Date(e.ts).toISOString();
            return `[${ts}] [${e.level.toUpperCase()}] ${e.msg}`;
          });
          const logText = lines.join('\n');

          // Download as .txt file
          const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `gemini-caption-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
          a.click();
          URL.revokeObjectURL(url);
          flashStatus(exportLogsBtn, 'export_done', 'Downloaded!', 'export_logs', 'Export Logs');
        } else {
          flashStatus(exportLogsBtn, 'export_empty_logs', 'No logs', 'export_logs', 'Export Logs');
        }
      } catch (err) {
        console.error('Export logs failed:', err);
        flashStatus(exportLogsBtn, 'export_failed', 'Failed', 'export_logs', 'Export Logs');
      }
    });
  }

  // ==================== UI LANGUAGE SWITCH ====================
  if (uiLanguageSelect && window.I18N) {
    uiLanguageSelect.addEventListener('change', async () => {
      await I18N.setLang(uiLanguageSelect.value);
      // Re-populate target language picker so optgroup labels get translated
      // (their labels are set imperatively, not via data-i18n).
      populateLanguages(targetLanguageSelect);
      if (settings.targetLanguage) targetLanguageSelect.value = settings.targetLanguage;
      // Refresh dynamic captions that were rendered before the switch.
      updateUI(statusBadge.querySelector('.status-dot.active')
        ? 'capturing'
        : statusBadge.querySelector('.status-dot.starting') ? 'starting' : 'idle');
      // Noise gate "Off" label, if currently off
      if (parseInt(noiseGateSlider.value) === 0) {
        gateValue.textContent = tr('noise_gate_off', 'Off');
      }
      // PiP hint
      updatePipStatus();
    });
  }

  // ==================== EXTERNAL LINKS ====================
  // Open in a new tab via chrome.tabs.create — more reliable than a bare
  // <a target="_blank"> inside an extension popup (which can silently no-op).
  for (const id of ['githubLink', 'getKeyLink']) {
    const link = document.getElementById(id);
    if (!link) continue;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: link.href });
    });
  }
});
