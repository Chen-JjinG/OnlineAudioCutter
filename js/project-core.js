/* Shared, deterministic operations used by the editor and its regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioCutterProjectCore = api;
})(globalThis, function () {
  'use strict';
  function batchNames(clips, options = {}) {
    if (options.start === '') throw new Error('请输入起始编号。');
    const start = Number(options.start ?? 1), digits = Number(options.digits ?? 3);
    if (!Number.isSafeInteger(start) || start < 0 || start > 999999) throw new Error('起始编号应为 0–999999 之间的整数。');
    if (!Number.isInteger(digits) || digits < 1 || digits > 6) throw new Error('编号位数应为 1–6。');
    const separator = ['_', '-', ''].includes(options.separator) ? options.separator : '_';
    // Leave room for the numeric suffix so export's filename limit never removes the sequence.
    const prefix = String(options.prefix ?? '').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '').replace(/\.(wav|mp3|ogg)$/i, '').slice(0, 80);
    return clips.map((clip, index) => ({ id: clip.id, name: `${prefix}${prefix ? separator : ''}${String(start + index).padStart(digits, '0')}` }));
  }

  function validClips(clips, duration) {
    const seen = new Set();
    return (Array.isArray(clips) ? clips : []).filter((clip) => {
      if (!clip || typeof clip.id !== 'string' || !clip.id || seen.has(clip.id)) return false;
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end > duration || clip.end <= clip.start) return false;
      seen.add(clip.id);
      return true;
    }).map((clip) => ({ id: clip.id, start: clip.start, end: clip.end, name: String(clip.name || '未命名片段').slice(0, 160), checked: clip.checked !== false }));
  }
  return { batchNames, validClips };
});
