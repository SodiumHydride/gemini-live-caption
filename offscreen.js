// offscreen.js — Audio Capture + Gemini Live Translate WebSocket
// Runs in an offscreen document with full Web API access.

const DEBUG = false;
const dbg = DEBUG ? (...args) => console.log('[Offscreen]', ...args) : () => {};

// ==================== DIAGNOSTIC LOG BUFFER ====================
// Ring buffer storing recent log entries for debugging without DevTools.
// Users can export this via the popup when something goes wrong.
const LOG_BUFFER_SIZE = 200;
const logBuffer = new Array(LOG_BUFFER_SIZE);
let logWriteIdx = 0;
let logCount = 0;

function _logEntry(level, ...args) {
  const entry = {
    ts: Date.now(),
    level,
    msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
  };
  logBuffer[logWriteIdx] = entry;
  logWriteIdx = (logWriteIdx + 1) % LOG_BUFFER_SIZE;
  logCount = Math.min(logCount + 1, LOG_BUFFER_SIZE);
}

// Override console methods to capture into ring buffer
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;

console.log = (...args) => { _logEntry('log', ...args); _origLog.apply(console, args); };
console.warn = (...args) => { _logEntry('warn', ...args); _origWarn.apply(console, args); };
console.error = (...args) => { _logEntry('error', ...args); _origError.apply(console, args); };

function getLogEntries(since = 0) {
  const entries = [];
  const count = Math.min(logCount, LOG_BUFFER_SIZE);
  const startIdx = logCount >= LOG_BUFFER_SIZE ? logWriteIdx : 0;
  for (let i = 0; i < count; i++) {
    const idx = (startIdx + i) % LOG_BUFFER_SIZE;
    const entry = logBuffer[idx];
    if (entry && entry.ts >= since) entries.push(entry);
  }
  return entries;
}

function clearLogBuffer() {
  logBuffer.fill(null);
  logWriteIdx = 0;
  logCount = 0;
}

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let websocket = null;
let isCapturing = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let wsGeneration = 0;
let currentSettings = {};
let isReconnecting = false;
let resumptionHandle = null;
let wsConnectTimeoutId = null;
let standbyWebsocket = null;   // warmed-up connection during hot-swap rotation
let isRotating = false;        // a make-before-break rotation is in progress

// Device change detection
let currentOutputDeviceId = null;
let deviceChangeDebounceTimer = null;

// Session management state
let reconnectAttempts = 0;
let captionWatchdogTimer = null;
let lastCaptionTime = 0;
let lastAudioSendTime = 0;
let lastNonSilentAudioTime = 0;
let lastSilenceProbeTime = 0;
let silenceTailUntil = 0;
let sessionRotateTimer = null;
let sessionStartTime = 0;

