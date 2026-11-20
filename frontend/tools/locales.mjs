/**
 * Schreibt die Seite in zwei Sprachen: `de/index.html` und `en/index.html`.
 *
 *   node tools/locales.mjs dist/mixapart/browser
 *
 * Laeuft nach `inline-css.mjs`, also auf der fertigen Datei.
 *
 * **Warum zwei Dateien und nicht eine mit Umschalter.** Der Umschalter in
 * der Kopfleiste wechselt die Oberflaeche sofort, aber er wechselt nichts
 * an dem, was eine Suchmaschine zuerst holt: Titel, Beschreibung, `og`,
 * JSON-LD. Die stehen im Kopf der ausgelieferten Datei, und eine Seite hat
 * genau einen Kopf. Wer in zwei Sprachen gefunden werden will, braucht
 * zwei Adressen, die aufeinander zeigen (`hreflang`) — das ist der
 * Mechanismus, den es dafuer gibt, und er laesst sich auf einer Adresse
 * nicht nachbilden.
 *
 * **Warum die Texte hier stehen und nicht im Woerterbuch der Anwendung.**
 * Sie haben ein anderes Publikum. `de.ts` und `en.ts` schreiben fuer den
 * Menschen vor dem Schirm; was hier steht, liest eine Suchmaschine und
 * jemand, der einen Link irgendwo einfuegt. Es ueberschneidet sich auch
 * nicht: kein Titel, keine Beschreibung und kein `og`-Feld kommt in der
 * Oberflaeche vor.
 *
 * **Jede Ersetzung ist Pflicht.** Greift eine ins Leere — weil jemand die
 * `index.html` umgebaut hat —, bricht der Bau ab. Der Fehler, der sonst
 * entstuende, ist der unangenehmste seiner Art: eine englische Seite mit
 * deutschem Titel, die monatelang niemandem auffaellt, weil sie im Browser
 * richtig aussieht.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WURZEL = process.argv[2];
if (!WURZEL) {
  console.error('locales: Verzeichnis fehlt.\n  node tools/locales.mjs dist/<bau>/browser');
  process.exit(2);
}

const BASIS = 'https://mixapart.de';

/** Was je Sprache im Kopf steht. */
const SEO = {
  de: {
    lang: 'de',
    locale: 'de_DE',
    pfad: '/de/',
    bild: '/mixapart-share-ger.webp',
    title: 'MixApart — Songs in Einzelspuren trennen',
    description:
      'MixApart trennt Songs in Gesang, Drums, Bass und Instrumente — im ' +
      'Browser, ohne Upload. Ein Produkt von CLICKIT DIGITAL.',
    share:
      'Gesang, Drums, Bass und Instrumente getrennt — im Browser, ohne ' +
      'Upload. Ein Produkt von CLICKIT DIGITAL.',
    schema:
      'MixApart trennt Songs in Gesang, Drums, Bass und Instrumente — im ' +
      'Browser, ohne Upload.',
  },
  en: {
    lang: 'en',
    locale: 'en_US',
    pfad: '/en/',
    bild: '/mixapart-share-en.webp',
    title: 'MixApart — split songs into separate stems',
    description:
      'MixApart splits songs into vocals, drums, bass and instruments — in ' +
      'your browser, without uploading. A product by CLICKIT DIGITAL.',
    share:
      'Vocals, drums, bass and instruments separated — in your browser, ' +
      'without uploading. A product by CLICKIT DIGITAL.',
    schema:
      'MixApart splits songs into vocals, drums, bass and instruments — in ' +
      'your browser, without uploading.',
  },
};

/**
 * Die Verweise aufeinander, plus `x-default` auf die Wurzel.
 *
 * `/` leitet nach der Spracheinstellung des Browsers weiter und ist damit
 * genau das, was `x-default` meint: die Adresse fuer alle, fuer die keine
 * der benannten Sprachen die richtige ist.
 */
const HREFLANG = [
  `<link rel="alternate" hreflang="de" href="${BASIS}/de/" />`,
  `<link rel="alternate" hreflang="en" href="${BASIS}/en/" />`,
  `<link rel="alternate" hreflang="x-default" href="${BASIS}/" />`,
].join('\n    ');

