# Privacy Policy - Gemini Live Caption

**Last updated:** June 2026

Gemini Live Caption is a Chrome extension that provides real-time subtitle translation. This policy explains what data flows through the extension and how it is handled.

---

## What Data Is Accessed

**Tab audio.** The extension captures audio from your active browser tab to send for translation. This is the core functionality -- without audio, there is no caption to translate.

**Google API key.** You provide your own Gemini API key. It is stored locally in your browser (`chrome.storage.local`) and used solely to authenticate requests to Google's API. We never see, collect, or transmit your API key to any server other than Google's.

**User settings.** Preferences like target language and UI options are stored locally in your browser.

**Caption history.** Translated captions are kept in memory while the extension is active. They are discarded when the page closes or the extension is stopped. Nothing is saved to disk.

**Diagnostic log buffer.** The extension maintains an in-memory ring buffer (200 entries) of recent diagnostic events (connection status, errors, audio processing milestones). This is purely technical information for troubleshooting and is never transmitted off-device. Users can export it manually from the extension popup when seeking support.

## How Your Data Is Used

The audio stream is sent to Google's Gemini Live Translate API via WebSocket for the sole purpose of real-time translation. The translated text is displayed as a floating overlay on your screen.

That's it. There is no secondary use, no profiling, no analytics.

## Free API Key Notice

If you use a **free-tier Gemini API key**, Google's Terms of Service (effective March 2026) state that your audio data may be used for model training and may be reviewed by human annotators. If this is a concern, use a paid API key, which has different data handling terms.

Users in the EEA/UK should be aware that Google's free API tier may not be available in their region per Google's terms. A paid API key may be required.

**Age restriction:** Google's Gemini API Terms of Service require users to be 18 years or older. This extension must not be used as part of a service directed at individuals under 18.

This extension does not control or influence Google's data handling policies. By using this extension, you agree to Google's [Terms of Service](https://ai.google.dev/terms).

## Third-Party Data Sharing

Audio data is streamed to **Google** through the Gemini Live Translate API. Google's handling of that data is governed by their own privacy policy:
https://policies.google.com/privacy

We do not share any data with any other third parties.

## Data Retention

- **Audio:** Streamed in real-time. Not recorded or stored locally or by us.
- **API key:** Stored locally on your device only. You can delete it at any time from the extension settings.
- **Settings:** Stored locally on your device only.
- **Captions:** Held in memory during active use only. Gone when you close the page.

We do not operate any servers that collect or store your data.

## Tracking and Analytics

None. No analytics, no tracking pixels, no telemetry, no fingerprinting. We have no idea who uses this extension or how.

## Your Rights

- **Delete your API key:** Open the extension popup and clear it from settings. Done.
- **Stop using the extension:** Disable or uninstall it. All local data is removed automatically.
- **Revoke API access:** Revoke the key from your Google account at any time.

## Contact

If you have questions about this policy, open an issue on the project's GitHub repository.
