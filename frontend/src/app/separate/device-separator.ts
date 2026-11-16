/**
 * Trennen auf diesem Gerät — als Job, wie jeder andere.
 *
 * Nach außen sieht dieser Dienst aus wie `ApiService`: eine Liste von Jobs,
 * eine Liste von Modi, Start, Abbruch, Löschen. Dass dahinter kein Server
 * steht, sondern ein Worker mit WebGPU, merkt der Verlauf nicht — er zeigt
 * beide Arten nebeneinander, mit demselben Aufbau und denselben Knöpfen.
 *
 * Was hier gegenüber dem Backend dazukommt, ist ein echter Fortschritt: der
 * Modelldownload kennt seine Bytes, die Trennung kennt ihre Blöcke. Beides
 * sind getrennte Zustände, denn beim ersten Lauf wartet man auf den
 * Download, bei jedem weiteren nicht mehr, und das soll man sehen.
 *
 * Ein Auftrag je Tab. Eine Trennung belegt die Grafikkarte und knapp ein
 * Gigabyte; zwei gleichzeitig wären beide langsamer als eine nach der
 * anderen.
 */
import { Injectable, computed, inject, signal } from '@angular/core';

import type { Job, ModelInfo, Stem } from '../core/models';
import {
  BROWSER_MODELS,
  availableModels,
  weightsCacheKey,
  type ModelManifest,
} from './catalog';
import { ACCEPTED_TYPES, decodeForModel } from './decode';
import { cachedBytes, isCached } from './model-cache';
import { adapterLabel, type ExecutionProof, type WebGpuSupport } from './runtime';
import { StemStore } from './stem-store';
import { TEST_DURATION_S, TEST_SAMPLE_RATE, makeTestStems } from './test-signals';
import type { FromWorker, Phase, StartMessage } from './separate.worker';

/** Dieselben Anzeigenamen wie `STEM_LABELS` im Backend. */
const STEM_LABELS: Record<string, string> = {
  vocals: 'Gesang',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Rest',
  guitar: 'Gitarre',
  piano: 'Klavier',
  instrumental: 'Begleitung',
};

/** Was die Oberfläche je Phase schreibt. */
const PHASE_TEXT: Record<Phase, string> = {
  warten: 'Wartet',
  'modell-prüfen': 'Modell wird geprüft',
  'laufzeit-laden': 'Laufzeit wird geladen',
  'modell-laden': 'Modell wird geladen',
  'sitzung-anlegen': 'Modell wird vorbereitet',
  trennen: 'Wird getrennt',
  fertig: 'Fertig',
};

export interface DeviceRun {
  jobId: string;
  phase: Phase;
  /** Modelldownload, falls er läuft. */
  model: { loaded: number; total: number; fromCache: boolean } | null;
  blocksDone: number;
  blocksTotal: number;
  /** Nach dem ersten Block abschätzbar, vorher null. */
  remainingMs: number | null;
}

export interface DeviceTimings {
  modelMs: number;
  sessionMs: number;
  inferenceMs: number;
  gpuWaitMs: number;
  forwardDspMs: number;
  inverseDspMs: number;
  totalMs: number;
  wallMs: number;
  blocks: number;
  /** Länge des Songs in Sekunden — für „x-fach Echtzeit". */
  audioSeconds: number;
}

export interface DeviceResultInfo {
  timings: DeviceTimings;
  proof: ExecutionProof;
  manifest: ModelManifest;
}

@Injectable({ providedIn: 'root' })
export class DeviceSeparator {
  private readonly store = inject(StemStore);

  /** Jobs dieser Sitzung, jüngster zuerst. */
  readonly jobs = signal<Job[]>([]);
  readonly models = signal<ModelInfo[]>([]);
  readonly support = signal<WebGpuSupport | null>(null);
  readonly runtimeVersion = signal<string | null>(null);
  readonly run = signal<DeviceRun | null>(null);
  readonly cachedModelBytes = signal(0);

