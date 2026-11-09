/**
 * Prueft `src/app/separate/dsp.ts` gegen die Werte, die
 * `backend/tools/demucs_reference.py --fixtures` geschrieben hat.
 *
 * Die Kette dort ist Schritt fuer Schritt gegen die Methoden des Modells
 * selbst gemessen (`--self-check`), und der ganze Weg einmal gegen Torch auf
 * der Grafikkarte (`--compare`). Was diese Pruefung also sagt: die
 * TypeScript-Fassung rechnet dasselbe wie die numpy-Fassung, und damit
 * dasselbe wie Demucs.
 *
 * Laeuft in Node, ohne Browser — hier gibt es kein Audio und kein WebGPU,
 * nur Zahlen.
 */
import {
  RealFft,
  SpectrogramWorkspace,
  hannPeriodic,
  meanAndStd,
  paddedChunk,
  segmentWeight,
  type ModelShape,
} from '../../src/app/separate/dsp';
import { makeReferenceSignal } from '../../src/app/separate/reference-signal';
import { STEM_BUDGET_BYTES, StemStore } from '../../src/app/separate/stem-store';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface Digest {
  shape: number[];
  sum: number;
  sum_squares: number;
  abs_max: number;
  probe_step: number;
  probes: number[];
}

export interface Fixtures {
  sources: string[];
  sample_rate: number;
  segment: number;
  hop: number;
  nfft: number;
  freqs: number;
  frames: number;
  samples: number;
  stages: Record<string, Digest>;
  normalisation: {
    spec_mean: number;
    spec_std: number;
    wave_mean: number;
    wave_std: number;
  };
}

function flatten(parts: readonly (Float32Array | Float64Array)[]): Float64Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float64Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Vergleicht ein Zwischenergebnis mit den Kennzahlen aus Python.
 *
 * Gemessen wird relativ: die Werte reichen von Bruchteilen bis knapp fuenf,
 * ein absoluter Grenzwert waere an einer Stelle streng und an der anderen
 * blind. `1e-5` ist weit unter allem, was man hoeren koennte, und weit ueber
 * dem Abstand zwischen float32 und float64.
 */
function compare(name: string, got: Float64Array, want: Digest, tol = 1e-5): Check {
  const size = want.shape.reduce((a, b) => a * b, 1);
  if (got.length !== size) {
    return {
      name,
      pass: false,
      detail: `${got.length} Werte, erwartet ${size} (${want.shape.join('×')})`,
    };
  }
  let sum = 0;
  let sumSq = 0;
  let absMax = 0;
  for (let i = 0; i < got.length; i++) {
    sum += got[i];
    sumSq += got[i] * got[i];
    const a = Math.abs(got[i]);
    if (a > absMax) absMax = a;
  }
  const scale = Math.max(absMax, 1e-12);
  const relSum = Math.abs(sum - want.sum) / Math.max(Math.abs(want.sum), scale);
  const relSq = Math.abs(sumSq - want.sum_squares) / Math.max(want.sum_squares, scale);
  const relMax = Math.abs(absMax - want.abs_max) / scale;

  let worstProbe = 0;
  let worstAt = -1;
  for (let i = 0; i < want.probes.length; i++) {
    const index = i * want.probe_step;
    const d = Math.abs(got[index] - want.probes[i]) / scale;
    if (d > worstProbe) {
      worstProbe = d;
      worstAt = index;
    }
  }

  const worst = Math.max(relSum, relSq, relMax, worstProbe);
  return {
    name,
    pass: worst < tol,
    detail:
      `${want.shape.join('×')}, Betrag bis ${absMax.toFixed(4)}; ` +
      `Summe ${relSum.toExponential(1)}, Quadratsumme ${relSq.toExponential(1)}, ` +
      `Betrag ${relMax.toExponential(1)}, ${want.probes.length} Stichproben ` +
      `bis ${worstProbe.toExponential(1)}` +
      (worstAt >= 0 && worstProbe > tol ? ` (schlechteste bei ${worstAt})` : ''),
  };
}

/**
 * Das Byte-Budget des Ergebnisspeichers.
 *
 * Mit echten Songen waere das nicht pruefbar: es braeuchte ueber ein
 * Gigabyte Audio, um die Grenze zu erreichen. Die Klasse selbst haengt aber
 * an nichts als Zahlen, also wird sie hier direkt befragt.
 */
function withBudget(budget: number): StemStore {
  const store = new StemStore();
  store.budget = budget;
  return store;
}