// Configuration constants
const CONFIG = {
  // Reconnection
  MAX_RECONNECT_ATTEMPTS: 8,
  BASE_RECONNECT_DELAY: 3000,      // 3s, doubles each attempt

  // Watchdog
  CAPTION_WATCHDOG_MS: 15000,      // 15s no captions = session dead
  WATCHDOG_AUDIO_THRESHOLD: 10000, // Only trigger if audio was sent within 10s

  // Session rotation
  SESSION_ROTATE_MS: 8 * 60 * 1000, // 8 minutes (before ~10 min limit)

  // Device change
  DEVICE_CHANGE_DEBOUNCE_MS: 300,

  // Transcription processing — sentence-aware segmentation
  GAP_FLUSH_MS: 1200,              // Finalize the current line after 1.2s of silence (was 700)
  MIN_SENTENCE_CHARS: 2,           // A sentence-ending punct finalizes even a short line (≥ this)
  MIN_FLUSH_CHARS: 10,             // Min length for a comma soft-break / gap pause flush
  SOFT_WRAP_CHARS: 56,             // Only break at a comma once the line is at least this long
  BUFFER_OVERFLOW_LIMIT: 140,      // Hard cap; break at nearest punct/space when exceeded
  PARTIAL_MIN_INTERVAL_MS: 120,    // Throttle live (partial) caption refreshes to reduce flicker

  // Heartbeat
  HEARTBEAT_INTERVAL_MS: 20000,    // 20s heartbeat to keep SW alive

  // WebSocket
  WS_CONNECT_TIMEOUT_MS: 15000,    // 15s connection timeout

  // Send failure
  MAX_SEND_FAILURES: 5,            // Auto-reconnect after 5 failures

  // Silence handling
  SILENCE_TAIL_MS: 900,             // Keep enough trailing room for model-side end-of-speech
  SILENCE_PROBE_INTERVAL_MS: 1500,  // Sparse silence probes keep stream state warm without flooding
};

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

    // Update bilingual mode
    if (msg.settings.bilingualMode !== undefined) {
      bilingualMode = msg.settings.bilingualMode;
    }

    // Update worklet parameters in real-time (no restart needed)
    if (workletNode && msg.settings.audioGain !== undefined) {
      workletNode.port.postMessage({ gain: msg.settings.audioGain });
    }
    if (workletNode && msg.settings.noiseGate !== undefined) {
      workletNode.port.postMessage({ noiseGate: msg.settings.noiseGate });
    }

    // Setup-level changes require WebSocket reconnect because Live API session
    // configuration is immutable after the opening setup message.
    if (msg.settings.targetLanguage || msg.settings.echoTargetLanguage !== undefined || msg.settings.captionTerminology !== undefined) {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        reconnectWebSocket();
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'PING') {
    // Liveness check from service worker (used by recoverState).
    sendResponse({ alive: isCapturing });
    return true;
  }

  if (msg.type === 'EXPORT_LOGS') {
    const entries = getLogEntries(msg.since || 0);
    sendResponse({ entries });
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
    audioGain: settings.audioGain ?? 1.0,
    noiseGate: settings.noiseGate ?? 0,
    echoTargetLanguage: settings.echoTargetLanguage ?? false,
    captionTerminology: settings.captionTerminology || '',
  };

  // Restore bilingualMode from settings
  bilingualMode = settings.bilingualMode ?? false;

  if (!currentSettings.apiKey) {
    throw new Error('No API key configured. Please set your Gemini API key in the extension settings.');
  }

  // Reset session state
  reconnectAttempts = 0;
  sendMessageFailCount = 0;
  lastAudioSendTime = 0;
  lastNonSilentAudioTime = 0;
  lastSilenceProbeTime = 0;
  silenceTailUntil = 0;
  captionSegmentSeq = 0;
  activeSegment = null;
  pendingSourceLanguage = '';
  pendingTargetLanguage = '';
  sessionStartTime = Date.now();

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

  // Send audio processing parameters to worklet
  workletNode.port.postMessage({
    gain: currentSettings.audioGain,
    noiseGate: currentSettings.noiseGate,
  });

  // 5. Handle PCM data from AudioWorklet
  workletNode.port.onmessage = (event) => {
    if (event.data.type === 'audio-data') {
      sendAudioToGemini(event.data.pcm, {
        rms: event.data.rms,
        hasSpeech: event.data.hasSpeech,
      });
    }
  };

  // 6. Monitor audio stream — restart if tracks end (e.g. another tab steals audio focus)
  for (const track of mediaStream.getAudioTracks()) {
    track.onended = () => {
      console.warn('[Offscreen] Audio track ended unexpectedly');
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
    dbg('[Offscreen] AudioContext suspended, resuming...');
    await audioContext.resume();
  }
  audioContext.onstatechange = () => {
    if (!audioContext) return;
    dbg(`AudioContext state: ${audioContext.state}`);
    if (audioContext.state === 'suspended' && isCapturing) {
      audioContext.resume().catch(err => {
        console.error('[Offscreen] AudioContext resume failed:', err);
        sendStatus('error', 'Audio suspended and cannot resume');
      });
    }
  };

  // 8. Monitor audio output device changes (e.g. headphone plug/unplug)
  //    When the default output device changes, the AudioContext may need full reconstruction.
  currentOutputDeviceId = await _getCurrentOutputDeviceId();
  _startDeviceMonitoring();

  // 8. Connect to Gemini Live Translate API
  await connectWebSocket();

  isCapturing = true;
  sendStatus('capturing', 'Live caption active');

  // Start heartbeat to keep the service worker alive (SW idle timeout = 30s).
  // Also writes lastHeartbeat to chrome.storage.session so recoverState() can
  // verify the offscreen is actually alive after a SW restart.
  heartbeatTimer = setInterval(() => {
    if (!isCapturing) return;
    chrome.runtime.sendMessage({ type: 'HEARTBEAT' }).catch(err => {
      console.warn('[Offscreen] Heartbeat failed (SW may be dead):', err.message);
    });
    chrome.storage?.session?.set({ lastHeartbeat: Date.now() }).catch(err => {
      console.warn('[Offscreen] Failed to write heartbeat:', err.message);
    });
  }, 20000);
  // Write initial heartbeat immediately
  chrome.storage?.session?.set({ lastHeartbeat: Date.now() }).catch(() => {});

  dbg('Capture started successfully');
}

function stopCapture() {
  isCapturing = false;
  isRotating = false;
  wsGeneration++;  // Invalidate any in-flight WebSocket connections

  if (standbyWebsocket) {
    try {
      standbyWebsocket.onopen = standbyWebsocket.onmessage = null;
      standbyWebsocket.onerror = standbyWebsocket.onclose = null;
      standbyWebsocket.close();
    } catch (e) {}
    standbyWebsocket = null;
  }

  _stopDeviceMonitoring();
  stopCaptionWatchdog();
  stopSessionRotation();

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (wsConnectTimeoutId) {
    clearTimeout(wsConnectTimeoutId);
    wsConnectTimeoutId = null;
  }

  if (gapFlushTimer) {
    clearTimeout(gapFlushTimer);
    gapFlushTimer = null;
  }

  if (partialThrottleTimer) {
    clearTimeout(partialThrottleTimer);
    partialThrottleTimer = null;
  }
  activeSegment = null;
  pendingSourceLanguage = '';
  pendingTargetLanguage = '';

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
      if (!setupComplete) {
        // Failed before the session was ever established — almost always a bad
        // API key or no network. Fail fast with a clear, user-facing message.
        if (wsConnectTimeoutId) { clearTimeout(wsConnectTimeoutId); wsConnectTimeoutId = null; }
        reject(new Error('Check your API key or network connection.'));
      } else {
        sendStatus('error', 'WebSocket connection error');
      }
    };

    ws.onclose = (event) => {
      if (gen !== wsGeneration) return;
      dbg(`WebSocket closed: code=${event.code}, isCapturing: ${isCapturing}`);
      if (!setupComplete) {
        // Closed before setup ever completed — fail fast instead of waiting for
        // the 15s connect timeout. Reject so the caller surfaces the error (on
        // first connect) or schedules a retry (on the reconnect path).
        if (wsConnectTimeoutId) { clearTimeout(wsConnectTimeoutId); wsConnectTimeoutId = null; }
        reject(new Error('Check your API key or network connection.'));
        return;
      }
      if (isCapturing) {
        sendStatus('reconnecting', 'Connection lost, reconnecting...');
        scheduleReconnect();
      } else {
        dbg('WebSocket closed, not reconnecting');
      }
    };

    wsConnectTimeoutId = setTimeout(() => {
      wsConnectTimeoutId = null;
      if (gen !== wsGeneration) return;
      if (!setupComplete) {
        // Close WebSocket on timeout to prevent resource leak
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
        reject(new Error('WebSocket connection timeout'));
      }
    }, CONFIG.WS_CONNECT_TIMEOUT_MS);
  });
}

