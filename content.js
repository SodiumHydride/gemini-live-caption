// content.js — Gemini Live Caption Subtitle Overlay
// True LRC scrolling: track slides up one line-height per new subtitle.

(function () {
  'use strict';

  const HOST_ID = 'gemini-live-caption-host';
  const STORE_KEY = 'captionLayout';
  const MAX_LINES = 3;

  let shadow, wrap, linesEl, track, placeholder, pipBtn, statusIndicator;
  let historyPanel, historyScroll, historyOverlay;
  let historyVisible = false;
  let fadeTimer = null, capturing = false;
  let layout = { x: null, y: null, w: 560 };
  let lineCount = 0;
  let initGeneration = 0;  // Prevents stale async callbacks from building on wrong shadow
  let listenerController = null;  // AbortController for document-level listeners

  // ==================== INIT ====================
  const FONT_MAP = { small: '2.4vh', medium: '3.2vh', large: '4vh' };

  function applySettings(s) {
    if (!shadow) return;
    const host = shadow.host;
    if (s.fontSize) host.style.setProperty('--cap-font-size', FONT_MAP[s.fontSize] ?? FONT_MAP.medium);
    if (s.bgOpacity !== undefined) host.style.setProperty('--cap-bg', `rgba(0,0,0,${s.bgOpacity})`);
  }

  function init() {
    // Clean up any existing overlay (idempotent — safe for re-injection)
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    // Abort previous document-level listeners to prevent accumulation
    if (listenerController) {
      listenerController.abort();
    }
    listenerController = new AbortController();
    const signal = listenerController.signal;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });
    const gen = ++initGeneration;
    chrome.storage.local.get([STORE_KEY, 'fontSize', 'bgOpacity'], r => {
      if (gen !== initGeneration) return;  // Stale callback, ignore
      if (r[STORE_KEY]) Object.assign(layout, r[STORE_KEY]);
      build();
      applySettings(r);
    });

    // ESC key to close history panel (using AbortController for cleanup)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && historyVisible) {
        hideHistory();
      }
    }, { signal });
  }

  function build() {
    const style = document.createElement('style');
    style.textContent = css();
    shadow.appendChild(style);

    wrap = document.createElement('div');
    wrap.className = 'w';

    // Drag handle
    const drag = document.createElement('div');
    drag.className = 'drag';
    const svg = ns('svg', { width: 20, height: 6, viewBox: '0 0 20 6' });
    ['0.5', '4'].forEach(y =>
      svg.appendChild(ns('rect', { y, width: 20, height: 1.5, rx: 0.75, fill: 'rgba(255,255,255,0.4)' }))
    );
    drag.appendChild(svg);

    // PiP button — standalone floating element (not inside drag bar)
    // Visible during capture, positioned at top-right of subtitle overlay area
    pipBtn = document.createElement('button');
    pipBtn.className = 'pip-btn';
    pipBtn.title = 'Picture-in-Picture';
    const pipSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    pipSvg.setAttribute('width', '16');
    pipSvg.setAttribute('height', '16');
    pipSvg.setAttribute('viewBox', '0 0 24 24');
    pipSvg.setAttribute('fill', 'none');
    pipSvg.setAttribute('stroke', 'currentColor');
    pipSvg.setAttribute('stroke-width', '2');
    pipSvg.setAttribute('stroke-linecap', 'round');
    pipSvg.setAttribute('stroke-linejoin', 'round');
    const rect1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect1.setAttribute('x', '2');
    rect1.setAttribute('y', '3');
    rect1.setAttribute('width', '20');
    rect1.setAttribute('height', '14');
    rect1.setAttribute('rx', '2');
    pipSvg.appendChild(rect1);
    const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect2.setAttribute('x', '11');
    rect2.setAttribute('y', '9');
    rect2.setAttribute('width', '9');
    rect2.setAttribute('height', '6');
    rect2.setAttribute('rx', '1');
    rect2.setAttribute('fill', 'currentColor');
    pipSvg.appendChild(rect2);
    pipBtn.appendChild(pipSvg);
    pipBtn.addEventListener('click', e => {
      e.stopPropagation();
      togglePiP(pipBtn);
    });
    if (!isPiPSupported()) {
      pipBtn.style.display = 'none';
    }

    // Visible window — fixed height set by JS after first line measurement
    linesEl = document.createElement('div');
    linesEl.className = 'lines';

    // Sliding track inside the window
    track = document.createElement('div');
    track.className = 'track';
    linesEl.appendChild(track);

    // Placeholder when idle
    placeholder = document.createElement('div');
    placeholder.className = 'ph';
    placeholder.textContent = 'Gemini Live Caption';

    // Status indicator — small dot + text showing connection state
    statusIndicator = document.createElement('div');
    statusIndicator.className = 'status';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const txt = document.createElement('span');
    txt.className = 'txt';
    statusIndicator.appendChild(dot);
    statusIndicator.appendChild(txt);

    // Resize handle
    const resize = document.createElement('div');
    resize.className = 'rsz';

    wrap.appendChild(drag);
    wrap.appendChild(linesEl);
    wrap.appendChild(placeholder);
    wrap.appendChild(statusIndicator);
    wrap.appendChild(resize);
    wrap.appendChild(pipBtn);

    // Transcript history panel (hidden by default, shown on double-click)
    historyPanel = document.createElement('div');
    historyPanel.className = 'history-panel';
    const historyHeader = document.createElement('div');
    historyHeader.className = 'history-header';
    const historyTitle = document.createElement('span');
    historyTitle.className = 'history-title';
    historyTitle.textContent = 'Transcript';
    const historyClose = document.createElement('button');
    historyClose.className = 'history-close';
    historyClose.textContent = '×';
    historyClose.addEventListener('click', (e) => {
      e.stopPropagation();
      hideHistory();
    });
    historyHeader.appendChild(historyTitle);
    historyHeader.appendChild(historyClose);
    historyScroll = document.createElement('div');
    historyScroll.className = 'history-scroll';
    historyPanel.appendChild(historyHeader);
    historyPanel.appendChild(historyScroll);
    wrap.appendChild(historyPanel);

    // Double-click to toggle history panel
    linesEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHistory();
    });

    // Click outside history panel to close
    historyOverlay = document.createElement('div');
    historyOverlay.className = 'history-overlay';
    historyOverlay.addEventListener('click', () => hideHistory());
    wrap.appendChild(historyOverlay);

    shadow.appendChild(wrap);

    applyPos();
    setupDrag(drag);
    setupResize(resize);
  }

  function ns(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function css() {
    return `
      :host {
        all: initial !important;
        --cap-font-size: 3.2vh;
        --cap-bg: rgba(0,0,0,0.78);
        --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
      }

      .w {
        position: fixed; pointer-events: auto; z-index: 2147483647;
        opacity: 0; transform: translateY(10px);
        transition: opacity .35s cubic-bezier(.16,1,.3,1), transform .35s cubic-bezier(.16,1,.3,1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC',
                     'PingFang SC', 'Microsoft YaHei', sans-serif;
        min-width: 200px; max-width: 90vw;
        border-radius: 12px; overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.05);
      }
      .w.vis { opacity: 1; transform: translateY(0); pointer-events: auto; }

      .drag {
        display: flex; align-items: center; justify-content: center;
        height: 16px; cursor: grab; opacity: 0;
        transition: opacity .2s; flex-shrink: 0;
        background: var(--cap-bg);
        position: relative;
      }
      .w:hover .drag, .w.dragging .drag { opacity: 1; }
      .w.dragging .drag { cursor: grabbing; }

      .pip-btn {
        position: absolute; bottom: 4px; right: 26px; z-index: 10;
        width: 28px; height: 28px; padding: 0;
        background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1);
        cursor: pointer; border-radius: 6px;
        color: rgba(255,255,255,0.5);
        display: none; align-items: center; justify-content: center;
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        transition: color .2s, background .2s, transform .15s;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        pointer-events: auto;
      }
      .pip-btn.vis { display: flex; }
      .pip-btn:hover { color: #fff; background: rgba(30,30,50,0.8); transform: scale(1.1); }
      .pip-btn:active { transform: scale(0.92); }
      .pip-btn.active { color: #4fc3f7; border-color: rgba(79,195,247,0.3); }
      .pip-btn.active:hover { color: #81d4fa; }

      .lines {
        overflow: hidden;
        background: var(--cap-bg);
        width: 100%;
      }

      .track {
        transition: transform .35s cubic-bezier(.16,1,.3,1);
        width: 100%;
      }

      .line {
        color: var(--cap-text, #fff);
        font-size: var(--cap-font-size); font-weight: 500; line-height: 1.45;
        padding: .3em 1em;
        text-align: center;
        text-shadow: 0 1px 4px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.4);
        word-break: break-word; white-space: pre-wrap;
        transition: opacity .25s ease-out, padding .25s ease-out, max-height .25s ease-out;
        max-height: 10em;
        overflow: hidden;
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
      }

      .line-original {
        font-size: calc(var(--cap-font-size) * 0.85);
        color: rgba(255, 255, 255, 0.6);
        margin-bottom: 2px;
      }

      .line-translated {
        color: var(--cap-text, #fff);
      }

      .ph {
        color: rgba(255,255,255,.3);
        font-size: calc(var(--cap-font-size) * 0.875); font-weight: 500; line-height: 1.45;
        padding: .45em 1em;
        text-align: center;
        background: var(--cap-bg);
        display: none;
      }
      .ph.show { display: block; }

      .status {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        padding: 4px 10px; font-size: 11px; font-weight: 500;
        background: var(--cap-bg); color: rgba(255,255,255,.5);
        opacity: 0; max-height: 0; overflow: hidden;
        transition: opacity .3s ease, max-height .3s ease, padding .3s ease;
      }
      .status.show { opacity: 1; max-height: 30px; padding: 6px 10px; }
      .status .dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #888; flex-shrink: 0;
        transition: background .3s;
      }
      .status .dot.green { background: #4caf50; }
      .status .dot.orange { background: #ff9800; }
      .status .dot.red { background: #f44336; }

      .rsz {
        position: absolute; bottom: 0; right: 0;
        width: 22px; height: 22px; cursor: nwse-resize;
        opacity: 0; transition: opacity .2s; pointer-events: auto;
      }
      .rsz::before {
        content: ''; position: absolute; bottom: 4px; right: 4px;
        width: 10px; height: 10px;
        border-right: 2px solid rgba(255,255,255,.3);
        border-bottom: 2px solid rgba(255,255,255,.3);
        border-radius: 0 0 3px 0;
      }
      .w:hover .rsz { opacity: 1; }

      /* History Panel */
      .history-overlay {
        display: none;
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.3);
        z-index: 5;
        pointer-events: auto;
      }
      .history-overlay.visible {
        display: block;
      }

      .history-panel {
        display: none;
        position: absolute;
        inset: 0;
        z-index: 10;
        background: rgba(15, 15, 25, 0.95);
        backdrop-filter: blur(20px) saturate(1.2);
        -webkit-backdrop-filter: blur(20px) saturate(1.2);
        border-radius: 12px;
        overflow: hidden;
        pointer-events: auto;
        flex-direction: column;
        animation: historySlideIn 0.25s var(--ease-out-expo);
      }
      .history-panel.visible {
        display: flex;
      }

      @keyframes historySlideIn {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .history-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
      }

      .history-title {
        font-size: 13px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.9);
        letter-spacing: 0.02em;
      }

      .history-close {
        width: 24px;
        height: 24px;
        padding: 0;
        background: rgba(255, 255, 255, 0.08);
        border: none;
        border-radius: 6px;
        color: rgba(255, 255, 255, 0.6);
        font-size: 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }
      .history-close:hover {
        background: rgba(255, 255, 255, 0.15);
        color: rgba(255, 255, 255, 0.9);
      }

      .history-scroll {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
      }
      .history-scroll::-webkit-scrollbar {
        width: 6px;
      }
      .history-scroll::-webkit-scrollbar-track {
        background: transparent;
      }
      .history-scroll::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      .history-scroll::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      .history-entry {
        display: flex;
        gap: 10px;
        padding: 6px 14px;
        transition: background 0.15s ease;
      }
      .history-entry:hover {
        background: rgba(255, 255, 255, 0.04);
      }

      .history-time {
        flex-shrink: 0;
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.35);
        font-variant-numeric: tabular-nums;
        min-width: 55px;
      }

      .history-content {
        flex: 1;
        min-width: 0;
      }

      .history-original {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
        line-height: 1.4;
        margin-bottom: 2px;
      }

      .history-text {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.85);
        line-height: 1.5;
        word-break: break-word;
      }

      /* Hint for double-click */
      .lines {
        cursor: pointer;
      }
    `;
  }

  // ==================== ADD LINE ====================
  let viewportLocked = false;

  function addLine(text, originalText) {
    const el = document.createElement('div');
    el.className = 'line';

    if (originalText) {
      // Bilingual mode: original + translated
      const origEl = document.createElement('div');
      origEl.className = 'line-original';
      origEl.textContent = originalText;
      const transEl = document.createElement('div');
      transEl.className = 'line-translated';
      transEl.textContent = text;
      el.appendChild(origEl);
      el.appendChild(transEl);
    } else {
      el.textContent = text;
    }

    track.appendChild(el);
    lineCount++;

    // Lock viewport height on first line — prevents container flash.
    // Wait for browser layout so offsetHeight is accurate.
    if (!viewportLocked) {
      viewportLocked = true;
      requestAnimationFrame(() => {
        const lineH = el.offsetHeight || parseFloat(getComputedStyle(el).fontSize) * 1.45 || 32;
        linesEl.style.height = (lineH * MAX_LINES) + 'px';
      });
    }

    if (lineCount > MAX_LINES) {
      // Slide track up by one line height
      const lineH = el.offsetHeight;
      track.style.transform = `translateY(-${lineH}px)`;

      // After animation, remove old line and reset track position
      track.addEventListener('transitionend', function handler(event) {
        if (event.propertyName !== 'transform') return;
        track.removeEventListener('transitionend', handler);
        if (track.firstChild && track.firstChild !== el) {
          track.removeChild(track.firstChild);
        }
        lineCount--;
        track.style.transition = 'none';
        track.style.transform = 'translateY(0)';
        track.offsetHeight; // force reflow
        track.style.transition = '';
      }, { once: true });
    }
  }

  // ==================== SHOW ====================
  let lastFinalized = '';
  let currentPartialEl = null;
  let currentPartialText = '';

  function show(text, isFinal, originalText) {
    if (!text) return;

    if (isFinal) {
      // Dedup: skip if already finalized this exact text
      if (text === lastFinalized) return;

      // If this finalized text matches what's showing as partial → just mark finalized
      if (currentPartialEl && currentPartialEl.parentNode === track && text === currentPartialText) {
        lastFinalized = text;
        currentPartialEl = null;
        currentPartialText = '';
        return;
      }

      // Different text → previous partial becomes finalized, add new line
      lastFinalized = text;
      currentPartialEl = null;
      currentPartialText = '';
      addLine(text, originalText);
    } else {
      // Partial: update current line in-place (live preview)
      if (currentPartialEl && currentPartialEl.parentNode === track) {
        // Update translated text
        const transEl = currentPartialEl.querySelector('.line-translated');
        if (transEl) {
          transEl.textContent = text;
        } else {
          currentPartialEl.textContent = text;
        }
        // Update original text if available
        if (originalText) {
          let origEl = currentPartialEl.querySelector('.line-original');
          if (!origEl) {
            origEl = document.createElement('div');
            origEl.className = 'line-original';
            currentPartialEl.insertBefore(origEl, currentPartialEl.firstChild);
          }
          origEl.textContent = originalText;
        }
        currentPartialText = text;
      } else {
        addLine(text, originalText);
        currentPartialEl = track.lastChild;
        currentPartialText = text;
      }
    }

    // Show container, hide placeholder
    capturing = true;
    wrap.classList.add('vis');
    placeholder.classList.remove('show');
    linesEl.style.display = '';

    // Reset fade timer
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (capturing) {
        capturing = false;
        // Fade out all lines
        for (const child of Array.from(track.children)) {
          child.style.opacity = '0';
          child.style.maxHeight = '0';
          child.style.padding = '0 1em';
        }
        setTimeout(() => {
          if (!capturing) {
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
        }, 300);
      }
    }, 12000);
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
    historyOverlay.classList.add('visible');

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
    historyOverlay.classList.remove('visible');

    // Restart fade timer after closing history panel
    if (capturing) {
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => {
        if (capturing) {
          capturing = false;
          for (const child of Array.from(track.children)) {
            child.style.opacity = '0';
            child.style.maxHeight = '0';
            child.style.padding = '0 1em';
          }
          setTimeout(() => {
            if (!capturing) {
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
          }, 300);
        }
      }, 12000);
    }
  }

  function renderHistory() {
    if (!historyScroll) return;

    // Clear existing content
    while (historyScroll.firstChild) {
      historyScroll.removeChild(historyScroll.firstChild);
    }

    // Render all history entries
    const entries = getCaptionHistory();
    for (const entry of entries) {
      const el = document.createElement('div');
      el.className = 'history-entry';

      // Timestamp
      const time = document.createElement('span');
      time.className = 'history-time';
      const d = new Date(entry.ts);
      time.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

      // Content (original + translated)
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
    }
  }

  function appendToHistory(text, ts, originalText) {
    if (!historyScroll || !historyVisible) return;

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

  // ==================== CLEAR ====================
  function clearCaptions() {
    clearTimeout(fadeTimer);
    for (const child of Array.from(track.children)) {
      child.style.opacity = '0';
      child.style.maxHeight = '0';
      child.style.padding = '0 1em';
    }
    setTimeout(() => {
      while (track.firstChild) track.removeChild(track.firstChild);
      lineCount = 0;
      viewportLocked = false;
      linesEl.style.height = '';
      track.style.transform = 'translateY(0)';
      linesEl.style.display = 'none';
      placeholder.classList.add('show');
    }, 300);
    capturing = false;
    currentPartialEl = null;
    currentPartialText = '';
  }

  // ==================== STATUS INDICATOR ====================
  let statusHideTimer = null;

  function updateStatus(status, message) {
    if (!statusIndicator) return;

    const dot = statusIndicator.querySelector('.dot');
    const txt = statusIndicator.querySelector('.txt');
    if (!dot || !txt) return;

    // Clear previous hide timer
    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = null;
    }

    // Set color and text based on status
    dot.className = 'dot';
    switch (status) {
      case 'capturing':
        dot.classList.add('green');
        txt.textContent = message || 'Connected';
        showStatusTemporarily(3000); // Auto-hide after 3s
        break;
      case 'reconnecting':
        dot.classList.add('orange');
        txt.textContent = message || 'Reconnecting...';
        showStatus(); // Stay visible
        break;
      case 'error':
        dot.classList.add('red');
        txt.textContent = message || 'Error';
        showStatus(); // Stay visible
        break;
      case 'idle':
      default:
        txt.textContent = message || '';
        hideStatus();
        break;
    }
  }

  function showStatus() {
    if (!statusIndicator) return;
    // Show the main container too if hidden
    if (!wrap.classList.contains('vis')) {
      wrap.classList.add('vis');
      placeholder.classList.remove('show');
    }
    statusIndicator.classList.add('show');
  }

  function showStatusTemporarily(duration) {
    showStatus();
    statusHideTimer = setTimeout(() => {
      hideStatus();
    }, duration);
  }

  function hideStatus() {
    if (!statusIndicator) return;
    statusIndicator.classList.remove('show');
  }

  // ==================== LAYOUT ====================
  const POSITION_PRESETS = {
    'bottom-center': { x: null, y: null },  // null = auto-center
    'top-center': { x: null, y: 20, top: true },
    'bottom-left': { x: 20, y: null },
    'bottom-right': { x: null, y: null, right: 20 },
    'top-left': { x: 20, y: 20, top: true },
    'top-right': { x: null, y: 20, top: true, right: 20 },
  };

  function applyPos() {
    if (!wrap) return;
    wrap.style.width = layout.w + 'px';

    // Apply preset or custom position
    if (layout.preset && POSITION_PRESETS[layout.preset]) {
      const p = POSITION_PRESETS[layout.preset];
      if (p.x != null) {
        wrap.style.left = p.x + 'px';
        wrap.style.right = 'auto';
        wrap.style.transform = 'none';
      } else if (p.right != null) {
        wrap.style.right = p.right + 'px';
        wrap.style.left = 'auto';
        wrap.style.transform = 'none';
      } else {
        wrap.style.left = '50%';
        wrap.style.right = 'auto';
        wrap.style.transform = 'translateX(-50%)';
      }
      if (p.top) {
        wrap.style.top = (p.y || 20) + 'px';
        wrap.style.bottom = 'auto';
      } else {
        wrap.style.bottom = (p.y || 40) + 'px';
        wrap.style.top = 'auto';
      }
    } else {
      // Custom position (dragged)
      if (layout.x != null) {
        wrap.style.left = layout.x + 'px';
        wrap.style.right = 'auto';
        wrap.style.transform = 'none';
      } else {
        wrap.style.left = '50%';
        wrap.style.right = 'auto';
        wrap.style.transform = 'translateX(-50%)';
      }
      if (layout.y != null) {
        wrap.style.top = layout.y + 'px';
        wrap.style.bottom = 'auto';
      } else {
        wrap.style.bottom = '40px';
        wrap.style.top = 'auto';
      }
    }
  }

  function setPositionPreset(preset) {
    layout.preset = preset;
    layout.x = null;
    layout.y = null;
    applyPos();
    save();
  }

  function save() { chrome.storage.local.set({ [STORE_KEY]: layout }); }

  // ==================== DRAG ====================
  function setupDrag(handle) {
    let sx, sy, sl, st;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      wrap.classList.add('dragging');
      const r = wrap.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      wrap.style.transition = 'none';
      wrap.style.transform = 'none';
      wrap.style.left = sl + 'px';
      wrap.style.top = st + 'px';
      wrap.style.bottom = 'auto';
      handle.setPointerCapture(e.pointerId);
      const mv = ev => {
        wrap.style.left = Math.max(0, Math.min(sl + ev.clientX - sx, innerWidth - r.width)) + 'px';
        wrap.style.top = Math.max(0, Math.min(st + ev.clientY - sy, innerHeight - r.height)) + 'px';
      };
      const up = ev => {
        wrap.classList.remove('dragging');
        wrap.style.transition = '';
        handle.releasePointerCapture(ev.pointerId);
        layout.x = Math.round(wrap.getBoundingClientRect().left);
        layout.y = Math.round(wrap.getBoundingClientRect().top);
        save();
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
    });
  }

  // ==================== RESIZE ====================
  function setupResize(handle) {
    let sx, sw;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      sx = e.clientX; sw = wrap.getBoundingClientRect().width;
      wrap.style.transition = 'none';
      handle.setPointerCapture(e.pointerId);
      const mv = ev => {
        const w = Math.max(200, Math.min(sw + ev.clientX - sx, innerWidth * .95));
        wrap.style.width = w + 'px';
        layout.w = Math.round(w);
      };
      const up = ev => {
        wrap.style.transition = '';
        handle.releasePointerCapture(ev.pointerId);
        save();
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
    });
  }

  // ==================== DOCUMENT PIP ====================
  // PiP window is a plain browsing context (inherits host page origin).
  // It cannot access chrome.* APIs. content.js acts as the bridge:
  //   service-worker → content.js → pipWindow (via postMessage)
  //   pipWindow → content.js → service-worker (via postMessage relay)

  let pipWindow = null;

  function isPiPSupported() {
    return !!window.documentPictureInPicture;
  }

  async function togglePiP(btn) {
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
      return;
    }

    if (!isPiPSupported()) {
      console.warn('[Gemini Live Caption] Document PiP not supported');
      return;
    }

    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 800,
        height: 360,
      });

      // Fetch pip.html and replace relative URLs with absolute extension URLs.
      // PiP window inherits host page origin, so relative paths break.
      const response = await fetch(chrome.runtime.getURL('pip.html'));
      let html = await response.text();
      html = html
        .replace('href="pip.css"', `href="${chrome.runtime.getURL('pip.css')}"`)
        .replace('src="pip.js"', `src="${chrome.runtime.getURL('pip.js')}"`);
      pipWindow.document.write(html);
      pipWindow.document.close();

      // Notify service worker
      chrome.runtime.sendMessage({ type: 'PIP_OPENED' }).catch(() => {});
      btn.classList.add('active');

      // Listen for messages FROM PiP window (sent via window.opener.postMessage).
      // Must listen on `window` (the host page), not on `pipWindow`.
      function onPiPMessage(event) {
        if (!event.data || !event.data.type) return;
        if (event.data.type === 'PIP_CLOSED') {
          chrome.runtime.sendMessage({ type: 'PIP_CLOSED' }).catch(() => {});
          btn.classList.remove('active');
          pipWindow = null;
          window.removeEventListener('message', onPiPMessage);
        } else if (event.data.type === 'PIP_SETTINGS_CHANGED') {
          // PiP window changed a setting — persist it
          const { key, value } = event.data;
          if (key && value !== undefined) {
            chrome.storage.local.set({ [key]: value }).catch(() => {});
          }
        }
      }
      window.addEventListener('message', onPiPMessage);

      // PiP window closed by user (browser chrome close button, etc.)
      pipWindow.addEventListener('pagehide', () => {
        chrome.runtime.sendMessage({ type: 'PIP_CLOSED' }).catch(() => {});
        btn.classList.remove('active');
        pipWindow = null;
        window.removeEventListener('message', onPiPMessage);
      });

      // Replay recent captions into PiP window so it's not empty on open
      replayBufferToPiP();
    } catch (err) {
      console.warn('[Gemini Live Caption] PiP failed:', err);
      pipWindow = null;
    }
  }

  // Caption ring buffer for PiP catch-up and history export
  const CAPTION_HISTORY_SIZE = 500;  // Keep last 500 finalized captions
  const captionHistory = [];
  let sessionStartTime = null;

  // PiP buffer is a subset of history (most recent)
  const PIP_BUFFER_SIZE = 20;

  function bufferCaption(text, isFinal, originalText) {
    if (!isFinal) return; // Only buffer finalized captions
    if (!sessionStartTime) sessionStartTime = Date.now();
    const ts = Date.now();
    captionHistory.push({ text, ts, original: originalText || '' });
    if (captionHistory.length > CAPTION_HISTORY_SIZE) captionHistory.shift();

    // If history panel is visible, append new entry
    if (historyVisible) {
      appendToHistory(text, ts, originalText);
    }
  }

  function getCaptionHistory() {
    return captionHistory.slice();
  }

  function formatSRT(entries) {
    if (!entries.length) return '';
    const startTime = entries[0].ts;
    return entries.map((entry, i) => {
      const start = entry.ts - startTime;
      const end = (i < entries.length - 1 ? entries[i + 1].ts : entry.ts + 2000) - startTime;
      const formatTime = (ms) => {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const ms2 = ms % 1000;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms2).padStart(3, '0')}`;
      };
      return `${i + 1}\n${formatTime(start)} --> ${formatTime(end)}\n${entry.text}\n`;
    }).join('\n');
  }

  function replayBufferToPiP() {
    if (!pipWindow || pipWindow.closed) return;
    const recent = captionHistory.slice(-PIP_BUFFER_SIZE);
    for (const entry of recent) {
      postToPiP({ type: 'CAPTION_UPDATE', text: entry.text, isFinal: true });
    }
  }

  function postToPiP(msg) {
    if (!pipWindow || pipWindow.closed) return;
    try {
      pipWindow.postMessage(msg, window.location.origin);
    } catch (e) {
      // Window may have navigated or closed
    }
  }

  // Relay settings changes to PiP window
  function relaySettingsToPiP(s) {
    postToPiP({ type: 'SETTINGS_UPDATE', ...s });
  }

  // ==================== MESSAGES ====================
  let contextInvalidated = false;

  function messageHandler(msg) {
    try {
      if (msg.type === 'CAPTION_UPDATE') {
        if (contextInvalidated) {
          // Extension was reloaded — reinitialize the overlay from scratch.
          // The new service worker injected us fresh; re-init DOM and layout.
          console.log('[Gemini Live Caption] Reinitializing after context invalidation');
          contextInvalidated = false;
          try {
            const oldHost = document.getElementById(HOST_ID);
            if (oldHost) oldHost.remove();
            shadow = wrap = linesEl = track = placeholder = statusIndicator = null;
            viewportLocked = false;
            lineCount = 0;
            currentPartialEl = null;
            currentPartialText = '';
            lastFinalized = '';
            init();
          } catch (reinitErr) {
            console.warn('[Gemini Live Caption] Reinit failed:', reinitErr);
          }
        }
        show(msg.text, msg.isFinal, msg.original);
        // Show PiP button when captions are flowing
        if (pipBtn) pipBtn.classList.add('vis');
        // Relay to PiP window and buffer for catch-up
        bufferCaption(msg.text, msg.isFinal, msg.original);
        postToPiP({ type: 'CAPTION_UPDATE', text: msg.text, isFinal: msg.isFinal, original: msg.original });
      } else if (msg.type === 'CLEAR_CAPTIONS') {
        clearCaptions();
        postToPiP({ type: 'CLEAR_CAPTIONS' });
        // Hide PiP button when capture stops
        if (pipBtn) pipBtn.classList.remove('vis');
        updateStatus('idle', '');
      } else if (msg.type === 'STATUS_UPDATE') {
        updateStatus(msg.status, msg.message);
      } else if (msg.type === 'SET_POSITION') {
        setPositionPreset(msg.preset);
      } else if (msg.type === 'SET_TEXT_COLOR') {
        if (shadow && shadow.host) {
          shadow.host.style.setProperty('--cap-text', msg.color);
        }
      } else if (msg.type === 'EXPORT_CAPTIONS') {
        const history = getCaptionHistory();
        const srt = formatSRT(history);
        return { captions: history, srt };
      }
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.log('[Gemini Live Caption] Extension context invalidated');
        contextInvalidated = true;
        // Do NOT remove the listener — the new service worker's messages
        // may still route through this handler on some Chrome versions.
        // The next message that arrives will trigger reinit.
      }
    }
  }
  // Listener dedup: remove previous handler if this script was re-injected.
  if (window.__geminiCaptionHandler) {
    chrome.runtime.onMessage.removeListener(window.__geminiCaptionHandler);
  }
  window.__geminiCaptionHandler = messageHandler;
  chrome.runtime.onMessage.addListener(messageHandler);

  // ==================== SETTINGS REAL-TIME SYNC ====================
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const s = {};
    if (changes.fontSize) s.fontSize = changes.fontSize.newValue;
    if (changes.bgOpacity) s.bgOpacity = changes.bgOpacity.newValue;
    if (Object.keys(s).length) {
      applySettings(s);
      relaySettingsToPiP(s);
    }
  });

  // ==================== AUTO-REPAIR ====================
  const obs = new MutationObserver(() => { if (!document.getElementById(HOST_ID)) init(); });
  if (document.documentElement) {
    obs.observe(document.documentElement, { childList: true, subtree: false });
    init();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.documentElement, { childList: true, subtree: false });
      init();
    });
  }
})();
