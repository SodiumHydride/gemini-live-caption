// content.js — Gemini Live Caption Subtitle Overlay
// Fixed N-line viewport, continuous text, bottom-aligned clip (broadcast-style).

(function () {
  'use strict';

  const DEBUG = false;
  const dbg = DEBUG ? (...args) => console.log('[Content]', ...args) : () => {};
  if (!window.CaptionTrack) {
    throw new Error('caption-track.js must be injected before content.js');
  }

  const HOST_ID = 'gemini-live-caption-host';
  const STORE_KEY = 'captionLayout';
  let MAX_LINES = 2; // Fixed visual-line viewport (broadcast-style rolling window)
  let bilingualMode = false;
  const captionTrack = window.CaptionTrack.create({ bilingualMode, maxChars: 720 });

  let shadow, wrap, linesEl, flowEl, placeholder, pipBtn, statusIndicator;
  let historyPanel, historyScroll, historyOverlay;
  let historyVisible = false;
  let fadeTimer = null, capturing = false;
  let captionRollFrame = 0, captionRollTimer = 0;
  let pipActive = false; // When true, suppress overlay display (PiP is showing captions)
  let layout = { x: null, y: null, w: 560 };
  let initGeneration = 0;  // Prevents stale async callbacks from building on wrong shadow
  let listenerController = null;  // AbortController for document-level listeners
  let hostObserver = null;  // MutationObserver watching for host removal
  let suppressObserver = false;  // Guard: skip observer callback during intentional removal

  // Disconnect any leftover observer from a previous script injection (re-injection dedup)
  const _obsKey = Symbol.for('__geminiCaptionObserver');
  if (window[_obsKey]) {
    window[_obsKey].disconnect();
    window[_obsKey] = null;
  }

  // ==================== INIT ====================
  // Sizes lean a touch larger than before: BBC subtitle legibility research
  // targets ~7-8% of video height per line; the old medium (3.2vh) read small.
  const FONT_MAP = { small: '2.8vh', medium: '3.6vh', large: '4.6vh', xlarge: '5.8vh' };

  function applySettings(s) {
    if (!shadow) return;
    const host = shadow.host;
    if (s.fontSize) {
      host.style.setProperty('--cap-font-size', FONT_MAP[s.fontSize] ?? FONT_MAP.medium);
    }
    if (s.bgOpacity !== undefined) host.style.setProperty('--cap-bg', `rgba(0,0,0,${s.bgOpacity})`);
    if (s.overlayMaxLines) MAX_LINES = s.overlayMaxLines;
    if (s.bilingualMode !== undefined) {
      bilingualMode = !!s.bilingualMode;
      captionTrack.configure({ bilingualMode });
      renderCaption();
    }
    if (s.textColor) {
      host.style.setProperty('--cap-text', s.textColor);
    }
    if (s.fontSize || s.overlayMaxLines || s.bilingualMode !== undefined) applyViewportSize();
  }

  function init() {
    resetCaptionRoll();

    // Disconnect previous observer to prevent accumulation
    if (hostObserver) {
      hostObserver.disconnect();
      hostObserver = null;
    }

    // Unregister the previous Shadow DOM from i18n so applyAll() doesn't
    // keep iterating over a detached root.
    if (window.I18N && shadow) {
      try { I18N.unregisterRoot(shadow); } catch (e) {}
    }

    // Clean up any existing overlay (idempotent — safe for re-injection)
    suppressObserver = true;
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    suppressObserver = false;

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
    chrome.storage.local.get([STORE_KEY, 'fontSize', 'bgOpacity', 'overlayMaxLines', 'textColor', 'bilingualMode'], r => {
      if (gen !== initGeneration) return;  // Stale callback, ignore
      if (r[STORE_KEY]) Object.assign(layout, r[STORE_KEY]);
      if (r.overlayMaxLines) MAX_LINES = r.overlayMaxLines;
      build();
      applySettings(r);
      // Wire i18n: register this Shadow DOM so it gets re-translated on UI
      // language change, then resolve current language and apply.
      if (window.I18N) {
        I18N.registerRoot(shadow);
        I18N.init().then(() => I18N.apply(shadow));
      }
      dbg('Init complete, MAX_LINES =', MAX_LINES);
    });

    // ESC key to close history panel (using AbortController for cleanup)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && historyVisible) {
        hideHistory();
      }
    }, { signal });

    // Restart observer to watch for the new host being removed
    startObserver();
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

    // Fixed N-line viewport; caption-track owns text state, this Adapter renders it.
    linesEl = document.createElement('div');
    linesEl.className = 'lines';

    flowEl = document.createElement('div');
    flowEl.className = 'flow';
    linesEl.appendChild(flowEl);

    // Placeholder when idle
    placeholder = document.createElement('div');
    placeholder.className = 'ph';
    placeholder.setAttribute('data-i18n', 'app_name');
    placeholder.textContent = window.I18N ? I18N.t('app_name') : 'Gemini Live Caption';

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
    historyTitle.setAttribute('data-i18n', 'overlay_transcript');
    historyTitle.textContent = window.I18N ? I18N.t('overlay_transcript') : 'Transcript';
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
    applyViewportSize();
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
        background: var(--cap-bg);
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
        box-sizing: border-box;
        height: var(--cap-viewport-h, auto);
        max-height: var(--cap-viewport-h, auto);
        background: var(--cap-bg);
        width: 100%;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        padding: 0 1em;
        opacity: 1;
        transition: opacity .25s ease-out;
      }

      .flow {
        color: var(--cap-text, #fff);
        font-size: var(--cap-font-size);
        font-weight: 600;
        line-height: var(--cap-line-h, 1.4em);
        padding: 0;
        text-align: center;
        letter-spacing: .01em;
        paint-order: stroke fill;
        -webkit-text-stroke: .5px rgba(0,0,0,.45);
        text-shadow: 0 1px 3px rgba(0,0,0,.85), 0 0 10px rgba(0,0,0,.35);
        word-break: keep-all;
        overflow-wrap: break-word;
        white-space: normal;
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
        transform: translate3d(0, 0, 0);
        will-change: transform;
        display: flex;
        flex-direction: column;
        gap: .12em;
      }

      .caption-row {
        display: flex;
        flex-direction: column;
        gap: .05em;
        min-width: 0;
      }

      .line-original {
        color: rgba(255,255,255,.62);
        font-size: .64em;
        font-weight: 500;
        line-height: 1.25;
        text-align: center;
        text-shadow: 0 1px 2px rgba(0,0,0,.75);
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
      }

      .line-translated {
        color: var(--cap-text, #fff);
        font-size: 1em;
        font-weight: 650;
        line-height: var(--cap-line-h, 1.4em);
        overflow: hidden;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
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

      @media (prefers-reduced-motion: reduce) {
        .flow {
          transition: none !important;
          transform: none !important;
        }
      }
    `;
  }

  // ==================== CAPTION VIEWPORT ====================
  // Caption-track owns the subtitle facts. The overlay is a rendering Adapter:
  // it maps track snapshots into safe DOM, sizing, and live row-advance motion.
  const CAP_LINE_HEIGHT_RATIO = 1.36;
  const CAP_SECONDARY_HEIGHT_RATIO = 0.84;
  const CAP_ROW_GAP_RATIO = 0.12;
  const CAP_LINE_WIDTH_FACTOR = 0.88;
  const CAP_ROLL_BUFFER_ROWS = 1;

  function measureFontSizePx() {
    if (!flowEl) return 28;
    const target = flowEl.querySelector('.line-translated') || flowEl;
    const cs = getComputedStyle(target);
    return parseFloat(cs.fontSize) || 16;
  }

  function measureLineHeightPx() {
    return measureFontSizePx() * CAP_LINE_HEIGHT_RATIO;
  }

  function applyViewportSize() {
    if (!shadow?.host || !flowEl) return;
    const fontSize = measureFontSizePx();
    const lh = measureLineHeightPx();
    const model = captionTrack.snapshot();
    const hasOriginal = model.rows.some(row => row.secondary);
    const secondaryHeight = hasOriginal ? fontSize * CAP_SECONDARY_HEIGHT_RATIO : 0;
    const rowGap = fontSize * CAP_ROW_GAP_RATIO;
    shadow.host.style.setProperty('--cap-line-h', `${lh}px`);
    shadow.host.style.setProperty('--cap-viewport-h', `${(lh + secondaryHeight) * MAX_LINES + rowGap * Math.max(0, MAX_LINES - 1)}px`);
  }

  function computeViewportHeight() {
    const fontSize = measureFontSizePx();
    const hasOriginal = captionTrack.snapshot().rows.some(row => row.secondary);
    const rowHeight = measureLineHeightPx() + (hasOriginal ? fontSize * CAP_SECONDARY_HEIGHT_RATIO : 0);
    return rowHeight * MAX_LINES + fontSize * CAP_ROW_GAP_RATIO * Math.max(0, MAX_LINES - 1);
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
      maxRows: MAX_LINES + CAP_ROLL_BUFFER_ROWS,
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
    if (isFinal && !segment?.id) {
      dbg('Final caption ignored: missing segment metadata');
      return;
    }

    const rollFromHeight = flowEl ? flowEl.scrollHeight : 0;
    const hadRollText = captionTrack.snapshot().hasText;

    const model = captionTrack.applyCaption({ text, isFinal, original: originalText, segment, source });
    if (!model.changed) return;
    capturing = true;
    if (!pipActive) wrap.classList.add('vis');
    placeholder.classList.remove('show');
    linesEl.style.display = '';
    linesEl.style.opacity = '1';
    const rendered = renderCaption(model);
    const rollDistance = rendered.rowAdvanced ? rendered.rollDistance : undefined;
    const shouldRoll = model.animate || (model.reason === 'partial' && rendered.rowAdvanced);
    if (shouldRoll && rendered.changed) animateCaptionRoll(rollFromHeight, hadRollText, rollDistance);

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (capturing) fadeOutAndClear();
    }, 12000);
  }

  function fadeOutAndClear() {
    capturing = false;
    linesEl.style.opacity = '0';
    wrap.classList.remove('vis');
    setTimeout(() => {
      if (!capturing) clearTrackState();
    }, 280);
  }

  function clearTrackState() {
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
    postToPiP({ type: 'TRANSCRIPT_SEGMENT_UPDATED', segment });
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

    // Populate from the runtime transcript store; local cache remains a live view cache.
    refreshTranscriptFromStore()
      .then(() => {
        renderHistory();
        requestAnimationFrame(() => {
          historyScroll.scrollTop = historyScroll.scrollHeight;
        });
      })
      .catch(err => {
        dbg('Transcript refresh failed:', err.message);
        renderHistory();
        requestAnimationFrame(() => {
          historyScroll.scrollTop = historyScroll.scrollHeight;
        });
      });

    // Show panel with animation
    historyPanel.classList.add('visible');
    historyOverlay.classList.add('visible');

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
          fadeOutAndClear();
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
      if (!isRenderableSegment(entry)) continue;
      const el = document.createElement('div');
      el.className = 'history-entry';

      // Timestamp
      const time = document.createElement('span');
      time.className = 'history-time';
      const d = new Date(entry.startTs);
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

  // ==================== CLEAR ====================
  function clearCaptions() {
    clearTimeout(fadeTimer);
    resetCaptionRoll();
    fadeOutAndClear();
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
        applyViewportSize();
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
      // Send close request via postMessage first (more reliable for Document PiP).
      // Fallback to direct close if postMessage fails.
      try {
        postToPiP({ type: 'PIP_CLOSE_REQUEST' });
      } catch (e) {}
      try {
        pipWindow.close();
      } catch (e) {}
      pipWindow = null;
      btn.classList.remove('active');
      chrome.runtime.sendMessage({ type: 'PIP_CLOSED' }).catch(() => {});
      // Restore overlay when PiP closes
      pipActive = false;
      if (capturing) wrap.classList.add('vis');
      return;
    }

    if (!isPiPSupported()) {
      dbg('Document PiP not supported');
      return;
    }

    let onPiPMessage = null;
    try {
      const pipSettings = await chrome.storage.local.get(['fontSize', 'pipMaxLines']);
      const pipFontMap = { small: 20, medium: 28, large: 36, xlarge: 44 };
      const pipWidth = Math.max(layout.w || 560, 400);
      const pipFontSize = pipFontMap[pipSettings.fontSize] || pipFontMap.medium;
      const pipLines = [2, 3, 4, 5].includes(pipSettings.pipMaxLines) ? pipSettings.pipMaxLines : 2;
      const pipLineH = pipFontSize * 1.4 + 12; // line-height + padding
      const pipHeight = Math.round(pipLineH * pipLines + 50);
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: pipWidth,
        height: pipHeight,
      });

      // Hide overlay while PiP is open (avoid double display)
      pipActive = true;
      wrap.classList.remove('vis');

      // Listen for messages FROM PiP window (sent via window.opener.postMessage).
      // Must listen on `window` (the host page), not on `pipWindow`.
      // Verify message source to prevent malicious page injection.
      onPiPMessage = async function (event) {
        if (event.source !== pipWindow) return;
        if (!event.data || !event.data.type) return;
        if (event.data.type === 'PIP_READY') {
          await syncSettingsToPiP();
          await replayTranscriptToPiP();
        } else if (event.data.type === 'PIP_CLOSED') {
          chrome.runtime.sendMessage({ type: 'PIP_CLOSED' }).catch(() => {});
          btn.classList.remove('active');
          pipWindow = null;
          window.removeEventListener('message', onPiPMessage);
        } else if (event.data.type === 'PIP_SETTINGS_CHANGED') {
          // PiP window changed a setting — persist it
          const { key, value } = event.data;
          if (['fontSize', 'bgOpacity', 'textColor', 'pipMaxLines'].includes(key) && value !== undefined) {
            chrome.storage.local.set({ [key]: value }).catch(() => {});
          }
        }
      };
      window.addEventListener('message', onPiPMessage);

      // Fetch pip.html and replace relative URLs with absolute extension URLs.
      // PiP window inherits host page origin, so relative paths break.
      const response = await fetch(chrome.runtime.getURL('pip.html'));
      let html = await response.text();
      html = html
        .replace('href="pip.css"', `href="${chrome.runtime.getURL('pip.css')}"`)
        .replace('src="i18n.js"', `src="${chrome.runtime.getURL('i18n.js')}"`)
        .replace('src="caption-track.js"', `src="${chrome.runtime.getURL('caption-track.js')}"`)
        .replace('src="pip.js"', `src="${chrome.runtime.getURL('pip.js')}"`);
      // Standard Document PiP pattern (per Google docs): write extension-controlled HTML
      // into the PiP window. Source is the extension's own pip.html via chrome.runtime.getURL() -
      // no user input is involved.
      pipWindow.document.write(html);
      pipWindow.document.close();

      // Notify service worker
      chrome.runtime.sendMessage({ type: 'PIP_OPENED' }).catch(() => {});
      btn.classList.add('active');

      // PiP window closed by user (browser chrome close button, etc.)
      // Capture reference to avoid closure race if pipWindow is reassigned.
      const thisPipWin = pipWindow;
      thisPipWin.addEventListener('pagehide', () => {
        chrome.runtime.sendMessage({ type: 'PIP_CLOSED' }).catch(() => {});
        btn.classList.remove('active');
        if (pipWindow === thisPipWin) pipWindow = null;
        window.removeEventListener('message', onPiPMessage);
        // Restore overlay when PiP closes
        pipActive = false;
        if (capturing) wrap.classList.add('vis');
      });

    } catch (err) {
      dbg('PiP failed:', err);
      if (onPiPMessage) window.removeEventListener('message', onPiPMessage);
      pipWindow = null;
      pipActive = false;
      btn.classList.remove('active');
    }
  }

  // Caption cache for rendering; service-worker transcript store is authoritative.
  const CAPTION_HISTORY_SIZE = 500;
  const captionHistory = [];

  // PiP buffer is a subset of history (most recent)
  const PIP_BUFFER_SIZE = 20;

  function bufferCaption(msg) {
    if (!msg.isFinal) return;
    const segment = msg.segment || normalizeMessageSegment(msg);
    if (!segment) {
      dbg('Final caption not cached: missing segment metadata');
      return;
    }
    updateCachedSegment(segment);
  }

  function normalizeMessageSegment(msg) {
    if (!msg.segmentId || !Number.isFinite(msg.startedAt) || !Number.isFinite(msg.endedAt) || msg.endedAt <= msg.startedAt) {
      return null;
    }
    return {
      id: msg.segmentId,
      text: msg.text,
      rawText: msg.text,
      original: msg.original || '',
      startTs: msg.startedAt,
      endTs: msg.endedAt,
      sourceLanguage: msg.sourceLanguage || '',
      targetLanguage: msg.targetLanguage || '',
      revisionStatus: 'raw',
    };
  }

  function isRenderableSegment(entry) {
    return !!entry?.id && !!entry.text && Number.isFinite(entry.startTs) && Number.isFinite(entry.endTs) && entry.endTs > entry.startTs;
  }

  function updateCachedSegment(segment) {
    if (!isRenderableSegment(segment)) return;
    const idx = captionHistory.findIndex(entry => entry.id === segment.id);
    if (idx >= 0) captionHistory[idx] = { ...captionHistory[idx], ...segment };
    else captionHistory.push(segment);
    if (captionHistory.length > CAPTION_HISTORY_SIZE) captionHistory.shift();

    // If history panel is visible, append new entry
    if (historyVisible) renderHistory();
  }

  function getCaptionHistory() {
    return captionHistory.slice();
  }

  async function refreshTranscriptFromStore() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TRANSCRIPT' });
    if (response?.segments) {
      captionHistory.splice(0, captionHistory.length, ...response.segments.slice(-CAPTION_HISTORY_SIZE));
    }
    return captionHistory;
  }

  async function replayTranscriptToPiP() {
    if (!pipWindow || pipWindow.closed) return;
    await refreshTranscriptFromStore();
    const recent = captionHistory.filter(isRenderableSegment).slice(-PIP_BUFFER_SIZE);
    for (const entry of recent) {
      postToPiP({ type: 'CAPTION_UPDATE', text: entry.text, isFinal: true, original: entry.original, segment: entry, source: 'hydrate' });
    }
  }

  async function syncSettingsToPiP() {
    const r = await chrome.storage.local.get(['fontSize', 'bgOpacity', 'textColor', 'bilingualMode', 'pipMaxLines']);
    const s = {};
    if (r.fontSize) s.fontSize = r.fontSize;
    if (r.bgOpacity !== undefined) s.bgOpacity = r.bgOpacity;
    if (r.textColor) s.textColor = r.textColor;
    if (r.bilingualMode !== undefined) s.bilingualMode = r.bilingualMode;
    if (r.pipMaxLines) s.pipMaxLines = r.pipMaxLines;
    if (window.I18N) s.uiLanguage = I18N.getLang();
    if (Object.keys(s).length) postToPiP({ type: 'SETTINGS_UPDATE', ...s });
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
          dbg('Reinitializing after context invalidation');
          contextInvalidated = false;
          try {
            suppressObserver = true;
            const oldHost = document.getElementById(HOST_ID);
            if (oldHost) oldHost.remove();
            suppressObserver = false;
            shadow = wrap = linesEl = flowEl = placeholder = statusIndicator = null;
            captionTrack.clear();
            init();
          } catch (reinitErr) {
            dbg('Reinit failed:', reinitErr);
          }
        }
        const segment = msg.segment || normalizeMessageSegment(msg);
        show(msg.text, msg.isFinal, msg.original, segment);
        // Show PiP button when captions are flowing
        if (pipBtn) pipBtn.classList.add('vis');
        // Relay to PiP window and buffer for catch-up
        bufferCaption(msg);
        postToPiP({ type: 'CAPTION_UPDATE', text: msg.text, isFinal: msg.isFinal, original: msg.original, segment });
      } else if (msg.type === 'TRANSCRIPT_SEGMENT_UPDATED') {
        applySegmentUpdate(msg.segment);
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
      }
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        dbg('Extension context invalidated');
        contextInvalidated = true;
        // Do NOT remove the listener — the new service worker's messages
        // may still route through this handler on some Chrome versions.
        // The next message that arrives will trigger reinit.
      }
    }
  }
  // Listener dedup: remove previous handler if this script was re-injected.
  // Use Symbol.for so the key is shared across re-injections but non-enumerable.
  const _dedup = Symbol.for('__geminiCaptionHandler');
  if (window[_dedup]) {
    chrome.runtime.onMessage.removeListener(window[_dedup]);
  }
  window[_dedup] = messageHandler;
  chrome.runtime.onMessage.addListener(messageHandler);

  // ==================== SETTINGS REAL-TIME SYNC ====================
  const _storageDedup = Symbol.for('__geminiCaptionStorageListener');
  if (window[_storageDedup]) {
    chrome.storage.onChanged.removeListener(window[_storageDedup]);
  }
  function _onStorageChanged(changes, area) {
    if (area !== 'local') return;
    const s = {};
    if (changes.fontSize) s.fontSize = changes.fontSize.newValue;
    if (changes.bgOpacity) s.bgOpacity = changes.bgOpacity.newValue;
    if (changes.textColor) s.textColor = changes.textColor.newValue;
    if (changes.bilingualMode) s.bilingualMode = changes.bilingualMode.newValue;
    if (changes.pipMaxLines) s.pipMaxLines = changes.pipMaxLines.newValue;
    if (changes.overlayMaxLines) {
      applySettings({ overlayMaxLines: changes.overlayMaxLines.newValue });
    }
    if (Object.keys(s).length) {
      applySettings(s);
      relaySettingsToPiP(s);
    }
  }
  window[_storageDedup] = _onStorageChanged;
  chrome.storage.onChanged.addListener(_onStorageChanged);

  // ==================== AUTO-REPAIR ====================
  function startObserver() {
    hostObserver = new MutationObserver(() => {
      if (suppressObserver) return;
      if (!document.getElementById(HOST_ID)) init();
    });
    hostObserver.observe(document.documentElement, { childList: true, subtree: false });
    window[_obsKey] = hostObserver;  // Expose for cross-injection dedup
  }

  // Relay UI-language changes (driven by popup) to the PiP window so it
  // localizes in sync.
  //
  // Re-injection note: content.js can be injected multiple times into the
  // same page (extension reload, tab navigation). If we capture postToPiP
  // directly in the onChange closure, an old listener would keep calling a
  // stale function bound to a dead pipWindow. So we keep the *latest*
  // postToPiP behind a Symbol.for slot on window, register the onChange
  // listener exactly once, and have it dispatch through the current slot.
  const _postPiPKey = Symbol.for('__geminiCaptionPostPiP');
  window[_postPiPKey] = (msg) => postToPiP(msg);

  const _i18nCbKey = Symbol.for('__geminiCaptionI18nCbRegistered');
  if (window.I18N && !window[_i18nCbKey]) {
    window[_i18nCbKey] = true;
    I18N.onChange((newLang) => {
      const post = window[_postPiPKey];
      if (typeof post === 'function') {
        post({ type: 'SETTINGS_UPDATE', uiLanguage: newLang });
      }
    });
  }

  if (document.documentElement) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      init();
    });
  }
})();
