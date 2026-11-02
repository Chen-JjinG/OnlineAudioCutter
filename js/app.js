/* Audio Cutter — buildless, browser-local editor. Third-party versions are pinned in vendor/. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ui = {
    upload: $('audio-upload'), play: $('btn-play-pause'), undo: $('btn-undo'), redo: $('btn-redo'),
    tbody: document.querySelector('#segments-table tbody'), checkAll: $('check-all'),
    zoom: $('zoom-slider'), quality: $('export-quality'), sampleRate: $('export-samplerate'),
    channels: $('export-channels'), fade: $('export-fade'), export: $('btn-export'),
  };
  const state = {
    wave: null, regions: null, minimap: null, buffer: null, file: null, loadId: 0,
    ready: false, loading: false, selectedId: null, metadata: new Map(), rows: new Map(),
    history: [], historyIndex: -1, restoring: false, clipSequence: 0,
    loop: false, previewId: null, zoomFrame: 0, timelineFrame: 0, uiFrame: 0,
    worker: null, requestId: 0, exportJob: null, resultUrl: null, toastTimer: 0,
  };
  const formats = {
    wav: { label: '位深', description: '无损 PCM，适合后期制作与音频存档。', options: [['16', '16 bit · 标准'], ['24', '24 bit · 高精度'], ['32', '32 bit float · 浮点']], default: '16' },
    mp3: { label: '比特率', description: '体积更小，适合分享、试听与通用播放。', options: [['128', '128 kbps · 小巧'], ['192', '192 kbps · 均衡'], ['256', '256 kbps · 高品质'], ['320', '320 kbps · 最高品质']], default: '192' },
    ogg: { label: 'Vorbis 品质', description: 'Ogg Vorbis，适合游戏素材与循环音频。', options: [['3', 'Q3 · 标准（约 112 kbps）'], ['5', 'Q5 · 高品质（约 160 kbps）'], ['7', 'Q7 · 极高（约 224 kbps）'], ['10', 'Q10 · 最高（约 500 kbps）']], default: '5' },
  };
  const qualityValues = { wav: '16', mp3: '192', ogg: '5' };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const getRegions = () => state.regions ? [...state.regions.getRegions()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)) : [];
  const getRegion = (id) => state.regions?.getRegions().find((r) => r.id === id);
  const getFormat = () => document.querySelector('input[name="format"]:checked').value;
  const getMeta = (id) => state.metadata.get(id);

  function formatTime(seconds, precise = true) {
    const ms = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
    const minutes = Math.floor(ms / 60000);
    return `${String(minutes).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${precise ? `.${String(ms % 1000).padStart(3, '0')}` : ''}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function fileStem(name) { return name.replace(/\.[^.]+$/, '') || 'audio'; }

  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
  }

  function showError(message) {
    $('error-banner').textContent = message;
    $('error-banner').hidden = !message;
  }

  function resetResult() {
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
    $('export-result').replaceChildren();
    $('export-result').hidden = true;
  }

  function pickFile() {
    if (state.exportJob) return toast('请先完成或取消当前导出。');
    ui.upload.click();
  }

  function setLoading(loading) {
    state.loading = loading;
    $('dropzone').hidden = !loading && !!state.file;
    $('file-strip').hidden = loading || !state.file;
    $('drop-title').textContent = loading ? '正在读取这段声音…' : '把音频拖到这里';
    $('drop-description').textContent = loading ? '解码音频并绘制波形，请稍候。' : '支持 MP3、WAV、OGG、M4A、FLAC 等浏览器可解码的音频';
    $('loading-indicator').hidden = !loading;
    $('drop-import').hidden = loading;
    $('demo-audio').hidden = loading;
    updateControls();
  }

  // WAV's declared rate can be preserved during decode. Other formats use a clearly labelled 44.1 kHz project rate.
  function decodingRate(bytes) {
    const v = new DataView(bytes);
    if (v.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return 44100;
    for (let p = 12; p + 8 <= v.byteLength;) {
      const length = v.getUint32(p + 4, true);
      if (v.getUint32(p, false) === 0x666d7420 && length >= 16 && p + 24 <= v.byteLength) {
        const rate = v.getUint32(p + 12, true);
        return rate >= 8000 && rate <= 96000 ? rate : 44100;
      }
      p += 8 + length + (length % 2);
    }
    return 44100;
  }

  async function loadFile(file) {
    if (!file || state.exportJob) return;
    if (!file.size) return showError('这个文件是空的，请重新选择音频。');
    const id = ++state.loadId;
    setLoading(true);
    showError('');
    resetResult();
    state.previewId = null;
    state.wave?.pause();
    // Decode first; a failed replacement leaves the previous project intact.
    try {
      const bytes = await file.arrayBuffer();
      if (id !== state.loadId) return;
      const context = new OfflineAudioContext(1, 1, decodingRate(bytes));
      const buffer = await context.decodeAudioData(bytes);
      if (id !== state.loadId) return;
      if (!buffer.length || !Number.isFinite(buffer.duration)) throw new Error('音频中没有可读取的采样。');
      state.ready = false;
      if (state.zoomFrame) cancelAnimationFrame(state.zoomFrame);
      state.zoomFrame = 0;
      state.wave?.destroy();
      state.metadata.clear();
      state.rows.clear();
      ui.tbody.replaceChildren();
      state.selectedId = null;
      state.history = [];
      state.historyIndex = -1;
      state.clipSequence = 0;
      state.buffer = buffer;
      state.file = file;
      initWaveform();
      const wave = state.wave;
      // Feed decoded PCM to WaveSurfer, avoiding a second full decode. The media element plays the original file.
      await wave.loadBlob(file, Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c)), buffer.duration);
      if (id !== state.loadId) return;
      state.ready = true;
      selectRegion(null);
      $('wave-placeholder').hidden = true;
      $('overview').hidden = false;
      $('file-name').textContent = file.name;
      $('sidebar-filename').textContent = file.name;
      $('sidebar-filename').title = file.name;
      $('file-meta').textContent = `${formatBytes(file.size)}  ·  ${formatTime(buffer.duration, false)}  ·  项目 ${buffer.sampleRate / 1000} kHz  ·  ${buffer.numberOfChannels === 1 ? '单声道' : `${buffer.numberOfChannels} 声道`}`;
      $('sidebar-file-info').textContent = `${formatTime(buffer.duration, false)} · ${formatBytes(file.size)}`;
      $('total-time').textContent = formatTime(buffer.duration);
      $('duration-badge').textContent = formatTime(buffer.duration, false);
      ui.channels.options[0].textContent = buffer.numberOfChannels > 2 ? '自动 · 立体声混音' : `保留原声道 · ${buffer.numberOfChannels === 1 ? '单声道' : '立体声'}`;
      ui.sampleRate.options[0].textContent = `跟随项目 · ${buffer.sampleRate / 1000} kHz`;
      ui.zoom.value = '0';
      fitWaveform();
      commitHistory();
      renderClips();
      toast('音频已就绪。拖拽波形即可创建片段。');
    } catch (error) {
      if (id !== state.loadId) return;
      console.error('Audio import failed', error);
      if (!state.ready) {
        state.wave?.destroy();
        state.wave = state.regions = null;
        state.buffer = state.file = null;
        $('wave-placeholder').hidden = false;
        $('overview').hidden = true;
        $('total-time').textContent = '00:00.000';
        $('duration-badge').textContent = '等待导入';
        state.rows.clear();
        state.metadata.clear();
        ui.tbody.replaceChildren();
        renderClips();
      }
      showError('无法读取这份音频。请确认文件未损坏，或换用浏览器支持的 WAV、MP3、OGG、M4A 等格式。');
    } finally {
      if (id === state.loadId) setLoading(false);
    }
  }

  function initWaveform() {
    const colors = getComputedStyle(document.documentElement);
    const wave = state.wave = WaveSurfer.create({
      container: '#waveform', height: $('waveform').clientHeight,
      waveColor: colors.getPropertyValue('--wave').trim(), progressColor: colors.getPropertyValue('--wave-progress').trim(),
      cursorColor: colors.getPropertyValue('--accent').trim(), cursorWidth: 1.5,
      barWidth: 2, barGap: 1, barRadius: 2, normalize: false,
      minPxPerSec: 0, hideScrollbar: false, autoCenter: false, autoScroll: true,
    });
    wave.setVolume(Number($('volume-slider').value));
    const regions = state.regions = wave.registerPlugin(WaveSurfer.Regions.create());
    regions.enableDragSelection({ color: 'rgba(14,146,117,0.12)', minLength: Math.min(0.01, state.buffer.duration) });
    state.minimap = wave.registerPlugin(WaveSurfer.Minimap.create({
      container: '#minimap', height: 34, waveColor: colors.getPropertyValue('--wave').trim(),
      progressColor: colors.getPropertyValue('--wave-progress').trim(), overlayColor: 'rgba(14,146,117,0.12)',
      barWidth: 1, barGap: 1, interact: false,
    }));
    regions.on('region-created', (region) => {
      if (!state.metadata.has(region.id)) {
        state.clipSequence++;
        state.metadata.set(region.id, { name: `${fileStem(state.file.name)}_${String(state.clipSequence).padStart(2, '0')}`, checked: true });
      }
      region.setContent(getMeta(region.id).name);
      if (state.restoring) return;
      selectRegion(region.id);
      commitHistory();
      renderClips();
    });
    // v7 emits region-update while dragging and region-updated on release.
    regions.on('region-update', (region) => {
      if (state.previewId === region.id) stopPreview();
      if (state.selectedId !== region.id) selectRegion(region.id);
      updateRow(region);
      scheduleSummary();
    });
    regions.on('region-updated', () => {
      if (state.restoring) return;
      commitHistory();
      renderClips();
    });
    regions.on('region-clicked', (region, event) => { event.stopPropagation(); selectRegion(region.id); });
    regions.on('region-double-clicked', (region, event) => { event.stopPropagation(); playRegion(region.id); });
    wave.on('timeupdate', (time) => {
      $('current-time').textContent = formatTime(time);
      $('minimap-interact').setAttribute('aria-valuenow', String(Math.round(time / state.buffer.duration * 100)));
    });
    wave.on('play', syncPlayback);
    wave.on('pause', () => {
      syncPlayback();
      const region = getRegion(state.previewId);
      if (state.loop && region && wave.getCurrentTime() >= region.end - 0.035) {
        const id = region.id;
        requestAnimationFrame(() => { if (state.wave === wave && state.loop && state.previewId === id) playRegion(id); });
      }
    });
    wave.on('interaction', () => { state.previewId = null; });
    wave.on('scroll', scheduleTimeline);
    wave.on('zoom', scheduleTimeline);
    wave.on('resize', () => { if (Number(ui.zoom.value) === 0) fitWaveform(); scheduleTimeline(); });
    wave.on('error', (error) => { if (state.ready) showError(`播放失败：${error.message || '浏览器无法播放这个文件。'}`); });
  }

  function syncPlayback() {
    const playing = !!state.wave?.isPlaying();
    ui.play.classList.toggle('is-playing', playing);
    ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    ui.play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  }

  function stopPreview() {
    state.previewId = null;
    state.wave?.pause();
  }

  async function playRegion(id) {
    if (!state.ready || state.loading) return;
    const region = getRegion(id);
    if (!region) return;
    selectRegion(id);
    state.previewId = id;
    try { await state.wave.play(region.start, region.end); }
    catch (error) { state.previewId = null; toast(`无法播放：${error.message}`, true); }
  }

  async function togglePlayback() {
    if (!state.ready || state.loading) return;
    if (state.wave.isPlaying()) { stopPreview(); return; }
    if (state.loop && state.selectedId) { await playRegion(state.selectedId); return; }
    state.previewId = null;
    if (state.wave.getCurrentTime() >= state.buffer.duration - 0.001) state.wave.setTime(0);
    try { await state.wave.play(); }
    catch (error) { toast(`无法播放：${error.message}`, true); }
  }

  function selectRegion(id) {
    const old = getRegion(state.selectedId);
    state.selectedId = id;
    if (old && old.id !== id) old.setOptions({ color: 'rgba(14,146,117,0.08)' });
    const selected = getRegion(id);
    selected?.setOptions({ color: 'rgba(14,146,117,0.20)' });
    for (const [key, row] of state.rows) row.classList.toggle('selected-row', key === id);
    $('selection-hint').textContent = selected ? `已选片段 · ${(selected.end - selected.start).toFixed(3)} 秒` : state.ready ? '在波形空白处拖拽，创建新片段' : '导入音频后，即可框选片段';
  }

  function snapshot() {
    return JSON.stringify(getRegions().map((region) => ({ id: region.id, start: region.start, end: region.end, ...getMeta(region.id) })));
  }

  function commitHistory() {
    if (state.restoring || !state.ready) return;
    const current = snapshot();
    if (state.history[state.historyIndex] === current) return;
    state.history.splice(state.historyIndex + 1);
    state.history.push(current);
    if (state.history.length > 80) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateControls();
  }

  function restoreHistory(offset) {
    const target = state.historyIndex + offset;
    if (!state.ready || state.loading || target < 0 || target >= state.history.length) return;
    stopPreview();
    state.restoring = true;
    try {
      state.regions.clearRegions();
      state.metadata.clear();
      const entries = JSON.parse(state.history[target]);
      for (const item of entries) {
        state.metadata.set(item.id, { name: item.name, checked: item.checked });
        state.regions.addRegion({ id: item.id, start: item.start, end: item.end, minLength: Math.min(.01, state.buffer.duration), color: 'rgba(14,146,117,0.08)' });
      }
      state.historyIndex = target;
      selectRegion(entries.some((e) => e.id === state.selectedId) ? state.selectedId : entries.at(-1)?.id || null);
      renderClips();
    } finally { state.restoring = false; updateControls(); }
  }

  function makeRow(region) {
    const row = document.createElement('tr');
    row.dataset.id = region.id;
    // All names and filenames enter via .value/.textContent, never interpolated markup.
    row.innerHTML = '<td class="check-cell"><input type="checkbox" class="clip-check" aria-label="导出这个片段"></td><td><input type="text" class="input-name" aria-label="片段名称" maxlength="160" spellcheck="false"></td><td><input type="number" class="input-start" aria-label="开始时间（秒）" step="0.001" min="0"></td><td><input type="number" class="input-end" aria-label="结束时间（秒）" step="0.001" min="0"></td><td class="clip-duration"></td><td><div class="clip-actions"><button class="icon-button preview-clip" aria-label="试听这个片段" title="试听片段"><svg class="icon"><use href="#i-play"/></svg></button><button class="icon-button delete-clip" aria-label="删除这个片段" title="删除片段"><svg class="icon"><use href="#i-trash"/></svg></button></div></td>';
    row.addEventListener('click', (event) => { if (!event.target.closest('button')) selectRegion(row.dataset.id); });
    row.querySelector('.preview-clip').addEventListener('click', () => playRegion(row.dataset.id));
    row.querySelector('.delete-clip').addEventListener('click', () => deleteRegion(row.dataset.id));
    row.querySelector('.clip-check').addEventListener('change', (event) => {
      getMeta(row.dataset.id).checked = event.target.checked;
      commitHistory();
      updateSummary();
    });
    const name = row.querySelector('.input-name');
    name.addEventListener('input', () => {
      const id = row.dataset.id;
      getMeta(id).name = name.value;
      getRegion(id)?.setContent(name.value || '未命名片段');
    });
    name.addEventListener('change', commitHistory);
    name.addEventListener('blur', commitHistory);
    name.addEventListener('keydown', (event) => { if (event.key === 'Enter') name.blur(); });
    for (const edge of ['start', 'end']) {
      const input = row.querySelector(`.input-${edge}`);
      input.addEventListener('input', () => {
        const current = getRegion(row.dataset.id);
        const value = input.value === '' ? NaN : Number(input.value);
        if (!current || !Number.isFinite(value)) return;
        const valid = edge === 'start' ? value >= 0 && value < current.end : value > current.start && value <= state.buffer.duration;
        if (!valid) return; // Allow intermediate typing without snapping the cursor or accepting an inverted range.
        stopPreview();
        current.setOptions({ [edge]: value });
        updateRow(current);
        scheduleSummary();
      });
      input.addEventListener('change', () => {
        const current = getRegion(row.dataset.id);
        if (!current) return;
        let value = input.value.trim() === '' ? NaN : Number(input.value);
        if (!Number.isFinite(value)) { toast('请输入有效的时间（秒）。', true); updateRow(current, true); return; }
        const minimum = Math.min(.001, state.buffer.duration);
        value = edge === 'start' ? clamp(value, 0, current.end - minimum) : clamp(value, current.start + minimum, state.buffer.duration);
        stopPreview();
        current.setOptions({ [edge]: value });
        commitHistory();
        updateRow(current, true);
        renderClips();
      });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
      input.addEventListener('blur', commitHistory);
    }
    return row;
  }

  function updateRow(region, force = false) {
    const row = state.rows.get(region.id);
    if (!row) return;
    const meta = getMeta(region.id);
    for (const [selector, value] of [['.input-name', meta.name], ['.input-start', region.start.toFixed(3)], ['.input-end', region.end.toFixed(3)]]) {
      const input = row.querySelector(selector);
      if (force || document.activeElement !== input) input.value = value;
    }
    row.querySelector('.input-start').max = String(region.end);
    row.querySelector('.input-end').max = String(state.buffer.duration);
    row.querySelector('.clip-check').checked = meta.checked;
    row.querySelector('.clip-duration').textContent = `${(region.end - region.start).toFixed(3)}s`;
    row.classList.toggle('selected-row', region.id === state.selectedId);
    if (region.id === state.selectedId) $('selection-hint').textContent = `已选片段 · ${(region.end - region.start).toFixed(3)} 秒`;
  }

  function renderClips() {
    const regions = getRegions();
    const ids = new Set(regions.map((region) => region.id));
    for (const [id, row] of state.rows) {
      if (!ids.has(id)) { row.remove(); state.rows.delete(id); }
    }
    // Keyed DOM: typing/selection never rebuilds the table, and dragging only updates the affected row.
    regions.forEach((region, index) => {
      let row = state.rows.get(region.id);
      if (!row) { row = makeRow(region); state.rows.set(region.id, row); }
      updateRow(region);
      const occupant = ui.tbody.children[index];
      if (occupant !== row) ui.tbody.insertBefore(row, occupant || null);
    });
    $('clips-empty').hidden = regions.length > 0;
    $('clip-table-wrap').hidden = regions.length === 0;
    $('clip-count').textContent = String(regions.length);
    updateSummary();
    updateControls();
  }

  function addClip() {
    if (!state.ready || state.loading) return;
    const duration = state.buffer.duration;
    const start = Math.min(state.wave.getCurrentTime(), Math.max(0, duration - Math.min(5, duration)));
    state.regions.addRegion({ start, end: Math.min(duration, start + 5), minLength: Math.min(.01, duration), color: 'rgba(14,146,117,0.2)' });
  }

  function deleteRegion(id) {
    if (!state.ready || state.loading) return;
    const region = getRegion(id);
    if (!region) return;
    if (state.previewId === id) stopPreview();
    region.remove();
    state.metadata.delete(id);
    if (state.selectedId === id) selectRegion(null);
    commitHistory();
    renderClips();
  }

  function getExportClips() {
    const regions = getRegions();
    if (!state.buffer) return [];
    if (regions.length === 0) return [{ start: 0, end: state.buffer.duration, name: fileStem(state.file.name) }];
    return regions.filter((r) => getMeta(r.id)?.checked).map((r) => ({ start: r.start, end: r.end, name: getMeta(r.id).name }));
  }

  function updateSummary() {
    const regions = getRegions();
    const checked = regions.filter((r) => getMeta(r.id)?.checked);
    const clips = getExportClips();
    ui.checkAll.checked = regions.length > 0 && checked.length === regions.length;
    ui.checkAll.indeterminate = checked.length > 0 && checked.length < regions.length;
    $('clips-summary').textContent = `${regions.length} 个片段${regions.length ? ` · 已选择 ${checked.length} 个` : ''}`;
    const duration = clips.reduce((sum, c) => sum + c.end - c.start, 0);
    const format = getFormat();
    const rate = exportSampleRate();
    const channels = Number(ui.channels.value) || Math.min(2, state.buffer?.numberOfChannels || 2);
    const quality = Number(ui.quality.value);
    let bytes = format === 'wav' ? Math.round(duration * rate) * channels * (quality / 8) + 58 * clips.length : duration * (format === 'mp3' ? quality : ({3:112, 5:160, 7:224, 10:500}[quality] || 160)) * 1000 / 8;
    if (format === 'ogg' && channels === 1) bytes *= .65;
    $('export-scope').textContent = regions.length ? `${checked.length} 个已选片段` : '整段音频';
    $('export-duration').textContent = state.buffer ? formatTime(duration, false) : '—';
    $('export-size').textContent = state.buffer && clips.length ? `${format !== 'wav' ? '约 ' : ''}${formatBytes(bytes)}` : '—';
    $('export-button-label').textContent = state.exportJob ? '正在导出…' : clips.length > 1 ? `导出 ${clips.length} 个片段 · ZIP` : `导出 ${format.toUpperCase()} 音频`;
    $('export-footnote').textContent = clips.length > 1 ? '多个片段自动打包为一个 ZIP 文件。' : '音频在本地编码，无需等待上传。';
    ui.export.disabled = !state.ready || state.loading || !!state.exportJob || clips.length === 0;
  }

  function scheduleSummary() {
    if (state.uiFrame) return;
    state.uiFrame = requestAnimationFrame(() => { state.uiFrame = 0; updateSummary(); });
  }

  function exportSampleRate() {
    const requested = Number(ui.sampleRate.value) || state.buffer?.sampleRate || 44100;
    // All offered MP3 bitrates are MPEG-1 rates. Normalize unusual source rates consistently in UI and output.
    const rate = getFormat() === 'mp3' && ![32000, 44100, 48000].includes(requested) ? 44100 : requested;
    if (state.buffer) ui.sampleRate.options[0].textContent = getFormat() === 'mp3' && ![32000, 44100, 48000].includes(state.buffer.sampleRate) ? '自动 · 44.1 kHz（MP3）' : `跟随项目 · ${state.buffer.sampleRate / 1000} kHz`;
    return rate;
  }

  function updateControls() {
    const enabled = state.ready && !state.loading;
    for (const id of ['btn-play-pause', 'btn-rewind', 'btn-loop', 'btn-add-clip', 'btn-fit', 'btn-zoom-in', 'btn-zoom-out', 'zoom-slider']) $(id).disabled = !enabled;
    ui.undo.disabled = !enabled || state.historyIndex <= 0;
    ui.redo.disabled = !enabled || state.historyIndex >= state.history.length - 1;
    $('btn-clear-clips').disabled = !enabled || getRegions().length === 0;
    updateSummary();
  }

  function fitScale() { return state.buffer ? Math.max(.001, $('waveform').clientWidth / state.buffer.duration) : 1; }
  function zoomScale(value) { const fit = fitScale(); return fit * Math.pow(Math.max(1, 1600 / fit), value / 100); }

  function fitWaveform() {
    if (!state.ready || !state.wave) return;
    cancelAnimationFrame(state.zoomFrame);
    state.zoomFrame = 0;
    state.wave.zoom(fitScale());
    state.wave.setScroll(0);
    ui.zoom.value = '0';
    scheduleTimeline();
  }

  function setZoom(value, clientX = null) {
    if (!state.ready || state.loading) return;
    const wave = state.wave;
    const oldScale = Math.max(fitScale(), wave.options.minPxPerSec);
    const rect = $('waveform').getBoundingClientRect();
    const anchor = clientX === null ? rect.width / 2 : clamp(clientX - rect.left, 0, rect.width);
    const anchorTime = (wave.getScroll() + anchor) / oldScale;
    const scale = zoomScale(clamp(value, 0, 100));
    ui.zoom.value = String(clamp(value, 0, 100));
    cancelAnimationFrame(state.zoomFrame);
    state.zoomFrame = requestAnimationFrame(() => {
      state.zoomFrame = 0;
      if (state.wave !== wave) return;
      wave.zoom(scale);
      wave.setScroll(Math.max(0, anchorTime * scale - anchor));
      scheduleTimeline();
    });
  }

  function scheduleTimeline() {
    if (state.timelineFrame) return;
    state.timelineFrame = requestAnimationFrame(() => { state.timelineFrame = 0; renderTimeline(); });
  }

  function renderTimeline() {
    if (!state.ready || !state.wave) { $('timeline').replaceChildren(); return; }
    const scale = Math.max(fitScale(), state.wave.options.minPxPerSec);
    const scroll = state.wave.getScroll();
    const width = $('timeline').clientWidth;
    const intervals = [.01, .02, .05, .1, .2, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600];
    const step = intervals.find((seconds) => seconds * scale >= 70) || 3600;
    const start = Math.floor(scroll / scale / step) * step;
    const fragment = document.createDocumentFragment();
    for (let t = start, count = 0; t <= state.buffer.duration && t * scale - scroll <= width && count < 100; t += step, count++) {
      const tick = document.createElement('span');
      tick.style.left = `${Math.round(t * scale - scroll) + 3}px`;
      tick.textContent = step < 1 ? `${t.toFixed(step < .1 ? 2 : 1)}s` : formatTime(t, false);
      fragment.append(tick);
    }
    $('timeline').replaceChildren(fragment);
  }

  function setupOverview() {
    const layer = $('minimap-interact');
    let drag = null;
    layer.addEventListener('pointerdown', (event) => {
      if (!state.ready || state.loading || (event.pointerType === 'mouse' && event.button !== 0)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: state.wave.getScroll(), zoom: Number(ui.zoom.value), mode: null };
      layer.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    layer.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.mode) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        drag.mode = Math.abs(dx) >= Math.abs(dy) ? 'pan' : 'zoom';
      }
      if (drag.mode === 'zoom') setZoom(drag.zoom - dy / 2);
      else {
        const contentWidth = state.buffer.duration * Math.max(fitScale(), state.wave.options.minPxPerSec);
        state.wave.setScroll(Math.max(0, drag.scroll + dx / Math.max(1, layer.clientWidth) * contentWidth));
      }
    });
    layer.addEventListener('pointerup', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.mode) {
        const rect = layer.getBoundingClientRect();
        const time = clamp((event.clientX - rect.left) / rect.width, 0, 1) * state.buffer.duration;
        seekToTime(time);
        state.wave.setScrollTime(Math.max(0, time - state.wave.getWidth() / Math.max(fitScale(), state.wave.options.minPxPerSec) / 2));
      }
      drag = null;
    });
    layer.addEventListener('lostpointercapture', () => { drag = null; });
    layer.addEventListener('pointercancel', () => { drag = null; });
    layer.addEventListener('keydown', (event) => {
      if (!state.ready || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      seekToTime(state.wave.getCurrentTime() + (event.key === 'ArrowRight' ? 5 : -5));
    });
  }

  function createEncodingWorker() {
    if (state.worker) return state.worker;
    const embedded = $('audio-cutter-worker');
    if (embedded) {
      const source = embedded.dataset.encoding === 'json' ? JSON.parse(embedded.textContent) : embedded.textContent;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      state.worker = new Worker(url);
      URL.revokeObjectURL(url);
    } else state.worker = new Worker(new URL('encoder-worker.js', document.currentScript?.src || new URL('js/app.js', document.baseURI).href));
    return state.worker;
  }

  function seekToTime(time) {
    if (!state.ready || state.loading) return;
    const wave = state.wave;
    const target = clamp(time, 0, state.buffer.duration);
    state.previewId = null;
    if (wave.isPlaying()) wave.play(target).catch((error) => toast(`无法播放：${error.message}`, true));
    else wave.setTime(target);
  }

  function workerRequest(payload, transfer, onProgress, job) {
    if (job.cancelled) return Promise.reject(new DOMException('导出已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = createEncodingWorker(); } catch (error) { reject(new Error('无法启动音频编码。请通过 HTTP 服务器打开项目，或使用独立 HTML 版本。')); return; }
      const id = ++state.requestId;
      let timer;
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', receive); worker.removeEventListener('error', fail); if (job.reject === abort) job.reject = null; };
      const abort = () => { cleanup(); reject(new DOMException('导出已取消', 'AbortError')); };
      const fail = (event) => { cleanup(); worker.terminate(); if (state.worker === worker) state.worker = null; reject(new Error(event.message || '音频编码器无法启动。请使用 HTTP 服务器或独立版 HTML。')); };
      const watchdog = () => { clearTimeout(timer); timer = setTimeout(() => fail({ message: '编码器长时间没有响应，请重试或缩短导出片段。' }), 120000); };
      const receive = (event) => {
        if (event.data.id !== id) return;
        watchdog();
        if (event.data.type === 'progress') onProgress(event.data.progress);
        else if (event.data.type === 'done') { cleanup(); resolve(event.data); }
        else if (event.data.type === 'error') { cleanup(); reject(new Error(event.data.message)); }
      };
      job.reject = abort;
      worker.addEventListener('message', receive);
      worker.addEventListener('error', fail);
      watchdog();
      try { worker.postMessage({ ...payload, id }, transfer); } catch (error) { cleanup(); reject(error); }
    });
  }

  async function clipPcm(buffer, clip, sampleRate, channels, job) {
    const start = clamp(Math.round(clip.start * buffer.sampleRate), 0, buffer.length - 1);
    const end = clamp(Math.round(clip.end * buffer.sampleRate), start + 1, buffer.length);
    if (sampleRate === buffer.sampleRate && channels === buffer.numberOfChannels) {
      return Array.from({ length: channels }, (_, c) => buffer.getChannelData(c).slice(start, end));
    }
    // Offline rendering performs proper antialiased resampling and speaker downmix, independent of playback volume.
    const length = Math.max(1, Math.round((end - start) * sampleRate / buffer.sampleRate));
    const context = new OfflineAudioContext(channels, length, sampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0, start / buffer.sampleRate, (end - start) / buffer.sampleRate);
    const rendered = await context.startRendering();
    if (job.cancelled) throw new DOMException('导出已取消', 'AbortError');
    return Array.from({ length: channels }, (_, c) => rendered.getChannelData(c).slice());
  }

  function uniqueName(input, extension, used) {
    let stem = String(input || '未命名片段').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '').replace(/\.(wav|mp3|ogg|zip)$/i, '').slice(0, 100) || '未命名片段';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    let name = `${stem}.${extension}`, sequence = 2;
    while (used.has(name.toLocaleLowerCase())) name = `${stem}_${sequence++}.${extension}`;
    used.add(name.toLocaleLowerCase());
    return name;
  }

  function setExportBusy(busy) {
    $('export-progress').hidden = !busy;
    for (const element of document.querySelectorAll('#export-panel input, #export-panel select')) element.disabled = busy;
    updateControls();
  }

  function exportProgress(value, text) {
    const progress = clamp(value, 0, 1);
    $('export-status').textContent = text;
    $('export-percent').textContent = `${Math.floor(progress * 100)}%`;
    $('export-progress-bar').value = progress;
  }

  async function exportAudio() {
    if (!state.ready || state.loading || state.exportJob) return;
    const clips = getExportClips();
    if (!clips.length) return toast('请先勾选需要导出的片段。');
    const buffer = state.buffer;
    const format = getFormat(), quality = Number(ui.quality.value);
    const sampleRate = exportSampleRate();
    const channels = Number(ui.channels.value) || Math.min(2, buffer.numberOfChannels);
    const fadeMs = Number(ui.fade.value);
    const job = state.exportJob = { cancelled: false, reject: null };
    const used = new Set(), files = [];
    resetResult();
    showError('');
    exportProgress(0, '正在准备音频…');
    setExportBusy(true);
    await nextFrame();
    try {
      for (let index = 0; index < clips.length; index++) {
        if (job.cancelled) throw new DOMException('导出已取消', 'AbortError');
        const text = `编码 ${index + 1}/${clips.length} · ${format.toUpperCase()}`;
        exportProgress(index / clips.length * .94, text);
        const pcm = await clipPcm(buffer, clips[index], sampleRate, channels, job);
        const result = await workerRequest({ type: 'encode', format, quality, sampleRate, fadeMs, channels: pcm }, pcm.map((c) => c.buffer), (progress) => exportProgress((index + progress) / clips.length * .94, text), job);
        files.push({ name: uniqueName(clips[index].name, format, used), data: result.data });
        await nextFrame();
      }
      if (job.cancelled) throw new DOMException('导出已取消', 'AbortError');
      let blob, filename;
      if (files.length === 1) {
        blob = new Blob([files[0].data], { type: { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' }[format] });
        filename = files[0].name;
      } else {
        exportProgress(.96, '正在打包 ZIP…');
        const result = await workerRequest({ type: 'zip', files }, files.map((f) => f.data), () => {}, job);
        blob = new Blob([result.data], { type: 'application/zip' });
        filename = uniqueName(`${fileStem(state.file.name)}_片段_${format}`, 'zip', new Set());
      }
      if (job.cancelled) throw new DOMException('导出已取消', 'AbortError');
      exportProgress(1, '导出完成');
      state.resultUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = state.resultUrl;
      link.download = filename;
      link.textContent = `再次下载 ${filename}`;
      $('export-result').append(document.createTextNode(`上次导出 · ${clips.length} 份音频 · ${formatBytes(blob.size)}`), link);
      $('export-result').hidden = false;
      link.click();
      toast(files.length > 1 ? `${files.length} 个片段已打包为 ZIP。` : `${format.toUpperCase()} 音频已导出。`);
    } catch (error) {
      if (error.name === 'AbortError' || job.cancelled) toast('已取消导出。');
      else { console.error('Audio export failed', error); showError(`导出失败：${error.message || '请重试。'}`); }
    } finally {
      if (state.exportJob === job) { state.exportJob = null; setExportBusy(false); }
    }
  }

  function cancelExport() {
    const job = state.exportJob;
    if (!job) return;
    job.cancelled = true;
    job.reject?.();
    state.worker?.terminate();
    state.worker = null;
    exportProgress(0, '正在取消…');
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-label').textContent = theme === 'dark' ? '切换浅色模式' : '切换深色模式';
    $('theme-toggle').setAttribute('aria-label', $('theme-label').textContent);
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#212121' : '#ffffff';
    try { localStorage.setItem('audio-cutter-theme', theme); } catch (_) { /* Private browser storage is optional. */ }
    if (state.wave) {
      const colors = getComputedStyle(document.documentElement);
      state.wave.setOptions({ waveColor: colors.getPropertyValue('--wave').trim(), progressColor: colors.getPropertyValue('--wave-progress').trim(), cursorColor: colors.getPropertyValue('--accent').trim() });
    }
  }

  function applySidebar(collapsed) {
    const sidebar = $('app-sidebar');
    if (collapsed && sidebar.contains(document.activeElement)) $('sidebar-toggle').focus();
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    sidebar.inert = collapsed;
    sidebar.setAttribute('aria-hidden', String(collapsed));
    $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('sidebar-toggle').setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
    $('sidebar-toggle').title = `${collapsed ? '展开侧栏' : '收起侧栏'} · Ctrl/⌘ + \\`;
    try { localStorage.setItem('audio-cutter-sidebar', collapsed ? 'collapsed' : 'expanded'); } catch (_) { /* Optional preference. */ }
    scheduleTimeline();
  }

  function loadDemo() {
    if (state.exportJob) return;
    const rate = 44100, frames = rate * 8;
    const bytes = new ArrayBuffer(44 + frames * 4), v = new DataView(bytes);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) v.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); v.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, frames * 4, true);
    const notes = [261.63, 329.63, 392, 523.25, 440, 392, 329.63, 293.66];
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / rate, local = time % 1, frequency = notes[Math.floor(time)];
      const envelope = Math.min(1, local * 120) * Math.exp(-local * 4) * Math.min(1, (8 - time) * 10);
      const left = (Math.sin(time * frequency * 2 * Math.PI) + .2 * Math.sin(time * frequency * 4 * Math.PI)) * envelope * .48;
      const right = (Math.sin(time * frequency * 2 * Math.PI) + .15 * Math.sin(time * frequency * 6 * Math.PI)) * envelope * .45;
      v.setInt16(44 + frame * 4, Math.round(left * 32767), true);
      v.setInt16(46 + frame * 4, Math.round(right * 32767), true);
    }
    loadFile(new File([bytes], '示例_八个音符.wav', { type: 'audio/wav' }));
  }

  function setupEvents() {
    for (const id of ['sidebar-import', 'header-import', 'drop-import', 'replace-file']) $(id).addEventListener('click', pickFile);
    ui.upload.addEventListener('change', () => { const file = ui.upload.files[0]; ui.upload.value = ''; loadFile(file); });
    $('demo-audio').addEventListener('click', loadDemo);
    ui.play.addEventListener('click', togglePlayback);
    $('btn-rewind').addEventListener('click', () => { stopPreview(); state.wave?.setTime(0); });
    ui.undo.addEventListener('click', () => restoreHistory(-1));
    ui.redo.addEventListener('click', () => restoreHistory(1));
    $('btn-add-clip').addEventListener('click', addClip);
    $('btn-clear-clips').addEventListener('click', () => { stopPreview(); state.regions?.clearRegions(); state.metadata.clear(); selectRegion(null); commitHistory(); renderClips(); });
    ui.checkAll.addEventListener('change', () => { for (const meta of state.metadata.values()) meta.checked = ui.checkAll.checked; commitHistory(); renderClips(); });
    $('btn-loop').addEventListener('click', () => { state.loop = !state.loop; $('btn-loop').setAttribute('aria-pressed', String(state.loop)); if (!state.loop) state.previewId = null; toast(state.loop ? '循环试听已开启，点击片段播放键开始。' : '循环试听已关闭。'); });
    $('volume-slider').addEventListener('input', (event) => state.wave?.setVolume(Number(event.target.value)));
    ui.zoom.addEventListener('input', () => setZoom(Number(ui.zoom.value)));
    $('btn-zoom-in').addEventListener('click', () => setZoom(Number(ui.zoom.value) + 8));
    $('btn-zoom-out').addEventListener('click', () => setZoom(Number(ui.zoom.value) - 8));
    $('btn-fit').addEventListener('click', fitWaveform);
    $('wave-surface').addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!state.ready) return;
      event.preventDefault();
      setZoom(Number(ui.zoom.value) - clamp(event.deltaY, -80, 80) * .06, event.clientX);
    }, { passive: false });
    for (const radio of document.querySelectorAll('input[name="format"]')) radio.addEventListener('change', () => {
      const format = getFormat(), config = formats[format];
      $('quality-label').textContent = config.label;
      $('format-description').textContent = config.description;
      ui.quality.replaceChildren(...config.options.map(([value, label]) => new Option(label, value)));
      ui.quality.value = qualityValues[format];
      updateSummary();
    });
    ui.quality.addEventListener('change', () => { qualityValues[getFormat()] = ui.quality.value; updateSummary(); });
    for (const input of [ui.sampleRate, ui.channels, ui.fade]) input.addEventListener('change', updateSummary);
    ui.export.addEventListener('click', exportAudio);
    $('btn-cancel-export').addEventListener('click', cancelExport);
    $('theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
    $('sidebar-toggle').addEventListener('click', () => applySidebar(document.documentElement.dataset.sidebar !== 'collapsed'));
    for (const id of ['sidebar-help', 'help-button', 'shortcuts-button']) $(id).addEventListener('click', () => $('help-dialog').showModal());
    $('close-help').addEventListener('click', () => $('help-dialog').close());
    $('help-dialog').addEventListener('click', (event) => { if (event.target === $('help-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; $('drag-overlay').hidden = false; } });
    window.addEventListener('dragover', (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = state.exportJob ? 'none' : 'copy'; } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drag-overlay').hidden = true; });
    window.addEventListener('drop', (event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); dragDepth = 0; $('drag-overlay').hidden = true; if (state.exportJob) return toast('请先完成或取消当前导出。'); if (event.dataTransfer.files.length > 1) toast('一次编辑一份音频，已选择第一个文件。'); loadFile(event.dataTransfer.files[0]); });
    document.addEventListener('keydown', (event) => {
      if ($('help-dialog').open || event.isComposing || event.altKey) return;
      const editable = event.target.closest('input,textarea,select,[contenteditable="true"]');
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && key === '\\') { event.preventDefault(); applySidebar(document.documentElement.dataset.sidebar !== 'collapsed'); return; }
      if (command && key === 'o') { event.preventDefault(); pickFile(); return; }
      if (editable) return;
      if (command && key === 'z') { event.preventDefault(); restoreHistory(event.shiftKey ? 1 : -1); return; }
      if (command && key === 'y') { event.preventDefault(); restoreHistory(1); return; }
      if (command || !state.ready || state.loading) return;
      if (event.code === 'Space') {
        if (event.target.closest('button,a')) return;
        event.preventDefault(); if (!event.repeat) togglePlayback();
      }
      else if (['Delete', 'Backspace'].includes(event.key) && state.selectedId) { event.preventDefault(); deleteRegion(state.selectedId); }
      else if (key === 'a') { event.preventDefault(); addClip(); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(Number(ui.zoom.value) + 8); }
      else if (event.key === '-') { event.preventDefault(); setZoom(Number(ui.zoom.value) - 8); }
      else if (event.key === '0') fitWaveform();
      else if (['ArrowRight', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); seekToTime(state.wave.getCurrentTime() + (event.key === 'ArrowRight' ? 5 : -5)); }
    });
    let previousHeight = $('waveform').clientHeight;
    const observer = new ResizeObserver(() => {
      const height = $('waveform').clientHeight;
      if (height !== previousHeight && state.wave && state.ready) state.wave.setOptions({ height });
      previousHeight = height;
    });
    observer.observe($('waveform'));
    window.addEventListener('pagehide', () => { stopPreview(); cancelExport(); state.worker?.terminate(); state.worker = null; resetResult(); });
  }

  // A real, generated audio sample makes it possible to explore every feature before importing a file.
  const demo = document.createElement('button');
  demo.id = 'demo-audio'; demo.className = 'text-button demo-button'; demo.textContent = '试用示例';
  $('dropzone').insertBefore(demo, $('drop-import'));
  let savedTheme, savedSidebar;
  try { savedTheme = localStorage.getItem('audio-cutter-theme'); savedSidebar = localStorage.getItem('audio-cutter-sidebar'); } catch (_) { /* Optional preference. */ }
  applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
  applySidebar(savedSidebar === 'collapsed');
  setupEvents();
  setupOverview();
  updateControls();
})();
