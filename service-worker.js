// service-worker.js — Gemini Live Caption Extension
// Orchestrates tab capture, offscreen document, and message routing.
//
// Architecture:
// - All state stored in chrome.storage.session (survives SW restart)
// - Event listeners registered at top level (MV3 requirement)
// - Single offscreen document for audio processing
// - State machine: idle → starting → capturing → stopping

const DEBUG = false;
const dbg = (...args) => DEBUG && console.log(...args);

const TRANSCRIPT_SEGMENTS_KEY = 'transcriptSegments';
const TRANSCRIPT_SESSION_KEY = 'transcriptSession';
const TRANSCRIPT_LIMIT = 1000;
const SRT_MIN_DURATION_MS = 833;
const SRT_MAX_DURATION_MS = 7000;
const REVISION_MODES = new Set(['off', 'polish']);
const REVISION_MODEL = 'gemini-3.5-flash';
let revisionQueue = Promise.resolve();

// ==================== STATE MANAGEMENT ====================
// State structure in chrome.storage.session:
// {
//   captureState: 'idle' | 'starting' | 'capturing' | 'stopping',
//   activeTabId: number | null,
//   waitingReloadTabId: number | null  // Tab waiting for reload to complete
// }

// ==================== STARTUP RECOVERY ====================
// Recover from stuck states when service worker restarts.
//
// Recovery strategy for 'capturing' state:
//   1. Check if the offscreen document still exists (Chrome may have GC'd it)
//   2. Check lastHeartbeat timestamp — offscreen writes this every 20s
//   3. If no recent heartbeat, PING the offscreen to see if it responds
//   4. Only reset to idle if we can confirm the offscreen is truly dead
//
// The offscreen document is the stable anchor (full DOM, no idle timeout for
// USER_MEDIA reason). The service worker is ephemeral. When the SW restarts,
// the offscreen may still be happily capturing — we must not kill it blindly.
(async function recoverState() {
  const { captureState, activeTabId, lastHeartbeat } =
    await chrome.storage.session.get(['captureState', 'activeTabId', 'lastHeartbeat']);

  if (captureState === 'starting' || captureState === 'stopping') {
    // Transition states are transient — if the SW died mid-transition,
    // the operation is incomplete. Clean up and reset.
    dbg(`[SW] Recovering from stuck state: ${captureState}`);
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) {
      try { await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }); } catch (e) {}
      await closeOffscreenDocument();
    }
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null, lastHeartbeat: null });
    await chrome.action.setBadgeText({ text: '' });

  } else if (captureState === 'capturing' && activeTabId) {
    // Verify the tab still exists
    let tabAlive = true;
    try {
      await chrome.tabs.get(activeTabId);
    } catch (e) {
      tabAlive = false;
    }

    if (!tabAlive) {
      dbg(`[SW] Active tab ${activeTabId} no longer exists, cleaning up`);
      try { await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }); } catch (e) {}
      await closeOffscreenDocument();
      await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null, lastHeartbeat: null });
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    // Tab is alive — verify the offscreen document is actually working.
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length === 0) {
      // Offscreen document is gone. Clean up.
      dbg('[SW] Offscreen document missing during recovery, resetting');
      await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null, lastHeartbeat: null });
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    // Offscreen exists. Check if it's actually alive via heartbeat.
    const now = Date.now();
    if (lastHeartbeat && (now - lastHeartbeat) < 30000) {
      // Heartbeat is fresh (< 30s old) — offscreen is alive and capturing.
      dbg('[SW] Offscreen alive (heartbeat fresh), capture continues');
      // Re-inject content script — it may have been lost during SW restart
      await ensureContentScript(activeTabId);
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
      return;
    }

    // No recent heartbeat. Ping the offscreen directly — it may have just
    // started and not sent its first heartbeat yet, or the SW restarted
    // before the first heartbeat arrived.
    dbg('[SW] No recent heartbeat, pinging offscreen...');
    try {
      const pong = await Promise.race([
        chrome.runtime.sendMessage({ type: 'PING' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
      ]);
      if (pong && pong.alive) {
        dbg('[SW] Offscreen responded to PING, capture continues');
        // Re-inject content script — it may have been lost during SW restart
        await ensureContentScript(activeTabId);
        await chrome.action.setBadgeText({ text: 'ON' });
        await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
        return;
      }
    } catch (e) {
      dbg('[SW] Offscreen ping failed:', e.message);
    }

    // Offscreen is not responding. Clean up.
    dbg('[SW] Offscreen appears dead, resetting to idle');
    await closeOffscreenDocument();
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null, lastHeartbeat: null });
    await chrome.action.setBadgeText({ text: '' });
  }
})();

