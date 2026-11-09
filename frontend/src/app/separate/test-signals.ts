/**
 * Der Testpfad im Browser — dieselben Spuren wie `make_test_stems` im Backend.
 *
 * Dieser Pfad trennt nichts. Er legt drei fertige Spuren hin, damit sich das
 * Deck prüfen lässt, ohne 174 MB Modell zu laden und ohne auf eine
 * Grafikkarte angewiesen zu sein: zwei Klickspuren, deren Klicks auf genau
 * denselben Zeitpunkten liegen, und ein Dauerton.
 *
 * Zum Hören: laufen die Klickspuren synchron, hört man **einen** Klick.
 * Driften sie, hört man ein Flattern oder zwei getrennte Klicks. Die beiden
 * Spuren liegen auf 1000 und 2500 Hz und lassen sich deshalb auch im
 * fertigen Mix getrennt vermessen — genau das tut `tests/audio/`.
 *
 * Die Zahlen sind aus `backend/app/synthetic.py` übernommen und nicht neu
 * gewählt: beide Varianten sollen dieselben Spuren erzeugen, sonst wäre ein
 * Messwert aus dem einen Pfad im anderen nicht vergleichbar.
 */

export const TEST_SAMPLE_RATE = 44_100;
const CLICK_INTERVAL_S = 1.0;
export const TEST_DURATION_S = 30.0;

/** Klickfolge: kurze, scharf abfallende Bursts in festem Raster. */
function clickTrain(
  durationS: number,
  freqHz: number,
  intervalS = CLICK_INTERVAL_S,
  decayS = 0.004,
): Float32Array {
  const n = Math.trunc(durationS * TEST_SAMPLE_RATE);
  const out = new Float32Array(n);
  const burstN = Math.trunc(decayS * 4 * TEST_SAMPLE_RATE);
  const burst = new Float32Array(burstN);
  for (let i = 0; i < burstN; i++) {
    const t = i / TEST_SAMPLE_RATE;
    burst[i] = Math.sin(2 * Math.PI * freqHz * t) * Math.exp(-t / decayS);
  }
  const count = Math.trunc(durationS / intervalS) + 1;
  for (let k = 0; k < count; k++) {
    const start = Math.round(k * intervalS * TEST_SAMPLE_RATE);
    if (start >= n) break;
    const end = Math.min(start + burstN, n);
    for (let i = start; i < end; i++) out[i] += burst[i - start];
  }
  for (let i = 0; i < n; i++) {
    const v = out[i] * 0.8;
    out[i] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return out;
}

function sine(durationS: number, freqHz: number, amp = 0.25): Float32Array {
  const n = Math.trunc(durationS * TEST_SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / TEST_SAMPLE_RATE) * amp;
  }
  return out;
}

export interface TestStem {
  label: string;
  slug: string;
  channels: Float32Array[];
}

/**
 * Die drei Testspuren, in Stereo.
 *
 * Beide Kanäle tragen dasselbe Signal — wie im Backend. Zwei eigene Puffer
 * sind es trotzdem, denn das Deck übergibt sie an das Worklet und ein
 * geteilter Puffer wäre nach dem ersten Kanal leer.
 */
export function makeTestStems(durationS = TEST_DURATION_S): TestStem[] {
  const specs: readonly [string, string, Float32Array][] = [
    ['Click A (1000 Hz)', 'click-a', clickTrain(durationS, 1000)],
    ['Click B (2500 Hz)', 'click-b', clickTrain(durationS, 2500)],
    ['Sine 440 Hz', 'sine-440', sine(durationS, 440)],
  ];
  return specs.map(([label, slug, mono]) => ({
    label,
    slug,
    channels: [new Float32Array(mono), new Float32Array(mono)],
  }));
}
