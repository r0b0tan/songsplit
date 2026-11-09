/**
 * Die Trennung: von den Abtastwerten eines Songs zu den fertigen Spuren.
 *
 * Der Ablauf ist derselbe wie in `apply_model` von Demucs und derselbe wie
 * in `backend/tools/demucs_reference.py`:
 *
 *   Bloecke von 7,8 s mit 25 % Ueberlappung
 *     -> STFT, CAC, normieren
 *     -> ONNX
 *     -> entnormieren, maskieren, iSTFT, Zeitzweig addieren
 *     -> mit Dreiecksgewicht in die Spuren einsummieren
 *   am Ende durch die Summe der Gewichte teilen
 *
 * Alle Puffer werden einmal belegt und ueber alle Bloecke wiederverwendet:
 * je Block gehen rund 70 MB durch die Hand, und sie jedes Mal neu zu
 * belegen liesse den Sammler mitten in der Rechnung arbeiten.
 */

import {
  SpectrogramWorkspace,
  blockCount,
  centerTrimOffset,
  meanAndStd,
  paddedChunk,
  segmentWeight,
  type ModelShape,
} from './dsp';
import type { DspBlock, FromDsp, ToDsp } from './dsp-protocol';
import { noteOutputLocations, type ExecutionProof } from './runtime';

type Session = import('onnxruntime-common').InferenceSession;
type OrtTensor = import('onnxruntime-common').Tensor;

/** 25 % wie in Demucs. Weniger spart Zeit und hoert sich an den Nahtstellen. */
export const OVERLAP = 0.25;

export interface Timings {
  /**
   * Blockumlauf: vom Abschicken eines Blocks bis zu seinem Ergebnis.
   *
   * **Nicht** die reine Rechenzeit der Karte — dazwischen liegt die
   * Prozessorarbeit, die absichtlich in dieses Fenster gelegt wird. Was
   * die Karte wirklich kostet, steht in `gpuWaitMs`.
   *
   * **Diese drei Zahlen summieren sich nicht zu `totalMs`**, und das ist
   * der Sinn der Sache: waehrend die Karte an einem Block rechnet, bringt
   * der Prozessor den vorigen zurueck und den naechsten vor. Was die drei
   * zusammen ueber `totalMs` hinausgehen, ist genau die eingesparte Zeit.
   */
  inferenceMs: number;
  /** STFT, CAC, Normierung. Prozessor. */
  forwardDspMs: number;
  /** iSTFT, Maskierung, Einsummieren. Prozessor. */
  inverseDspMs: number;
  /**
   * Davon tatsaechlich *untaetig* auf die Karte gewartet.
   *
   * Die aufschlussreiche Zahl: geht sie gegen Null, ist nicht mehr die
   * Karte der Engpass, sondern der eigene Code — dann bringt ein
   * schnelleres Modell nichts mehr.
   */
  gpuWaitMs: number;
  /** Alles zusammen, inklusive allem, was nicht einzeln gemessen wird. */
  totalMs: number;
  blocks: number;
}

export interface Progress {
  blocksDone: number;
  blocksTotal: number;
  /** Erster Block fertig heisst: ab hier ist eine Zeit abschaetzbar. */
  elapsedMs: number;
}

export interface SeparationResult {
  /** Spuren in der Reihenfolge des Modells, je Spur ein Array pro Kanal. */
  stems: { source: string; channels: Float32Array[] }[];
  sampleRate: number;
  samples: number;
  timings: Timings;
  proof: ExecutionProof;
}

/** Abbruch von aussen. Zwischen zwei Bloecken wird nachgesehen. */
export interface Cancellation {
  cancelled: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('Abgebrochen');
    this.name = 'CancelledError';
  }
}

/**
 * Trennt einen Song. `channels` sind die Abtastwerte in der Modellrate,
 * genau `channels` Kanaele — das richtet der Aufrufer vorher.
 */
