#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const manifest = JSON.parse(read('manifest.json'));
assert(manifest.manifest_version === 3, 'manifest must stay on MV3');
assert(manifest.background?.service_worker === 'service-worker.js', 'background service worker must be service-worker.js');
assert(manifest.action?.default_popup === 'popup/popup.html', 'popup entry must be popup/popup.html');
assert((manifest.permissions || []).includes('offscreen'), 'offscreen permission is required for tab audio capture');

const requiredFiles = new Set([
  'manifest.json',
  'service-worker.js',
  'offscreen.html',
  'offscreen.js',
  'audio-processor.js',
  'content.js',
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
assert(offscreen.includes('setupConfig.systemInstruction = buildTranslationSystemInstruction'), 'Live setup must include translation system instruction');
assert(offscreen.includes('return { parts: [{ text }] }'), 'systemInstruction must be a Gemini Content object');
assert(offscreen.includes('captionTerminology'), 'Live setup must receive terminology settings');
assert(!/\bmediaChunks\s*:/.test(offscreen), 'realtimeInput.mediaChunks must not return');
assert(offscreen.includes("mimeType: 'audio/pcm;rate=16000'"), 'audio frames must declare 16kHz PCM');
assert(offscreen.includes('sessionResumption'), 'session resumption must stay wired for long live sessions');

const serviceWorker = read('service-worker.js');
assert(serviceWorker.includes("const TRANSCRIPT_SEGMENTS_KEY = 'transcriptSegments'"), 'service worker must own transcript segments');
assert(serviceWorker.includes("const REVISION_MODEL = 'gemini-3.5-flash'"), 'caption revision model must be explicit');
const exportBlock = messageBlock(serviceWorker, "if (msg.type === 'EXPORT_CAPTIONS')");
assert(exportBlock.includes('formatSRT(segments)'), 'SRT export must be generated from stored segments');
assert(!exportBlock.includes('tabs.sendMessage'), 'SRT export must not ask content scripts for history');

const popup = read('popup/popup.html') + '\n' + read('popup/popup.js');
assert(popup.includes('overlayMaxLinesControl'), 'popup must expose overlay line count');
assert(popup.includes('pipMaxLinesControl'), 'popup must expose PiP line count');
assert(popup.includes('captionRevisionModeControl'), 'popup must expose caption revision mode');
assert(popup.includes('echoTargetLanguage'), 'popup must expose Live Translate echo setting');
assert(!/maxLinesControl|saveSettings\(\{\s*maxLines\b/.test(popup), 'popup must not write legacy maxLines');

const content = read('content.js');
const pip = read('pip.js');
assert(!/local-\$\{|id:\s*`local-/.test(content), 'content.js must not fabricate local transcript segment ids');
assert(!/local-\$\{|id:\s*`local-/.test(pip), 'pip.js must not fabricate local transcript segment ids');

const i18n = read('i18n.js');
for (const key of [
  'setting_overlay_max_lines',
  'setting_pip_max_lines',
  'setting_echo_target',
  'setting_caption_revision',
  'setting_caption_terminology',
]) {
  assert(i18n.includes(`${key}:`), `i18n key is missing: ${key}`);
}

if (failures.length) {
  console.error(`verify-extension failed (${failures.length})`);
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log('verify-extension passed');
