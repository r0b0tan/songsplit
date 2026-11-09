/**
 * Das Vergleichssignal, das Python und Browser gleich erzeugen.
 *
 * Gegenstück zu `test_signal` in `backend/tools/demucs_reference.py`. Es
 * steht hier und nicht im Testordner, weil beide es brauchen: die Prüfung
 * der Signalverarbeitung in Node und die Messung im Browser. Wären es zwei
 * Fassungen, verglichen sie irgendwann zwei verschiedene Signale und
 * niemand wüsste, welche recht hat.
 *
 * Warum nicht einfach eine Datei mitliefern: drei Megabyte Rauschen im Repo,
 * nur um einen Vergleich anstoßen zu können. Xorshift32 besteht dagegen aus
 * drei Schiebeoperationen auf 32 Bit, und die sind in Javascript und in
 * Python Bit für Bit gleich definiert.
 */

/** Rauschen zwischen −1 und 1, aus einem 32-Bit-Zustand. */
export function xorshift32(seed: number, count: number): Float64Array {
  let x = seed >>> 0;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = (x / 4294967296) * 2 - 1;
  }
  return out;
}

/**
 * Zwei Töne auf verschiedenen Frequenzen, Rauschen darunter, ein harter
 * Einsatz bei einem Drittel.
 *
 * Jeder Teil hat seinen Zweck: der Ton zeigt eine falsche Normierung, das
 * Rauschen deckt das ganze Spektrum ab, und der Einsatz macht einen Versatz
 * um einzelne Abtastwerte sichtbar — ein um einen halben Block verschobenes
 * Ergebnis fällt sonst in keiner Kennzahl auf.
 */
export function makeReferenceSignal(
  samples: number,
  sampleRate: number,
): Float32Array[] {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  const nl = xorshift32(12345, samples);
  const nr = xorshift32(67890, samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    left[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.05 * nl[i];
    right[i] = 0.3 * Math.sin(2 * Math.PI * 330 * t + 0.7) + 0.05 * nr[i];
  }
  const at = Math.trunc(samples / 3);
  for (let i = at; i < at + 64; i++) {
    left[i] += 0.9;
    right[i] -= 0.9;
  }
  return [left, right];
}