// Process a single WebSocket message (string). Handles setup detection and error routing.
function processMessage(text, resolve, reject) {
  let msg;
  try {
    msg = JSON.parse(text);
    dbg('Received:', JSON.stringify(msg).substring(0, 200));
  } catch (e) {
    console.warn('[Offscreen] Failed to parse WebSocket message:', e.message);
    return;
  }

  handleGeminiResponse(msg);

  // Resolve on first meaningful response
  if (!setupComplete) {
    if (msg.error) {
      reject(new Error(`Server error: ${msg.error.message || JSON.stringify(msg.error)}`));
      return;
    }
    setupComplete = true;
    reconnectAttempts = 0;
    sendMessageFailCount = 0;  // Reset on successful connect
    startCaptionWatchdog();
    startSessionRotation();
    resolve();
  }
}

function buildSetupMessage() {
  const targetLang = currentSettings.targetLanguage || 'zh-Hans';

  // Setup format for gemini-3.5-live-translate-preview
  // See: https://ai.google.dev/gemini-api/docs/live-api/live-translate
  const setupConfig = {
    model: 'models/gemini-3.5-live-translate-preview',
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode: targetLang,
        echoTargetLanguage: !!currentSettings.echoTargetLanguage,
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Session resumption: reconnect with a handle to preserve context across the
    // ~10 min session limit. Does NOT degrade translation quality.
    // NOTE: contextWindowCompression is intentionally omitted — it causes
    // audio freezes (#1225) and premature turnComplete (#1227).
    sessionResumption: {},
  };

  setupConfig.systemInstruction = buildTranslationSystemInstruction(
    targetLang,
    currentSettings.captionTerminology || ''
  );

  // If we have a resumption handle from a previous session, include it
  if (resumptionHandle) {
    setupConfig.sessionResumption = { handle: resumptionHandle };
  }

  return { setup: setupConfig };
}

function buildTranslationSystemInstruction(targetLang, terminology) {
  const glossary = terminology.trim();
  const text = [
    'You are a realtime speech translator producing readable subtitles.',
    `Translate speech into ${targetLang}. Preserve speaker meaning; do not answer, explain, summarize, or add facts.`,
    'Keep names, numbers, dates, units, and product terms accurate. Prefer concise subtitle phrasing with natural punctuation.',
    glossary ? `Terminology and style rules:\n${glossary}` : 'Terminology and style rules: none',
  ].join('\n');
  return { parts: [{ text }] };
}

function sendSetupMessage() {
  websocket.send(JSON.stringify(buildSetupMessage()));
  dbg(`Setup sent: live-translate → ${currentSettings.targetLanguage || 'zh-Hans'}`);
}