export async function separate(
  ort: typeof import('onnxruntime-web'),
  session: Session,
  shape: ModelShape,
  channels: readonly Float32Array[],
  options: {
    proof: ExecutionProof;
    cancel: Cancellation;
    /** Der Draht zum zweiten Worker, der die Ruecktransformation macht. */
    inverse: MessagePort;
    onProgress?: (p: Progress) => void;
  },
): Promise<SeparationResult> {
  const started = performance.now();
  const { segment, frames, freqBins, channels: ch } = shape;
  const sources = shape.sources.length;
  const samples = channels[0].length;
  const bins = freqBins * frames;

  if (channels.length !== ch) {
    throw new Error(`Das Modell erwartet ${ch} Kanäle, bekommen hat es ${channels.length}`);
  }

  const ws = new SpectrogramWorkspace(shape);
  const weight = segmentWeight(segment);
  const stride = Math.trunc((1 - OVERLAP) * segment);
  const total = blockCount(samples, segment, OVERLAP);

  // ----------------------------------------------------- Puffer, einmalig
  const block: Float64Array[] = [];
  for (let c = 0; c < ch; c++) block.push(new Float64Array(segment));
  const specRe: Float32Array[] = [];
  const specIm: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    specRe.push(new Float32Array(bins));
    specIm.push(new Float32Array(bins));
  }
  // Die Eingaben doppelt: waehrend die Karte an einem Block rechnet, wird
  // der naechste schon vorbereitet, und der laufende darf dabei nicht
  // unter der Hand ueberschrieben werden. Kostet 14 MB.
  const xBuf = [new Float32Array(ch * 2 * bins), new Float32Array(ch * 2 * bins)];
  const xtBuf = [new Float32Array(ch * segment), new Float32Array(ch * segment)];

  let inferenceMs = 0;
  let forwardDspMs = 0;
  let gpuWaitMs = 0;
  let proof = options.proof;
  let done = 0;

  /** Ein Block, fertig fuer die Karte. */
  interface Prepared {
    offset: number;
    have: number;
    slot: number;
    specMean: number;
    specStd: number;
    timeMean: number;
    timeStd: number;
  }

  /** Hinein: Block holen, STFT, CAC, normieren. */
  function prepare(offset: number, slot: number): Prepared {
    const mark = performance.now();
    const have = Math.min(samples - offset, segment);
    const xData = xBuf[slot];
    const xtData = xtBuf[slot];

    paddedChunk(channels, offset, segment, block);
    for (let c = 0; c < ch; c++) {
      ws.spec(block[c], specRe[c], specIm[c]);
      // CAC: Real und Imaginaer je Kanal abwechselnd.
      xData.set(specRe[c], 2 * c * bins);
      xData.set(specIm[c], (2 * c + 1) * bins);
      for (let i = 0; i < segment; i++) xtData[c * segment + i] = block[c][i];
    }
    const spec = meanAndStd(xData);
    for (let i = 0; i < xData.length; i++) {
      xData[i] = (xData[i] - spec.mean) / (1e-5 + spec.std);
    }
    const time = meanAndStd(xtData);
    for (let i = 0; i < xtData.length; i++) {
      xtData[i] = (xtData[i] - time.mean) / (1e-5 + time.std);
    }
    forwardDspMs += performance.now() - mark;
    return {
      offset,
      have,
      slot,
      specMean: spec.mean,
      specStd: spec.std,
      timeMean: time.mean,
      timeStd: time.std,
    };
  }

  // ------------------------------------------- der zweite Faden, verdrahtet
  const dsp = new DspLink(options.inverse, () => {
    done++;
    options.onProgress?.({
      blocksDone: done,
      blocksTotal: total,
      elapsedMs: performance.now() - started,
    });
  });
  dsp.begin(shape, samples);

  /**
   * Die Kette ueber zwei Faeden.
   *
   * Je Durchgang: Block abschicken, **ohne** zu warten; den naechsten
   * vorbereiten, waehrend die Karte rechnet; dann das Ergebnis abholen und
   * an den zweiten Worker weiterreichen, der es zurueckrechnet, waehrend
   * hier schon der naechste Block laeuft.
   *
   * Zwei `run`-Aufrufe gleichzeitig gibt es dabei nicht: wenn Block i
   * abgeschickt wird, ist i−1 laengst abgeholt. Mehrere Auftraege auf
   * einmal sind bei der WebGPU-Laufzeit ausdruecklich nicht vorgesehen.
   */
  let noted = false;
  let upcoming: Prepared | null = samples > 0 ? prepare(0, 0) : null;
  let slot = 1;

  while (upcoming) {
    if (options.cancel.cancelled) {
      dsp.abort();
      throw new CancelledError();
    }
    const current = upcoming;

    const feeds = {
      x: new ort.Tensor('float32', xBuf[current.slot], [1, 2 * ch, freqBins, frames]),
      xt: new ort.Tensor('float32', xtBuf[current.slot], [1, ch, segment]),
    };
    const sent = performance.now();
    const running = session.run(feeds);

    // Prozessorarbeit, waehrend die Karte rechnet.
    const nextOffset = current.offset + stride;
    upcoming = nextOffset < samples ? prepare(nextOffset, slot) : null;
    slot ^= 1;

    const waited = performance.now();
    const results = await running;
    gpuWaitMs += performance.now() - waited;

    // Kopieren statt uebergeben: liegt ein Ergebnis auf der CPU, gehoert
    // der Puffer dem Tensor, und ein uebergebener Puffer waere ihm unter
    // den Haenden weg. Die Kopie kostet wenige Millisekunden, der Fehler
    // waere nicht reproduzierbar.
    const xOut = new Float32Array(await readTensor(results['x_out']));
    const xtOut = new Float32Array(await readTensor(results['xt_out']));
    inferenceMs += performance.now() - sent;

    if (!noted) {
      noted = true;
      proof = noteOutputLocations(proof, {
        x_out: results['x_out'],
        xt_out: results['xt_out'],
      });
    }
    for (const tensor of Object.values(results)) tensor.dispose?.();

    // Hinueber in den zweiten Faden. Die Bremse haelt hoechstens zwei
    // Bloecke unterwegs — sonst liefe die Karte davon und jeder wartende
    // Block hielte 55 MB fest.
    await dsp.send({
      type: 'block',
      offset: current.offset,
      have: current.have,
      specMean: current.specMean,
      specStd: current.specStd,
      timeMean: current.timeMean,
      timeStd: current.timeStd,
      xOut,
      xtOut,
    });
  }

  const finished = await dsp.end();


  return {
    stems: shape.sources.map((source, s) => ({
      source,
      channels: finished.stems[s],
    })),
    sampleRate: shape.sampleRate,
    samples,
    timings: {
      inferenceMs,
      forwardDspMs,
      inverseDspMs: finished.inverseDspMs,
      gpuWaitMs,
      totalMs: performance.now() - started,
      blocks: done,
    },
    proof,
  };
}

