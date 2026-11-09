/// <reference lib="webworker" />
/**
 * Der Worker, in dem die Trennung laeuft.
 *
 * Warum ueberhaupt ein Worker: ein Block Inferenz blockiert den Faden, auf
 * dem er laeuft, fuer mehrere Hundert Millisekunden, und die iSTFT dazu
 * nochmal so lange. Auf dem Hauptfaden hiesse das: die Fortschrittsanzeige
 * steht still, der Abbrechen-Knopf reagiert nicht, und das Deck eines
 * vorherigen Jobs setzt aus. Hier draussen merkt die Oberflaeche nichts
 * davon.
 *
 * Das Protokoll ist bewusst klein — ein Auftrag je Tab, wie es die
 * Aufgabenstellung verlangt. Nachrichten hinein:
 *
 *   probe                       Kann dieses Gerät das überhaupt?
 *   start {jobId, ...}          Trennung beginnen
 *   cancel {jobId}              Abbrechen
 *
 * Nachrichten heraus: `probed`, `stage`, `model`, `progress`, `done`,
 * `error`. Jede traegt die `jobId`, denn ein spaet eintreffendes Ergebnis
 * eines abgebrochenen Jobs darf keinen neuen ueberschreiben — darueber
 * entscheidet der Empfaenger, und dafuer braucht er die Kennung.
 */

import {
  loadManifest,
  shapeOf,
  weightPartUrls,
  weightsBytes,
  weightsCacheKey,
  type ModelManifest,
} from './catalog';
import { fetchWeights, isCached } from './model-cache';
import {
  createSession,
  describe,
  ensureWasmBinary,
  loadRuntime,
  probeWebGpu,
  type ExecutionProof,
  type WebGpuSupport,
} from './runtime';
import { CancelledError, separate, type Timings } from './separator';

/** Phasen, die die Oberflaeche getrennt anzeigt. */
export type Phase =
  | 'warten'
  | 'modell-prüfen'
  | 'laufzeit-laden'
  | 'modell-laden'
  | 'sitzung-anlegen'
  | 'trennen'
  | 'fertig';

export interface StartMessage {
  type: 'start';
  jobId: string;
  modelId: string;
  /** Abtastwerte in der Modellrate, bereits auf die Kanalzahl gebracht. */
  channels: Float32Array[];
  sampleRate: number;
  /** `false` erzwingt den WASM-Pfad — nur für Messungen. */
  preferGpu: boolean;
}

export type ToWorker =
  | { type: 'probe' }
  /**
   * Der Draht zum zweiten Worker, einmal beim Aufbau.
   *
   * Verdrahtet wird vom Hauptfaden, weil nur er beide Worker kennt —
   * danach reden sie direkt miteinander, ohne ihn. Je Block gehen 55 MB
   * hinueber; die sollen nicht ueber einen dritten Faden laufen, der mit
   * der Trennung nichts zu tun hat.
   */
  | { type: 'link'; port: MessagePort }
  | StartMessage
  | { type: 'cancel'; jobId: string };

export interface StemPayload {
  source: string;
  channels: Float32Array[];
}

export type FromWorker =
  | { type: 'probed'; support: WebGpuSupport; runtimeVersion: string | null }
  | { type: 'stage'; jobId: string; phase: Phase }
  | {
      type: 'model';
      jobId: string;
      loaded: number;
      total: number;
      fromCache: boolean;
    }
  | {
      type: 'progress';
      jobId: string;
      blocksDone: number;
      blocksTotal: number;
      elapsedMs: number;
    }
  | {
      type: 'done';
      jobId: string;
      stems: StemPayload[];
      sampleRate: number;
      samples: number;
      timings: Timings;
      proof: ExecutionProof;
      manifest: ModelManifest;
      /** Zeit vom Auftrag bis hierher, inklusive Modelldownload. */
      wallMs: number;
      modelMs: number;
      sessionMs: number;
      /** Lagen die Gewichte schon im Cache? Dann war es kein Download. */
      modelFromCache: boolean;
    }
  | { type: 'error'; jobId: string; message: string; cancelled: boolean };

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/**
 * Die laufende Arbeit. Mehr als eine gibt es nicht: ein Trennjob belegt die
 * Grafikkarte und knapp ein Gigabyte Arbeitsspeicher, zwei gleichzeitig
 * waeren beide langsamer als einer nach dem anderen.
 */
let current: { jobId: string; cancel: { cancelled: boolean } } | null = null;

/** Der Draht zum zweiten Worker. Ohne ihn laeuft keine Trennung. */
let inverse: MessagePort | null = null;

/** Sitzungen bleiben stehen: das Anlegen kostet Sekunden, der zweite Job nicht. */
const sessions = new Map<
  string,
  { session: import('onnxruntime-common').InferenceSession; proof: ExecutionProof }
>();

scope.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'probe') {
    void handleProbe();
    return;
  }
  if (message.type === 'link') {
    inverse = message.port;
    return;
  }
  if (message.type === 'cancel') {
    if (current?.jobId === message.jobId) current.cancel.cancelled = true;
    return;
  }
  if (message.type === 'start') {
    void handleStart(message);
  }
});

async function handleProbe(): Promise<void> {
  const support = await probeWebGpu();
  let runtimeVersion: string | null = null;
  try {
    const ort = await loadRuntime();
    runtimeVersion = ort.env.versions?.common ?? null;
  } catch {
    // Die Runtime fehlt oder ist nicht ladbar. Die Oberflaeche sagt es
    // anhand von `support`.
  }
  post({ type: 'probed', support, runtimeVersion });
}

