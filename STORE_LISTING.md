# Chrome Web Store Listing

## Short Description (132 chars max)

Real-time AI subtitle translation for any tab. Uses Gemini Live Translate to show translated captions as you watch.

## Detailed Description

### Real-Time Translation for Any Audio

Gemini Live Caption captures audio from any browser tab and translates it in real-time using Google's Gemini Live Translate API. Watch foreign streams, lectures, meetings, and videos with instant translated subtitles.

### Features

- **Real-time translation** — Captures tab audio and displays translated captions as floating subtitles
- **50+ languages** — Translate to Chinese, English, Japanese, Korean, Spanish, French, German, and more
- **Picture-in-Picture** — Open captions in a floating window that stays visible when you switch tabs
- **Customizable display** — Adjust font size, background opacity, text color, and caption position
- **Audio controls** — Adjustable gain and noise gate for better transcription quality
- **Caption history** — Double-click the overlay to view full transcript
- **SRT export** — Download subtitles as SRT files for later use
- **Keyboard shortcut** — Alt+C to toggle capture instantly

### How It Works

1. Install the extension and enter your Gemini API key (free tier available at ai.google.dev)
2. Navigate to any page with audio (YouTube, Twitch, online meetings, etc.)
3. Click the extension icon or press Alt+C to start
4. Translated captions appear as a floating overlay on the page

### What Makes It Different

Unlike other subtitle extensions that only work on specific platforms, Gemini Live Caption works on **any tab with audio**. It captures the actual audio output from your browser, not just platform-specific subtitle data. This means it works on live streams, webinars, video calls, and any website with sound.

### Privacy

- Your API key is stored locally and never shared
- Audio is streamed directly to Google's API — we don't see or store it
- No analytics, no tracking, no data collection
- Full privacy policy: https://github.com/SodiumHydride/charming-newton/blob/main/PRIVACY.md

### Requirements

- Chrome 116 or later
- A Google Gemini API key (free tier available)

### Permissions

- **tabCapture** — Required to capture audio from the active tab
- **offscreen** — Required for audio processing (Chrome MV3 architecture)
- **storage** — Stores your settings and API key locally
- **tabs** — Manages tab lifecycle for capture
- **activeTab + scripting** — Injects the subtitle overlay into the current page

---

# Chrome Web Store 上架信息

## 短描述（132 字符以内）

实时 AI 字幕翻译，适用于任意标签页。使用 Gemini Live Translate 在观看时显示翻译字幕。

## 详细描述

### 任意音频的实时翻译

Gemini Live Caption 捕获浏览器标签页的音频，使用 Google Gemini Live Translate API 进行实时翻译。观看外语直播、课程、会议和视频时，即时显示翻译字幕。

### 功能特点

- **实时翻译** — 捕获标签页音频，以浮动字幕形式显示翻译
- **50+ 种语言** — 翻译为中文、英文、日文、韩文、西班牙文、法文、德文等
- **画中画** — 在浮动窗口中打开字幕，切换标签页时仍可见
- **自定义显示** — 调整字体大小、背景透明度、文字颜色和字幕位置
- **音频控制** — 可调增益和噪声门，提升转录质量
- **字幕历史** — 双击 overlay 查看完整记录
- **SRT 导出** — 下载 SRT 格式字幕文件
- **快捷键** — Alt+C 一键开关

### 使用方法

1. 安装扩展并输入 Gemini API 密钥（ai.google.dev 可免费获取）
2. 打开任意有音频的页面（YouTube、Twitch、在线会议等）
3. 点击扩展图标或按 Alt+C 开始
4. 翻译字幕以浮动 overlay 形式出现在页面上

### 与其他扩展的区别

与其他只支持特定平台的字幕扩展不同，Gemini Live Caption 适用于**任何有音频的标签页**。它捕获浏览器的实际音频输出，而非平台特定的字幕数据。这意味着它可用于直播、网络研讨会、视频通话和任何有声音的网站。

### 隐私

- API 密钥本地存储，绝不共享
- 音频直接传输到 Google API — 我们看不到也存储不了
- 无分析、无追踪、无数据收集
- 完整隐私政策：https://github.com/SodiumHydride/charming-newton/blob/main/PRIVACY.md

### 要求

- Chrome 116 或更高版本
- Google Gemini API 密钥（免费额度可用）

### 权限说明

- **tabCapture** — 捕获活动标签页的音频
- **offscreen** — 音频处理（Chrome MV3 架构要求）
- **storage** — 本地存储设置和 API 密钥
- **tabs** — 管理标签页生命周期
- **activeTab + scripting** — 注入字幕 overlay 到当前页面