/**
 * Holt die Werte eines Ergebnisses, auch wenn es im GPU-Puffer liegt.
 *
 * Mit `preferredOutputLocation: 'gpu-buffer'` kommen die Ausgaben als
 * GPU-Puffer zurueck; `getData` kopiert sie herueber. Das ist der Preis
 * dafuer, dass die iSTFT in Javascript laeuft — ohne sie koennte das
 * Ergebnis auf der Karte bleiben.
 */
async function readTensor(tensor: OrtTensor): Promise<Float32Array> {
  if (tensor.location === 'gpu-buffer' || tensor.location === 'ml-tensor') {
    return (await tensor.getData(true)) as Float32Array;
  }
  return tensor.data as Float32Array;
}

/**
 * Der Draht zum zweiten Worker.
 *
 * Zwei Dinge macht diese Klasse, und beide wären von Hand leicht falsch:
 *
 * **Bremsen.** Die Karte ist je Block etwa so schnell wie die
 * Rücktransformation. Liefe sie ungebremst davon, hinge je wartendem Block
 * 55 MB in der Warteschlange — bei einem langen Stück ist das der
 * Arbeitsspeicher des Tabs. `send` wartet deshalb, sobald mehr als zwei
 * Blöcke unterwegs sind. Zwei, nicht einer: bei genau einem stünde der
 * Faden nach jedem Block still, und das ist das Gegenteil dessen, was hier
 * erreicht werden soll.
 *
 * **Fehler weiterreichen.** Stirbt der zweite Worker — Speichermangel ist
 * der wahrscheinliche Fall —, soll das als Fehler des Jobs ankommen und
 * nicht als Trennung, die für immer bei Block 23 steht.
 */
class DspLink {
  /** Blöcke, die abgeschickt, aber noch nicht bestätigt sind. */
  private outstanding = 0;
  /** Wartet `send` gerade auf Luft? */
  private room: (() => void) | null = null;
  private failure: string | null = null;
  private stems: { stems: Float32Array[][]; inverseDspMs: number } | null = null;
  private ended: (() => void) | null = null;

  constructor(
    private readonly port: MessagePort,
    /** Einmal je zurueckgerechnetem Block. */
    private readonly onBlockDone: () => void,
  ) {
    this.port.onmessage = (event: MessageEvent<FromDsp>) => {
      const message = event.data;
      if (message.type === 'ack') {
        this.outstanding--;
        this.onBlockDone();
        const open = this.room;
        this.room = null;
        open?.();
      } else if (message.type === 'stems') {
        this.stems = { stems: message.stems, inverseDspMs: message.inverseDspMs };
        this.ended?.();
      } else {
        this.failure = message.message;
        this.room?.();
        this.room = null;
        this.ended?.();
      }
    };
    this.port.start();
  }

  begin(shape: ModelShape, samples: number): void {
    this.port.postMessage({ type: 'begin', shape, samples } satisfies ToDsp);
  }

  /** Schickt einen Block hinüber und wartet, wenn zu viele unterwegs sind. */
  async send(block: DspBlock): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    this.outstanding++;
    this.port.postMessage(block, [block.xOut.buffer, block.xtOut.buffer]);
    while (this.outstanding > 2 && !this.failure) {
      await new Promise<void>((resolve) => (this.room = resolve));
    }
    if (this.failure) throw new Error(this.failure);
  }

  /** Sagt, dass nichts mehr kommt, und holt die fertigen Spuren ab. */
  async end(): Promise<{ stems: Float32Array[][]; inverseDspMs: number }> {
    this.port.postMessage({ type: 'end' } satisfies ToDsp);
    if (!this.stems && !this.failure) {
      await new Promise<void>((resolve) => (this.ended = resolve));
    }
    if (this.failure) throw new Error(this.failure);
    if (!this.stems) throw new Error('Der zweite Worker lieferte keine Spuren.');
    return this.stems;
  }

  abort(): void {
    this.port.postMessage({ type: 'abort' } satisfies ToDsp);
  }
}
