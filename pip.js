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
  if (!window.CaptionTrack) {
    throw new Error('caption-track.js must be loaded before pip.js');
  }

  const FONT_MAP = { small: '20px', medium: '28px', large: '36px', xlarge: '44px' };
  const FADE_TIMEOUT = 15000;

  let linesEl, flowEl, placeholder, settingsPanel;
  let historyPanel, historyScroll, historyOverlay;
  let historyVisible = false;
  let maxLines = 2;
  let fadeTimer = null;
  let captionRollFrame = 0;
  let captionRollTimer = 0;
  let capturing = false;
  let bilingualMode = false;
  const captionTrack = window.CaptionTrack.create({ bilingualMode, maxChars: 720 });

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
      maxLines = parseInt(val, 10);
      applyViewportSize();
      sendSetting('pipMaxLines', maxLines);
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
          show(event.data.text, event.data.isFinal, event.data.original, event.data.segment, { source: event.data.source || 'live' });
          break;
        case 'TRANSCRIPT_SEGMENT_UPDATED':
          applySegmentUpdate(event.data.segment);
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
    notifyReady();
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
      bilingualMode = !!s.bilingualMode;
      captionTrack.configure({ bilingualMode });
      renderCaption();
    }
    if (s.uiLanguage && window.I18N) {
      // Mirror the popup's UI language. setLang() tries chrome.storage.set
      // (no-op here, swallowed) and then re-applies translations.
      I18N.setLang(s.uiLanguage);
    }
    if (s.pipMaxLines) {
      maxLines = s.pipMaxLines;
      const seg = document.getElementById('sp-maxlines');
      if (seg) seg.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === String(s.pipMaxLines));
      });
    }
    if (s.fontSize || s.pipMaxLines || s.bilingualMode !== undefined) applyViewportSize();
  }

  // ==================== CAPTION VIEWPORT ====================
  // Caption-track owns subtitle facts. PiP renders snapshots and only animates
  // live row advances, not replay/hydration backfill.
  const CAP_LINE_HEIGHT_RATIO = 1.36;
  const CAP_SECONDARY_HEIGHT_RATIO = 0.84;
  const CAP_ROW_GAP_RATIO = 0.12;
  const CAP_LINE_WIDTH_FACTOR = 0.88;
  const CAP_ROLL_BUFFER_ROWS = 1;

  function applyViewportSize() {
    if (!flowEl) return;
    const fontSize = measureFontSizePx();
    const lh = measureLineHeightPx();
    const model = captionTrack.snapshot();
    const hasOriginal = model.rows.some(row => row.secondary);
    const secondaryHeight = hasOriginal ? fontSize * CAP_SECONDARY_HEIGHT_RATIO : 0;
    const rowGap = fontSize * CAP_ROW_GAP_RATIO;
    document.documentElement.style.setProperty('--cap-line-h', `${lh}px`);
    document.documentElement.style.setProperty('--cap-viewport-h', `${(lh + secondaryHeight) * maxLines + rowGap * Math.max(0, maxLines - 1)}px`);
  }

  function measureFontSizePx() {
    if (!flowEl) return 28;
    const target = flowEl.querySelector('.line-translated') || flowEl;
    const cs = getComputedStyle(target);
    return parseFloat(cs.fontSize) || 16;
  }

  function measureLineHeightPx() {
    return measureFontSizePx() * CAP_LINE_HEIGHT_RATIO;
  }

  function computeViewportHeight() {
    const fontSize = measureFontSizePx();
    const hasOriginal = captionTrack.snapshot().rows.some(row => row.secondary);
    const rowHeight = measureLineHeightPx() + (hasOriginal ? fontSize * CAP_SECONDARY_HEIGHT_RATIO : 0);
    return rowHeight * maxLines + fontSize * CAP_ROW_GAP_RATIO * Math.max(0, maxLines - 1);
  }

  function computeLineUnits() {
    if (!flowEl) return 42;
    const fontSize = measureFontSizePx();
    const width = flowEl.clientWidth || linesEl?.clientWidth || 0;
    if (!width || !fontSize) return 42;
    return Math.max(10, (width / fontSize) * CAP_LINE_WIDTH_FACTOR);
  }

  function computeRollStep() {
    return measureLineHeightPx() + measureFontSizePx() * CAP_ROW_GAP_RATIO;
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function resetCaptionRoll() {
    if (captionRollFrame) {
      cancelAnimationFrame(captionRollFrame);
      captionRollFrame = 0;
    }
    if (captionRollTimer) {
      clearTimeout(captionRollTimer);
      captionRollTimer = 0;
    }
    if (flowEl) {
      flowEl.style.transition = '';
      flowEl.style.transform = '';
    }
  }

  function animateCaptionRoll(previousHeight, hadPreviousText, preferredDistance) {
    resetCaptionRoll();
    if (!flowEl || prefersReducedMotion()) return;

    const nextHeight = flowEl.scrollHeight;
    const delta = nextHeight - (Number.isFinite(previousHeight) ? previousHeight : 0);
    const measuredDistance = delta > 1 ? Math.min(computeViewportHeight(), delta) : 0;
    const distance = Number.isFinite(preferredDistance) && preferredDistance > 1
      ? preferredDistance
      : measuredDistance;
    if (!hadPreviousText || distance <= 1) return;
    if (!Number.isFinite(distance) || distance <= 1) return;

    flowEl.style.transition = 'none';
    flowEl.style.transform = `translate3d(0, ${distance}px, 0)`;
    flowEl.getBoundingClientRect();

    captionRollFrame = requestAnimationFrame(() => {
      captionRollFrame = 0;
      if (!flowEl) return;
      flowEl.style.transition = 'transform 260ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1))';
      flowEl.style.transform = 'translate3d(0, 0, 0)';
      captionRollTimer = setTimeout(() => {
        captionRollTimer = 0;
        if (flowEl) flowEl.style.transition = '';
      }, 280);
    });
  }

  function renderCaption(model = captionTrack.snapshot()) {
    if (!flowEl) return { changed: false, rowAdvanced: false, rollDistance: 0 };
    const sourceRows = model.rows.length
      ? model.rows
      : (model.primaryText || model.secondaryText ? [{ id: 'single', primary: model.primaryText, secondary: model.secondaryText, live: true }] : []);
    const shaped = window.CaptionTrack.shapeRows(sourceRows, {
      maxRows: maxLines + CAP_ROLL_BUFFER_ROWS,
      maxUnits: computeLineUnits(),
    });
    const rows = shaped.rows;
    const signature = rows.map(row => `${row.id}:${row.live ? '1' : '0'}:${row.secondary}\n${row.primary}`).join('\n---\n');
    const previousTailKey = flowEl.dataset.captionTailKey || '';
    const previousTotalRows = parseInt(flowEl.dataset.captionTotalRows || '0', 10) || 0;
    const rowAdvanced = !!previousTailKey && shaped.tailKey !== previousTailKey && shaped.totalRows > previousTotalRows;
    if (flowEl.dataset.captionSignature === signature) {
      flowEl.dataset.captionTailKey = shaped.tailKey;
      flowEl.dataset.captionTotalRows = String(shaped.totalRows);
      return { changed: false, rowAdvanced, rollDistance: computeRollStep() };
    }
    flowEl.dataset.captionSignature = signature;
    flowEl.dataset.captionTailKey = shaped.tailKey;
    flowEl.dataset.captionTotalRows = String(shaped.totalRows);

    const nodes = rows.map(row => {
      const rowEl = document.createElement('div');
      rowEl.className = row.live ? 'caption-row live' : 'caption-row';
      if (row.secondary) {
        const original = document.createElement('div');
        original.className = 'line-original';
        original.textContent = row.secondary;
        rowEl.appendChild(original);
      }
      if (row.primary) {
        const translated = document.createElement('div');
        translated.className = 'line-translated';
        translated.textContent = row.primary;
        rowEl.appendChild(translated);
      }
      return rowEl;
    });
    flowEl.replaceChildren(...nodes);
    applyViewportSize();
    return { changed: true, rowAdvanced, rollDistance: computeRollStep() };
  }

  function show(text, isFinal, originalText, segment, options = {}) {
    if (!text) {
      if (!isFinal) {
        renderCaption(captionTrack.applyCaption({ text: '', isFinal: false }));
      }
      return;
    }

    const source = options.source || 'live';
    if (isFinal && !segment?.id) return;

    if (isFinal) {
      if (isRenderableSegment(segment)) updateCachedSegment(segment);
    }

    const rollFromHeight = flowEl ? flowEl.scrollHeight : 0;
    const hadRollText = captionTrack.snapshot().hasText;

    const model = captionTrack.applyCaption({ text, isFinal, original: originalText, segment, source });
    if (!model.changed) return;
    capturing = true;
    placeholder.classList.remove('show');
    linesEl.style.display = '';
    linesEl.style.opacity = '1';
    const rendered = renderCaption(model);
    const rollDistance = rendered.rowAdvanced ? rendered.rollDistance : undefined;
    const shouldRoll = model.animate || (model.reason === 'partial' && rendered.rowAdvanced);
    if (shouldRoll && rendered.changed) animateCaptionRoll(rollFromHeight, hadRollText, rollDistance);

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
    resetCaptionRoll();
    linesEl.style.opacity = '0';
    setTimeout(clearTrack, 280);
    capturing = false;
  }

  function clearTrack() {
    resetCaptionRoll();
    captionTrack.clear();
    if (flowEl) {
      flowEl.dataset.captionSignature = '';
      flowEl.replaceChildren();
    }
    if (linesEl) {
      linesEl.style.opacity = '1';
      linesEl.style.display = 'none';
    }
    placeholder.classList.add('show');
  }

  function applySegmentUpdate(segment) {
    if (!segment?.id || !segment.text) return;
    renderCaption(captionTrack.applySegmentUpdate(segment));
    updateCachedSegment(segment);
  }

  function updateCachedSegment(segment) {
    if (!isRenderableSegment(segment)) return;
    const idx = captionHistory.findIndex(entry => entry.id === segment.id);
    if (idx >= 0) captionHistory[idx] = { ...captionHistory[idx], ...segment };
    else captionHistory.push(segment);
    if (captionHistory.length > CAPTION_HISTORY_SIZE) captionHistory.shift();
    if (historyVisible) renderHistory();
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
      if (!isRenderableSegment(entry)) continue;
      appendHistoryEntry(entry);
    }
  }

  function appendHistoryEntry(entry) {
    if (!historyScroll) return;

    const el = document.createElement('div');
    el.className = 'history-entry';

    const time = document.createElement('span');
    time.className = 'history-time';
    const d = new Date(entry.startTs);
    time.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'history-content';

    if (entry.original) {
      const origEl = document.createElement('div');
      origEl.className = 'history-original';
      origEl.textContent = entry.original;
      contentEl.appendChild(origEl);
    }

    const textEl = document.createElement('div');
    textEl.className = 'history-text';
    textEl.textContent = entry.text;
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

  function isRenderableSegment(entry) {
    return !!entry?.id && !!entry.text && Number.isFinite(entry.startTs) && Number.isFinite(entry.endTs) && entry.endTs > entry.startTs;
  }

  // ==================== LIFECYCLE ====================
  function notifyReady() {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'PIP_READY' }, window.location.origin);
      }
    } catch (e) {}
  }

  function notifyClosed() {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'PIP_CLOSED' }, window.location.origin);
      }
    } catch (e) {}
  }
})();
