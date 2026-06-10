// offscreen.js — Audio Capture + Gemini Live Translate WebSocket
// Runs in an offscreen document with full Web API access.
//
// Key design decisions (from official docs 2026-06-09):
// - gemini-3.5-live-translate-preview is NOT a conversation model.
//   It's a continuous streaming translation pipeline: audio in → translated audio out.
//   No system instructions, no tools, no text input.
// - Audio chunks: 100ms (official recommendation for live-translate).
// - Setup uses translationConfig, NOT speechConfig.
// - Session management: contextWindowCompression + sessionResumption for long sessions.
// - GoAway: server sends this before disconnecting; handle it proactively.

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let websocket = null;
let isCapturing = false;
let reconnectTimer = null;
let currentSettings = {};

// Session management state
let sessionResumptionHandle = null;  // For seamless reconnection across WebSocket resets
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 3000; // 3s, doubles each attempt

// ==================== MESSAGE HANDLER ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    (async () => {
      try {
        await startCapture(msg.streamId, msg.settings || {});
        sendResponse({ success: true });
      } catch (err) {
        console.error('[Offscreen] Start capture failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    currentSettings = { ...currentSettings, ...msg.settings };
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      reconnectWebSocket();
    }
    sendResponse({ success: true });
    return true;
  }
});

// ==================== AUDIO CAPTURE ====================
async function startCapture(streamId, settings) {
  if (isCapturing) {
    console.warn('[Offscreen] Already capturing, stopping first...');
    stopCapture();
  }

  currentSettings = {
    apiKey: settings.apiKey || '',
    targetLanguage: settings.targetLanguage || 'zh-Hans',
  };

  if (!currentSettings.apiKey) {
    throw new Error('No API key configured. Please set your Gemini API key in the extension settings.');
  }

  // Reset session state
  sessionResumptionHandle = null;
  reconnectAttempts = 0;

  // 1. Get the media stream from the tab
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // 2. Create AudioContext at 16kHz (Gemini's native input rate)
  audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);

  // 3. Keep audio playing through speakers
  source.connect(audioContext.destination);

  // 4. Load and connect AudioWorklet
  const workletUrl = chrome.runtime.getURL('audio-processor.js');
  await audioContext.audioWorklet.addModule(workletUrl);
  workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');
  source.connect(workletNode);

  // 5. Handle PCM data from AudioWorklet
  workletNode.port.onmessage = (event) => {
    if (event.data.type === 'audio-data') {
      sendAudioToGemini(event.data.samples);
    }
  };

  // 6. Connect to Gemini Live Translate API
  await connectWebSocket();

  isCapturing = true;
  sendStatus('capturing', 'Live caption active');
  console.log('[Offscreen] Capture started successfully');
}

function stopCapture() {
  isCapturing = false;

  if (gapFlushTimer) {
    clearTimeout(gapFlushTimer);
    gapFlushTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (websocket) {
    websocket.onclose = null;
    websocket.close();
    websocket = null;
  }

  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  sendStatus('idle', 'Caption stopped');
  console.log('[Offscreen] Capture stopped');
}

// ==================== GEMINI WEBSOCKET ====================
let setupComplete = false;

async function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const apiKey = currentSettings.apiKey;
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    console.log('[Offscreen] Connecting to Gemini Live Translate...');
    setupComplete = false;
    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log('[Offscreen] WebSocket connected, sending setup...');
      sendSetupMessage();
    };

    websocket.onmessage = (event) => {
      // Server may send Blob (binary frames) or string — handle both
      if (event.data instanceof Blob) {
        event.data.text().then((text) => {
          processMessage(text, resolve, reject);
        });
      } else {
        processMessage(event.data, resolve, reject);
      }
    };

    websocket.onerror = (error) => {
      console.error('[Offscreen] WebSocket error:', error);
      sendStatus('error', 'WebSocket connection error');
      if (!setupComplete) reject(new Error('WebSocket connection failed'));
    };

    websocket.onclose = (event) => {
      console.log(`[Offscreen] WebSocket closed: code=${event.code}, reason=${event.reason}`);
      if (isCapturing) {
        sendStatus('reconnecting', 'Connection lost, reconnecting...');
        scheduleReconnect();
      }
    };

    setTimeout(() => {
      if (!setupComplete) {
        reject(new Error('WebSocket connection timeout'));
      }
    }, 15000);
  });
}

