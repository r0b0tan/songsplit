/**
 * Warnt vor Backticks in Angular-Vorlagen und -Stilen.
 *
 *   node tools/check-literals.mjs
 *
 * `template: ` und `styles: [` sind Template-Literale. Ein Backtick im
 * Kommentar darin — etwa um einen Dateinamen hervorzuheben — beendet das
 * Literal mitten im Text. Der Compiler meldet das dann an ganz anderer
 * Stelle („Cannot find name 'select'", „Failed to resolve styles"), und
 * man sucht an der falschen Zeile.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function* dateien(ordner) {
  for (const e of await readdir(ordner, { withFileTypes: true })) {
    const pfad = join(ordner, e.name);
    if (e.isDirectory()) yield* dateien(pfad);
    else if (e.name.endsWith('.ts')) yield pfad;
  }
}

let gefunden = 0;
for await (const pfad of dateien('src')) {
  const text = await readFile(pfad, 'utf8');
  for (const marke of ['  template: `', '  styles: [\n    `']) {
    let i = text.indexOf(marke);
    if (i < 0) continue;
    const start = text.indexOf('`', i) + 1;
    const ende = text.indexOf('`', start);
    const zeile = text.slice(0, start).split('\n').length;
    // Alles zwischen Anfang und erstem Backtick ist der Inhalt. Steht der
    // schliessende Backtick nicht am erwarteten Ende, liegt einer drin.
    const rest = text.slice(ende + 1, ende + 40).trim();
    if (!rest.startsWith(',') && !rest.startsWith(']')) {
      console.error(
        `${pfad}:${text.slice(0, ende).split('\n').length} — Backtick im ` +
          `${marke.includes('template') ? 'Template' : 'Stil'}, ab Zeile ${zeile}`,
      );
      gefunden++;
    }
  }
}
console.log(gefunden ? `${gefunden} Stelle(n)` : 'Keine Backticks in Vorlagen oder Stilen.');
process.exit(gefunden ? 1 : 0);