// ==================== EVENT LISTENERS (top-level registration) ====================

// Handle keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-capture') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await toggleCapture(tab.id);
  }
});

// Handle tab activation (switching between tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId } = activeInfo;
  const { activeTabId, captureState } = await chrome.storage.session.get(['activeTabId', 'captureState']);

  // Skip if in transition
  if (captureState === 'starting' || captureState === 'stopping') {
    return;
  }

  // If switching to a different tab while capturing — do nothing.
  // Audio capture stays locked to the original source tab.
  if (captureState === 'capturing' && activeTabId !== tabId) {
    dbg(`[SW] Tab switched to ${tabId}, keeping capture on source tab ${activeTabId}`);
  }
});

// Handle tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeTabId, waitingReloadTabId } = await chrome.storage.session.get(['activeTabId', 'waitingReloadTabId']);

  if (tabId === activeTabId) {
    dbg('[SW] Active tab closed, stopping capture');
    await stopCapture();
  }

  // Clean up waiting state if the tab is closed
  if (tabId === waitingReloadTabId) {
    await chrome.storage.session.set({ waitingReloadTabId: null });
  }
});

// Handle tab navigation
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const { activeTabId, captureState, waitingReloadTabId } = await chrome.storage.session.get([
    'activeTabId', 'captureState', 'waitingReloadTabId'
  ]);

  // If the active tab starts loading a new page
  if (changeInfo.status === 'loading' && tabId === activeTabId && captureState === 'capturing') {
    dbg(`[SW] Active tab ${tabId} navigating, stopping capture`);
    await stopCapture();
    await chrome.storage.session.set({ waitingReloadTabId: tabId });
  }

  // If the tab finishes loading and was waiting for reload
  if (changeInfo.status === 'complete' && tabId === waitingReloadTabId) {
    // Verify this is still the active tab before resuming
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab && currentTab.id === tabId) {
      dbg(`[SW] Tab ${tabId} reloaded, resuming capture`);
      await chrome.storage.session.set({ waitingReloadTabId: null });
      await startCapture(tabId);
    } else {
      dbg(`[SW] Tab ${tabId} reloaded but no longer active, skipping resume`);
      await chrome.storage.session.set({ waitingReloadTabId: null });
    }
  }
});

// Handle tab ID replacement (pre-render scenarios)
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (removedTabId === activeTabId) {
    dbg(`[SW] Tab replaced: ${removedTabId} → ${addedTabId}, restarting capture`);
    await chrome.storage.session.set({ activeTabId: addedTabId });
    // Restart capture with new tab ID since stream ID is tab-specific
    try {
      await stopCapture();
    } catch (e) {
      dbg('[SW] stopCapture failed during tab replace:', e);
    }
    try {
      await startCapture(addedTabId);
    } catch (e) {
      dbg('[SW] startCapture failed during tab replace:', e);
      await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    }
  }
});

// Sender validation helpers
function isFromPopup(sender) {
  return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup/`);
}
function isFromOffscreen(sender) {
  return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/offscreen`);
}

