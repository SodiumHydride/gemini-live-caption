// offscreen.js — Audio Capture + Gemini Live Translate WebSocket
// Runs in an offscreen document with full Web API access.

const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log('[Offscreen]', ...args); };

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let websocket = null;
let isCapturing = false;
let reconnectTimer = null;
let heartbeatTimer = null;  // Keeps SW alive via periodic messages
let wsGeneration = 0;       // Tracks WebSocket connection generation; stopCapture increments it
let currentSettings = {};

// Session management state
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

  if (msg.type === 'PING') {
    // Liveness check from service worker (used by recoverState).
    sendResponse({ alive: isCapturing });
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

  // 2. Create AudioContext at native sample rate (no resampling for playback)
  const inputSampleRate = mediaStream.getAudioTracks()[0]?.getSettings()?.sampleRate || 48000;
  dbg(`Input audio sample rate: ${inputSampleRate}Hz`);
  audioContext = new AudioContext({ sampleRate: inputSampleRate });
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

  // 6. Monitor audio stream — restart if tracks end (e.g. another tab steals audio focus)
  for (const track of mediaStream.getAudioTracks()) {
    track.onended = () => {
      console.warn('[SW] Audio track ended unexpectedly');
      if (isCapturing) {
        sendStatus('reconnecting', 'Audio lost, reconnecting...');
        stopCapture();
        // Notify service worker to restart
        chrome.runtime.sendMessage({ type: 'AUDIO_LOST' }).catch(() => {});
      }
    };
  }

  // 7. Monitor AudioContext — resume if suspended by Chrome
  if (audioContext.state === 'suspended') {
    console.log('[Offscreen] AudioContext suspended, resuming...');
    await audioContext.resume();
  }
  audioContext.onstatechange = () => {
    if (!audioContext) return;
    console.log(`[Offscreen] AudioContext state: ${audioContext.state}`);
    if (audioContext.state === 'suspended' && isCapturing) {
      audioContext.resume().catch(() => {});
    }
  };

  // 8. Connect to Gemini Live Translate API
  await connectWebSocket();

  isCapturing = true;
  sendStatus('capturing', 'Live caption active');

  // Start heartbeat to keep the service worker alive (SW idle timeout = 30s).
  // Also writes lastHeartbeat to chrome.storage.session so recoverState() can
  // verify the offscreen is actually alive after a SW restart.
  heartbeatTimer = setInterval(() => {
    if (!isCapturing) return;
    chrome.runtime.sendMessage({ type: 'HEARTBEAT' }).catch(() => {});
    chrome.storage?.session?.set({ lastHeartbeat: Date.now() }).catch(() => {});
  }, 20000);
  // Write initial heartbeat immediately
  chrome.storage?.session?.set({ lastHeartbeat: Date.now() }).catch(() => {});

  dbg('Capture started successfully');
}

function stopCapture() {
  isCapturing = false;
  wsGeneration++;  // Invalidate any in-flight WebSocket connections

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

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
  dbg('Capture stopped');
}

// ==================== GEMINI WEBSOCKET ====================
let setupComplete = false;

