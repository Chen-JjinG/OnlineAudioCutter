const { test } = require('node:test');
const assert = require('node:assert/strict');
const detectClips = require('../js/auto-split.js');

function audio(seconds, envelope, stereo = false) {
  const sampleRate = 8000;
  const length = Math.round(seconds * sampleRate);
  const mono = Float32Array.from({ length }, (_, i) => envelope(i / sampleRate) * Math.sin(i * Math.PI * .11));
  const channels = stereo ? [mono, mono.map((sample) => -sample)] : [mono];
  return { sampleRate, length, duration: length / sampleRate, numberOfChannels: channels.length, getChannelData: (index) => channels[index] };
}

test('splits sound effects around quiet intervals, retaining context and opposing stereo channels', async () => {
  const source = audio(3, (time) => {
    if (time >= .4 && time < .8) return .5;
    if (time >= 1.35 && time < 1.69) return .15;
    if (time >= 2.3 && time < 2.5) return .33;
    return .001;
  }, true);
  const clips = await detectClips(source);
  assert.equal(clips.length, 3);
  for (const [index, [attack, release]] of [[.4, .8], [1.35, 1.69], [2.3, 2.5]].entries()) {
    assert.ok(clips[index].start <= attack && clips[index].start >= attack - .03);
    assert.ok(clips[index].end >= release && clips[index].end <= release + .09);
    if (index > 0) assert.ok(clips[index - 1].end < clips[index].start);
  }
});

test('finds new attacks in a continuous decaying recording', async () => {
  const source = audio(4.007, (time) => .4 * Math.exp(-(time % 1) * 4));
  const clips = await detectClips(source);
  assert.equal(clips.length, 4);
  assert.equal(clips[0].start, 0);
  assert.equal(clips.at(-1).end, source.duration);
  for (let i = 1; i < clips.length; i++) {
    assert.ok(Math.abs(clips[i].start - i) <= .02);
    assert.equal(clips[i - 1].end, clips[i].start);
  }
});

test('keeps sustained audio and silence unchanged and ignores brief dropouts', async () => {
  assert.deepEqual(await detectClips(audio(1.007, () => .3)), []);
  assert.deepEqual(await detectClips(audio(1, () => 0)), []);
  assert.deepEqual(await detectClips(audio(2, (time) => time >= .8 && time < .82 ? 0 : .3)), []);
});