// Handle messages from popup, offscreen, and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOGGLE_CAPTURE') {
    (async () => {
      try {
        await toggleCapture(msg.tabId);
        const { captureState = 'idle', activeTabId = null } =
          await chrome.storage.session.get(['captureState', 'activeTabId']);
        sendResponse({ success: true, state: captureState, tabId: activeTabId });
      } catch (err) {
        console.error('[SW] Toggle capture error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    (async () => {
      const { captureState = 'idle', activeTabId = null } = await chrome.storage.session.get(['captureState', 'activeTabId']);
      sendResponse({ state: captureState, tabId: activeTabId });
    })();
    return true;
  }

  if (msg.type === 'CAPTION_UPDATE') {
    if (!isFromOffscreen(sender)) return false;
    (async () => {
      const { activeTabId } = await chrome.storage.session.get('activeTabId');
      // Send to content script in the audio source tab.
      // content.js acts as the bridge: it renders the overlay AND relays
      // to the PiP window via postMessage. No broadcast needed — sending
      // via chrome.runtime.sendMessage would cause content.js to receive
      // the message twice (once from tabs.sendMessage, once from runtime).
      if (activeTabId) {
        const captionMsg = {
          type: 'CAPTION_UPDATE',
          text: msg.text,
          isFinal: msg.isFinal,
          segmentId: msg.segmentId,
          startedAt: msg.startedAt,
          endedAt: msg.endedAt,
          sourceLanguage: msg.sourceLanguage,
          targetLanguage: msg.targetLanguage,
        };
        // Pass through original text for bilingual mode
        if (msg.original) {
          captionMsg.original = msg.original;
        }
        if (msg.isFinal && msg.text) {
          try {
            const segment = await storeFinalTranscriptSegment(captionMsg);
            captionMsg.segment = segment;
            enqueueCaptionRevision(segment);
          } catch (err) {
            console.error('[SW] Transcript store rejected finalized caption:', err.message);
          }
        }
        try {
          await chrome.tabs.sendMessage(activeTabId, captionMsg);
        } catch (err) {
          // Content script lost — re-inject and retry
          console.warn('[SW] CAPTION_UPDATE delivery failed, re-injecting content script:', err.message);
          try {
            await ensureContentScript(activeTabId);
            // Small delay to let content.js init() create the overlay
            await new Promise(r => setTimeout(r, 200));
            // Retry once after re-injection
            await chrome.tabs.sendMessage(activeTabId, captionMsg);
          } catch (retryErr) {
            console.error('[SW] CAPTION_UPDATE retry also failed:', retryErr.message);
          }
        }
      }
    })();
    return false;
  }

  if (msg.type === 'STATUS_UPDATE') {
    if (!isFromOffscreen(sender)) return false;
    (async () => {
      await updateBadge(msg.status);
      // Forward status to content script for in-page indicator
      const { activeTabId } = await chrome.storage.session.get('activeTabId');
      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, {
            type: 'STATUS_UPDATE',
            status: msg.status,
            message: msg.message,
          });
        } catch (e) {
          // Content script might be gone, not critical
        }
      }
    })();
    return false;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    if (!isFromPopup(sender)) return false;
    (async () => {
      // Validate settings schema — only allow known keys with correct types
      const allowed = {};
      if (typeof msg.settings?.apiKey === 'string') allowed.apiKey = msg.settings.apiKey;
      if (typeof msg.settings?.targetLanguage === 'string') allowed.targetLanguage = msg.settings.targetLanguage;
      if (['small', 'medium', 'large', 'xlarge'].includes(msg.settings?.fontSize)) allowed.fontSize = msg.settings.fontSize;
      if (typeof msg.settings?.bgOpacity === 'number' && msg.settings.bgOpacity >= 0 && msg.settings.bgOpacity <= 1) {
        allowed.bgOpacity = msg.settings.bgOpacity;
      }
      if (typeof msg.settings?.audioGain === 'number' && msg.settings.audioGain >= 1 && msg.settings.audioGain <= 5) {
        allowed.audioGain = msg.settings.audioGain;
      }
      if (typeof msg.settings?.noiseGate === 'number' && msg.settings.noiseGate >= 0 && msg.settings.noiseGate <= 0.05) {
        allowed.noiseGate = msg.settings.noiseGate;
      }
      if (typeof msg.settings?.bilingualMode === 'boolean') allowed.bilingualMode = msg.settings.bilingualMode;
      if (typeof msg.settings?.echoTargetLanguage === 'boolean') allowed.echoTargetLanguage = msg.settings.echoTargetLanguage;
      if ([2, 3, 4].includes(msg.settings?.overlayMaxLines)) allowed.overlayMaxLines = msg.settings.overlayMaxLines;
      if ([2, 3, 4, 5].includes(msg.settings?.pipMaxLines)) allowed.pipMaxLines = msg.settings.pipMaxLines;
      if (REVISION_MODES.has(msg.settings?.captionRevisionMode)) allowed.captionRevisionMode = msg.settings.captionRevisionMode;
      if (typeof msg.settings?.captionTerminology === 'string') allowed.captionTerminology = msg.settings.captionTerminology.slice(0, 4000);
      if (Object.keys(allowed).length === 0) {
        sendResponse({ success: false, error: 'No valid settings' });
        return;
      }
      await chrome.storage.local.set(allowed);
      try {
        await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: allowed });
      } catch (e) {
        // Offscreen may not exist yet
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.type === 'SET_POSITION') {
    if (!isFromPopup(sender)) return false;
    (async () => {
      const { activeTabId } = await chrome.storage.session.get('activeTabId');
      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, { type: 'SET_POSITION', preset: msg.preset });
        } catch (e) {}
      }
      await chrome.storage.local.set({ captionPosition: msg.preset });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.type === 'SET_TEXT_COLOR') {
    if (!isFromPopup(sender)) return false;
    (async () => {
      const { activeTabId } = await chrome.storage.session.get('activeTabId');
      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, { type: 'SET_TEXT_COLOR', color: msg.color });
        } catch (e) {}
      }
      await chrome.storage.local.set({ textColor: msg.color });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.type === 'AUDIO_LOST') {
    if (!isFromOffscreen(sender)) return false;
    (async () => {
      const { activeTabId, captureState } = await chrome.storage.session.get(['activeTabId', 'captureState']);
      if (captureState === 'capturing' && activeTabId) {
        try {
          await stopCapture();
        } catch (e) {
          console.warn('[SW] stopCapture failed during AUDIO_LOST:', e);
        }
        // Small delay before restart to let resources clean up
        await new Promise(r => setTimeout(r, 500));
        try {
          await startCapture(activeTabId);
        } catch (e) {
          console.error('[SW] Restart capture after AUDIO_LOST failed:', e);
        }
      }
    })();
    return false;
  }

  if (msg.type === 'HEARTBEAT') {
    if (!isFromOffscreen(sender)) return false;
    // Heartbeat from offscreen document — keeps this SW alive (resets 30s idle timer).
    return false;
  }

  if (msg.type === 'PIP_OPENED') {
    (async () => {
      await chrome.storage.session.set({ pipWindowOpen: true });
      dbg('[SW] PiP window opened');
    })();
    return false;
  }

  if (msg.type === 'PIP_CLOSED') {
    (async () => {
      await chrome.storage.session.set({ pipWindowOpen: false });
      dbg('[SW] PiP window closed');
    })();
    return false;
  }

  if (msg.type === 'DISCLAIMER_ACCEPTED') {
    if (!isFromPopup(sender)) return false;
    (async () => {
      await chrome.action.setBadgeText({ text: '' });
    })();
    return false;
  }

  if (msg.type === 'EXPORT_LOGS') {
    if (!isFromPopup(sender)) return false;
    (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'EXPORT_LOGS', since: msg.since || 0 });
        sendResponse(response || { entries: [] });
      } catch (e) {
        // Offscreen may not exist
        sendResponse({ entries: [] });
      }
    })();
    return true;
  }

  if (msg.type === 'EXPORT_CAPTIONS') {
    if (!isFromPopup(sender)) return false;
    (async () => {
      const segments = await getTranscriptSegments();
      sendResponse({ captions: segments, segments, srt: formatSRT(segments) });
    })();
    return true;
  }

  if (msg.type === 'GET_TRANSCRIPT') {
    (async () => {
      const segments = await getTranscriptSegments();
      sendResponse({ segments, srt: formatSRT(segments) });
    })();
    return true;
  }
});

