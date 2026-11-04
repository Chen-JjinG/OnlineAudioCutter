/* Browser-local silence and onset detection over decoded PCM. */
(function (root, factory) {
  const split = factory();
  if (typeof module === 'object' && module.exports) module.exports = split;
  else root.AudioCutterAutoSplit = split;
})(globalThis, function () {
  'use strict';
  const QUIET_FRAMES = 25;
  const MIN_SOUND_FRAMES = 5;
  const MIN_ONSET_SPACING = 24;
  const PRE_ROLL_FRAMES = 2;
  const TAIL_FRAMES = 8;
  const MAX_CLIPS = 500;

  function percentile(histogram, count, fraction) {
    let rank = Math.ceil(count * fraction);
    for (let bin = 0; bin < histogram.length; bin++) {
      rank -= histogram[bin];
      if (rank <= 0) return bin - 100;
    }
    return 0;
  }

  return async function detectClips(buffer, shouldContinue = () => true) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
    const frameSize = Math.max(1, Math.round(buffer.sampleRate * .01));
    const levels = new Float32Array(Math.ceil(buffer.length / frameSize));
    const histogram = new Uint32Array(101);
    let peak = -100;
    let yieldAt = performance.now() + 10;
    for (let frame = 0; frame < levels.length; frame++) {
      const start = frame * frameSize;
      const end = Math.min(start + frameSize, buffer.length);
      let energy = 0;
      // Use the loudest channel, so opposite stereo phases cannot cancel.
      for (const channel of channels) {
        let sum = 0;
        for (let sample = start; sample < end; sample++) sum += channel[sample] * channel[sample];
        energy = Math.max(energy, sum / (end - start));
      }
      const level = Math.max(-100, 10 * Math.log10(energy));
      levels[frame] = level;
      peak = Math.max(peak, level);
      histogram[Math.min(100, Math.floor(level) + 100)]++;
      if (performance.now() >= yieldAt) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!shouldContinue()) return null;
        yieldAt = performance.now() + 10;
      }
    }
    if (peak <= -96) return [];
    const reference = Math.max(percentile(histogram, levels.length, .95), peak - 12);
    const noise = percentile(histogram, levels.length, .2);
    // Only raise the threshold for a stable floor, not for a musical decay.
    const noiseGate = noise - percentile(histogram, levels.length, .05) <= 4 ? noise + 8 : -100;
    const quiet = Math.max(-99, Math.min(reference - 24, Math.max(reference - 48, noiseGate)));
    const clips = [];
    const frameTime = frameSize / buffer.sampleRate;
    function append(start, end) {
      if (clips.length === MAX_CLIPS) throw new Error('检测到超过 500 个片段，请分段导入后再试。');
      clips.push({ start: start * frameTime, end: end === levels.length ? buffer.duration : end * frameTime });
    }

    function splitRun(first, last) {
      if (last - first + 1 < MIN_SOUND_FRAMES) return;
      let start = first < QUIET_FRAMES ? 0 : Math.max(0, first - PRE_ROLL_FRAMES);
      const trailing = levels.length - 1 - last;
      const end = trailing < QUIET_FRAMES ? levels.length : last + 1 + TAIL_FRAMES;
      for (let frame = first + 5; frame <= last; frame++) {
        const boundary = frame - 1;
        if (boundary - start < MIN_ONSET_SPACING || end - boundary < MIN_ONSET_SPACING) continue;
        const level = levels[frame];
        if (level < Math.max(quiet + 8, reference - 26) || level - levels[frame - 1] < 5) continue;
        const valley = Math.max(levels[frame - 5], levels[frame - 4], levels[frame - 3], levels[frame - 2]);
        if (valley > reference - 18 || level - valley < 13) continue;
        append(start, boundary);
        start = boundary;
      }
      append(start, end);
    }

    let first = -1;
    let last = -1;
    for (let frame = 0; frame < levels.length; frame++) {
      if (levels[frame] <= quiet) continue;
      if (first < 0) first = frame;
      else if (frame - last - 1 >= QUIET_FRAMES) {
        splitRun(first, last);
        first = frame;
      }
      last = frame;
    }
    if (first >= 0) splitRun(first, last);
    // A continuous take without clear boundaries needs no edit.
    if (clips.length === 1 && clips[0].start === 0 && clips[0].end === buffer.duration) return [];
    return clips;
  };
});
