# Gemini Live Caption

[English](README.md) | 中文

实时翻译字幕的 Chrome 浏览器扩展，基于 Google Gemini Live Translate API。

捕获标签页音频 → 流式传输到 Gemini 实时翻译 → 以浮动覆盖层显示翻译字幕，支持画中画窗口。

## 功能特点

- 50+ 语言实时语音翻译
- **双语模式** — 同时显示原文和翻译
- 浮动字幕覆盖层 — 可拖拽、调整大小、自定义字体、颜色和透明度
- **字幕位置预设** — 6 个位置（上/下 × 左/中/右）
- 画中画窗口 — 切换标签页也能看到字幕
- **字幕历史面板** — 双击展开，可滚动的历史记录，带时间戳
- **SRT 导出** — 下载字幕历史为字幕文件
- 自动会话管理 — 无缝处理 Gemini 连接限制
- **设备切换检测** — 切换音频输出设备时自动重建音频链路
- **连接状态指示器** — 可视化连接状态反馈
- **调试日志** — 无需 DevTools 即可导出诊断日志
- 适用于任何有音频的网站：YouTube、Twitch、播客、视频通话等

## 快速开始

### 1. 安装

**从源码安装：**
1. 下载或克隆本仓库
2. 打开 Chrome，访问 `chrome://extensions`
3. 开启右上角的 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择项目文件夹
5. 扩展图标会出现在工具栏中

### 2. 获取 Gemini API Key

1. 前往 [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. 使用 Google 账号登录
3. 点击 **Create API key**
4. 复制生成的密钥（以 `AIza...` 开头）

### 3. 配置

1. 点击工具栏中的扩展图标
2. 粘贴你的 API Key
3. 选择目标语言（如中文、日语、韩语、西班牙语等）
4. 根据需要调整音频增益和噪声门限

### 4. 使用

1. 打开任意有音频的页面（如 YouTube 视频）
2. 点击扩展图标
3. 点击 **Start** 按钮（或按 `Alt+C`）
4. 字幕会以浮动覆盖层的形式出现在页面上
5. 点击覆盖层上的 PiP 按钮，可在画中画窗口中显示字幕

## 设置选项

| 设置 | 说明 |
|------|------|
| API Key | 你的 Gemini API 密钥 |
| 目标语言 | 翻译字幕的目标语言 |
| 双语模式 | 同时显示原文和翻译 |
| 字体大小 | 字幕文字大小（S/M/L） |
| 背景透明度 | 字幕背景的深浅（默认：75%） |
| 字幕位置 | 预设位置（上/下 × 左/中/右） |
| 文字颜色 | 字幕文字颜色（6 种选项） |
| 音频增益 | 增强或降低捕获的音频音量 |
| 噪声门限 | 过滤低于此阈值的背景噪音 |

## 工作原理

```
标签页音频 → chrome.tabCapture → AudioWorklet（降采样至 16kHz）
  → WebSocket → Gemini Live Translate API
  → 解析转录响应
  → 显示浮动字幕覆盖层
  → 可选：转发到画中画窗口
```

扩展从当前标签页捕获音频，通过 WebSocket 流式传输到 Gemini Live Translate API，并将翻译后的文字以浮动覆盖层显示。自动管理连接生命周期 — 在连接过期前轮转会话，断线时自动重连。

## 系统要求

- Chrome 116+（需要 offscreen document 支持）
- Gemini API 密钥（[aistudio.google.com](https://aistudio.google.com) 提供免费额度）

## 已知限制

- Gemini Live 会话每次连接限制约 10 分钟，扩展会自动轮转会话以保持连续字幕
- 仅捕获音频 — 不捕获视频或屏幕内容
- 翻译质量取决于音频清晰度和 Gemini 的能力
- 需要有效的网络连接

## 隐私说明

- 音频直接从浏览器传输到 Google Gemini API，无中间服务器
- API Key 存储在 Chrome 扩展本地存储中，不会被共享
- 本扩展不包含任何分析、追踪或数据收集
- **注意：** 音频数据由 Google Gemini API 处理，适用 Google 的[服务条款](https://ai.google.dev/terms)和[隐私政策](https://policies.google.com/privacy)。请勿用于处理敏感或机密音频内容

## 许可证

CC BY-NC 4.0 — 仅限非商业用途。详见 [LICENSE](LICENSE)。
