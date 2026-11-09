/**
 * Die Signalverarbeitung um das Modell herum — alles, was nicht im
 * ONNX-Graphen steht.
 *
 * Der Export aus `backend/tools/export_htdemucs_onnx.py` beginnt beim
 * normierten Spektrogramm und endet bei den rohen Ausgaben beider Zweige.
 * Davor und danach liegt die Kette hier: polstern, STFT, Real- und
 * Imaginaerteil als Kanaele, normieren — und zurueck: entnormieren,
 * maskieren, iSTFT, Zeitzweig addieren.
 *
 * Jeder Schritt hat ein Gegenstueck in `backend/tools/demucs_reference.py`,
 * und das wiederum ist gegen die Methoden des Modells selbst gemessen. Die
 * Pruefung `frontend/tests/separate/` vergleicht diese Datei gegen die
 * Kennzahlen, die das Python-Skript geschrieben hat. Wer hier etwas aendert,
 * laesst beide laufen: ein halber Block Versatz oder eine Fensterfunktion in
 * der symmetrischen statt der periodischen Variante faellt im Klang nur als
 * Dumpfheit auf, nicht als Fehler.
 */

/** Feste Groessen eines Exports, wie sie im `manifest.json` stehen. */
export interface ModelShape {
  /** Spuren in der Reihenfolge, die das Modell liefert. */
  sources: readonly string[];
  sampleRate: number;
  channels: number;
  /** Blocklaenge in Abtastwerten, hier 343980 (7,8 s). */
  segment: number;
  nfft: number;
  hopLength: number;
  freqBins: number;
  frames: number;
}

/**
 * `_spec` polstert um drei Achtel der Fensterlaenge. Dadurch ist die Zahl
 * der Zeitschritte genau die Eingabelaenge geteilt durch den Vorschub, und
 * Zeit- und Frequenzzweig lassen sich hinterher ohne Versatz addieren.
 */
export function specPad(shape: ModelShape): number {
  return (shape.hopLength >> 1) * 3;
}

export function specPadRight(shape: ModelShape): number {
  return specPad(shape) + shape.frames * shape.hopLength - shape.segment;
}

// --------------------------------------------------------------------- FFT

/**
 * Komplexe FFT zur Basis 2, an Ort und Stelle.
 *
 * Die Drehfaktoren und die Bitumkehr haengen nur an der Laenge und werden
 * einmal je Laenge berechnet: eine Trennung macht zehntausende Transformationen
 * derselben Groesse, und sie jedes Mal neu aufzubauen kostete mehr als die
 * Transformation selbst.
 */
