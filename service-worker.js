// service-worker.js — Gemini Live Caption Extension
// Orchestrates tab capture, offscreen document, and message routing.
//
// Architecture:
// - All state stored in chrome.storage.session (survives SW restart)
// - Event listeners registered at top level (MV3 requirement)
// - Single offscreen document for audio processing
// - State machine: idle → starting → capturing → stopping

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
    console.log(`[SW] Recovering from stuck state: ${captureState}`);
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
      console.log(`[SW] Active tab ${activeTabId} no longer exists, cleaning up`);
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
      console.log('[SW] Offscreen document missing during recovery, resetting');
      await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null, lastHeartbeat: null });
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    // Offscreen exists. Check if it's actually alive via heartbeat.
    const now = Date.now();
    if (lastHeartbeat && (now - lastHeartbeat) < 30000) {
      // Heartbeat is fresh (< 30s old) — offscreen is alive and capturing.
      console.log('[SW] Offscreen alive (heartbeat fresh), capture continues');
      // Re-inject content script — it may have been lost during SW restart
      await ensureContentScript(activeTabId);
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
      return;
    }

    // No recent heartbeat. Ping the offscreen directly — it may have just
    // started and not sent its first heartbeat yet, or the SW restarted
    // before the first heartbeat arrived.
    console.log('[SW] No recent heartbeat, pinging offscreen...');
    try {
      const pong = await Promise.race([
        chrome.runtime.sendMessage({ type: 'PING' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
      ]);
      if (pong && pong.alive) {
        console.log('[SW] Offscreen responded to PING, capture continues');
        // Re-inject content script — it may have been lost during SW restart
        await ensureContentScript(activeTabId);
        await chrome.action.setBadgeText({ text: 'ON' });
        await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
        return;
      }
    } catch (e) {
      console.log('[SW] Offscreen ping failed:', e.message);
    }

    // Offscreen is not responding. Clean up.
    console.log('[SW] Offscreen appears dead, resetting to idle');
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
    console.log(`[SW] Tab switched to ${tabId}, keeping capture on source tab ${activeTabId}`);
  }
});

// Handle tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeTabId, waitingReloadTabId } = await chrome.storage.session.get(['activeTabId', 'waitingReloadTabId']);

  if (tabId === activeTabId) {
    console.log('[SW] Active tab closed, stopping capture');
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
    console.log(`[SW] Active tab ${tabId} navigating, stopping capture`);
    await stopCapture();
    await chrome.storage.session.set({ waitingReloadTabId: tabId });
  }

  // If the tab finishes loading and was waiting for reload
  if (changeInfo.status === 'complete' && tabId === waitingReloadTabId) {
    // Verify this is still the active tab before resuming
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab && currentTab.id === tabId) {
      console.log(`[SW] Tab ${tabId} reloaded, resuming capture`);
      await chrome.storage.session.set({ waitingReloadTabId: null });
      await startCapture(tabId);
    } else {
      console.log(`[SW] Tab ${tabId} reloaded but no longer active, skipping resume`);
      await chrome.storage.session.set({ waitingReloadTabId: null });
    }
  }
});

