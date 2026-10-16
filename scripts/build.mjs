import { build } from 'esbuild';
import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL('../dist/', import.meta.url);
await mkdir(out, { recursive: true });
await rm(new URL('chunks/', out), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { app: 'src/app.js', background: 'src/background.js' },
  bundle: true, format: 'esm', outdir: fileURLToPath(out), target: 'chrome110',
  splitting: true, chunkNames: 'chunks/[name]-[hash]',
  minify: true, legalComments: 'eof', sourcemap: false,
});
// 内容脚本是经典脚本（不支持 ESM 代码分割），打成自包含的单文件
await build({
  absWorkingDir: root,
  entryPoints: { 'file-reader': 'src/file-reader.js' },
  bundle: true, format: 'iife', outfile: fileURLToPath(new URL('file-reader.js', out)), target: 'chrome110',
  minify: true, legalComments: 'eof', sourcemap: false,
});
await Promise.all(['index.html', 'styles.css', 'file-reader.css'].map(name => copyFile(new URL(`../src/${name}`, import.meta.url), new URL(name, out))));
await copyFile(new URL('../manifest.json', import.meta.url), new URL('manifest.json', out));
await mkdir(new URL('icons/', out), { recursive: true });

// A tiny native PNG encoder keeps the release build self-contained.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function createIcon(size) {
  const scale = 4, large = size * scale;
  const pixels = new Uint8Array(large * large * 4);
  for (let y = 0; y < large; y++) for (let x = 0; x < large; x++) {
    const a = x / large, b = y / large;
    const edgeX = Math.max(.2 - a, 0, a - .8), edgeY = Math.max(.2 - b, 0, b - .8);
    const rounded = Math.hypot(edgeX, edgeY) < .19;
    const left = a > .22 && a < .47 && b > .29 + (a - .22) * .15 && b < .72 + (a - .22) * .15;
    const right = a > .53 && a < .78 && b > .33 - (a - .53) * .15 && b < .76 - (a - .53) * .15;
    const line = (a > .28 && a < .42 && (Math.abs(b - .43) < .011 || Math.abs(b - .53) < .011)) || (a > .59 && a < .72 && (Math.abs(b - .43) < .011 || Math.abs(b - .53) < .011));
    const rgb = (left || right) && !line ? [245, 247, 236] : [82, 107, 69];
    const index = (y * large + x) * 4;
    pixels.set([...rgb, rounded ? 255 : 0], index);
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) {
    let total = 0;
    for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) total += pixels[(((y * scale + yy) * large) + x * scale + xx) * 4 + c];
    raw[y * (size * 4 + 1) + 1 + x * 4 + c] = Math.round(total / (scale * scale));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
await Promise.all([16, 32, 48, 128].map(size => writeFile(new URL(`icons/icon${size}.png`, out), createIcon(size))));
await mkdir(new URL('licenses/', out), { recursive: true });
for (const name of ['marked', 'dompurify', 'highlight.js', 'mermaid']) {
  const files = { marked: 'LICENSE.md', dompurify: 'LICENSE', 'highlight.js': 'LICENSE', mermaid: 'LICENSE' };
  await copyFile(new URL(`../node_modules/${name}/${files[name]}`, import.meta.url), new URL(`licenses/${name}.txt`, out));
}
const manifest = JSON.parse(await readFile(new URL('manifest.json', out), 'utf8'));
console.log(`墨读 v${manifest.version} 已构建：${fileURLToPath(out)}`);