async function connectWebSocket() {
  const gen = ++wsGeneration;
  return new Promise((resolve, reject) => {
    const apiKey = currentSettings.apiKey;
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    dbg('Connecting to Gemini Live Translate...');
    setupComplete = false;
    const ws = new WebSocket(wsUrl);
    websocket = ws;

    ws.onopen = () => {
      if (gen !== wsGeneration) { ws.close(); return; }
      dbg('WebSocket connected, sending setup...');
      sendSetupMessage();
    };

    ws.onmessage = (event) => {
      if (gen !== wsGeneration) return;
      if (event.data instanceof Blob) {
        event.data.text().then((text) => {
          processMessage(text, resolve, reject);
        });
      } else {
        processMessage(event.data, resolve, reject);
      }
    };

    ws.onerror = (error) => {
      if (gen !== wsGeneration) return;
      console.error('[Offscreen] WebSocket error:', error);
      sendStatus('error', 'WebSocket connection error');
      if (!setupComplete) reject(new Error('WebSocket connection failed'));
    };

    ws.onclose = (event) => {
      if (gen !== wsGeneration) return;
      dbg(`WebSocket closed: code=${event.code}, isCapturing: ${isCapturing}`);
      if (isCapturing) {
        sendStatus('reconnecting', 'Connection lost, reconnecting...');
        scheduleReconnect();
      } else {
        dbg('WebSocket closed, not reconnecting');
      }
    };

    setTimeout(() => {
      if (gen !== wsGeneration) return;
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
    dbg('Received:', JSON.stringify(raw).substring(0, 200));
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

  // Setup format for gemini-3.5-live-translate-preview
  // See: https://ai.google.dev/gemini-api/docs/live-api/live-translate
  //
  // Proven pattern (kazunori279/live-translator, yangping4271/live-translator):
  // - No sessionResumption: causes translation cascade bugs (prev turn prepended to current)
  // - No contextWindowCompression: unnecessary for streaming translation, no history to compress
  // - GoAway → fresh session each time (98% pass rate vs 65% with resumption)
  // - Transcription configs inside generationConfig per official docs
  const setupMsg = {
    setup: {
      model: 'models/gemini-3.5-live-translate-preview',
      generationConfig: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: targetLang,
          echoTargetLanguage: false,
        },
      },
    },
  };

  websocket.send(JSON.stringify(setupMsg));
  dbg(`Setup sent: live-translate → ${targetLang}`);
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
      dbg('Gemini setup complete');
      sendStatus('capturing', 'Connected to Gemini 3.5 Live Translate');
      return;
    }

    // Error response from server
    if (msg.error) {
      console.error('[Offscreen] Server error:', msg.error);
      sendStatus('error', `Server error: ${msg.error.message || JSON.stringify(msg.error)}`);
      return;
    }

    // GoAway — server is about to disconnect, proactively reconnect with fresh session
    // (no session resumption — community-proven to avoid translation cascade bugs)
    if (msg.goAway) {
      console.warn(`[Offscreen] GoAway received, time left: ${msg.goAway.timeLeft}`);
      dbg(`isCapturing: ${isCapturing}, websocket state: ${websocket?.readyState}`);
      if (isCapturing) {
        sendStatus('reconnecting', 'Server disconnecting, reconnecting...');
        reconnectWebSocket();
      } else {
        console.warn('[Offscreen] GoAway received but isCapturing is false, not reconnecting');
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
      if (signals.length) dbg('Signals:', signals.join(', '));

      // Interrupted — clear buffer immediately
      if (sc.interrupted) {
        dbg('Generation interrupted');
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
        dbg('Generation complete');
      }

      // Input transcription — language detection (text not logged for privacy)
    }
  } catch (err) {
    console.error('[Offscreen] Failed to parse Gemini response:', err, data);
  }
}

// ==================== RECONNECTION ====================
function scheduleReconnect() {
  dbg(`scheduleReconnect called, attempts: ${reconnectAttempts}`);
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
  dbg(`Scheduling reconnect #${reconnectAttempts} in ${delay}ms...`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    dbg(`Reconnect timer fired, isCapturing: ${isCapturing}`);
    if (!isCapturing) return;
    try {
      await connectWebSocket();
      dbg('Reconnected successfully');
      reconnectAttempts = 0; // Reset on successful reconnect
    } catch (err) {
      console.error('[Offscreen] Reconnect failed:', err);
      scheduleReconnect();
    }
  }, delay);
}

function reconnectWebSocket() {
  dbg('reconnectWebSocket called');
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
  connectWebSocket().then(() => {
    dbg('Reconnect successful');
    reconnectAttempts = 0; // Reset on successful reconnect
  }).catch(err => {
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

dbg('Offscreen document loaded');
