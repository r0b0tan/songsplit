/** Messwerkzeuge fuer die gerenderten Puffer. */

/**
 * Huellkurve der Energie bei einer Frequenz (Goertzel ueber ein Schiebefenster).
 * Damit lassen sich die beiden Klickspuren im Mix auseinanderhalten:
 * eine klickt bei 1000 Hz, die andere bei 2500 Hz.
 */
export function bandEnvelope(
  x: Float32Array,
  sampleRate: number,
  freq: number,
  windowN = 128,
  hop = 16,
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor((x.length - windowN) / hop) + 1));
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w);
  const coeff = 2 * cos;
  for (let k = 0; k < out.length; k++) {
    const start = k * hop;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < windowN; i++) {
      const s0 = x[start + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    out[k] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
  }
  return out;
}

/** Normiert auf Spitzenwert 1. */
export function normalize(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak <= 0) return x;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] / peak;
  return out;
}

/**
 * Verschiebung zwischen zwei Huellkurven ueber Kreuzkorrelation.
 * Rueckgabe in Huellkurven-Schritten. 0 = deckungsgleich.
 */
export function bestLag(a: Float32Array, b: Float32Array, maxLag: number): { lag: number; score: number } {
  let bestLagValue = 0;
  let best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      sum += a[i] * b[j];
      count++;
    }
    if (count === 0) continue;
    const score = sum / count;
    if (score > best) {
      best = score;
      bestLagValue = lag;
    }
  }
  return { lag: bestLagValue, score: best };
}

/** Zeitpunkte der Klicks: lokale Maxima der Huellkurve ueber einer Schwelle. */
export function onsets(env: Float32Array, hop: number, sampleRate: number, threshold = 0.35): number[] {
  const peak = Math.max(...env);
  const limit = peak * threshold;
  const found: number[] = [];
  let lastIndex = -Infinity;
  const minGap = Math.round((0.2 * sampleRate) / hop);
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < limit) continue;
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    if (i - lastIndex < minGap) continue;
    found.push((i * hop) / sampleRate);
    lastIndex = i;
  }
  return found;
}

/**
 * Grundfrequenz ueber Nulldurchgaenge. Fuer einen reinen Sinus genau genug
 * und ohne FFT. Der Puffer sollte frei von Ein- und Ausschwingen sein.
 */
export function zeroCrossingFreq(x: Float32Array, sampleRate: number): number {
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      // Nulldurchgang zwischen i-1 und i linear interpolieren
      const frac = -x[i - 1] / (x[i] - x[i - 1]);
      const pos = i - 1 + frac;
      if (first < 0) first = pos;
      last = pos;
      crossings++;
    }
  }
  if (crossings < 2) return 0;
  const periods = crossings - 1;
  return (periods * sampleRate) / (last - first);
}

export function rms(x: Float32Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / Math.max(1, x.length));
}
