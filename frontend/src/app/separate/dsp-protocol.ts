/**
 * Die Sprache zwischen den beiden Workern.
 *
 * Getrennt wird in zwei Fäden, weil sie sich sonst im Weg stehen: die
 * WebGPU-Laufzeit arbeitet über **Asyncify** — sie hält das WASM zwischen
 * den Kernen an, gibt die Kontrolle an die Javascript-Schleife zurück und
 * wird von dort fortgesetzt. Sie braucht den Faden also zwischendurch
 * immer wieder. Eine iSTFT ist dagegen eine geschlossene Schleife über
 * eine Viertelsekunde; solange sie läuft, kommt die Laufzeit nicht voran.
 *
 * Gemessen: auf einem Faden addieren sich beide schlicht (340 ms Warten
 * plus 582 ms Rechnen ergaben 1,17 s), und ein Umbau der Reihenfolge
 * brachte sechs Prozent. Auf zwei Fäden laufen sie wirklich nebeneinander.
 *
 * Geredet wird direkt über einen `MessageChannel`, nicht über den
 * Hauptfaden. Der hat mit einer Trennung nichts zu tun und soll auch je
 * Block nicht 55 MB weiterreichen müssen.
 */

import type { ModelShape } from './dsp';

/** Ein Block, so wie ihn die Karte zurückgibt. */
export interface DspBlock {
  type: 'block';
  offset: number;
  /** Wie viele Abtastwerte dieses Blocks wirklich zum Song gehören. */
  have: number;
  /** Mittelwert und Streuung, mit denen normiert wurde. */
  specMean: number;
  specStd: number;
  timeMean: number;
  timeStd: number;
  /** Frequenzzweig, `2*ch*sources * freqBins * frames`. Wird übergeben. */
  xOut: Float32Array;
  /** Zeitzweig, `ch*sources * segment`. Wird übergeben. */
  xtOut: Float32Array;
}

export type ToDsp =
  | { type: 'begin'; shape: ModelShape; samples: number }
  | DspBlock
  | { type: 'end' }
  | { type: 'abort' };

export type FromDsp =
  | {
      /**
       * Ein Block ist zurückgerechnet.
       *
       * Die Gegenseite zählt daran mit, wie viele Blöcke noch unterwegs
       * sind. Ohne diese Bremse liefe die Karte davon und jeder Block in
       * der Warteschlange hielte 55 MB fest.
       */
      type: 'ack';
      offset: number;
    }
  | {
      type: 'stems';
      /** Spuren in der Reihenfolge des Modells, je Spur ein Array pro Kanal. */
      stems: Float32Array[][];
      /** Reine Rechenzeit der Rücktransformation, über alle Blöcke. */
      inverseDspMs: number;
    }
  | { type: 'failed'; message: string };
