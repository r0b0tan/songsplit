import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';

import { DeviceFacts } from '../core/device-facts';
import { IconComponent } from '../core/icon';
import { STATUS_LABELS, type Job } from '../core/models';

/**
 * Das Fenster, das beim Trennen aufgeht.
 *
 * Einen Prozentwert gibt es nur, wo er aus etwas Gezaehltem kommt, und eine
 * Restzeit nur, wo sie gemessen ist. Das ist kein Grundsatz um seiner
 * selbst willen, sondern der Unterschied zwischen den Wegen:
 *
 * - **Auf dem Geraet.** Der Modelldownload kennt seine Bytes, die Trennung
 *   ihre Bloecke. Beides sind echte Zaehler, also steht ein Balken da, und
 *   `progress_of` sagt, woraus er kommt. Dass es zwei getrennte Zustaende
 *   sind, sieht man: beim ersten Lauf wartet man auf den Download, bei
 *   jedem weiteren nicht mehr.
 * - **Backend.** Dieselben Bloecke, nur eine Ebene tiefer geholt:
 *   `apply_model` in der mitgelieferten Demucs-Fassung kennt einen
 *   Fortschrittshaken, den `audio-separator` nicht durchreicht. Er wird in
 *   `separation._demucs_fortschritt` fuer die Dauer eines Laufs gesetzt.
 *   Das gilt fuer die Demucs-Modelle; das Roformer-Modell zaehlt nichts,
 *   und dort laeuft weiterhin ein Lauflicht.
 *
 * Die Restzeit faellt in beiden Faellen weg, solange zu wenig gemessen ist
 * — in den ersten Sekunden ist `null` die Wahrheit, keine Luecke.
 *
 * Ist die Trennung fertig, schliesst der Aufrufer das Fenster und oeffnet
 * das Deck: der Weg von der Datei zum Ueben hat damit keine Station, an
 * der man selbst klicken muesste.
 */