class Fft {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(readonly n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT-Laenge muss eine Zweierpotenz sein, nicht ${n}`);
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** `inverse` dreht nur das Vorzeichen des Drehfaktors; skaliert wird nicht. */
  run(re: Float64Array, im: Float64Array, inverse = false): void {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = sign * sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/**
 * Transformation reeller Bloecke ueber eine halb so lange komplexe FFT.
 *
 * Ein reeller Block der Laenge N laesst sich als komplexer Block der Laenge
 * N/2 transformieren — gerade und ungerade Abtastwerte als Real- und
 * Imaginaerteil —, wenn man die beiden Haelften hinterher wieder auseinander
 * rechnet. Das halbiert die Arbeit, und die Arbeit ist hier der Grund, warum
 * die Trennung nicht allein an der Grafikkarte haengt: je Block kommen gut
 * dreitausend solche Transformationen zusammen.
 */
export class RealFft {
  private readonly fft: Fft;
  private readonly half: number;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly wr: Float64Array;
  private readonly wi: Float64Array;

  constructor(readonly n: number) {
    this.half = n >> 1;
    this.fft = new Fft(this.half);
    this.zr = new Float64Array(this.half);
    this.zi = new Float64Array(this.half);
    this.wr = new Float64Array(this.half);
    this.wi = new Float64Array(this.half);
    for (let k = 0; k < this.half; k++) {
      this.wr[k] = Math.cos((-2 * Math.PI * k) / n);
      this.wi[k] = Math.sin((-2 * Math.PI * k) / n);
    }
  }

  /**
   * `input` hat `n` Werte, `outRe`/`outIm` je `n/2 + 1`.
   * Ohne Normierung — die kommt in `stftFrames` dazu.
   */
  forward(
    input: Float64Array,
    outRe: Float64Array,
    outIm: Float64Array,
  ): void {
    const { half, zr, zi, wr, wi } = this;
    for (let k = 0; k < half; k++) {
      zr[k] = input[2 * k];
      zi[k] = input[2 * k + 1];
    }
    this.fft.run(zr, zi);

    for (let k = 0; k < half; k++) {
      const m = (half - k) % half;
      // Gerader und ungerader Anteil, aus Z[k] und dem Spiegelwert.
      const er = 0.5 * (zr[k] + zr[m]);
      const ei = 0.5 * (zi[k] - zi[m]);
      const or_ = 0.5 * (zi[k] + zi[m]);
      const oi = -0.5 * (zr[k] - zr[m]);
      outRe[k] = er + (or_ * wr[k] - oi * wi[k]);
      outIm[k] = ei + (or_ * wi[k] + oi * wr[k]);
    }
    // Die Nyquist-Frequenz folgt aus dem nullten Wert: W^(n/2) ist -1.
    outRe[half] = zr[0] - zi[0];
    outIm[half] = 0;
  }

  /**
   * Gegenstueck zu `forward`. `inRe`/`inIm` haben `n/2 + 1` Werte, `output`
   * hat `n`. Das Ergebnis ist durch `n` geteilt, wie `irfft` in numpy.
   */
  inverse(
    inRe: Float64Array,
    inIm: Float64Array,
    output: Float64Array,
  ): void {
    const { half, zr, zi, wr, wi } = this;
    for (let k = 0; k < half; k++) {
      // Die obere Haelfte des Spektrums ist der gespiegelte, konjugierte
      // Teil; fuer k = 0 ist das der reelle Nyquist-Wert.
      const ur = k === 0 ? inRe[half] : inRe[half - k];
      const ui = k === 0 ? inIm[half] : -inIm[half - k];
      const er = 0.5 * (inRe[k] + ur);
      const ei = 0.5 * (inIm[k] + ui);
      let or_ = 0.5 * (inRe[k] - ur);
      let oi = 0.5 * (inIm[k] - ui);
      // Mit dem konjugierten Drehfaktor zurueckdrehen.
      const tr = or_ * wr[k] + oi * wi[k];
      const ti = -or_ * wi[k] + oi * wr[k];
      or_ = tr;
      oi = ti;
      zr[k] = er - oi;
      zi[k] = ei + or_;
    }
    this.fft.run(zr, zi, true);
    // Die ruecktransformierte Reihe ist `n/2` lang, nicht `n`: geteilt wird
    // deshalb durch die halbe Laenge. Mit `1/n` kaeme alles halb so laut
    // heraus — und zwar nur hier, weshalb man es am Ende als zu leise
    // Spuren und nicht als Fehler merkte.
    const scale = 1 / half;
    for (let k = 0; k < half; k++) {
      output[2 * k] = zr[k] * scale;
      output[2 * k + 1] = zi[k] * scale;
    }
  }
}

// ------------------------------------------------------------------ Fenster

/**
 * Dasselbe Fenster wie `torch.hann_window(n)`: periodisch, geteilt durch `n`.
 *
 * Die symmetrische Variante (geteilt durch `n-1`) sieht fast gleich aus und
 * ist hier falsch — sie verletzt die Bedingung, unter der sich die
 * ueberlagerten Bloecke wieder zum Original summieren.
 */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// --------------------------------------------------------------- Spektrogramm

/** Spiegelndes Polstern, wie `mode="reflect"`. */
export function padReflect(
  input: Float64Array,
  left: number,
  right: number,
): Float64Array {
  const n = input.length;
  const out = new Float64Array(left + n + right);
  out.set(input, left);
  for (let i = 0; i < left; i++) out[left - 1 - i] = input[i + 1];
  for (let i = 0; i < right; i++) out[left + n + i] = input[n - 2 - i];
  return out;
}

/**
 * Hilfsgeraet fuer eine feste Blockgroesse. Alle Puffer haengen daran, damit
 * eine Trennung ueber viele Bloecke nicht laufend neu belegt: die
 * Zwischenergebnisse sind zweistellige Megabyte, und der Sammler haette
 * sonst alle sieben Sekunden Audio etwas zu tun.
 */
export class SpectrogramWorkspace {
  readonly window: Float64Array;
  private readonly rfft: RealFft;
  private readonly block: Float64Array;
  private readonly frameRe: Float64Array;
  private readonly frameIm: Float64Array;
  private readonly timeBlock: Float64Array;
  /** Zeitschritte, die `torch.stft` liefert, vor dem Zuschnitt. */
  readonly rawFrames: number;
  /** Laenge des gepolsterten Eingangs. */
  readonly paddedLength: number;

  constructor(readonly shape: ModelShape) {
    this.window = hannPeriodic(shape.nfft);
    this.rfft = new RealFft(shape.nfft);
    this.block = new Float64Array(shape.nfft);
    this.frameRe = new Float64Array(shape.nfft / 2 + 1);
    this.frameIm = new Float64Array(shape.nfft / 2 + 1);
    this.timeBlock = new Float64Array(shape.nfft);
    this.paddedLength = specPad(shape) + shape.segment + specPadRight(shape);
    // `center=true` polstert um ein halbes Fenster an beiden Enden, deshalb
    // genau ein Zeitschritt mehr als Laenge durch Vorschub.
    this.rawFrames = 1 + this.paddedLength / shape.hopLength;
  }

  /**
   * `_spec`: ein Kanal eines Blocks zum Spektrogramm.
   *
   * Schreibt in `outRe`/`outIm` je `freqBins * frames` Werte, Frequenz
   * aussen, Zeit innen — dieselbe Anordnung, die das Modell erwartet.
   */
  spec(
    input: Float64Array,
    outRe: Float32Array,
    outIm: Float32Array,
  ): void {
    const s = this.shape;
    const pad = specPad(s);
    const padded = padReflect(input, pad, specPadRight(s));
    // `center=true`: noch einmal ein halbes Fenster an beide Enden.
    const centered = padReflect(padded, s.nfft >> 1, s.nfft >> 1);
    const norm = 1 / Math.sqrt(s.nfft);
    const bins = s.freqBins;

    // `_spec` behaelt die Zeitschritte 2 bis 2+frames und wirft die oberste
    // Frequenz weg. Berechnet werden deshalb nur die gebrauchten Schritte.
    for (let t = 0; t < s.frames; t++) {
      const at = (t + 2) * s.hopLength;
      for (let i = 0; i < s.nfft; i++) this.block[i] = centered[at + i] * this.window[i];
      this.rfft.forward(this.block, this.frameRe, this.frameIm);
      for (let f = 0; f < bins; f++) {
        outRe[f * s.frames + t] = this.frameRe[f] * norm;
        outIm[f * s.frames + t] = this.frameIm[f] * norm;
      }
    }
  }

  /**
   * `_ispec`: ein Kanal zurueck in die Zeit.
   *
   * `inRe`/`inIm` sind `freqBins * frames` wie oben. Die oberste Frequenz
   * und die zwei Zeitschritte an jedem Rand, die `_spec` verworfen hat,
   * gehen als Null wieder hinein — genau das macht die Torch-Fassung auch.
   */
  ispec(inRe: Float32Array, inIm: Float32Array, out: Float64Array): void {
    const s = this.shape;
    const pad = specPad(s);
    const frames = s.frames + 4;
    const total = (frames - 1) * s.hopLength + s.nfft;
    const acc = new Float64Array(total);
    const env = new Float64Array(total);
    const norm = Math.sqrt(s.nfft);
    const bins = s.freqBins;
    const half = s.nfft >> 1;

    for (let t = 0; t < frames; t++) {
      this.frameRe.fill(0);
      this.frameIm.fill(0);
      const src = t - 2;
      if (src >= 0 && src < s.frames) {
        for (let f = 0; f < bins; f++) {
          this.frameRe[f] = inRe[f * s.frames + src] * norm;
          this.frameIm[f] = inIm[f * s.frames + src] * norm;
        }
      }
      this.rfft.inverse(this.frameRe, this.frameIm, this.timeBlock);
      const at = t * s.hopLength;
      for (let i = 0; i < s.nfft; i++) {
        const w = this.window[i];
        acc[at + i] += this.timeBlock[i] * w;
        env[at + i] += w * w;
      }
    }

    // Teilen durch die Summe der Fensterquadrate: ohne das waere der Anfang
    // jedes Blocks lauter als die Mitte, und man hoerte es an jeder
    // Blockgrenze. Der Ausschnitt nimmt beides zurueck — das halbe Fenster
    // von `center=true` und die Polsterung von `_spec`.
    const from = half + pad;
    for (let i = 0; i < s.segment; i++) {
      const e = env[from + i];
      out[i] = e > 1e-11 ? acc[from + i] / e : 0;
    }
  }
}

// ----------------------------------------------------------------- Normierung

/** Mittelwert und Streuung wie `torch.std`: mit Korrektur um einen Freiheitsgrad. */
export function meanAndStd(a: Float32Array | Float64Array): {
  mean: number;
  std: number;
} {
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i];
  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - mean;
    acc += d * d;
  }
  return { mean, std: Math.sqrt(acc / (n - 1)) };
}

// ------------------------------------------------------------- Blockbildung

/**
 * Dreiecksgewicht ueber einen Block, in der Mitte am schwersten.
 *
 * Damit werden die ueberlappenden Bloecke zusammengefuegt: was in der Mitte
 * eines Blocks liegt, hatte den vollen Zusammenhang um sich und wiegt
 * schwer; was am Rand liegt, wiegt leicht und wird vom Nachbarblock
 * getragen.
 */
export function segmentWeight(segment: number): Float64Array {
  const half = segment >> 1;
  const w = new Float64Array(segment);
  for (let i = 0; i < half; i++) w[i] = i + 1;
  for (let i = half; i < segment; i++) w[i] = segment - i;
  const max = Math.max(w[half - 1], w[half]);
  for (let i = 0; i < segment; i++) w[i] /= max;
  return w;
}

/**
 * Einen Block aus dem Song holen, kuerzere Bloecke mittig mit Null umgeben.
 *
 * Der letzte Block eines Songs ist fast immer kuerzer als `segment`. Demucs
 * legt ihn nicht an den Fensteranfang, sondern in die Mitte: die halbe
 * Differenz als Stille davor, der Rest danach. Legte man ihn nach vorn,
 * bekaeme das Ende des Songs ein anderes Gewicht als der Rest, und man
 * hoerte es an den letzten Sekunden.
 */
export function paddedChunk(
  channels: readonly Float32Array[],
  offset: number,
  want: number,
  out: Float64Array[],
): void {
  const total = channels[0].length;
  const have = Math.min(total - offset, want);
  const delta = want - have;
  const start = offset - (delta >> 1);
  const left = Math.max(0, start);
  const right = Math.min(total, start + want);
  for (let c = 0; c < channels.length; c++) {
    out[c].fill(0);
    const at = left - start;
    for (let i = left; i < right; i++) out[c][at + i - left] = channels[c][i];
  }
}

/** Wie `center_trim`: der Ueberhang geht zur Haelfte vorn weg, der Rest hinten. */
export function centerTrimOffset(from: number, to: number): number {
  return (from - to) >> 1;
}

/** Zahl der Bloecke, die ein Song dieser Laenge braucht. */
export function blockCount(samples: number, segment: number, overlap: number): number {
  const stride = Math.trunc((1 - overlap) * segment);
  return Math.max(1, Math.ceil(samples / stride));
}
