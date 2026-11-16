/**
 * Warnt vor Backticks in Angular-Vorlagen und -Stilen.
 *
 *   npm run check:literals
 *
 * `template:` und `styles: [` sind Template-Literale. Ein Backtick im
 * Kommentar darin — etwa um einen Dateinamen oder eine CSS-Eigenschaft
 * hervorzuheben — beendet das Literal mitten im Text. Der Compiler meldet
 * das dann an ganz anderer Stelle und in einer Sprache, die nichts davon
 * verraet:
 *
 *     Failed to resolve styles at position 1 to a string
 *     Value is a reference to 'top'.
 *
 * Wer das liest, sucht an der falschen Zeile. Diese Pruefung nennt die
 * richtige.
 *
 * **Wie erkannt wird:** nicht am Backtick selbst — der darf ja drinstehen,
 * wenn er entwertet ist — sondern an dem, was auf das Ende des Literals
 * folgt. Hinter einem ordentlich geschlossenen Literal steht ein Komma,
 * eine schliessende Klammer oder das Ende des Objekts. Steht dort Code,
 * war das Literal schon vorher zu Ende, und der Backtick davor ist der
 * Grund.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const WURZEL = process.argv[2] ?? 'src';

async function* dateien(ordner) {
  for (const e of await readdir(ordner, { withFileTypes: true })) {
    const pfad = join(ordner, e.name);
    if (e.isDirectory()) yield* dateien(pfad);
    else if (e.name.endsWith('.ts')) yield pfad;
  }
}

/**
 * Jeder Anfang eines Literals an `template:` oder `styles:`.
 *
 * Frueher stand hier ein fester Text samt Einrueckung und ein einzelnes
 * `indexOf`. Das hatte zwei Luecken, beide nachgestellt und beide echt:
 * eine zweite Komponente in derselben Datei wurde nie angesehen, und
 * `styles: [\`` in einer Zeile rutschte durch, weil dort der Zeilenumbruch
 * fehlte. Jetzt entscheidet die Form, nicht die Formatierung.
 */
const ANFANG = /\b(template|styles)\s*:\s*\[?\s*`/g;

/** Was hinter einem sauber geschlossenen Literal stehen darf. */
const ERLAUBT = new Set([',', ']', ')', '}']);

function zeileVon(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Sucht das Ende des Literals, das bei `start` beginnt.
 *
 * Entwertete Backticks zaehlen nicht, und was in `${…}` steht, gehoert zum
 * eingebetteten Ausdruck — dort darf ein Backtick stehen, und zwar auch
 * verschachtelt. Beides zu uebergehen ist der Unterschied zwischen einer
 * Pruefung, der man glaubt, und einer, die man abschaltet.
 */
function endeDesLiterals(text, start) {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === '`') {
      return i;
    } else if (c === '$' && text[i + 1] === '{') {
      let tiefe = 1;
      i += 2;
      while (i < text.length && tiefe > 0) {
        if (text[i] === '{') tiefe++;
        else if (text[i] === '}') tiefe--;
        i++;
      }
      i--;
    }
  }
  return -1;
}

let gefunden = 0;
for await (const pfad of dateien(WURZEL)) {
  const text = await readFile(pfad, 'utf8');
  ANFANG.lastIndex = 0;
  let treffer;
  while ((treffer = ANFANG.exec(text)) !== null) {
    const art = treffer[1] === 'template' ? 'Template' : 'Stil';
    const start = treffer.index + treffer[0].length;
    const ende = endeDesLiterals(text, start);
    if (ende < 0) {
      console.error(`${pfad}:${zeileVon(text, start)} — ${art} ohne Ende`);
      gefunden++;
      continue;
    }
    const danach = text.slice(ende + 1).trimStart()[0];
    if (!ERLAUBT.has(danach)) {
      console.error(
        `${pfad}:${zeileVon(text, ende)} — Backtick im ${art} ` +
          `(Literal ab Zeile ${zeileVon(text, start)} endet hier zu frueh)`,
      );
      gefunden++;
    }
    // Weiter hinter dem Literal suchen, nicht darin: sonst findet der
    // naechste Durchlauf das `styles:` eines eingebetteten Beispiels.
    ANFANG.lastIndex = ende + 1;
  }
}
console.log(gefunden ? `${gefunden} Stelle(n)` : 'Keine Backticks in Vorlagen oder Stilen.');
process.exit(gefunden ? 1 : 0);
