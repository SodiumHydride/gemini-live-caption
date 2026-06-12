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
let heartbeatTimer = null;  // Keeps SW alive via periodic messages
let wsGeneration = 0;       // Tracks WebSocket connection generation; stopCapture increments it
let currentSettings = {};
let isReconnecting = false; // Guard: prevents watchdog from firing during reconnection
let resumptionHandle = null; // Session resumption token from Gemini (valid 2h)

// Device change detection: track current output device and rebuild audio chain on switch
let currentOutputDeviceId = null;
let deviceChangeDebounceTimer = null;
const DEVICE_CHANGE_DEBOUNCE_MS = 300;

// Session management state
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;  // More attempts for long sessions
const BASE_RECONNECT_DELAY = 3000; // 3s, doubles each attempt

// Caption watchdog: if WebSocket is open but no captions arrive for this duration,
// the session is silently dead (Gemini stopped transcribing). Force reconnect.
// Only fires when audio IS being sent (silence is not a failure).
const CAPTION_WATCHDOG_MS = 15000;
let captionWatchdogTimer = null;
let lastCaptionTime = 0;
let lastAudioSendTime = 0;  // Track when audio was last sent to Gemini

// Proactive session rotation: Gemini Live Translate sessions die after ~10 min.
// Instead of waiting for GoAway or silent death, rotate the session BEFORE it expires.
// This eliminates caption gaps — the new session is ready before the old one dies.
const SESSION_ROTATE_MS = 8 * 60 * 1000; // 8 minutes (before the ~10 min limit)
let sessionRotateTimer = null;
let sessionStartTime = 0;

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

    // Language change requires WebSocket reconnect with new setup
    if (msg.settings.targetLanguage) {
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
  };

  // Restore bilingualMode from settings
  bilingualMode = settings.bilingualMode ?? false;

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

  // Send audio processing parameters to worklet
  workletNode.port.postMessage({
    gain: currentSettings.audioGain,
    noiseGate: currentSettings.noiseGate,
  });

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
  wsGeneration++;  // Invalidate any in-flight WebSocket connections

  _stopDeviceMonitoring();
  stopCaptionWatchdog();
  stopSessionRotation();

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
        // Close WebSocket on timeout to prevent resource leak
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
        reject(new Error('WebSocket connection timeout'));
      }
    }, 15000);
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
    startCaptionWatchdog();
    startSessionRotation();
    resolve();
  }
}

