/**
 * Kurzer Anzeigename einer Spur.
 *
 * Fuer bekannte Spuren liefert das Backend schon „Gesang" oder „Drums".
 * Erkennt es eine Spur nicht, faellt es auf den Dateinamen zurueck, und
 * der sieht so aus:
 *
 *     Yeah Yeah Yeahs - Heads Will Roll (Official Music Video)_(Bass)_htdemucs_6s
 *
 * In der Spurleiste des Decks ist davon nichts zu lesen — alle sechs Spuren
 * sehen gleich aus. `audio-separator` schreibt die Spur in Klammern an das
 * Ende, deshalb traegt die **letzte** Klammergruppe den Namen; frueher
 * stehende Klammern gehoeren zum Songtitel. Der vollstaendige Name bleibt
 * im Tooltip und im Dateinamen des Downloads erhalten.
 */
const PARENTHESISED = /\(([^()]{1,24})\)(?!.*\([^()]{1,24}\))/;

export function shortStemName(name: string): string {
  if (name.length <= 24) return name;
  const match = PARENTHESISED.exec(name);
  const inner = match?.[1]?.trim();
  return inner ? inner : name;
}
