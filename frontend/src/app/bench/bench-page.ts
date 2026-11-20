/**
 * Die Messseite: `#bench` hinter der Adresse.
 *
 * Eine eigene Seite, nicht ein Knopf in der Oberfläche. Sie redet direkt mit
 * dem Worker, ohne `DeviceSeparator` und ohne Verlauf dazwischen — gemessen
 * werden soll die Trennung, nicht der Weg durch die App.
 *
 * Was sie beantwortet, in dieser Reihenfolge:
 *
 * 1. **Läuft es wirklich auf der Grafikkarte?** Vier Belege müssen
 *    zusammenkommen, und sie stehen einzeln da (siehe `runtime.ts`). Ein
 *    WASM-Lauf erscheint hier nie als GPU-Lauf — er wird so benannt.
 * 2. **Wie lange dauert was?** Modelldownload, Sitzung, Inferenz,
 *    Signalverarbeitung und die Zeit bis zur ersten abspielbaren Spur
 *    getrennt, nicht als eine Zahl.
 * 3. **Kommt das Richtige heraus?** Das Ergebnis wird gegen die Werte aus
 *    `backend/tools/demucs_reference.py` gehalten — dieselbe Kette, in
 *    numpy, gegen Torch gemessen. Eine schnelle falsche Trennung ist keine.
 *
 * Kalt gegen warm: „Modell-Cache leeren" wirft die Gewichte aus der
 * Cache-API, danach ist der nächste Lauf wieder ein kalter.
 */
import { Component, computed, inject, signal } from '@angular/core';

import { BROWSER_MODELS } from '../separate/catalog';
import { decodeForModel } from '../separate/decode';
import { clearCache } from '../separate/model-cache';
import { makeReferenceSignal } from '../separate/reference-signal';
import { I18n } from '../i18n/i18n';
import { adapterLabel, probeWebGpu, type ExecutionProof } from '../separate/runtime';
import type { FromWorker } from '../separate/separate.worker';

/** Ein Lauf: alles, was dabei herauskommt. */
interface Measurement {
  label: string;
  provider: string;
  gpuConfirmed: boolean;
  evidence: string[];
  adapter: string;
  /** Länge des Materials in Sekunden. */
  audioSeconds: number;
  modelMs: number;
  modelFromCache: boolean;
  sessionMs: number;
  decodeMs: number;
  inferenceMs: number;
  forwardDspMs: number;
  inverseDspMs: number;
  separationMs: number;
  /** Vom Klick bis die Spuren im Deck liegen könnten. */
  firstPlayableMs: number;
  blocks: number;
  /** Vielfaches der Echtzeit, nur die Trennung. */
  realtime: number;
  check: string | null;
  checkPass: boolean | null;
}

interface Digest {
  shape: number[];
  sum: number;
  sum_squares: number;
  abs_max: number;
  probe_step: number;
  probes: number[];
}

interface Fixtures {
  samples: number;
  sample_rate: number;
  sources: string[];
  stages: Record<string, Digest>;
  separated: Record<string, Digest>;
  sum_of_stems: { db: number };
}