@Component({
  selector: 'app-run-progress',
  standalone: true,
  imports: [IconComponent],
  styles: [
    `
      :host {
        display: block;
      }
      .run {
        padding: clamp(18px, 2.6vw, 26px) clamp(16px, 2.6vw, 28px)
          clamp(15px, 2.2vw, 20px);
      }
      .head {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        justify-content: space-between;
      }
      .step b {
        color: var(--accent);
        font-weight: 600;
      }
      .lede {
        font-size: clamp(19px, 2.8cqw, 25px);
        font-weight: 680;
        letter-spacing: -0.03em;
        line-height: 1.1;
        margin: 7px 0 6px;
        overflow-wrap: anywhere;
      }
      .facts {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        font: 11.5px/1.5 var(--mono);
        color: var(--dim);
        font-variant-numeric: tabular-nums;
      }
      .facts .sep {
        color: var(--edge);
      }

      .bar {
        margin: 19px 0 11px;
      }
      /* Der Balken mit echter Fuellung. Er sitzt auf derselben Hoehe wie das
         Lauflicht, damit der Wechsel zwischen den Phasen nichts verschiebt. */
      .track {
        height: 6px;
        border-radius: 3px;
        background: var(--ghost);
        overflow: hidden;
      }
      .track i {
        display: block;
        height: 100%;
        border-radius: 3px;
        background: var(--accent);
        transition: width 0.18s linear;
      }
      .stage {
        display: flex;
        gap: 10px;
        align-items: baseline;
        justify-content: space-between;
        flex-wrap: wrap;
        font-size: 13.5px;
        font-weight: 600;
      }
      .stage span {
        font: 12px/1.5 var(--mono);
        font-variant-numeric: tabular-nums;
        color: var(--dim);
      }
      .what {
        margin-top: 7px;
        font-size: 12.5px;
        color: var(--faint);
        max-width: 58ch;
      }

      .foot {
        display: flex;
        gap: 10px 14px;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid var(--edge-soft);
      }
      button.link {
        min-height: 0;
        padding: 2px 0;
        border: 0;
        background: none;
        color: var(--dim);
        font-size: 13px;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
        text-underline-offset: 3px;
      }
      button.link:hover:not(:disabled) {
        color: var(--accent);
      }
      .close {
        --icon-size: 16px;
      }
      /* Dieselbe Tabelle wie in den Sprechblasen der Importkarte: feste
         Spalte fuer die Benennungen, eine Schriftstufe kleiner, grau.
         Sie ist Beiwerk neben dem Balken, nicht sein Gegenspieler. */
      .facts-long {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 2px 9px;
        margin: 16px 0 0;
        padding-top: 12px;
        border-top: 1px solid var(--edge);
        font-size: 10.5px;
      }
      .facts-long dt {
        color: var(--faint);
        white-space: nowrap;
      }
      .facts-long dd {
        margin: 0;
        color: var(--dim);
        font-family: var(--mono);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
    `,
  ],
  template: `
    <section class="panel run">
      <div class="head">
        <div class="grow">
          <div class="eyebrow step"><b>Trennung</b></div>
          <h2 class="lede">{{ job().source_name }}</h2>
          <div class="facts">
            <span>{{ job().model_label }}</span>
            @if (job().device && job().device !== 'keins') {
              <span class="sep">/</span>
              <span>{{ job().device!.toUpperCase() }}</span>
            }
            @if (job().duration_seconds) {
              <span class="sep">/</span>
              <span>{{ length() }}</span>
            }
          </div>
        </div>
        @if (dismissible()) {
          <button
            class="icon close"
            aria-label="Fenster schließen, Trennung läuft weiter"
            title="Fenster schließen, Trennung läuft weiter"
            (click)="close.emit()"
          >
            <app-icon name="x" />
          </button>
        }
      </div>

      @if (job().status === 'failed') {
        <div class="notice bad" style="margin-top: 16px">
          <span>{{ job().error ?? 'Die Trennung ist fehlgeschlagen.' }}</span>
        </div>
      } @else {
        @if (share() !== null) {
          <!-- Ein echter Balken: er haengt an gezaehlten Bytes oder
               Bloecken, siehe Klassendoku. -->
          <div
            class="track bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-valuenow]="percent()"
            [attr.aria-label]="stage()"
            data-testid="progress-bar"
          >
            <i [style.width.%]="percent()"></i>
          </div>
        } @else {
          <!-- Lauflicht: hier gibt es nichts zu zaehlen. -->
          <div class="activity bar" role="progressbar" [attr.aria-label]="stage()"></div>
        }
        <p class="stage">
          {{ stage() }}
          <span>
            @if (share() !== null) {
              {{ percent() }} % ·
            }
            {{ elapsed() }}
            @if (remaining(); as rest) {
              · <b data-testid="remaining">{{ rest }}</b>
            }
          </span>
        </p>
      }

      <!-- Worauf gerechnet wird, in ganzer Laenge. In der Importkarte
           stehen davon nur zwei Zeilen: dort entscheidet man sich, hier
           wartet man — und Wartezeit ist der einzige Moment, in dem fuenf
           Zeilen Technik niemanden aufhalten. -->
      <dl class="facts-long" data-testid="run-facts">
        @for (row of facts.rows(job().site); track row.label) {
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        }
      </dl>

      <div class="foot">
        @if (cancellable()) {
          <!-- Nur auf dem Geraet: ein Backendjob laeuft in einem Prozess,
               den die Oberflaeche nicht anhalten kann. -->
          <button class="link" data-testid="cancel-run" (click)="cancel.emit()">
            Abbrechen
          </button>
        }
        @if (dismissible()) {
          <button class="link" (click)="close.emit()">
            {{ job().status === 'failed' ? 'Schließen' : 'Im Hintergrund weiterlaufen lassen' }}
          </button>
        } @else if (job().status === 'failed') {
          <!-- Eingebettet gibt es nichts wegzuklicken — aber ein
               gescheiterter Lauf darf den Platz nicht behalten. Ohne
               diesen Knopf stuende auf dem Handy eine Fehlermeldung, hinter
               der die Importkarte liegt und nicht mehr hervorkommt. -->
          <button class="link" data-testid="run-dismiss" (click)="close.emit()">
            Zurück
          </button>
        }
      </div>
    </section>
  `,
})
export class RunProgressComponent {
  readonly facts = inject(DeviceFacts);

