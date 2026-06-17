// caption-track.js — shared live subtitle state for overlay and PiP.
//
// Interface:
//   const track = CaptionTrack.create({ bilingualMode: false, maxChars: 720 });
//   track.applyCaption({ text, isFinal, original, segment, source: 'live' });
//   track.applySegmentUpdate(segment);
//   track.hydrate(segments);
//   track.clear();

(function (global) {
  'use strict';

  const DEFAULT_MAX_CHARS = 720;
  const NO_SPACE_BEFORE_RE = /^[，,。.!！？?…、；;：:)"'”’)\]】»」』]/;
  const NO_SPACE_AFTER_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af，。！？…、；："'“‘(\[【«「『]$/;
  const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  const SPACE_RE = /\s/;
  const PUNCTUATION_RE = /^[，,。.!！？?…、；;：:)"'”’)\]】»」』(\[【«「『-]$/;
  const SOFT_BREAK_RE = /^[\s，,。.!！？?…、；;：:)"'”’)\]】»」』-]$/;

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function joinSegments(a, b) {
    const left = cleanText(a);
    const right = cleanText(b);
    if (!left) return right;
    if (!right) return left;
    if (NO_SPACE_AFTER_RE.test(left) || NO_SPACE_BEFORE_RE.test(right)) return left + right;
    return left + ' ' + right;
  }

  function textUnit(char) {
    if (SPACE_RE.test(char)) return 0.34;
    if (CJK_RE.test(char)) return 1;
    if (PUNCTUATION_RE.test(char)) return 0.42;
    return 0.56;
  }

  function measureTextUnits(text) {
    return Array.from(cleanText(text)).reduce((sum, char) => sum + textUnit(char), 0);
  }

  function splitTextIntoLines(text, maxUnits = 42) {
    const chars = Array.from(cleanText(text));
    if (!chars.length) return [];

    const limit = Math.max(6, Number.isFinite(maxUnits) ? maxUnits : 42);
    const lines = [];
    let line = [];
    let units = 0;
    let breakAt = -1;

    function recomputeBreak() {
      breakAt = -1;
      for (let i = 0; i < line.length; i += 1) {
        if (SOFT_BREAK_RE.test(line[i])) breakAt = i + 1;
      }
    }

    function pushLine(cut) {
      const value = line.slice(0, cut).join('').trim();
      if (value) lines.push(value);
      line = line.slice(cut);
      while (line[0] && SPACE_RE.test(line[0])) line.shift();
      units = line.reduce((sum, char) => sum + textUnit(char), 0);
      recomputeBreak();
    }

    for (const char of chars) {
      line.push(char);
      units += textUnit(char);
      if (SOFT_BREAK_RE.test(char)) breakAt = line.length;
      if (units > limit && line.length > 1) {
        const cut = breakAt > 0 && breakAt < line.length ? breakAt : line.length - 1;
        pushLine(cut);
      }
    }

    pushLine(line.length);
    return lines;
  }

  function shapeRows(rows = [], options = {}) {
    const maxRows = Math.max(1, Math.floor(Number.isFinite(options.maxRows) ? options.maxRows : rows.length || 1));
    const maxUnits = Number.isFinite(options.maxUnits) ? options.maxUnits : 42;
    const allRows = [];

    rows.forEach((row, rowIndex) => {
      const sourceId = row.id || `row-${rowIndex}`;
      const primaryLines = splitTextIntoLines(row.primary, maxUnits);
      const secondaryLine = row.secondary ? splitTextIntoLines(row.secondary, maxUnits)[0] || '' : '';
      const lineCount = Math.max(primaryLines.length, secondaryLine ? 1 : 0);

      for (let partIndex = 0; partIndex < lineCount; partIndex += 1) {
        allRows.push({
          id: `${sourceId}:${partIndex}`,
          sourceId,
          partIndex,
          primary: primaryLines[partIndex] || '',
          secondary: partIndex === 0 ? secondaryLine : '',
          live: !!row.live,
        });
      }
    });

    return {
      rows: allRows.slice(-maxRows),
      totalRows: allRows.length,
      tailKey: allRows[allRows.length - 1]?.id || '',
      overflowed: allRows.length > maxRows,
    };
  }

  function normalizeSegment(segment, text, original) {
    const id = segment?.id || segment?.segmentId;
    const normalizedText = cleanText(text || segment?.text);
    if (!id || !normalizedText) return null;
    return {
      ...segment,
      id,
      text: normalizedText,
      original: cleanText(original || segment?.original),
    };
  }

  function create(options = {}) {
    let bilingualMode = !!options.bilingualMode;
    let maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
    let committedSegments = [];
    let liveText = '';
    let liveOriginal = '';
    let lastFinalized = '';

    function configure(next = {}) {
      if (next.bilingualMode !== undefined) bilingualMode = !!next.bilingualMode;
      if (Number.isFinite(next.maxChars)) maxChars = next.maxChars;
      trimCommitted();
      return snapshot({ changed: true, animate: false, reason: 'configure' });
    }

    function applyCaption({ text, isFinal, original, segment, source = 'live' } = {}) {
      const normalizedText = cleanText(text);
      const normalizedOriginal = cleanText(original || segment?.original);

      if (!normalizedText) {
        if (!isFinal && (liveText || liveOriginal)) {
          liveText = '';
          liveOriginal = '';
          return snapshot({ changed: true, animate: false, reason: 'partial-clear' });
        }
        return snapshot();
      }

      if (!isFinal) {
        const startsLiveRow = !liveText && !liveOriginal;
        const hadCommittedRows = committedSegments.length > 0;
        liveText = normalizedText;
        liveOriginal = normalizedOriginal;
        return snapshot({
          changed: true,
          animate: source === 'live' && startsLiveRow && hadCommittedRows,
          reason: startsLiveRow ? 'partial-start' : 'partial',
        });
      }

      const entry = normalizeSegment(segment, normalizedText, normalizedOriginal);
      if (!entry) return snapshot({ reason: 'missing-final-segment' });
      if (entry.id === lastFinalized || committedSegments.some(item => item.id === entry.id)) {
        return snapshot({ reason: 'duplicate-final' });
      }

      const textWasVisible = !!liveText && (
        liveText === entry.text ||
        liveText.startsWith(entry.text) ||
        entry.text.startsWith(liveText)
      );
      const originalWasVisible = !!entry.original && !!liveOriginal && liveOriginal.startsWith(entry.original);
      const nextLiveText = textWasVisible && liveText.length > entry.text.length
        ? cleanText(liveText.slice(entry.text.length))
        : '';
      const nextLiveOriginal = originalWasVisible && liveOriginal.length > entry.original.length
        ? cleanText(liveOriginal.slice(entry.original.length))
        : '';
      const createsTailRow = !!(nextLiveText || nextLiveOriginal);
      const hadPriorText = !!(committedSegments.length || liveText || liveOriginal);
      lastFinalized = entry.id;
      committedSegments.push(entry);
      liveText = nextLiveText;
      liveOriginal = nextLiveOriginal;
      trimCommitted();
      return snapshot({
        changed: true,
        animate: source === 'live' && hadPriorText && (!textWasVisible || createsTailRow),
        reason: createsTailRow ? 'final-split' : 'final',
      });
    }

    function applySegmentUpdate(segment) {
      const entry = normalizeSegment(segment);
      if (!entry) return snapshot({ reason: 'invalid-update' });
      const idx = committedSegments.findIndex(item => item.id === entry.id);
      if (idx < 0) return snapshot({ reason: 'update-miss' });
      committedSegments[idx] = { ...committedSegments[idx], ...entry };
      trimCommitted();
      return snapshot({ changed: true, animate: false, reason: 'revision' });
    }

    function hydrate(segments = []) {
      committedSegments = segments
        .map(segment => normalizeSegment(segment))
        .filter(Boolean);
      trimCommitted();
      const last = committedSegments[committedSegments.length - 1];
      lastFinalized = last?.id || '';
      liveText = '';
      liveOriginal = '';
      return snapshot({ changed: true, animate: false, reason: 'hydrate' });
    }

    function clear() {
      committedSegments = [];
      liveText = '';
      liveOriginal = '';
      lastFinalized = '';
      return snapshot({ changed: true, animate: false, reason: 'clear' });
    }

    function trimCommitted() {
      while (committedSegments.length > 1 && committedLength() > maxChars) {
        committedSegments.shift();
      }
    }

    function committedLength() {
      return committedSegments.reduce((total, item) => total + item.text.length + (item.original || '').length, 0);
    }

    function snapshot(meta = {}) {
      const rows = committedSegments.map(seg => ({
        id: seg.id,
        primary: seg.text,
        secondary: bilingualMode ? seg.original : '',
        live: false,
      }));
      if (liveText || (bilingualMode && liveOriginal)) {
        rows.push({
          id: 'live',
          primary: liveText,
          secondary: bilingualMode ? liveOriginal : '',
          live: true,
        });
      }
      const primaryText = rows.reduce((acc, row) => joinSegments(acc, row.primary), '');
      const secondaryText = bilingualMode
        ? rows.reduce((acc, row) => joinSegments(acc, row.secondary), '')
        : '';
      return {
        changed: !!meta.changed,
        animate: !!meta.animate,
        reason: meta.reason || '',
        primaryText,
        secondaryText,
        hasText: !!(primaryText || secondaryText),
        rows,
        segments: committedSegments.slice(),
      };
    }

    return {
      configure,
      applyCaption,
      applySegmentUpdate,
      hydrate,
      clear,
      snapshot,
    };
  }

  global.CaptionTrack = { create, joinSegments, measureTextUnits, splitTextIntoLines, shapeRows };
})(typeof globalThis !== 'undefined' ? globalThis : window);