@Component({
  selector: 'app-bench',
  standalone: true,
  styles: [
    `
      :host {
        display: block;
      }
      .wrap {
        max-width: 1040px;
        margin: 0 auto;
        padding: clamp(14px, 3vw, 28px) 16px 64px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      h1 {
        font-size: clamp(22px, 3vw, 30px);
        letter-spacing: -0.03em;
        margin: 0;
      }
      .card {
        padding: 16px 18px;
      }
      h2 {
        font-size: 14px;
        margin: 0 0 10px;
        letter-spacing: -0.01em;
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      label.field {
        display: flex;
        gap: 7px;
        align-items: center;
        font-size: 13px;
      }
      dl {
        margin: 0;
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 3px 14px;
        font: 12px/1.6 var(--mono);
      }
      dt {
        color: var(--dim);
      }
      dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }
      ul.evidence {
        margin: 8px 0 0;
        padding-left: 18px;
        font: 12px/1.65 var(--mono);
        color: var(--dim);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font: 12px/1.5 var(--mono);
        font-variant-numeric: tabular-nums;
      }
      th,
      td {
        text-align: right;
        padding: 5px 7px;
        border-bottom: 1px solid var(--edge-soft);
        white-space: nowrap;
      }
      th:first-child,
      td:first-child {
        text-align: left;
      }
      th {
        color: var(--dim);
        font-weight: 600;
      }
      .ok {
        color: #2f8f4e;
      }
      .bad {
        color: #c0392b;
      }
      .log {
        font: 11.5px/1.6 var(--mono);
        color: var(--dim);
        white-space: pre-wrap;
        max-height: 190px;
        overflow: auto;
        margin: 0;
      }
    `,
  ],
  template: `
    <div class="wrap">
      <h1>MixApart — Messung des Browserpfads</h1>

      <!-- ------------------------------------------------------- Gerät -->
      <section class="panel card">
        <h2>Gerät</h2>
        @if (support(); as s) {
          <dl>
            <dt>WebGPU</dt>
            <dd [class.ok]="s.available" [class.bad]="!s.available">
              {{ s.available ? 'nutzbar' : 'nicht nutzbar' }}
            </dd>
            <dt>Adapter</dt>
            <dd>{{ adapterLabel(s.adapter) }}</dd>
            @if (s.adapter) {
              <dt>Software-Umsetzung</dt>
              <dd [class.bad]="s.adapter.software">
                {{ s.adapter.software ? 'ja — das rechnet auf der CPU' : 'nein' }}
              </dd>
              <!-- Steht nur da, wo es zutrifft: im Kernmodus waere „nein"
                   eine Zeile ohne Aussage. Trifft es zu, gehoert es in die
                   Messung — die Grenzen sind kleiner, und ein Vergleich mit
                   einem Kern-Lauf vergliche dann zwei verschiedene Dinge. -->
              @if (s.adapter.compat) {
                <dt>Compatibility-Modus</dt>
                <dd>ja — kleinere Grenzen als im Kernmodus</dd>
              }
            }
            <!-- Die Gegenprobe ueber WebGL. Sie steht nur da, wo WebGPU
                 nichts hergab — dann aber als Erstes nach dem Adapter, weil
                 sie die Frage beantwortet, die der leere Adapter aufwirft:
                 ob ueberhaupt eine Grafikeinheit da ist. -->
            @if (s.renderer) {
              <dt>WebGL meldet</dt>
              <dd>{{ s.renderer }}</dd>
            }
            @if (s.code) {
              <dt>Code</dt>
              <dd>{{ s.code }}</dd>
            }
            <!-- Der Befund wird hier zum Satz wie ueberall sonst. Die
                 Messseite selbst bleibt deutsch — sie ist Werkzeug, kein
                 Teil der Anwendung. -->
            @if (i18n.gpuReason(s.reason); as grund) {
              <dt>Grund</dt>
              <dd>{{ grund }}</dd>
            }
          </dl>
        } @else {
          <p class="log">wird geprüft …</p>
        }
      </section>

      <!-- ------------------------------------------------------- Lauf -->
      <section class="panel card">
        <h2>Lauf</h2>
        <div class="row">
          <label class="field">
            Modell
            <select [value]="modelId()" (change)="pickModel($event)">
              @for (m of MODELS; track m.id) {
                <option [value]="m.id">{{ m.mode }} — {{ m.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <input
              type="checkbox"
              [checked]="preferGpu()"
              (change)="preferGpu.set(!preferGpu())"
            />
            WebGPU (aus = WASM, zum Vergleich)
          </label>
          <label class="field">
            Datei
            <input type="file" accept=".mp3,.wav" (change)="pickFile($event)" />
          </label>
        </div>
        <div class="row" style="margin-top: 12px">
          <button
            type="button"
            data-testid="bench-clip"
            [disabled]="busy()"
            (click)="runClip()"
          >
            Kurzer Clip (Vergleichssignal, {{ clipSeconds() }} s)
          </button>
          <button
            type="button"
            data-testid="bench-file"
            [disabled]="busy() || !file()"
            (click)="runFile()"
          >
            Ganzer Song{{ file() ? ' (' + file()!.name + ')' : '' }}
          </button>
          <button type="button" [disabled]="busy()" (click)="dropCache()">
            Modell-Cache leeren (für einen kalten Lauf)
          </button>
        </div>
        @if (status(); as s) {
          <p class="log" style="margin-top: 10px" data-testid="bench-status">{{ s }}</p>
        }
      </section>

      <!-- --------------------------------------------------- Ergebnisse -->
      @if (runs().length) {
        <section class="panel card">
          <h2>Messwerte</h2>
          <table data-testid="bench-table">
            <thead>
              <tr>
                <th>Lauf</th>
                <th>Weg</th>
                <th>Audio</th>
                <th>Modell</th>
                <th>Sitzung</th>
                <th>Dekodieren</th>
                <th>Inferenz</th>
                <th>DSP hin</th>
                <th>DSP zurück</th>
                <th>Trennung</th>
                <th>bis spielbar</th>
                <th>× Echtzeit</th>
                <th>Prüfung</th>
              </tr>
            </thead>
            <tbody>
              @for (r of runs(); track $index) {
                <tr>
                  <td>{{ r.label }}</td>
                  <td [class.ok]="r.gpuConfirmed" [class.bad]="!r.gpuConfirmed">
                    {{ r.provider }}
                  </td>
                  <td>{{ r.audioSeconds.toFixed(1) }} s</td>
                  <td>
                    {{ ms(r.modelMs) }}{{ r.modelFromCache ? ' (Cache)' : '' }}
                  </td>
                  <td>{{ ms(r.sessionMs) }}</td>
                  <td>{{ ms(r.decodeMs) }}</td>
                  <td>{{ ms(r.inferenceMs) }}</td>
                  <td>{{ ms(r.forwardDspMs) }}</td>
                  <td>{{ ms(r.inverseDspMs) }}</td>
                  <td>{{ ms(r.separationMs) }}</td>
                  <td>{{ ms(r.firstPlayableMs) }}</td>
                  <td>{{ r.realtime.toFixed(1) }}×</td>
                  <td [class.ok]="r.checkPass === true" [class.bad]="r.checkPass === false">
                    {{ r.check ?? '—' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <ul class="evidence">
            @for (line of runs()[runs().length - 1].evidence; track line) {
              <li>{{ line }}</li>
            }
          </ul>
        </section>
      }
    </div>
  `,
})
export class BenchPageComponent {
  protected readonly i18n = inject(I18n);