// Handle extension install/update
chrome.runtime.onInstalled.addListener(async (details) => {
  dbg(`[SW] Extension ${details.reason}`);
  const existing = await chrome.storage.local.get([
    'targetLanguage', 'apiKey', 'fontSize', 'bgOpacity', 'maxLines',
    'overlayMaxLines', 'pipMaxLines', 'echoTargetLanguage', 'captionRevisionMode',
    'captionTerminology',
  ]);
  const defaults = {};
  if (existing.apiKey === undefined) defaults.apiKey = '';
  if (!existing.targetLanguage) defaults.targetLanguage = 'zh-Hans';
  if (!existing.fontSize) defaults.fontSize = 'medium';
  if (existing.bgOpacity === undefined) defaults.bgOpacity = 0.75;
  if (existing.overlayMaxLines === undefined) defaults.overlayMaxLines = existing.maxLines ?? 2;
  if (existing.pipMaxLines === undefined) defaults.pipMaxLines = 2;
  if (existing.echoTargetLanguage === undefined) defaults.echoTargetLanguage = false;
  if (!REVISION_MODES.has(existing.captionRevisionMode)) defaults.captionRevisionMode = 'off';
  if (existing.captionTerminology === undefined) defaults.captionTerminology = '';
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null });
  await chrome.action.setBadgeText({ text: '' });
});

