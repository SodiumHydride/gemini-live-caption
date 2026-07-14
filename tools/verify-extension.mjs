#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(relPath) {
  return readFileSync(path.join(root, relPath), 'utf8');
}

function readJson(relPath) {
  return JSON.parse(read(relPath));
}

function listFiles(dir, ext, acc = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(rel, ext, acc);
    else if (entry.isFile() && entry.name.endsWith(ext)) acc.push(rel);
  }
  return acc;
}

function messageBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const next = source.indexOf('\n  if (msg.type ===', start + marker.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

function functionBlock(source, name) {
  const start = source.indexOf(`async function ${name}`);
  if (start < 0) return '';
  const next = source.indexOf('\nasync function ', start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

function assertCaptionRollCapture(source, relPath) {
  const showIndex = source.indexOf('function show(');
  const applyIndex = source.indexOf('const model = captionTrack.applyCaption', showIndex);
  const heightIndex = source.indexOf('const rollFromHeight = flowEl ? flowEl.scrollHeight : 0;', showIndex);
  const hasTextIndex = source.indexOf('const hadRollText = captionTrack.snapshot().hasText;', showIndex);
  const preApply = source.slice(showIndex, applyIndex);
  assert(showIndex >= 0 && applyIndex > showIndex, `${relPath} must keep caption updates inside show()`);
  assert(heightIndex > showIndex && heightIndex < applyIndex, `${relPath} must capture pre-render caption height before state update`);
  assert(hasTextIndex > heightIndex && hasTextIndex < applyIndex, `${relPath} must capture pre-render caption presence before state update`);
  assert(!preApply.includes('let rollFromHeight = 0'), `${relPath} must not only prepare roll height for final captions`);
  assert(!preApply.includes('let hadRollText = false'), `${relPath} must not only prepare roll text state for final captions`);
}

const manifest = readJson('manifest.json');
assert(manifest.manifest_version === 3, 'manifest must stay on MV3');
assert(manifest.default_locale === 'en', 'manifest must declare the default Chrome locale');
assert(manifest.name === '__MSG_extensionName__', 'manifest name must use Chrome native localization');
assert(manifest.description === '__MSG_extensionDescription__', 'manifest description must use Chrome native localization');
assert(manifest.background?.service_worker === 'service-worker.js', 'background service worker must be service-worker.js');
assert(manifest.action?.default_popup === 'popup/popup.html', 'popup entry must be popup/popup.html');
assert(manifest.action?.default_title === '__MSG_extensionName__', 'popup title must use Chrome native localization');
assert((manifest.permissions || []).includes('offscreen'), 'offscreen permission is required for tab audio capture');

for (const locale of ['en', 'zh_CN', 'zh_TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt_BR', 'ru']) {
  const messages = readJson(`_locales/${locale}/messages.json`);
  for (const key of ['extensionName', 'extensionDescription', 'toggleCaptionCommand']) {
    assert(typeof messages[key]?.message === 'string' && messages[key].message.trim(), `${locale} locale message is missing: ${key}`);
  }
  assert(Array.from(messages.extensionDescription.message).length <= 132, `${locale} manifest description must fit Chrome's 132-character limit`);
}

const requiredFiles = new Set([
  'manifest.json',
  'service-worker.js',
  'offscreen.html',
  'offscreen.js',
  'audio-processor.js',
  'content.js',
  'caption-track.js',
  'pip.html',
  'pip.css',
  'pip.js',
  'i18n.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...((manifest.web_accessible_resources || []).flatMap(group => group.resources || [])),
]);
for (const rel of requiredFiles) {
  assert(existsSync(path.join(root, rel)), `required file is missing: ${rel}`);
}

for (const rel of listFiles('.', '.js')) {
  const check = spawnSync(process.execPath, ['--check', rel], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(check.status === 0, `node --check failed for ${rel}\n${check.stderr || check.stdout}`);
}

const offscreen = read('offscreen.js');
assert(offscreen.includes("model: 'models/gemini-3.5-live-translate-preview'"), 'offscreen must use the dedicated Live Translate model');
assert(/generationConfig:\s*{[\s\S]*translationConfig:\s*{[\s\S]*targetLanguageCode/.test(offscreen), 'translationConfig must live under generationConfig');
assert(/generationConfig:\s*{[\s\S]*translationConfig:\s*{[\s\S]*},\s*},\s*inputAudioTranscription:\s*{}/.test(offscreen), 'input transcription must live at setup top-level');
assert(/inputAudioTranscription:\s*{},\s*outputAudioTranscription:\s*{}/.test(offscreen), 'output transcription must live at setup top-level');
assert(!offscreen.includes('systemInstruction'), 'Live Translate setup must not use unsupported system instructions');
assert(!offscreen.includes('captionTerminology'), 'Live Translate setup must not pretend to support terminology prompts');
assert(!/\bmediaChunks\s*:/.test(offscreen), 'realtimeInput.mediaChunks must not return');
assert(offscreen.includes("mimeType: 'audio/pcm;rate=16000'"), 'audio frames must declare 16kHz PCM');
assert(offscreen.includes('sessionResumption'), 'session resumption must stay wired for long live sessions');
assert(offscreen.includes('orphan source text'), 'input transcription must not be attached to the wrong target segment');

const serviceWorker = read('service-worker.js');
assert(serviceWorker.includes("const TRANSCRIPT_SEGMENTS_KEY = 'transcriptSegments'"), 'service worker must own transcript segments');
assert(serviceWorker.includes("const REVISION_MODEL = 'gemini-3.5-flash'"), 'caption revision model must be explicit');
const exportBlock = messageBlock(serviceWorker, "if (msg.type === 'EXPORT_CAPTIONS')");
const settingsExportBlock = messageBlock(serviceWorker, "if (msg.type === 'EXPORT_SETTINGS')");
const toggleBlock = functionBlock(serviceWorker, 'toggleCapture');
assert(exportBlock.includes('formatSRT(segments)'), 'SRT export must be generated from stored segments');
assert(!exportBlock.includes('tabs.sendMessage'), 'SRT export must not ask content scripts for history');
assert(settingsExportBlock.includes('EXPORTABLE_SETTINGS'), 'settings export must use the allowlisted setting keys');
assert(!settingsExportBlock.includes('apiKey'), 'settings export must never include the API key');
assert(!serviceWorker.includes('onMessageExternal'), 'extension must not expose settings through external messages');
assert(!serviceWorker.includes('EXPORT_PEER_SETTINGS') && !serviceWorker.includes('GET_PEER_SETTINGS'), 'legacy peer settings export messages must not return');
assert(serviceWorker.includes("files: ['i18n.js', 'caption-track.js', 'content.js']"), 'content injection must load caption-track before content.js');
assert((toggleBlock.match(/startCapture\(tabId\)/g) || []).length === 1, 'global toggle must only start capture from idle');
assert(/captureState === 'capturing'[\s\S]*await stopCapture\(\);/.test(toggleBlock), 'global toggle must stop an existing capture instead of switching source tabs');
assert(toggleBlock.indexOf("captureState === 'capturing'") < toggleBlock.indexOf('disclaimerAccepted'), 'stop toggle must run before start-only disclaimer checks');

const popup = read('popup/popup.html') + '\n' + read('popup/popup.js');
assert(popup.includes('overlayMaxLinesControl'), 'popup must expose overlay line count');
assert(popup.includes('pipMaxLinesControl'), 'popup must expose PiP line count');
assert(popup.includes('captionRevisionModeControl'), 'popup must expose caption revision mode');
assert(popup.includes('echoTargetLanguage'), 'popup must expose Live Translate echo setting');
assert(popup.includes('currentPopupTabId') && popup.includes('status_capturing_other'), 'popup must distinguish capture running in another tab');
assert(popup.includes('stoppingExistingCapture') && popup.includes("tr('toggle_stopping'"), 'popup stop path must not look like a start operation');
assert(!/maxLinesControl|saveSettings\(\{\s*maxLines\b/.test(popup), 'popup must not write legacy maxLines');

const content = read('content.js');
const pip = read('pip.js');
const pipHtml = read('pip.html');
const pipCss = read('pip.css');
assert(content.includes("window.CaptionTrack.create"), 'content.js must use shared caption-track state');
assert(pip.includes("window.CaptionTrack.create"), 'pip.js must use shared caption-track state');
assert(content.includes("source: 'hydrate'"), 'PiP replay must mark hydrated captions as non-live');
assert(!content.includes('lineHeight * 0.65') && !pip.includes('lineHeight * 0.65'), 'caption roll must not use artificial fallback distance');
assert(content.includes('caption-row') && pip.includes('caption-row'), 'caption rendering must be row-based for lyrics-style upward motion');
assert(content.includes('window.CaptionTrack.shapeRows') && pip.includes('window.CaptionTrack.shapeRows'), 'caption rendering must shape long rows before drawing');
assert(content.includes('-webkit-line-clamp: 1') && pipCss.includes('-webkit-line-clamp: 1'), 'translated caption visual rows must stay one physical line');
assert(pipHtml.includes('src="caption-track.js"'), 'PiP HTML must load caption-track before pip.js');
assert(!/local-\$\{|id:\s*`local-/.test(content), 'content.js must not fabricate local transcript segment ids');
assert(!/local-\$\{|id:\s*`local-/.test(pip), 'pip.js must not fabricate local transcript segment ids');
assertCaptionRollCapture(content, 'content.js');
assertCaptionRollCapture(pip, 'pip.js');

const trackSandbox = { console };
trackSandbox.globalThis = trackSandbox;
vm.createContext(trackSandbox);
vm.runInContext(read('caption-track.js'), trackSandbox, { filename: 'caption-track.js' });
assert(trackSandbox.CaptionTrack.joinSegments('Hello,', 'world') === 'Hello, world', 'caption-track must keep English spacing after commas');
assert(trackSandbox.CaptionTrack.joinSegments('你好，', '世界') === '你好，世界', 'caption-track must not inject spaces into CJK punctuation');
assert(trackSandbox.CaptionTrack.joinSegments('Hello', '.') === 'Hello.', 'caption-track must not insert spaces before punctuation');
const longCaption = 'This is a deliberately long real-time translation chunk that should become several stable visual subtitle rows instead of one giant DOM line.';
const shapedLong = trackSandbox.CaptionTrack.shapeRows([
  { id: 'long-live', primary: longCaption, secondary: '', live: true },
], { maxRows: 3, maxUnits: 18 });
assert(shapedLong.rows.length === 3 && shapedLong.totalRows > shapedLong.rows.length, 'long live captions must render as a bounded rolling visual window');
assert(shapedLong.rows[2].id === shapedLong.tailKey, 'shaped caption windows must expose a stable tail key');
const longTrack = trackSandbox.CaptionTrack.create({ bilingualMode: false, maxChars: 120 });
let longModel = longTrack.applyCaption({ text: longCaption, isFinal: false });
assert(longModel.primaryText === longCaption, 'caption-track must preserve full long live text in state');
const track = trackSandbox.CaptionTrack.create({ bilingualMode: true, maxChars: 120 });
let model = track.applyCaption({ text: '你好世界', isFinal: false, original: 'hello world' });
assert(model.primaryText === '你好世界' && model.secondaryText === 'hello world' && model.rows.length === 1 && model.rows[0].live && !model.animate, 'caption-track must render first bilingual partial without animation');
model = track.applyCaption({ text: '你好世界。', isFinal: true, original: 'hello world.', segment: { id: 's1' }, source: 'live' });
assert(!model.animate && model.primaryText === '你好世界。' && model.secondaryText === 'hello world.', 'caption-track must not roll when finalizing the first visible line');
model = track.applyCaption({ text: '你好世界。', isFinal: true, original: 'hello world.', segment: { id: 's1' }, source: 'live' });
assert(!model.changed && !model.animate, 'caption-track must ignore duplicate finalized captions');
model = track.applyCaption({ text: '下一句开始', isFinal: false, original: 'next line starts' });
assert(model.changed && model.animate && model.rows.length === 2 && model.rows[1].live, 'caption-track must animate when a new live row starts below committed captions');
model = track.applySegmentUpdate({ id: 's1', text: '你好，世界。', original: 'hello world.' });
assert(model.changed && !model.animate && model.rows[0].primary === '你好，世界。', 'caption-track revisions must update committed rows without roll animation');
track.clear();
track.applyCaption({ text: 'Already visible', isFinal: false, original: '已经显示' });
model = track.applyCaption({ text: 'Already visible', isFinal: true, original: '已经显示', segment: { id: 's-exact' }, source: 'live' });
assert(model.changed && !model.animate && model.primaryText === 'Already visible', 'caption-track must not roll when final text exactly matches visible partial');
track.clear();
track.applyCaption({ text: 'Hello world and welcome back', isFinal: false, original: '大家好，欢迎回来' });
model = track.applyCaption({ text: 'Hello world', isFinal: true, original: '大家好，', segment: { id: 's-prefix' }, source: 'live' });
assert(model.changed && model.animate && model.primaryText === 'Hello world and welcome back' && model.rows.length === 2, 'caption-track must split visible prefix finals into rolling committed/live rows');
model = track.hydrate([{ id: 's2', text: '回放字幕。', original: 'replayed caption.' }]);
assert(model.changed && !model.animate && model.primaryText === '回放字幕。', 'caption-track hydrate must not animate replayed captions');

const i18n = read('i18n.js');
for (const key of [
  'setting_overlay_max_lines',
  'setting_pip_max_lines',
  'setting_echo_target',
  'setting_caption_revision',
  'setting_caption_terminology',
  'export_settings',
  'status_capturing_other',
  'toggle_stopping',
]) {
  assert(i18n.includes(`${key}:`), `i18n key is missing: ${key}`);
}

if (failures.length) {
  console.error(`verify-extension failed (${failures.length})`);
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log('verify-extension passed');
