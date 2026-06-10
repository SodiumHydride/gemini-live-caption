// audio-processor.js — AudioWorklet Processor
// Runs on a dedicated audio thread, collects PCM samples and sends them
// to the main thread in ~100ms chunks for streaming to Gemini.

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 1600; // 100ms at 16kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0]; // Mono channel, 128 samples per call
    if (!channelData) return true;

    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];
      
      if (this.bufferIndex >= this.bufferSize) {
        // Send accumulated buffer (100ms of audio)
        this.port.postMessage({
          type: 'audio-data',
          samples: this.buffer.slice(0) // Copy the buffer
        });
        this.bufferIndex = 0;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