function sendSetupMessage() {
  const targetLang = currentSettings.targetLanguage || 'zh-Hans';

  // Setup format for gemini-3.5-live-translate-preview
  // See: https://ai.google.dev/gemini-api/docs/live-api/live-translate
  //
  // Key: contextWindowCompression enables unlimited session duration.
  // Session resumption allows reconnecting with context preserved.
  const setupConfig = {
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
    // Session resumption: reconnect with handle to preserve context across the
    // ~10 min session limit. Does NOT degrade translation quality.
    // NOTE: contextWindowCompression is intentionally omitted — it causes
    // audio freezes (#1225) and premature turnComplete (#1227).
    sessionResumption: {},
  };

  // If we have a resumption handle from a previous session, include it
  if (resumptionHandle) {
    setupConfig.sessionResumption = {
      handle: resumptionHandle,
    };
    dbg(`Reconnecting with resumption handle: ${resumptionHandle.substring(0, 20)}...`);
  }

  const setupMsg = { setup: setupConfig };

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
    lastAudioSendTime = Date.now();
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
// TranscriptionProcessor: handles cumulative output from Gemini Live API
// with revision detection and stability buffering
class TranscriptionProcessor {
  constructor(options = {}) {
    this.STABILITY_THRESHOLD = options.stabilityThreshold || 0.8;
    this.BUFFER_KEEP = options.bufferKeep || 20;
    this.reset();
  }

  reset() {
    this.lastRawText = '';
    this.confirmedText = '';
    this.pendingBuffer = '';
    this.revisionCount = 0;
  }

  // Process new cumulative transcription text
  // Returns: { text: string, changed: boolean, isRevision: boolean }
  process(newFullText) {
    if (!newFullText) return { text: this.confirmedText, changed: false, isRevision: false };

    // Exact duplicate
    if (newFullText === this.lastRawText) {
      return { text: this.confirmedText, changed: false, isRevision: false };
    }

    const prevText = this.lastRawText;
    this.lastRawText = newFullText;

    // Detect if this is a revision (modification of previous text) or append
    const isRevision = this._detectRevision(prevText, newFullText);

    if (isRevision) {
      return this._handleRevision(prevText, newFullText);
    } else {
      return this._handleAppend(prevText, newFullText);
    }
  }

  _detectRevision(prev, curr) {
    if (!prev) return false;
    // If current text doesn't start with previous text, it's a revision
    return !curr.startsWith(prev);
  }

  _handleRevision(prev, curr) {
    this.revisionCount++;

    // Find first difference position
    const minLen = Math.min(prev.length, curr.length);
    let diffPos = 0;
    while (diffPos < minLen && prev[diffPos] === curr[diffPos]) {
      diffPos++;
    }

    // Keep confirmed text up to diff position
    this.confirmedText = curr.substring(0, diffPos);
    // Put remaining into pending buffer
    this.pendingBuffer = curr.substring(diffPos);

    dbg(`[TranscriptionProcessor] Revision detected at pos ${diffPos}, total revisions: ${this.revisionCount}`);

    return { text: this.confirmedText + this.pendingBuffer, changed: true, isRevision: true };
  }

  _handleAppend(prev, curr) {
    // Extract delta (new text after previous)
    const delta = curr.substring(prev.length);
    this.pendingBuffer += delta;

    // If buffer is long enough, confirm the front part
    if (this.pendingBuffer.length > this.BUFFER_KEEP * 2) {
      const toConfirm = this.pendingBuffer.substring(0, this.pendingBuffer.length - this.BUFFER_KEEP);
      this.confirmedText += toConfirm;
      this.pendingBuffer = this.pendingBuffer.substring(this.pendingBuffer.length - this.BUFFER_KEEP);
    }

    return { text: this.confirmedText + this.pendingBuffer, changed: true, isRevision: false };
  }

  // Force confirm all pending text (called on turnComplete, punctuation flush, etc.)
  flush() {
    this.confirmedText += this.pendingBuffer;
    this.pendingBuffer = '';
    return this.confirmedText;
  }

  getFullText() {
    return this.confirmedText + this.pendingBuffer;
  }

  getStats() {
    return {
      revisionCount: this.revisionCount,
      confirmedLength: this.confirmedText.length,
      pendingLength: this.pendingBuffer.length
    };
  }
}

// Create processor instances
const outputProcessor = new TranscriptionProcessor();
const inputProcessor = new TranscriptionProcessor({ bufferKeep: 10 });

let bilingualMode = false;  // Controlled by settings
let gapFlushTimer = null;
const GAP_FLUSH_MS = 700;   // Flush after 700ms of no new text (for talk-show/news)
const MIN_FLUSH_CHARS = 10; // Minimum chars before punctuation-based flush kicks in

// Punctuation-based segmentation: flush at first punctuation after MIN_FLUSH_CHARS
function tryFlushAtPunctuation() {
  const currentText = outputProcessor.getFullText();
  if (currentText.length < MIN_FLUSH_CHARS) return false;
  const ends = /[。！？.!?，,]/g;
  let m;
  while ((m = ends.exec(currentText)) !== null) {
    if (m.index >= MIN_FLUSH_CHARS - 1) {
      if (gapFlushTimer) { clearTimeout(gapFlushTimer); gapFlushTimer = null; }
      const toSend = currentText.substring(0, m.index + 1).trim();
      const remaining = currentText.substring(m.index + 1);
      outputProcessor.reset();
      if (remaining) outputProcessor.process(remaining);
      sendCaption(toSend, true);
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
    console.log(`[Offscreen] Scheduled rotation in ${parseDuration(timeLeft) - 2000}ms`);
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

  handleOutputTranscription(sc);
  handleInputTranscription(sc);
  handleModelTurn(sc);
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
  outputProcessor.reset();
  sendCaption('', false);
}

function handleOutputTranscription(sc) {
  if (!sc.outputTranscription || !sc.outputTranscription.text) return;

  if (!lastCaptionTime || (Date.now() - lastCaptionTime > 30000)) {
    dbg(`First caption after ${(Date.now() - (sessionStartTime || Date.now())) / 1000}s gap`);
  }

  const result = outputProcessor.process(sc.outputTranscription.text);
  if (!result.changed) return;

  const fullText = outputProcessor.getFullText();
  resetCaptionWatchdog();
  if (fullText.trim()) sendCaption(fullText.trim(), false);

  // Restart gap timer on each text arrival
  if (gapFlushTimer) clearTimeout(gapFlushTimer);
  gapFlushTimer = setTimeout(() => {
    gapFlushTimer = null;
    const currentText = outputProcessor.getFullText();
    if (!tryFlushAtPunctuation() && currentText.trim().length >= MIN_FLUSH_CHARS) {
      outputProcessor.flush();
      sendCaption(currentText.trim(), true);
    }
  }, GAP_FLUSH_MS);
}

function handleInputTranscription(sc) {
  if (!sc.inputTranscription || !sc.inputTranscription.text) return;
  inputProcessor.process(sc.inputTranscription.text);
  resetCaptionWatchdog();
}

function handleModelTurn(sc) {
  if (!sc.modelTurn || !sc.modelTurn.parts) return;

  for (const part of sc.modelTurn.parts) {
    if (part.text && !outputProcessor.getFullText().endsWith(part.text)) {
      outputProcessor.process(outputProcessor.getFullText() + part.text);
    }
  }
  if (outputProcessor.getFullText().trim()) {
    sendCaption(outputProcessor.getFullText().trim(), false);
  }
}

function handleSegmentation(sc) {
  tryFlushAtPunctuation();
}

function handleTurnComplete(sc) {
  if (!sc.outputTranscription?.finished && !sc.turnComplete && !sc.waitingForInput) return;

  const currentText = outputProcessor.getFullText();
  if (currentText.trim().length < MIN_FLUSH_CHARS) return;

  if (gapFlushTimer) { clearTimeout(gapFlushTimer); gapFlushTimer = null; }
  const flushed = outputProcessor.flush();
  sendCaption(flushed.trim(), true);
}

function handleBufferOverflow() {
  const fullText = outputProcessor.getFullText();
  if (fullText.length <= 150) return;

  console.warn('[Offscreen] Buffer overflow, force-flushing 150+ chars');
  const flushed = outputProcessor.flush();
  sendCaption(flushed.trim(), true);
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
  if (isReconnecting) {
    dbg('reconnectWebSocket: already in progress, skipping');
    return;
  }
  isReconnecting = true;
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
  outputProcessor.reset();
  inputProcessor.reset();
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
    if (!isCapturing || !setupComplete || isReconnecting) return;
    const now = Date.now();
    const sinceCaption = now - lastCaptionTime;
    const sinceAudio = now - lastAudioSendTime;

    // Only trigger if:
    // 1. No captions for CAPTION_WATCHDOG_MS (connection likely dead)
    // 2. Audio WAS sent recently (within 10s) — so it's not just silence
    // If no audio is flowing either, the user is just quiet — leave the connection alone.
    if (sinceCaption > CAPTION_WATCHDOG_MS && sinceAudio < 10000) {
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

function startSessionRotation() {
  stopSessionRotation();
  sessionStartTime = Date.now();
  sessionRotateTimer = setTimeout(() => {
    if (!isCapturing || isReconnecting) return;
    const uptime = Math.round((Date.now() - sessionStartTime) / 1000);
    console.log(`[Offscreen] Session rotation: session alive for ${uptime}s, rotating proactively`);
    sendStatus('reconnecting', 'Rotating session...');
    reconnectWebSocket();
  }, SESSION_ROTATE_MS);
}

function scheduleSessionRotation(delayMs) {
  stopSessionRotation();
  sessionRotateTimer = setTimeout(() => {
    if (!isCapturing || isReconnecting) return;
    console.log('[Offscreen] Scheduled session rotation triggered');
    sendStatus('reconnecting', 'Rotating session...');
    reconnectWebSocket();
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
  }, DEVICE_CHANGE_DEBOUNCE_MS);
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
        sendAudioToGemini(event.data.samples);
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
const MAX_SEND_FAILURES = 5;

function sendCaption(text, isFinal, originalText) {
  if (text) resetCaptionWatchdog();
  const msg = {
    type: 'CAPTION_UPDATE',
    text,
    isFinal,
  };
  if (bilingualMode) {
    msg.original = originalText || (isFinal ? inputProcessor.flush() : inputProcessor.getFullText());
  }
  chrome.runtime.sendMessage(msg).catch(err => {
    sendMessageFailCount++;
    if (sendMessageFailCount <= MAX_SEND_FAILURES) {
      console.warn(`[Offscreen] sendCaption failed (${sendMessageFailCount}/${MAX_SEND_FAILURES}):`, err.message);
    }
    if (sendMessageFailCount >= MAX_SEND_FAILURES && isCapturing) {
      console.error('[Offscreen] Too many send failures, triggering reconnect');
      reconnectWebSocket();
    }
  });
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