/**
 * Die Ersetzungen. Jede nennt, wie oft sie greifen muss.
 *
 * Die Zahl ist der Punkt: `replace` ohne Kontrolle ist eine Zusicherung,
 * die niemand prueft. So faellt eine umgebaute `index.html` beim Bauen auf.
 */
// `\s*\/?>` am Ende jeder Regel, und das ist kein Schlamp: `ng build`
// schreibt `content="x"/>` ohne Leerzeichen, die Quelle `content="x" />`
// mit. Ein Muster, das nur eine der beiden Formen kennt, greift je nach
// Bauschritt — und meldet dann einen Fehler, der keiner ist.
const REGELN = [
  ['lang-Attribut', /<html lang="[^"]*">/g, 1, (s) => `<html lang="${s.lang}">`],
  ['Titel', /<title>[^<]*<\/title>/g, 1, (s) => `<title>${s.title}</title>`],
  [
    'Beschreibung',
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta name="description" content="${s.description}" />`,
  ],
  [
    'canonical',
    /<link rel="canonical" href="[^"]*"\s*\/?>/g,
    1,
    (s) => `<link rel="canonical" href="${BASIS}${s.pfad}" />\n    ${HREFLANG}`,
  ],
  [
    'og:locale',
    /<meta property="og:locale" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta property="og:locale" content="${s.locale}" />`,
  ],
  [
    'og:url',
    /<meta property="og:url" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta property="og:url" content="${BASIS}${s.pfad}" />`,
  ],
  [
    'og:title',
    /<meta property="og:title" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta property="og:title" content="${s.title}" />`,
  ],
  [
    'og:description',
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta property="og:description" content="${s.share}" />`,
  ],
  [
    'og:image',
    /<meta property="og:image" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta property="og:image" content="${BASIS}${s.bild}" />`,
  ],
  [
    'twitter:image',
    /<meta name="twitter:image" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta name="twitter:image" content="${BASIS}${s.bild}" />`,
  ],
  [
    // Im JSON-LD steht dasselbe Bild noch einmal.
    'ld:image',
    /"image": "[^"]*"/g,
    1,
    (s) => `"image": "${BASIS}${s.bild}"`,
  ],
  [
    'og:image:alt',
    /<meta property="og:image:alt" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta property="og:image:alt" content="${s.title}" />`,
  ],
  [
    'twitter:title',
    /<meta name="twitter:title" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta name="twitter:title" content="${s.title}" />`,
  ],
  [
    'twitter:description',
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta name="twitter:description" content="${s.share}" />`,
  ],
  [
    'twitter:image:alt',
    /<meta name="twitter:image:alt" content="[^"]*"\s*\/?>/g,
    1,
    (s) => `<meta name="twitter:image:alt" content="${s.title}" />`,
  ],
  // Im JSON-LD: drei Felder, jedes fuer sich.
  ['ld:url', /"url": "https:\/\/mixapart\.de\/"/g, 1, (s) => `"url": "${BASIS}${s.pfad}"`],
  ['ld:inLanguage', /"inLanguage": "[^"]*"/g, 1, (s) => `"inLanguage": "${s.lang}"`],
  [
    'ld:description',
    /"description": "[^"]*"/g,
    1,
    (s) => `"description": "${s.schema}"`,
  ],
];

/**
 * Macht die Verweise auf das Bundle absolut.
 *
 * `ng build` schreibt `src="main-ABC.js"` — relativ zur Datei. Unter
 * `/de/index.html` suchte der Browser damit `/de/main-ABC.js`, und das
 * gibt es nicht. Ein `<base href="/">` taete es auch, wirkte aber auf jede
 * relative Adresse der Anwendung; hier wird genau das angefasst, worum es
 * geht.
 */
