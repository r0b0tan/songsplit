/**
 * Trennen über unseren Server — der Weg für Geräte, die ihre GPU nicht hergeben.
 *
 * Warum es ihn gibt, steht in `runtime.ts`: Chrome gibt WebGPU auf Android
 * nur für einen Teil der verbauten Grafikeinheiten frei. Ist kein Adapter
 * zu haben (`GPU-01` bis `GPU-04`), kann das Gerät nicht rechnen, und der
 * WASM-Rückfallweg ist auf einem Handy keine Antwort.
 *
 * **Wo dieser Dienst endet, ist der Unterschied zum Gerätepfad — und er ist
 * der einzige.** Die getrennten Spuren kommen als MP3 zurück, werden hier
 * dekodiert und in denselben `StemStore` gelegt, in den auch der Worker
 * schreibt. Ab dort ist ein Cloudjob von einem Gerätejob nicht mehr zu
 * unterscheiden: dasselbe Deck, dasselbe Speicherbudget, derselbe Verlauf,
 * dieselbe Prüfung in `JobsService.openable`. Es gibt keinen zweiten Weg
 * durch die Anwendung, nur einen zweiten Anfang.
 *
 * **Was hier nicht passiert: von selbst ausweichen.** Die Seite sagt zu,
 * dass keine Datei das Gerät verlässt. Diesen Weg zu gehen, ohne dass
 * jemand ihn ausdrücklich gewählt hat, wäre ein Vertrauensbruch — und die
 * Einwilligung, auf die sich der Transfer in die USA stützt, gäbe es dann
 * auch nicht. Gestartet wird nur auf Klick, und was der Klick bedeutet,
 * steht daneben.
 */
import { Injectable, computed, inject, signal } from '@angular/core';

import {
  loadCloudConfig,
  type CloudConfig,
  type CloudHealth,
} from '../core/cloud-config';
import type { Job, ModelInfo, Stem } from '../core/models';
import { decodeForModel } from './decode';
import { StemStore } from './stem-store';

/** Was der Server liefert. Ein Modell, vier Spuren — htdemucs. */
const CLOUD_MODEL = 'htdemucs';
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;

/** Wie oft nachgefragt wird, aufsteigend. Siehe `warte`. */
const POLL_START_MS = 1500;
const POLL_MAX_MS = 6000;

interface StartAntwort {
  job: string;
}

interface StemAntwort {
  slug: string;
  label: string;
  bytes: number;
  url: string;
}

interface StatusAntwort {
  zustand: 'laeuft' | 'fertig' | 'fehler';
  phase?: string;
  karte?: string;
  wartet?: number;
  block?: number;
  blocks?: number;
  prozent?: number | null;
  rest?: number | null;
  grund?: string;
  stems?: StemAntwort[];
  seconds?: number;
}

/** Was die Oberfläche über den laufenden Auftrag wissen will. */
export interface CloudRun {
  jobId: string;
  phase: string;
  /** Welche Karte zugeteilt wurde — vorher leer, sie steht nicht fest. */
  karte: string;
}

@Injectable({ providedIn: 'root' })
export class CloudSeparator {
  private readonly store = inject(StemStore);

  private readonly config = signal<CloudConfig | null>(null);
  private readonly health = signal<CloudHealth | null>(null);
  private readonly jobList = signal<Job[]>([]);
  private readonly running = signal<CloudRun | null>(null);

  /** Gibt es den Weg überhaupt? Ohne `cloud.json`: nein. */
  readonly available = computed(() => this.config() !== null);

  /**
   * Ist `cloud.json` schon gelesen?
   *
   * `available()` allein kann zwei Dinge heißen — „es gibt ihn nicht" und
   * „wir wissen es noch nicht" —, und der Unterschied entscheidet. Die
   * Geräteprüfung und das Lesen der Datei laufen nebeneinander; wer auf
   * `available()` schaut, bevor die Datei da ist, sieht „kein Serverweg"
   * und trifft darauf eine Entscheidung, die eine Zehntelsekunde später
   * falsch ist. Genau so ging das Fenster „Dieses Gerät kann nicht selbst
   * trennen" auf, obwohl der Weg längst eingerichtet war.
   */
  readonly checked = computed(() => this.configChecked());
  private readonly configChecked = signal(false);
  readonly where = computed(() => this.config()?.region ?? '');
  readonly keepHours = computed(() => this.config()?.keepHours ?? 6);
  readonly providerKeepDays = computed(() => this.config()?.providerKeepDays ?? 7);
  readonly run = this.running.asReadonly();
  readonly jobs = this.jobList.asReadonly();

  /**
   * Wie lange eine Minute Musik etwa dauert — oder `null`.
   *
   * Kommt aus `/health` und damit aus Läufen, die wirklich stattgefunden
   * haben. Damit steht die Schätzung schon da, **bevor** irgendetwas
   * hochgeladen ist.
   */
  readonly secondsPerMinute = computed(() => this.health()?.secondsPerMinute ?? null);

