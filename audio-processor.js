// audio-processor.js — Dynamic Sample Rate AudioWorklet Processor
// High-quality downsampling from any input rate to 16kHz for Gemini API
//
// Architecture:
//   Input: Any sample rate mono Float32 from AudioContext (44.1kHz, 48kHz, 96kHz, etc.)
//   Output (worklet port): 16kHz Int16 PCM chunks (100ms) → Gemini API
//   Pass-through: original audio goes to AudioContext.destination for playback (no resampling)

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // === Polyphase Decimation Configuration ===
    // Input rate is dynamic (matches AudioContext sample rate)
    this.OUTPUT_RATE = 16000;
    // M will be calculated after we know the input rate
    this.M = null;

    // Get sample rate from AudioWorkletProcessor
    this.sampleRate = sampleRate;

    // Design parameters
    const AS = 80;           // Stopband attenuation (dB)
    const FC = 8000;         // Cutoff frequency (Hz)
    const TRANSITION = 1500; // Transition bandwidth (Hz)

    // Filter will be initialized on first process() call when we know sample rate
    this.initialized = false;
    this.firCoeffs = null;
    this.phases = null;
    this.buffer = null;
    this.outputBuffer = null;

    // Audio processing parameters (adjustable via port messages)
    this.gain = 1.0;        // Multiplier applied to input samples before processing
    this.noiseGate = 0;     // RMS threshold; blocks below this are zeroed (with hangover)

    // Noise-gate hangover: once speech is detected, keep the gate open for a
    // short tail so soft word endings / low-energy onsets aren't clipped.
    // Assumes the AudioWorklet render quantum of 128 samples per process() call.
    this.GATE_HANGOVER_MS = 250;
    this.gateHangoverFrames = Math.ceil((this.GATE_HANGOVER_MS / 1000) * this.sampleRate / 128);
    this.gateHold = 0;

    this.port.onmessage = (e) => {
      if (e.data.gain !== undefined) this.gain = e.data.gain;
      if (e.data.noiseGate !== undefined) this.noiseGate = e.data.noiseGate;
    };
  }

  _initialize(sampleRate) {
    const INPUT_RATE = sampleRate;
    const OUTPUT_RATE = this.OUTPUT_RATE;

    // Calculate decimation factor (must be integer for polyphase)
    // If not integer, we'll use a simple approach: resample in process()
    this.M = Math.round(INPUT_RATE / OUTPUT_RATE);
    if (Math.abs(INPUT_RATE / OUTPUT_RATE - this.M) > 0.01) {
      // Non-integer ratio, use simple resampling
      this.M = null;
      this.resampleRatio = INPUT_RATE / OUTPUT_RATE;
      console.log(`[PolyphaseDecimator] Non-integer ratio ${INPUT_RATE}/${OUTPUT_RATE} = ${this.resampleRatio.toFixed(3)}, using linear interpolation`);
    } else {
      console.log(`[PolyphaseDecimator] Integer ratio ${INPUT_RATE}/${OUTPUT_RATE} = ${this.M}, using polyphase`);
    }

    if (this.M !== null) {
      // Integer ratio: use polyphase FIR
      const AS = 80;           // Stopband attenuation (dB)
      const FC = OUTPUT_RATE / 2; // Cutoff frequency = Nyquist of output
      const TRANSITION = 1500; // Transition bandwidth (Hz)

      this.firCoeffs = this._designKaiserFIR(FC, TRANSITION, AS, INPUT_RATE);
      this.firLength = this.firCoeffs.length;

      // Polyphase decomposition
      this.phases = [];
      for (let p = 0; p < this.M; p++) {
        const subFilter = [];
        for (let i = p; i < this.firLength; i += this.M) {
          subFilter.push(this.firCoeffs[i]);
        }
        this.phases.push(new Float32Array(subFilter));
      }

      // Circular buffer
      this.bufferSize = Math.ceil(this.firLength / this.M) * this.M;
      this.buffer = new Float32Array(this.bufferSize);
      this.bufferWriteIdx = 0;
      this.sampleCount = 0;
      this.outputSampleCount = 0;
    } else {
      // Non-integer ratio: use ring buffer for linear interpolation
      // Size: one process() call (128 samples) + ceil(resampleRatio) slack for
      // read-position overshoot + 2 for two-sample interpolation reads
      this.inputBufferSize = 128 + Math.ceil(this.resampleRatio) + 2;
      this.inputBuffer = new Float32Array(this.inputBufferSize);
      this.inputWriteIdx = 0;
      this.readPos = 0;  // fractional read position (independent accumulator)
      this.totalInputSamples = 0;  // global counter for valid-sample boundary
    }

    // Output accumulation buffer: 100ms at 16kHz = 1600 samples
    this.CHUNK_SAMPLES = 1600;
    this.outputBuffer = new Int16Array(this.CHUNK_SAMPLES);
    this.outputWriteIdx = 0;
    this.outputEnergySum = 0;
    this.outputEnergyCount = 0;

    this.initialized = true;
    console.log(`[PolyphaseDecimator] Initialized: ${INPUT_RATE}Hz → ${OUTPUT_RATE}Hz`);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    let channelData = input[0]; // Mono, 128 samples per call
    if (!channelData) return true;

    // Apply gain in-place (only affects audio sent to the model, not playback).
    // Use a soft limiter instead of hard clipping so loud peaks don't distort —
    // hard clamping injects harmonics that degrade recognition/translation.
    if (this.gain !== 1.0) {
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = this._softClip(channelData[i] * this.gain);
      }
    }

    // Noise gate with hangover: zero out blocks below the RMS threshold, but keep
    // the gate open for a short tail after speech so soft endings aren't clipped.
    if (this.noiseGate > 0) {
      let sumSq = 0;
      for (let i = 0; i < channelData.length; i++) sumSq += channelData[i] * channelData[i];
      const rms = Math.sqrt(sumSq / channelData.length);
      if (rms >= this.noiseGate) {
        this.gateHold = this.gateHangoverFrames; // speech — open & refresh hold
      } else if (this.gateHold > 0) {
        this.gateHold--;                         // within hangover — keep passing
      } else {
        channelData.fill(0);                     // silence — gate closed
      }
    }

    // Initialize on first call when we know the sample rate
    if (!this.initialized) {
      this._initialize(this.sampleRate || sampleRate);
    }

    if (this.M !== null) {
      // Integer ratio: use polyphase FIR
      for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bufferWriteIdx] = channelData[i];
        this.bufferWriteIdx = (this.bufferWriteIdx + 1) % this.bufferSize;
        this.sampleCount++;

        if (this.sampleCount % this.M === 0) {
          const phase = this.outputSampleCount % this.M;
          const downsampled = this._applyPolyphaseFilter(phase);
          this.outputSampleCount++;
          this._writeOutputSample(downsampled);
        }
      }
    } else {
      // Non-integer ratio: linear interpolation resampling
      // readPos is an independent fractional accumulator (in input-sample units).
      // Each output sample advances readPos by resampleRatio.
      // Floor(readPos) = input sample index, frac = interpolation weight.
      for (let i = 0; i < channelData.length; i++) {
        // Write to ring buffer
        this.inputBuffer[this.inputWriteIdx] = channelData[i];
        this.inputWriteIdx = (this.inputWriteIdx + 1) % this.inputBufferSize;
        this.totalInputSamples++;

        // Produce output samples: need floor(readPos)+1 to be a valid (written) sample
        while (this.readPos + 1 < this.totalInputSamples) {
          const idx0 = Math.floor(this.readPos) % this.inputBufferSize;
          const idx1 = (idx0 + 1) % this.inputBufferSize;
          const frac = this.readPos - Math.floor(this.readPos);

          const sample = this.inputBuffer[idx0] * (1 - frac) +
                        this.inputBuffer[idx1] * frac;

          this._writeOutputSample(sample);

          this.readPos += this.resampleRatio;
        }
      }
      // readPos and totalInputSamples grow monotonically (both ~128 per call).
      // JavaScript float64 handles this without precision issues.
      // Buffer indexing uses % inputBufferSize, so no wrapping needed.
    }

    return true;
  }

  /**
   * Apply polyphase decimation filter for a single phase.
   * For the Nth output sample, only phase (N % M) is selected.
   * Each phase reads M-spaced samples from the delay line offset by its phase index.
   */
  _applyPolyphaseFilter(phase) {
    const coeffs = this.phases[phase];
    const len = coeffs.length;

    // Start reading from the most recent sample, going backward by phase
    // phase 0 reads x[n], x[n-3], x[n-6]...
    // phase 1 reads x[n-1], x[n-4], x[n-7]...
    // phase 2 reads x[n-2], x[n-5], x[n-8]...
    let readIdx = (this.bufferWriteIdx - 1 - phase + this.bufferSize) % this.bufferSize;

    let sum = 0;
    for (let k = 0; k < len; k++) {
      sum += coeffs[k] * this.buffer[readIdx];
      readIdx = (readIdx - this.M + this.bufferSize) % this.bufferSize;
    }

    return sum;
  }

  _writeOutputSample(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    this.outputEnergySum += s * s;
    this.outputEnergyCount++;
    this.outputBuffer[this.outputWriteIdx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    if (this.outputWriteIdx >= this.CHUNK_SAMPLES) this._flushOutputBuffer();
  }

  _flushOutputBuffer() {
    const pcm = this.outputBuffer;
    const rms = Math.sqrt(this.outputEnergySum / Math.max(1, this.outputEnergyCount));
    const activityThreshold = Math.max(this.noiseGate * 0.5, 0.003);

    this.outputBuffer = new Int16Array(this.CHUNK_SAMPLES);
    this.outputWriteIdx = 0;
    this.outputEnergySum = 0;
    this.outputEnergyCount = 0;

    // Send downsampled little-endian 16kHz PCM. Transfer the backing buffer so
    // offscreen.js can base64-wrap it without another Float32→Int16 pass.
    this.port.postMessage({
      type: 'audio-data',
      pcm: pcm.buffer,
      rms,
      hasSpeech: rms >= activityThreshold,
    }, [pcm.buffer]);
  }

  // Soft limiter: linear below the knee, smoothly compressed above it so the
  // signal asymptotically approaches ±1 instead of hard-clipping (which would
  // inject harmonic distortion and hurt transcription quality).
  _softClip(x) {
    const t = 0.95;
    if (x > t) return t + (1 - t) * Math.tanh((x - t) / (1 - t));
    if (x < -t) return -t - (1 - t) * Math.tanh((-x - t) / (1 - t));
    return x;
  }

  // === FIR Filter Design (Kaiser Window) ===

  _designKaiserFIR(fc, transitionWidth, stopbandAttenuation, sampleRate) {
    const As = stopbandAttenuation;
    const df = transitionWidth;

    // Kaiser beta parameter
    let beta;
    if (As > 50) {
      beta = 0.1102 * (As - 8.7);
    } else if (As >= 21) {
      beta = 0.5842 * Math.pow(As - 21, 0.4) + 0.07886 * (As - 21);
    } else {
      beta = 0;
    }

    // Filter order estimation
    const N = Math.ceil((As - 7.95) / (2.285 * 2 * Math.PI * df / sampleRate));
    // Make odd for type I FIR (symmetric, even length = odd taps)
    const order = N % 2 === 0 ? N + 1 : N;
    const halfLen = Math.floor(order / 2);

    // Normalized cutoff (0 to pi, where pi = Nyquist)
    const wc = 2 * Math.PI * fc / sampleRate;

    // Generate coefficients using windowed sinc
    const coeffs = new Float32Array(order);
    let sum = 0;

    for (let n = 0; n < order; n++) {
      const m = n - halfLen;

      // Ideal lowpass impulse response (sinc)
      let h;
      if (m === 0) {
        h = wc / Math.PI;
      } else {
        h = Math.sin(wc * m) / (Math.PI * m);
      }

      // Kaiser window
      const ratio = (n - halfLen) / halfLen; // -1 to 1
      const w = this._kaiserWindow(ratio, beta);

      coeffs[n] = h * w;
      sum += coeffs[n];
    }

    // Normalize to unit DC gain
    for (let n = 0; n < order; n++) {
      coeffs[n] /= sum;
    }

    return coeffs;
  }

  _kaiserWindow(t, beta) {
    const x = t * t; // t^2, where t is in [-1, 1]
    if (x > 1) return 0;
    return this._bessel0(beta * Math.sqrt(1 - x)) / this._bessel0(beta);
  }

  /**
   * Modified Bessel function of the first kind, order 0.
   * I_0(x) = sum_{k=0}^{inf} [(x/2)^k / k!]^2
   * Truncated at 25 terms (sufficient for beta < 10).
   */
  _bessel0(x) {
    let sum = 1;
    let term = 1;
    const xHalf = x / 2;
    for (let k = 1; k < 25; k++) {
      term *= (xHalf / k);
      sum += term * term;
    }
    return sum;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