async function handleStart(message: StartMessage): Promise<void> {
  const { jobId, modelId } = message;
  if (current) {
    post({
      type: 'error',
      jobId,
      message: 'Es läuft schon eine Trennung in diesem Tab.',
      cancelled: false,
    });
    return;
  }
  const cancel = { cancelled: false };
  current = { jobId, cancel };
  const startedAt = performance.now();
  let modelMs = 0;
  let sessionMs = 0;
  // Eine bereits stehende Sitzung ist der warme Fall: weder Download noch
  // Anlegen fallen dann an.
  let fromCache = true;

  try {
    post({ type: 'stage', jobId, phase: 'modell-prüfen' });
    const manifest = await loadManifest(modelId);
    if (!manifest) {
      throw new Error(
        `Zu „${modelId}" liegt kein Modell bereit. ` +
          'Dieser Trennmodus ist in dieser Variante nicht verfügbar.',
      );
    }
    const shape = shapeOf(manifest);
    if (message.sampleRate !== shape.sampleRate) {
      throw new Error(
        `Das Modell rechnet mit ${shape.sampleRate} Hz, bekommen hat es ` +
          `${message.sampleRate} Hz.`,
      );
    }

    const ort = await loadRuntime();
    let entry = sessions.get(modelId);
    if (!entry) {
      // Erst die Laufzeit selbst: ihr WASM liegt ebenfalls in Stuecken,
      // weil es einzeln ueber dem Limit der Hoster laege.
      post({ type: 'stage', jobId, phase: 'laufzeit-laden' });
      await ensureWasmBinary(ort, (loaded, total, fromCache) => {
        post({ type: 'model', jobId, loaded, total, fromCache });
      });
      if (cancel.cancelled) throw new CancelledError();

      const urls = weightPartUrls(modelId, manifest);
      const key = weightsCacheKey(modelId, manifest);
      const bytes = weightsBytes(manifest);
      const cached = await isCached(key);
      post({ type: 'stage', jobId, phase: 'modell-laden' });
      const mark = performance.now();
      const weights = await fetchWeights(urls, key, bytes, manifest.weights.sha256, (p) => {
        post({
          type: 'model',
          jobId,
          loaded: p.loaded,
          total: p.total,
          fromCache: p.fromCache,
        });
      });
      modelMs = performance.now() - mark;
      fromCache = cached;
      if (cancel.cancelled) throw new CancelledError();

      post({ type: 'stage', jobId, phase: 'sitzung-anlegen' });
      const sessionMark = performance.now();
      entry = await createSession(weights, { preferGpu: message.preferGpu });
      sessionMs = performance.now() - sessionMark;
      sessions.set(modelId, entry);
    }
    if (cancel.cancelled) throw new CancelledError();

    if (!inverse) {
      throw new Error(
        'Der zweite Worker fuer die Signalverarbeitung ist nicht verbunden.',
      );
    }
    post({ type: 'stage', jobId, phase: 'trennen' });
    const result = await separate(ort, entry.session, shape, message.channels, {
      proof: entry.proof,
      cancel,
      inverse,
      onProgress: (p) =>
        post({
          type: 'progress',
          jobId,
          blocksDone: p.blocksDone,
          blocksTotal: p.blocksTotal,
          elapsedMs: p.elapsedMs,
        }),
    });
    // Der Nachweis wird beim ersten Block vervollstaendigt; die Sitzung
    // behaelt ihn, damit der naechste Job nicht wieder von vorn belegt.
    entry.proof = result.proof;

    const transfer: Transferable[] = [];
    for (const stem of result.stems) {
      for (const channel of stem.channels) transfer.push(channel.buffer);
    }
    post(
      {
        type: 'done',
        jobId,
        stems: result.stems.map((s) => ({ source: s.source, channels: s.channels })),
        sampleRate: result.sampleRate,
        samples: result.samples,
        timings: result.timings,
        proof: result.proof,
        manifest,
        wallMs: performance.now() - startedAt,
        modelMs,
        sessionMs,
        modelFromCache: fromCache,
      },
      transfer,
    );
  } catch (err) {
    const cancelled = err instanceof CancelledError || cancel.cancelled;
    post({
      type: 'error',
      jobId,
      message: cancelled ? 'Abgebrochen' : explain(err),
      cancelled,
    });
  } finally {
    current = null;
  }
}

/**
 * Macht aus einem Fehler eine Meldung, mit der sich etwas anfangen laesst.
 *
 * Besonders beim Speicher: „Array buffer allocation failed" sagt niemandem,
 * was zu tun ist. Ein Trennjob belegt das Modell (174 MB), die Zwischen-
 * ergebnisse je Block (rund 70 MB) und die fertigen Spuren (92 MB je Spur
 * und 4:33) — bei einem langen Stueck mit sechs Spuren kommt da ein
 * Gigabyte und mehr zusammen, und ein 32-Bit-Tab oder ein voller Rechner
 * steigt dabei aus.
 */
function explain(err: unknown): string {
  const text = describe(err);
  if (
    err instanceof RangeError ||
    /allocation failed|out of memory|Aborted\(OOM|enomem/i.test(text)
  ) {
    return (
      'Der Speicher hat nicht gereicht. Ein kürzeres Stück, der Modus ' +
      '„Schnell" statt „Instrumente" oder ein Neuladen des Tabs hilft; ' +
      `andere Tabs zu schließen gibt ebenfalls Platz. (${text})`
    );
  }
  return text;
}
