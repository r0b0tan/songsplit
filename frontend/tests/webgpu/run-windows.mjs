/**
 * Misst den Browserweg im **Chrome von Windows** — dort liegt die Grafikkarte.
 *
 *   node tests/webgpu/run-windows.mjs
 *   node tests/webgpu/run-windows.mjs --song ../testmusik/x.mp3
 *   node tests/webgpu/run-windows.mjs --wasm        # Gegenprobe dazu
 *   node tests/webgpu/run-windows.mjs --model htdemucs_6s-op17-fp32
 *
 * Warum ein eigener Pruefstand: unter WSL2 gibt es keinen Vulkan-Treiber
 * fuer die NVIDIA-Karte, und das Chromium von Playwright bekommt deshalb
 * nur SwiftShader — eine Software-Umsetzung, aus der kein GPU-Wert werden
 * kann. Das Chrome von Windows sieht die Karte (gemessen: `nvidia`,
 * `lovelace`), laesst sich aber von hier aus nicht ueber CDP fernsteuern.
 *
 * Also umgekehrt: dieses Skript liefert die Messung aus und **wartet auf
 * den Rueckruf**. Die Seite rechnet und schickt ihr Ergebnis per `fetch` an
 * `/result`. Erreichbar ist der Server, weil WSL2 die Ports an den
 * Windows-Host spiegelt — gebunden wird nur auf 127.0.0.1.
 *
 * `http://localhost:<port>` ist fuer den Browser ein sicherer Kontext, und
 * nur in einem solchen gibt es `navigator.gpu`. Mit der WSL-IP statt
 * `localhost` waere WebGPU gar nicht vorhanden.
 *
 * Es laeuft im neuen Headless-Modus, mit einem eigenen Profil unter
 * `C:\\Users\\Public\\songsplit-messung` — das Profil des Benutzers wird
 * nicht angefasst, und es erscheint kein Fenster.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');

const CHROME = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const POWERSHELL =
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/**
 * Ein eigenes Profil **je Lauf**, und ein Windows-Pfad dazu.
 *
 * Beides ist Erfahrung und nicht Vorsicht. Ein Linux-Pfad (`/tmp/...`)
 * laesst chrome.exe mit „Failed To Create Data Directory" stehen — als
 * Fenster auf dem Bildschirm, mitten im angeblich kopflosen Lauf. Und ein
 * *fester* Profilpfad ist noch unangenehmer: laeuft noch eine Instanz mit
 * demselben Profil, reicht der neue Aufruf ihr nur die Adresse und endet
 * sofort. Der Pruefstand wartet dann auf einen Rueckruf, den niemand mehr
 * schickt — hier siebzehn Minuten lang, ohne eine einzige Zeile Ausgabe.
 */
const PROFILE = `C:\\Users\\Public\\songsplit-messung-${process.pid}-${Date.now()}`;

/**
 * Beendet die Browser **dieses** Laufs und raeumt sein Profil weg.
 *
 * Gefiltert wird ueber den Profilpfad in der Befehlszeile. Ein schlichtes
 * `taskkill /IM chrome.exe` wuerde auch das Fenster erschlagen, in dem der
 * Benutzer gerade etwas offen hat; das ist kein Preis fuer eine Messung.
 * `chrome.kill()` allein genuegt nicht: der Browser loest sich vom
 * gestarteten Prozess und lebt weiter.
 */