// ==================== CORE FUNCTIONS ====================

async function toggleCapture(tabId) {
  const { captureState = 'idle', activeTabId } = await chrome.storage.session.get(['captureState', 'activeTabId']);

  // Ignore if in transition
  if (captureState === 'starting' || captureState === 'stopping') {
    dbg('[SW] Capture in transition, ignoring toggle');
    return;
  }

  if (captureState === 'capturing') {
    // The main toggle is a global capture switch. If tab A owns the audio
    // session and the user opens the popup or shortcut from tab B, the intent is
    // to stop the running session, not to silently move capture to B.
    if (activeTabId && activeTabId !== tabId) {
      dbg(`[SW] Toggle from tab ${tabId} stopping source tab ${activeTabId}`);
    }
    await stopCapture();
    return;
  }

  if (captureState === 'idle') {
    // Block new captures until disclaimer is accepted. Stop actions are never
    // gated by start prerequisites.
    const { disclaimerAccepted } = await chrome.storage.local.get('disclaimerAccepted');
    if (!disclaimerAccepted) {
      dbg('[SW] Disclaimer not accepted, blocking capture');
      // Open popup so user can see and accept the disclaimer
      try {
        await chrome.action.openPopup();
      } catch (e) {
        // openPopup may fail without user gesture — show badge hint
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
      }
      return;
    }

    await startCapture(tabId);
  }
}

async function startCapture(tabId) {
  dbg(`[SW] Starting capture for tab ${tabId}`);

  // Check if the tab is a Chrome internal page
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || '';
    dbg(`[SW] Tab URL: ${url}`);

    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
        url.startsWith('chrome-web-store://') || url.startsWith('edge://') ||
        url.startsWith('about:') || url.startsWith('brave://') ||
        url.startsWith('vivaldi://') || url.startsWith('opera://')) {
      console.warn(`[SW] Cannot capture internal page: ${url}`);
      await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
      await chrome.action.setBadgeText({ text: 'ERR' });
      await chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
      throw new Error('Cannot capture Chrome internal pages. Please switch to a regular webpage.');
    }
  } catch (e) {
    if (e.message.includes('Cannot capture')) throw e;
    console.warn('[SW] Failed to get tab info, proceeding anyway:', e);
  }

  await chrome.storage.session.set({ captureState: 'starting', activeTabId: tabId });
  await chrome.action.setBadgeText({ text: '...' });
  await chrome.action.setBadgeBackgroundColor({ color: '#FFA500' });

  // Ensure the content script is alive in the target tab.
  // After extension reload, old content scripts become invalid ("Extension context
  // invalidated") and can't receive messages. We must inject a fresh one.
  await ensureContentScript(tabId);

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const settings = await chrome.storage.local.get([
      'apiKey', 'targetLanguage', 'audioGain', 'noiseGate', 'bilingualMode',
      'echoTargetLanguage', 'captionTerminology'
    ]);
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId,
      settings: {
        apiKey: settings.apiKey || '',
        targetLanguage: settings.targetLanguage || 'zh-Hans',
        audioGain: settings.audioGain ?? 1.0,
        noiseGate: settings.noiseGate ?? 0,
        bilingualMode: settings.bilingualMode ?? false,
        echoTargetLanguage: settings.echoTargetLanguage ?? false,
        captionTerminology: settings.captionTerminology || '',
      },
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to start capture');
    }

    await resetTranscriptSession(tabId, settings);
    await chrome.storage.session.set({ captureState: 'capturing' });
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
    dbg('[SW] Capture started');
  } catch (err) {
    console.error('[SW] Start capture failed:', err);
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
    throw err;
  }
}

