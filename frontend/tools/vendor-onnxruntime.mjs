/**
 * Holt die ONNX-Runtime aus `node_modules` nach `public/vendor/onnxruntime/`.
 *
 *   node tools/vendor-onnxruntime.mjs
 *
 * Warum vendoriert und nicht gebuendelt — dieselben zwei Gruende wie bei
 * Signalsmith Stretch, siehe README:
 *
 * 1. Die Runtime laedt ihr WASM und ihre Worker selbst nach, anhand von
 *    Pfaden, die sie zur Laufzeit aus der eigenen Dateiadresse bildet. Ein
 *    Bundler, der die Datei umschreibt oder umbenennt, bricht diesen
 *    Selbstbezug.
 * 2. Die oeffentliche Variante soll nach dem ersten Laden ohne Netz
 *    arbeiten. Dafuer muessen Runtime und WASM gewoehnliche Dateien unter
 *    einer festen Adresse sein, die der Browser cachen kann — kein CDN und
 *    kein Chunk mit wechselndem Namen.
 *
 * Die Version steht in `package.json` exakt (ohne `^`). Dieses Skript
 * schreibt sie in `VERSION` daneben, damit sich im Zweifel feststellen
 * laesst, was ausgeliefert wurde.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const from = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const to = join(root, 'public', 'vendor', 'onnxruntime');

/**
 * Die Runtime, die ausgeliefert wird: WebGPU mit WASM als Rueckfallweg.
 *
 * Die anderen Varianten im Paket — `all`, `jspi`, `node` — braucht der
 * Browserpfad nicht; zusammen waeren sie ueber hundert Megabyte.
 */
const RUNTIME = 'ort.webgpu.bundle.min.mjs';

/**
 * Welche WASM-Dateien dazugehoeren, wird nicht geraten, sondern in der
 * Runtime nachgelesen.
 *
 * Das ist hier nicht Vorsicht um ihrer selbst willen: die Namen haben sich
 * zwischen den Fassungen schon geaendert (bis 1.30 `…jsep.wasm`, in 1.31
 * `…asyncify.wasm`), und eine falsch vendorierte Datei faellt nicht beim
 * Bauen auf, sondern erst beim ersten Trennversuch im Browser — mit
 * „no available backend found". Deshalb sucht dieses Skript die Namen in
 * der Runtime und bricht ab, wenn es keine findet.
 */
function referencedFiles(source) {
  const found = new Set();
  for (const match of source.matchAll(/ort-wasm[A-Za-z0-9._-]*\.(?:mjs|wasm)/g)) {
    found.add(match[0]);
  }
  return [...found].sort();
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.dependencies['onnxruntime-web'];
if (!version || /[\^~]/.test(version)) {
  console.error(
    `onnxruntime-web muss in package.json exakt stehen, gefunden: ${version}`,
  );
  process.exit(1);
}

const runtimeSource = await readFile(join(from, RUNTIME), 'utf8');
const wasmFiles = referencedFiles(runtimeSource);
if (!wasmFiles.length) {
  console.error(
    `In ${RUNTIME} steht kein Verweis auf eine WASM-Datei. Der Aufbau des ` +
      'Pakets hat sich geaendert — bitte nachsehen, welche Dateien die ' +
      'Runtime jetzt nachlaedt, statt eine Liste zu raten.',
  );
  process.exit(1);
}
console.log(`  ${RUNTIME} laedt nach: ${wasmFiles.join(', ')}`);

/**
 * Groesse, ab der eine Datei zerlegt wird.
 *
 * Das WASM der Runtime ist 28,7 MB, und Cloudflare Pages nimmt hoechstens
 * 25 MiB je Datei — damit waere der Bau dort nicht auszuliefern. Die
 * Stuecke werden im Browser wieder zusammengesetzt und der Laufzeit ueber
 * `env.wasm.wasmBinary` uebergeben; sie merkt davon nichts.
 */
const PART_BYTES = 20 * 1024 * 1024;

async function splitFile(path, name) {
  const data = await readFile(path);
  if (data.byteLength <= PART_BYTES) {
    return [{ name, bytes: data.byteLength, sha256: sha256sum(data) }];
  }
  const parts = [];
  for (let at = 0, index = 0; at < data.byteLength; at += PART_BYTES, index++) {
    const slice = data.subarray(at, Math.min(at + PART_BYTES, data.byteLength));
    const partName = `${name}.${String(index).padStart(3, '0')}`;
    await writeFile(join(to, partName), slice);
    parts.push({ name: partName, bytes: slice.byteLength, sha256: sha256sum(slice) });
  }
  await unlink(path);
  return parts;
}

function sha256sum(data) {
  return createHash('sha256').update(data).digest('hex');
}

await mkdir(to, { recursive: true });
const lines = [];
const manifest = { version, runtime: RUNTIME, wasm: null };
for (const name of [RUNTIME, ...wasmFiles]) {
  const src = join(from, name);
  try {
    await stat(src);
  } catch {
    console.error(`${name} fehlt in ${from} — erst \`npm install\` laufen lassen.`);
    process.exit(1);
  }
  await copyFile(src, join(to, name));
  const { size } = await stat(join(to, name));
  const hash = await sha256(join(to, name));
  lines.push(`${name}  ${(size / 1e6).toFixed(1)} MB  sha256:${hash}`);
  console.log(`  ${name}  ${(size / 1e6).toFixed(1)} MB`);

  if (name.endsWith('.wasm')) {
    const parts = await splitFile(join(to, name), name);
    manifest.wasm = { file: name, total_bytes: size, sha256: hash, parts };
    if (parts.length > 1) {
      console.log(`    zerlegt in ${parts.length} Stuecke zu hoechstens 20 MiB`);
      lines.push(`  zerlegt in ${parts.length} Stuecke`);
    }
  }
}

await writeFile(
  join(to, 'runtime.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8',
);

await writeFile(
  join(to, 'VERSION'),
  [
    `onnxruntime-web ${version}`,
    'MIT, Microsoft. Unveraendert aus dem npm-Paket kopiert von',
    'frontend/tools/vendor-onnxruntime.mjs.',
    '',
    ...lines,
    '',
  ].join('\n'),
  'utf8',
);
console.log(`\nonnxruntime-web ${version} liegt in public/vendor/onnxruntime/`);