  /** Messwerte und Nachweis je fertigem Job — für die Technikangaben. */
  private readonly results = new Map<string, DeviceResultInfo>();

  readonly busy = computed(() => this.run() !== null);

  private worker: Worker | null = null;
  private dspWorker: Worker | null = null;
  private ready: Promise<void> | null = null;

  /** Der Job, auf den Nachrichten noch wirken dürfen. */
  private activeId: string | null = null;

  resultInfo(jobId: string): DeviceResultInfo | null {
    return this.results.get(jobId) ?? null;
  }

  /**
   * Fragt Gerät und Modelle ab. Läuft einmal beim Start.
   *
   * Zuerst die Fähigkeiten, dann die Modi: ein Browser ohne WebGPU soll
   * nicht erst eine Liste von Modi sehen, die er nicht rechnen kann.
   */
  async init(): Promise<void> {
    this.ready ??= this.doInit();
    return this.ready;
  }

  private async doInit(): Promise<void> {
    const worker = this.ensureWorker();
    const probed = new Promise<void>((resolve) => {
      const onMessage = (event: MessageEvent<FromWorker>) => {
        if (event.data.type !== 'probed') return;
        this.support.set(event.data.support);
        this.runtimeVersion.set(event.data.runtimeVersion);
        worker.removeEventListener('message', onMessage);
        resolve();
      };
      worker.addEventListener('message', onMessage);
    });
    worker.postMessage({ type: 'probe' });
    // Wenn der Worker gar nicht antwortet — eine abgeschaltete Runtime, eine
    // blockierte Datei —, soll die Oberflaeche nicht ewig leer bleiben.
    await Promise.race([probed, wait(8000)]);
    if (!this.support()) {
      this.support.set({
        available: false,
        adapter: null,
        code: 'GPU-06',
        reason:
          'Der Trennvorgang ließ sich nicht vorbereiten. Die ONNX-Runtime ' +
          'unter /vendor/onnxruntime/ antwortet nicht.',
        // Hier bewusst nicht nachgesehen: der Worker schweigt, es geht also
        // gar nicht um die Grafikeinheit. Ein Treibername waere an dieser
        // Stelle eine Antwort auf eine Frage, die niemand gestellt hat —
        // und zoege `runtime.ts` ins Hauptbuendel, nur fuer diesen Fall.
        renderer: null,
      });
    }
    await this.refreshModels();
    this.cachedModelBytes.set(await cachedBytes());
  }

  /**
   * Warum die Modusliste leer oder kuerzer ist als erwartet — oder `null`.
   *
   * Eine leere Liste ohne Begruendung ist der schlechteste Zustand: die
   * Importkarte sieht aus wie fertig geladen, nur ohne Auswahl, und
   * niemand kann sehen woran es liegt.
   */
  readonly modelProblem = signal<string | null>(null);