async function stopCapture() {
  dbg('[SW] Stopping capture');
  await chrome.storage.session.set({ captureState: 'stopping' });

  try {
    await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  } catch (e) {
    // Offscreen might already be gone
  }

  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'CLEAR_CAPTIONS' });
    } catch (e) {
      // Content script might be gone
    }
  }
  // Note: content.js relays CLEAR_CAPTIONS to PiP window via postMessage.
  // No broadcast via chrome.runtime.sendMessage — would cause double-receive.

  await closeOffscreenDocument();
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null, lastHeartbeat: null });
  await chrome.action.setBadgeText({ text: '' });
  dbg('[SW] Capture stopped');
}

// ==================== HELPER FUNCTIONS ====================

async function updateBadge(status) {
  if (status === 'error') {
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
  } else if (status === 'reconnecting') {
    await chrome.action.setBadgeText({ text: '...' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FFA500' });
  } else if (status === 'capturing') {
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
  } else if (status === 'idle') {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ==================== OFFSCREEN DOCUMENT MANAGEMENT ====================

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({});
  const offscreenExists = existingContexts.some(
    (ctx) => ctx.contextType === 'OFFSCREEN_DOCUMENT'
  );

  if (offscreenExists) {
    dbg('[SW] Offscreen document already exists');
    return;
  }

  dbg('[SW] Creating offscreen document');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capturing tab audio and streaming to Gemini Live API for real-time translation',
  });
}

async function closeOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenExists = existingContexts.some(
      (ctx) => ctx.contextType === 'OFFSCREEN_DOCUMENT'
    );
    if (offscreenExists) {
      await chrome.offscreen.closeDocument();
      dbg('[SW] Offscreen document closed');
    }
  } catch (e) {
    console.warn('[SW] Error closing offscreen document:', e);
  }
}

async function ensureContentScript(tabId) {
  // Always inject. content.js's init() is idempotent — if the host element
  // already exists it returns immediately. A fresh injection guarantees the
  // message listener is wired to the current extension context, not a stale one.
  // i18n.js and caption-track.js are injected first so content.js receives
  // localization and the shared subtitle state module before it initializes.
  dbg('[SW] Ensuring content script in tab', tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['i18n.js', 'caption-track.js', 'content.js'],
    });
  } catch (e) {
    console.warn('[SW] Content script injection:', e.message);
  }
}

// ==================== TRANSCRIPT STORE ====================

async function resetTranscriptSession(tabId, settings) {
  await chrome.storage.session.set({
    [TRANSCRIPT_SEGMENTS_KEY]: [],
    [TRANSCRIPT_SESSION_KEY]: {
      id: `cap-${Date.now()}`,
      tabId,
      startedAt: Date.now(),
      targetLanguage: settings.targetLanguage || 'zh-Hans',
    },
  });
}

async function getTranscriptSegments() {
  const data = await chrome.storage.session.get(TRANSCRIPT_SEGMENTS_KEY);
  return Array.isArray(data[TRANSCRIPT_SEGMENTS_KEY]) ? data[TRANSCRIPT_SEGMENTS_KEY] : [];
}

async function storeFinalTranscriptSegment(msg) {
  const segment = normalizeFinalTranscriptSegment(msg);
  const segments = await getTranscriptSegments();
  segments.push(segment);
  if (segments.length > TRANSCRIPT_LIMIT) segments.splice(0, segments.length - TRANSCRIPT_LIMIT);
  await chrome.storage.session.set({ [TRANSCRIPT_SEGMENTS_KEY]: segments });
  return segment;
}

function normalizeFinalTranscriptSegment(msg) {
  const text = (msg.text || '').trim();
  if (!text) throw new Error('empty finalized caption');
  if (!msg.segmentId) throw new Error('missing segment id');
  if (!Number.isFinite(msg.startedAt) || !Number.isFinite(msg.endedAt) || msg.endedAt <= msg.startedAt) {
    throw new Error(`invalid caption timestamps for ${msg.segmentId}`);
  }
  return {
    id: msg.segmentId,
    startTs: msg.startedAt,
    endTs: msg.endedAt,
    text,
    rawText: text,
    original: msg.original || '',
    sourceLanguage: msg.sourceLanguage || '',
    targetLanguage: msg.targetLanguage || '',
    revisionStatus: 'raw',
    revisionModel: '',
    revisionError: '',
  };
}

