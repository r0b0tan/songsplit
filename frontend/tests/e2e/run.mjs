/**
 * Ende-zu-Ende-Pruefung gegen die laufenden Server.
 *
 *   Terminal 1:  cd backend  && ../.venv/bin/python run.py
 *   Terminal 2:  cd frontend && npm start
 *   Terminal 3:  cd frontend && node tests/e2e/run.mjs [pfad/zur/musik.mp3]
 *
 * Geprueft werden der Weg von der Datei bis zur hoerbaren Einzelspur, die
 * Zustandsanzeige, der Testpfad, Solo samt eigenem Tempo und der Download.
 */
import { execFileSync } from 'node:child_process';

import { chromium } from 'playwright';

import { makeInputWav } from '../lib/wav.mjs';

/**
 * Hauptspeicher aller Chromium-Prozesse in MB.
 *
 * Die dekodierten Spuren liegen im AudioWorklet, also in einem eigenen
 * Javascript-Kontext. `performance.memory` der Seite sieht sie nicht, die
 * Prozesse schon. Gemessen wird die Summe aller Chromium-Prozesse; laeuft
 * nebenher ein weiterer Chrome, faellt die Zahl zu hoch aus. Nur unter
 * Linux verfuegbar, sonst `null`.
 */
function chromiumRssMb() {
  if (process.platform !== 'linux') return null;
  try {
    const rows = execFileSync('ps', ['-eo', 'rss,comm', '--no-headers']).toString().trim();
    let total = 0;
    for (const line of rows.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && /chrom|headless_shell/i.test(m[2])) total += Number(m[1]);
    }
    return total > 0 ? total / 1024 : null;
  } catch {
    return null;
  }
}

const UI = process.env.MIXAPART_UI ?? 'http://127.0.0.1:4200';
const API = process.env.MIXAPART_API ?? 'http://127.0.0.1:8000';
const AUDIO = process.argv[2] ?? null;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'OK  ' : 'FEHL'}] ${name}\n         ${detail}`);
};

/** Wartet, bis `probe` wahrhaftig etwas liefert. */
async function until(probe, { timeout = 30_000, interval = 500, what = 'Bedingung' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${what} nicht innerhalb von ${timeout / 1000} s erreicht`);
}

