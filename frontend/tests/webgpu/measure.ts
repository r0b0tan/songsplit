/**
 * Die Messung selbst — als Modul, damit sie in jedem Browser laeuft.
 *
 * Gegenstueck zur Messseite `#bench`, aber ohne Angular und ohne Oberflaeche:
 * diese Fassung laesst sich in einen Browser laden, der sich **nicht**
 * fernsteuern laesst. Genau das ist unter WSL2 der Fall — das Chromium von
 * Playwright bekommt dort nur SwiftShader, waehrend das Chrome von Windows
 * die Grafikkarte sieht, sich aber nicht ueber CDP erreichen laesst.
 * Deshalb redet diese Messung nicht zurueck, sondern schickt ihr Ergebnis
 * per `fetch` an den Server, der sie ausgeliefert hat.
 *
 * Gemessen wird dasselbe und in derselben Reihenfolge wie auf der
 * Messseite, damit die Zahlen vergleichbar bleiben.
 */
import { clearCache } from '../../src/app/separate/model-cache';
import { makeReferenceSignal } from '../../src/app/separate/reference-signal';
import { probeWebGpu, type ExecutionProof } from '../../src/app/separate/runtime';
import type { FromWorker } from '../../src/app/separate/separate.worker';

export interface RunResult {
  label: string;
  provider: string;
  gpuConfirmed: boolean;
  evidence: string[];
  audioSeconds: number;
  blocks: number;
  decodeMs: number;
  modelMs: number;
  modelFromCache: boolean;
  sessionMs: number;
  inferenceMs: number;
  gpuWaitMs: number;
  forwardDspMs: number;
  inverseDspMs: number;
  separationMs: number;
  firstPlayableMs: number;
  realtime: number;
  /** dB unter Mix gegen die numpy-Referenz, oder null. */
  referenceDb: number | null;
  referenceDetail: string | null;
}

export interface MeasureReport {
  adapter: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    software: boolean;
  } | null;
  adapterReason: string | null;
  userAgent: string;
  runs: RunResult[];
  failure: string | null;
}

interface Digest {
  shape: number[];
  sum_squares: number;
  probe_step: number;
  probes: number[];
}

interface Fixtures {
  samples: number;
  stages: Record<string, Digest>;
  separated: Record<string, Digest>;
}

/** Knapp zwei Bloecke — dieselbe Laenge wie auf der Messseite. */
const CLIP_SAMPLES = 343980 + 1024 * 37;
const RATE = 44100;

