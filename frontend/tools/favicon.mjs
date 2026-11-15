/**
 * Rechnet favicon.ico und apple-touch-icon.png aus public/mixapart.svg.
 *
 *     node tools/favicon.mjs
 *
 * Die SVG ist die einzige Quelle: wer das Zeichen aendert, aendert sie und
 * laesst dieses Skript noch einmal laufen. Gezeichnet wird vom selben
 * Chromium, das auch die Tests fahren -- eine eigene Rasterbibliothek
 * braucht es dafuer nicht, Playwright liegt ohnehin als
 * Entwicklungsabhaengigkeit hier.
 *
 * Die .ico traegt drei Stufen (16, 32, 48) als PNG. Das verstehen alle
 * Browser, die heute noch eine .ico lesen, und erspart den Umweg ueber das
 * alte BMP-Format samt seiner Maske.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const SOURCE = path.join(PUBLIC, 'mixapart.svg');

/** Die Stufen in der .ico. Mehr Stufen heisst: der Browser waehlt, statt
    eine grosse herunterzurechnen. */
const ICO_SIZES = [16, 32, 48];
/** Was iOS auf den Startbildschirm legt. */
const TOUCH_SIZE = 180;

/** Das Zeichen in `size` Pixeln Kantenlaenge, als PNG. */
async function render(page, svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0">${svg
      .replace(/width="[^"]*"/, `width="${size}"`)
      .replace(/height="[^"]*"/, `height="${size}"`)}</body>`,
  );
  return page.screenshot({ omitBackground: true });
}

/**
 * Baut eine .ico aus fertigen PNG-Stufen.
 *
 * Kopf: zwei Nullbytes, Typ 1 (Zeichen), Anzahl. Danach je Stufe ein
 * Eintrag von sechzehn Byte -- Kantenlaengen, Farbebenen, Bittiefe, Laenge
 * und Versatz --, dann die Bilder selbst.
 */
function buildIco(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt8(0, at + 2); // Farben in der Palette: keine
    head.writeUInt8(0, at + 3); // reserviert
    head.writeUInt16LE(1, at + 4); // Farbebenen
    head.writeUInt16LE(32, at + 6); // Bit je Punkt
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

const svg = fs.readFileSync(SOURCE, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

const steps = [];
for (const size of ICO_SIZES) steps.push({ size, png: await render(page, svg, size) });
fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'), buildIco(steps));
fs.writeFileSync(path.join(PUBLIC, 'apple-touch-icon.png'), await render(page, svg, TOUCH_SIZE));

await browser.close();
console.log(
  `geschrieben aus ${path.relative(process.cwd(), SOURCE)}: ` +
    `favicon.ico (${ICO_SIZES.join(', ')}), apple-touch-icon.png (${TOUCH_SIZE})`,
);