function formatSRT(segments) {
  const valid = segments.filter(s => s && s.text && Number.isFinite(s.startTs) && Number.isFinite(s.endTs) && s.endTs > s.startTs);
  if (!valid.length) return '';
  const startTime = valid[0].startTs;
  return valid.map((entry, i) => {
    const start = entry.startTs - startTime;
    const next = valid[i + 1];
    let endTs = Math.max(entry.endTs, entry.startTs + SRT_MIN_DURATION_MS);
    endTs = Math.min(endTs, entry.startTs + SRT_MAX_DURATION_MS);
    if (next && endTs >= next.startTs) endTs = Math.max(entry.startTs + 1, next.startTs - 1);
    const end = endTs - startTime;
    const body = entry.original ? `${entry.original}\n${entry.text}` : entry.text;
    return `${i + 1}\n${formatSRTTime(start)} --> ${formatSRTTime(end)}\n${body}\n`;
  }).join('\n');
}

function formatSRTTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms2 = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms2).padStart(3, '0')}`;
}

function enqueueCaptionRevision(segment) {
  revisionQueue = revisionQueue.then(() => maybeReviseSegment(segment)).catch(err => {
    console.error('[SW] Caption revision queue failed:', err.message);
  });
}

async function maybeReviseSegment(segment) {
  const settings = await chrome.storage.local.get(['captionRevisionMode', 'captionTerminology', 'apiKey', 'targetLanguage']);
  if ((settings.captionRevisionMode || 'off') !== 'polish') return;
  let revisedText;
  try {
    revisedText = await requestCaptionRevision(segment, settings);
  } catch (err) {
    await updateTranscriptSegment(segment.id, {
      revisionStatus: 'error',
      revisionModel: REVISION_MODEL,
      revisionError: err.message.slice(0, 240),
    });
    throw err;
  }
  if (!revisedText || revisedText === segment.text) {
    await updateTranscriptSegment(segment.id, { revisionStatus: 'unchanged', revisionModel: REVISION_MODEL });
    return;
  }
  const updated = await updateTranscriptSegment(segment.id, {
    text: revisedText,
    revisionStatus: 'revised',
    revisionModel: REVISION_MODEL,
    revisionError: '',
  });
  await notifyTranscriptSegmentUpdated(updated);
}

async function requestCaptionRevision(segment, settings) {
  if (!settings.apiKey) throw new Error('caption revision requires an API key');
  const prompt = buildRevisionPrompt(segment, settings);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${REVISION_MODEL}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    await updateTranscriptSegment(segment.id, {
      revisionStatus: 'error',
      revisionModel: REVISION_MODEL,
      revisionError: `HTTP ${res.status}: ${body.slice(0, 240)}`,
    });
    return '';
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('caption revision returned empty response');
  const parsed = JSON.parse(text);
  const revised = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!revised) throw new Error('caption revision returned invalid JSON');
  return revised;
}

function buildRevisionPrompt(segment, settings) {
  const glossary = (settings.captionTerminology || '').trim();
  return [
    'You revise one finalized live-caption translation segment for readability.',
    'Preserve meaning, numbers, names, and timing. Do not add facts. Do not summarize.',
    'Improve punctuation, spacing, terminology consistency, and subtitle readability.',
    'Return exactly JSON: {"text":"..."}',
    glossary ? `Glossary and style rules:\n${glossary}` : 'Glossary and style rules: none',
    `Target language: ${settings.targetLanguage || segment.targetLanguage || 'unknown'}`,
    segment.original ? `Source transcript:\n${segment.original}` : 'Source transcript: unavailable',
    `Translated caption:\n${segment.rawText}`,
  ].join('\n\n');
}

async function updateTranscriptSegment(id, patch) {
  const segments = await getTranscriptSegments();
  const idx = segments.findIndex(s => s.id === id);
  if (idx < 0) throw new Error(`transcript segment not found: ${id}`);
  segments[idx] = { ...segments[idx], ...patch };
  await chrome.storage.session.set({ [TRANSCRIPT_SEGMENTS_KEY]: segments });
  return segments[idx];
}

async function notifyTranscriptSegmentUpdated(segment) {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'TRANSCRIPT_SEGMENT_UPDATED',
      segment,
    });
  } catch (e) {}
}

dbg('[SW] Service worker loaded');
