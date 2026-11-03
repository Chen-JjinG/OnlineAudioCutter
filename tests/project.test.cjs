const { test } = require('node:test');
const assert = require('node:assert/strict');
const { batchNames, validClips } = require('../js/project-core.js');
const ProjectStore = require('../js/project-store.js');

test('batch names are zero-padded, ordered, and leave input clips untouched', () => {
  const clips = [{ id: 'b', name: '保留原名' }, { id: 'a', name: '另一个原名' }, { id: 'c' }];
  assert.deepEqual(batchNames(clips, { prefix: '', start: 1, digits: 3 }), [{ id: 'b', name: '001' }, { id: 'a', name: '002' }, { id: 'c', name: '003' }]);
  assert.equal(clips[0].name, '保留原名');
  assert.deepEqual(batchNames(clips.slice(0, 2), { prefix: '刀剑/挥砍', start: 9, digits: 3, separator: '-' }).map(c => c.name), ['刀剑_挥砍-009', '刀剑_挥砍-010']);
});

test('numbering never wraps or truncates and rejects invalid numeric input', () => {
  const clips = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(batchNames(clips, { prefix: '音效', start: 999, digits: 3, separator: '_' }).map(c => c.name), ['音效_999', '音效_1000', '音效_1001']);
  assert.equal(batchNames(clips.slice(0, 1), { prefix: '', start: 0, digits: 3 })[0].name, '000');
  for (const start of ['', -1, 1.2, Infinity, 1000000]) assert.throws(() => batchNames(clips, { start }), /编号/);
  assert.throws(() => batchNames(clips, { digits: 7 }), /位数/);
  assert.ok(batchNames(clips, { prefix: 'a'.repeat(120), start: 1, digits: 3 })[0].name.endsWith('_001'));
  assert.ok(batchNames(clips, { prefix: 'a'.repeat(120), start: 1, digits: 3 })[0].name.length < 100);
});

test('project restoration rejects corrupt ranges/duplicate IDs while preserving names and selection', () => {
  const restored = validClips([{ id: 'one', start: 1, end: 3, name: '刀剑_001', checked: false }, { id: 'one', start: 4, end: 5 }, { id: 'bad', start: -1, end: 1 }, { id: 'nan', start: NaN, end: 2 }, { id: 'past-end', start: 6, end: 20 }, null], 8);
  assert.deepEqual(restored, [{ id: 'one', start: 1, end: 3, name: '刀剑_001', checked: false }]);
});

test('project store fallback keeps projects, audio, and edits isolated across switches', async () => {
  const store = await new ProjectStore().open();
  const first = { id: 'first', name: '刀剑音效', audio: new Blob(['audio-a']), clips: [{ id: 'clip-a', name: '挥砍_001', start: 1, end: 3 }], settings: { format: 'ogg', quality: '5' }, updatedAt: 1 };
  const second = { id: 'second', name: '对白剪辑', audio: null, clips: [], settings: { format: 'wav' }, updatedAt: 2 };
  await store.put(first); await store.put(second);
  first.clips[0].name = '外部修改不应污染存储';
  const restored = await store.get('first');
  assert.equal(restored.clips[0].name, '挥砍_001');
  assert.equal(await restored.audio.text(), 'audio-a');
  assert.equal(restored.settings.format, 'ogg');
  assert.equal((await store.get('second')).audio, null);
  assert.deepEqual((await store.list()).map(p => p.id), ['second', 'first']);
  restored.name = '读取结果也应独立';
  assert.equal((await store.get('first')).name, '刀剑音效');
});

test('deleting one project removes its audio and clips while preserving other projects', async () => {
  const store = await new ProjectStore().open();
  const keep = { id: 'keep', name: '保留的项目', audio: new Blob(['keep-audio']), clips: [{ name: '001' }], updatedAt: 1 };
  await store.put(keep);
  await store.put({ id: 'remove', audio: new Blob(['remove-audio']), clips: [{ name: '002' }], updatedAt: 2 });
  await store.remove('remove');
  assert.equal(await store.get('remove'), null);
  assert.deepEqual((await store.list()).map(project => project.id), ['keep']);
  const restored = await store.get('keep');
  assert.equal(await restored.audio.text(), 'keep-audio');
  assert.deepEqual(restored.clips, keep.clips);
  await store.remove('already-missing');
  assert.equal((await store.list()).length, 1);
});

test('deleting the last project can replace it without retaining deleted data', async () => {
  const store = await new ProjectStore().open();
  await store.put({ id: 'old', audio: new Blob(['old-audio']), clips: [{ name: 'old-clip' }], updatedAt: 1 });
  const blank = { id: 'new', name: '未命名项目', audio: null, clips: [], updatedAt: 2 };
  await store.remove('old', blank);
  blank.name = '外部修改';
  assert.equal(await store.get('old'), null);
  assert.deepEqual(await store.list(), [{ id: 'new', name: '未命名项目', audio: null, clips: [], updatedAt: 2 }]);
});

test('invalid replacement cannot destroy either the target or an existing project', async () => {
  const store = await new ProjectStore().open();
  await store.put({ id: 'old', name: '旧项目', updatedAt: 1 });
  await store.put({ id: 'existing', name: '保留项目', updatedAt: 2 });
  await assert.rejects(store.remove('old', { id: 'old' }), /新的 ID/);
  await assert.rejects(store.remove('old', { id: 'existing' }), /已存在/);
  assert.equal((await store.get('old')).name, '旧项目');
  assert.equal((await store.get('existing')).name, '保留项目');
});
