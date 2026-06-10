// service-worker.js — Gemini Live Caption Extension
// Orchestrates tab capture, offscreen document, and message routing.

// ==================== EVENT LISTENERS (synchronous top-level registration) ====================

// Handle keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-capture') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await toggleCapture(tab.id);
  }
});

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
    // Forward from offscreen to content script
    (async () => {
      const { activeTabId } = await chrome.storage.session.get('activeTabId');
      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, {
            type: 'CAPTION_UPDATE',
            text: msg.text,
            isFinal: msg.isFinal,
          });
        } catch (err) {
          // Content script might not be ready yet
          console.warn('[SW] Failed to send caption to tab:', err.message);
        }
      }
    })();
    return false; // No response needed
  }

  if (msg.type === 'STATUS_UPDATE') {
    (async () => {
      console.log(`[SW] Status: ${msg.status} - ${msg.message}`);
      if (msg.status === 'error') {
        await chrome.action.setBadgeText({ text: 'ERR' });
        await chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
      } else if (msg.status === 'reconnecting') {
        await chrome.action.setBadgeText({ text: '...' });
        await chrome.action.setBadgeBackgroundColor({ color: '#FFA500' });
      } else if (msg.status === 'capturing') {
        await chrome.action.setBadgeText({ text: 'ON' });
        await chrome.action.setBadgeBackgroundColor({ color: '#00C853' });
      } else if (msg.status === 'idle') {
        await chrome.action.setBadgeText({ text: '' });
      }
    })();
    return false;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    (async () => {
      await chrome.storage.local.set(msg.settings);
      // Notify offscreen document of settings change
      try {
        await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: msg.settings });
      } catch (e) {
        // Offscreen may not exist yet
      }
      sendResponse({ success: true });
    })();
    return true;
  }
});

// Clean up when tab is closed or navigated
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (tabId === activeTabId) {
    console.log('[SW] Active tab closed, stopping capture');
    await stopCapture();
  }
});

// Handle extension install/update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[SW] Extension ${details.reason}`);
  // Initialize default settings
  const existing = await chrome.storage.local.get(['targetLanguage', 'apiKey']);
  if (!existing.targetLanguage) {
    await chrome.storage.local.set({
      apiKey: '',
      targetLanguage: 'zh-Hans',
      fontSize: 'medium',
      bgOpacity: 0.75,
    });
  }
  // Reset capture state
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
  await chrome.action.setBadgeText({ text: '' });
});

// ==================== CORE FUNCTIONS ====================

async function toggleCapture(tabId) {
  const { captureState = 'idle' } = await chrome.storage.session.get('captureState');

  // Ignore if in transition
  if (captureState === 'starting' || captureState === 'stopping') {
    console.log('[SW] Capture in transition, ignoring toggle');
    return;
  }

  if (captureState === 'idle') {
    await startCapture(tabId);
  } else if (captureState === 'capturing') {
    await stopCapture();
  }
}

async function startCapture(tabId) {
  console.log(`[SW] Starting capture for tab ${tabId}`);
  await chrome.storage.session.set({ captureState: 'starting', activeTabId: tabId });
  await chrome.action.setBadgeText({ text: '...' });
  await chrome.action.setBadgeBackgroundColor({ color: '#FFA500' });

  try {
    // 1. Get media stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    // 2. Read settings (offscreen can't access chrome.storage)
    const settings = await chrome.storage.local.get(['apiKey', 'targetLanguage']);

    // 3. Ensure offscreen document exists
    await ensureOffscreenDocument();

    // 4. Tell offscreen document to start capture with settings
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
    // Tell offscreen to stop
    await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  } catch (e) {
    // Offscreen might already be gone
  }

  // Send clear to content script
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'CLEAR_CAPTIONS' });
    } catch (e) {
      // Content script might be gone
    }
  }

  // Clean up offscreen document
  await closeOffscreenDocument();

  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
  await chrome.action.setBadgeText({ text: '' });
  console.log('[SW] Capture stopped');
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

console.log('[SW] Service worker loaded');