// ==================== AUDIO STREAMING ====================
function sendAudioToGemini(pcmBuffer, activity = {}) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN || !setupComplete) return;

  const now = Date.now();
  if (activity.hasSpeech) {
    lastNonSilentAudioTime = now;
    silenceTailUntil = now + CONFIG.SILENCE_TAIL_MS;
  } else if (now > silenceTailUntil) {
    if (now - lastSilenceProbeTime < CONFIG.SILENCE_PROBE_INTERVAL_MS) return;
    lastSilenceProbeTime = now;
  }

  const base64 = arrayBufferToBase64(pcmBuffer);

  // Official live-translate frame shape (2026 docs): realtimeInput.audio holds a
  // single PCM Blob. The legacy realtimeInput.mediaChunks[] array is deprecated.
  const audioMsg = {
    realtimeInput: {
      audio: {
        data: base64,
        mimeType: 'audio/pcm;rate=16000',
      },
    },
  };

  try {
    lastAudioSendTime = now;
    websocket.send(JSON.stringify(audioMsg));
  } catch (err) {
    console.error('[Offscreen] Failed to send audio:', err);
    sendStatus('error', 'Audio send failed, reconnecting...');
    reconnectWebSocket();
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
let partialInputText = '';
let bilingualMode = false;
let gapFlushTimer = null;
let lastPartialSentTime = 0;
let partialThrottleTimer = null;
let captionSegmentSeq = 0;
let activeSegment = null;
let pendingSourceLanguage = '';
let pendingTargetLanguage = '';
// Sentence-aware segmentation.
//   1. Finalize at a sentence-ending punctuation (。！？.!? …) — a real sentence
//      boundary, kept with any trailing quotes/brackets. Even short sentences
//      finalize (MIN_SENTENCE_CHARS) so brief lines don't merge into the next.
//   2. Commas/semicolons only break once the line is past SOFT_WRAP_CHARS, so a
//      sentence isn't chopped into tiny lines while still capping line length.
// CJK enders split anywhere; ASCII .!? require a trailing space/end so we don't
// split decimals (1.5) or break mid-token.
const SENTENCE_END_RE = /[。！？…]+["'”’)\]】»」』]*|[.!?]+["'”’)\]]*(?=\s|$)/g;
const SOFT_BREAK_RE = /[，,、；;]/g;

function flushFinal(cutAt) {
  if (gapFlushTimer) { clearTimeout(gapFlushTimer); gapFlushTimer = null; }
  sendCaption(partialText.substring(0, cutAt).trim(), true);
  partialText = partialText.substring(cutAt);
  // Immediately surface the remaining tail as the new active line so a soft-wrap
  // split reads as "line 1 locked, line 2 continuing" instead of a brief shrink.
  if (partialText.trim()) sendPartialThrottled();
}

// Throttle partial (non-final) caption updates so the live line refreshes
// smoothly instead of flickering on every tiny transcription delta. A leading
// update fires immediately; further deltas within the window collapse into one
// trailing update that always sends the latest text.
function sendPartialThrottled() {
  const text = partialText.trim();
  if (!text) return;
  const elapsed = Date.now() - lastPartialSentTime;
  if (elapsed >= CONFIG.PARTIAL_MIN_INTERVAL_MS) {
    lastPartialSentTime = Date.now();
    sendCaption(text, false);
  } else if (!partialThrottleTimer) {
    partialThrottleTimer = setTimeout(() => {
      partialThrottleTimer = null;
      const latest = partialText.trim();
      if (latest) {
        lastPartialSentTime = Date.now();
        sendCaption(latest, false);
      }
    }, CONFIG.PARTIAL_MIN_INTERVAL_MS - elapsed);
  }
}

function tryFlushAtPunctuation() {
  if (partialText.length < CONFIG.MIN_SENTENCE_CHARS) return false;

  // Pass 1: sentence-ending punctuation — finalize even a short complete sentence
  // so brief utterances ("是的。") don't linger and merge into the next line.
  let m;
  SENTENCE_END_RE.lastIndex = 0;
  while ((m = SENTENCE_END_RE.exec(partialText)) !== null) {
    const end = m.index + m[0].length;
    if (end >= CONFIG.MIN_SENTENCE_CHARS) {
      flushFinal(end);
      return true;
    }
  }

  // Pass 2: soft break at comma/semicolon, but only on an already-long line.
  if (partialText.length >= CONFIG.SOFT_WRAP_CHARS) {
    let lastIdx = -1;
    SOFT_BREAK_RE.lastIndex = 0;
    while ((m = SOFT_BREAK_RE.exec(partialText)) !== null) {
      if (m.index + 1 >= CONFIG.MIN_FLUSH_CHARS) lastIdx = m.index + 1;
    }
    if (lastIdx > 0) {
      flushFinal(lastIdx);
      return true;
    }
  }

  return false;
}

function handleGeminiResponse(msg) {
  // Handle non-serverContent messages first
  if (msg.setupComplete) {
    dbg('Gemini setup complete');
    sendStatus('capturing', 'Connected to Gemini 3.5 Live Translate');
    return;
  }

  if (msg.sessionResumptionUpdate) {
    handleSessionResumption(msg.sessionResumptionUpdate);
    return;
  }

  if (msg.error) {
    handleServerError(msg.error);
    return;
  }

  if (msg.goAway) {
    handleGoAway(msg.goAway);
    return;
  }

  // Handle server content
  if (msg.serverContent) {
    handleServerContent(msg.serverContent);
  }
}

function handleSessionResumption(update) {
  const handle = update.newHandle;
  if (handle) {
    resumptionHandle = handle;
    dbg(`Session resumption handle saved: ${handle.substring(0, 20)}...`);
  }
}

function handleServerError(error) {
  console.error('[Offscreen] Server error:', error);
  sendStatus('error', `Server error: ${error.message || JSON.stringify(error)}`);
}

function handleGoAway(goAway) {
  const timeLeft = goAway.timeLeft;
  console.warn(`[Offscreen] GoAway received, time left: ${timeLeft}`);
  if (!isCapturing) return;

  if (timeLeft && parseDuration(timeLeft) > 5000) {
    scheduleSessionRotation(parseDuration(timeLeft) - 2000);
    dbg(`Scheduled rotation in ${parseDuration(timeLeft) - 2000}ms`);
  } else {
    sendStatus('reconnecting', 'Server disconnecting, reconnecting...');
    reconnectWebSocket();
  }
}

function handleServerContent(sc) {
  logSignals(sc);

  if (sc.interrupted) {
    handleInterrupted();
    return;
  }

  // Text source: in live-translate (AUDIO-only) mode the translated text always
  // arrives via outputTranscription. modelTurn.parts carry the translated AUDIO
  // (inlineData), which this extension does not play — so there is no separate
  // text stream to merge. Keeping a single source avoids duplicated/garbled text.
  handleOutputTranscription(sc);
  handleInputTranscription(sc);
  handleSegmentation(sc);
  handleTurnComplete(sc);
  handleBufferOverflow();
  handleGenerationComplete(sc);
  handleWatchdogReset(sc);
}

function logSignals(sc) {
  const signals = [];
  if (sc.turnComplete) signals.push('turnComplete');
  if (sc.generationComplete) signals.push('generationComplete');
  if (sc.waitingForInput) signals.push('waitingForInput');
  if (sc.interrupted) signals.push('interrupted');
  if (sc.outputTranscription?.finished) signals.push('outFinished');
  if (sc.outputTranscription?.text) signals.push(`outText(${sc.outputTranscription.text.length})`);
  if (sc.inputTranscription?.text) signals.push(`inText(${sc.inputTranscription.text.length})`);
  if (signals.length) dbg('Signals:', signals.join(', '));
}

function handleInterrupted() {
  dbg('Generation interrupted');
  partialText = '';
  partialInputText = '';
  activeSegment = null;
  pendingSourceLanguage = '';
  pendingTargetLanguage = '';
  sendCaption('', false);
}

function handleOutputTranscription(sc) {
  if (!sc.outputTranscription || !sc.outputTranscription.text) return;

  if (!lastCaptionTime || (Date.now() - lastCaptionTime > 30000)) {
    dbg(`First caption after ${(Date.now() - sessionStartTime) / 1000}s gap`);
  }

  const segment = ensureCaptionSegment();
  pendingTargetLanguage = sc.outputTranscription.languageCode || pendingTargetLanguage;
  if (pendingTargetLanguage) segment.targetLanguage = pendingTargetLanguage;
  partialText += sc.outputTranscription.text;
  resetCaptionWatchdog();
  sendPartialThrottled();

  // Restart gap timer on each text arrival
  if (gapFlushTimer) clearTimeout(gapFlushTimer);
  gapFlushTimer = setTimeout(() => {
    gapFlushTimer = null;
    // After a real pause, finalize the buffered line even if it's short, so a
    // brief utterance doesn't linger and merge into the next one.
    if (!tryFlushAtPunctuation() && partialText.trim().length > 0) {
      sendCaption(partialText.trim(), true);
      partialText = '';
    }
  }, CONFIG.GAP_FLUSH_MS);
}

function handleInputTranscription(sc) {
  if (!sc.inputTranscription || !sc.inputTranscription.text) return;
  pendingSourceLanguage = sc.inputTranscription.languageCode || pendingSourceLanguage;
  if (activeSegment && pendingSourceLanguage) activeSegment.sourceLanguage = pendingSourceLanguage;
  if (bilingualMode) {
    partialInputText += sc.inputTranscription.text;
  }
  resetCaptionWatchdog();
}

function handleSegmentation(sc) {
  tryFlushAtPunctuation();
}

function handleTurnComplete(sc) {
  if (!sc.outputTranscription?.finished && !sc.turnComplete && !sc.waitingForInput) return;

  // A turn boundary finalizes whatever is buffered — even a short sentence — so
  // the next turn starts on a clean line instead of concatenating onto this one.
  if (partialText.trim().length === 0) return;

  if (gapFlushTimer) { clearTimeout(gapFlushTimer); gapFlushTimer = null; }
  sendCaption(partialText.trim(), true);
  partialText = '';
}

function handleBufferOverflow() {
  if (partialText.length <= CONFIG.BUFFER_OVERFLOW_LIMIT) return;

  // Prefer a natural break (punctuation or whitespace) at or before the limit so
  // we never cut mid-word; fall back to a hard cap only if nothing better exists.
  const limit = CONFIG.BUFFER_OVERFLOW_LIMIT;
  const breakChars = /[。！？.!?…，,、；;：:\s]/g;
  let cut = -1;
  let m;
  while ((m = breakChars.exec(partialText)) !== null) {
    if (m.index + 1 <= limit) cut = m.index + 1; else break;
  }
  if (cut < CONFIG.MIN_FLUSH_CHARS) cut = limit; // no good break — hard cap
  console.warn(`[Offscreen] Buffer overflow, flushing ${cut} chars`);
  flushFinal(cut);
}

function handleGenerationComplete(sc) {
  if (sc.generationComplete) dbg('Generation complete');
}

function handleWatchdogReset(sc) {
  if (sc.inputTranscription && sc.inputTranscription.text) {
    resetCaptionWatchdog();
  }
}

// ==================== RECONNECTION ====================
function scheduleReconnect() {
  dbg(`scheduleReconnect called, attempts: ${reconnectAttempts}`);
  if (reconnectTimer) return;

  if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
    console.error('[Offscreen] Max reconnect attempts reached, giving up');
    sendStatus('error', `Connection failed after ${CONFIG.MAX_RECONNECT_ATTEMPTS} attempts`);
    stopCapture();
    return;
  }

  // Exponential backoff: 3s, 6s, 12s, 24s, 48s
  const delay = CONFIG.BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
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
  if (isReconnecting) {
    dbg('reconnectWebSocket: already in progress, skipping');
    return;
  }
  isReconnecting = true;
  isRotating = false;

  // Discard any half-warmed standby connection from an aborted hot-swap.
  if (standbyWebsocket) {
    try {
      standbyWebsocket.onopen = standbyWebsocket.onmessage = null;
      standbyWebsocket.onerror = standbyWebsocket.onclose = null;
      standbyWebsocket.close();
    } catch (e) {}
    standbyWebsocket = null;
  }

  // Clear any pending scheduled reconnect to avoid orphaned connections
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const reason = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
  dbg(`reconnectWebSocket called from: ${reason}`);
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
  partialInputText = '';
  activeSegment = null;
  pendingSourceLanguage = '';
  pendingTargetLanguage = '';
  const t0 = Date.now();
  connectWebSocket().then(() => {
    dbg(`Reconnect successful (took ${Date.now() - t0}ms), waiting for captions...`);
    isReconnecting = false;
    reconnectAttempts = 0; // Reset on successful reconnect
  }).catch(err => {
    console.error('[Offscreen] Reconnect failed:', err);
    isReconnecting = false;
    scheduleReconnect();
  });
}

// ==================== CAPTION WATCHDOG ====================
// Gemini Live Translate sessions silently die after ~10 minutes.
// The WebSocket stays open and audio keeps flowing, but the server
// stops sending transcriptions. This watchdog detects that state
// and forces a reconnection.

function startCaptionWatchdog() {
  stopCaptionWatchdog();
  lastCaptionTime = Date.now();
  captionWatchdogTimer = setInterval(() => {
    if (!isCapturing || !setupComplete || isReconnecting || isRotating) return;
    const now = Date.now();
    const sinceCaption = now - lastCaptionTime;
    const sinceAudio = now - lastNonSilentAudioTime;

    // Only trigger if:
    // 1. No captions for CAPTION_WATCHDOG_MS (connection likely dead)
    // 2. Non-silent audio was observed recently (within 10s) — so it's not just silence
    // If no audio is flowing either, the user is just quiet — leave the connection alone.
    if (sinceCaption > CONFIG.CAPTION_WATCHDOG_MS && sinceAudio < CONFIG.WATCHDOG_AUDIO_THRESHOLD) {
      console.warn(`[Offscreen] Watchdog: no captions for ${Math.round(sinceCaption/1000)}s but audio flowing, forcing reconnect`);
      sendStatus('reconnecting', 'Session stale, reconnecting...');
      reconnectWebSocket();
    }
  }, 10000); // Check every 10s
}

function stopCaptionWatchdog() {
  if (captionWatchdogTimer) {
    clearInterval(captionWatchdogTimer);
    captionWatchdogTimer = null;
  }
}

function resetCaptionWatchdog() {
  lastCaptionTime = Date.now();
}

// ==================== SESSION ROTATION ====================
// Proactively rotate the WebSocket session before Gemini kills it.
// This is the primary mechanism for seamless long-running captions.
// The watchdog is the safety net for silent failures.

// Make-before-break rotation: open a fully-initialized standby connection while
// the current one keeps translating, then atomically switch audio to it and
// close the old one. This removes the audio/caption gap that a plain
// close-then-reconnect (reconnectWebSocket) creates. Falls back to a normal
// reconnect if the standby fails to come up.
async function rotateSessionHotSwap() {
  if (!isCapturing || isReconnecting || isRotating) return;
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    // No healthy active connection to bridge from — just reconnect.
    reconnectWebSocket();
    return;
  }
  isRotating = true;
  dbg('Hot-swap rotation: warming up standby connection...');

  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${currentSettings.apiKey}`;
  const standby = new WebSocket(wsUrl);
  standbyWebsocket = standby;

  // Wait until the standby has connected and completed setup.
  let firstMsg;
  try {
    firstMsg = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(to); fn(arg); } };
      const to = setTimeout(() => finish(reject, new Error('standby setup timeout')), CONFIG.WS_CONNECT_TIMEOUT_MS);

      standby.onopen = () => {
        try { standby.send(JSON.stringify(buildSetupMessage())); }
        catch (e) { finish(reject, e); }
      };
      standby.onmessage = (event) => {
        const handle = (text) => {
          let msg;
          try { msg = JSON.parse(text); } catch { return; }
          if (msg.error) { finish(reject, new Error(msg.error.message || 'standby server error')); return; }
          finish(resolve, msg); // first non-error message = ready
        };
        if (event.data instanceof Blob) event.data.text().then(handle);
        else handle(event.data);
      };
      standby.onerror = () => finish(reject, new Error('standby socket error'));
      standby.onclose = () => finish(reject, new Error('standby closed before ready'));
    });
  } catch (err) {
    dbg('Hot-swap standby failed, falling back to reconnect:', err.message);
    try { standby.onopen = standby.onmessage = standby.onerror = standby.onclose = null; standby.close(); } catch (e) {}
    if (standbyWebsocket === standby) standbyWebsocket = null;
    isRotating = false;
    if (isCapturing) reconnectWebSocket();
    return;
  }

  // Abort if capture stopped (or another path took over) while warming up.
  if (!isCapturing || standbyWebsocket !== standby) {
    try { standby.onopen = standby.onmessage = standby.onerror = standby.onclose = null; standby.close(); } catch (e) {}
    if (standbyWebsocket === standby) standbyWebsocket = null;
    isRotating = false;
    return;
  }

  // ---- Atomic switch (synchronous; JS single-thread guarantees no interleave) ----
  const gen = ++wsGeneration;     // new active generation; invalidates the old socket's callbacks
  const oldWs = websocket;

  // Finalize residual text from the outgoing session so it isn't lost.
  if (partialText.trim().length >= CONFIG.MIN_FLUSH_CHARS) {
    sendCaption(partialText.trim(), true);
  }
  partialText = '';

  // Rewire the standby to the normal active-connection handlers.
  standby.onopen = null;
  standby.onmessage = (event) => {
    if (gen !== wsGeneration) return;
    if (event.data instanceof Blob) {
      event.data.text().then((t) => processMessage(t, () => {}, () => {}));
    } else {
      processMessage(event.data, () => {}, () => {});
    }
  };
  standby.onerror = (error) => {
    if (gen !== wsGeneration) return;
    console.error('[Offscreen] WebSocket error:', error);
    sendStatus('error', 'WebSocket connection error');
  };
  standby.onclose = (event) => {
    if (gen !== wsGeneration) return;
    dbg(`WebSocket closed: code=${event.code}, isCapturing: ${isCapturing}`);
    if (isCapturing) {
      sendStatus('reconnecting', 'Connection lost, reconnecting...');
      scheduleReconnect();
    }
  };

  websocket = standby;          // audio now flows to the new connection
  standbyWebsocket = null;
  setupComplete = true;         // standby already completed its setup

  // Process the first standby message (may carry a sessionResumptionUpdate).
  handleGeminiResponse(firstMsg);

  // Break: close the old connection now that the new one is carrying traffic.
  if (oldWs) {
    try { oldWs.onclose = null; oldWs.onmessage = null; oldWs.onerror = null; oldWs.close(); } catch (e) {}
  }

  // Reset session timers for the freshly-rotated session.
  startCaptionWatchdog();
  startSessionRotation();
  isRotating = false;
  dbg('Hot-swap rotation complete (zero-gap)');
}

function startSessionRotation() {
  stopSessionRotation();
  sessionStartTime = Date.now();
  sessionRotateTimer = setTimeout(() => {
    if (!isCapturing || isReconnecting || isRotating) return;
    const uptime = Math.round((Date.now() - sessionStartTime) / 1000);
    dbg(`Session rotation: session alive for ${uptime}s, rotating proactively`);
    rotateSessionHotSwap();
  }, CONFIG.SESSION_ROTATE_MS);
}

function scheduleSessionRotation(delayMs) {
  stopSessionRotation();
  sessionRotateTimer = setTimeout(() => {
    if (!isCapturing || isReconnecting || isRotating) return;
    dbg('Scheduled session rotation triggered');
    rotateSessionHotSwap();
  }, delayMs);
}

function stopSessionRotation() {
  if (sessionRotateTimer) {
    clearTimeout(sessionRotateTimer);
    sessionRotateTimer = null;
  }
}

// Parse GoAway timeLeft string to milliseconds.
// Gemini sends formats like "30s", "2m30s", "5m", "1h30m".
function parseDuration(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str; // Already numeric
  const match = String(str).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600 + parseInt(match[2] || 0) * 60 + parseInt(match[3] || 0)) * 1000;
}

// ==================== DEVICE CHANGE MONITORING ====================
// Detects audio output device changes (headphone plug/unplug, Bluetooth connect/disconnect).
// When the default output device changes, the AudioContext's internal routing may become stale,
// causing silent playback or capture failures. We rebuild the entire audio chain on change.

async function _getCurrentOutputDeviceId() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutput = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default');
    return audioOutput?.deviceId || null;
  } catch (err) {
    dbg('Failed to enumerate audio devices:', err.message);
    return null;
  }
}

function _startDeviceMonitoring() {
  if (!navigator.mediaDevices?.addEventListener) {
    dbg('devicechange monitoring not supported');
    return;
  }

  navigator.mediaDevices.addEventListener('devicechange', _onDeviceChange);
  dbg('Device change monitoring started');
}

function _stopDeviceMonitoring() {
  if (!navigator.mediaDevices?.removeEventListener) return;
  navigator.mediaDevices.removeEventListener('devicechange', _onDeviceChange);
  if (deviceChangeDebounceTimer) {
    clearTimeout(deviceChangeDebounceTimer);
    deviceChangeDebounceTimer = null;
  }
}

function _onDeviceChange() {
  // Debounce: multiple rapid events fire during device switch
  if (deviceChangeDebounceTimer) clearTimeout(deviceChangeDebounceTimer);
  deviceChangeDebounceTimer = setTimeout(() => {
    deviceChangeDebounceTimer = null;
    _handleDeviceChange();
  }, CONFIG.DEVICE_CHANGE_DEBOUNCE_MS);
}

async function _handleDeviceChange() {
  if (!isCapturing) return;

  const newDeviceId = await _getCurrentOutputDeviceId();
  dbg(`Device change detected: ${currentOutputDeviceId} → ${newDeviceId}`);

  if (newDeviceId === currentOutputDeviceId) {
    dbg('Device ID unchanged, ignoring');
    return;
  }

  currentOutputDeviceId = newDeviceId;
  sendStatus('reconnecting', 'Audio device changed, rebuilding...');

  // Full audio chain rebuild: AudioContext → MediaStreamSource → Worklet → WebSocket
  // We keep the WebSocket alive (no need to reconnect Gemini session),
  // but the audio capture path must be torn down and rebuilt.
  await _rebuildAudioChain();
}

async function _rebuildAudioChain() {
  dbg('Rebuilding audio chain...');

  // 1. Tear down existing audio nodes (keep WebSocket and mediaStream alive)
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }

  if (audioContext) {
    audioContext.onstatechange = null; // Prevent stale listener
    await audioContext.close().catch(() => {});
    audioContext = null;
  }

  // 2. Recreate AudioContext with the same stream
  if (!mediaStream) {
    dbg('No mediaStream available, cannot rebuild');
    sendStatus('error', 'Audio stream lost during device change');
    return;
  }

  const inputSampleRate = mediaStream.getAudioTracks()[0]?.getSettings()?.sampleRate || 48000;
  audioContext = new AudioContext({ sampleRate: inputSampleRate });
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(audioContext.destination);

  // 3. Reload and connect AudioWorklet
  try {
    const workletUrl = chrome.runtime.getURL('audio-processor.js');
    await audioContext.audioWorklet.addModule(workletUrl);
    workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');
    source.connect(workletNode);

    workletNode.port.postMessage({
      gain: currentSettings.audioGain,
      noiseGate: currentSettings.noiseGate,
    });

    workletNode.port.onmessage = (event) => {
      if (event.data.type === 'audio-data') {
        sendAudioToGemini(event.data.pcm, {
          rms: event.data.rms,
          hasSpeech: event.data.hasSpeech,
        });
      }
    };
  } catch (err) {
    console.error('[Offscreen] Failed to rebuild worklet:', err);
    sendStatus('error', 'Failed to rebuild audio processor');
    return;
  }

  // 4. Re-attach AudioContext state monitoring
  audioContext.onstatechange = () => {
    if (!audioContext) return;
    dbg(`AudioContext state: ${audioContext.state}`);
    if (audioContext.state === 'suspended' && isCapturing) {
      audioContext.resume().catch(() => {});
    }
  };

  // 5. Resume if suspended
  if (audioContext.state === 'suspended') {
    await audioContext.resume().catch(() => {});
  }

  dbg('Audio chain rebuilt successfully');
  sendStatus('capturing', 'Audio device switched, capture resumed');
}

// ==================== HELPERS ====================
let sendMessageFailCount = 0;

function sendCaption(text, isFinal, originalText) {
  if (text) resetCaptionWatchdog();
  // A finalized line supersedes any pending throttled partial update, so the
  // just-finalized text can't reappear as a stale live line afterwards.
  if (isFinal && partialThrottleTimer) {
    clearTimeout(partialThrottleTimer);
    partialThrottleTimer = null;
    lastPartialSentTime = 0;
  }
  const segment = text ? ensureCaptionSegment() : activeSegment;
  const endedAt = isFinal && segment ? Math.max(Date.now(), segment.startedAt + 1) : null;
  const msg = {
    type: 'CAPTION_UPDATE',
    text,
    isFinal,
  };
  if (segment) {
    msg.segmentId = segment.id;
    msg.startedAt = segment.startedAt;
    if (isFinal) msg.endedAt = endedAt;
    msg.sourceLanguage = segment.sourceLanguage || pendingSourceLanguage || '';
    msg.targetLanguage = segment.targetLanguage || currentSettings.targetLanguage || '';
  }
  if (bilingualMode) {
    msg.original = originalText || (isFinal ? partialInputText.trim() : '');
    if (isFinal) partialInputText = '';
  }
  chrome.runtime.sendMessage(msg).then(() => {
    sendMessageFailCount = 0;  // Reset consecutive failure count on success
  }).catch(err => {
    sendMessageFailCount++;
    if (sendMessageFailCount <= CONFIG.MAX_SEND_FAILURES) {
      console.warn(`[Offscreen] sendCaption failed (${sendMessageFailCount}/${CONFIG.MAX_SEND_FAILURES}):`, err.message);
    }
    if (sendMessageFailCount >= CONFIG.MAX_SEND_FAILURES && isCapturing) {
      console.error('[Offscreen] Too many send failures, triggering reconnect');
      reconnectWebSocket();
    }
  });
  if (isFinal) {
    activeSegment = null;
    pendingSourceLanguage = '';
    pendingTargetLanguage = '';
  }
}

function ensureCaptionSegment() {
  if (!activeSegment) {
    activeSegment = {
      id: `${sessionStartTime}-${++captionSegmentSeq}`,
      startedAt: Date.now(),
      sourceLanguage: pendingSourceLanguage,
      targetLanguage: pendingTargetLanguage || currentSettings.targetLanguage || '',
    };
  }
  return activeSegment;
}

function sendStatus(status, message) {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    status,
    message,
  }).catch(err => {
    console.warn('[Offscreen] sendStatus failed:', err.message);
  });
}

dbg('Offscreen document loaded');