// Process a single WebSocket message (string). Handles setup detection and error routing.
function processMessage(text, resolve, reject) {
  try {
    const raw = JSON.parse(text);
    console.log('[Offscreen] Received:', JSON.stringify(raw).substring(0, 500));
  } catch (e) {}

  handleGeminiResponse(text);

  // Resolve on first meaningful response
  if (!setupComplete) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) {
        reject(new Error(`Server error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
        return;
      }
    } catch (e) {}
    setupComplete = true;
    reconnectAttempts = 0;
    resolve();
  }
}

function sendSetupMessage() {
  const targetLang = currentSettings.targetLanguage || 'zh-Hans';

  // Official setup format for gemini-3.5-live-translate-preview
  // See: https://ai.google.dev/gemini-api/docs/live-api/live-translate
  //
  // CRITICAL: Uses translationConfig, NOT speechConfig.
  // CRITICAL: inputAudioTranscription/outputAudioTranscription go at SETUP level,
  //           NOT inside generationConfig. Server rejects them inside generationConfig.
  const setupMsg = {
    setup: {
      model: 'models/gemini-3.5-live-translate-preview',
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: targetLang,
          echoTargetLanguage: false,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Session resumption for seamless reconnection
      ...(sessionResumptionHandle ? {
        sessionResumption: {
          handle: sessionResumptionHandle,
        },
      } : {}),
    },
  };

  websocket.send(JSON.stringify(setupMsg));
  console.log(`[Offscreen] Setup sent: live-translate → ${targetLang}`);
  console.log('[Offscreen] Setup message:', JSON.stringify(setupMsg, null, 2));
}

// ==================== AUDIO STREAMING ====================
function sendAudioToGemini(float32Samples) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN || !setupComplete) return;

  // Convert Float32 PCM to Int16 PCM (little-endian)
  const int16 = new Int16Array(float32Samples.length);
  for (let i = 0; i < float32Samples.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const base64 = arrayBufferToBase64(int16.buffer);

  const audioMsg = {
    realtimeInput: {
      mediaChunks: [
        {
          data: base64,
          mimeType: 'audio/pcm;rate=16000',
        },
      ],
    },
  };

  try {
    websocket.send(JSON.stringify(audioMsg));
  } catch (err) {
    console.error('[Offscreen] Failed to send audio:', err);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ==================== RESPONSE HANDLING ====================
let partialText = '';
let gapFlushTimer = null;
const GAP_FLUSH_MS = 700;   // Flush after 700ms of no new text (for talk-show/news)
const MIN_FLUSH_CHARS = 10; // Minimum chars before punctuation-based flush kicks in

function handleGeminiResponse(data) {
  try {
    const msg = JSON.parse(data);

    // Setup complete confirmation
    if (msg.setupComplete) {
      console.log('[Offscreen] Gemini setup complete');
      sendStatus('capturing', 'Connected to Gemini 3.5 Live Translate');
      return;
    }

    // Error response from server
    if (msg.error) {
      console.error('[Offscreen] Server error:', msg.error);
      sendStatus('error', `Server error: ${msg.error.message || JSON.stringify(msg.error)}`);
      return;
    }

    // Session resumption update — save handle for reconnection
    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) {
        sessionResumptionHandle = update.newHandle;
        console.log('[Offscreen] Session resumption handle saved');
      }
    }

    // GoAway — server is about to disconnect, proactively reconnect
    if (msg.goAway) {
      console.warn(`[Offscreen] GoAway received, time left: ${msg.goAway.timeLeft}`);
      if (isCapturing) {
        sendStatus('reconnecting', 'Server disconnecting, reconnecting...');
        reconnectWebSocket();
      }
      return;
    }

    // Server content
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Debug: log which signals are present
      const signals = [];
      if (sc.turnComplete) signals.push('turnComplete');
      if (sc.generationComplete) signals.push('generationComplete');
      if (sc.waitingForInput) signals.push('waitingForInput');
      if (sc.interrupted) signals.push('interrupted');
      if (sc.outputTranscription?.finished) signals.push('outFinished');
      if (sc.outputTranscription?.text) signals.push(`outText(${sc.outputTranscription.text.length})`);
      if (sc.inputTranscription?.text) signals.push(`inText(${sc.inputTranscription.text.length})`);
      if (signals.length) console.debug('[Offscreen] Signals:', signals.join(', '));

      // Interrupted — clear buffer immediately
      if (sc.interrupted) {
        console.log('[Offscreen] Generation interrupted');
        partialText = '';
        sendCaption('', false);
        return;
      }

      // Accumulate output transcription text into buffer
      if (sc.outputTranscription && sc.outputTranscription.text) {
        partialText += sc.outputTranscription.text;
        // Show as live preview (isFinal=false)
        if (partialText.trim()) sendCaption(partialText.trim(), false);

        // Restart gap timer on each text arrival
        if (gapFlushTimer) clearTimeout(gapFlushTimer);
        gapFlushTimer = setTimeout(() => {
          gapFlushTimer = null;
          // Gap flush: try punctuation first, else flush only if long enough
          if (!tryFlushAtPunctuation() && partialText.trim().length >= MIN_FLUSH_CHARS) {
            sendCaption(partialText.trim(), true);
            partialText = '';
          }
        }, GAP_FLUSH_MS);
      }

      // Also check modelTurn text parts (fallback)
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.text && !partialText.includes(part.text)) {
            partialText += part.text;
          }
        }
        if (partialText.trim()) sendCaption(partialText.trim(), false);
      }

      // === Segmentation: breath-based flush at punctuation ===
      // Cut at the first punctuation after MIN_FLUSH_CHARS ("气口").
      // Short fragments are NEVER flushed — they accumulate into the next segment.
      // This prevents "嗯。" / "首先" from becoming standalone subtitles.

      const tryFlushAtPunctuation = () => {
        if (partialText.length < MIN_FLUSH_CHARS) return false; // Too short, keep accumulating
        const ends = /[。！？.!?，,]/g;
        let m;
        while ((m = ends.exec(partialText)) !== null) {
          if (m.index >= MIN_FLUSH_CHARS - 1) {
            // Found punctuation after minimum chars — cut here
            if (gapFlushTimer) { clearTimeout(gapFlushTimer); gapFlushTimer = null; }
            sendCaption(partialText.substring(0, m.index + 1).trim(), true);
            partialText = partialText.substring(m.index + 1);
            return true;
          }
        }
        return false; // No punctuation found after MIN_FLUSH_CHARS
      };

      // Try flush on any model signal — but only if buffer is long enough
      tryFlushAtPunctuation();

      // Model turn/segment signals — only flush if buffer >= MIN_FLUSH_CHARS
      // Short buffers are left for the gap timer to accumulate further
      if (sc.outputTranscription?.finished || sc.turnComplete || sc.waitingForInput) {
        if (partialText.trim().length >= MIN_FLUSH_CHARS) {
          // Enough text — flush even without punctuation
          if (gapFlushTimer) { clearTimeout(gapFlushTimer); gapFlushTimer = null; }
          sendCaption(partialText.trim(), true);
          partialText = '';
        }
        // else: too short, keep accumulating (gap timer will handle it)
      }

      // Fallback: safety valve for very long turns without any signal or punctuation
      if (partialText.length > 150) {
        console.warn('[Offscreen] Buffer overflow, force-flushing 150+ chars');
        sendCaption(partialText.trim(), true);
        partialText = '';
      }

      // Generation complete — log only
      if (sc.generationComplete) {
        console.debug('[Offscreen] Generation complete');
      }

      // Input transcription — original language
      if (sc.inputTranscription && sc.inputTranscription.text) {
        console.log(`[Offscreen] Original (${sc.inputTranscription.languageCode || '?'}): ${sc.inputTranscription.text}`);
      }
    }
  } catch (err) {
    console.error('[Offscreen] Failed to parse Gemini response:', err, data);
  }
}

// ==================== RECONNECTION ====================
function scheduleReconnect() {
  if (reconnectTimer) return;

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[Offscreen] Max reconnect attempts reached, giving up');
    sendStatus('error', `Connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    stopCapture();
    return;
  }

  // Exponential backoff: 3s, 6s, 12s, 24s, 48s
  const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;
  console.log(`[Offscreen] Scheduling reconnect #${reconnectAttempts} in ${delay}ms...`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!isCapturing) return;
    try {
      await connectWebSocket();
      console.log('[Offscreen] Reconnected successfully');
    } catch (err) {
      console.error('[Offscreen] Reconnect failed:', err);
      scheduleReconnect();
    }
  }, delay);
}

function reconnectWebSocket() {
  if (websocket) {
    websocket.onclose = null;
    websocket.close();
    websocket = null;
  }
  if (gapFlushTimer) {
    clearTimeout(gapFlushTimer);
    gapFlushTimer = null;
  }
  setupComplete = false;
  partialText = '';
  connectWebSocket().catch(err => {
    console.error('[Offscreen] Reconnect failed:', err);
    scheduleReconnect();
  });
}

// ==================== HELPERS ====================
function sendCaption(text, isFinal) {
  chrome.runtime.sendMessage({
    type: 'CAPTION_UPDATE',
    text,
    isFinal,
  }).catch(() => {});
}

function sendStatus(status, message) {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    status,
    message,
  }).catch(() => {});
}

console.log('[Offscreen] Offscreen document loaded');