  /**
   * Fragt ab, welche Modi ausgeliefert sind.
   *
   * Je Modus einzeln eingepackt: ein Modus, dessen Beschreibung nicht
   * lesbar ist, darf nicht die ganze Liste mitnehmen. Vorher tat er genau
   * das — ein `TypeError` in dieser Schleife liess `init()` scheitern, und
   * uebrig blieb eine Importkarte ohne einen einzigen Trennmodus.
   */
  async refreshModels(): Promise<void> {
    const found = await availableModels();
    const infos: ModelInfo[] = [];
    const broken: string[] = [];
    for (const { model, manifest } of found) {
      try {
        const key = weightsCacheKey(model.id, manifest);
        infos.push({
          name: model.name,
          mode: model.mode,
          label: model.label,
          description: model.description,
          stems: model.display.map((s) => STEM_LABELS[s] ?? s),
          is_default: model.name === 'htdemucs',
          // Der Modus ist da, auch ohne Grafikkarte — dann rechnet der
          // Prozessor. Was das bedeutet, steht als Warnung in der
          // Importkarte, nicht als „nicht verfügbar" an der Karte.
          available: true,
          detail: this.support()?.reason ?? null,
          downloaded: await isCached(key),
          missing_files: [],
          site: 'device',
          download_bytes: manifest.weights.total_bytes,
          // Was das Modell wirklich ausgibt. Das Manifest ist dafür die
          // Quelle, nicht `display`: bei „Minimum" zeigt die Anzeige zwei
          // Spuren, der Lauf hält vier.
          peak_stems: manifest.sources.length,
        });
      } catch (error) {
        broken.push(`${model.mode} (${model.name}): ${message(error)}`);
      }
    }
    this.models.set(infos);
    if (broken.length) {
      this.modelProblem.set(
        'Diese Trennmodi liegen nicht in lesbarer Form vor: ' +
          broken.join('; ') +
          '. Ein Neuladen der Seite holt die Beschreibung neu.',
      );
    } else if (!infos.length) {
      // Zwei Ursachen mit derselben Folge, und keine davon laesst sich von
      // hier aus unterscheiden: der Export fehlt, oder eine veraltete
      // Beschreibung liegt im Cache und laesst sich ohne Netz nicht
      // ersetzen. Beide stehen da, statt eine zu raten.
      //
      // Der erste Fall ist der haeufigere, seit die Gewichte nicht mehr im
      // Repo liegen: ein frischer Klon hat `frontend/public/models/` gar
      // nicht. Deshalb steht der Befehl dabei — wer das hier liest, sitzt
      // ohnehin vor dem Quelltext.
      this.modelProblem.set(
        'Keine Modellbeschreibung ist lesbar. Entweder fehlt der Export ' +
          'unter /models/ — er liegt nicht im Repo und entsteht mit ' +
          '„python backend/tools/export_htdemucs_onnx.py htdemucs" —, ' +
          'oder eine veraltete Beschreibung liegt im Browser-Cache und das ' +
          'Netz ist nicht erreichbar, um sie zu ersetzen. Einmal mit Netz ' +
          'neu laden räumt den zweiten Fall auf.',
      );
    } else {
      this.modelProblem.set(null);
    }
  }

  /**
   * Alles, was zur Geräteprüfung zu sagen ist — in einem Stück zum Kopieren.
   *
   * Entstanden aus einem Satz, der die Lage genau beschreibt: „Ich tipp das
   * nicht ab." Ein Treiberstring wie „ANGLE (Samsung Xclipse 540, Vulkan
   * 1.3.0)" überlebt das Abschreiben nicht, und ohne ihn ist aus der Ferne
   * nicht zu sagen, ob die Grafikeinheit fehlt oder nur gesperrt ist. Also
   * steht hier ein Block, den ein Knopf in die Zwischenablage legt.
   *
   * Bewusst ohne alles, was niemanden angeht: keine Dateinamen, keine Jobs,
   * keine Kennungen. Was hier steht, steht über das Gerät, nicht über den
   * Menschen davor — und es geht nur weg, wenn er es selbst verschickt.
   */
  diagnosis(): string {
    const s = this.support();
    const nav = globalThis.navigator;
    const lines = [
      'MixApart — Gerätebericht',
      `Code: ${s?.code ?? (s?.available ? 'in Ordnung' : 'unbekannt')}`,
      `WebGPU: ${s?.available ? 'nutzbar' : 'nicht nutzbar'}`,
    ];
    if (s?.adapter) lines.push(`Adapter: ${adapterLabel(s.adapter)}`);
    if (s?.renderer) lines.push(`WebGL: ${s.renderer}`);
    if (s?.reason) lines.push(`Grund: ${s.reason}`);
    if (this.runtimeVersion()) lines.push(`Runtime: ${this.runtimeVersion()}`);
    lines.push(`Browser: ${nav?.userAgent ?? 'unbekannt'}`);
    lines.push(
      `Kerne: ${nav?.hardwareConcurrency ?? '?'} · isoliert: ` +
        (globalThis.crossOriginIsolated ? 'ja' : 'nein'),
    );
    return lines.join('\n');
  }