function absolut(html) {
  let getroffen = 0;
  const out = html.replace(
    /\b(src|href)="(?!https?:|\/\/|\/|#|data:|mailto:)([^"]+)"/g,
    (_, attr, pfad) => {
      getroffen++;
      return `${attr}="/${pfad}"`;
    },
  );
  // Geprueft wird das Ergebnis, nicht die Arbeit: ob das Bundle hinterher
  // absolut dasteht. „Es wurde nichts umgeschrieben" waere kein Fehler,
  // sondern hiesse nur, dass es schon absolut stand — und genau so war es,
  // wenn dieser Schritt zweimal ueber dieselbe Ausgabe laeuft.
  if (!/<script\b[^>]*\bsrc="\/[^"]/.test(out)) {
    console.error(
      'locales: in der index.html steht kein absoluter Verweis auf das ' +
        'Bundle — stimmt der Bau noch?',
    );
    process.exit(1);
  }
  return { html: out, getroffen };
}

/**
 * Liegt das Bild, auf das der Kopf zeigt, auch wirklich da?
 *
 * Ein falscher Dateiname faellt im Betrieb nicht auf: die Seite sieht
 * richtig aus, und die Vorschau bleibt nur dort leer, wo jemand den Link
 * einfuegt — also genau da, wo man es selbst nie sieht. Deshalb hier,
 * beim Bauen, wo es auffaellt.
 */
for (const [lang, seo] of Object.entries(SEO)) {
  if (!existsSync(join(WURZEL, seo.bild))) {
    console.error(
      `locales: das Bild zum Teilen fehlt (${lang}): ${seo.bild}\n` +
        '  Erwartet unter ' + join(WURZEL, seo.bild),
    );
    process.exit(1);
  }
}

const quelle = join(WURZEL, 'index.html');
const roh = readFileSync(quelle, 'utf8');

/**
 * Einmal je Bau, und das laesst sich nicht umgehen.
 *
 * Der letzte Schritt schreibt die Wurzel-`index.html` neu — sie ist danach
 * die englische Seite und keine Vorlage mehr. Ein zweiter Lauf laese sie
 * als Vorlage und scheiterte an einer Regel, die nichts mehr findet, mit
 * einer Meldung ueber die `index.html`, die zwar stimmt, aber in die
 * falsche Richtung zeigt. Also wird der Fall benannt, statt ihn zu
 * erraten.
 */
if (roh.includes('rel="alternate" hreflang')) {
  console.error(
    'locales: diese index.html ist schon verarbeitet.\n' +
      '  Der Schritt gehoert auf eine frische Ausgabe von `ng build`.',
  );
  process.exit(1);
}
const { html: vorlage, getroffen } = absolut(roh);

for (const [lang, seo] of Object.entries(SEO)) {
  let html = vorlage;
  for (const [name, muster, soll, ersatz] of REGELN) {
    const treffer = html.match(muster)?.length ?? 0;
    if (treffer !== soll) {
      console.error(
        `locales: „${name}" ${treffer}× gefunden, ${soll}× erwartet (${lang}).\n` +
          '  Die index.html passt nicht mehr zu den Regeln in tools/locales.mjs.',
      );
      process.exit(1);
    }
    html = html.replace(muster, ersatz(seo));
  }
  mkdirSync(join(WURZEL, lang), { recursive: true });
  writeFileSync(join(WURZEL, lang, 'index.html'), html, 'utf8');
}

/**
 * Die Wurzel bleibt liegen, zeigt aber auf die englische Fassung.
 *
 * Erreicht wird sie im Betrieb nicht: `/` leitet nach der Spracheinstellung
 * des Browsers weiter. Wer `/index.html` direkt aufruft oder eine alte
 * Verknuepfung hat, soll trotzdem etwas Sinnvolles bekommen — und das
 * `canonical` sagt der Suchmaschine, wohin die Seite wirklich gehoert.
 */
const wurzel = readFileSync(join(WURZEL, 'en', 'index.html'), 'utf8').replace(
  `<link rel="canonical" href="${BASIS}/en/" />`,
  `<link rel="canonical" href="${BASIS}/en/" />`,
);
writeFileSync(quelle, wurzel, 'utf8');

console.log(
  `locales: de/ und en/ geschrieben (${getroffen} Verweise absolut gesetzt), ` +
    'die Wurzel zeigt auf /en/.',
);
