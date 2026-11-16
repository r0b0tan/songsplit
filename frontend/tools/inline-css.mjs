/**
 * Setzt das gebaute Stylesheet als <style> in die index.html.
 *
 *     node tools/inline-css.mjs [dist/mixapart-public/browser]
 *
 * Laeuft am Ende von `npm run build:public` und `npm run build`.
 *
 * Warum ueberhaupt: das `<link rel="stylesheet">` haelt das erste Rendering
 * auf. Der Browser hat die index.html, sieht den Verweis, und bevor er
 * irgendetwas zeichnet, holt er die Datei -- eine zweite Rundreise ueber
 * eine Leitung, die auf dem Handy langsam ist. Lighthouse hat dafuer
 * 150 ms gemessen, bei 2,1 KiB uebertragener Groesse. Die Datei ist also
 * kleiner als die Verzoegerung, die sie kostet; sie gehoert in die Seite.
 *
 * Warum nicht Angulars `inlineCritical`: der Inliner setzt nur den
 * kritischen Teil ein und laedt den Rest mit einem **Inline-Skript** nach.
 * Dafuer braeuchte `script-src` in der CSP `'unsafe-inline'` -- genau das,
 * was nginx-security-headers.conf nicht gibt und nicht geben soll. Deshalb
 * steht die Option in angular.json auf `false` und dieses Skript hier.
 * Inline-*Styles* sind dagegen erlaubt (`style-src ... 'unsafe-inline'`),
 * und zwar ohnehin: Angular haengt die Styles jeder Komponente als
 * <style>-Block in die Seite. Es kommt hier also kein Recht dazu, das die
 * Seite nicht schon brauchte.
 *
 * Das Stylesheet bleibt klein genug, dass das aufgeht -- ein paar Kilobyte.
 * Waechst es einmal auf das Zehnfache, ist der Tausch keiner mehr: dann
 * traegt jede Seitenansicht das ganze CSS unkomprimierbar im HTML. Deshalb
 * die Grenze unten, die den Build anhaelt, statt stillschweigend eine
 * schlechtere Seite auszuliefern.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** Ab hier lohnt das Einsetzen nicht mehr. */
const MAX_BYTES = 40 * 1024;

const dir = path.resolve(ROOT, process.argv[2] ?? 'dist/mixapart-public/browser');
const indexFile = path.join(dir, 'index.html');

if (!fs.existsSync(indexFile)) {
  console.error(`inline-css: ${indexFile} gibt es nicht — erst bauen.`);
  process.exit(1);
}

const html = fs.readFileSync(indexFile, 'utf8');

// Nur das vom Build erzeugte, hash-benannte Stylesheet. Ein fremder Verweis
// -- eine Schrift, ein Stylesheet aus public/ -- bleibt stehen.
const link = /<link rel="stylesheet" href="(styles-[A-Z0-9]+\.css)">/i;
const found = html.match(link);

if (!found) {
  // Kein Fehler: wer das Skript zweimal laufen laesst, soll keinen roten
  // Build bekommen. Beim ersten Mal hat es gewirkt, beim zweiten ist nichts
  // mehr zu tun.
  const schon = html.includes('<style>');
  console.log(
    schon
      ? 'inline-css: steht schon in der Seite, nichts zu tun.'
      : 'inline-css: kein gebautes Stylesheet im <head> gefunden, nichts zu tun.',
  );
  process.exit(0);
}

const cssFile = path.join(dir, found[1]);
const css = fs.readFileSync(cssFile, 'utf8');

if (css.length > MAX_BYTES) {
  console.error(
    `inline-css: ${found[1]} ist ${Math.round(css.length / 1024)} KiB und damit ` +
      `groesser als die Grenze von ${MAX_BYTES / 1024} KiB. So viel CSS gehoert ` +
      'in eine eigene, cachebare Datei und nicht in jede Seitenansicht. ' +
      'Entweder das Stylesheet kuerzen oder diesen Schritt bewusst entfernen.',
  );
  process.exit(1);
}

// `</style>` im CSS wuerde den Block vorzeitig schliessen. In diesem
// Stylesheet steht so etwas nicht, aber ein content: "</style>" waere
// gueltiges CSS -- und der Fehler faende sich erst in der ausgelieferten
// Seite wieder.
if (/<\/style/i.test(css)) {
  console.error('inline-css: das CSS enthaelt "</style" und laesst sich nicht einsetzen.');
  process.exit(1);
}

fs.writeFileSync(indexFile, html.replace(link, `<style>${css}</style>`), 'utf8');

// Die Datei geht mit: auf sie zeigt jetzt nichts mehr. Ihr Hash steht in
// keinem Cache, der noch gelesen wird -- eine aeltere index.html verweist
// auf einen aelteren Hash, nicht auf diesen.
fs.rmSync(cssFile, { force: true });

console.log(
  `inline-css: ${found[1]} (${(css.length / 1024).toFixed(1)} KiB) steht jetzt in der index.html.`,
);
