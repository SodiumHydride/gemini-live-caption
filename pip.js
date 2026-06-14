// pip.js — Gemini Live Caption · Document PiP Window
// KikoFlu-inspired glassmorphism subtitle display.
//
// Runs in a plain browsing context (no chrome.* APIs).
// Communication via postMessage with content.js as bridge.
//
// Inbound:  CAPTION_UPDATE, CLEAR_CAPTIONS, SETTINGS_UPDATE
// Outbound: PIP_CLOSED, PIP_SETTINGS_CHANGED

(function () {
  'use strict';

  const FONT_MAP = { small: '20px', medium: '28px', large: '36px', xlarge: '44px' };
  const FADE_TIMEOUT = 15000;

  let linesEl, flowEl, placeholder, settingsPanel;
  let historyPanel, historyScroll, historyOverlay;
  let historyVisible = false;
  let maxLines = 2;
  let fadeTimer = null;
  let capturing = false;

  // Dedup state
  let lastFinalized = '';

  // Caption history buffer
  const CAPTION_HISTORY_SIZE = 500;
  const captionHistory = [];

  // ==================== INIT ====================
  document.addEventListener('DOMContentLoaded', () => {
    // i18n: in the PiP window chrome.* APIs aren't available, so I18N.init()
    // will fall back to navigator.language. content.js sends the user's
    // chosen UI language right after opening, overriding the default.
    if (window.I18N) {
      I18N.init().then(() => I18N.apply(document));
    }

    linesEl = document.getElementById('lines');
    const legacyTrack = document.getElementById('track');
    if (legacyTrack) legacyTrack.remove();
    flowEl = document.createElement('div');
    flowEl.className = 'flow';
    linesEl.appendChild(flowEl);
    applyViewportSize();
    placeholder = document.getElementById('placeholder');
    settingsPanel = document.getElementById('settings-panel');
    historyPanel = document.getElementById('history-panel');
    historyScroll = document.getElementById('history-scroll');
    historyOverlay = document.getElementById('history-overlay');

    // Close button
    document.getElementById('close-btn').addEventListener('click', () => {
      notifyClosed();
      window.close();
    });

    // Settings toggle
    document.getElementById('settings-btn').addEventListener('click', () => {
      settingsPanel.classList.toggle('hidden');
    });

    // Close settings when clicking outside
    document.addEventListener('click', (e) => {
      if (!settingsPanel.classList.contains('hidden') &&
          !settingsPanel.contains(e.target) &&
          e.target.id !== 'settings-btn' &&
          !e.target.closest('#settings-btn')) {
        settingsPanel.classList.add('hidden');
      }
    });

    // Settings: font size
    setupSegment('sp-fontsize', 'medium', (val) => {
      document.documentElement.style.setProperty('--cap-font-size', FONT_MAP[val]);
      applyViewportSize();
      sendSetting('fontSize', val);
    });

    // Settings: max lines
    setupSegment('sp-maxlines', '2', (val) => {
      maxLines = parseInt(val);
      applyViewportSize();
      sendSetting('maxLines', maxLines);
    });

    // Settings: opacity
    const opacitySlider = document.getElementById('sp-opacity');
    const opacityVal = document.getElementById('sp-opacity-val');
    opacitySlider.addEventListener('input', () => {
      opacityVal.textContent = opacitySlider.value + '%';
    });
    opacitySlider.addEventListener('change', () => {
      const v = parseInt(opacitySlider.value) / 100;
      document.documentElement.style.setProperty('--cap-bg', `rgba(0,0,0,${v})`);
      sendSetting('bgOpacity', v);
    });

    // Settings: text color
    setupColors('sp-color', '#ffffff', (val) => {
      document.documentElement.style.setProperty('--cap-text', val);
      sendSetting('textColor', val);
    });

    // Before unload
    window.addEventListener('beforeunload', notifyClosed);

    // Double-click to toggle history panel
    linesEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHistory();
    });

    // History panel close button
    const historyClose = document.getElementById('history-close');
    if (historyClose) {
      historyClose.addEventListener('click', (e) => {
        e.stopPropagation();
        hideHistory();
      });
    }

    // Click overlay to close history
    if (historyOverlay) {
      historyOverlay.addEventListener('click', () => hideHistory());
    }

    // ESC key to close history
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && historyVisible) {
        hideHistory();
      }
    });

    // Listen for messages from content.js (verify source to prevent injection)
    window.addEventListener('message', (event) => {
      if (event.source !== window.opener) return;
      if (!event.data || !event.data.type) return;
      switch (event.data.type) {
        case 'CAPTION_UPDATE':
          show(event.data.text, event.data.isFinal, event.data.original);
          break;
        case 'CLEAR_CAPTIONS':
          clearCaptions();
          break;
        case 'SETTINGS_UPDATE':
          applySettings(event.data);
          break;
        case 'PIP_CLOSE_REQUEST':
          notifyClosed();
          window.close();
          break;
      }
    });
  });

  // ==================== SETTINGS HELPERS ====================
  function setupSegment(containerId, defaultVal, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        onChange(btn.dataset.v);
      });
    });
  }

  function setupColors(containerId, defaultVal, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        onChange(btn.dataset.v);
      });
    });
  }

  function sendSetting(key, value) {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'PIP_SETTINGS_CHANGED', key, value }, window.location.origin);
      }
    } catch (e) {}
  }

  // ==================== SETTINGS APPLY ====================
  function applySettings(s) {
    const root = document.documentElement;
    if (s.fontSize) {
      root.style.setProperty('--cap-font-size', FONT_MAP[s.fontSize] ?? FONT_MAP.medium);
      // Update settings panel UI
      const seg = document.getElementById('sp-fontsize');
      if (seg) seg.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === s.fontSize);
      });
    }
    if (s.bgOpacity !== undefined) {
      root.style.setProperty('--cap-bg', `rgba(0,0,0,${s.bgOpacity})`);
      const slider = document.getElementById('sp-opacity');
      const val = document.getElementById('sp-opacity-val');
      if (slider) slider.value = Math.round(s.bgOpacity * 100);
      if (val) val.textContent = Math.round(s.bgOpacity * 100) + '%';
    }
    if (s.textColor) {
      root.style.setProperty('--cap-text', s.textColor);
      const container = document.getElementById('sp-color');
      if (container) container.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === s.textColor);
      });
    }
    if (s.bilingualMode !== undefined) {
      // bilingualMode state is informational for PiP; rendering handled by content.js
    }
    if (s.uiLanguage && window.I18N) {
      // Mirror the popup's UI language. setLang() tries chrome.storage.set
      // (no-op here, swallowed) and then re-applies translations.
      I18N.setLang(s.uiLanguage);
    }
    if (s.maxLines) {
      maxLines = s.maxLines;
      const seg = document.getElementById('sp-maxlines');
      if (seg) seg.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === String(s.maxLines));
      });
    }
    if (s.fontSize || s.maxLines) applyViewportSize();
  }

  // ==================== CAPTION VIEWPORT (broadcast-style) ====================
  const COMMITTED_MAX_CHARS = 600;
  let committedText = '';
  let liveText = '';

  function joinSegments(a, b) {
    const left = (a || '').trim();
    const right = (b || '').trim();
    if (!left) return right;
    if (!right) return left;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/.test(left)) return left + right;
    return left + ' ' + right;
  }

  function applyViewportSize() {
    if (!flowEl) return;
    const lh = measureLineHeightPx();
    document.documentElement.style.setProperty('--cap-line-h', `${lh}px`);
    document.documentElement.style.setProperty('--cap-viewport-h', `${lh * maxLines}px`);
  }

  function measureLineHeightPx() {
    if (!flowEl) return 28;
    const cs = getComputedStyle(flowEl);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const lh = parseFloat(cs.lineHeight);
    return Number.isFinite(lh) ? lh : fontSize * 1.4;
  }

  function computeViewportHeight() {
    return measureLineHeightPx() * maxLines;
  }

  function renderCaption() {
    if (!flowEl) return;
    const display = joinSegments(committedText, liveText);
    if (flowEl.textContent !== display) flowEl.textContent = display;
  }

  function appendCommitted(segment) {
    const s = segment.trim();
    if (!s) return;
    committedText = joinSegments(committedText, s);
    if (committedText.length > COMMITTED_MAX_CHARS) {
      committedText = committedText.slice(-COMMITTED_MAX_CHARS);
    }
  }

  function show(text, isFinal, originalText) {
    if (!text) {
      if (!isFinal) {
        liveText = '';
        renderCaption();
      }
      return;
    }

    if (isFinal) {
      if (text.trim() === lastFinalized.trim()) return;
      lastFinalized = text;
      appendCommitted(text);
      liveText = '';

      const ts = Date.now();
      captionHistory.push({ text, ts, original: originalText || '' });
      if (captionHistory.length > CAPTION_HISTORY_SIZE) captionHistory.shift();
      if (historyVisible) appendHistoryEntry(text, ts, originalText);
    } else {
      liveText = text.trim();
    }
    renderCaption();

    capturing = true;
    placeholder.classList.remove('show');
    linesEl.style.display = '';
    linesEl.style.opacity = '1';

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (capturing) {
        capturing = false;
        linesEl.style.opacity = '0';
        setTimeout(() => {
          if (!capturing) clearTrack();
        }, 280);
      }
    }, FADE_TIMEOUT);
  }

  function clearCaptions() {
    clearTimeout(fadeTimer);
    linesEl.style.opacity = '0';
    setTimeout(clearTrack, 280);
    capturing = false;
  }

  function clearTrack() {
    committedText = '';
    liveText = '';
    lastFinalized = '';
    if (flowEl) flowEl.textContent = '';
    if (linesEl) {
      linesEl.style.opacity = '1';
      linesEl.style.display = 'none';
    }
    placeholder.classList.add('show');
  }

  // ==================== HISTORY PANEL ====================
  function toggleHistory() {
    if (historyVisible) {
      hideHistory();
    } else {
      showHistory();
    }
  }

  function showHistory() {
    if (!historyPanel || !historyScroll) return;
    historyVisible = true;

    // Populate history
    renderHistory();

    // Show panel with animation
    historyPanel.classList.add('visible');
    if (historyOverlay) historyOverlay.classList.add('visible');

    // Scroll to bottom
    requestAnimationFrame(() => {
      historyScroll.scrollTop = historyScroll.scrollHeight;
    });

    // Pause fade timer while viewing history
    clearTimeout(fadeTimer);
  }

  function hideHistory() {
    if (!historyPanel) return;
    historyVisible = false;
    historyPanel.classList.remove('visible');
    if (historyOverlay) historyOverlay.classList.remove('visible');

    // Restart fade timer after closing history panel
    if (capturing) {
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => {
        if (capturing) {
          capturing = false;
          linesEl.style.opacity = '0';
          setTimeout(() => {
            if (!capturing) clearTrack();
          }, 280);
        }
      }, FADE_TIMEOUT);
    }
  }

  function renderHistory() {
    if (!historyScroll) return;

    // Clear existing content
    while (historyScroll.firstChild) {
      historyScroll.removeChild(historyScroll.firstChild);
    }

    // Render all history entries
    for (const entry of captionHistory) {
      appendHistoryEntry(entry.text, entry.ts, entry.original);
    }
  }

  function appendHistoryEntry(text, ts, originalText) {
    if (!historyScroll) return;

    const el = document.createElement('div');
    el.className = 'history-entry';

    const time = document.createElement('span');
    time.className = 'history-time';
    const d = new Date(ts);
    time.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'history-content';

    if (originalText) {
      const origEl = document.createElement('div');
      origEl.className = 'history-original';
      origEl.textContent = originalText;
      contentEl.appendChild(origEl);
    }

    const textEl = document.createElement('div');
    textEl.className = 'history-text';
    textEl.textContent = text;
    contentEl.appendChild(textEl);

    el.appendChild(time);
    el.appendChild(contentEl);
    historyScroll.appendChild(el);

    // Near-Bottom Detection: only auto-scroll if user is already at bottom
    const threshold = 80;
    const { scrollHeight, scrollTop, clientHeight } = historyScroll;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < threshold;

    if (isNearBottom) {
      requestAnimationFrame(() => {
        historyScroll.scrollTop = historyScroll.scrollHeight;
      });
    }
  }

  // ==================== LIFECYCLE ====================
  function notifyClosed() {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'PIP_CLOSED' }, window.location.origin);
      }
    } catch (e) {}
  }
})();
