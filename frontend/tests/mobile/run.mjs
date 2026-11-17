/**
 * Was die Seite auf einem Handy sagt — im Testbrowser, ohne Handy.
 *
 *   npm run build:public
 *   npm run test:mobile
 *
 * Geprueft wird die Auskunft, nicht das Rechnen. Auf einem Android-Telefon
 * gibt der Browser die Grafikeinheit meist nicht frei; was dann dasteht,
 * entscheidet, ob jemand bleibt oder geht. Genau diese Texte und die
 * Vorauswahl des Trennorts haengen an `isMobileDevice()` und an
 * `cloud.json`, und beide lassen sich hier stellen.
 *
 * **Der Hauptfall ist der mit Serverweg.** Lokal ist `cloud.json` leer,
 * also geht das Geraetefenster auf und die Handy-Texte erscheinen. Auf dem
 * ausgelieferten Stand traegt die Datei Adresse und Token — dort geht das
 * Fenster nie auf, und der Serverweg steht vorgewaehlt da. Ein Test, der
 * nur die leere Datei kennt, prueft also die Konfiguration, die kein
 * Besucher zu sehen bekommt. Deshalb stellt dieser Lauf beide.
 *
 * **Der Grafikzustand wird gestellt, nicht abgewartet.** Von sich aus hat
 * dieser Browser WebGPU, und `requestAdapter()` liefert unter WSL2
 * trotzdem `null` — das ist GPU-03 und zufaellig genau der haeufigste
 * Zustand auf einem Handy. Darauf ist kein Verlass: auf einem Rechner mit
 * freigegebener Grafikkarte kaeme ein Adapter zurueck, und dann gaebe es
 * nichts zu melden und der Test liefe ins Leere, ohne es zu sagen. Also
 * legt der Testserver dem ausgelieferten Worker eine Attrappe vor, die
 * den gewuenschten Zustand herstellt — fehlendes WebGPU (GPU-01) oder
 * vorhandenes ohne Adapter (GPU-03). Sie steht im Worker und nicht im
 * Fenster, weil die Geraetepruefung dort laeuft (`separate.worker.ts`,
 * Nachricht `probe`); ein Startskript der Seite erreicht ihn nicht.
 *
 * **Was hier nicht nachweisbar ist**, und wofuer es ein echtes Geraet
 * braucht: ob die Trennung auf einer Handy-Grafikeinheit durchlaeuft, ob
 * der Compatibility-Modus greift, ob der Speicher reicht, und ob der
 * Download der Spuren in Chrome fuer Android ankommt. Dieser Lauf sagt
 * nur: wer in diesen Zustand geraet, bekommt die richtige Auskunft.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
/**
 * Der gepruefte Bau. Ueber `MIXAPART_DIST` auch ein anderer — damit sich
 * dieser Lauf gegen einen absichtlich verdorbenen Bau richten laesst. Eine
 * Pruefung, die nicht fehlschlagen kann, sagt nichts; nachgewiesen wird das
 * an einer Kopie, in der ein Handy-Text durch den Desktop-Text ersetzt ist.
 */
const dist = process.env.MIXAPART_DIST ?? join(root, 'dist', 'mixapart-public', 'browser');

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
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Die Grafikzustaende, die sich stellen lassen.
 *
 * Vorangestellt wird dem Worker. Dass das erst nach seinen Importen
 * laeuft, ist gleichgueltig: gefragt wird die Attrappe erst, wenn die
 * Nachricht `probe` eintrifft, und die kommt aus dem Fenster.
 */
const ATTRAPPEN = {
  /** WebGPU ist da und gibt nichts her — der Android-Fall, GPU-03. */
  'kein-adapter': `
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {
        // Der Compatibility-Modus bekommt dieselbe Antwort. Sonst stuende
        // im Bericht ein Adapter, den kein solches Handy hat.
        requestAdapter: async () => null,
        getPreferredCanvasFormat: () => 'bgra8unorm',
        wgslLanguageFeatures: new Set(),
      },
    });
  `,
  /** Der Browser kennt WebGPU nicht — GPU-01. */
  fehlt: `
    try { delete Object.getPrototypeOf(navigator).gpu; } catch {}
    Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined });
  `,
  /** Nichts stellen — was der Browser hergibt, gilt. */
  echt: '',
};

