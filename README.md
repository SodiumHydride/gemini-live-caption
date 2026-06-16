<div align="center">

<img src="icon-128.png" width="96" height="96" alt="Gemini Live Caption logo" />

# Gemini Live Caption

**Real-time, translated subtitles for _any_ audio in your browser — powered by Google Gemini.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Gemini Live API](https://img.shields.io/badge/Gemini-Live%20Translate-8E75B2?logo=googlegemini&logoColor=white)](https://ai.google.dev/gemini-api/docs/live)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![GitHub stars](https://img.shields.io/github/stars/SodiumHydride/gemini-live-caption?style=social)](https://github.com/SodiumHydride/gemini-live-caption)

English | [中文](README_zh.md)

[Install](#quick-start) · [Features](#features) · [How it works](#how-it-works) · [Permissions](#permissions) · [Roadmap](#roadmap) · [Contributing](#contributing)

<br/>

<!-- TODO: Replace this placeholder with a real demo.gif (record a YouTube video being captioned + the PiP window). Drop it at docs/demo.gif and update the src below. -->
<img src="https://placehold.co/820x440/0f0f19/4fc3f7?text=Gemini+Live+Caption+%E2%80%94+Live+Demo" alt="Gemini Live Caption demo" width="820" />

</div>

---

## Why this exists

Chrome's built-in Live Caption only **transcribes English** — it doesn't translate. Most live streams, podcasts, lectures, and meetings have **no subtitle track at all**. And web-page translators don't touch audio.

**Gemini Live Caption** captures the audio of any browser tab and turns it into real-time **translated** captions — rendered as a draggable overlay on the page, or in a floating **Picture-in-Picture** window that stays on top while you switch tabs. Bring your own [Gemini API key](https://aistudio.google.com/apikey), and any audio on the web becomes readable in your language.

> Great for: foreign-language lectures and online courses, untranslated YouTube/Twitch streams, podcasts, and remote meetings.

## How it compares

| | **Gemini Live Caption** | Chrome Live Caption | Subtitle / page-translate extensions |
|---|:---:|:---:|:---:|
| Translates across 70+ languages | ✅ | ❌ (transcribe only) | ⚠️ text only, not audio |
| Translation pipeline | **End-to-end · Gemini 3.5** | transcribe only | transcribe → translate (2-stage) |
| Works on any tab audio (no platform subtitle track needed) | ✅ | ✅ | ❌ depends on platform captions |
| Bilingual (original + translation) | ✅ | ❌ | ❌ |
| Floating Picture-in-Picture window | ✅ | ❌ | ❌ |
| Transcript history + SRT export | ✅ | ❌ | ⚠️ rarely |
| Drag / resize / position presets | ✅ | ❌ | ⚠️ limited |
| No backend — audio goes straight to Google | ✅ | ✅ | varies |

**Why end-to-end matters:** most extensions chain a speech-to-text engine (Deepgram, Whisper) with a *separate* translation model — transcription errors compound and latency stacks. Gemini Live Caption rides Google's `gemini-3.5-live-translate` model **end-to-end**: one model listens and translates at once, auto-detects the source language, and covers 70+ languages with lower latency.

## Features

**Translation**
- 🌐 Real-time speech translation across **70+ languages** (auto-detects the source language)
- 🌍 **Bilingual mode** — show the original language alongside the translation
- ✨ Optional finalized-caption polish with a terminology/style guide

**Display**
- 🪟 Floating caption overlay — drag, resize, and customize font size, color, and opacity
- 📺 **Picture-in-Picture** window — captions stay visible across tab switches, with its own line-count control
- 📍 **6 position presets** (top/bottom × left/center/right)

**Productivity**
- 📜 **Transcript history panel** — double-click to expand, scrollable, timestamped
- 💾 **SRT export** — generated from the service worker's finalized transcript store

**Reliability** _(the hard part — see [Tech highlights](#tech-highlights))_
- 🔄 Automatic session rotation around Gemini's ~10-minute connection limit
- 🔌 Exponential-backoff reconnect + caption watchdog for silent stalls
- 🎧 Audio device hot-swap recovery (headphones / Bluetooth plug-unplug)
- ♻️ Crash-safe state machine that survives service-worker restarts

**Privacy**
- 🔒 No intermediate servers — audio streams directly from your browser to Google
- 🔑 Your API key is stored locally and never leaves your device (except to Google)
- 📜 Finalized captions are kept in Chrome session storage for history and SRT export
- 🚫 Zero analytics, tracking, or telemetry

## Quick Start

### 1. Install

**From source (developer mode):**
1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon appears in your toolbar

### 2. Get a Gemini API key (free tier available)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in and click **Create API key**
3. Copy the key (it starts with `AIza…`)

### 3. Caption anything

1. Open any page with audio (e.g. a YouTube video)
2. Click the extension icon, paste your key, pick a target language
3. Click **Start** (or press `Alt+C`)
4. Captions appear as an overlay — click the PiP button to pop them out

## How it works

```
Tab audio
  → chrome.tabCapture
  → AudioWorklet (polyphase + Kaiser-window FIR downsample to 16 kHz)
  → WebSocket → Gemini Live Translate API
  → parse transcription stream
  → Shadow-DOM caption overlay
  → (optional) relay to Picture-in-Picture window
```

The extension captures tab audio, streams it to Gemini's Live Translate API over WebSocket, and renders the translated text on screen. It manages the full connection lifecycle automatically — rotating sessions before they expire and reconnecting on drops — so captions stay continuous.

## Tech highlights

This is a deliberately well-engineered MV3 extension. If you're learning how to build production-grade Chrome extensions or how to drive the Gemini Live API, these parts are worth a read:

- **Professional DSP resampling** (`audio-processor.js`): a Kaiser-window FIR low-pass with **polyphase decomposition** for integer ratios and linear interpolation for non-integer ratios — clean 16 kHz audio at any input sample rate.
- **Seamless long sessions** (`offscreen.js`): proactive session rotation, `sessionResumption` handles, a caption watchdog for silent server stalls, and exponential-backoff reconnect — all to paper over Gemini Live's ~10-minute session ceiling.
- **Crash-safe MV3 orchestration** (`service-worker.js`): a state machine with heartbeat + ping recovery so capture survives ephemeral service-worker restarts.
- **Authoritative transcript store** (`service-worker.js`): finalized segments, SRT timing, and optional post-final polish live in one service-worker-owned session store instead of being reconstructed by the page overlay.
- **Robust in-page UI** (`content.js`): a `closed` Shadow DOM for full style isolation, XSS-safe rendering, `AbortController`-managed listeners, and a `MutationObserver` that self-heals if the host page removes the overlay.

## Roadmap

- [ ] 🎙️ Microphone input (live in-person meetings & interpretation)
- [ ] 🌐 Full UI internationalization (zh / en / ja / …)
- [ ] 🧭 First-run onboarding wizard (guided API-key setup)
- [ ] 🔌 Pluggable transcription providers (reduce single-vendor dependency)
- [ ] 🧩 Microsoft Edge & Firefox builds
- [ ] 🎨 Customizable caption themes

Have an idea? [Open an issue](https://github.com/SodiumHydride/gemini-live-caption/issues).

## Contributing

Contributions are welcome — bug reports, feature ideas, and PRs all help.

1. Fork the repo and create a feature branch
2. Make your change (the codebase is plain JS, no build step required)
3. Load the unpacked extension and test your change
4. Open a pull request describing what and why

If this project saves you time, a ⭐ on [GitHub](https://github.com/SodiumHydride/gemini-live-caption) genuinely helps it reach more people.

## Star history

<a href="https://star-history.com/#SodiumHydride/gemini-live-caption&Date">
  <img src="https://api.star-history.com/svg?repos=SodiumHydride/gemini-live-caption&type=Date" alt="Star History Chart" width="600" />
</a>

## Requirements

- Chrome 116+ (for Document Picture-in-Picture and offscreen-document support)
- A Gemini API key — free tier available at [aistudio.google.com](https://aistudio.google.com)

## Permissions

Gemini Live Caption asks only for the Chrome permissions needed to capture the active tab's audio, render captions, and keep the MV3 extension reliable:

- `tabCapture`: capture audio from the tab you choose after you start captions.
- `offscreen`: run audio capture, AudioWorklet processing, and the Gemini Live WebSocket from an offscreen extension document.
- `storage`: store your local settings/API key and keep session transcript segments for history and SRT export.
- `activeTab`: identify the current tab after your click or keyboard shortcut.
- `scripting`: inject the isolated caption overlay into the source tab.
- `tabs`: track tab navigation/close/replace events so capture can stop or recover cleanly.

The extension does not request host permissions. Its Picture-in-Picture files are listed as web-accessible resources because Document Picture-in-Picture is opened from arbitrary pages; those files are static UI assets and contain no API keys or user data.

## Privacy & disclaimer

- Audio streams directly from your browser to Google's Gemini API — there is no intermediate server. Finalized captions are kept in Chrome session storage for transcript history and SRT export. See the full [Privacy Policy](PRIVACY.md).
- Optional finalized-caption polish sends the finalized text segment, source transcript when available, and terminology/style rules to Google's Generative Language API. It is off by default.
- **Free API keys:** Google may use your audio for model training and human review. For sensitive use, prefer a paid key. See [Google's Terms](https://ai.google.dev/terms).
- **Use responsibly:** don't capture copyrighted content without permission or record private conversations without consent. You must be 18+ to use Google's Gemini API.
- Provided "as is", without warranty of any kind.

## License

[CC BY-NC 4.0](LICENSE) — free for non-commercial use.

<sub>Built by <a href="https://github.com/SodiumHydride">NaH</a> · Powered by Google Gemini</sub>