  /** Modell-Kennung aus dem Modellnamen, für `start`. */
  private idFor(name: string): string | null {
    const found = BROWSER_IDS.get(name);
    return found ?? null;
  }

  /**
   * Startet eine Trennung. Gibt den angelegten Job zurück, damit der
   * Aufrufer ihm zusehen kann — genau wie `ApiService.upload`.
   */
  async start(file: File, modelName: string): Promise<Job> {
    await this.init();
    if (this.run()) {
      throw new Error(
        'Es läuft schon eine Trennung in diesem Tab. ' +
          'Erst abwarten oder abbrechen.',
      );
    }
    if (!ACCEPTED_TYPES.test(file.name)) {
      throw new Error('Nur MP3 und WAV.');
    }
    // Fehlende Grafikbeschleunigung ist kein Grund abzulehnen: der
    // Worker fällt dann auf WASM zurück und rechnet auf dem Prozessor. Die
    // Importkarte hat vorher gesagt, dass das ein Vielfaches dauert, und
    // am fertigen Job steht hinterher „WASM (CPU)" statt „WebGPU".
    // Abgelehnt wird nur, wenn gar nichts geht.
    const support = this.support();
    if (support === null) {
      throw new Error('Das Gerät wird noch geprüft. Einen Moment.');
    }
    const modelId = this.idFor(modelName);
    const info = this.models().find((m) => m.name === modelName);
    if (!modelId || !info) {
      throw new Error(`„${modelName}" gibt es auf diesem Gerät nicht.`);
    }

    const jobId = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: Job = {
      id: jobId,
      source_name: file.name,
      model: modelName,
      model_label: info.label,
      site: 'device',
      status: 'processing',
      progress: null,
      progress_of: null,
      stage: PHASE_TEXT['warten'],
      error: null,
      is_test_path: false,
      device: 'WebGPU',
      duration_seconds: null,
      created_at: Date.now() / 1000,
      started_at: Date.now() / 1000,
      finished_at: null,
      stems: [],
    };
    this.jobs.update((list) => [job, ...list]);
    this.activeId = jobId;
    this.run.set({
      jobId,
      phase: 'warten',
      model: null,
      blocksDone: 0,
      blocksTotal: 0,
      remainingMs: null,
    });

    // Dekodieren liegt auf dem Hauptfaden, weil `decodeAudioData` nur hier
    // zu haben ist. Es dauert bei einem Lied unter einer Sekunde.
    try {
      const decoded = await decodeForModel(file, 44100, 2);
      this.patch(jobId, { duration_seconds: decoded.duration });
      const message: StartMessage = {
        type: 'start',
        jobId,
        modelId,
        channels: decoded.channels,
        sampleRate: decoded.sampleRate,
        preferGpu: true,
      };
      this.ensureWorker().postMessage(
        message,
        decoded.channels.map((c) => c.buffer),
      );
    } catch (err) {
      this.fail(jobId, err instanceof Error ? err.message : String(err));
      throw err;
    }
    return job;
  }

  /**
   * Legt die Testspuren an, ohne zu trennen.
   *
   * Dasselbe wie `POST /api/jobs/test-signals`, nur im Browser: so lässt
   * sich das Deck auch in der öffentlichen Variante prüfen, ohne 174 MB
   * Modell und ohne Grafikkarte.
   */
  createTestJob(): Job {
    const stems = makeTestStems();
    const jobId = `test-${Date.now().toString(36)}`;
    this.store.put({ jobId, stems: stems.map((s) => ({ source: s.slug, channels: s.channels })), sampleRate: TEST_SAMPLE_RATE });
    const job: Job = {
      id: jobId,
      source_name: 'Testspuren',
      model: 'test-signals',
      model_label: 'Testpfad — trennt nichts',
      site: 'device',
      status: 'done',
      progress: 1,
      progress_of: null,
      stage: null,
      error: null,
      is_test_path: true,
      device: null,
      duration_seconds: TEST_DURATION_S,
      created_at: Date.now() / 1000,
      started_at: Date.now() / 1000,
      finished_at: Date.now() / 1000,
      stems: stems.map((s) => ({
        name: s.label,
        slug: s.slug,
        url: '',
        download_url: '',
        bytes: s.channels.reduce((sum, c) => sum + c.byteLength, 0),
      })),
    };
    this.jobs.update((list) => [job, ...list]);
    return job;
  }