  readonly job = input.required<Job>();

  /**
   * Steht das hier in einem Fenster — oder **ist** es die Seite?
   *
   * Auf dem Handy ist es die Seite: das Fortschrittsfenster hat dort
   * seinen Zweck verfehlt. Ein Modal laesst sich wegtippen, und auf einem
   * Telefon passiert genau das — daneben getippt, Fenster weg, und zurueck
   * fuehrte kein Weg, weil der Verlauf nur „In Verarbeitung" zeigte. Wer
   * dann wissen wollte, wie weit sein Lied ist, konnte nur warten und
   * raten.
   *
   * Eingebettet gibt es nichts, was verschwinden koennte: die Anzeige
   * nimmt den Platz der Importkarte ein und raeumt ihn erst, wenn das
   * Deck aufgeht. Was wegfaellt, ist der Weg hinaus — und der wird hier
   * nicht gebraucht, denn die Trennung laeuft ohnehin bis zum Ende.
   */
  readonly dismissible = input(true);

  readonly close = output<void>();
  readonly cancel = output<void>();

  /** Fortschritt von 0 bis 1, oder `null`, wenn es nichts zu zaehlen gibt. */
  readonly share = computed(() => {
    const job = this.job();
    return job.progress_of === null ? null : job.progress;
  });

  readonly percent = computed(() => Math.round((this.share() ?? 0) * 100));

  /**
   * Abbrechen geht nur auf dem Geraet.
   *
   * Der Python-Worker rechnet in einem eigenen Prozess ohne Abbruchweg; ein
   * Knopf, der nichts tut, waere schlechter als keiner.
   */
  readonly cancellable = computed(
    () => this.job().site === 'device' && this.job().status === 'processing',
  );

  /** Tickt im Sekundentakt, damit die verstrichene Zeit laeuft. */
  private readonly now = signal(Date.now() / 1000);

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now() / 1000), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  readonly stage = computed(() => {
    const job = this.job();
    if (job.status === 'queued') return 'Wartet auf einen freien Platz';
    return job.stage ?? STATUS_LABELS[job.status];
  });

  /** Laufzeit seit dem Start der Trennung, sonst seit dem Anlegen. */
  readonly elapsed = computed(() => {
    const job = this.job();
    const from = job.started_at ?? job.created_at;
    const seconds = Math.max(0, (job.finished_at ?? this.now()) - from);
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  });

  /**
   * „noch etwa 40 s" — oder nichts.
   *
   * Nichts ist hier der Normalfall der ersten Sekunden und kein Mangel:
   * bevor drei Blöcke gerechnet sind, gibt es keine belastbare Zahl, und
   * eine unbelastbare wäre schlechter als keine. Deshalb steht die
   * verstrichene Zeit immer da und die Restzeit nur, wenn sie gemessen
   * ist.
   *
   * Gerundet wird großzügig: auf fünf Sekunden unterhalb einer Minute, auf
   * halbe Minuten darüber. Eine sekundengenaue Restzeit, die bei jedem
   * Block zappelt, liest sich wie ein Zufallsgenerator — und genauer als
   * die Schätzung ist sie dadurch nicht.
   */
  readonly remaining = computed(() => {
    const seconds = this.job().remaining_seconds;
    if (seconds === null || this.job().status !== 'processing') return null;
    if (seconds < 8) return 'gleich fertig';
    if (seconds < 60) return `noch etwa ${Math.round(seconds / 5) * 5} s`;
    const halbe = Math.round(seconds / 30) / 2;
    return `noch etwa ${halbe.toFixed(1).replace('.0', '').replace('.', ',')} min`;
  });

  readonly length = computed(() => {
    const seconds = this.job().duration_seconds ?? 0;
    const m = Math.floor(seconds / 60);
    return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')} lang`;
  });
}
