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

  let track, linesEl, placeholder, settingsPanel;
  let maxLines = 3;
  let fadeTimer = null;
  let capturing = false;

  // Dedup state
  let lastFinalized = '';
  let currentPartialEl = null;
  let currentPartialText = '';
  let lineCount = 0;
  let viewportLocked = false;

  // ==================== INIT ====================
  document.addEventListener('DOMContentLoaded', () => {
    track = document.getElementById('track');
    linesEl = document.getElementById('lines');
    placeholder = document.getElementById('placeholder');
    settingsPanel = document.getElementById('settings-panel');

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
      sendSetting('fontSize', val);
    });

    // Settings: max lines
    setupSegment('sp-maxlines', '3', (val) => {
      maxLines = parseInt(val);
      resetViewport();
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

    // Listen for messages from content.js
    window.addEventListener('message', (event) => {
      if (!event.data || !event.data.type) return;
      switch (event.data.type) {
        case 'CAPTION_UPDATE':
          show(event.data.text, event.data.isFinal);
          break;
        case 'CLEAR_CAPTIONS':
          clearCaptions();
          break;
        case 'SETTINGS_UPDATE':
          applySettings(event.data);
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
        window.opener.postMessage({ type: 'PIP_SETTINGS_CHANGED', key, value }, '*');
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
    if (s.maxLines) {
      maxLines = s.maxLines;
      const seg = document.getElementById('sp-maxlines');
      if (seg) seg.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === String(s.maxLines));
      });
    }
  }

  // ==================== VIEWPORT RESET ====================
  function resetViewport() {
    // Remove excess lines if new maxLines is smaller
    while (lineCount > maxLines && track.firstChild) {
      track.removeChild(track.firstChild);
      lineCount--;
    }
    viewportLocked = false;
    linesEl.style.height = '';
    // Recalculate if we have lines
    if (track.firstChild) {
      const lineH = track.firstChild.offsetHeight;
      linesEl.style.height = (lineH * maxLines) + 'px';
      viewportLocked = true;
    }
  }

  // ==================== ADD LINE ====================
  function addLine(text) {
    const el = document.createElement('div');
    el.className = 'line';
    el.textContent = text;
    track.appendChild(el);
    lineCount++;

    if (!viewportLocked) {
      const lineH = el.offsetHeight;
      linesEl.style.height = (lineH * maxLines) + 'px';
      viewportLocked = true;
    }

    if (lineCount > maxLines) {
      const lineH = el.offsetHeight;
      track.style.transform = `translateY(-${lineH}px)`;

      track.addEventListener('transitionend', function handler(event) {
        if (event.propertyName !== 'transform') return;
        track.removeEventListener('transitionend', handler);
        if (track.firstChild && track.firstChild !== el) {
          track.removeChild(track.firstChild);
        }
        lineCount--;
        track.style.transition = 'none';
        track.style.transform = 'translateY(0)';
        track.offsetHeight;
        track.style.transition = '';
      }, { once: true });
    }
  }

  // ==================== SHOW ====================
  function show(text, isFinal) {
    if (!text) return;

    if (isFinal) {
      if (text === lastFinalized) return;
      if (currentPartialEl && currentPartialEl.parentNode === track && text === currentPartialText) {
        lastFinalized = text;
        currentPartialEl = null;
        currentPartialText = '';
        return;
      }
      lastFinalized = text;
      currentPartialEl = null;
      currentPartialText = '';
      addLine(text);
    } else {
      if (currentPartialEl && currentPartialEl.parentNode === track) {
        currentPartialEl.textContent = text;
        currentPartialText = text;
      } else {
        addLine(text);
        currentPartialEl = track.lastChild;
        currentPartialText = text;
      }
    }

    capturing = true;
    placeholder.classList.remove('show');
    linesEl.style.display = '';

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (capturing) {
        capturing = false;
        for (const child of Array.from(track.children)) {
          child.style.opacity = '0';
          child.style.maxHeight = '0';
        }
        setTimeout(() => {
          if (!capturing) {
            clearTrack();
            placeholder.classList.add('show');
          }
        }, 400);
      }
    }, FADE_TIMEOUT);
  }

  // ==================== CLEAR ====================
  function clearCaptions() {
    clearTimeout(fadeTimer);
    for (const child of Array.from(track.children)) {
      child.style.opacity = '0';
      child.style.maxHeight = '0';
    }
    setTimeout(clearTrack, 400);
    capturing = false;
  }

  function clearTrack() {
    while (track.firstChild) track.removeChild(track.firstChild);
    lineCount = 0;
    viewportLocked = false;
    linesEl.style.height = '';
    track.style.transform = 'translateY(0)';
    linesEl.style.display = 'none';
    placeholder.classList.add('show');
    currentPartialEl = null;
    currentPartialText = '';
  }

  // ==================== LIFECYCLE ====================
  function notifyClosed() {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'PIP_CLOSED' }, '*');
      }
    } catch (e) {}
  }
})();
