// Zero dependencies. Produces a static deployment folder and a completely offline single HTML.
import { readFile, writeFile, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
for (const directory of ['css', 'js', 'vendor', 'assets']) {
  await rm(path.join(output, directory), { recursive: true, force: true });
  await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
}
const source = await readFile(path.join(root, 'index.html'), 'utf8');
await writeFile(path.join(output, 'index.html'), source);
const safeScript = (source) => source.replace(/<\/script/gi, '<\\/script');
const stylesheet = await readFile(path.join(root, 'css/styles.css'), 'utf8');
let standalone = source.replace('<link rel="stylesheet" href="css/styles.css">', () => `<style>\n${stylesheet}\n</style>`);
for (const filename of ['wavesurfer.min.js', 'regions.min.js', 'minimap.min.js']) {
  const library = safeScript(await readFile(path.join(root, 'vendor', filename), 'utf8'));
  standalone = standalone.replace(`<script defer src="vendor/${filename}"></script>`, () => `<script>\n${library}\n</script>`);
}
const scripts = ['project-core.js', 'project-store.js', 'auto-split.js', 'app.js'];
for (const filename of scripts) standalone = standalone.replace(`<script defer src="js/${filename}"></script>`, '');
for (const filename of ['vvcat-logo.png', 'vvcat-companion.png']) {
  const asset = `assets/${filename}`;
  const data = `data:image/png;base64,${(await readFile(path.join(root, asset))).toString('base64')}`;
  standalone = standalone.replaceAll(asset, data);
}
const wasm = {};
for (const format of ['mp3', 'ogg']) wasm[format] = `data:application/wasm;base64,${(await readFile(path.join(root, 'vendor', `${format}.wasm`))).toString('base64')}`;
const worker = [
  `self.AUDIO_CUTTER_WASM = ${JSON.stringify(wasm)};`,
  await readFile(path.join(root, 'vendor/wasm-media-encoders.js'), 'utf8'),
  await readFile(path.join(root, 'vendor/fflate.js'), 'utf8'),
  await readFile(path.join(root, 'js/encoder-worker.js'), 'utf8'),
].join('\n');
// Escape '<' in inert JSON so HTML processors/live-reload injectors never interpret bundled JS as HTML.
const workerJson = JSON.stringify(worker).replace(/</g, '\\u003c');
const applicationParts = [];
for (const filename of scripts) applicationParts.push(await readFile(path.join(root, 'js', filename), 'utf8'));
const application = safeScript(applicationParts.join('\n'));
const licenses = {};
for (const filename of (await readdir(path.join(root, 'vendor/licenses'))).sort()) licenses[filename] = await readFile(path.join(root, 'vendor/licenses', filename), 'utf8');
const noticesJson = JSON.stringify({ notice: await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), licenses }).replace(/</g, '\\u003c');
standalone = standalone.replace('</body>', () => `<script type="application/json" id="third-party-notices">${noticesJson}</script>\n<script type="application/json" data-encoding="json" id="audio-cutter-worker">${workerJson}</script>\n<script>\n${application}\n</script>\n</body>`);
await writeFile(path.join(output, 'AudioCutter-standalone.html'), standalone);
console.log('Built dist/index.html and dist/AudioCutter-standalone.html (offline, no CDN).');