/** Der Lauf, der gerade dran ist — der Server liest hier mit. */
let aktuell = { cloud: false, gpu: 'echt' };

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'OK  ' : 'FEHL'}] ${name}`);
  console.log(`         ${detail}`);
}

/** Vergleicht normalisiert: die Vorlagen brechen Zeilen, die Texte nicht. */
const flach = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

function enthaelt(name, text, teil) {
  const da = flach(text).includes(teil);
  check(
    name,
    da,
    da
      ? `gefunden: „${teil}“`
      : `fehlt: „${teil}“\n         stattdessen: ${flach(text).slice(0, 220)}`,
  );
  return da;
}

function fehlt(name, text, teil) {
  const da = flach(text).includes(teil);
  check(
    name,
    !da,
    da ? `steht da, soll aber nicht: „${teil}“` : `nicht vorhanden, richtig: „${teil}“`,
  );
}

/**
 * Die Faelle.
 *
 * `uaData: false` entfernt `navigator.userAgentData` im Fenster. Chrome auf
 * Android liefert es, und dann entscheidet es die Erkennung allein; Firefox
 * und Safari liefern es nicht, und dann traegt der UA-Text. Beide Wege
 * stehen in `platform.ts`, also werden beide gegangen. Im Worker bleibt es
 * vorhanden — dorthin reicht kein Startskript.
 */
const FAELLE = [
  {
    name: 'Android, Serverweg eingerichtet',
    geraet: 'Pixel 7',
    cloud: true,
    gpu: 'kein-adapter',
    async pruefen(page) {
      await page.waitForSelector('.local', { timeout: 20_000 });
      // Das Fenster darf nicht aufgehen. Es gibt keinen Zeitpunkt, an dem
      // das endgueltig feststeht, also wird kurz gewartet: der Effekt
      // laeuft, sobald Geraetepruefung und cloud.json beide da sind.
      await page.waitForTimeout(1500);
      const offen = await page.locator('dialog.device-modal[open]').count();
      check(
        'Kein Geraetefenster, wenn der Serverweg bereitsteht',
        offen === 0,
        offen === 0 ? 'Fenster blieb zu' : 'Fenster ging auf, obwohl es einen Weg gibt',
      );

      // Ohne Grafikfreigabe bleibt hier genau ein Weg uebrig, und eine
      // Liste mit einem Eintrag ist keine Wahl. Der Geraetepfad waere auf
      // diesem Telefon eine knappe Stunde Rechnen und faellt deshalb
      // heraus, CUDA gibt es ohne Backend nicht.
      const auswahl = await page.locator('[data-testid="site-select"]').count();
      const kopf = flach(await page.locator('.local').first().innerText());
      check(
        'Kein Auswahlfeld, wenn nur der Serverweg bleibt',
        auswahl === 0,
        auswahl === 0 ? `Kopfzeile: „${kopf}“` : 'Ein Auswahlfeld mit einem Eintrag',
      );
      check(
        'Die Kopfzeile nennt den Serverweg',
        kopf.includes('Modus: Fremdserver'),
        `Kopfzeile: „${kopf}“`,
      );

      // Der Geraetehinweis ist in die FAQ gewandert; in der Karte hat er
      // nichts mehr zu suchen.
      const hinweis = await page.locator('[data-testid="no-webgpu"]').count();
      check(
        'Kein Geraetehinweis mehr in der Karte',
        hinweis === 0,
        hinweis === 0 ? 'nicht vorhanden' : 'steht immer noch da',
      );
    },
  },
  {
    name: 'Android, kein Serverweg',
    geraet: 'Pixel 7',
    cloud: false,
    gpu: 'kein-adapter',
    async pruefen(page) {
      const dialog = page.locator('dialog.device-modal[open]');
      await dialog.waitFor({ timeout: 20_000 });
      const text = await dialog.textContent();
      enthaelt('Ueberschrift', text, 'Leider wird Ihr Gerät momentan nicht unterstützt');
      enthaelt('Handy-Fassung der Nachricht', text, 'Musik würde Ihr Gerät nicht verlassen');
      enthaelt('Handy-Fassung des Vorbehalts', text, 'eher eine Stunde als zehn Minuten');
      fehlt(
        'Kein Rat zur Grafikkarte',
        text,
        'eine Grafikkarte, auf die der Browser zugreifen darf',
      );
      enthaelt('Code steht fuer sich', await page.locator('.code').textContent(), 'GPU-03');

      // Der Bericht kommt aus dem Worker und traegt den Grund im Klartext.
      // Damit haengt an diesem Knopf die zweite Haelfte der Pruefung: ob
      // auch dort die Handy-Fassung steht und nicht der Treiberrat.
      await page.locator('.code-row button').click();
      const bericht = await page.evaluate(() => navigator.clipboard.readText());
      enthaelt('Bericht nennt den Code', bericht, 'Code: GPU-03');
      enthaelt(
        'Bericht begruendet geraetegerecht',
        bericht,
        'nur für einen Teil der verbauten Grafikeinheiten',
      );
      fehlt('Kein Treiberrat im Bericht', bericht, 'Oft hilft ein aktueller Grafiktreiber');
    },
  },
  {
    name: 'Android ohne userAgentData (Rueckfallweg UA-Text)',
    geraet: 'Pixel 7',
    cloud: false,
    gpu: 'kein-adapter',
    uaData: false,
    async pruefen(page) {
      const weg = await page.evaluate(() => 'userAgentData' in navigator);
      check('userAgentData ist im Fenster entfernt', !weg, weg ? 'noch vorhanden' : 'entfernt');
      const dialog = page.locator('dialog.device-modal[open]');
      await dialog.waitFor({ timeout: 20_000 });
      enthaelt(
        'Erkennung traegt auch ohne userAgentData',
        await dialog.textContent(),
        'Musik würde Ihr Gerät nicht verlassen',
      );
    },
  },
  {
    name: 'Android ohne WebGPU (GPU-01)',
    geraet: 'Galaxy S9+',
    cloud: false,
    gpu: 'fehlt',
    async pruefen(page) {
      const dialog = page.locator('dialog.device-modal[open]');
      await dialog.waitFor({ timeout: 20_000 });
      enthaelt('Code steht fuer sich', await page.locator('.code').textContent(), 'GPU-01');
      await page.locator('.code-row button').click();
      const bericht = await page.evaluate(() => navigator.clipboard.readText());
      enthaelt('Bericht nennt die Android-Fassung', bericht, 'Auf Android kann es Chrome ab');
      fehlt('Kein Rat zu Chrome oder Edge am Rechner', bericht, 'es braucht Chrome oder Edge');
    },
  },
  {
    name: 'Desktop zur Gegenprobe',
    geraet: 'Desktop Chrome',
    cloud: false,
    gpu: 'kein-adapter',
    async pruefen(page) {
      const dialog = page.locator('dialog.device-modal[open]');
      await dialog.waitFor({ timeout: 20_000 });
      const text = await dialog.textContent();
      enthaelt(
        'Desktop-Fassung der Nachricht',
        text,
        'eine Grafikkarte, auf die der Browser zugreifen darf',
      );
      enthaelt('Desktop-Fassung des Vorbehalts', text, 'eher zehn Minuten als eine');
      fehlt('Keine Handy-Fassung', text, 'Musik würde Ihr Gerät nicht verlassen');
      await page.locator('.code-row button').click();
      const bericht = await page.evaluate(() => navigator.clipboard.readText());
      enthaelt('Bericht raet zum Treiber', bericht, 'Oft hilft ein aktueller Grafiktreiber');
    },
  },
];

async function main() {
  try {
    await stat(join(dist, 'index.html'));
  } catch {
    console.error(
      'Kein oeffentlicher Bau gefunden. Erst bauen:\n  npm run build:public\n' +
        `(erwartet ${dist})\n`,
    );
    process.exit(2);
  }

  const server = createServer(async (req, res) => {
    const pfad = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // Der Serverweg, gestellt. Die Adresse zeigt auf diesen Testserver
    // selbst — eine fremde Herkunft braeuchte CORS, und darum geht es hier
    // nicht. Ohne Token gilt der Weg als nicht eingerichtet, siehe
    // cloud-config.ts; genau das ist der zweite Fall.
    if (pfad === '/cloud.json') {
      const body = aktuell.cloud
        ? JSON.stringify({
            url: '/serverweg',
            token: 'testmarke',
            region: 'Pruefstand',
            keep_hours: 6,
            provider_keep_days: 7,
          })
        : JSON.stringify({ url: '', token: '', region: 'Pruefstand' });
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }).end(body);
      return;
    }

    // Die gemessene Rechenzeit. Scheitert der Aufruf, bleibt der Weg
    // begehbar und nur die Zahl fehlt — hier steht sie, damit kein
    // Fehlschlag im Protokoll liegt, den spaeter jemand deutet.
    if (pfad === '/serverweg/health') {
      res
        .writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: true, format: 'wav', seconds_per_minute: 13, measured: true }));
      return;
    }

    const datei = pfad === '/' ? join(dist, 'index.html') : join(dist, pfad);
    try {
      let body = await readFile(datei);
      const attrappe = ATTRAPPEN[aktuell.gpu] ?? '';
      if (attrappe !== '' && /(^|\/)worker-[^/]*\.js$/.test(pfad)) {
        body = Buffer.concat([Buffer.from(attrappe, 'utf8'), body]);
      }
      res.writeHead(200, {
        'content-type': TYPES[extname(datei)] ?? 'application/octet-stream',
        'content-length': String(body.byteLength),
        // Die Faelle liefern dieselbe Adresse mit verschiedenem Inhalt
        // aus, und der Browserspeicher haengt am Prozess und nicht am
        // Kontext. Ohne das koennte ein Lauf den praeparierten Worker des
        // vorigen bekommen.
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('nicht gefunden');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch();

  console.log('\nHANDY-PRUEFUNG (emuliert)\n');

  try {
    for (const fall of FAELLE) {
      console.log(`\n${fall.name}`);
      aktuell = { cloud: fall.cloud, gpu: fall.gpu };

      const context = await browser.newContext({
        ...devices[fall.geraet],
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      if (fall.uaData === false) {
        await context.addInitScript(() => {
          // Ein Browser ohne diese Angabe — Firefox und Safari auf Android.
          delete Object.getPrototypeOf(navigator).userAgentData;
          delete navigator.userAgentData;
        });
      }
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') console.error('  [Browser]', m.text());
      });

      try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await fall.pruefen(page);
      } catch (err) {
        check(fall.name, false, `abgebrochen: ${err.message}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const schlecht = results.filter((r) => !r.pass);
  console.log(`\n${results.length - schlecht.length} von ${results.length} Pruefungen bestanden.`);
  if (schlecht.length > 0) {
    console.log('\nFehlgeschlagen:');
    for (const r of schlecht) console.log(`  - ${r.name}`);
  }
  console.log(
    '\nNicht geprueft, dafuer braucht es ein echtes Geraet: Trennung auf einer\n' +
      'Handy-Grafikeinheit, Compatibility-Modus, Speicher, Download in Chrome\n' +
      'fuer Android.\n',
  );
  process.exit(schlecht.length > 0 ? 1 : 0);
}

await main();