  async init(): Promise<void> {
    const config = await loadCloudConfig();
    this.config.set(config);
    this.configChecked.set(true);
    if (!config) return;
    // Der Endpunkt wird gefragt, aber nicht geweckt-und-gewartet: antwortet
    // er nicht, bleibt der Weg trotzdem begehbar. Die Zahl aus `/health`
    // ist eine Bequemlichkeit, keine Voraussetzung.
    try {
      const raw = (await this.fetchJson('/health')) as Record<string, unknown>;
      this.health.set({
        ok: raw['ok'] === true,
        format: typeof raw['format'] === 'string' ? raw['format'] : 'mp3',
        secondsPerMinute:
          typeof raw['sekunden_je_minute'] === 'number' ? raw['sekunden_je_minute'] : 0,
        measured: raw['gemessen'] === true,
      });
    } catch {
      this.health.set(null);
    }
  }

  /** Geschätzte Rechenzeit für eine Datei dieser Länge, in Sekunden. */
  estimateSeconds(durationSeconds: number): number | null {
    const rate = this.secondsPerMinute();
    if (!rate || durationSeconds <= 0) return null;
    return Math.round((durationSeconds / 60) * rate);
  }

  models(): ModelInfo[] {
    if (!this.available()) return [];
    return [
      {
        name: CLOUD_MODEL,
        // Der Modus heisst wie ueberall, denn er ist derselbe: htdemucs,
        // vier Spuren. **Wo** gerechnet wird, steht oben in der Ortswahl —
        // „Ueber unseren Server" als Modusname sagte dasselbe ein zweites
        // Mal und liess die Karte aussehen, als gaebe es hier ein anderes
        // Verfahren.
        mode: 'Schnell',
        label: 'htdemucs — 4 Spuren, auf unserem Server',
        description:
          'Dasselbe Modell wie auf dem Gerät, nur anderswo gerechnet. ' +
          'Die Datei wird dafür an unseren Server geschickt.',
        // Dieselben Anzeigenamen wie auf dem Geraet. Der Endpunkt liefert
        // die englischen Kennungen; auf der Karte stuenden sonst zwei
        // Sprachen nebeneinander, je nachdem wo gerechnet wird.
        stems: ['Gesang', 'Drums', 'Bass', 'Rest'],
        is_default: false,
        available: true,
        detail: null,
        downloaded: true,
        missing_files: [],
        site: 'cloud',
      },
    ];
  }