function storeChecks(): Check[] {
  const out: Check[] = [];
  // Ein kleines Budget, damit die Pruefung nicht ein Gigabyte Audio
  // belegen muss, um die Grenze zu erreichen. Die Logik ist dieselbe.
  const budget = 4_000_000;
  const perResult = budget / 4;
  const make = (id: string) => ({
    jobId: id,
    sampleRate: 44100,
    stems: [{ source: 'vocals', channels: [new Float32Array(perResult / 4)] }],
  });

  const store = withBudget(budget);
  for (const id of ['a', 'b', 'c', 'd']) store.put(make(id));
  out.push({
    name: 'Ergebnisspeicher: vier Ergebnisse passen ins Budget',
    pass:
      store.bytes() <= budget && ['a', 'b', 'c', 'd'].every((i) => store.has(i)),
    detail:
      `${store.bytes()} von ${budget} Byte, ` +
      `gehalten: ${[...store.available()].join(', ')}`,
  });

  store.put(make('e'));
  out.push({
    name: 'Ergebnisspeicher: das fuenfte verdraengt das aelteste',
    pass: !store.has('a') && store.has('e') && store.bytes() <= budget,
    detail:
      `gehalten: ${[...store.available()].join(', ')}; ` +
      `„a" ${store.has('a') ? 'noch da — falsch' : 'verdraengt'}`,
  });

  // Oeffnen macht ein Ergebnis zum juengsten. Sonst verdraengte der naechste
  // Job genau das, mit dem gerade gearbeitet wird.
  store.get('b');
  store.put(make('f'));
  out.push({
    name: 'Ergebnisspeicher: ein geoeffnetes Ergebnis wird nicht verdraengt',
    pass: store.has('b') && !store.has('c'),
    detail:
      'nach dem Oeffnen von „b" und einem neuen Job: gehalten ' +
      `${[...store.available()].join(', ')}`,
  });

  // Ein einzelnes Ergebnis, das groesser als das ganze Budget ist, muss
  // zumindest einmal benutzbar sein — sonst verschwaende es gleich nach dem
  // Rechnen, und gerechnet hat es trotzdem Minuten.
  const huge = withBudget(budget);
  huge.put({
    jobId: 'riese',
    sampleRate: 44100,
    stems: [{ source: 'vocals', channels: [new Float32Array(budget / 2)] }],
  });
  out.push({
    name: 'Ergebnisspeicher: ein ueberlanges Ergebnis bleibt benutzbar',
    pass: huge.has('riese'),
    detail:
      `${huge.bytes()} Byte bei einem Budget von ${budget} — ` +
      `${huge.has('riese') ? 'gehalten' : 'verworfen'}`,
  });

  const dropped = withBudget(budget);
  dropped.put(make('x'));
  dropped.drop('x');
  out.push({
    name: 'Ergebnisspeicher: geloeschte Jobs geben den Speicher frei',
    pass: !dropped.has('x') && dropped.bytes() === 0,
    detail: `${dropped.bytes()} Byte nach dem Loeschen`,
  });

  out.push({
    name: 'Ergebnisspeicher: die Vorgabe des Budgets ist gesetzt',
    pass: new StemStore().budget === STEM_BUDGET_BYTES,
    detail: `${(STEM_BUDGET_BYTES / 1e6).toFixed(0)} MB — drei Ergebnisse zu vier Spuren von 4:33`,
  });
  return out;
}

