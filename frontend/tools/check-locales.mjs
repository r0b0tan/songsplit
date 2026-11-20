/**
 * Haelt die Sprachfassungen der statischen Seiten beieinander.
 *
 *   npm run check:locales
 *
 * Es gibt sie je zweimal: `public/de/` und `public/en/`. Zwei Dateien, die
 * dasselbe sagen sollen, sagen nach einer Weile nicht mehr dasselbe —
 * jemand aendert eine Frist, eine Anschrift, einen Abschnitt, und die
 * andere Fassung bleibt stehen. Bei einer FAQ waere das aergerlich. Bei
 * einer Datenschutzerklaerung steht dann in einer Sprache etwas Falsches,
 * und falsch ist dort schlimmer als gar nicht vorhanden.
 *
 * **Was geprueft wird**, und warum gerade das:
 *
 * - **Der Stand.** Er steht sichtbar auf jeder Seite und ist die Zusage,
 *   wie aktuell sie ist. Wer eine Fassung anfasst, zieht den Stand nach;
 *   wer die andere vergisst, faellt hier auf.
 * - **Die Gliederung.** Gleich viele `h2` und `h3`: ein neuer Abschnitt in
 *   der einen Sprache ist der sicherste Hinweis darauf, dass die andere
 *   ihn noch nicht hat.
 *
 * **Was nicht geprueft wird:** der Text selbst. Eine Uebersetzung ist nicht
 * zeichengleich, und eine Pruefung, die das verlangte, waere nach dem
 * ersten Satz abgeschaltet. Diese hier prueft, was sich maschinell
 * vergleichen laesst, und laesst den Rest dem Menschen — sie soll ihn
 * erinnern, nicht ersetzen.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const WURZEL = process.argv[2] ?? 'public';
const SEITEN = ['faq.html', 'impressum.html', 'datenschutz.html'];
const SPRACHEN = ['de', 'en'];

/** Was auf der Seite steht und sich vergleichen laesst. */
async function lies(lang, seite) {
  const text = await readFile(join(WURZEL, lang, seite), 'utf8');
  const ohneKommentare = text.replace(/<!--[\s\S]*?-->/g, '');
  const zaehle = (muster) => ohneKommentare.match(muster)?.length ?? 0;
  return {
    // „Stand: November 2026" oder „As of November 2026" — verglichen wird,
    // was dahinter steht, nicht die Einleitung.
    stand: /class="stand">\s*(?:Stand:|As of)\s*([^<]+?)\s*</.exec(ohneKommentare)?.[1] ?? null,
    h2: zaehle(/<h2[\s>]/g),
    h3: zaehle(/<h3[\s>]/g),
  };
}

let gefunden = 0;
for (const seite of SEITEN) {
  const [a, b] = await Promise.all(SPRACHEN.map((l) => lies(l, seite)));
  const melde = (was, links, rechts) => {
    console.error(
      `check-locales: ${seite} — ${was} weicht ab: ` +
        `${SPRACHEN[0]} ${links}, ${SPRACHEN[1]} ${rechts}`,
    );
    gefunden++;
  };
  if (a.stand === null || b.stand === null) {
    melde('Stand', a.stand ?? '(fehlt)', b.stand ?? '(fehlt)');
  } else if (a.stand !== b.stand) {
    melde('Stand', a.stand, b.stand);
  }
  if (a.h2 !== b.h2) melde('Zahl der Abschnitte', a.h2, b.h2);
  if (a.h3 !== b.h3) melde('Zahl der Unterpunkte', a.h3, b.h3);
}

if (gefunden) {
  console.error(
    '\nEine Fassung ist nachgezogen worden und die andere nicht. ' +
      'Beide gehoeren auf denselben Stand.',
  );
  process.exit(1);
}
console.log(`Sprachfassungen stimmen überein (${SEITEN.length} Seiten × ${SPRACHEN.length}).`);
