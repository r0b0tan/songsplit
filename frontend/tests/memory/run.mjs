/**
 * Prueft den Speicherwaechter.
 *
 *   node tests/memory/run.mjs
 *
 * Kein Browser noetig: `memory-budget.ts` rechnet nur. Gebuendelt wird mit
 * esbuild, wie in `tests/separate/run.mjs`; das Geraet wird vorgetaeuscht,
 * indem `navigator.deviceMemory` gesetzt wird.
 *
 * Geprueft wird nicht, ob die Schaetzung „stimmt" — das kann niemand
 * sagen, kein Browser nennt die Grenze eines Tabs. Geprueft wird, dass
 * die Abstufung sitzt: ein Lied von 4:33 geht auf dem Rechner durch und
 * wird auf dem Telefon zur Rueckfrage, ein Zehnminueter auf dem Telefon
 * nicht mehr.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));

let fehler = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : 'FEHLT '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fehler++;
}

/** Geraet vortaeuschen. `undefined` = Browser, der nichts sagt. */
function setzeGeraet(gb) {
  Object.defineProperty(globalThis, 'navigator', {
    value: gb === undefined ? {} : { deviceMemory: gb },
    configurable: true,
    writable: true,
  });
}

async function main() {
  const out = await mkdtemp(join(tmpdir(), 'songsplit-mem-'));
  const bundle = join(out, 'memory-budget.mjs');
  await esbuild.build({
    entryPoints: [join(here, '..', '..', 'src', 'app', 'separate', 'memory-budget.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outfile: bundle,
  });
  const { assess, audioMib, deviceMemoryGb, asMinutes } = await import(
    pathToFileURL(bundle).href
  );

  const VIER_DREIUNDDREISSIG = 273;
  const ZEHN_MINUTEN = 600;

  // 4 Spuren eines Liedes von 4:33 sind 367 MiB — die Zahl steht so im
  // README. Dazu die dekodierte Eingabe, also eine Spur mehr.
  setzeGeraet(8);
  const vier = audioMib(VIER_DREIUNDDREISSIG, 4);
  check(
    'Die Rechnung trifft die Zahl aus dem README',
    Math.round(vier - vier / 5) === 367,
    `4 Spuren ${Math.round(vier - vier / 5)} MiB, mit Eingabe ${Math.round(vier)} MiB`,
  );

  check('„4:33" aus 273 Sekunden', asMinutes(VIER_DREIUNDDREISSIG) === '4:33');

  // --- Der Rechner: 8 GB. Hier soll nichts im Weg stehen.
  setzeGeraet(8);
  const testdatei = assess(4, 4);
  check('Die 4-Sekunden-Testdatei laeuft ohne Frage', testdatei.verdict === 'reicht');

  const liedAufRechner = assess(VIER_DREIUNDDREISSIG, 4);
  check(
    'Ein Lied von 4:33 laeuft auf 8 GB ohne Frage',
    liedAufRechner.verdict === 'reicht',
    `${Math.round(liedAufRechner.neededMib)} MB noetig, ${Math.round(liedAufRechner.budgetMib)} MB zugetraut`,
  );

  const langAufRechner = assess(ZEHN_MINUTEN, 4);
  check(
    'Zehn Minuten laufen auf 8 GB ebenfalls',
    langAufRechner.verdict === 'reicht',
    `${Math.round(langAufRechner.neededMib)} MB noetig`,
  );

  // --- Das Telefon: 2 GB. Hier beginnt die Grenze zu wirken.
  setzeGeraet(2);
  const liedAufTelefon = assess(VIER_DREIUNDDREISSIG, 4);
  check(
    'Dasselbe Lied wird auf 2 GB zur Rueckfrage',
    liedAufTelefon.verdict === 'eng',
    `${Math.round(liedAufTelefon.neededMib)} MB noetig, ${Math.round(liedAufTelefon.budgetMib)} MB zugetraut`,
  );

  const langAufTelefon = assess(ZEHN_MINUTEN, 4);
  check(
    'Zehn Minuten werden auf 2 GB abgelehnt',
    langAufTelefon.verdict === 'aussichtslos',
    `${Math.round(langAufTelefon.neededMib)} MB noetig`,
  );
  check(
    'Die Ablehnung nennt eine Laenge, die noch ginge',
    langAufTelefon.fitsSeconds > 60 && langAufTelefon.fitsSeconds < ZEHN_MINUTEN,
    `bis ${asMinutes(langAufTelefon.fitsSeconds)}`,
  );
  // Was als machbar genannt wird, muss auch durchgehen — sonst schickt die
  // Meldung den Menschen in die naechste Ablehnung.
  const geradeNoch = assess(langAufTelefon.fitsSeconds - 1, 4);
  check(
    'Die genannte Laenge geht auch wirklich durch',
    geradeNoch.verdict !== 'aussichtslos',
    geradeNoch.verdict,
  );

  // --- Sechs Spuren brauchen mehr als vier, bei gleicher Laenge.
  setzeGeraet(4);
  const vierSpuren = assess(VIER_DREIUNDDREISSIG, 4);
  const sechsSpuren = assess(VIER_DREIUNDDREISSIG, 6);
  check(
    '„Instrumente" braucht mehr als „Schnell"',
    sechsSpuren.neededMib > vierSpuren.neededMib,
    `${Math.round(vierSpuren.neededMib)} MB gegen ${Math.round(sechsSpuren.neededMib)} MB`,
  );

  // --- Ein Browser, der nichts sagt: Annahme statt Messung.
  setzeGeraet(undefined);
  const stumm = deviceMemoryGb();
  check(
    'Ohne Auskunft wird angenommen, nicht geraten',
    stumm.measured === false && stumm.gb === 4,
    `${stumm.gb} GB, gemeldet: ${stumm.measured}`,
  );
  check(
    'Und die Annahme laesst ein Lied von 4:33 durch',
    assess(VIER_DREIUNDDREISSIG, 4).verdict === 'reicht',
  );

  console.log(fehler ? `\n${fehler} Pruefung(en) fehlgeschlagen.` : '\nAlle Pruefungen bestanden.');
  process.exit(fehler ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