// Handle tab ID replacement (pre-render scenarios)
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (removedTabId === activeTabId) {
    console.log(`[SW] Tab replaced: ${removedTabId} → ${addedTabId}, restarting capture`);
    await chrome.storage.session.set({ activeTabId: addedTabId });
    // Restart capture with new tab ID since stream ID is tab-specific
    try {
      await stopCapture();
    } catch (e) {
      console.warn('[SW] stopCapture failed during tab replace:', e);
    }
    await startCapture(addedTabId);
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
        const { captureState = 'idle' } = await chrome.storage.session.get('captureState');
        sendResponse({ success: true, state: captureState });
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
        try {
          await chrome.tabs.sendMessage(activeTabId, {
            type: 'CAPTION_UPDATE',
            text: msg.text,
            isFinal: msg.isFinal,
          });
        } catch (err) {
          // Content script lost — re-inject and retry
          console.warn('[SW] CAPTION_UPDATE delivery failed, re-injecting content script:', err.message);
          try {
            await ensureContentScript(activeTabId);
            // Small delay to let content.js init() create the overlay
            await new Promise(r => setTimeout(r, 200));
            // Retry once after re-injection
            await chrome.tabs.sendMessage(activeTabId, {
              type: 'CAPTION_UPDATE',
              text: msg.text,
              isFinal: msg.isFinal,
            });
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
      if (['small', 'medium', 'large'].includes(msg.settings?.fontSize)) allowed.fontSize = msg.settings.fontSize;
      if (typeof msg.settings?.bgOpacity === 'number' && msg.settings.bgOpacity >= 0 && msg.settings.bgOpacity <= 1) {
        allowed.bgOpacity = msg.settings.bgOpacity;
      }
      if (typeof msg.settings?.audioGain === 'number' && msg.settings.audioGain >= 1 && msg.settings.audioGain <= 5) {
        allowed.audioGain = msg.settings.audioGain;
      }
      if (typeof msg.settings?.noiseGate === 'number' && msg.settings.noiseGate >= 0 && msg.settings.noiseGate <= 0.05) {
        allowed.noiseGate = msg.settings.noiseGate;
      }
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
      console.log('[SW] PiP window opened');
    })();
    return false;
  }

  if (msg.type === 'PIP_CLOSED') {
    (async () => {
      await chrome.storage.session.set({ pipWindowOpen: false });
      console.log('[SW] PiP window closed');
    })();
    return false;
  }
});

// Handle extension install/update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[SW] Extension ${details.reason}`);
  const existing = await chrome.storage.local.get(['targetLanguage', 'apiKey']);
  if (!existing.targetLanguage) {
    await chrome.storage.local.set({
      apiKey: '',
      targetLanguage: 'zh-Hans',
      fontSize: 'medium',
      bgOpacity: 0.75,
    });
  }
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, waitingReloadTabId: null });
  await chrome.action.setBadgeText({ text: '' });
});

// ==================== CORE FUNCTIONS ====================

async function toggleCapture(tabId) {
  const { captureState = 'idle', activeTabId } = await chrome.storage.session.get(['captureState', 'activeTabId']);

  // Ignore if in transition
  if (captureState === 'starting' || captureState === 'stopping') {
    console.log('[SW] Capture in transition, ignoring toggle');
    return;
  }

  if (captureState === 'idle') {
    await startCapture(tabId);
  } else if (captureState === 'capturing') {
    if (activeTabId === tabId) {
      // Same tab, stop capture
      await stopCapture();
    } else {
      // Different tab, switch capture
      try {
        await stopCapture();
      } catch (e) {
        console.warn('[SW] stopCapture failed during switch:', e);
      }
      await startCapture(tabId);
    }
  }
}

async function startCapture(tabId) {
  console.log(`[SW] Starting capture for tab ${tabId}`);

  // Check if the tab is a Chrome internal page
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || '';
    console.log(`[SW] Tab URL: ${url}`);

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
    const settings = await chrome.storage.local.get(['apiKey', 'targetLanguage']);
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId,
      settings: {
        apiKey: settings.apiKey || '',
        targetLanguage: settings.targetLanguage || 'zh-Hans',
      },
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to start capture');
    }

    await chrome.storage.session.set({ captureState: 'capturing' });
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
    console.log('[SW] Capture started');
  } catch (err) {
    console.error('[SW] Start capture failed:', err);
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
    throw err;
  }
}

async function stopCapture() {
  console.log('[SW] Stopping capture');
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
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null, lastHeartbeat: null });
  await chrome.action.setBadgeText({ text: '' });
  console.log('[SW] Capture stopped');
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
    console.log('[SW] Offscreen document already exists');
    return;
  }

  console.log('[SW] Creating offscreen document');
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
      console.log('[SW] Offscreen document closed');
    }
  } catch (e) {
    console.warn('[SW] Error closing offscreen document:', e);
  }
}

async function ensureContentScript(tabId) {
  // Always inject. content.js's init() is idempotent — if the host element
  // already exists it returns immediately. A fresh injection guarantees the
  // message listener is wired to the current extension context, not a stale one.
  console.log('[SW] Ensuring content script in tab', tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    console.warn('[SW] Content script injection:', e.message);
  }
}

console.log('[SW] Service worker loaded');
