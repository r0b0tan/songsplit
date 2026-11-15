/**
 * Fuehrt die Fehlerfall-Pruefungen des Browserpfads in Chromium aus.
 *
 *   node tests/separate/run-browser.mjs
 *   node tests/separate/run-browser.mjs --model htdemucs_6s-op17-fp32
 *
 * Gebuendelt werden zwei Einstiegspunkte: die Pruefungen selbst und der
 * Worker. Der Worker wird in der Anwendung ueber
 * `new Worker(new URL(...))` eingebunden, was der Angular-Bau aufloest;
 * esbuild tut das nicht, deshalb ist er hier ein eigener Bau und die
 * Pruefung bekommt seine Adresse als Parameter.
 *
 * Modell und Runtime kommen aus `public/` — dieselben Dateien, die auch
 * ausgeliefert werden. Ohne Export unter `public/models/` laeuft nichts;
 * das Skript sagt dann, was fehlt.
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');

const args = process.argv.slice(2);
const at = args.indexOf('--model');
const MODEL = at >= 0 ? args[at + 1] : 'htdemucs-op17-fp32';
// Mit `--song <datei>` kommt eine Pruefung dazu, die eine echte Datei
// dekodiert — in der Regel eine MP3, die der Browser nicht selbst schreiben
// kann. Der Testserver liefert sie unter /song aus.
const songAt = args.indexOf('--song');
const SONG = songAt >= 0 ? resolve(args[songAt + 1]) : null;

const PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Browserpfad-Pruefung</title></head>
<body><h1>Pruefung laeuft</h1><script type="module" src="check.js"></script></body></html>`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

async function main() {
  const modelDir = join(root, 'public', 'models', MODEL);
  try {
    await stat(join(modelDir, 'manifest.json'));
  } catch {
    console.error(
      `Kein Export unter public/models/${MODEL}. Erst erzeugen:\n` +
        '  cd backend && ../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs\n',
    );
    process.exit(2);
  }

  const out = await mkdtemp(join(tmpdir(), 'mixapart-browser-'));
  await esbuild.build({
    entryPoints: {
      check: join(here, 'browser-check.ts'),
      worker: join(root, 'src', 'app', 'separate', 'separate.worker.ts'),
      dsp: join(root, 'src', 'app', 'separate', 'dsp.worker.ts'),
    },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: out,
    logLevel: 'warning',
    define: { ngDevMode: 'false', ngJitMode: 'false' },
  });

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file;
    if (path === '/') file = join(out, 'index.html');
    else if (path.startsWith('/vendor/') || path.startsWith('/models/')) {
      file = join(root, 'public', path);
    } else if (path === '/song' && SONG) file = SONG;
    else file = join(out, path);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('nicht gefunden');
    }
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(out, 'index.html'), PAGE, 'utf8');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({
    args: [
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--js-flags=--max-old-space-size=4096',
    ],
  });

  let failed = 0;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('  [Browser]', m.text());
    });
    page.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction('typeof window.runSeparateChecks === "function"', null, {
      timeout: 30_000,
    });

    const checks = await page.evaluate(
      ([workerUrl, dspUrl, modelId, songUrl]) =>
        window.runSeparateChecks(workerUrl, dspUrl, modelId, songUrl ?? undefined),
      [`${base}worker.js`, `${base}dsp.js`, MODEL, SONG ? `${base}song` : null],
      // Der Worker rechnet auf WASM moeglicherweise minutenlang.
    );

    console.log(`\nBROWSERPFAD (Chromium, Modell ${MODEL})\n`);
    for (const c of checks) {
      if (!c.pass) failed++;
      console.log(`  [${c.pass ? 'OK  ' : 'FEHL'}] ${c.name}`);
      console.log(`         ${c.detail}`);
    }
    console.log(
      `\n  ${checks.length - failed} von ${checks.length} Pruefungen bestanden.\n`,
    );
  } catch (err) {
    console.error('Pruefung konnte nicht laufen:', err.message);
    failed = 2;
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
