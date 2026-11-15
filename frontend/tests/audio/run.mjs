/**
 * Fuehrt die Engine-Pruefungen in Chromium aus.
 *
 *   node tests/audio/run.mjs
 *
 * Ablauf: engine-check.ts mit esbuild buenden, ueber einen kleinen lokalen
 * Server ausliefern (die Vendor-Datei muss unter vendor/ erreichbar sein),
 * in Chromium laden und `window.runEngineChecks()` aufrufen.
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');

const PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Engine-Pruefung</title></head>
<body><h1>Engine-Pruefung laeuft</h1><script src="engine-check.js"></script></body></html>`;

async function main() {
  const out = await mkdtemp(join(tmpdir(), 'mixapart-check-'));

  await esbuild.build({
    entryPoints: [join(here, 'engine-check.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    outfile: join(out, 'engine-check.js'),
    logLevel: 'warning',
    define: { ngDevMode: 'false', ngJitMode: 'false' },
  });
  await writeFile(join(out, 'index.html'), PAGE, 'utf8');

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
  };

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path === '/' ? join(out, 'index.html')
      : path.startsWith('/vendor/') ? join(root, 'public', path)
      : join(out, path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('nicht gefunden');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const launchBrowser = async () => {
    const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const p = await b.newPage();
    p.on('console', (m) => {
      if (m.type() === 'error') console.error('  [Browser]', m.text());
    });
    p.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));
    return { b, p };
  };
  let { b: browser, p: page } = await launchBrowser();

  const results = [];
  let failure = null;
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction('typeof window.runEngineCheck === "function"', null, {
      timeout: 15_000,
    });
    const count = await page.evaluate(() => window.engineCheckCount);

    // Jede Pruefung in einem frischen Seitenaufruf: ein OfflineAudioContext
    // laesst sich nicht schliessen, und der Browser erlaubt nur wenige
    // gleichzeitig. Ohne Neuladen liefern die spaeteren Pruefungen Stille.
    for (let i = 0; i < count; i++) {
      // Fuer jede Pruefung ein frischer Browser. Ein blosser Seitenwechsel
      // reicht nicht: ein OfflineAudioContext laesst sich nicht schliessen,
      // und aufgegebene Contexts der Vorseite bleiben dem Prozess noch eine
      // Weile erhalten. Gelegentlich blieb dadurch eine Pruefung stumm.
      await browser.close();
      ({ b: browser, p: page } = await launchBrowser());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForFunction('typeof window.runEngineCheck === "function"', null, {
        timeout: 15_000,
      });
      results.push(await page.evaluate((index) => window.runEngineCheck(index), i));
    }
  } catch (err) {
    failure = err;
  } finally {
    await browser.close();
    server.close();
  }

  if (failure) {
    console.error('Pruefung konnte nicht laufen:', failure.message);
    process.exit(2);
  }

  console.log('\nPLAYER-PRUEFUNG (OfflineAudioContext, Chromium)\n');
  let failed = 0;
  for (const r of results) {
    const mark = r.pass ? 'OK  ' : 'FEHL';
    if (!r.pass) failed++;
    console.log(`  [${mark}] ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  console.log(`\n  ${results.length - failed} von ${results.length} Pruefungen bestanden.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