  /** Bricht den laufenden Job ab. Der Worker sieht zwischen zwei Blöcken nach. */
  cancel(jobId: string): void {
    this.worker?.postMessage({ type: 'cancel', jobId });
  }

  /** Entfernt einen Job dieser Sitzung samt Ergebnis. */
  remove(jobId: string): void {
    this.cancel(jobId);
    this.store.drop(jobId);
    this.results.delete(jobId);
    this.jobs.update((list) => list.filter((j) => j.id !== jobId));
    if (this.activeId === jobId) {
      this.activeId = null;
      this.run.set(null);
    }
  }

  /** Alles, was fertig oder fehlgeschlagen ist. Laufendes bleibt stehen. */
  removeFinished(): string[] {
    const gone = this.jobs()
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .map((j) => j.id);
    for (const id of gone) this.remove(id);
    return gone;
  }

  // ------------------------------------------------------------- intern

  /**
   * Legt beide Worker an und verdrahtet sie miteinander.
   *
   * Zwei Faeden, weil die WebGPU-Laufzeit den Javascript-Faden zwischen
   * ihren Kernen braucht und eine iSTFT ihn eine Viertelsekunde lang nicht
   * hergibt — auf einem Faden addieren sich beide statt sich zu
   * ueberlappen (gemessen, siehe README).
   *
   * Verdrahtet wird hier, weil nur der Hauptfaden beide kennt. Danach
   * reden sie ueber den `MessageChannel` direkt miteinander: je Block
   * gehen 55 MB hinueber, und die sollen nicht ueber einen dritten Faden
   * laufen, der mit der Trennung nichts zu tun hat.
   */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./separate.worker', import.meta.url), {
      type: 'module',
    });
    const dsp = new Worker(new URL('./dsp.worker', import.meta.url), {
      type: 'module',
    });
    const channel = new MessageChannel();
    worker.postMessage({ type: 'link', port: channel.port1 }, [channel.port1]);
    dsp.postMessage({ type: 'link', port: channel.port2 }, [channel.port2]);
    dsp.addEventListener('error', (event) => {
      const id = this.activeId;
      if (id) {
        this.fail(
          id,
          event.message
            ? `Die Signalverarbeitung brach ab: ${event.message}`
            : 'Die Signalverarbeitung brach ohne Meldung ab — meist fehlender ' +
                'Speicher. Ein kürzeres Stück oder ein Neuladen des Tabs hilft.',
        );
      }
    });
    this.dspWorker = dsp;
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) =>
      this.handle(event.data),
    );
    worker.addEventListener('error', (event) => {
      const id = this.activeId;
      if (!id) return;
      // Stirbt der Worker selbst, kommt oft keine Meldung mit — das ist der
      // Fall, wenn der Browser ihn wegen Speichermangels abgeräumt hat. Eine
      // leere Fehlermeldung hilft niemandem, also steht hier der
      // wahrscheinliche Grund.
      this.fail(
        id,
        event.message
          ? `Der Trennvorgang brach ab: ${event.message}`
          : 'Der Trennvorgang brach ohne Meldung ab. Das passiert, wenn dem ' +
              'Browser der Speicher ausgeht — ein kürzeres Stück oder ein ' +
              'Neuladen des Tabs hilft.',
      );
    });
    this.worker = worker;
    return worker;
  }

  private handle(message: FromWorker): void {
    if (message.type === 'probed') {
      this.support.set(message.support);
      this.runtimeVersion.set(message.runtimeVersion);
      return;
    }
    // Ein Ergebnis, das nach einem Abbruch noch eintrifft, darf den
    // nächsten Job nicht überschreiben. Deshalb wird jede Nachricht gegen
    // den gerade aktiven Job geprüft und sonst verworfen.
    if (message.jobId !== this.activeId) return;

    switch (message.type) {
      case 'stage': {
        this.run.update((r) => (r ? { ...r, phase: message.phase } : r));
        this.patch(message.jobId, {
          stage: PHASE_TEXT[message.phase],
          // Beim Wechsel in eine Phase ohne eigenen Fortschritt verschwindet
          // der Prozentwert, statt auf dem alten Stand stehenzubleiben.
          ...(message.phase === 'trennen' ||
          message.phase === 'modell-laden' ||
          message.phase === 'laufzeit-laden'
            ? {}
            : { progress: null, progress_of: null }),
        });
        return;
      }
      case 'model': {
        const share = message.total > 0 ? message.loaded / message.total : null;
        this.run.update((r) =>
          r
            ? {
                ...r,
                model: {
                  loaded: message.loaded,
                  total: message.total,
                  fromCache: message.fromCache,
                },
              }
            : r,
        );
        this.patch(message.jobId, {
          progress: share,
          progress_of: 'modell',
          stage: message.fromCache
            ? 'Modell liegt bereit'
            : `Modell wird geladen (${mb(message.loaded)} von ${mb(message.total)})`,
        });
        return;
      }
      case 'progress': {
        const share = message.blocksTotal
          ? message.blocksDone / message.blocksTotal
          : null;
        const perBlock = message.elapsedMs / Math.max(1, message.blocksDone);
        const remaining = (message.blocksTotal - message.blocksDone) * perBlock;
        this.run.update((r) =>
          r
            ? {
                ...r,
                blocksDone: message.blocksDone,
                blocksTotal: message.blocksTotal,
                remainingMs: message.blocksDone >= 1 ? remaining : null,
              }
            : r,
        );
        this.patch(message.jobId, {
          progress: share,
          progress_of: 'blöcke',
          stage: `Wird getrennt (Block ${message.blocksDone} von ${message.blocksTotal})`,
        });
        return;
      }
      case 'done': {
        this.finish(message);
        return;
      }
      case 'error': {
        if (message.cancelled) {
          // Ein Abbruch ist kein Fehler: der Job verschwindet, statt als
          // „Fehlgeschlagen" im Verlauf zu stehen.
          this.remove(message.jobId);
        } else {
          this.fail(message.jobId, message.message);
        }
        return;
      }
    }
  }

  private finish(message: Extract<FromWorker, { type: 'done' }>): void {
    const job = this.jobs().find((j) => j.id === message.jobId);
    if (!job) return;
    const order = BROWSER_ORDER.get(job.model) ?? message.manifest.sources;
    const stemsOut = foldStems(message.stems, BROWSER_MERGE.get(job.model));

    // Nach Anzeigereihenfolge sortieren, nicht nach der des Modells: das
    // Deck zeigt Gesang oben, das Modell liefert Drums zuerst.
    const byName = new Map(stemsOut.map((s) => [s.source, s]));
    const sorted = order
      .map((source) => byName.get(source))
      .filter((s): s is (typeof stemsOut)[number] => !!s);
    for (const stem of stemsOut) if (!sorted.includes(stem)) sorted.push(stem);

    this.store.put({
      jobId: message.jobId,
      stems: sorted,
      sampleRate: message.sampleRate,
    });

    const stems: Stem[] = sorted.map((s) => ({
      name: STEM_LABELS[s.source] ?? s.source,
      slug: s.source,
      url: '',
      download_url: '',
      bytes: s.channels.reduce((sum, c) => sum + c.byteLength, 0),
    }));

    this.results.set(message.jobId, {
      timings: {
        modelMs: message.modelMs,
        sessionMs: message.sessionMs,
        inferenceMs: message.timings.inferenceMs,
        gpuWaitMs: message.timings.gpuWaitMs,
        forwardDspMs: message.timings.forwardDspMs,
        inverseDspMs: message.timings.inverseDspMs,
        totalMs: message.timings.totalMs,
        wallMs: message.wallMs,
        blocks: message.timings.blocks,
        audioSeconds: message.samples / message.sampleRate,
      },
      proof: message.proof,
      manifest: message.manifest,
    });

    this.patch(message.jobId, {
      status: 'done',
      stage: null,
      progress: 1,
      progress_of: 'blöcke',
      finished_at: Date.now() / 1000,
      duration_seconds: message.samples / message.sampleRate,
      device: message.proof.gpuConfirmed ? 'WebGPU' : 'WASM (CPU)',
      stems,
    });
    this.activeId = null;
    this.run.set(null);
    void cachedBytes().then((b) => this.cachedModelBytes.set(b));
    void this.refreshModels();
  }

  private fail(jobId: string, message: string): void {
    this.patch(jobId, {
      status: 'failed',
      error: message,
      stage: null,
      progress: null,
      progress_of: null,
      finished_at: Date.now() / 1000,
    });
    if (this.activeId === jobId) {
      this.activeId = null;
      this.run.set(null);
    }
  }

  private patch(jobId: string, change: Partial<Job>): void {
    this.jobs.update((list) =>
      list.map((j) => (j.id === jobId ? { ...j, ...change } : j)),
    );
  }
}

