import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));

test('standalone embeds intact worker, WASM and application without external runtime assets', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
  const html = readFileSync(path.join(root, 'dist/AudioCutter-standalone.html'), 'utf8');
  const matched = html.match(/<script type="application\/json" data-encoding="json" id="audio-cutter-worker">([\s\S]*?)<\/script>/);
  assert.ok(matched, 'worker is stored as inert JSON');
  assert.ok(!matched[1].includes('<'), 'embedded code cannot be mistaken for HTML tags by static hosts');
  const worker = JSON.parse(matched[1]);
  assert.ok(worker.endsWith(readFileSync(path.join(root, 'js/encoder-worker.js'), 'utf8')));
  new vm.Script(worker);
  const wasm = JSON.parse(worker.split('\n')[0].replace('self.AUDIO_CUTTER_WASM = ', '').replace(/;$/, ''));
  for (const format of ['mp3', 'ogg']) {
    const bytes = Buffer.from(wasm[format].split(',')[1], 'base64');
    assert.ok(WebAssembly.validate(bytes));
    assert.deepEqual(bytes, readFileSync(path.join(root, `vendor/${format}.wasm`)));
  }
  assert.ok(!/<script[^>]*\bsrc=/.test(html));
  assert.ok(!/<link[^>]*\brel="stylesheet"/.test(html));
  assert.ok(!/src="assets\//.test(html), 'both cat assets are embedded for offline use');
  const catSprites = html.match(/data-sprite="data:image\/webp;base64,([^"]+)"/);
  assert.ok(catSprites, 'the cat sprites are embedded for offline use');
  assert.deepEqual(Buffer.from(catSprites[1], 'base64'), readFileSync(path.join(root, 'assets/vvcat-motions.webp')));
  assert.ok(!html.includes('count.getloli.com'), 'the offline build never requests the site visitor counter');
  assert.ok(html.includes('property="og:image" content="https://onlineaudiocutter.pages.dev/assets/vvcat-logo.png"'));
  assert.ok(html.includes('AudioCutterAutoSplit'));
  assert.ok(html.includes('AudioCutterProjectCore') && html.includes('AudioCutterProjectStore'));
  const application = readFileSync(path.join(root, 'js/app.js'), 'utf8');
  assert.ok(html.includes(application));
  for (const filename of ['robots.txt', 'sitemap.xml', 'indexnow-key.txt']) {
    assert.equal(readFileSync(path.join(root, 'dist', filename), 'utf8'), readFileSync(path.join(root, filename), 'utf8'));
  }
});
