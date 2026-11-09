/**
 * Faehrt die Messseite in Chromium und schreibt die Werte heraus.
 *
 *   node tests/webgpu/run.mjs                 # Clip, WebGPU wenn echt
 *   node tests/webgpu/run.mjs --wasm          # zum Vergleich auf WASM
 *   node tests/webgpu/run.mjs --song <datei>  # ganzer Song
 *   node tests/webgpu/run.mjs --cold          # Modell-Cache vorher leeren
 *
 * Wichtig und der ganze Punkt dieser Datei: **sie behauptet nie einen
 * GPU-Lauf.** Sie liest, was die Seite ueber den tatsaechlichen
 * Ausfuehrungsweg meldet (vier Belege, siehe `src/app/separate/runtime.ts`)
 * und schreibt es so hin. Chromium bringt mit `--enable-unsafe-swiftshader`
 * eine Software-Umsetzung von WebGPU mit, die alle Schnittstellen erfuellt
 * und auf der CPU rechnet; ein Messwert daraus waere als GPU-Wert eine
 * Luege. Dieses Skript setzt das Flag deshalb **nicht** und nennt einen
 * Software-Adapter beim Namen.
 *
 * Ohne echten Adapter laeuft der Vergleich trotzdem durch — dann auf WASM,
 * und so steht es in der Ausgabe. Das ist genau der Fall unter WSL2, wo
 * kein Vulkan-Treiber fuer die NVIDIA-Karte liegt.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist', 'songsplit', 'browser');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function main() {
  try {
    await stat(join(dist, 'index.html'));
  } catch {
    console.error(
      'Kein Produktionsbau gefunden. Erst bauen:\n  npx ng build\n' +
        `(erwartet ${dist})\n`,
    );
    process.exit(2);
  }

  // Ausgeliefert wird der fertige Bau. Gemessen werden soll, was auch
  // ankommt — ein unoptimierter Entwicklungsbau waere eine andere Zahl.
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path === '/' ? join(dist, 'index.html') : join(dist, path);
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({
    args: [
      // WebGPU anfordern. Kein `--enable-unsafe-swiftshader`: eine
      // Software-Umsetzung soll hier nicht als Grafikkarte durchgehen.
      '--enable-features=Vulkan',
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      // Das Modell ist 174 MB und liegt als ArrayBuffer im Worker, das
      // Ergebnis eines langen Songs noch einmal so viel.
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

    await page.goto(`${base}#bench`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="bench-clip"]', { timeout: 30_000 });

    const support = await page.evaluate(async () => {
      if (!navigator.gpu) return { available: false, reason: 'navigator.gpu fehlt' };
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { available: false, reason: 'kein Adapter' };
      const info = adapter.info ?? {};
      return {
        available: true,
        vendor: info.vendor ?? '',
        architecture: info.architecture ?? '',
        device: info.device ?? '',
        description: info.description ?? '',
      };
    });

    console.log('\nWEBGPU IM TESTBROWSER\n');
    if (!support.available) {
      console.log(`  WebGPU: nicht nutzbar — ${support.reason}`);
      console.log('  Der Lauf unten geht deshalb auf WASM. Das ist kein GPU-Wert.\n');
    } else {
      const label = [support.vendor, support.architecture, support.device, support.description]
        .filter(Boolean)
        .join(' · ');
      console.log(`  Adapter: ${label || '(ohne Angaben)'}`);
    }

    if (flag('--wasm')) {
      await page.locator('input[type=checkbox]').setChecked(false);
      console.log('  WebGPU abgewählt: dieser Lauf geht ausdrücklich auf WASM.');
    }
    if (flag('--cold')) {
      await page.getByText('Modell-Cache leeren', { exact: false }).click();
      await page.waitForTimeout(500);
      console.log('  Modell-Cache geleert: der Lauf unten ist ein kalter.');
    }

    const song = value('--song');
    if (song) {
      const file = resolve(song);
      await stat(file);
      await page.locator('input[type=file]').setInputFiles(file);
      await page.locator('[data-testid="bench-file"]').click();
    } else {
      await page.locator('[data-testid="bench-clip"]').click();
    }

    // Ein ganzer Song auf WASM, einfaedig, kann Minuten dauern.
    await page.waitForFunction(
      () => {
        const status = document.querySelector('[data-testid="bench-status"]');
        const text = status?.textContent ?? '';
        return text.includes('fertig') || text.includes('Fehler');
      },
      null,
      { timeout: 45 * 60_000 },
    );

    const status = await page.locator('[data-testid="bench-status"]').textContent();
    if (status?.includes('Fehler')) {
      console.error(`\n  ${status}\n`);
      failed = 1;
    } else {
      const table = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="bench-table"] tr')];
        return rows.map((r) =>
          [...r.querySelectorAll('th,td')].map((c) => c.textContent.trim()),
        );
      });
      const evidence = await page.evaluate(() =>
        [...document.querySelectorAll('ul.evidence li')].map((l) => l.textContent.trim()),
      );

      console.log('\nMESSWERTE\n');
      const [head, ...body] = table;
      for (const row of body) {
        for (let i = 0; i < head.length; i++) {
          console.log(`  ${head[i].padEnd(14)} ${row[i]}`);
        }
        console.log('');
      }
      console.log('NACHWEIS DES AUSFUEHRUNGSWEGS\n');
      for (const line of evidence) console.log(`  - ${line}`);

      const provider = body[body.length - 1]?.[1] ?? '';
      const check = body[body.length - 1]?.[12] ?? '';
      console.log('');
      if (provider === 'WebGPU') {
        console.log('  Dieser Lauf ist ein bestaetigter GPU-Lauf.');
      } else {
        console.log(`  Dieser Lauf ist KEIN GPU-Lauf: ${provider}.`);
      }
      if (check && check !== '—') {
        const ok = parseFloat(check) >= 40;
        console.log(
          `  Vergleich mit der numpy-Referenz: ${check} — ` +
            `${ok ? 'bestanden' : 'DURCHGEFALLEN'}`,
        );
        if (!ok) failed = 1;
      }
      console.log('');
    }
  } catch (err) {
    console.error('Messung konnte nicht laufen:', err.message);
    failed = 2;
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
