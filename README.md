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

- Chrome 116+ (for Document Picture-in-Picture API and offscreen document support)
- Gemini API key (free tier available at [aistudio.google.com](https://aistudio.google.com))

## Technical Notes

**`web_accessible_resources` with `<all_urls>`:** The manifest declares `pip.html`, `pip.css`, and `pip.js` as web-accessible to all origins. This is required because the Document Picture-in-Picture API creates a window from a URL that must be accessible from the content script's context on any page. Without `<all_urls>`, the PiP window fails to load on third-party sites (e.g., YouTube, Twitch). These files contain no sensitive logic — they only render caption text received via `postMessage`.

## Known Limitations

- Gemini Live sessions are limited to ~10 minutes per connection. The extension automatically rotates sessions to maintain continuous captions.
- Audio-only capture — does not capture video or screen content.
- Translation quality depends on audio clarity and Gemini's capabilities.
- Requires an active internet connection.

## Privacy

- Audio is streamed directly from your browser to Google's Gemini API. No intermediate servers.
- Your API key is stored locally in Chrome's extension storage and never shared.
- No analytics, tracking, or data collection by this extension.
- **Free API key notice:** If you use a free Gemini API key, Google may use your audio data for model training and human review. See [Google's Terms of Service](https://ai.google.dev/terms). For privacy-sensitive use, consider using a paid API key.
- **Note:** Audio data is processed by Google's Gemini API. Google's [Terms of Service](https://ai.google.dev/terms) and [Privacy Policy](https://policies.google.com/privacy) apply. Do not use with sensitive or confidential audio.

## Disclaimer

This extension is a tool for real-time audio translation. The user is solely responsible for how they use it.

- **Copyright:** Capturing audio from copyrighted content (streams, movies, music) may violate platform Terms of Service or applicable copyright laws. Ensure you have the right to capture and translate the audio you process through this extension.
- **Privacy:** Do not use this extension to capture audio from private conversations without the consent of all parties involved. Laws regarding audio recording vary by jurisdiction.
- **API usage:** This extension sends audio to Google's Gemini API. By using this extension, you agree to [Google's Terms of Service](https://ai.google.dev/terms). Free-tier API keys are subject to data usage policies that may include model training.
- **Age restriction:** Users must be 18 or older. Google's Gemini API must not be used as part of a service directed at individuals under 18.
- **No warranty:** This extension is provided "as is" without warranty of any kind. The developers are not responsible for any misuse, data loss, or legal consequences arising from the use of this extension.

## License

CC BY-NC 4.0 — Free for non-commercial use. See [LICENSE](LICENSE) for details.