  /**
   * Hochladen, warten, Spuren holen.
   *
   * Der Fortschritt kommt fertig aus `/status` — Prozent und Restzeit
   * rechnet der Server, weil nur er die Blöcke zählt. Fehlen sie, steht
   * `null` im Job, und die Oberfläche zeigt ein Lauflicht statt einer
   * erfundenen Zahl.
   */
  async start(file: File): Promise<Job> {
    const config = this.config();
    if (!config) throw new Error('Der Serverweg ist auf dieser Seite nicht eingerichtet.');

    const form = new FormData();
    form.append('datei', file, file.name);
    const begonnen = Date.now() / 1000;
    const start = (await this.fetchJson('/separate', {
      method: 'POST',
      body: form,
    })) as StartAntwort;

    const job: Job = {
      id: start.job,
      source_name: file.name,
      model: CLOUD_MODEL,
      model_label: 'htdemucs — auf unserem Server',
      site: 'cloud',
      status: 'processing',
      progress: null,
      progress_of: null,
      remaining_seconds: null,
      stage: 'Wartet auf einen Container',
      error: null,
      is_test_path: false,
      device: null,
      duration_seconds: null,
      created_at: begonnen,
      started_at: begonnen,
      finished_at: null,
      stems: [],
    };
    this.jobList.update((list) => [job, ...list]);
    this.running.set({ jobId: job.id, phase: 'angenommen', karte: '' });

    void this.verfolgen(job.id).catch((err: unknown) => {
      this.patch(job.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        stage: null,
        progress: null,
        progress_of: null,
        remaining_seconds: null,
        finished_at: Date.now() / 1000,
      });
      this.running.set(null);
    });
    return job;
  }

  remove(jobId: string): void {
    this.store.drop(jobId);
    this.jobList.update((list) => list.filter((j) => j.id !== jobId));
  }

  removeFinished(): string[] {
    const weg = this.jobList()
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .map((j) => j.id);
    for (const id of weg) this.store.drop(id);
    this.jobList.update((list) => list.filter((j) => !weg.includes(j.id)));
    return weg;
  }

  // ------------------------------------------------------------- innendrin

  private async verfolgen(jobId: string): Promise<void> {
    let pause = POLL_START_MS;
    for (;;) {
      const stand = (await this.fetchJson(`/status/${jobId}`)) as StatusAntwort;

      if (stand.zustand === 'fehler') {
        throw new Error(stand.grund || 'Die Trennung ist auf dem Server gescheitert.');
      }
      if (stand.zustand === 'fertig') {
        await this.abholen(jobId, stand);
        return;
      }

      this.running.set({
        jobId,
        phase: stand.phase ?? 'angenommen',
        karte: stand.karte ?? '',
      });
      this.patch(jobId, {
        stage: this.stufentext(stand),
        progress:
          typeof stand.prozent === 'number' ? Math.min(stand.prozent, 99) / 100 : null,
        progress_of: typeof stand.prozent === 'number' ? 'blöcke' : null,
        remaining_seconds: typeof stand.rest === 'number' ? stand.rest : null,
      });

      await warte(pause);
      // Langsamer nachfragen, je länger es dauert: jede Anfrage weckt den
      // Web-Container, und im Sekundentakt zu fragen, während auf eine
      // Karte gewartet wird, ist Rechenzeit für nichts.
      pause = Math.min(pause + 500, POLL_MAX_MS);
    }
  }

  private stufentext(stand: StatusAntwort): string {
    switch (stand.phase) {
      case 'dekodieren':
        return 'Die Datei wird gelesen';
      case 'trennen':
        return stand.blocks
          ? `Wird getrennt (Block ${stand.block ?? 0} von ${stand.blocks})`
          : 'Wird getrennt';
      case 'kodieren':
        return 'Die Spuren werden geschrieben';
      default:
        // Der aufschlussreiche Fall: der Auftrag liegt beim Anbieter, aber
        // es läuft noch kein Container. Meist der Start, manchmal eine
        // Warteschlange, weil gerade keine Grafikkarte frei ist.
        return 'Wartet auf eine freie Grafikkarte';
    }
  }

  /**
   * Spuren holen und dekodieren, bis sie im `StemStore` liegen.
   *
   * Erst danach gilt der Job als fertig. Würde er vorher „done" melden,
   * stünde im Verlauf ein Knopf, der ein Deck öffnet, in dem nichts ist.
   */
  private async abholen(jobId: string, stand: StatusAntwort): Promise<void> {
    const liste = stand.stems ?? [];
    this.patch(jobId, {
      stage: `Spuren werden geladen (0 von ${liste.length})`,
      progress: null,
      progress_of: null,
      remaining_seconds: null,
    });

    const stems: { source: string; channels: Float32Array[] }[] = [];
    const meta: Stem[] = [];
    for (const [index, eintrag] of liste.entries()) {
      const antwort = await this.fetchRaw(eintrag.url);
      const blob = await antwort.blob();
      const decoded = await decodeForModel(blob, SAMPLE_RATE, CHANNELS);
      stems.push({ source: eintrag.slug, channels: decoded.channels });
      meta.push({
        name: eintrag.label,
        slug: eintrag.slug,
        // Leer wie beim Gerätepfad: die Abtastwerte liegen im `StemStore`
        // und gehen ohne Umweg über eine Adresse an das Deck.
        url: '',
        download_url: '',
        bytes: eintrag.bytes,
      });
      this.patch(jobId, {
        stage: `Spuren werden geladen (${index + 1} von ${liste.length})`,
      });
    }

    this.store.put({ jobId, stems, sampleRate: SAMPLE_RATE });
    this.patch(jobId, {
      status: 'done',
      stage: null,
      progress: 1,
      progress_of: 'blöcke',
      remaining_seconds: null,
      duration_seconds: stand.seconds ?? null,
      device: this.running()?.karte || 'Server',
      finished_at: Date.now() / 1000,
      stems: meta,
    });
    this.running.set(null);
  }

  private patch(jobId: string, änderung: Partial<Job>): void {
    this.jobList.update((list) =>
      list.map((j) => (j.id === jobId ? { ...j, ...änderung } : j)),
    );
  }

  private async fetchJson(pfad: string, init: RequestInit = {}): Promise<unknown> {
    const antwort = await this.fetchRaw(pfad, init);
    return antwort.json();
  }

  private async fetchRaw(pfad: string, init: RequestInit = {}): Promise<Response> {
    const config = this.config();
    if (!config) throw new Error('Der Serverweg ist nicht eingerichtet.');
    const antwort = await fetch(`${config.url}${pfad}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'X-Mixapart-Token': config.token },
    });
    if (!antwort.ok) {
      // Die Meldung des Servers steht im Klartext im Feld `detail` — sie
      // ist für Menschen geschrieben („Höchstens 25 MB"), also wird sie
      // durchgereicht statt durch einen Statuscode ersetzt.
      let grund = `${antwort.status}`;
      try {
        const fehler = (await antwort.json()) as { detail?: unknown };
        if (typeof fehler.detail === 'string') grund = fehler.detail;
      } catch {
        // Keine JSON-Antwort — dann bleibt es beim Statuscode.
      }
      throw new Error(grund);
    }
    return antwort;
  }
}

function warte(ms: number): Promise<void> {
  return new Promise((fertig) => setTimeout(fertig, ms));
}
