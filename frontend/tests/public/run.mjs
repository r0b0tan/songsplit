/**
 * Die oeffentliche Variante von Ende zu Ende — ohne Backend, ohne Datenbank.
 *
 *   npm run build:public
 *   node tests/public/run.mjs
 *
 * Gepruefte Zusagen, in der Reihenfolge der Aufgabenstellung:
 *
 * - Es gibt keinen Server. Jede Anfrage nach `/api` wird mitgeschrieben und
 *   gilt als Fehler; der Testserver liefert dort absichtlich 500, damit ein
 *   uebersehener Aufruf auch wirklich auffaellt und nicht still gelingt.
 * - Der ganze Weg laeuft ueber die normale Oberflaeche: Datei hineinlegen,
 *   trennen, zusehen, im Deck ueben, als WAV speichern.
 * - Das Deck laesst sich bedienen — Abspielen, Seek, Solo, Mute,
 *   Spurlautstaerke, Pitch, Mix- und Solo-Tempo, A/B-Loop.
 * - Der Verlauf gilt fuer die Sitzung: nach einem Neuladen ist er leer.
 * - Im dauerhaften Speicher des Browsers liegen keine Audiodaten und keine
 *   Dateinamen. Nur die Modellgewichte stehen im Cache, und zwar unter
 *   einem Namen, der die Fassung enthaelt.
 * - Nach dem Laden der Assets laeuft eine Trennung auch bei abgeschaltetem
 *   Netz.
 *
 * Die Trennung laeuft hier auf WASM, denn der Testbrowser hat unter WSL2
 * keinen echten Grafikadapter. Fuer *diese* Pruefungen ist das gleichgueltig
 * — gemessen wird der Ablauf, nicht die Zeit. Die Zeit steht in
 * `tests/webgpu/run.mjs`.
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { makeInputWav } from '../lib/wav.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist', 'mixapart-public', 'browser');

/** Kurz, damit eine Trennung auf WASM in Sekunden und nicht Minuten laeuft. */
const CLIP_SECONDS = 4;
const RATE = 44100;

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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'OK  ' : 'FEHL'}] ${name}`);
  console.log(`         ${detail}`);
}


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

  const work = await mkdtemp(join(tmpdir(), 'mixapart-public-'));
  const inputPath = join(work, 'Pruefstueck (Testlauf) [xyz].wav');
  await writeFile(inputPath, makeInputWav(CLIP_SECONDS, RATE));

  /** Jede Anfrage, die der Browser stellt. */
  const requests = [];
  const apiHits = [];

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    requests.push(path);
    if (path.startsWith('/api')) {
      // Absichtlich ein Fehler: ein uebersehener Backendaufruf soll
      // auffallen und nicht still gelingen.
      apiHits.push(path);
      res.writeHead(500).end('kein Backend in dieser Variante');
      return;
    }
    const file = path === '/' ? join(dist, 'index.html') : join(dist, path);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-length': String(body.byteLength),
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
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--js-flags=--max-old-space-size=4096',
    ],
  });
  const context = await browser.newContext({ acceptDownloads: true });

  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('  [Browser]', m.text());
    });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('app-import-panel', { timeout: 30_000 });

    console.log('\nOEFFENTLICHE VARIANTE (Chromium, kein Backend)\n');

    // ------------------------------------------------- 1. kein Backend
    await page.waitForTimeout(1500);
    check(
      'Kein Backend wird angesprochen',
      apiHits.length === 0,
      apiHits.length
        ? `Angefragt: ${[...new Set(apiHits)].join(', ')}`
        : `${requests.length} Anfragen, keine davon nach /api`,
    );

    const label = await page.locator('.local').first().innerText();
    check(
      'Die Kopfzeile nennt den Trennort der Variante',
      label.includes('Alles auf diesem Gerät'),
      `Kopfzeile: „${label.replace(/\s+/g, ' ').trim()}"`,
    );

    // Der Ort steht in der lokalen Variante als Auswahlfeld in der
    // Kopfzeile. Hier darf es keines geben: eine Auswahl mit einem Eintrag
    // ist keine Auswahl, sondern eine Behauptung.
    const sitePick = await page.locator('[data-testid="site-select"]').count();
    const localLabel = await page.locator('.local').first().innerText();
    check(
      'Ohne Backend gibt es keine Wahl des Trennorts',
      sitePick === 0 && localLabel.includes('Alles auf diesem Gerät'),
      sitePick === 0
        ? `Kein Auswahlfeld, nur der Satz „${localLabel.replace(/\s+/g, ' ').trim()}"`
        : 'Ein Auswahlfeld, obwohl es nur einen Ort gibt',
    );

    const modes = await page.locator('[data-testid="model"]').allInnerTexts();
    check(
      'Angeboten werden nur die Modi, die ausgeliefert sind',
      modes.length > 0 && !modes.join(' ').includes('Nur Gesang'),
      `Modi: ${modes.map((m) => m.split('\n')[0]).join(', ')}`,
    );


    // --------------------------------------------- 2. Testpfad und Deck
    await page.getByRole('button', { name: 'Testspuren anlegen' }).click();
    await page.waitForSelector('[data-testid="job"]', { timeout: 15_000 });
    await page.locator('[data-testid="open-in-player"]').first().click();
    await page.waitForSelector('[data-testid="track"][data-state="ready"]', {
      timeout: 30_000,
    });
    const testTracks = await page.locator('[data-testid="track"]').count();
    check(
      'Testpfad legt die Spuren an und das Deck öffnet sie',
      testTracks === 3,
      `${testTracks} Spuren im Deck (erwartet 3)`,
    );

    const filled = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('[data-testid="waveform"] canvas')];
      return canvases.map((c) => {
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let on = 0;
        for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 8) on++;
        return Math.round((on / (data.length / (4 * 97))) * 100);
      });
    });
    check(
      'Die Wellenformen sind gezeichnet',
      filled.length === 3 && filled.every((f) => f > 1 && f < 80),
      `Füllung je Spur: ${filled.join(' %, ')} %`,
    );

    await deckControls(page);
    await page.getByRole('button', { name: 'Deck schließen' }).click().catch(async () => {
      await page.keyboard.press('Escape');
    });
    await page.waitForTimeout(300);

    // ------------------------------------- 3. echte Trennung über die UI
    await page.locator('input[type=file]').setInputFiles(inputPath);
    const startButton = page.locator('button.start');

    // Vor dem ersten Lauf fragt die Karte nach: 174 MB gehen ueber die
    // Leitung des Menschen, und das ist eine Folge, die vor den Klick
    // gehoert. „Nein" muss folgenlos bleiben — sonst waere die Frage eine
    // Verzierung.
    await startButton.click();
    const ask = page.locator('[data-testid="ask-download"]');
    // Gewartet wird auf die Frage, nicht auf den Rahmen: `showModal()`
    // laeuft sofort, der Inhalt kommt einen Durchlauf spaeter aus dem
    // Signal. Wer auf das `dialog` wartet, liest es im leeren Moment.
    const askOpen = await ask
      .locator('.ask-q')
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    const askText = askOpen ? (await ask.innerText()).replace(/\s+/g, ' ') : '';
    await ask.getByRole('button', { name: 'Nein' }).click();
    await page.waitForTimeout(800);
    const startedAnyway = await page.locator('[data-testid="progress-bar"]').count();
    check(
      'Vor dem ersten Download wird gefragt, „Nein" startet nichts',
      askOpen && /\d+ MB/.test(askText) && startedAnyway === 0,
      askOpen
        ? `„${askText.slice(0, 95)}" — nach „Nein" ${startedAnyway} Läufe`
        : 'Es wurde nicht gefragt',
    );

    await startButton.click();
    await ask.getByRole('button', { name: 'Ja' }).click();

    // Der Fortschritt muss aus etwas Gezaehltem kommen: erst das Modell
    // (Bytes), dann die Bloecke.
    const sawBar = await page
      .waitForSelector('[data-testid="progress-bar"]', { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const phases = new Set();
    // Die ausfuehrlichen Angaben stehen im Trennfenster — in der
    // oeffentlichen Variante also der Grafikadapter und die Fassung der
    // Runtime. Mitgelesen wird waehrend des Laufs, denn das Fenster geht
    // zu, sobald das Deck aufgeht.
    let longFacts = '';
    const watcher = setInterval(async () => {
      try {
        const text = await page.locator('.stage').first().innerText();
        if (text) phases.add(text.split('\n')[0].replace(/\d+/g, 'n'));
        if (!longFacts) {
          longFacts = (
            await page.locator('[data-testid="run-facts"]').innerText()
          ).replace(/\s+/g, ' ');
        }
      } catch {
        /* Fenster schon zu */
      }
    }, 250);

    // Fertig heisst: das Deck geht von selbst auf.
    await page.waitForSelector('[data-testid="track"][data-state="ready"]', {
      timeout: 4 * 60_000,
    });
    clearInterval(watcher);
    const stems = await page.locator('[data-testid="track"]').count();
    check(
      'Dateiimport, Trennung und Deck ohne Zwischenstation',
      stems === 4,
      `${stems} Spuren im Deck (erwartet 4); Fortschrittsbalken ` +
        `${sawBar ? 'war da' : 'fehlte'}`,
    );
    check(
      'Das Trennfenster trägt die ausführlichen Angaben',
      /Rechnet auf/.test(longFacts) &&
        /Adapter/.test(longFacts) &&
        /ONNX Runtime/.test(longFacts),
      longFacts ? longFacts.slice(0, 120) : 'keine Angaben im Fenster',
    );
    check(
      'Modelldownload und Trennung sind getrennte Zustände',
      [...phases].some((p) => /Modell/.test(p)) &&
        [...phases].some((p) => /getrennt|Block/.test(p)),
      `Phasen: ${[...phases].join(' | ') || '(keine gesehen)'}`,
    );

    // ------------------------------------------------ 4. WAV-Download
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.locator('button.wav').first().click(),
    ]).then(([d]) => d);
    const saved = join(work, 'stem.wav');
    await download.saveAs(saved);
    const wav = await readFile(saved);
    const riff = wav.subarray(0, 4).toString('ascii');
    const channels = wav.readUInt16LE(22);
    const rate = wav.readUInt32LE(24);
    const bits = wav.readUInt16LE(34);
    const frames = wav.readUInt32LE(40) / (channels * (bits / 8));
    const seconds = frames / rate;
    check(
      'Eine Spur lässt sich als WAV speichern',
      riff === 'RIFF' &&
        channels === 2 &&
        rate === RATE &&
        bits === 16 &&
        Math.abs(seconds - CLIP_SECONDS) < 0.05,
      `${download.suggestedFilename()}: ${riff}, ${channels} Kanäle, ${rate} Hz, ` +
        `${bits} Bit, ${seconds.toFixed(2)} s (Eingabe ${CLIP_SECONDS} s)`,
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ------------------------------- 5. mehrere Jobs, erneut öffnen
    await page.getByRole('button', { name: 'Testspuren anlegen' }).click();
    await page.waitForTimeout(500);
    const jobCount = await page.locator('[data-testid="job"]').count();
    const titles = await page.locator('[data-testid="job"] .song').allInnerTexts();
    const reopen = page
      .locator('[data-testid="job"]')
      .filter({ hasText: 'Pruefstueck' })
      .locator('[data-testid="open-in-player"]');
    const canReopen = (await reopen.count()) > 0;
    let reopened = 0;
    let why = '';
    if (canReopen) {
      await reopen.first().click();
      reopened = await page
        .waitForSelector('[data-testid="track"][data-state="ready"]', {
          timeout: 60_000,
        })
        .then(() => page.locator('[data-testid="track"]').count())
        .catch((err) => {
          why = ` (${err.message.split('\n')[0]})`;
          return 0;
        });
    } else {
      // Entweder ist die Zeile nicht da, oder das Ergebnis ist aus dem
      // Speicher verdraengt — das waere der Hinweis „nicht mehr im
      // Speicher" an derselben Stelle.
      const gone = await page.locator('[data-testid="stems-gone"]').count();
      why = gone ? ' (steht als „nicht mehr im Speicher")' : ' (keine passende Zeile)';
    }
    check(
      'Mehrere Jobs im Verlauf, ein vorhandenes Ergebnis lässt sich erneut öffnen',
      jobCount >= 3 && canReopen && reopened === 4,
      `${jobCount} Jobs: ${titles.map((t) => t.trim()).join(' / ')}; ` +
        `erneut geöffnet mit ${reopened} Spuren${why}`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ------------------------------------ 5b. „Minimum": zwei Spuren
    // Kein eigenes Modell, sondern dieselbe Trennung mit zusammengefassten
    // Spuren. Zwei Zusagen sind zu pruefen: es kommen wirklich zwei Spuren
    // heraus, und es wird **nichts** nachgeladen — derselbe Cache-Eintrag
    // wie „Schnell", sonst waere das Zusammenfassen teuer erkauft.
    const vorMinimum = requests.length;
    await page.locator('[data-testid="model"]:has-text("Minimum")').first().click();
    await page.locator('input[type=file]').setInputFiles(inputPath);
    await page.waitForTimeout(200);
    await page.locator('button.start').click();
    const zweiSpuren = await page
      .waitForSelector('[data-testid="track"][data-state="ready"]', { timeout: 4 * 60_000 })
      .then(() => page.locator('[data-testid="track"]').count())
      .catch(() => 0);
    const spurnamen = (await page.locator('[data-testid="track"]').allInnerTexts())
      .map((t) => t.split('\n')[0].trim());
    check(
      '„Minimum" liefert zwei Spuren, ohne etwas nachzuladen',
      zweiSpuren === 2 &&
        spurnamen.join(' ').includes('Gesang') &&
        spurnamen.join(' ').includes('Begleitung') &&
        requests.length === vorMinimum,
      `${zweiSpuren} Spuren (${spurnamen.join(', ')}), ` +
        `${requests.length - vorMinimum} Anfragen`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // Zurueck auf „Schnell", damit die Pruefungen danach wie bisher laufen.
    await page.locator('[data-testid="model"]:has-text("Schnell")').first().click();

    // ----------------------------------- 5c. Der Speicherwaechter greift
    // Getrennt wird im Arbeitsspeicher, die Laenge des Liedes ist damit
    // eine Systemgrenze. Hier wird nicht die Rechnung geprueft — das tut
    // `tests/memory/run.mjs` ohne Browser —, sondern dass die Oberflaeche
    // den Start wirklich anhaelt und sagt, warum. Statt eine lange Datei
    // anzulegen, wird das Geraet klein gemacht: `deviceMemory` liest der
    // Waechter bei jedem Start neu, ein Neuladen ist dafuer nicht noetig.
    const echterSpeicher = await page.evaluate(() => navigator.deviceMemory ?? null);
    const jobsVorher = await page.locator('[data-testid="job"]').count();

    // Ausgang eins: knapp. Es kommt dieselbe Rueckfrage wie beim
    // Download, und „Nein" laesst alles, wie es war.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 1, configurable: true });
    });
    await page.locator('input[type=file]').setInputFiles(inputPath);
    await page.waitForTimeout(200);
    await page.locator('button.start').click();
    const frage = await page
      .waitForSelector('[data-testid="ask-download"] .ask-q', { timeout: 10_000 })
      .then((el) => el.innerText())
      .catch(() => '');
    await page.locator('[data-testid="ask-download"] button.demo').click();
    await page.waitForTimeout(300);
    const jobsNachNein = await page.locator('[data-testid="job"]').count();
    check(
      'Knapper Speicher fragt nach, „Nein" startet nichts',
      /Arbeitsspeicher/.test(frage) && /MB/.test(frage) && jobsNachNein === jobsVorher,
      `„${frage.replace(/\s+/g, ' ').trim()}" — ${jobsNachNein} Jobs wie vorher`,
    );

    // Ausgang zwei: aussichtslos. Hier wird nicht gefragt, sondern
    // abgelehnt — und zwar mit dem Grund, nicht mit „ging nicht".
    const vorWaechter = requests.length;
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 0.25, configurable: true });
    });
    await page.locator('button.start').click();
    const abgelehnt = await page
      .waitForSelector('.notice.bad', { timeout: 10_000 })
      .then((el) => el.innerText())
      .catch(() => '');
    const meldung = abgelehnt.replace(/\s+/g, ' ').trim();
    const jobsNachAbsage = await page.locator('[data-testid="job"]').count();
    check(
      'Zu kleines Gerät: abgelehnt, mit Grund, ohne etwas zu laden',
      /reicht der Arbeitsspeicher dieses Geräts nicht/.test(meldung) &&
        /MB/.test(meldung) &&
        // Ein Ausschnitt hilft hier nicht — und darf deshalb auch nicht
        // als Rat dastehen, schon gar nicht als „bis 0:00".
        !/0:00/.test(meldung) &&
        jobsNachAbsage === jobsVorher &&
        requests.length === vorWaechter,
      `„${meldung.slice(0, 130)}" — ${requests.length - vorWaechter} Anfragen`,
    );

    // Geraet und Eingabefeld zuruecksetzen, sonst traegt der Rest des
    // Durchlaufs eine abgelehnte Datei und ein Telefon mit sich herum.
    await page.evaluate((gb) => {
      if (gb === null) delete navigator.deviceMemory;
      else
        Object.defineProperty(navigator, 'deviceMemory', {
          value: gb,
          configurable: true,
        });
    }, echterSpeicher);
    await page.locator('input[type=file]').setInputFiles([]);
    await page.waitForTimeout(200);

    // --------------------------------- 6. Speicher und Netz inspizieren
    const storage = await page.evaluate(async () => {
      const read = (store) => {
        const out = {};
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            out[key] = (store.getItem(key) ?? '').slice(0, 120);
          }
        } catch {
          /* gesperrt */
        }
        return out;
      };
      let databases = [];
      try {
        databases = (await indexedDB.databases()).map((d) => d.name ?? '');
      } catch {
        databases = ['(nicht abfragbar)'];
      }
      let cacheKeys = [];
      try {
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) {
            cacheKeys.push(`${name}:${new URL(request.url).pathname}`);
          }
        }
      } catch {
        /* gesperrt */
      }
      return {
        local: read(localStorage),
        session: read(sessionStorage),
        databases,
        cacheKeys,
      };
    });

    // Genau der Name, der auf der Platte steht: nach einem Namen zu suchen,
    // den es nie gab, bestaetigt nichts.
    const fileName = 'Pruefstueck';
    const everything = JSON.stringify(storage.local) + JSON.stringify(storage.session);
    const noName = !everything.includes(fileName) && !everything.includes('Testlauf');
    const noDatabase = storage.databases.filter(Boolean).length === 0;
    // Gecacht gehoeren Modellgewichte und die Laufzeit — beide liegen in
    // Stuecken und werden im Arbeitsspeicher zusammengesetzt. Alles andere
    // waere ein Fund: Audiodaten oder Dateinamen haben hier nichts zu
    // suchen.
    const onlyAssets = storage.cacheKeys.every(
      (k) => k.includes('/models/') || k.includes('/vendor/onnxruntime/'),
    );
    check(
      'Keine Audiodaten und keine Dateinamen im dauerhaften Speicher',
      noName && noDatabase && Object.keys(storage.local).length === 0,
      `localStorage ${Object.keys(storage.local).length} Einträge, ` +
        `sessionStorage ${Object.keys(storage.session).length}, ` +
        `IndexedDB ${storage.databases.filter(Boolean).length} Datenbanken`,
    );
    check(
      'Gecacht sind nur Modell und Laufzeit, nichts aus der Datei',
      storage.cacheKeys.length > 0 && onlyAssets && noName,
      `Cache: ${storage.cacheKeys.join(', ') || '(leer)'}`,
    );

    const foreign = [...new Set(requests)].filter(
      (p) => !/^\/(index\.html|$|main|styles|worker|polyfills|favicon|mixapart|apple-touch|vendor|models|reference|chunk)/.test(p),
    );
    check(
      'Keine Anfrage außer eigenen Dateien',
      foreign.length === 0,
      foreign.length ? `Unerwartet: ${foreign.join(', ')}` : `${new Set(requests).size} verschiedene Pfade, alle eigene`,
    );

    // ------------------------------------------ 7. ohne Netz weiterhin
    // Die Zusage lautet: sind die Assets geladen, braucht eine Trennung
    // kein Netz. Geprueft wird deshalb in derselben Sitzung — Modell im
    // Cache, Runtime im Speicher. Ein Neuladen *ohne* Netz ist eine andere
    // Zusage, und die gilt nicht: die ONNX-Runtime holt ihre
    // Javascript-Bruecke (53 kB) bei jedem Seitenaufbau selbst, und ohne
    // Service Worker liegt die nur im HTTP-Cache. Siehe Offene Punkte.
    await context.setOffline(true);
    const before = requests.length;
    await page.locator('input[type=file]').setInputFiles(inputPath);
    await page.locator('button.start').click();
    // Hier darf nicht mehr gefragt werden: die Gewichte liegen im Cache.
    // Faellt der Dialog doch auf, soll das als Fehler sichtbar werden und
    // nicht den Lauf blockieren.
    await page.waitForTimeout(700);
    const askedAgain = await page
      .locator('[data-testid="ask-download"] .ask-q')
      .isVisible()
      .catch(() => false);
    if (askedAgain) {
      await page
        .locator('[data-testid="ask-download"]')
        .getByRole('button', { name: 'Ja' })
        .click();
    }
    check(
      'Beim zweiten Lauf wird nicht noch einmal gefragt',
      !askedAgain,
      askedAgain ? 'Die Rückfrage kam erneut, obwohl das Modell liegt' : 'keine Rückfrage',
    );
    const offlineOk = await page
      .waitForSelector('[data-testid="track"][data-state="ready"]', {
        timeout: 4 * 60_000,
      })
      .then(() => true)
      .catch(() => false);
    const offlineStems = offlineOk ? await page.locator('[data-testid="track"]').count() : 0;
    check(
      'Bei abgeschaltetem Netz läuft eine Trennung weiter',
      offlineOk && offlineStems === 4,
      offlineOk
        ? `${offlineStems} Spuren getrennt, während das Netz aus war ` +
          `(${requests.length - before} Anfragen erreichten den Server)`
        : 'Die Trennung kam ohne Netz nicht durch',
    );
    await context.setOffline(false);
    await page.keyboard.press('Escape');

    // --------------------------------------- 8. Verlauf gilt der Sitzung
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('app-import-panel', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    const afterReload = await page.locator('[data-testid="job"]').count();
    check(
      'Nach dem Neuladen ist der Verlauf leer',
      afterReload === 0,
      `${afterReload} Jobs nach dem Neuladen (erwartet 0)`,
    );

    // ------------------------- 9. veraltete Beschreibung im Cache
    // Das `manifest.json` liegt im Cache, und seine Form hat sich schon
    // geaendert: vor dem Zerlegen der Gewichte standen `file` und `bytes`
    // flach darin, heute unter `weights`. Ein Eintrag von vorher blieb
    // liegen, weil der Cache-Name derselbe ist — und die Importkarte zeigte
    // daraufhin **keinen einzigen Trennmodus** mehr, ohne eine Meldung.
    // In einem eigenen Kontext, damit der Cache nicht der des Durchlaufs
    // oben ist.
    const stale = await browser.newContext();
    try {
      const page2 = await stale.newPage();
      await page2.goto(base, { waitUntil: 'load' });
      await page2.waitForSelector('app-import-panel', { timeout: 30_000 });
      await page2.evaluate(async () => {
        const cache = await caches.open('mixapart-modelle-v1');
        for (const [url, name] of [
          ['models/htdemucs-op17-fp32/manifest.json', 'htdemucs'],
          ['models/htdemucs_6s-op17-fp32/manifest.json', 'htdemucs_6s'],
        ]) {
          const alt = {
            name,
            sources: ['drums', 'bass', 'other', 'vocals'],
            sample_rate: 44100,
            channels: 2,
            segment_samples: 343980,
            nfft: 4096,
            hop_length: 1024,
            freq_bins: 2048,
            frames: 336,
            opset: 17,
            precision: 'fp32',
            file: `${name}.onnx`,
            bytes: 174261060,
            sha256: 'veraltet',
          };
          await cache.put(
            new URL(url, location.href).href,
            new Response(JSON.stringify(alt), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
      });
      await page2.reload({ waitUntil: 'load' });
      await page2.waitForSelector('app-import-panel', { timeout: 30_000 });
      await page2.waitForTimeout(2500);
      const staleModes = await page2
        .locator('[data-testid="model"]')
        .allInnerTexts();
      check(
        'Eine veraltete Beschreibung im Cache blockiert die Modi nicht',
        staleModes.length > 0,
        staleModes.length
          ? `${staleModes.length} Modi, neu geholt: ${staleModes
              .map((m) => m.split('\n')[0])
              .join(', ')}`
          : 'Kein Trennmodus — der alte Eintrag wurde nicht ersetzt',
      );

      // Und wenn er sich nicht ersetzen laesst, weil nichts erreichbar ist:
      // dann steht es wenigstens da. Eine leere Liste ohne Begruendung sieht
      // aus wie „laedt noch" und bleibt es auch.
      await page2.route('**/manifest.json', (route) => route.abort());
      await page2.evaluate(async () => {
        const cache = await caches.open('mixapart-modelle-v1');
        for (const key of await cache.keys()) {
          if (key.url.endsWith('manifest.json')) {
            await cache.put(
              key.url,
              new Response(JSON.stringify({ name: 'alt', file: 'x.onnx' }), {
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
        }
      });
      await page2.reload({ waitUntil: 'load' });
      await page2.waitForSelector('app-import-panel', { timeout: 30_000 });
      await page2.waitForTimeout(2500);
      const notice = await page2
        .locator('[data-testid="no-model"]')
        .innerText()
        .catch(() => '');
      check(
        'Ist kein Modus lesbar, sagt die Oberflaeche warum',
        /Keine Modellbeschreibung ist lesbar/.test(notice),
        notice ? `„${notice.replace(/\s+/g, ' ').slice(0, 120)}"` : 'Keine Meldung',
      );
    } finally {
      await stale.close();
    }
  } catch (err) {
    check('Durchlauf', false, `Ausnahme: ${err.message}`);
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(
    `\n  ${results.length - failed} von ${results.length} Pruefungen bestanden.\n`,
  );
  process.exit(failed ? 1 : 0);
}

/**
 * Die Bedienelemente des Decks, der Reihe nach.
 *
 * Gemessen wird am veroeffentlichten Zustand der Engine und an der
 * Oberflaeche, nicht am Klang — den prueft `tests/audio/` gegen das
 * gerenderte Audio. Hier geht es darum, dass die Knoepfe am richtigen Draht
 * haengen.
 */
async function deckControls(page) {
  const position = page.locator('[data-testid="position"]');

  await page.locator('[data-testid="playpause"]').click();
  await page.waitForTimeout(1200);
  const running = await position.innerText();
  await page.locator('[data-testid="playpause"]').click();
  check(
    'Abspielen lässt die Position laufen',
    running !== '0:00.000' && running !== '',
    `nach gut einer Sekunde: ${running}`,
  );

  // Seek über die Wellenform: hineinklicken springt an die Stelle.
  const wave = page.locator('[data-testid="waveform"]').first();
  const box = await wave.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const seeked = await position.innerText();
  check(
    'Ein Klick in die Wellenform springt an die Stelle',
    /^0:1[0-9]/.test(seeked),
    `halbe Bahn bei 30 s Länge: ${seeked}`,
  );

  // Solo und das eigene Tempo der solierten Spur.
  await page.locator('[data-testid="solo"]').first().click();
  await page.waitForTimeout(200);
  const soloRate = page.locator('[data-testid="solo-rate"]');
  const hasSoloRate = (await soloRate.count()) > 0;
  if (hasSoloRate) await soloRate.fill('70');
  await page.waitForTimeout(200);
  const soloPressed = await page
    .locator('[data-testid="solo"]')
    .first()
    .getAttribute('aria-pressed');
  check(
    'Solo erscheint mit eigenem Temporegler',
    soloPressed === 'true' && hasSoloRate,
    `Solo ${soloPressed}, Solo-Tempo ${hasSoloRate ? 'erschienen' : 'fehlt'}`,
  );
  await page.locator('[data-testid="solo"]').first().click();
  await page.waitForTimeout(200);

  // Mix-Tempo gilt wieder, sobald kein Solo mehr aktiv ist.
  const master = page.locator('[data-testid="master-rate"]');
  await master.fill('60');
  await page.waitForTimeout(200);
  check(
    'Mix-Tempo lässt sich stellen',
    (await master.inputValue()) === '60' && !(await master.isDisabled()),
    `Mix-Tempo auf ${await master.inputValue()} %`,
  );
  await master.fill('100');

  // Mute und Spurlautstaerke.
  const mute = page.locator('[data-testid="mute"]').first();
  await mute.click();
  await page.waitForTimeout(150);
  const muted = await mute.getAttribute('aria-pressed');
  await mute.click();
  const volume = page.locator('[data-testid="volume"]').first();
  await volume.fill('45');
  await page.waitForTimeout(150);
  check(
    'Mute und Spurlautstärke greifen',
    muted === 'true' && (await volume.inputValue()) === '45',
    `Mute ${muted}, Lautstärke auf ${await volume.inputValue()} %`,
  );
  await volume.fill('100');

  // Pitch klappt am Spurnamen auf.
  await page.locator('[data-testid="track-name"]').first().click();
  await page.waitForTimeout(150);
  await page.locator('[data-testid="pitch-up"]').first().click();
  await page.waitForTimeout(150);
  const pitch = await page.locator('[data-testid="pitch-value"]').first().innerText();
  check(
    'Pitch lässt sich in Halbtönen stellen',
    pitch.includes('1'),
    `nach einem Klick: ${pitch.trim()}`,
  );

  // A/B-Loop in Millisekunden eintippen.
  const a = page.locator('[data-testid="loop-a-ms"]');
  const b = page.locator('[data-testid="loop-b-ms"]');
  await a.fill('4250');
  await a.press('Enter');
  await b.fill('7800');
  await b.press('Enter');
  await page.waitForTimeout(250);
  const gotA = await a.inputValue();
  const gotB = await b.inputValue();
  check(
    'A/B-Loop lässt sich in Millisekunden eintippen',
    gotA === '4250' && gotB === '7800',
    `A ${gotA} ms, B ${gotB} ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
