/* Exercise the production worker and bundled WASM, then independently inspect/decode files with FFmpeg when installed. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'output');
fs.mkdirSync(output, { recursive: true });
const hasProbe = spawnSync('ffprobe', ['-version']).status === 0;
const hasDecoder = spawnSync('ffmpeg', ['-version']).status === 0;

function runtime() {
  let requestId = 0;
  const pending = new Map();
  const context = vm.createContext({ console, URL, Date, Math, Map, Set, Error, Array, Object, Number, String, Promise, ArrayBuffer, Float32Array, Uint8Array, DataView, WebAssembly, TextDecoder, TextEncoder, atob, btoa });
  context.self = context;
  context.location = { href: 'http://localhost/js/encoder-worker.js' };
  context.AUDIO_CUTTER_WASM = Object.fromEntries(['mp3', 'ogg'].map((format) => [format, new Uint8Array(fs.readFileSync(path.join(root, `vendor/${format}.wasm`)))]));
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(fs.readFileSync(path.resolve(root, 'js', file), 'utf8'), context); };
  context.postMessage = (message) => {
    const job = pending.get(message.id);
    if (message.type === 'done') { pending.delete(message.id); job.resolve(message.data); }
    if (message.type === 'error') { pending.delete(message.id); job.reject(new Error(message.message)); }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/encoder-worker.js'), 'utf8'), context);
  return (request) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    context.onmessage({ data: { ...request, id } });
  });
}

function sine(rate, seconds, channelCount) {
  return Array.from({ length: channelCount }, (_, channel) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, frame) => Math.sin(frame / rate * 2 * Math.PI * (channel ? 660 : 440)) * .5));
}

function saveAndProbe(data, name) {
  const file = path.join(output, name);
  fs.writeFileSync(file, Buffer.from(data));
  if (!hasProbe) return null;
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  if (hasDecoder) {
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.ok(decoded.stdout.length > 0, 'decodes to real audio samples');
    let power = 0;
    for (let at = 0; at < decoded.stdout.length; at += 4) power += decoded.stdout.readFloatLE(at) ** 2;
    assert.ok(power / (decoded.stdout.length / 4) > .01, 'exported audio is not silent');
  }
  return report;
}

test('WAV 16/24/32 retain sample count, stereo order, polarity and endpoints', async () => {
  const encode = runtime();
  const values = [-1, -.5, -.25, 0, .25, .5, 1];
  for (const bits of [16, 24, 32]) {
    const data = await encode({ type: 'encode', format: 'wav', sampleRate: 48000, quality: bits, channels: [Float32Array.from(values), Float32Array.from(values.map((n) => -n))], fadeMs: 0 });
    const view = new DataView(data), header = bits === 32 ? 58 : 44;
    assert.equal(Buffer.from(data, 0, 4).toString(), 'RIFF');
    assert.equal(view.getUint32(4, true), data.byteLength - 8);
    assert.equal(view.getUint16(20, true), bits === 32 ? 3 : 1);
    assert.equal(view.getUint16(22, true), 2);
    assert.equal(view.getUint16(34, true), bits);
    assert.equal(view.getUint32(header - 4, true), values.length * 2 * bits / 8);
    const read = (at) => bits === 16 ? view.getInt16(at, true) / 32768 : bits === 24 ? ((view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getInt8(at + 2) << 16) / 8388608) : view.getFloat32(at, true);
    values.forEach((value, i) => {
      assert.ok(Math.abs(read(header + i * 2 * bits / 8) - value) <= 1 / 32767);
      assert.ok(Math.abs(read(header + (i * 2 + 1) * bits / 8) + value) <= 1 / 32767);
    });
    const audio = await encode({ type: 'encode', format: 'wav', sampleRate: 48000, quality: bits, channels: sine(48000, 1.25, 2), fadeMs: 0 });
    const report = saveAndProbe(audio, `stereo-${bits}.wav`);
    if (report) { assert.equal(report.streams[0].sample_rate, '48000'); assert.equal(report.streams[0].channels, 2); assert.equal(Number(report.streams[0].duration), 1.25); }
  }
});

test('real MP3 and Vorbis files decode, have correct rate/channels, and allow encoder reuse', async () => {
  const encode = runtime();
  for (const format of ['mp3', 'ogg']) {
    for (const [rate, channels, quality] of format === 'mp3' ? [[44100, 2, 192], [48000, 1, 320], [22050, 1, 128]] : [[44100, 2, 5], [48000, 1, 10]]) {
      const data = await encode({ type: 'encode', format, quality, sampleRate: rate, channels: sine(rate, 1.5, channels), fadeMs: 0 });
      assert.ok(data.byteLength > 1024);
      if (format === 'ogg') assert.equal(Buffer.from(data, 0, 4).toString(), 'OggS');
      else assert.equal(new Uint8Array(data)[0] & 0xff, 0xff);
      const report = saveAndProbe(data, `tone-${rate}-${channels}.${format}`);
      if (report) {
        assert.equal(report.streams[0].codec_name, format === 'ogg' ? 'vorbis' : 'mp3');
        assert.equal(report.streams[0].channels, channels);
        assert.equal(Number(report.streams[0].sample_rate), format === 'mp3' && rate === 22050 ? 44100 : rate);
        assert.ok(Math.abs(Number(report.format.duration) - 1.5) < .12);
        if (format === 'mp3') assert.equal(Number(report.streams[0].bit_rate), quality * 1000);
      }
    }
  }
});

test('optional fades silence edges and preserve the center; disabled fades preserve original endpoints', async () => {
  const encode = runtime();
  for (const fadeMs of [0, 5]) {
    const data = await encode({ type: 'encode', format: 'wav', quality: 32, sampleRate: 44100, channels: [new Float32Array(1000).fill(.5)], fadeMs });
    const view = new DataView(data);
    assert.equal(view.getFloat32(58, true), fadeMs ? 0 : .5);
    assert.equal(view.getFloat32(data.byteLength - 4, true), fadeMs ? 0 : .5);
    assert.equal(view.getFloat32(58 + 500 * 4, true), .5);
  }
});

test('multiple encoded clips survive ZIP packaging with UTF-8 filenames and exact bytes', async () => {
  const encode = runtime();
  const { unzipSync } = require('../vendor/fflate.js');
  const first = await encode({ type: 'encode', format: 'wav', quality: 16, sampleRate: 44100, channels: sine(44100, .25, 1), fadeMs: 0 });
  const second = await encode({ type: 'encode', format: 'ogg', quality: 5, sampleRate: 44100, channels: sine(44100, .5, 2), fadeMs: 0 });
  const zip = await encode({ type: 'zip', files: [{ name: '刀剑_01.wav', data: first }, { name: '音效_02.ogg', data: second }] });
  const restored = unzipSync(new Uint8Array(zip));
  assert.deepEqual(Object.keys(restored), ['刀剑_01.wav', '音效_02.ogg']);
  assert.deepEqual(Buffer.from(restored['刀剑_01.wav']), Buffer.from(first));
  assert.deepEqual(Buffer.from(restored['音效_02.ogg']), Buffer.from(second));
});

test('bad PCM, unknown formats, and invalid quality fail explicitly', async () => {
  const encode = runtime();
  const valid = { type: 'encode', format: 'wav', quality: 16, sampleRate: 44100, channels: [new Float32Array(10)], fadeMs: 0 };
  await assert.rejects(encode({ ...valid, channels: [] }), /声道/);
  await assert.rejects(encode({ ...valid, channels: [new Float32Array(0)] }), /为空/);
  await assert.rejects(encode({ ...valid, format: 'aac' }), /格式/);
  await assert.rejects(encode({ ...valid, quality: 8 }), /位深/);
});

test('one-frame and silent clips remain valid for all three formats', async () => {
  const encode = runtime();
  for (const format of ['wav', 'mp3', 'ogg']) {
    const data = await encode({ type: 'encode', format, quality: format === 'wav' ? 16 : format === 'mp3' ? 192 : 5, sampleRate: 44100, channels: [new Float32Array(1)], fadeMs: 5 });
    assert.ok(data.byteLength > 44);
  }
});