export function runChecks(fx: Fixtures): Check[] {
  const shape: ModelShape = {
    sources: fx.sources,
    sampleRate: fx.sample_rate,
    channels: 2,
    segment: fx.segment,
    nfft: fx.nfft,
    hopLength: fx.hop,
    freqBins: fx.freqs,
    frames: fx.frames,
  };
  const checks: Check[] = [];

  // ------------------------------------------------- FFT gegen eine DFT
  // Eine unabhaengige Pruefung: die halbierte reelle FFT ist der Teil mit
  // dem meisten Spielraum fuer einen Vorzeichen- oder Indexfehler, und eine
  // direkt ausgeschriebene DFT hat diesen Spielraum nicht.
  checks.push(fftAgainstDft());

  checks.push(
    compare('Fensterfunktion (periodisches Hann)', hannPeriodic(fx.nfft), fx.stages['window']),
  );

  const mix = makeReferenceSignal(fx.samples, fx.sample_rate).map((c) => Float64Array.from(c));
  checks.push(compare('Testsignal in beiden Sprachen gleich', flatten(mix), fx.stages['signal']));

  checks.push(compare('Blockgewicht (Dreieck)', segmentWeight(fx.segment), fx.stages['weight']));

  // ----------------------------------------------------------- _spec
  const ws = new SpectrogramWorkspace(shape);
  const bins = fx.freqs * fx.frames;
  const re: Float32Array[] = [];
  const im: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const r = new Float32Array(bins);
    const i = new Float32Array(bins);
    ws.spec(mix[c].slice(0, fx.segment), r, i);
    re.push(r);
    im.push(i);
  }
  checks.push(compare('_spec, Realteil', flatten(re), fx.stages['spec_real']));
  checks.push(compare('_spec, Imaginaerteil', flatten(im), fx.stages['spec_imag']));

  // ------------------------------------------------------------- CAC
  // Die Reihenfolge ist der Punkt: Real und Imaginaer je Kanal abwechselnd,
  // nicht erst alle Realteile. Vertauscht laeuft das Modell ohne
  // Fehlermeldung und trennt nichts.
  const cac = flatten([re[0], im[0], re[1], im[1]]);
  checks.push(compare('CAC-Kanaele in der Reihenfolge des Modells', cac, fx.stages['cac']));

  // ------------------------------------------------------- Normierung
  const specStats = meanAndStd(cac);
  const block = flatten([mix[0].slice(0, fx.segment), mix[1].slice(0, fx.segment)]);
  const waveStats = meanAndStd(block);
  const n = fx.normalisation;
  const worstNorm = Math.max(
    Math.abs(specStats.mean - n.spec_mean) / Math.max(Math.abs(n.spec_mean), 1e-6),
    Math.abs(specStats.std - n.spec_std) / n.spec_std,
    Math.abs(waveStats.mean - n.wave_mean) / Math.max(Math.abs(n.wave_mean), 1e-6),
    Math.abs(waveStats.std - n.wave_std) / n.wave_std,
  );
  checks.push({
    name: 'Normierung: Mittelwert und Streuung wie torch.std',
    pass: worstNorm < 1e-4,
    detail:
      `Spektrogramm ${specStats.mean.toExponential(3)} / ${specStats.std.toFixed(6)}, ` +
      `Welle ${waveStats.mean.toExponential(3)} / ${waveStats.std.toFixed(6)}; ` +
      `groesster relativer Abstand ${worstNorm.toExponential(1)}`,
  });

  // ---------------------------------------------------------- _ispec
  const back: Float64Array[] = [];
  for (let c = 0; c < 2; c++) {
    const out = new Float64Array(fx.segment);
    ws.ispec(re[c], im[c], out);
    back.push(out);
  }
  checks.push(compare('_ispec zurueck in die Zeit', flatten(back), fx.stages['ispec']));

  // Und die Rueckprobe ohne Python: in der Blockmitte muss das Original
  // wieder herauskommen. An den Raendern nicht — dort fehlen die
  // weggeschnittenen Zeitschritte, und genau dafuer ueberlappen die Bloecke.
  let worstMiddle = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 8192; i < fx.segment - 8192; i++) {
      const d = Math.abs(back[c][i] - mix[c][i]);
      if (d > worstMiddle) worstMiddle = d;
    }
  }
  checks.push({
    name: '_spec und _ispec ergeben in der Blockmitte das Original',
    pass: worstMiddle < 5e-3,
    detail: `groesster Abstand ${worstMiddle.toExponential(2)} bei Pegeln um 0,35`,
  });

  // ------------------------------------------------- letzter, kurzer Block
  const mix32 = mix.map((c) => Float32Array.from(c));
  const chunk = [new Float64Array(fx.segment), new Float64Array(fx.segment)];
  paddedChunk(mix32, Math.trunc(0.75 * fx.segment), fx.segment, chunk);
  checks.push(
    compare(
      'letzter Block liegt mittig im Fenster',
      flatten(chunk),
      fx.stages['padded_last_chunk'],
      // Das Eingangssignal ist hier float32 (so kommt es aus dem Dekoder),
      // die Referenz float64. Das ist der ganze Unterschied.
      2e-4,
    ),
  );

  checks.push(...storeChecks());

  return checks;
}

/** Die reelle FFT gegen eine direkt ausgeschriebene DFT, bei kleiner Laenge. */
function fftAgainstDft(): Check {
  const n = 64;
  const rfft = new RealFft(n);
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    input[i] = Math.sin((2 * Math.PI * 5 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 17 * i) / n);
  }
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  rfft.forward(input, re, im);

  let worst = 0;
  for (let k = 0; k <= n / 2; k++) {
    let dr = 0;
    let di = 0;
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * k * i) / n;
      dr += input[i] * Math.cos(a);
      di += input[i] * Math.sin(a);
    }
    worst = Math.max(worst, Math.abs(re[k] - dr), Math.abs(im[k] - di));
  }

  const back = new Float64Array(n);
  rfft.inverse(re, im, back);
  let worstBack = 0;
  for (let i = 0; i < n; i++) worstBack = Math.max(worstBack, Math.abs(back[i] - input[i]));

  return {
    name: 'reelle FFT gegen eine ausgeschriebene DFT',
    pass: worst < 1e-10 && worstBack < 1e-12,
    detail:
      `vorwaerts bis ${worst.toExponential(1)} ab, ` +
      `hin und zurueck bis ${worstBack.toExponential(1)}`,
  };
}
