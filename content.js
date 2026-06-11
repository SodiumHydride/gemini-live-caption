// content.js — Gemini Live Caption Subtitle Overlay
// True LRC scrolling: track slides up one line-height per new subtitle.

(function () {
  'use strict';

  const HOST_ID = 'gemini-live-caption-host';
  const STORE_KEY = 'captionLayout';
  const MAX_LINES = 3;

  let shadow, wrap, linesEl, track, placeholder;
  let fadeTimer = null, capturing = false;
  let layout = { x: null, y: null, w: 560 };
  let lineCount = 0;

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
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });
    chrome.storage.local.get([STORE_KEY, 'fontSize', 'bgOpacity'], r => {
      if (r[STORE_KEY]) Object.assign(layout, r[STORE_KEY]);
      build();
      applySettings(r);
    });
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

    // Resize handle
    const resize = document.createElement('div');
    resize.className = 'rsz';

    wrap.appendChild(drag);
    wrap.appendChild(linesEl);
    wrap.appendChild(placeholder);
    wrap.appendChild(resize);
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
      }
      .w:hover .drag, .w.dragging .drag { opacity: 1; }
      .w.dragging .drag { cursor: grabbing; }

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
        color: #fff;
        font-size: var(--cap-font-size); font-weight: 500; line-height: 1.45;
        padding: .3em 1em;
        text-align: center;
        text-shadow: 0 1px 4px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.4);
        word-break: break-word; white-space: pre-wrap;
        transition: opacity .25s ease-out, padding .25s ease-out, max-height .25s ease-out;
        max-height: 10em;
        overflow: hidden;
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
    `;
  }

  // ==================== ADD LINE ====================
  let viewportLocked = false;

  function addLine(text) {
    const el = document.createElement('div');
    el.className = 'line';
    el.textContent = text;
    track.appendChild(el);
    lineCount++;

    // Lock viewport height on first line — prevents container flash
    if (!viewportLocked) {
      const lineH = el.offsetHeight;
      linesEl.style.height = (lineH * MAX_LINES) + 'px';
      viewportLocked = true;
    }

    if (lineCount > MAX_LINES) {
      // Slide track up by one line height
      const lineH = el.offsetHeight;
      track.style.transform = `translateY(-${lineH}px)`;

      // After animation, remove old line and reset track position
      track.addEventListener('transitionend', function handler() {
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

  function show(text, isFinal) {
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
      addLine(text);
    } else {
      // Partial: update current line in-place (live preview)
      if (currentPartialEl && currentPartialEl.parentNode === track) {
        currentPartialEl.textContent = text;
        currentPartialText = text;
      } else {
        addLine(text);
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

  // ==================== LAYOUT ====================
  function applyPos() {
    if (!wrap) return;
    wrap.style.width = layout.w + 'px';
    if (layout.x != null) {
      wrap.style.left = layout.x + 'px';
    } else {
      wrap.style.left = '50%';
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
            shadow = wrap = linesEl = track = placeholder = null;
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
        show(msg.text, msg.isFinal);
      } else if (msg.type === 'CLEAR_CAPTIONS') {
        clearCaptions();
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
    if (Object.keys(s).length) applySettings(s);
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
