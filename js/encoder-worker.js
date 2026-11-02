/* Runs PCM packing, WASM encoding and ZIP creation off the UI thread. */
'use strict';
const encoders = new Map();

function progress(id, value) { self.postMessage({ id, type: 'progress', progress: value }); }

function validatePcm(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) throw new Error('导出只支持单声道或立体声。');
  const frames = channels[0].length;
  if (!frames || channels.some((c) => !(c instanceof Float32Array) || c.length !== frames)) throw new Error('音频采样数据无效或片段为空。');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('不支持这个采样率，请选择 44.1 kHz 或 48 kHz。');
}

function fadeEdges(channels, sampleRate, fadeMs) {
  if (!Number.isFinite(fadeMs) || fadeMs <= 0) return;
  const frames = channels[0].length;
  const count = Math.min(Math.round(sampleRate * fadeMs / 1000), Math.floor(frames / 2));
  for (const channel of channels) {
    for (let i = 0; i < count; i++) {
      const gain = i / Math.max(1, count - 1);
      channel[i] *= gain;
      channel[frames - 1 - i] *= gain;
    }
  }
}

function encodeWav(channels, sampleRate, bits, id) {
  if (![16, 24, 32].includes(bits)) throw new Error('WAV 位深无效。');
  const floating = bits === 32;
  const frames = channels[0].length, count = channels.length, bytesPerSample = bits / 8;
  const header = floating ? 58 : 44, dataSize = frames * count * bytesPerSample;
  if (dataSize > 0xffffffff - header) throw new Error('WAV 超过 4 GB，请拆成较短的片段。');
  const buffer = new ArrayBuffer(header + dataSize), view = new DataView(buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, floating ? 18 : 16, true); view.setUint16(20, floating ? 3 : 1, true);
  view.setUint16(22, count, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * count * bytesPerSample, true);
  view.setUint16(32, count * bytesPerSample, true); view.setUint16(34, bits, true);
  if (floating) { view.setUint16(36, 0, true); text(38, 'fact'); view.setUint32(42, 4, true); view.setUint32(46, frames, true); }
  text(header - 8, 'data'); view.setUint32(header - 4, dataSize, true);
  for (let frame = 0, at = header; frame < frames; frame++) {
    for (const channel of channels) {
      let sample = Number.isFinite(channel[frame]) ? channel[frame] : 0;
      if (!floating) sample = Math.max(-1, Math.min(1, sample));
      if (bits === 16) view.setInt16(at, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      else if (bits === 24) {
        const value = Math.round(sample * (sample < 0 ? 8388608 : 8388607));
        view.setUint8(at, value & 255); view.setUint8(at + 1, (value >> 8) & 255); view.setUint8(at + 2, (value >> 16) & 255);
      } else view.setFloat32(at, sample, true);
      at += bytesPerSample;
    }
    if (frame % 65536 === 0) progress(id, frame / frames);
  }
  return buffer;
}

async function encodeCompressed(channels, sampleRate, format, quality, id) {
  if (!self.WasmMediaEncoder) importScripts('../vendor/wasm-media-encoders.js');
  if (!encoders.has(format)) {
    const wasm = self.AUDIO_CUTTER_WASM?.[format] || new URL(`../vendor/${format}.wasm`, self.location.href).href;
    encoders.set(format, await self.WasmMediaEncoder.createEncoder(format === 'mp3' ? 'audio/mpeg' : 'audio/ogg', wasm));
  }
  const encoder = encoders.get(format);
  const options = { channels: channels.length, sampleRate };
  if (format === 'mp3') {
    if (![128, 192, 256, 320].includes(quality)) throw new Error('MP3 比特率无效。');
    options.bitrate = quality;
    // LAME supports up to 48 kHz output and resamples from higher project rates internally.
    options.outputSampleRate = [32000, 44100, 48000].includes(sampleRate) ? sampleRate : 44100;
  } else {
    if (![3, 5, 7, 10].includes(quality)) throw new Error('OGG 品质无效。');
    options.vbrQuality = quality;
  }
  encoder.configure(options);
  const chunks = [], frames = channels[0].length;
  let length = 0, lastReport = 0;
  for (let frame = 0; frame < frames; frame += 8192) {
    const chunk = encoder.encode(channels.map((c) => c.subarray(frame, Math.min(frames, frame + 8192))));
    if (chunk.length) { const owned = chunk.slice(); chunks.push(owned); length += owned.length; }
    if (Date.now() - lastReport > 80) { progress(id, frame / frames); lastReport = Date.now(); }
  }
  // Encoder views point into mutable WASM memory and must be copied before the next call.
  const tail = encoder.finalize().slice();
  chunks.push(tail); length += tail.length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output.buffer;
}

self.onmessage = async ({ data: request }) => {
  const { id } = request;
  try {
    let data;
    if (request.type === 'encode') {
      const { channels, sampleRate, quality, format, fadeMs } = request;
      validatePcm(channels, sampleRate);
      if (!['wav', 'mp3', 'ogg'].includes(format)) throw new Error('不支持这个导出格式。');
      progress(id, 0);
      fadeEdges(channels, sampleRate, fadeMs);
      data = format === 'wav' ? encodeWav(channels, sampleRate, quality, id) : await encodeCompressed(channels, sampleRate, format, quality, id);
    } else if (request.type === 'zip') {
      if (!self.fflate) importScripts('../vendor/fflate.js');
      const files = Object.create(null);
      for (const file of request.files) files[file.name] = new Uint8Array(file.data);
      data = self.fflate.zipSync(files, { level: 0 }).buffer;
    } else throw new Error('未知编码任务。');
    progress(id, 1);
    self.postMessage({ id, type: 'done', data }, [data]);
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message || '音频编码失败。' });
  }
};