async function cleanupChrome() {
  await new Promise((done) => {
    const ps = spawn(
      POWERSHELL,
      [
        '-NoProfile',
        '-Command',
        // In einfachen Anfuehrungszeichen nimmt PowerShell den Backslash
        // woertlich — verdoppelt traefe das Muster nie.
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |` +
          ` Where-Object { $_.CommandLine -like '*${PROFILE}*' } |` +
          ' ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };' +
          ` Start-Sleep -Milliseconds 400;` +
          ` Remove-Item -LiteralPath '${PROFILE}' -Recurse -Force -ErrorAction SilentlyContinue`,
      ],
      { stdio: 'ignore' },
    );
    ps.on('exit', done);
    ps.on('error', done);
  });
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const MODEL = value('--model') ?? 'htdemucs-op17-fp32';
const SONG = value('--song') ? resolve(value('--song')) : null;

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

const PAGE = (config) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>songsplit — Messung</title></head>
<body><pre id="log">startet …</pre>
<script type="module">
import { measure } from './measure.js';
const log = document.getElementById('log');
const say = (t) => { log.textContent = t; void fetch('/status?t=' + encodeURIComponent(t)); };
try {
  const report = await measure({ ...${JSON.stringify(config)}, onStatus: say });
  await fetch('/result', { method: 'POST', body: JSON.stringify(report) });
  log.textContent = 'fertig';
} catch (err) {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(err && err.message || err), runs: [] }) });
}
</script></body></html>`;

function ms(value) {
  if (!value || value < 1) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

async function main() {
  try {
    await stat(CHROME);
  } catch {
    console.error(
      `Kein Chrome unter ${CHROME}.\n` +
        'Dieser Pruefstand braucht das Chrome von Windows — nur dort liegt die\n' +
        'Grafikkarte. Fuer einen Lauf ohne GPU: node tests/webgpu/run.mjs\n',
    );
    process.exit(2);
  }
  try {
    await stat(join(root, 'public', 'models', MODEL, 'manifest.json'));
  } catch {
    console.error(`Kein Export unter public/models/${MODEL}.\n`);
    process.exit(2);
  }

  const out = await mkdtemp(join(tmpdir(), 'songsplit-win-'));
  await esbuild.build({
    entryPoints: {
      measure: join(here, 'measure.ts'),
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

  let settle;
  const result = new Promise((r) => (settle = r));
  let lastStatus = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    if (req.method === 'POST' && path === '/result') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(204).end();
      settle(JSON.parse(body));
      return;
    }
    if (path === '/status') {
      const text = url.searchParams.get('t') ?? '';
      if (text !== lastStatus) {
        lastStatus = text;
        process.stderr.write(`  … ${text}\n`);
      }
      res.writeHead(204).end();
      return;
    }

    let file;
    if (path === '/') file = null;
    else if (path.startsWith('/vendor/') || path.startsWith('/models/')) {
      file = join(root, 'public', path);
    } else if (path.startsWith('/reference/')) {
      file = join(root, 'tests', 'separate', 'fixtures', path.slice('/reference/'.length));
    } else if (path === '/song' && SONG) file = SONG;
    else file = join(out, path);

    if (file === null) {
      const body = PAGE({
        workerUrl: './worker.js',
        dspWorkerUrl: './dsp.js',
        modelId: MODEL,
        songUrl: SONG ? './song' : null,
        alsoWasm: flag('--wasm'),
      });
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(body);
      return;
    }
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

  // Nur Loopback. Windows erreicht das ueber die Portspiegelung von WSL2.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://localhost:${port}/`;
  console.log(`\nMESSUNG IM CHROME VON WINDOWS\n\n  Ausgeliefert unter ${base}`);
  console.log(`  Modell ${MODEL}${SONG ? `, Datei ${SONG}` : ''}\n`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--enable-unsafe-webgpu',
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      base,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr.on('data', (d) => {
    const text = String(d);
    // Chrome schreibt beim Start Zeilen ueber fehlende Registry-Pfade von
    // Erweiterungen. Die gehoeren nicht zur Messung.
    if (/external_registry_loader|Missing value path/.test(text)) return;
    process.stderr.write(`  [chrome] ${text}`);
  });

  // Stirbt der Browser, bevor er etwas gemeldet hat, soll das sofort
  // auffallen und nicht in eine Zeitueberschreitung laufen.
  const exited = new Promise((r) =>
    chrome.on('exit', (code) => setTimeout(() => r({ exitedWith: code }), 20_000)),
  );
  const report = await Promise.race([
    result,
    exited,
    new Promise((r) => setTimeout(() => r(null), 60 * 60_000)),
  ]);
  chrome.kill();
  await cleanupChrome();
  server.close();

  if (!report || report.exitedWith !== undefined) {
    console.error(
      '\n  Keine Antwort aus dem Browser.' +
        (report?.exitedWith !== undefined
          ? ` chrome.exe endete mit ${report.exitedWith}, ohne zu melden.`
          : '') +
        '\n  Zuletzt gesehen: ' +
        (lastStatus || '(nichts)') +
        '\n',
    );
    process.exit(2);
  }

  console.log('GERAET\n');
  if (report.adapter) {
    const a = report.adapter;
    const label = [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' · ');
    console.log(`  Adapter             ${label || '(ohne Angaben)'}`);
    console.log(`  Software-Umsetzung  ${a.software ? 'JA — das ist kein GPU-Lauf' : 'nein'}`);
  } else {
    console.log(`  Adapter             keiner — ${report.adapterReason ?? ''}`);
  }
  console.log(`  Browser             ${(report.userAgent ?? '').replace(/^Mozilla\/\S+ /, '')}`);

  if (report.failure) {
    console.error(`\n  Fehler: ${report.failure}\n`);
    process.exit(1);
  }

  let failed = 0;
  for (const run of report.runs) {
    console.log(`\n${run.label.toUpperCase()}\n`);
    const rows = [
      ['Weg', run.provider],
      ['Audio', `${run.audioSeconds.toFixed(1)} s in ${run.blocks} Blöcken`],
      ['Datei dekodieren', ms(run.decodeMs)],
      ['Modell', `${ms(run.modelMs)}${run.modelFromCache ? ' (Cache)' : ''}`],
      ['Sitzung anlegen', ms(run.sessionMs)],
      ['Blockumlauf gesamt', ms(run.inferenceMs)],
      ['davon untätig gewartet', ms(run.gpuWaitMs)],
      ['DSP hin', ms(run.forwardDspMs)],
      ['DSP zurück', ms(run.inverseDspMs)],
      ['Trennung', ms(run.separationMs)],
      ['bis spielbar', ms(run.firstPlayableMs)],
      ['× Echtzeit', `${run.realtime.toFixed(1)}×`],
    ];
    if (run.referenceDb !== null) {
      rows.push([
        'Prüfung',
        `${run.referenceDb.toFixed(0)} dB unter Mix (${run.referenceDetail})`,
      ]);
    }
    for (const [k, v] of rows) console.log(`  ${k.padEnd(18)} ${v}`);

    if (run.label !== 'Clip auf WASM' && !run.gpuConfirmed) {
      console.log('\n  ACHTUNG: kein bestaetigter GPU-Lauf.');
      failed++;
    }
    if (run.referenceDb !== null && run.referenceDb < 40) {
      console.log('\n  ACHTUNG: Vergleich mit der Referenz durchgefallen.');
      failed++;
    }
  }

  const last = report.runs[report.runs.length - 1];
  console.log('\nNACHWEIS DES AUSFUEHRUNGSWEGS\n');
  for (const line of last?.evidence ?? []) console.log(`  - ${line}`);
  console.log('');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
