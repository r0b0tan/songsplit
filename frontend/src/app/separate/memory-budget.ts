/**
 * Reicht der Arbeitsspeicher fuer diesen Song?
 *
 * Getrennt wird im Arbeitsspeicher der Sitzung — nichts liegt auf einer
 * Platte, weder hier noch auf einem Server. Das ist die Zusage der
 * oeffentlichen Variante, und sie hat einen Preis: die Laenge des Liedes
 * ist eine Systemgrenze. Bis hierher ist sie nie aufgefallen, weil auf dem
 * Rechner des Entwicklers genug da war. Auf einem oeffentlichen Server
 * trifft sie den Ersten, der ein langes Livestueck auf dem Handy einwirft
 * — und zwar als sterbender Tab ohne Meldung.
 *
 * Deshalb wird vorher gerechnet. Die Zahlen sind eine Abschaetzung, keine
 * Messung: wie viel ein Tab wirklich bekommt, sagt kein Browser. Was sie
 * leisten soll, ist die Unterscheidung zwischen „geht", „kann knapp
 * werden" und „wird nichts" — und im letzten Fall eine ehrliche Zeile
 * statt eines Versuchs.
 */

/**
 * Was eine Sekunde einer Spur belegt: 44 100 Hz, zwei Kanaele, Float32.
 *
 * 352 800 Byte, also rund 21 MB je Minute und Spur. Vier Spuren eines
 * Liedes von 4:33 sind damit 367 MiB — dieselbe Zahl, die unter
 * „Minimum" im README steht.
 */
const BYTES_PER_SECOND = 44100 * 2 * 4;

const MIB = 1024 * 1024;

/**
 * Was neben dem Ton noch belegt ist, in MiB.
 *
 * Die Gewichte kommen als 174 MB zusammengesetzt an und liegen waehrend
 * des Anlegens der Sitzung ein zweites Mal in der Runtime. Dazu der
 * Arbeitsbereich der Blockschleife. 400 MiB ist dafuer grosszuegig
 * gerechnet, und grosszuegig ist hier die richtige Richtung: wer knapp
 * rechnet, verspricht einen Lauf, den das Geraet nicht halten kann.
 */
const MODEL_RESERVE_MIB = 400;

/**
 * Wie viel von dem, was das Geraet meldet, ein Tab ausreizen darf.
 *
 * Nicht alles: daneben liegen das Betriebssystem, die anderen Tabs und
 * der Browser selbst. Unter Druck wirft ein mobiler Browser den dicksten
 * Tab zuerst weg, und das waere genau dieser.
 */
const SHARE_OF_DEVICE = 0.6;

/**
 * Was angenommen wird, wenn das Geraet nichts sagt.
 *
 * `navigator.deviceMemory` gibt es nur in Chrome und Edge; Firefox und
 * Safari schweigen. Dort auf das Schlimmste zu tippen hiesse, jedem
 * Firefox-Benutzer lange Lieder zu verbieten, ohne einen Grund zu haben.
 * Angenommen werden deshalb 4 GB — ein Mittelklassegeraet.
 */
const ASSUMED_DEVICE_GB = 4;

/**
 * Ab wann ein kuerzerer Ausschnitt noch ein Rat ist, in Sekunden.
 *
 * Liegt die machbare Laenge darunter, ist nicht der Song zu lang, sondern
 * das Geraet zu klein: allein die Gewichte belegen 400 MB, und daran
 * aendert kein Zuschneiden etwas. „Bis etwa 0:00 geht es hier" waere
 * formal richtig und als Satz unbrauchbar.
 */
export const SHORTEST_WORTH_SUGGESTING_S = 30;

export type Verdict = 'reicht' | 'eng' | 'aussichtslos';

export interface Assessment {
  verdict: Verdict;
  /** Was der Lauf an Ton belegt, in MiB. Ohne Modell. */
  audioMib: number;
  /** Was mit Modell insgesamt gebraucht wird, in MiB. */
  neededMib: number;
  /** Was dem Tab zugetraut wird, in MiB. */
  budgetMib: number;
  /** Meldete das Geraet seinen Speicher, oder ist es eine Annahme? */
  measured: boolean;
  /** Laengster Song, der hier noch durchginge, in Sekunden. */
  fitsSeconds: number;
}

interface MemoryNavigator {
  deviceMemory?: number;
}

/** Was das Geraet meldet, in GB — oder die Annahme. */
export function deviceMemoryGb(): { gb: number; measured: boolean } {
  const reported = (globalThis.navigator as MemoryNavigator | undefined)?.deviceMemory;
  if (typeof reported === 'number' && reported > 0) {
    return { gb: reported, measured: true };
  }
  return { gb: ASSUMED_DEVICE_GB, measured: false };
}

/**
 * Was der Lauf an Ton belegt, in MiB.
 *
 * `stems + 1`, weil neben den Ausgabespuren die dekodierte Eingabe liegt:
 * sie wird dem Worker uebergeben, nicht geteilt, aber sie ist da, bis der
 * letzte Block gerechnet ist.
 */
export function audioMib(durationSeconds: number, stems: number): number {
  return ((stems + 1) * durationSeconds * BYTES_PER_SECOND) / MIB;
}

/**
 * Spuren zaehlen heisst: die des **Modells**, nicht die der Anzeige.
 *
 * Bei „Minimum" stehen am Ende zwei Spuren, aber waehrend des Laufs sind
 * es vier — zusammengefasst wird erst, wenn alle da sind (`foldStems` in
 * `device-separator.ts`). Die Spitze ist, was das Geraet aushalten muss,
 * nicht das Ergebnis.
 */
export function assess(durationSeconds: number, modelStems: number): Assessment {
  const { gb, measured } = deviceMemoryGb();
  const budgetMib = gb * 1024 * SHARE_OF_DEVICE;
  const audio = audioMib(durationSeconds, modelStems);
  const needed = audio + MODEL_RESERVE_MIB;

  const fuerTon = Math.max(0, budgetMib - MODEL_RESERVE_MIB);
  const fitsSeconds = (fuerTon * MIB) / ((modelStems + 1) * BYTES_PER_SECOND);

  // „Eng" beginnt deutlich vor der Grenze: die Abschaetzung kennt weder
  // die anderen Tabs noch den Browser. Wer bei 60 % des Zugetrauten
  // gewarnt wird, kann noch entscheiden; wer bei 100 % gewarnt wird,
  // erfaehrt es beim Absturz.
  let verdict: Verdict = 'reicht';
  if (needed > budgetMib) verdict = 'aussichtslos';
  else if (needed > budgetMib * 0.6) verdict = 'eng';

  return { verdict, audioMib: audio, neededMib: needed, budgetMib, measured, fitsSeconds };
}

/** „4:33" aus 273 Sekunden. Fuer die Meldungen. */
export function asMinutes(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