function flatten(parts: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function perSamplePower(digest: Digest): number {
  const size = digest.shape.reduce((a, b) => a * b, 1) || 1;
  return digest.sum_squares / size;
}

/**
 * Abstand zur Referenz, in dB unter dem Mix.
 *
 * Gegen den Mix und nicht gegen die jeweilige Spur: htdemucs legt auf
 * manches Material fast nichts auf Bass und Drums, und auf einer praktisch
 * leeren Spur sagt ein Verhaeltnis zu ihr selbst nichts ueber die
 * Umsetzung. Dieselbe Begruendung steht ausfuehrlich in der README.
 */
function belowMix(got: Float32Array, want: Digest, mixPower: number): number {
  let noise = 0;
  let count = 0;
  for (let i = 0; i < want.probes.length; i++) {
    const at = i * want.probe_step;
    if (at >= got.length) break;
    const d = got[at] - want.probes[i];
    noise += d * d;
    count++;
  }
  if (!count) return -Infinity;
  const per = noise / count;
  if (per === 0) return Infinity;
  return 10 * Math.log10(mixPower / per);
}

function compare(
  result: Extract<FromWorker, { type: 'done' }>,
  fx: Fixtures | null,
): { db: number | null; detail: string | null } {
  if (!fx || result.samples !== fx.samples) return { db: null, detail: null };
  const mixPower = perSamplePower(fx.stages['signal']);
  const parts: string[] = [];
  let worst = Infinity;
  for (const stem of result.stems) {
    const want = fx.separated[stem.source];
    if (!want) continue;
    const value = belowMix(flatten(stem.channels), want, mixPower);
    parts.push(`${stem.source} ${value.toFixed(0)}`);
    if (value < worst) worst = value;
  }
  if (!Number.isFinite(worst)) return { db: null, detail: null };
  return { db: worst, detail: parts.join(', ') };
}

function describeProvider(proof: ExecutionProof): string {
  if (proof.provider === 'webgpu' && proof.gpuConfirmed) return 'WebGPU';
  if (proof.provider === 'webgpu') return 'WebGPU (unbestätigt)';
  return 'WASM (CPU)';
}

/** Ein Lauf durch den Worker, mit allem gestoppt. */
async function runOnce(
  worker: Worker,
  label: string,
  modelId: string,
  channels: Float32Array[],
  preferGpu: boolean,
  decodeMs: number,
  fx: Fixtures | null,
  onStatus: (text: string) => void,
): Promise<RunResult> {
  const jobId = `measure-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const started = performance.now();
  let lastTenth = -1;

  const done = new Promise<Extract<FromWorker, { type: 'done' }>>((resolve, reject) => {
    const onMessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (!('jobId' in message) || message.jobId !== jobId) return;
      if (message.type === 'model') {
        const share = message.total ? Math.round((message.loaded / message.total) * 100) : 0;
        // Nur jedes Zehntel melden: die Meldungen gehen per `fetch` an den
        // Pruefstand und kommen dort nicht unbedingt in der Reihenfolge an,
        // in der sie abgeschickt wurden — bei jedem Prozent waere das
        // Protokoll ein Durcheinander aus hin- und herspringenden Zahlen.
        const step = Math.floor(share / 10);
        if (message.fromCache || step !== lastTenth) {
          lastTenth = step;
          onStatus(`${label}: Modell ${message.fromCache ? 'aus dem Cache' : `${share} %`}`);
        }
      } else if (message.type === 'progress') {
        onStatus(`${label}: Block ${message.blocksDone}/${message.blocksTotal}`);
      } else if (message.type === 'stage') {
        onStatus(`${label}: ${message.phase}`);
      } else if (message.type === 'done') {
        worker.removeEventListener('message', onMessage);
        resolve(message);
      } else if (message.type === 'error') {
        worker.removeEventListener('message', onMessage);
        reject(new Error(message.message));
      }
    };
    worker.addEventListener('message', onMessage);
  });

  worker.postMessage(
    { type: 'start', jobId, modelId, channels, sampleRate: RATE, preferGpu },
    channels.map((c) => c.buffer),
  );

  const result = await done;
  const firstPlayableMs = performance.now() - started + decodeMs;
  const audioSeconds = result.samples / result.sampleRate;
  const separationMs = result.timings.totalMs;
  const reference = compare(result, fx);

  return {
    label,
    provider: describeProvider(result.proof),
    gpuConfirmed: result.proof.gpuConfirmed,
    evidence: result.proof.evidence,
    audioSeconds,
    blocks: result.timings.blocks,
    decodeMs,
    modelMs: result.modelMs,
    modelFromCache: result.modelFromCache,
    sessionMs: result.sessionMs,
    inferenceMs: result.timings.inferenceMs,
    gpuWaitMs: result.timings.gpuWaitMs,
    forwardDspMs: result.timings.forwardDspMs,
    inverseDspMs: result.timings.inverseDspMs,
    separationMs,
    firstPlayableMs,
    realtime: audioSeconds / (separationMs / 1000),
    referenceDb: reference.db,
    referenceDetail: reference.detail,
  };
}

export interface MeasureOptions {
  workerUrl: string;
  /** Der zweite Worker: Rücktransformation auf einem eigenen Faden. */
  dspWorkerUrl: string;
  modelId: string;
  /** Adresse einer echten Datei, oder null. */
  songUrl: string | null;
  /** Auch den WASM-Weg messen, zum Vergleich. */
  alsoWasm: boolean;
  onStatus: (text: string) => void;
}

export async function measure(options: MeasureOptions): Promise<MeasureReport> {
  const { workerUrl, dspWorkerUrl, modelId, songUrl, alsoWasm, onStatus } = options;
  const support = await probeWebGpu();
  const report: MeasureReport = {
    adapter: support.adapter,
    adapterReason: support.reason,
    userAgent: navigator.userAgent,
    runs: [],
    failure: null,
  };

  let fx: Fixtures | null = null;
  try {
    const response = await fetch('reference/index.json');
    if (response.ok) fx = (await response.json()) as Fixtures;
  } catch {
    fx = null;
  }

  /** Beide Worker anlegen und verdrahten — wie in `DeviceSeparator`. */
  const open = () => {
    const worker = new Worker(workerUrl, { type: 'module' });
    const dsp = new Worker(dspWorkerUrl, { type: 'module' });
    const channel = new MessageChannel();
    worker.postMessage({ type: 'link', port: channel.port1 }, [channel.port1]);
    dsp.postMessage({ type: 'link', port: channel.port2 }, [channel.port2]);
    const stop = worker.terminate.bind(worker);
    worker.terminate = () => {
      dsp.terminate();
      stop();
    };
    return worker;
  };

  try {
    // ---------------------------------------------------- kalt: ohne Cache
    // Erst den Cache leeren und einen frischen Worker nehmen, sonst misst
    // der „kalte" Lauf nur eine stehende Sitzung.
    await clearCache();
    onStatus('Cache geleert, kalter Lauf …');
    let worker = open();
    report.runs.push(
      await runOnce(
        worker,
        'Clip kalt',
        modelId,
        makeReferenceSignal(CLIP_SAMPLES, RATE),
        true,
        0,
        fx,
        onStatus,
      ),
    );

    // --------------------------------------- warm: dieselbe Sitzung erneut
    report.runs.push(
      await runOnce(
        worker,
        'Clip warm',
        modelId,
        makeReferenceSignal(CLIP_SAMPLES, RATE),
        true,
        0,
        fx,
        onStatus,
      ),
    );

    // ------------------------------------------------- ein ganzes Stueck
    if (songUrl) {
      onStatus('Datei wird dekodiert …');
      const t0 = performance.now();
      const response = await fetch(songUrl);
      const blob = await response.blob();
      const { decodeForModel } = await import('../../src/app/separate/decode');
      const decoded = await decodeForModel(blob, RATE, 2);
      const decodeMs = performance.now() - t0;
      report.runs.push(
        await runOnce(
          worker,
          'Ganzer Song',
          modelId,
          decoded.channels,
          true,
          decodeMs,
          fx,
          onStatus,
        ),
      );
    }

    // ----------------------------------------- Gegenprobe auf dem WASM-Weg
    if (alsoWasm) {
      // Ein eigener Worker: die Sitzung einer laufenden haengt am
      // Ausfuehrungsweg und laesst sich nicht umschalten.
      worker.terminate();
      worker = open();
      report.runs.push(
        await runOnce(
          worker,
          'Clip auf WASM',
          modelId,
          makeReferenceSignal(CLIP_SAMPLES, RATE),
          false,
          0,
          fx,
          onStatus,
        ),
      );
    }
    worker.terminate();
  } catch (err) {
    report.failure = err instanceof Error ? err.message : String(err);
  }
  return report;
}