/** Modellname zu Ordner und Anzeigereihenfolge, aus dem Katalog. */
const BROWSER_IDS = new Map(BROWSER_MODELS.map((m) => [m.name, m.id]));
const BROWSER_ORDER = new Map<string, readonly string[]>(
  BROWSER_MODELS.map((m) => [m.name, m.display]),
);
const BROWSER_MERGE = new Map(
  BROWSER_MODELS.filter((m) => m.merge).map((m) => [m.name, m.merge!]),
);

/**
 * Fasst Spuren zusammen, wenn der Modus das vorsieht.
 *
 * Addiert wird **in** den Puffer der ersten Spur statt in einen neuen:
 * drei Spuren eines 4:33-Songs sind 276 MB, und die ein zweites Mal
 * anzulegen waere auf einem knappen Geraet der Unterschied zwischen laeuft
 * und laeuft nicht. Die Quellspuren fallen danach weg, der Speicher sinkt
 * also unterm Strich.
 *
 * Keine Normierung: die Ausgaben von Demucs addieren sich zum Mix, die
 * Summe liegt damit im selben Bereich wie das Original. Lauter machen
 * wuerde die Spur gegenueber dem Gesang verschieben, und beides zusammen
 * ergaebe nicht mehr den Song.
 */
function foldStems<T extends { source: string; channels: Float32Array[] }>(
  stems: T[],
  merge: { into: string; from: readonly string[] } | undefined,
): T[] {
  if (!merge) return stems;
  const byName = new Map(stems.map((s) => [s.source, s]));
  const parts = merge.from
    .map((name) => byName.get(name))
    .filter((s): s is T => !!s);
  if (parts.length < 2) return stems;

  const base = parts[0]!;
  for (let c = 0; c < base.channels.length; c++) {
    const target = base.channels[c]!;
    for (let p = 1; p < parts.length; p++) {
      const add = parts[p]!.channels[c];
      if (!add) continue;
      for (let i = 0; i < target.length; i++) target[i] += add[i]!;
    }
  }
  const merged = { ...base, source: merge.into } as T;
  return [...stems.filter((s) => !merge.from.includes(s.source)), merged];
}

/** Klartext aus einem unbekannten Fehlerwert. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}
