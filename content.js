// content.js — Gemini Live Caption Subtitle Overlay
// True LRC scrolling: track slides up one line-height per new subtitle.

(function () {
  'use strict';

  const HOST_ID = 'gemini-live-caption-host';
  const STORE_KEY = 'captionLayout';
  const MAX_LINES = 3;

  let shadow, wrap, linesEl, track, placeholder, pipBtn;
  let fadeTimer = null, capturing = false;
  let layout = { x: null, y: null, w: 560 };
  let lineCount = 0;
  let initGeneration = 0;  // Prevents stale async callbacks from building on wrong shadow

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
    const gen = ++initGeneration;
    chrome.storage.local.get([STORE_KEY, 'fontSize', 'bgOpacity'], r => {
      if (gen !== initGeneration) return;  // Stale callback, ignore
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

    // Resize handle
    const resize = document.createElement('div');
    resize.className = 'rsz';

    wrap.appendChild(drag);
    wrap.appendChild(linesEl);
    wrap.appendChild(placeholder);
    wrap.appendChild(resize);
    wrap.appendChild(pipBtn);
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

  // Caption ring buffer for PiP catch-up
  const PIP_BUFFER_SIZE = 20;
  const captionBuffer = [];

  function bufferCaption(text, isFinal) {
    if (!isFinal) return; // Only buffer finalized captions
    captionBuffer.push({ text, ts: Date.now() });
    if (captionBuffer.length > PIP_BUFFER_SIZE) captionBuffer.shift();
  }

  function replayBufferToPiP() {
    if (!pipWindow || pipWindow.closed) return;
    for (const entry of captionBuffer) {
      postToPiP({ type: 'CAPTION_UPDATE', text: entry.text, isFinal: true });
    }
  }

  function postToPiP(msg) {
    if (!pipWindow || pipWindow.closed) return;
    try {
      pipWindow.postMessage(msg, '*');
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
        // Show PiP button when captions are flowing
        if (pipBtn) pipBtn.classList.add('vis');
        // Relay to PiP window and buffer for catch-up
        bufferCaption(msg.text, msg.isFinal);
        postToPiP({ type: 'CAPTION_UPDATE', text: msg.text, isFinal: msg.isFinal });
      } else if (msg.type === 'CLEAR_CAPTIONS') {
        clearCaptions();
        postToPiP({ type: 'CLEAR_CAPTIONS' });
        // Hide PiP button when capture stops
        if (pipBtn) pipBtn.classList.remove('vis');
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
