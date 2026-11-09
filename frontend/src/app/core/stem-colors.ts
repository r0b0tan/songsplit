/**
 * Eine Farbe je Spur.
 *
 * Die Farbe haengt am Slug, nicht an der Reihenfolge: Gesang ist in jedem
 * Job und in jedem Modell dasselbe Violett. Wer zwei Jobs nebeneinander
 * vergleicht, erkennt die Spuren an der Farbe wieder.
 *
 * Jeder Wert ist ein light-dark()-Paar. Die helle Variante ist abgedunkelt,
 * damit sie auf heller Flaeche traegt; die dunkle ist aufgehellt. Beide
 * liegen bei aehnlicher Buntheit, sodass keine Spur im Deck vorlaut wirkt.
 */
const BY_SLUG: Record<string, string> = {
  vocals: 'light-dark(#7a4f9c, #bb9ddd)',
  drums: 'light-dark(#a9514f, #e59690)',
  bass: 'light-dark(#2d7265, #7fc0ae)',
  guitar: 'light-dark(#3a5da4, #96b0f2)',
  piano: 'light-dark(#8a6224, #d4ab74)',
  other: 'light-dark(#625e74, #a7a2b6)',
  instrumental: 'light-dark(#2f6a86, #8dc0d8)',
};

/** Fuer alles ohne festen Platz, etwa die Spuren des Testpfads. */
const CYCLE: readonly string[] = [
  'light-dark(#2d7265, #7fc0ae)',
  'light-dark(#a9514f, #e59690)',
  'light-dark(#8a6224, #d4ab74)',
  'light-dark(#3a5da4, #96b0f2)',
  'light-dark(#7a4f9c, #bb9ddd)',
  'light-dark(#625e74, #a7a2b6)',
];

/**
 * Woerter, die dieselbe Spur meinen. Noetig, weil der Slug aus dem
 * Dateinamen stammen kann, wenn das Modell eine Spur liefert, die das
 * Backend nicht kennt: dann heisst sie "…-(Bass)-htdemucs-6s".
 */
const ALIASES: Record<string, string> = {
  gesang: 'vocals',
  vocal: 'vocals',
  vocals: 'vocals',
  drums: 'drums',
  schlagzeug: 'drums',
  bass: 'bass',
  guitar: 'guitar',
  gitarre: 'guitar',
  piano: 'piano',
  klavier: 'piano',
  other: 'other',
  rest: 'other',
  instrumental: 'instrumental',
  begleitung: 'instrumental',
};

export function stemColor(slug: string, index: number, name = ''): string {
  const direct = BY_SLUG[slug];
  if (direct) return direct;
  // Sonst im Namen nach einem bekannten Wort suchen, damit dieselbe Spur
  // auch bei ungewoehnlicher Benennung dieselbe Farbe behaelt.
  for (const word of `${slug} ${name}`.toLowerCase().split(/[^a-zäöüß]+/)) {
    const key = ALIASES[word];
    if (key) return BY_SLUG[key]!;
  }
  return CYCLE[index % CYCLE.length]!;
}