function seconds(text) {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

async function main() {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [Browser]', m.text());
  });

  console.log('\nENDE-ZU-ENDE-PRUEFUNG\n');

  // ------------------------------------------------------------------ Start
  await page.goto(UI, { waitUntil: 'networkidle' });
  const health = await (await fetch(`${API}/api/health`)).json();
  record(
    'Backend meldet sich und nennt das Geraet',
    health.ok === true,
    `Geraet ${health.device.effective.toUpperCase()}` +
      (health.device.gpu_name ? `, ${health.device.gpu_name}` : '') +
      `, audio-separator: ${health.separator_detail}`,
  );

  // ---------------------------------------------------------- Trennort
  // Worauf gerechnet wird, steht in der aufklappbaren Ortsliste — und
  // zwar **zu beiden Orten gleichzeitig**: beim Geraet der Grafikadapter
  // und die Fassung der Runtime, beim Backend die Grafikkarte und CUDA.
  // Frueher nannte eine Sprechblase nur den gerade gewaehlten Ort, und wer
  // vergleichen wollte, musste erst umschalten.
  const sitePick = page.locator('[data-testid="site-select"]');
  await sitePick.click();
  await page.waitForSelector('[data-testid="site-panel"]', { timeout: 3000 });
  const entries = page.locator('[data-testid="site-option"]');
  const siteCount = await entries.count();
  const onDevice = await entries.evaluateAll(
    (els) => els.find((el) => el.classList.contains('on'))?.dataset.site ?? null,
  );
  record(
    'Der Trennort steht zur Wahl, auf dem Geraet als Vorgabe',
    siteCount === 2 && onDevice === 'device',
    `${siteCount} Eintraege, gewaehlt: ${onDevice}`,
  );

  const clean = (t) => t.replace(/\s+/g, ' ');
  const browserEntry = clean(
    await entries.filter({ has: page.locator('[value="device"]') }).innerText(),
  );
  const serverEntry = clean(
    await entries.filter({ has: page.locator('[value="backend"]') }).innerText(),
  );
  // Je Eintrag zwei Zeilen: womit gerechnet wird und worauf. Mehr gehoert
  // nicht in eine Liste, in der man sich entscheidet — die lange Fassung
  // steht im Fenster der laufenden Trennung, siehe weiter unten.
  record(
    'Die Liste nennt beide Orte mit Verfahren und Geraet, ohne umzuschalten',
    /Browser/.test(browserEntry) &&
      /WebGPU|Prozessor/.test(browserEntry) &&
      /Lokal/.test(serverEntry) &&
      serverEntry.includes(health.device.effective.toUpperCase()) &&
      (!health.device.gpu_name || serverEntry.includes(health.device.gpu_name)),
    `Browser: ${browserEntry.slice(0, 70)} || Lokal: ${serverEntry.slice(0, 85)}`,
  );

  // Diese Pruefung gilt dem Backend, also wird ausdruecklich umgeschaltet.
  // Danach zeigt die Karte nur noch die Modi, die das Backend anbietet.
  //
  // Gedrueckt wird von Hand — hinbewegen, halten, loslassen — und nicht
  // mit `click()`. Der Unterschied ist nicht Zierde: `click()` setzt
  // Druecken und Loslassen in denselben Arbeitsschritt, ein Mensch laesst
  // achtzig Millisekunden dazwischen. In dieser Luecke verliert der Knopf
  // den Fokus, und eine Liste, die daraufhin zuklappt, nimmt dem Klick
  // sein Ziel weg. Genau das war der Fall, und `click()` ging trotzdem
  // durch: die Pruefung bestand, waehrend die Oberflaeche nicht zu
  // bedienen war.
  const serverEntryEl = entries.filter({ has: page.locator('[value="backend"]') });
  const box = await serverEntryEl.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  const switched = await until(
    async () =>
      (await sitePick.innerText()).trim() === 'CUDA' &&
      (await page.locator('[data-testid="site-panel"]').count()) === 0
        ? true
        : null,
    { what: 'Wechsel auf den Rechner', timeout: 4000, interval: 150 },
  ).catch(() => false);
  record(
    'Ein menschlicher Tastendruck waehlt den Ort und klappt die Liste zu',
    switched === true,
    switched === true
      ? `Knopf zeigt „${(await sitePick.innerText()).trim()}"`
      : `Knopf blieb auf „${(await sitePick.innerText()).trim()}"`,
  );

  // ------------------------------------------------------- Modellauswahl
  const models = await (await fetch(`${API}/api/models`)).json();
  // Das Modell steht als Karte da, nicht in einer Auswahlliste: eine Karte
  // je Modell, die gewaehlte traegt `.on`.
  const cards = page.locator('[data-testid="model"]');
  const options = (await cards.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const chosen = await cards.evaluateAll((els) =>
    els.filter((el) => el.classList.contains('on')).length,
  );
  record(
    'Mehrere Modelle stehen zur Wahl',
    models.length >= 3 && options.length === models.length && chosen === 1,
    `${options.length} Karten, eine gewaehlt: ` +
      models.map((m) => `${m.name}${m.downloaded ? '' : ' (Download noetig)'}`).join(', '),
  );
  record(
    'Die Oberflaeche nennt die Spuren je Modell',
    models.every((m) => m.stems.length >= 2),
    models.map((m) => `${m.name}: ${m.stems.join('/')}`).join(' · '),
  );

  // -------------------------------------------------------------- Testpfad
  await page.getByRole('button', { name: 'Testspuren anlegen' }).click();
  const testJob = page.locator('[data-testid="job"][data-test-path="true"]').first();
  await until(async () => (await testJob.count()) > 0, { what: 'Testpfad-Job' });
  const testJobText = (await testJob.innerText()).replace(/\s+/g, ' ').trim();
  // Fertig steht nicht mehr als Wort in der Zeile, sondern als Haken; der
  // Zustand haengt am Element und ist damit unabhaengig von der Gestaltung.
  const testJobState = await testJob.getAttribute('data-status');
  record(
    'Testpfad ist als solcher gekennzeichnet',
    testJobText.includes('Testpfad') && testJobState === 'done',
    `${testJobText.slice(0, 120)} (data-status=${testJobState})`,
  );

  // Die Testspuren liegen in Millisekunden bereit — zu schnell, um den
  // Wartezustand zu sehen. Also werden sie hier absichtlich gebremst.
  await page.route('**/stems/**', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await testJob.locator('[data-testid="open-in-player"]').click();
  const booting = await until(
    async () => {
      const spinner = await page.locator('app-player .spinner').count();
      return spinner ? { spinner, deck: await page.locator('app-player .transport').count() } : null;
    },
    { what: 'Wartezustand im Deck', timeout: 8000, interval: 100 },
  ).catch(() => null);
  await until(
    async () => (await page.locator('[data-testid="track"][data-state="ready"]').count()) === 3,
    { what: 'drei geladene Testspuren' },
  );
  await page.unroute('**/stems/**');
  record(
    'Deck zeigt erst den Spinner, dann die Spuren',
    !!booting && booting.spinner === 1 && booting.deck === 0 &&
      (await page.locator('app-player .spinner').count()) === 0,
    booting
      ? `waehrend des Ladens: ${booting.spinner} Spinner, ${booting.deck} Transportleisten; ` +
        'danach umgekehrt'
      : 'kein Wartezustand gesehen',
  );
  const trackNames = await page.locator('[data-testid="track"] strong').allInnerTexts();
  record('Player laedt die drei Testspuren', true, trackNames.join(', '));

  // Das Speichern je Spur steht sichtbar bei den Reglern, nicht versteckt
  // an der Groessenangabe: dort fiel es quer gehaltenen Geraeten weg, weil
  // diese Zeile dort nicht erscheint. Gemessen wird die sichtbare Flaeche,
  // nicht die blosse Anwesenheit im Baum.
  const dlBoxes = await page
    .locator('[data-testid="track"] [data-testid="track-download"]')
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
  record(
    'Jede Spur hat ein sichtbares Speichern-Ziel',
    dlBoxes.length === 3 && dlBoxes.every((b) => b.w >= 20 && b.h >= 20),
    dlBoxes.length
      ? dlBoxes.map((b) => `${b.w}x${b.h}`).join(', ')
      : 'kein Speichern-Ziel in den Spuren gefunden',
  );

  // Die Schrittknoepfe der Tonhoehe muessen auch dann ihre Flaeche behalten,
  // wenn die Reglerspalte schmal wird. Quer gehalten blieben von 34 Pixeln
  // einmal 14 uebrig -- zwei Schlitze unmittelbar unter der Pegelschiene.
  // Wer mit dem Finger auf das Plus zielte, traf die Schiene, und statt der
  // Tonhoehe stieg die Lautstaerke. Geprueft wird deshalb in der engsten
  // Lage, nicht in der bequemen.
  await page.setViewportSize({ width: 870, height: 412 });
  await page.waitForTimeout(400);
  const ersteSpur = page.locator('[data-testid="track"]').first();
  await ersteSpur.locator('[data-testid="track-name"]').click();
  await page.waitForTimeout(300);
  const stufen = await ersteSpur
    .locator('[data-testid="pitch"] button')
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
  record(
    'Tonhoehe: die Schrittknoepfe bleiben auch schmal greifbar',
    stufen.length === 2 && stufen.every((b) => b.w >= 26 && b.h >= 24),
    stufen.length ? stufen.map((b) => `${b.w}x${b.h}`).join(', ') : 'keine Schrittknoepfe gefunden',
  );
  await ersteSpur.locator('[data-testid="track-name"]').click();
  await page.setViewportSize({ width: 1100, height: 1400 });
  await page.waitForTimeout(400);

  // Wellenformen: sind sie tatsaechlich gezeichnet?
  const painted = await until(
    async () =>
      page.evaluate(() => {
        const canvases = [...document.querySelectorAll('app-waveform canvas')];
        const filled = canvases.map((c) => {
          const ctx = c.getContext('2d');
          if (!ctx || !c.width || !c.height) return 0;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
          return n / (c.width * c.height);
        });
        const ok = filled.length > 0 && filled.every((f) => f > 0.01);
        return ok ? { count: filled.length, filled } : null;
      }),
    { what: 'gezeichnete Wellenformen', timeout: 10_000, interval: 300 },
  );
  record(
    'Wellenformen werden gezeichnet',
    painted.count === 3,
    `${painted.count} Wellenformen, gefuellte Flaeche ` +
      painted.filled.map((f) => `${(f * 100).toFixed(0)} %`).join(', '),
  );

  // Ziehen in der Wellenform setzt den Loop
  // page.mouse scrollt nicht von selbst, anders als locator.click().
  const wave = page.locator('app-waveform .frame').first();
  await wave.scrollIntoViewIfNeeded();
  const waveBox = await wave.boundingBox();
  await page.mouse.move(waveBox.x + waveBox.width * 0.2, waveBox.y + waveBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(waveBox.x + waveBox.width * 0.5, waveBox.y + waveBox.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  // Die Aenderungserkennung laeuft asynchron: die Oberflaeche ist erst im
  // naechsten Bildaufbau aktuell, also hier warten statt sofort lesen.
  const loopMatch = await until(
    async () => {
      const text = await page.locator('.panel').last().innerText();
      return /(\d+:\d+\.\d+) – (\d+:\d+\.\d+)\s+\(([\d.]+) s\)/.exec(text);
    },
    { what: 'gesetzter Loop', timeout: 5000, interval: 150 },
  ).catch(() => null);
  const dragged = loopMatch ? Number(loopMatch[3]) : 0;
  // 20 bis 50 Prozent von 30 s sind rund 9 s.
  record(
    'Ziehen in der Wellenform setzt den A/B-Loop',
    dragged > 7 && dragged < 11,
    loopMatch
      ? `Loop ${loopMatch[1]} bis ${loopMatch[2]}, ${dragged} s (erwartet rund 9 s)`
      : 'kein Loop erkannt',
  );
  await page.getByRole('button', { name: 'Loop löschen' }).click();

  // Wiedergabe: laeuft die Position?
  await page.locator('[data-testid="playpause"]').click();
  const posBefore = seconds(await page.locator('[data-testid="position"]').innerText());
  await until(
    async () => seconds(await page.locator('[data-testid="position"]').innerText()) > posBefore + 0.8,
    { what: 'fortschreitende Position', timeout: 10_000, interval: 200 },
  );
  const posAfter = seconds(await page.locator('[data-testid="position"]').innerText());
  record(
    'Wiedergabe laeuft, Position zaehlt in Songsekunden',
    posAfter > posBefore,
    `von ${posBefore.toFixed(2)} s auf ${posAfter.toFixed(2)} s`,
  );

  // Solo: eigener Temporegler erscheint nur bei genau einer Solo-Spur
  const firstTrack = page.locator('[data-testid="track"]').first();
  await firstTrack.locator('[data-testid="solo"]').click();
  await until(async () => (await page.locator('[data-testid="solo-rate"]').count()) === 1, {
    what: 'Solo-Temporegler',
    timeout: 5000,
  });
  const secondTrack = page.locator('[data-testid="track"]').nth(1);
  await secondTrack.locator('[data-testid="solo"]').click();
  // Auf die Aktualisierung warten: ein Klick wirkt nicht im selben Tick.
  const twoSolos = await until(
    async () => {
      const n = await page.locator('[data-testid="solo-rate"]').count();
      return n === 0 ? 0 : null;
    },
    { what: 'ausgeblendeter Solo-Temporegler', timeout: 5000, interval: 150 },
  ).catch(() => page.locator('[data-testid="solo-rate"]').count());
  await secondTrack.locator('[data-testid="solo"]').click();
  await until(async () => (await page.locator('[data-testid="solo-rate"]').count()) === 1, {
    what: 'Solo-Temporegler zurueck',
    timeout: 5000,
  });
  record(
    'Solo-Temporegler nur bei genau einer Solo-Spur',
    twoSolos === 0,
    `eine Solo-Spur: 1 Regler, zwei Solo-Spuren: ${twoSolos} Regler`,
  );

  // Solo-Tempo setzen, dann Solo verlassen: Position muss weiterlaufen
  const slider = page.locator('[data-testid="solo-rate"]');
  await slider.fill('60');
  const posDuringSolo = seconds(await page.locator('[data-testid="position"]').innerText());
  await firstTrack.locator('[data-testid="solo"]').click();
  const posAfterSolo = seconds(await page.locator('[data-testid="position"]').innerText());
  record(
    'Verlassen von Solo setzt an der gehoerten Stelle fort',
    posAfterSolo >= posDuringSolo - 0.02 && posAfterSolo < posDuringSolo + 1.0,
    `bei Solo ${posDuringSolo.toFixed(2)} s, danach ${posAfterSolo.toFixed(2)} s ` +
      `(kein Ruecksprung, Differenz ${(posAfterSolo - posDuringSolo).toFixed(3)} s)`,
  );

  // A/B-Loop
  await page.getByRole('button', { name: /Loop-Anfang A/ }).click();
  await page.locator('[data-testid="playpause"]').click();
  const loopText = await page.locator('.panel').last().innerText();
  record(
    'A/B-Loop laesst sich setzen',
    /Loop an/.test(loopText),
    (loopText.match(/A.B Loop[\s\S]{0,90}/i) ?? [''])[0].replace(/\n+/g, ' '),
  );

  // Loop von Hand: die beiden Felder stehen in Millisekunden
  const fieldA = page.locator('[data-testid="loop-a-ms"]');
  const fieldB = page.locator('[data-testid="loop-b-ms"]');
  await fieldA.fill('4250');
  await fieldA.press('Enter');
  await fieldB.fill('7800');
  await fieldB.press('Enter');
  const typedLoop = await until(
    async () => {
      const text = await page.locator('footer.status').innerText();
      const m = /(\d+:\d+\.\d+) – (\d+:\d+\.\d+)\s+\(([\d.]+) s\)/.exec(text);
      return m && m[1] === '0:04.25' ? m : null;
    },
    { what: 'getippter Loop', timeout: 5000, interval: 150 },
  ).catch(() => null);
  // Zurueckgelesen wird aus dem Feld selbst: es muss zeigen, was gilt.
  const readBack = [await fieldA.inputValue(), await fieldB.inputValue()];
  record(
    'Loop laesst sich in Millisekunden eintippen',
    typedLoop?.[2] === '0:07.80' && readBack[0] === '4250' && readBack[1] === '7800',
    typedLoop
      ? `${typedLoop[1]} – ${typedLoop[2]} (${typedLoop[3]} s), Felder ` +
        `${readBack[0]} ms / ${readBack[1]} ms`
      : 'kein getippter Loop erkannt',
  );

  // Unter dem Zeiger steht die Zeit — oben in der Zeitachse, nicht in der Spur
  const hoverWave = page.locator('app-waveform .frame').first();
  const hoverBox = await hoverWave.boundingBox();
  await page.mouse.move(hoverBox.x + hoverBox.width * 0.5, hoverBox.y + hoverBox.height / 2);
  const scrubbed = await until(
    async () => {
      const el = page.locator('app-time-ruler .scrub');
      return (await el.count()) ? /(\d+) ms/.exec(await el.innerText()) : null;
    },
    { what: 'Zeit unter dem Zeiger', timeout: 5000, interval: 150 },
  ).catch(() => null);
  const duration = seconds(
    (await page.locator('.clock small').innerText()).replace('/', '').trim(),
  );
  const hoverMs = scrubbed ? Number(scrubbed[1]) : NaN;
  const wantedMs = (duration * 1000) / 2;
  record(
    'Zeitachse zeigt die Millisekunde unter dem Zeiger',
    Math.abs(hoverMs - wantedMs) < wantedMs * 0.06,
    scrubbed
      ? `Zeiger auf halber Bahn: ${hoverMs} ms (erwartet rund ${wantedMs.toFixed(0)} ms)`
      : 'keine Anzeige unter dem Zeiger',
  );

  await page.screenshot({ path: 'tests/e2e/player-testpfad.png' });

  // Das Deck ist ein Modal: solange es offen ist, liegt die Seite dahinter
  // still. Fuer alles Weitere muss es also zu sein.
  const asModal = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.deck-modal');
    return {
      open: !!dialog?.open,
      // `:modal` trifft nur, was wirklich ueber `showModal()` offen ist —
      // also mit Schleier, oberster Ebene und stillgelegtem Hintergrund.
      modal: !!dialog?.matches(':modal'),
      locked: document.documentElement.classList.contains('modal-open'),
    };
  });
  await page.keyboard.press('Escape');
  const closed = await until(
    async () => ((await page.locator('app-player').count()) === 0 ? 'zu' : null),
    { what: 'geschlossenes Deck', timeout: 5000, interval: 150 },
  ).catch(() => null);
  record(
    'Deck liegt als Modal ueber der Seite und Escape schliesst es',
    asModal.open && asModal.modal && asModal.locked && closed === 'zu',
    `offen: ${asModal.open}, modal: ${asModal.modal}, Seite festgehalten: ` +
      `${asModal.locked}, nach Escape ${closed === 'zu' ? 'geschlossen' : 'noch offen'}`,
  );

  // -------------------------------------------------------------- Jobliste
  // Die Liste waechst mit jedem Lauf. Geprueft wird, dass sie sich
  // einschraenken und blaettern laesst — und dass das grosse Aufraeumen
  // erst nach einer Rueckfrage loescht.
  const jobIds = () =>
    page.locator('[data-testid="job"]').evaluateAll((els) =>
      els.map((el) => el.dataset.jobId),
    );
  const jobStates = () =>
    page.locator('[data-testid="job"]').evaluateAll((els) =>
      els.map((el) => `${el.dataset.status}/${el.dataset.testPath}`),
    );

  // Die Reiter weiter unten trennen Songs von Testlaeufen. Dafuer muss
  // mindestens ein **echter** Job da sein — und der entstand bisher nur,
  // wenn man dem Pruefstand eine Musikdatei mitgab oder noch einer vom
  // vorigen Lauf auf der Platte lag. Auf einem aufgeraeumten Rechner war
  // der Reiter „Songs" leer und deshalb deaktiviert; der Klick lief in
  // seinen Timeout, und der Durchlauf brach ab, statt etwas zu messen.
  //
  // Dieselbe Antwort wie beim Blaettern gleich darunter: was die Pruefung
  // braucht, legt sie selbst an. Zwei Sekunden kuenstlicher Ton genuegen,
  // und gewartet wird nur auf den **Job**, nicht auf die fertige
  // Trennung — der Reiter fragt `is_test_path`, nicht den Zustand.
  const echteJobs = async () =>
    (await (await fetch(`${API}/api/jobs`)).json()).filter((j) => !j.is_test_path);
  //
  // Angelegt wird er ueber die **API**, nicht ueber die Oberflaeche. Ein
  // hier gestarteter Job zieht das Deck auf, sobald er fertig ist — und
  // zwei Sekunden Ton sind schnell fertig, naemlich mitten in den
  // Pruefungen danach. Das offene Modal faengt dann jeden Klick ab; genau
  // daran ist der erste Versuch gescheitert. Im Verlauf steht der Job so
  // oder so, und mehr braucht der Reiter nicht.
  if (!(await echteJobs()).length) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([makeInputWav(2, 44100)], { type: 'audio/wav' }),
      'Pruefstueck.wav',
    );
    const angelegt = await fetch(`${API}/api/jobs`, { method: 'POST', body: form });
    if (!angelegt.ok) {
      throw new Error(
        `Der Trennjob fuer die Reiter liess sich nicht anlegen: HTTP ${angelegt.status}`,
      );
    }
    // Die Liste holt sich von selbst nach; gewartet wird auf die Zeile,
    // nicht auf die Antwort — der Reiter liest den DOM.
    await page.waitForSelector('[data-testid="job"][data-test-path="false"]', {
      timeout: 30_000,
    });
  }

  // Blaettern laesst sich nur pruefen, wenn es etwas zu blaettern gibt:
  // zehn Jobs je Seite. Auf einem frisch aufgeraeumten Rechner steht hier
  // sonst gar keine Leiste, und die Pruefung brach ab, statt etwas zu
  // messen. Testlaeufe sind billig — sie trennen nichts —, also legt sie
  // die Pruefung selbst an.
  while ((await (await fetch(`${API}/api/jobs`)).json()).length < 11) {
    await page.getByRole('button', { name: 'Testspuren anlegen' }).click();
    await page.waitForTimeout(250);
  }
  await until(async () => ((await page.locator('[data-testid="page-of"]').count()) ? true : null), {
    what: 'Blaetterleiste',
    timeout: 15_000,
  });

  const allJobs = await (await fetch(`${API}/api/jobs`)).json();
  const firstPage = await jobIds();
  const pageOf = (await page.locator('[data-testid="page-of"]').innerText()).replace(/\s+/g, ' ');
  await page.locator('[data-testid="page-next"]').click();
  // Die Aenderungserkennung laeuft asynchron: nach dem Klick erst warten.
  const secondPage = await until(
    async () => {
      const ids = await jobIds();
      return ids.length && ids[0] !== firstPage[0] ? ids : null;
    },
    { what: 'zweite Seite', timeout: 5000, interval: 150 },
  ).catch(() => []);
  await page.locator('[data-testid="page-back"]').click();
  const backAgain = await until(
    async () => {
      const ids = await jobIds();
      return ids[0] === firstPage[0] ? ids : null;
    },
    { what: 'erste Seite zurueck', timeout: 5000, interval: 150 },
  ).catch(() => []);
  record(
    'Jobliste blaettert seitenweise',
    firstPage.length <= 10 &&
      secondPage.length > 0 &&
      backAgain.length === firstPage.length &&
      secondPage.every((id) => !firstPage.includes(id)),
    `${allJobs.length} Jobs, ${pageOf}, erste Seite ${firstPage.length}, ` +
      `zweite Seite ${secondPage.length} andere Jobs, zurueck auf derselben Seite`,
  );

  // Die Reiter trennen echte Trennungen von Testlaeufen.
  const tabs = page.locator('[data-testid="tab"]');
  const tabLabels = (await tabs.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const counts = tabLabels.map((t) => Number(/(\d+)\s*$/.exec(t)?.[1] ?? -1));

  await tabs.nth(1).click();
  const onlySongs = await until(
    async () => {
      const states = await jobStates();
      return states.length && states.every((s) => s.endsWith('/false')) ? states : null;
    },
    { what: 'Reiter "Songs"', timeout: 5000, interval: 150 },
  ).catch(() => jobStates());
  await tabs.nth(2).click();
  const onlyTests = await until(
    async () => {
      const states = await jobStates();
      return states.length && states.every((s) => s.endsWith('/true')) ? states : null;
    },
    { what: 'Reiter "Testlaeufe"', timeout: 5000, interval: 150 },
  ).catch(() => jobStates());
  await tabs.nth(0).click();
  record(
    'Verlauf trennt Songs von Testlaeufen',
    onlySongs.length > 0 &&
      onlySongs.every((s) => s.endsWith('/false')) &&
      onlyTests.length > 0 &&
      onlyTests.every((s) => s.endsWith('/true')) &&
      counts[1] + counts[2] === counts[0],
    `${tabLabels.join(' · ')} — ${counts[1]} + ${counts[2]} = ${counts[0]}`,
  );

  // Alles Abgeschlossene auf einmal: der erste Klick im Menue fragt nur.
  // Hier wird absichtlich nicht bestaetigt — die Pruefung soll keine
  // Trennungen loeschen, die Minuten gekostet haben. Dass das Loeschen
  // selbst funktioniert und Laufendes stehen laesst, prueft backend/tests.
  await page.locator('[data-testid="purge"]').click();
  const purgeItem = page.locator('[data-testid="purge-item"]');
  const beforeLabel = (await purgeItem.innerText()).replace(/\s+/g, ' ').trim();
  await purgeItem.click();
  const armedLabel = await until(
    async () => {
      const text = (await purgeItem.innerText()).replace(/\s+/g, ' ').trim();
      return /^Wirklich\?/.test(text) ? text : null;
    },
    { what: 'Rueckfrage vor dem Aufraeumen', timeout: 5000, interval: 150 },
  ).catch(async () => (await purgeItem.innerText()).trim());
  await page.keyboard.press('Escape');
  const menuGone = await until(
    async () => ((await purgeItem.count()) === 0 ? true : null),
    { what: 'geschlossenes Menue', timeout: 5000, interval: 150 },
  ).catch(() => false);
  const stillThere = (await (await fetch(`${API}/api/jobs`)).json()).length;
  record(
    'Aufraeumen fragt erst nach und loescht nichts nebenbei',
    beforeLabel === 'Alle abgeschlossenen löschen' &&
      /^Wirklich\? \d+ löschen$/.test(armedLabel) &&
      menuGone === true &&
      stillThere === allJobs.length,
    `"${beforeLabel}" → "${armedLabel}", Escape schliesst das Menue, ` +
      `${stillThere} Jobs unveraendert`,
  );

  // --------------------------------------------------- echte Datei trennen
  if (AUDIO) {
    // Vorhandene Jobs merken, damit die Pruefung den **eigenen** Job verfolgt
    // und nicht einen aelteren, der zufaellig schon fertig ist.
    const idsBefore = new Set(
      (await (await fetch(`${API}/api/jobs`)).json()).map((j) => j.id),
    );
    await page.locator('input[type="file"]').setInputFiles(AUDIO);
    await page.getByRole('button', { name: /Spuren trennen/ }).click();

    const created = await until(
      async () => {
        const jobs = await (await fetch(`${API}/api/jobs`)).json();
        return jobs.find((j) => !idsBefore.has(j.id)) ?? null;
      },
      { what: 'angelegter Job', timeout: 30_000, interval: 300 },
    );
    record(
      'Oberflaeche legt den Job mit dem gewaehlten Modell an',
      created.model === 'htdemucs',
      `Job ${created.id}, Modell ${created.model} (Vorgabe htdemucs)`,
    );

    // Nach dem Start haelt das Fortschrittsfenster die Stelle, bis es etwas
    // zu hoeren gibt.
    const runText = await until(
      async () => {
        const box = page.locator('app-run-progress');
        return (await box.count())
          ? (await box.innerText()).replace(/\s+/g, ' ').trim()
          : null;
      },
      { what: 'Fortschrittsfenster', timeout: 20_000, interval: 200 },
    ).catch(() => null);
    const runIsModal = await page.evaluate(
      () => !!document.querySelector('dialog.run-modal')?.matches(':modal'),
    );
    record(
      'Trennung oeffnet ein Fortschrittsfenster',
      !!runText && runIsModal && runText.includes('TRENNUNG'),
      runText ? `modal: ${runIsModal} · ${runText.slice(0, 110)}` : 'kein Fenster',
    );

    // Die Technik steht dort, wo gewartet wird — und nirgends sonst
    // doppelt. Gelesen wird gegen `/api/health`, damit nicht geprueft
    // wird, dass irgendein Text dasteht, sondern der richtige.
    const longFacts = (
      (await page.locator('[data-testid="run-facts"]').innerText().catch(() => '')) ?? ''
    ).replace(/\s+/g, ' ');
    record(
      'Das Trennfenster traegt die ausfuehrlichen Angaben',
      longFacts.includes(health.device.effective.toUpperCase()) &&
        (!health.device.gpu_name || longFacts.includes(health.device.gpu_name)) &&
        (!health.device.torch_version || longFacts.includes(health.device.torch_version)),
      longFacts ? longFacts.slice(0, 120) : 'keine Angaben im Fenster',
    );

    const realJob = page.locator(`[data-testid="job"][data-job-id="${created.id}"]`);
    await until(async () => (await realJob.count()) > 0, { what: 'Job in der Liste' });

    const sawProcessing = await until(
      async () => {
        const status = await realJob.getAttribute('data-status');
        return status === 'processing' || status === 'done' ? status : null;
      },
      // Die Warteschlange ist seriell. Laeuft schon eine Trennung, wartet
      // dieser Job — das koennen bei einem langen Stueck Minuten sein.
      { what: 'Verarbeitung', timeout: 600_000, interval: 500 },
    );
    record(
      'Zustaende werden angezeigt',
      ['processing', 'done'].includes(sawProcessing),
      `beobachtet: ${sawProcessing}`,
    );

    // Vor dem Deck messen: das Dekodieren der Spuren ist es, was den
    // Speicher kostet, und das faengt mit dem Deck an.
    const rssBefore = chromiumRssMb();

    await until(
      async () => (await realJob.getAttribute('data-status')) === 'done',
      { what: 'fertige Trennung', timeout: 600_000, interval: 1000 },
    );
    // „Fertig" steht nicht als Wort in der Zeile — ein fertiger Job zeigt
    // die Spurzahl und den Knopf ins Deck, ein laufender die Phase und eine
    // Uhr (siehe Bedienung in der README). Geprueft wird deshalb das, was
    // wirklich dasteht, und nicht ein Wort, das die Oberflaeche nie
    // geschrieben hat.
    const realText = await realJob.innerText();
    const opensDeck = await realJob.locator('[data-testid="open-in-player"]').count();
    record(
      'Echte Trennung wird fertig',
      opensDeck === 1 && /\d+ Spuren/.test(realText),
      realText.replace(/\n+/g, ' · ').slice(0, 170),
    );

    // Fertig heisst: weiter ins Deck, ohne Zutun.
    const autoDeck = await until(
      async () => ((await page.locator('app-player .transport').count()) ? true : null),
      { what: 'Deck geht von selbst auf', timeout: 120_000, interval: 300 },
    ).catch(() => false);
    const runGone = (await page.locator('app-run-progress').count()) === 0;
    record(
      'Fertige Trennung landet ohne Zutun im Deck',
      autoDeck === true && runGone,
      autoDeck
        ? `Deck offen, Fortschrittsfenster ${runGone ? 'geschlossen' : 'noch offen'}`
        : 'Deck ging nicht von selbst auf',
    );

    const expected = await until(
      async () => {
        const n = await page.locator('[data-testid="track"][data-state="ready"]').count();
        return n >= 4 ? n : null;
      },
      { what: 'geladene Stems', timeout: 120_000, interval: 500 },
    );
    const names = await page.locator('[data-testid="track"] strong').allInnerTexts();
    record('Stems landen im Player', expected >= 4, `${expected} Spuren: ${names.join(', ')}`);

    // Liegen die Spuren wirklich im Speicher, und wie viel kostet das?
    const rssAfter = chromiumRssMb();
    // `textContent`, nicht `innerText`: die Technikangaben stehen in einem
    // zugeklappten <details> und gehoeren damit nicht zum sichtbaren Text.
    const reported = await page.locator('.panel').last().textContent();
    const reportedMb = Number(/([\d.]+) MB\s*\n?\s*insgesamt/.exec(reported)?.[1] ?? 0);
    const rate = Number(/AudioContext (\d+) Hz/.exec(reported)?.[1] ?? 48000);
    const delta = rssBefore !== null && rssAfter !== null ? rssAfter - rssBefore : null;
    // Erwartet wird, was die Laenge hergibt: Dauer x Abtastrate x 2 Kanaele
    // x 4 Byte je Spur. Eine feste Untergrenze haenge an der Laenge der
    // Datei, mit der jemand gerade prueft — und die ist bei einem kurzen
    // Testmix eine andere als bei einem ganzen Stueck.
    // Die Laenge steht erst am fertigen Job: beim Anlegen kennt sie niemand.
    const finished = (await (await fetch(`${API}/api/jobs`)).json()).find(
      (j) => j.id === created.id,
    );
    const songSeconds = finished?.duration_seconds ?? 0;
    const expectedMb = (songSeconds * rate * 2 * 4 * expected) / 1e6;
    record(
      'Alle Spuren liegen entschluesselt im Speicher',
      expectedMb > 0 && reportedMb >= 0.6 * expectedMb,
      `Oberflaeche meldet ${reportedMb} MB, erwartet rund ${expectedMb.toFixed(0)} MB ` +
        `(${expected} Spuren, ${songSeconds.toFixed(0)} s, ${rate} Hz)` +
        (delta !== null
          ? `; Browser-Prozessbaum waechst um ${delta.toFixed(0)} MB ` +
            `(${rssBefore.toFixed(0)} auf ${rssAfter.toFixed(0)} MB)`
          : '; Prozessmessung nur unter Linux'),
    );

    const paintedReal = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('app-waveform canvas')];
      return canvases.map((c) => {
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
        return n / (c.width * c.height);
      });
    });
    record(
      'Wellenformen der echten Stems sind gezeichnet',
      paintedReal.length >= 4 && paintedReal.every((f) => f > 0.01),
      `${paintedReal.length} Wellenformen, gefuellte Flaeche ` +
        paintedReal.map((f) => `${(f * 100).toFixed(0)} %`).join(', '),
    );

    await page.locator('[data-testid="playpause"]').click();
    const p0 = seconds(await page.locator('[data-testid="position"]').innerText());
    await until(
      async () =>
        seconds(await page.locator('[data-testid="position"]').innerText()) > p0 + 0.8,
      { what: 'Wiedergabe der echten Spuren', timeout: 10_000, interval: 200 },
    );
    record(
      'Echte Spuren sind hoerbar abspielbar',
      true,
      `Position laeuft ab ${p0.toFixed(2)} s`,
    );

    await page.screenshot({ path: 'tests/e2e/player-echt.png' });
    // Das Deck ist modal: fuer den zweiten Durchgang muss es wieder zu.
    await page.getByRole('button', { name: 'Deck schließen' }).click();
    await until(async () => (await page.locator('app-player').count()) === 0, {
      what: 'geschlossenes Deck',
      timeout: 5000,
    });

    // ------------------------------------------- zweites Modell waehlen
    // Prueft, dass die Auswahl wirklich durchschlaegt: ein anderes Modell
    // liefert eine andere Zahl von Spuren und eigene Spurnamen.
    const second = models.find((m) => m.name !== 'htdemucs' && m.downloaded);
    if (second) {
      const idsBefore2 = new Set(
        (await (await fetch(`${API}/api/jobs`)).json()).map((j) => j.id),
      );
      await page
        .locator(`[data-testid="model"]:has(input[value="${second.name}"])`)
        .click();
      await page.locator('input[type="file"]').setInputFiles(AUDIO);
      await page.getByRole('button', { name: /Spuren trennen/ }).click();
      const created2 = await until(
        async () => {
          const jobs = await (await fetch(`${API}/api/jobs`)).json();
          return jobs.find((j) => !idsBefore2.has(j.id)) ?? null;
        },
        { what: 'zweiter Job', timeout: 30_000, interval: 300 },
      );
      const done2 = await until(
        async () => {
          const jobs = await (await fetch(`${API}/api/jobs`)).json();
          const j = jobs.find((x) => x.id === created2.id);
          return j && (j.status === 'done' || j.status === 'failed') ? j : null;
        },
        { what: 'zweite Trennung', timeout: 600_000, interval: 1000 },
      );
      record(
        `Zweites Modell (${second.name}) laeuft durch`,
        done2.status === 'done' && done2.stems.length === second.stems.length,
        done2.status === 'done'
          ? `${done2.stems.length} Spuren: ${done2.stems.map((x) => x.name).join(', ')}` +
            ` in ${(done2.finished_at - done2.started_at).toFixed(1)} s`
          : `fehlgeschlagen: ${done2.error}`,
      );
      // Auch dieser Job landet von selbst im Deck. Fuer den Rest der
      // Pruefung muss es wieder zu sein.
      await until(
        async () => ((await page.locator('app-player').count()) ? true : null),
        { what: 'Deck nach dem zweiten Lauf', timeout: 120_000, interval: 300 },
      ).catch(() => null);
      await page.keyboard.press('Escape');
      await until(
        async () => ((await page.locator('app-player').count()) === 0 ? true : null),
        { what: 'geschlossenes Deck', timeout: 10_000, interval: 200 },
      ).catch(() => null);
    }

    // Download einer einzelnen Spur, aus genau diesem Job
    const jobs = await (await fetch(`${API}/api/jobs`)).json();
    const real = jobs.find((j) => j.id === created.id);
    const dl = await fetch(`${API}${real.stems[0].download_url}`);
    const disposition = dl.headers.get('content-disposition') ?? '';
    record(
      'Einzelne Spur laesst sich als WAV herunterladen',
      dl.ok && dl.headers.get('content-type') === 'audio/wav' && /attachment/.test(disposition),
      `HTTP ${dl.status}, ${dl.headers.get('content-type')}, ${disposition.slice(0, 90)}`,
    );

    // Zum Schluss die Liste: das Deck ist hier laengst wieder zu.
    await page.screenshot({ path: 'tests/e2e/jobs-echt.png', fullPage: true });
  } else {
    console.log('  [ -- ] Echte Trennung uebersprungen (kein Audiopfad uebergeben)');
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed} von ${results.length} Pruefungen bestanden.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nPruefung abgebrochen:', err.message);
  process.exit(2);
});
