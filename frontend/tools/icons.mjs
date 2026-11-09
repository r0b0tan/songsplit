/**
 * Schreibt src/app/core/icons.ts aus dem Paket `lucide-static`.
 *
 *   node tools/icons.mjs
 *
 * Warum erzeugt und nicht zur Laufzeit geladen: gebraucht werden gut zwei
 * Dutzend Zeichen, das Paket bringt über zweitausend mit. Die erzeugte
 * Datei ist winzig, kommt ins Repository und braucht zur Laufzeit nichts
 * — `lucide-static` bleibt eine reine Entwicklungsabhängigkeit.
 *
 * Wer ein Zeichen braucht, trägt es unten in WANTED ein und lässt das
 * Skript laufen. Namen stehen auf lucide.dev.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Jedes Zeichen mit dem Ort, an dem es steht — damit niemand rät. */
const WANTED = {
  play: 'Transport: abspielen',
  pause: 'Transport: pausieren',
  'skip-back': 'Transport: an den Anfang',
  rewind: 'Transport: fünf Sekunden zurück',
  'fast-forward': 'Transport: fünf Sekunden vor',
  repeat: 'Transport: A–B-Loop an oder aus',
  'volume-2': 'Spur: klingt',
  'volume-x': 'Spur: stumm',
  headphones: 'Spur: solo',
  plus: 'Tonhöhe einen Halbton höher',
  minus: 'Tonhöhe einen Halbton tiefer',
  'arrow-down-to-line': 'Loop-Marke auf die aktuelle Stelle setzen',
  x: 'schließen, aufheben, löschen',
  info: 'Hinweis, der im Titel steht',
  download: 'Spur als WAV speichern',
  trash: 'Job löschen',
  'chevron-left': 'Jobliste: eine Seite zurück',
  'chevron-right': 'Jobliste: eine Seite vor',
  'square-arrow-out-up-right': 'Verlauf: Job im Deck öffnen',
  ellipsis: 'Verlauf: weitere Aktionen zu einem Job',
  clock: 'Verlauf: Job wartet oder laeuft',
  'audio-lines': 'Job im Deck öffnen',
};

/** Formen, die die Icon-Komponente zeichnen kann. */
const DRAWABLE = new Set(['path', 'circle', 'rect']);

const nodes = JSON.parse(
  await readFile(join(root, 'node_modules/lucide-static/icon-nodes.json'), 'utf8'),
);
const { version } = JSON.parse(
  await readFile(join(root, 'node_modules/lucide-static/package.json'), 'utf8'),
);

const lines = [];
for (const [name, where] of Object.entries(WANTED)) {
  const shapes = nodes[name];
  if (!shapes) throw new Error(`lucide kennt "${name}" nicht`);
  for (const [tag] of shapes) {
    if (!DRAWABLE.has(tag)) {
      throw new Error(
        `"${name}" braucht <${tag}>, und das zeichnet icon.ts nicht. ` +
          `Entweder dort ergänzen oder ein anderes Zeichen nehmen.`,
      );
    }
  }
  const body = shapes
    .map(([tag, attrs]) => `    ['${tag}', ${JSON.stringify(attrs)}],`)
    .join('\n');
  lines.push(`  // ${where}\n  '${name}': [\n${body}\n  ],`);
}

const out = `/**
 * Zeichen aus Lucide ${version} (ISC), erzeugt von tools/icons.mjs.
 * Nicht von Hand ändern — Zeichen dort eintragen und neu erzeugen.
 *
 * ISC License · Copyright (c) for portions of Lucide are held by Cole
 * Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for
 * Lucide are held by Lucide Contributors 2022.
 * https://lucide.dev · https://github.com/lucide-icons/lucide/blob/main/LICENSE
 */

/** Eine Form: Name des SVG-Elements und seine Attribute. */
export type IconShape = readonly [string, Readonly<Record<string, string>>];

export const ICONS = {
${lines.join('\n')}
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICONS;
`;

await writeFile(join(root, 'src/app/core/icons.ts'), out);
console.log(`geschrieben: src/app/core/icons.ts — ${Object.keys(WANTED).length} Zeichen aus Lucide ${version}`);
