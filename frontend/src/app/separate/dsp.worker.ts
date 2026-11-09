/// <reference lib="webworker" />
/**
 * Der zweite Faden: alles, was nach dem Modell kommt.
 *
 * Entnormieren, maskieren, iSTFT, Zeitzweig addieren, mit dem
 * Dreiecksgewicht einsummieren — und am Ende durch die Summe der Gewichte
 * teilen. Warum das in einem eigenen Worker liegt, steht in
 * [`dsp-protocol.ts`](./dsp-protocol.ts); kurz: die WebGPU-Laufzeit braucht
 * den Javascript-Faden zwischen den Kernen, und eine iSTFT gibt ihn eine
 * Viertelsekunde lang nicht her.
 *
 * Dieser Worker hält die **fertigen Spuren**. Das ist der größte Posten
 * einer Trennung — 385 MB bei vier Spuren und 4:33 — und er liegt damit
 * dort, wo er entsteht, statt über die Fadengrenze gereicht zu werden.
 * Hinüber geht am Ende genau einmal etwas, und zwar als Übergabe, nicht
 * als Kopie.
 */

import {
  SpectrogramWorkspace,
  centerTrimOffset,
  segmentWeight,
  type ModelShape,
} from './dsp';
import type { DspBlock, FromDsp, ToDsp } from './dsp-protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface Job {
  shape: ModelShape;
  samples: number;
  ws: SpectrogramWorkspace;
  weight: Float64Array;
  /** `[Spur][Kanal]`, die Summe über alle Blöcke. */
  out: Float32Array[][];
  sumWeight: Float32Array;
  /** Wiederverwendete Puffer: je 2,75 Millionen Werte. */
  reD: Float32Array;
  imD: Float32Array;
  wave: Float64Array;
  inverseDspMs: number;
}

let link: MessagePort | null = null;
let job: Job | null = null;

scope.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; port?: MessagePort };
  if (data?.type === 'link' && data.port) {
    link = data.port;
    link.onmessage = (message: MessageEvent<ToDsp>) => handle(message.data);
    link.start();
  }
});

function send(message: FromDsp, transfer: Transferable[] = []): void {
  link?.postMessage(message, transfer);
}

function handle(message: ToDsp): void {
  try {
    switch (message.type) {
      case 'begin':
        job = begin(message.shape, message.samples);
        return;
      case 'block':
        if (!job) return;
        inverse(job, message);
        send({ type: 'ack', offset: message.offset });
        return;
      case 'end': {
        if (!job) return;
        finish(job);
        job = null;
        return;
      }
      case 'abort':
        // Die Puffer loslassen: bei einem langen Stück hängen hier
        // mehrere Hundert Megabyte, und der nächste Job will sie.
        job = null;
        return;
    }
  } catch (err) {
    job = null;
    send({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

function begin(shape: ModelShape, samples: number): Job {
  const sources = shape.sources.length;
  const bins = shape.freqBins * shape.frames;
  const out: Float32Array[][] = [];
  for (let s = 0; s < sources; s++) {
    const perChannel: Float32Array[] = [];
    for (let c = 0; c < shape.channels; c++) perChannel.push(new Float32Array(samples));
    out.push(perChannel);
  }
  return {
    shape,
    samples,
    ws: new SpectrogramWorkspace(shape),
    weight: segmentWeight(shape.segment),
    out,
    sumWeight: new Float32Array(samples),
    reD: new Float32Array(bins),
    imD: new Float32Array(bins),
    wave: new Float64Array(shape.segment),
    inverseDspMs: 0,
  };
}

/** Ein Block zurück in die Zeit und in die Spuren hinein. */
function inverse(j: Job, block: DspBlock): void {
  const mark = performance.now();
  const { shape, ws, weight, out, sumWeight, reD, imD, wave } = j;
  const { segment, freqBins, frames, channels: ch } = shape;
  const sources = shape.sources.length;
  const bins = freqBins * frames;
  const { xOut, xtOut, offset, have, specMean, specStd, timeMean, timeStd } = block;
  const trim = centerTrimOffset(segment, have);

  for (let s = 0; s < sources; s++) {
    for (let c = 0; c < ch; c++) {
      // Maskierung im CAC-Modus heisst: die Kanaele sind
      // (Spur, Kanal, Real/Imaginaer) in genau dieser Verschachtelung.
      const base = (s * ch + c) * 2;
      const re = xOut.subarray(base * bins, (base + 1) * bins);
      const im = xOut.subarray((base + 1) * bins, (base + 2) * bins);
      // Entnormieren vor der Ruecktransformation, wie im Modell.
      for (let i = 0; i < bins; i++) {
        reD[i] = re[i] * specStd + specMean;
        imD[i] = im[i] * specStd + specMean;
      }
      ws.ispec(reD, imD, wave);

      const timeBase = (s * ch + c) * segment;
      const target = out[s][c];
      for (let i = 0; i < have; i++) {
        const at = trim + i;
        const fromTime = xtOut[timeBase + at] * timeStd + timeMean;
        target[offset + i] += weight[i] * (wave[at] + fromTime);
      }
    }
  }
  for (let i = 0; i < have; i++) sumWeight[offset + i] += weight[i];
  j.inverseDspMs += performance.now() - mark;
}

/** Durch die Summe der Gewichte teilen und die Spuren hinübergeben. */
function finish(j: Job): void {
  const mark = performance.now();
  const sources = j.out.length;
  for (let s = 0; s < sources; s++) {
    for (let c = 0; c < j.out[s].length; c++) {
      const data = j.out[s][c];
      for (let i = 0; i < j.samples; i++) data[i] /= j.sumWeight[i];
    }
  }
  j.inverseDspMs += performance.now() - mark;

  const transfer: Transferable[] = [];
  for (const stem of j.out) for (const channel of stem) transfer.push(channel.buffer);
  send({ type: 'stems', stems: j.out, inverseDspMs: j.inverseDspMs }, transfer);
}
