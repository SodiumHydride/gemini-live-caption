// i18n.js — Gemini Live Caption · UI internationalization
//
// Loaded by popup.html, pip.html, and injected into the host page alongside
// content.js. Exposes `window.I18N` with t/apply/setLang/onChange helpers.
//
// HTML usage:
//   <span data-i18n="status_ready">Ready</span>              -> textContent
//   <input data-i18n-attr="placeholder:setting_api_key_ph">  -> attribute(s)
//   <p data-i18n-html="shortcut_hint_html"></p>              -> innerHTML
//
// JS usage:
//   I18N.t('toggle_start')               -> translated string
//   I18N.apply(document)                 -> rewrite the whole page
//   I18N.setLang('zh-Hans')              -> change + persist + broadcast
//   I18N.onChange(lang => { /* react */ })

(function () {
  'use strict';

  // Idempotent install: when content.js (and i18n.js with it) is re-injected
  // into the same page, skip re-initialization so we don't accumulate state
  // (extraRoots, onChange callbacks) and leak references to dead IIFE closures.
  if (window.I18N && window.I18N.__SIGNATURE === 'GEMINI_LIVE_CAPTION_I18N_V1') return;

  const SUPPORTED = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es'];
  const DEFAULT_LANG = 'en';

  // Display name for the UI language picker (in the language's own script).
  const LANG_LABELS = {
    'en':      'English',
    'zh-Hans': '简体中文',
    'zh-Hant': '繁體中文',
    'ja':      '日本語',
    'ko':      '한국어',
    'es':      'Español',
  };

  // Translation table. Missing keys in a non-default language fall back to en.
  // Keys are sorted into logical groups: app / status / disclaimer / settings /
  // export / overlay / pip.
  const MESSAGES = {
    en: {
      app_name: 'Gemini Live Caption',
      app_subtitle: 'AI-powered real-time translation',

      status_ready: 'Ready',
      status_capturing: 'Capturing',
      status_capturing_other: 'Capturing another tab',
      status_starting: 'Starting',

      toggle_start: 'Start Caption',
      toggle_stop: 'Stop Caption',
      toggle_starting: 'Starting...',
      toggle_stopping: 'Stopping...',
      toggle_need_key: 'Paste your API key first',

      disclaimer_title: 'Before you start',
      disclaimer_body_html: 'This extension captures tab audio and sends it to Google for translation. By using it, you agree to <a href="https://ai.google.dev/terms" target="_blank" rel="noopener">Google\'s Terms of Service</a>.',
      disclaimer_rule_copyright: 'Do not capture copyrighted content without permission',
      disclaimer_rule_privacy: 'Do not record private conversations without consent',
      disclaimer_rule_freekey: 'Free API keys: Google may use your data for model training',
      disclaimer_rule_age: 'You must be 18+ to use this extension (Google API requirement)',
      disclaimer_accept: 'I Understand',

      display_mode_label: '🖥️ Display Mode',
      display_mode_hint: 'Click the PiP button on the subtitle overlay to open floating window',
      display_mode_hint_sub: 'PiP window stays visible when you switch tabs',
      display_mode_pip_active: 'PiP window is currently active',

      setting_ui_language: '🌎 Interface Language',
      setting_api_key: '🔑 API Key',
      setting_get_key: 'Get a free key →',
      setting_api_key_placeholder: 'Enter your Gemini API key',
      setting_api_key_show_hide: 'Show/hide API key',
      setting_target_language: '🌐 Target Language',
      setting_echo_target: '🔁 Target-Language Echo',
      setting_echo_target_hint: 'Preserve target-language speech in the Live Translate stream',
      setting_font_size: '📏 Font Size',
      setting_max_lines: '📐 Max Lines',
      setting_overlay_max_lines: '📐 Overlay Lines',
      setting_pip_max_lines: '🪟 PiP Lines',
      setting_bg_opacity: '🎨 Background Opacity',
      setting_audio_gain: '🔊 Audio Gain',
      setting_noise_gate: '🔇 Noise Gate',
      noise_gate_off: 'Off',
      setting_bilingual: '🌍 Bilingual Mode',
      setting_bilingual_hint: 'Show original language alongside translation',
      setting_caption_position: '📍 Caption Position',
      position_top_left: 'Top Left',
      position_top_center: 'Top Center',
      position_top_right: 'Top Right',
      position_bottom_left: 'Bottom Left',
      position_bottom_center: 'Bottom Center',
      position_bottom_right: 'Bottom Right',
      setting_text_color: '✏️ Text Color',
      color_white: 'White',
      color_light_gray: 'Light Gray',
      color_yellow: 'Yellow',
      color_light_blue: 'Light Blue',
      color_light_green: 'Light Green',
      color_orange: 'Orange',
      setting_caption_revision: '✨ Final Caption Polish',
      revision_off: 'Off',
      revision_polish: 'Polish',
      setting_caption_revision_hint: 'Optional second pass for finalized subtitles; live text stays low-latency',
      setting_caption_terminology: '📚 Terminology',
      setting_caption_terminology_placeholder: 'One rule per line, e.g. MiHoYo => HoYoverse',

      export_subtitles: 'Export Subtitles (SRT)',
      export_loading: 'Exporting...',
      export_done: 'Downloaded!',
      export_empty_subtitles: 'No subtitles',
      export_failed: 'Failed',
      export_logs: 'Export Logs',
      export_empty_logs: 'No logs',

      shortcut_hint_html: '⌨️ Press <kbd>Alt+C</kbd> to toggle',
      github_cta: 'Star on GitHub',
      lang_common: '★ Common',
      lang_all: 'All languages (70+)',

      overlay_transcript: 'Transcript',

      pip_settings_title: 'Caption Settings',
      pip_font_size: 'Font Size',
      pip_max_lines: 'Max Lines',
      pip_background: 'Background',
      pip_text_color: 'Text Color',
    },

    'zh-Hans': {
      app_name: 'Gemini 实时字幕',
      app_subtitle: 'AI 实时翻译字幕',

      status_ready: '就绪',
      status_capturing: '捕获中',
      status_capturing_other: '正在捕获其他标签页',
      status_starting: '正在启动',

      toggle_start: '开始字幕',
      toggle_stop: '停止字幕',
      toggle_starting: '启动中…',
      toggle_stopping: '停止中…',
      toggle_need_key: '请先填入 API Key',

      disclaimer_title: '开始之前',
      disclaimer_body_html: '本扩展会捕获标签页音频并发送至 Google 进行翻译。继续使用即表示你同意 <a href="https://ai.google.dev/terms" target="_blank" rel="noopener">Google 服务条款</a>。',
      disclaimer_rule_copyright: '未经许可，请勿捕获受版权保护的内容',
      disclaimer_rule_privacy: '未经同意，请勿录制私人对话',
      disclaimer_rule_freekey: '免费 API Key：Google 可能将你的数据用于模型训练',
      disclaimer_rule_age: '使用本扩展需年满 18 岁（Google API 要求）',
      disclaimer_accept: '我已了解',

      display_mode_label: '🖥️ 显示模式',
      display_mode_hint: '点击字幕浮层上的 PiP 按钮可弹出独立窗口',
      display_mode_hint_sub: '画中画窗口在切换标签页时仍保持可见',
      display_mode_pip_active: '画中画窗口已开启',

      setting_ui_language: '🌎 界面语言',
      setting_api_key: '🔑 API Key',
      setting_get_key: '免费获取 →',
      setting_api_key_placeholder: '请输入你的 Gemini API Key',
      setting_api_key_show_hide: '显示 / 隐藏 API Key',
      setting_target_language: '🌐 目标语言',
      setting_echo_target: '🔁 目标语回显',
      setting_echo_target_hint: '在 Live Translate 流中保留目标语言语音',
      setting_font_size: '📏 字体大小',
      setting_max_lines: '📐 最大行数',
      setting_overlay_max_lines: '📐 浮层行数',
      setting_pip_max_lines: '🪟 PiP 行数',
      setting_bg_opacity: '🎨 背景不透明度',
      setting_audio_gain: '🔊 音频增益',
      setting_noise_gate: '🔇 噪声门',
      noise_gate_off: '关闭',
      setting_bilingual: '🌍 双语模式',
      setting_bilingual_hint: '同时显示原文与译文',
      setting_caption_position: '📍 字幕位置',
      position_top_left: '左上',
      position_top_center: '顶部居中',
      position_top_right: '右上',
      position_bottom_left: '左下',
      position_bottom_center: '底部居中',
      position_bottom_right: '右下',
      setting_text_color: '✏️ 文字颜色',
      color_white: '白色',
      color_light_gray: '浅灰',
      color_yellow: '黄色',
      color_light_blue: '浅蓝',
      color_light_green: '浅绿',
      color_orange: '橙色',
      setting_caption_revision: '✨ 最终字幕润色',
      revision_off: '关闭',
      revision_polish: '润色',
      setting_caption_revision_hint: '只对已定稿字幕做二次处理，实时字幕保持低延迟',
      setting_caption_terminology: '📚 术语表',
      setting_caption_terminology_placeholder: '每行一条规则，例如：MiHoYo => HoYoverse',

      export_subtitles: '导出字幕 (SRT)',
      export_loading: '导出中…',
      export_done: '已下载！',
      export_empty_subtitles: '暂无字幕',
      export_failed: '失败',
      export_logs: '导出日志',
      export_empty_logs: '暂无日志',

      shortcut_hint_html: '⌨️ 按 <kbd>Alt+C</kbd> 切换',
      github_cta: '在 GitHub 上 Star',
      lang_common: '★ 常用',
      lang_all: '全部语言 (70+)',

      overlay_transcript: '字幕历史',

      pip_settings_title: '字幕设置',
      pip_font_size: '字体大小',
      pip_max_lines: '最大行数',
      pip_background: '背景',
      pip_text_color: '文字颜色',
    },

    'zh-Hant': {
      app_name: 'Gemini 即時字幕',
      app_subtitle: 'AI 即時翻譯字幕',

      status_ready: '就緒',
      status_capturing: '擷取中',
      status_capturing_other: '正在擷取其他分頁',
      status_starting: '啟動中',

      toggle_start: '開始字幕',
      toggle_stop: '停止字幕',
      toggle_starting: '啟動中…',
      toggle_stopping: '停止中…',
      toggle_need_key: '請先填入 API Key',

      disclaimer_title: '開始之前',
      disclaimer_body_html: '本擴充功能會擷取分頁音訊並送至 Google 進行翻譯。繼續使用即表示你同意 <a href="https://ai.google.dev/terms" target="_blank" rel="noopener">Google 服務條款</a>。',
      disclaimer_rule_copyright: '未經許可，請勿擷取受版權保護的內容',
      disclaimer_rule_privacy: '未經同意，請勿錄製私人對話',
      disclaimer_rule_freekey: '免費 API Key：Google 可能將你的資料用於模型訓練',
      disclaimer_rule_age: '使用本擴充功能須年滿 18 歲（Google API 要求）',
      disclaimer_accept: '我已了解',

      display_mode_label: '🖥️ 顯示模式',
      display_mode_hint: '點擊字幕浮層上的 PiP 按鈕可彈出獨立視窗',
      display_mode_hint_sub: '子母畫面視窗在切換分頁時仍保持可見',
      display_mode_pip_active: '子母畫面視窗已開啟',

      setting_ui_language: '🌎 介面語言',
      setting_api_key: '🔑 API Key',
      setting_get_key: '免費取得 →',
      setting_api_key_placeholder: '請輸入你的 Gemini API Key',
      setting_api_key_show_hide: '顯示 / 隱藏 API Key',
      setting_target_language: '🌐 目標語言',
      setting_echo_target: '🔁 目標語回聲',
      setting_echo_target_hint: '在 Live Translate 串流中保留目標語語音',
      setting_font_size: '📏 字型大小',
      setting_max_lines: '📐 最大行數',
      setting_overlay_max_lines: '📐 浮層行數',
      setting_pip_max_lines: '🪟 子母畫面行數',
      setting_bg_opacity: '🎨 背景不透明度',
      setting_audio_gain: '🔊 音訊增益',
      setting_noise_gate: '🔇 雜訊閘',
      noise_gate_off: '關閉',
      setting_bilingual: '🌍 雙語模式',
      setting_bilingual_hint: '同時顯示原文與譯文',
      setting_caption_position: '📍 字幕位置',
      position_top_left: '左上',
      position_top_center: '頂部置中',
      position_top_right: '右上',
      position_bottom_left: '左下',
      position_bottom_center: '底部置中',
      position_bottom_right: '右下',
      setting_text_color: '✏️ 文字顏色',
      color_white: '白色',
      color_light_gray: '淺灰',
      color_yellow: '黃色',
      color_light_blue: '淺藍',
      color_light_green: '淺綠',
      color_orange: '橘色',
      setting_caption_revision: '✨ 最終字幕潤飾',
      revision_off: '關閉',
      revision_polish: '潤飾',
      setting_caption_revision_hint: '只對已定稿字幕做二次處理，即時字幕保持低延遲',
      setting_caption_terminology: '📚 術語表',
      setting_caption_terminology_placeholder: '每行一條規則，例如：MiHoYo => HoYoverse',

      export_subtitles: '匯出字幕 (SRT)',
      export_loading: '匯出中…',
      export_done: '已下載！',
      export_empty_subtitles: '尚無字幕',
      export_failed: '失敗',
      export_logs: '匯出記錄',
      export_empty_logs: '尚無記錄',

      shortcut_hint_html: '⌨️ 按 <kbd>Alt+C</kbd> 切換',
      github_cta: '在 GitHub 上 Star',
      lang_common: '★ 常用',
      lang_all: '全部語言 (70+)',

      overlay_transcript: '字幕歷史',

      pip_settings_title: '字幕設定',
      pip_font_size: '字型大小',
      pip_max_lines: '最大行數',
      pip_background: '背景',
      pip_text_color: '文字顏色',
    },

    ja: {
      app_name: 'Gemini ライブキャプション',
      app_subtitle: 'AI によるリアルタイム翻訳字幕',

      status_ready: '準備完了',
      status_capturing: 'キャプチャ中',
      status_capturing_other: '別のタブをキャプチャ中',
      status_starting: '起動中',

      toggle_start: '字幕を開始',
      toggle_stop: '字幕を停止',
      toggle_starting: '起動中…',
      toggle_stopping: '停止中…',
      toggle_need_key: 'まず API キーを入力してください',

      disclaimer_title: 'はじめに',
      disclaimer_body_html: 'この拡張機能はタブの音声を取得し、翻訳のために Google に送信します。利用することで <a href="https://ai.google.dev/terms" target="_blank" rel="noopener">Google の利用規約</a> に同意したことになります。',
      disclaimer_rule_copyright: '許可なく著作権コンテンツを取得しないでください',
      disclaimer_rule_privacy: '同意なく私的な会話を録音しないでください',
      disclaimer_rule_freekey: '無料 API キー: データがモデル学習に利用される場合があります',
      disclaimer_rule_age: 'この拡張機能の利用は 18 歳以上に限られます (Google API の要件)',
      disclaimer_accept: '了解しました',

      display_mode_label: '🖥️ 表示モード',
      display_mode_hint: '字幕オーバーレイの PiP ボタンでフローティング表示に切替',
      display_mode_hint_sub: 'ピクチャ イン ピクチャはタブを切り替えても表示され続けます',
      display_mode_pip_active: 'ピクチャ イン ピクチャ表示中',

      setting_ui_language: '🌎 表示言語',
      setting_api_key: '🔑 API キー',
      setting_get_key: '無料で取得 →',
      setting_api_key_placeholder: 'Gemini API キーを入力',
      setting_api_key_show_hide: 'API キーの表示/非表示',
      setting_target_language: '🌐 翻訳先の言語',
      setting_echo_target: '🔁 翻訳先言語のエコー',
      setting_echo_target_hint: 'Live Translate ストリームで翻訳先言語の音声を保持',
      setting_font_size: '📏 フォントサイズ',
      setting_max_lines: '📐 最大行数',
      setting_overlay_max_lines: '📐 オーバーレイ行数',
      setting_pip_max_lines: '🪟 PiP 行数',
      setting_bg_opacity: '🎨 背景の不透明度',
      setting_audio_gain: '🔊 音量ゲイン',
      setting_noise_gate: '🔇 ノイズゲート',
      noise_gate_off: 'オフ',
      setting_bilingual: '🌍 バイリンガル表示',
      setting_bilingual_hint: '原文と翻訳を同時に表示',
      setting_caption_position: '📍 字幕の位置',
      position_top_left: '左上',
      position_top_center: '中央上',
      position_top_right: '右上',
      position_bottom_left: '左下',
      position_bottom_center: '中央下',
      position_bottom_right: '右下',
      setting_text_color: '✏️ 文字色',
      color_white: '白',
      color_light_gray: 'ライトグレー',
      color_yellow: '黄',
      color_light_blue: 'ライトブルー',
      color_light_green: 'ライトグリーン',
      color_orange: 'オレンジ',
      setting_caption_revision: '✨ 最終字幕の整形',
      revision_off: 'オフ',
      revision_polish: '整形',
      setting_caption_revision_hint: '確定済み字幕だけを後処理し、ライブ表示は低遅延のままにします',
      setting_caption_terminology: '📚 用語集',
      setting_caption_terminology_placeholder: '1 行に 1 ルール。例: MiHoYo => HoYoverse',

      export_subtitles: '字幕を書き出し (SRT)',
      export_loading: '書き出し中…',
      export_done: 'ダウンロード完了',
      export_empty_subtitles: '字幕がありません',
      export_failed: '失敗しました',
      export_logs: 'ログを書き出し',
      export_empty_logs: 'ログがありません',

      shortcut_hint_html: '⌨️ <kbd>Alt+C</kbd> で切替',
      github_cta: 'GitHub でスターを付ける',
      lang_common: '★ よく使う',
      lang_all: 'すべての言語 (70+)',

      overlay_transcript: '字幕履歴',

      pip_settings_title: '字幕設定',
      pip_font_size: 'フォントサイズ',
      pip_max_lines: '最大行数',
      pip_background: '背景',
      pip_text_color: '文字色',
    },

    ko: {
      app_name: 'Gemini 라이브 자막',
      app_subtitle: 'AI 기반 실시간 번역 자막',

      status_ready: '준비됨',
      status_capturing: '캡처 중',
      status_capturing_other: '다른 탭 캡처 중',
      status_starting: '시작 중',

      toggle_start: '자막 시작',
      toggle_stop: '자막 중지',
      toggle_starting: '시작 중…',
      toggle_stopping: '중지 중…',
      toggle_need_key: 'API 키를 먼저 입력하세요',

      disclaimer_title: '시작하기 전에',
      disclaimer_body_html: '이 확장 프로그램은 탭 오디오를 캡처하여 번역을 위해 Google로 전송합니다. 사용 시 <a href="https://ai.google.dev/terms" target="_blank" rel="noopener">Google 서비스 약관</a>에 동의하게 됩니다.',
      disclaimer_rule_copyright: '허가 없이 저작권 콘텐츠를 캡처하지 마세요',
      disclaimer_rule_privacy: '동의 없이 사적인 대화를 녹음하지 마세요',
      disclaimer_rule_freekey: '무료 API 키: 데이터가 모델 학습에 사용될 수 있습니다',
      disclaimer_rule_age: '이 확장 프로그램은 만 18세 이상만 사용할 수 있습니다 (Google API 요건)',
      disclaimer_accept: '확인',

      display_mode_label: '🖥️ 표시 모드',
      display_mode_hint: '자막 오버레이의 PiP 버튼으로 별도 창 표시',
      display_mode_hint_sub: 'PiP 창은 탭을 전환해도 계속 표시됩니다',
      display_mode_pip_active: 'PiP 창이 활성화됨',

      setting_ui_language: '🌎 인터페이스 언어',
      setting_api_key: '🔑 API 키',
      setting_get_key: '무료로 받기 →',
      setting_api_key_placeholder: 'Gemini API 키를 입력하세요',
      setting_api_key_show_hide: 'API 키 표시/숨김',
      setting_target_language: '🌐 대상 언어',
      setting_echo_target: '🔁 대상 언어 에코',
      setting_echo_target_hint: 'Live Translate 스트림에서 대상 언어 음성을 보존',
      setting_font_size: '📏 글꼴 크기',
      setting_max_lines: '📐 최대 줄 수',
      setting_overlay_max_lines: '📐 오버레이 줄 수',
      setting_pip_max_lines: '🪟 PiP 줄 수',
      setting_bg_opacity: '🎨 배경 불투명도',
      setting_audio_gain: '🔊 오디오 게인',
      setting_noise_gate: '🔇 노이즈 게이트',
      noise_gate_off: '끔',
      setting_bilingual: '🌍 이중 언어 모드',
      setting_bilingual_hint: '원문과 번역을 함께 표시',
      setting_caption_position: '📍 자막 위치',
      position_top_left: '왼쪽 상단',
      position_top_center: '상단 중앙',
      position_top_right: '오른쪽 상단',
      position_bottom_left: '왼쪽 하단',
      position_bottom_center: '하단 중앙',
      position_bottom_right: '오른쪽 하단',
      setting_text_color: '✏️ 글자 색상',
      color_white: '흰색',
      color_light_gray: '연한 회색',
      color_yellow: '노란색',
      color_light_blue: '연한 파랑',
      color_light_green: '연한 초록',
      color_orange: '주황',
      setting_caption_revision: '✨ 최종 자막 다듬기',
      revision_off: '끔',
      revision_polish: '다듬기',
      setting_caption_revision_hint: '확정된 자막만 후처리하고 실시간 표시는 낮은 지연을 유지합니다',
      setting_caption_terminology: '📚 용어집',
      setting_caption_terminology_placeholder: '한 줄에 규칙 하나, 예: MiHoYo => HoYoverse',

      export_subtitles: '자막 내보내기 (SRT)',
      export_loading: '내보내는 중…',
      export_done: '다운로드 완료',
      export_empty_subtitles: '자막 없음',
      export_failed: '실패',
      export_logs: '로그 내보내기',
      export_empty_logs: '로그 없음',

      shortcut_hint_html: '⌨️ <kbd>Alt+C</kbd> 키로 전환',
      github_cta: 'GitHub에서 스타하기',
      lang_common: '★ 자주 쓰는 언어',
      lang_all: '모든 언어 (70+)',

      overlay_transcript: '자막 기록',

      pip_settings_title: '자막 설정',
      pip_font_size: '글꼴 크기',
      pip_max_lines: '최대 줄 수',
      pip_background: '배경',
      pip_text_color: '글자 색상',
    },

    es: {
      app_name: 'Gemini Live Caption',
      app_subtitle: 'Traducción en tiempo real con IA',

      status_ready: 'Listo',
      status_capturing: 'Capturando',
      status_capturing_other: 'Capturando otra pestaña',
      status_starting: 'Iniciando',

      toggle_start: 'Iniciar subtítulos',
      toggle_stop: 'Detener subtítulos',
      toggle_starting: 'Iniciando…',
      toggle_stopping: 'Deteniendo…',
      toggle_need_key: 'Pega primero tu clave API',

      disclaimer_title: 'Antes de empezar',
      disclaimer_body_html: 'Esta extensión captura el audio de la pestaña y lo envía a Google para su traducción. Al usarla, aceptas las <a href="https://ai.google.dev/terms" target="_blank" rel="noopener">Condiciones del servicio de Google</a>.',
      disclaimer_rule_copyright: 'No captures contenido con derechos de autor sin permiso',
      disclaimer_rule_privacy: 'No grabes conversaciones privadas sin consentimiento',
      disclaimer_rule_freekey: 'Claves gratuitas: Google puede usar tus datos para entrenar modelos',
      disclaimer_rule_age: 'Debes ser mayor de 18 años (requisito de la API de Google)',
      disclaimer_accept: 'Entendido',

      display_mode_label: '🖥️ Modo de visualización',
      display_mode_hint: 'Pulsa el botón PiP en los subtítulos para abrir la ventana flotante',
      display_mode_hint_sub: 'La ventana PiP sigue visible al cambiar de pestaña',
      display_mode_pip_active: 'Ventana PiP activa',

      setting_ui_language: '🌎 Idioma de la interfaz',
      setting_api_key: '🔑 Clave API',
      setting_get_key: 'Obtener clave gratis →',
      setting_api_key_placeholder: 'Introduce tu clave API de Gemini',
      setting_api_key_show_hide: 'Mostrar/ocultar clave API',
      setting_target_language: '🌐 Idioma de destino',
      setting_echo_target: '🔁 Eco del idioma destino',
      setting_echo_target_hint: 'Conserva el habla del idioma destino en el flujo de Live Translate',
      setting_font_size: '📏 Tamaño de fuente',
      setting_max_lines: '📐 Líneas máximas',
      setting_overlay_max_lines: '📐 Líneas del overlay',
      setting_pip_max_lines: '🪟 Líneas PiP',
      setting_bg_opacity: '🎨 Opacidad del fondo',
      setting_audio_gain: '🔊 Ganancia de audio',
      setting_noise_gate: '🔇 Puerta de ruido',
      noise_gate_off: 'Desactivada',
      setting_bilingual: '🌍 Modo bilingüe',
      setting_bilingual_hint: 'Mostrar el idioma original junto a la traducción',
      setting_caption_position: '📍 Posición del subtítulo',
      position_top_left: 'Arriba izquierda',
      position_top_center: 'Arriba centro',
      position_top_right: 'Arriba derecha',
      position_bottom_left: 'Abajo izquierda',
      position_bottom_center: 'Abajo centro',
      position_bottom_right: 'Abajo derecha',
      setting_text_color: '✏️ Color del texto',
      color_white: 'Blanco',
      color_light_gray: 'Gris claro',
      color_yellow: 'Amarillo',
      color_light_blue: 'Azul claro',
      color_light_green: 'Verde claro',
      color_orange: 'Naranja',
      setting_caption_revision: '✨ Pulido final de subtítulos',
      revision_off: 'Desactivado',
      revision_polish: 'Pulir',
      setting_caption_revision_hint: 'Segunda pasada opcional solo para subtítulos finalizados; el texto en vivo mantiene baja latencia',
      setting_caption_terminology: '📚 Terminología',
      setting_caption_terminology_placeholder: 'Una regla por línea, p. ej. MiHoYo => HoYoverse',

      export_subtitles: 'Exportar subtítulos (SRT)',
      export_loading: 'Exportando…',
      export_done: 'Descargado',
      export_empty_subtitles: 'Sin subtítulos',
      export_failed: 'Falló',
      export_logs: 'Exportar registros',
      export_empty_logs: 'Sin registros',

      shortcut_hint_html: '⌨️ Pulsa <kbd>Alt+C</kbd> para alternar',
      github_cta: 'Star en GitHub',
      lang_common: '★ Frecuentes',
      lang_all: 'Todos los idiomas (70+)',

      overlay_transcript: 'Transcripción',

      pip_settings_title: 'Ajustes de subtítulos',
      pip_font_size: 'Tamaño de fuente',
      pip_max_lines: 'Líneas máximas',
      pip_background: 'Fondo',
      pip_text_color: 'Color del texto',
    },
  };

  // Auto-detect a sensible default from chrome.i18n.getUILanguage() (e.g.
  // "zh-CN", "en-US"). Falls back to English. Users can override later.
  function detectInitial() {
    let ui = '';
    try { ui = chrome.i18n.getUILanguage() || ''; } catch (e) { /* not available outside extension contexts */ }
    if (!ui) {
      try { ui = (navigator.language || ''); } catch (e) {}
    }
    if (!ui) return DEFAULT_LANG;
    const lower = ui.toLowerCase();
    if (lower.startsWith('zh-cn') || lower.startsWith('zh-hans') || lower === 'zh' || lower === 'zh-sg') return 'zh-Hans';
    if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant') || lower === 'zh-mo') return 'zh-Hant';
    if (lower.startsWith('ja')) return 'ja';
    if (lower.startsWith('ko')) return 'ko';
    if (lower.startsWith('es')) return 'es';
    return 'en';
  }

  let currentLang = DEFAULT_LANG;
  let initialized = false;
  // Extra DOM roots (Shadow DOMs, separate windows) registered by clients
  // so they get re-translated on language change. Stored as a Set for cheap
  // dedup on re-injection.
  const extraRoots = new Set();

  function t(key, lang) {
    const L = lang || currentLang;
    const table = MESSAGES[L];
    if (table && table[key] !== undefined) return table[key];
    const def = MESSAGES[DEFAULT_LANG][key];
    return def !== undefined ? def : key;
  }

  function apply(root, lang) {
    const where = root || document;
    const L = lang || currentLang;

    where.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'), L);
    });

    where.querySelectorAll('[data-i18n-attr]').forEach(el => {
      // Format: "attr:key" or "attr:key;attr2:key2"
      const spec = el.getAttribute('data-i18n-attr');
      for (const pair of spec.split(';')) {
        const idx = pair.indexOf(':');
        if (idx < 0) continue;
        const attr = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (attr && key) el.setAttribute(attr, t(key, L));
      }
    });

    // innerHTML is only used for keys we author; values are never user input.
    where.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'), L);
    });

    // Mark <html lang> for accessibility/typography
    try { document.documentElement.lang = L; } catch (e) {}
  }

  async function init() {
    if (initialized) return currentLang;
    let saved = null;
    try {
      const r = await chrome.storage.local.get('uiLanguage');
      saved = r && r.uiLanguage;
    } catch (e) { /* storage may not be available in some contexts */ }
    currentLang = SUPPORTED.includes(saved) ? saved : detectInitial();
    initialized = true;
    return currentLang;
  }

  function applyAll(lang) {
    apply(document, lang);
    for (const root of extraRoots) {
      try { apply(root, lang); } catch (e) { /* root may be detached */ }
    }
  }

  async function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    currentLang = lang;
    try { await chrome.storage.local.set({ uiLanguage: lang }); } catch (e) {}
    applyAll(lang);
  }

  function registerRoot(root) {
    if (root) extraRoots.add(root);
  }

  function unregisterRoot(root) {
    extraRoots.delete(root);
  }

  // onChange listener is registered once per JS realm (popup/PiP/host page).
  // For content scripts that re-inject on tab navigation, the Symbol.for guard
  // prevents listener accumulation.
  const _onChangeKey = Symbol.for('__geminiI18nOnChangeRegistered');
  function onChange(cb) {
    if (window[_onChangeKey]) {
      if (typeof cb === 'function') extraCbs.push(cb);
      return;
    }
    window[_onChangeKey] = true;
    if (typeof cb === 'function') extraCbs.push(cb);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.uiLanguage) return;
        const newLang = changes.uiLanguage.newValue;
        if (!SUPPORTED.includes(newLang)) return;
        currentLang = newLang;
        applyAll(newLang);
        for (const fn of extraCbs) { try { fn(newLang); } catch (e) {} }
      });
    } catch (e) { /* no chrome.storage here */ }
  }
  const extraCbs = [];

  function getLang() { return currentLang; }

  // Expose API. __SIGNATURE marks this build so re-injection is a no-op.
  window.I18N = {
    __SIGNATURE: 'GEMINI_LIVE_CAPTION_I18N_V1',
    t, apply, init, setLang, onChange, getLang,
    registerRoot, unregisterRoot,
    SUPPORTED, DEFAULT: DEFAULT_LANG, LABELS: LANG_LABELS,
  };
})();
