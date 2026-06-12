# Gemini Live Caption

English | [中文](README_zh.md)

Real-time translated subtitles for any browser tab, powered by Google Gemini.

Capture tab audio → stream to Gemini Live Translate → display translated captions as a floating overlay with optional Picture-in-Picture window.

## Features

- Real-time speech-to-text translation across 50+ languages
- **Bilingual mode** — display original language alongside translation
- Floating caption overlay — drag, resize, customize font size, color, and opacity
- **Caption position presets** — 6 positions (top/bottom × left/center/right)
- Picture-in-Picture window — keep captions visible when switching tabs
- **Transcript history panel** — double-click to expand, scrollable history with timestamps
- **SRT export** — download caption history as subtitle files
- Automatic session management — handles Gemini's connection limits seamlessly
- **Device change detection** — automatically rebuilds audio chain when switching output devices
- **Connection status indicator** — visual feedback for connection state
- **Debug logs** — export diagnostic logs without DevTools
- Works on any website with audio: YouTube, Twitch, podcasts, video calls, etc.

## Quick Start

### 1. Install

**From source:**
1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the project folder
5. The extension icon will appear in your toolbar

### 2. Get a Gemini API Key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **Create API key**
4. Copy the key (it starts with `AIza...`)

### 3. Configure

1. Click the extension icon in your toolbar
2. Paste your API key
3. Select your target language (e.g., Chinese, Japanese, Korean, Spanish...)
4. Adjust audio gain and noise gate if needed

### 4. Use

1. Open any page with audio (e.g., a YouTube video)
2. Click the extension icon
3. Click the **Start** button (or press `Alt+C`)
4. Captions will appear as a floating overlay on the page
5. Click the PiP button on the overlay to open captions in a Picture-in-Picture window

## Settings

| Setting | Description |
|---------|-------------|
| API Key | Your Gemini API key |
| Target Language | Language to translate captions into |
| Bilingual Mode | Show original language alongside translation |
| Font Size | Caption text size (S/M/L) |
| Background Opacity | Caption background darkness (default: 75%) |
| Caption Position | Preset positions (top/bottom × left/center/right) |
| Text Color | Caption text color (6 options) |
| Audio Gain | Boost or reduce captured audio volume |
| Noise Gate | Filter out background noise below this threshold |

## How It Works

```
Tab Audio → chrome.tabCapture → AudioWorklet (downsample to 16kHz)
  → WebSocket → Gemini Live Translate API
  → Parse transcription responses
  → Display floating caption overlay
  → Optional: relay to Picture-in-Picture window
```

The extension captures audio from the current tab, streams it to Gemini's Live Translate API over WebSocket, and displays the translated text as a floating overlay. It automatically manages connection lifecycle — rotating sessions before they expire and reconnecting if the connection drops.

## Requirements

- Chrome 116+ (for offscreen document support)
- Gemini API key (free tier available at [aistudio.google.com](https://aistudio.google.com))

## Known Limitations

- Gemini Live sessions are limited to ~10 minutes per connection. The extension automatically rotates sessions to maintain continuous captions.
- Audio-only capture — does not capture video or screen content.
- Translation quality depends on audio clarity and Gemini's capabilities.
- Requires an active internet connection.

## Privacy

- Audio is streamed directly from your browser to Google's Gemini API. No intermediate servers.
- Your API key is stored locally in Chrome's extension storage and never shared.
- No analytics, tracking, or data collection by this extension.
- **Note:** Audio data is processed by Google's Gemini API. Google's [Terms of Service](https://ai.google.dev/terms) and [Privacy Policy](https://policies.google.com/privacy) apply. Do not use with sensitive or confidential audio.

## License

CC BY-NC 4.0 — Free for non-commercial use. See [LICENSE](LICENSE) for details.