  readonly MODELS = BROWSER_MODELS;
  readonly adapterLabel = adapterLabel;

  readonly support = signal<Awaited<ReturnType<typeof probeWebGpu>> | null>(null);
  readonly modelId = signal(BROWSER_MODELS[0].id);
  readonly preferGpu = signal(true);
  readonly file = signal<File | null>(null);
  readonly busy = signal(false);
  readonly status = signal<string | null>(null);
  readonly runs = signal<Measurement[]>([]);

  /** Das Vergleichssignal ist knapp zwei Blöcke lang. */
  private readonly clipSamples = 343980 + 1024 * 37;
  readonly clipSeconds = computed(() => Math.round(this.clipSamples / 44100));

  private worker: Worker | null = null;
  private fixtures: Fixtures | null = null;

  constructor() {
    void probeWebGpu().then((s) => this.support.set(s));
    void fetch('reference/index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((f) => (this.fixtures = f as Fixtures | null))
      .catch(() => (this.fixtures = null));
  }

  pickModel(event: Event): void {
    this.modelId.set((event.target as HTMLSelectElement).value);
  }

  pickFile(event: Event): void {
    this.file.set((event.target as HTMLInputElement).files?.[0] ?? null);
  }

  async dropCache(): Promise<void> {
    await clearCache();
    // Die Sitzung hält das Modell weiter im Speicher. Ein kalter Lauf muss
    // deshalb auch den Worker loswerden, sonst misst er nur den Cache.
    this.worker?.terminate();
    this.worker = null;
    this.status.set('Modell-Cache geleert und Worker beendet. Der nächste Lauf ist kalt.');
  }

  async runClip(): Promise<void> {
    const channels = makeReferenceSignal(this.clipSamples, 44100);
    await this.measure('Clip', channels, 44100, 0, true);
  }

  async runFile(): Promise<void> {
    const file = this.file();
    if (!file) return;
    this.busy.set(true);
    this.status.set('Datei wird dekodiert …');
    try {
      const started = performance.now();
      const decoded = await decodeForModel(file, 44100, 2);
      const decodeMs = performance.now() - started;
      await this.measure(file.name, decoded.channels, 44100, decodeMs, false);
    } catch (err) {
      this.status.set(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
      this.busy.set(false);
    }
  }

  /** Ein Lauf durch den Worker, mit allem gestoppt. */
  private async measure(
    label: string,
    channels: Float32Array[],
    sampleRate: number,
    decodeMs: number,
    compare: boolean,
  ): Promise<void> {
    this.busy.set(true);
    const samples = channels[0].length;
    const jobId = `bench-${Date.now().toString(36)}`;
    const worker = this.ensureWorker();
    const started = performance.now();

    const done = new Promise<Extract<FromWorker, { type: 'done' }>>((resolve, reject) => {
      const onMessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data;
        if (!('jobId' in message) || message.jobId !== jobId) return;
        if (message.type === 'stage') {
          this.status.set(`${label}: ${message.phase}`);
        } else if (message.type === 'model') {
          const share = message.total ? Math.round((message.loaded / message.total) * 100) : 0;
          this.status.set(
            message.fromCache
              ? `${label}: Modell aus dem Cache`
              : `${label}: Modell wird geladen, ${share} %`,
          );
        } else if (message.type === 'progress') {
          this.status.set(
            `${label}: Block ${message.blocksDone} von ${message.blocksTotal}`,
          );
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
      {
        type: 'start',
        jobId,
        modelId: this.modelId(),
        channels,
        sampleRate,
        preferGpu: this.preferGpu(),
      },
      channels.map((c) => c.buffer),
    );

    try {
      const result = await done;
      const firstPlayableMs = performance.now() - started + decodeMs;
      const audioSeconds = result.samples / result.sampleRate;
      const separationMs = result.timings.totalMs;

      let check: string | null = null;
      let checkPass: boolean | null = null;
      if (compare) {
        const verdict = this.compareWithReference(result);
        check = verdict.text;
        checkPass = verdict.pass;
      }

      this.runs.update((list) => [
        ...list,
        {
          label,
          provider: describeProvider(result.proof),
          gpuConfirmed: result.proof.gpuConfirmed,
          evidence: result.proof.evidence,
          adapter: adapterLabel(result.proof.adapter),
          audioSeconds,
          modelMs: result.modelMs,
          modelFromCache: result.modelFromCache,
          sessionMs: result.sessionMs,
          decodeMs,
          inferenceMs: result.timings.inferenceMs,
          forwardDspMs: result.timings.forwardDspMs,
          inverseDspMs: result.timings.inverseDspMs,
          separationMs,
          firstPlayableMs,
          blocks: result.timings.blocks,
          realtime: audioSeconds / (separationMs / 1000),
          check,
          checkPass,
        },
      ]);
      this.status.set(`${label}: fertig.`);
    } catch (err) {
      this.status.set(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy.set(false);
      void samples;
    }
  }

  /**
   * Vergleicht das Ergebnis mit `demucs_reference.py`.
   *
   * Gemessen wird die Abweichung **gegen den Mix**, nicht gegen die
   * jeweilige Spur. Das ist wichtig und war beim ersten Versuch falsch:
   * htdemucs legt auf manches Material fast nichts auf Bass und Drums (das
   * steht so in der README), und auf einer Spur, die praktisch leer ist,
   * verschlingt schon das Gleitkomma-Rauschen das ganze Signal — dieselbe
   * Rechnung einmal auf der CPU und einmal auf der GPU liegt dort auch nur
   * ein halbes dB auseinander. Der Wert sagte dann nichts über die
   * Umsetzung, nur etwas über das Material.
   *
   * Gegen den Mix gemessen ist es die Größe, die man hören würde: wie laut
   * ist der Unterschied, verglichen mit der Musik. Zwei ordentliche
   * fp32-Umsetzungen liegen dort um 50 dB auseinander; ein echter Fehler in
   * der Kette — ein halber Block Versatz, eine falsche Fensterfunktion —
   * läge bei 20 dB oder schlechter.
   */
  private compareWithReference(
    result: Extract<FromWorker, { type: 'done' }>,
  ): { text: string; pass: boolean } {
    const fx = this.fixtures;
    if (!fx) return { text: 'keine Referenz geladen', pass: false };
    if (result.samples !== fx.samples) {
      return { text: `Länge ${result.samples} statt ${fx.samples}`, pass: false };
    }
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
    if (!Number.isFinite(worst)) return { text: 'keine Spur vergleichbar', pass: false };
    const pass = worst >= 40;
    return { text: `${worst.toFixed(0)} dB unter Mix (${parts.join(', ')})`, pass };
  }

  private ensureWorker(): Worker {
    this.worker ??= new Worker(new URL('../separate/separate.worker', import.meta.url), {
      type: 'module',
    });
    return this.worker;
  }

  ms(value: number): string {
    if (value < 1) return '—';
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${(value / 1000).toFixed(2)} s`;
  }
}

function describeProvider(proof: ExecutionProof): string {
  if (proof.provider === 'webgpu' && proof.gpuConfirmed) return 'WebGPU';
  if (proof.provider === 'webgpu') return 'WebGPU (unbestätigt)';
  return 'WASM (CPU)';
}

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

/** Mittlere Leistung je Abtastwert, aus der Quadratsumme im Vergleichswert. */
function perSamplePower(digest: Digest): number {
  const size = digest.shape.reduce((a, b) => a * b, 1) || 1;
  return digest.sum_squares / size;
}

/**
 * Wie viele dB unter dem Mix die Abweichung von der Referenz liegt.
 *
 * Die ganze Referenzspur liegt nicht vor — nur Kennzahlen und Stichproben
 * an festen Stellen. Für diese Größe reicht das: die Stichproben geben die
 * Abweichung Wert für Wert, und ihr Mittel ist die Leistung des Fehlers.
 * Knapp hundert Stellen über die ganze Spur verteilt schätzen eine mittlere
 * Leistung gut genug, um 50 dB von 20 dB zu unterscheiden — und mehr muss
 * diese Prüfung nicht leisten.
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
  const noisePerSample = noise / count;
  if (noisePerSample === 0) return Infinity;
  return 10 * Math.log10(mixPower / noisePerSample);
}
